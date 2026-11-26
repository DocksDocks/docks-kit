/**
 * The process listener of the talk transport (#248 D2 Process scope, #249 E7,
 * E8): one endpoint per process, opened at the first registration and kept
 * until the process ends; registrations and their entries; the handshake, the
 * requests, withdrawal, and the repair and refresh passes.
 */
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

import { Clock, Effect, FiberSet, Option, Result, Schema, Semaphore } from "effect";

import { type Connection, makeConnection } from "./connection";
import {
  type BoundEndpoint,
  type Endpoint,
  bindEndpoint,
  closeEndpoint,
  endpointState,
  randomNameHex,
} from "./endpoint";
import {
  PROTOCOL_VERSION,
  type RequestFrame,
  computeHmac,
  decodeHello,
  decodeProof,
  decodeRequest,
  makeNonce,
  verifyHmac,
} from "./handshake";
import {
  type PublishedEntry,
  type RegistryEntry,
  TalkRegistry,
  describeFailure,
  entryFileName,
} from "./registry";
import { PING_KIND, type RequestHandler, type ResponseResult } from "./request";

const SECRET_BYTES = 32;

export interface ListenerOptions {
  readonly platform: NodeJS.Platform;
  /** The period of the repair pass (E8 Lifetime). */
  readonly repairIntervalMs: number;
  /** POSIX: the period of the `futimes` refresh of the kept entry files. */
  readonly refreshIntervalMs: number;
  /** The deadline of a handshake, from accept. */
  readonly handshakeTimeoutMs: number;
  /** The most connections that the listener admits before `ready`. */
  readonly maxUnauthenticated: number;
}

export interface RegistrationInput {
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
}

/** A registration of this process; the instance id is the same for each one. */
export interface Registration {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly fileName: string;
}

/** A registration could not start. */
export class TalkRegisterError extends Schema.TaggedError<
  TalkRegisterError,
  { readonly brand: unique symbol }
>()("TalkRegisterError", {
  sessionId: Schema.String,
  reason: Schema.String,
}) {}

class TalkHandshakeFailed extends Schema.TaggedError<
  TalkHandshakeFailed,
  { readonly brand: unique symbol }
>()("TalkHandshakeFailed", {
  reason: Schema.String,
}) {}

export interface RegistrationStatus {
  readonly sessionId: string;
  readonly fileName: string;
  readonly live: boolean;
  /** The entry waits for a publication. */
  readonly stale: boolean;
}

export interface ListenerStatus {
  readonly instanceId: string;
  readonly endpoint: Endpoint | undefined;
  /** Listeners that a rebind closed. */
  readonly closedListeners: number;
  readonly unauthenticated: number;
  readonly heldRequests: number;
  readonly registrations: ReadonlyArray<RegistrationStatus>;
  /** Entry files of ended registrations whose removal failed and is retried. */
  readonly pendingRemovals: ReadonlyArray<string>;
}

/** An authenticated connection and the ids of the requests that it waits for. */
interface ServedConnection {
  readonly connection: Connection;
  readonly held: Set<number>;
}

/** A registration that this listener served; ended ones stay until the process ends. */
interface Served {
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  readonly startTime: number;
  readonly secret: Buffer;
  readonly fileName: string;
  live: boolean;
  /** The entry needs a publication: never published, replaced, or its endpoint changed. */
  stale: boolean;
  published: PublishedEntry | undefined;
  readonly connections: Set<ServedConnection>;
}

type HandshakeEnd =
  | { readonly _tag: "Ready"; readonly served: Served }
  | { readonly _tag: "Ended" };

const targetKey = (instanceId: string, sessionId: string): string =>
  `${instanceId}\u0000${sessionId}`;

export interface Listener {
  readonly instanceId: string;
  readonly register: (input: RegistrationInput) => Effect.Effect<Registration, TalkRegisterError>;
  /** Ends a registration (E8 Withdrawal). An unknown or ended session id is no failure. */
  readonly withdraw: (sessionId: string) => Effect.Effect<void>;
  /** Sets the handler of a request kind. */
  readonly handle: (kind: string, handler: RequestHandler) => Effect.Effect<void>;
  readonly status: Effect.Effect<ListenerStatus>;
}

/** Makes the listener of this process. Its scope ends every live registration and closes the endpoint. */
export const makeListener = Effect.fnUntraced(function* (options: ListenerOptions) {
  const registry = yield* TalkRegistry;
  const instanceId = randomNameHex();
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();
  const registrations = new Map<string, Served>();
  const handlers = new Map<string, RequestHandler>([[PING_KIND, () => Effect.succeed("pong")]]);
  const pendingRemovals = new Set<string>();
  let bound: BoundEndpoint | undefined;
  let closedListeners = 0;
  let unauthenticated = 0;

  const entryOf = (served: Served, endpoint: Endpoint): RegistryEntry => ({
    version: PROTOCOL_VERSION,
    instanceId,
    sessionId: served.sessionId,
    name: served.name,
    cwd: served.cwd,
    processId: process.pid,
    endpoint,
    startTime: served.startTime,
    secret: served.secret.toString("hex"),
  });

  // --- Handshake and requests ---------------------------------------------------

  const handshake = Effect.fnUntraced(function* (connection: Connection) {
    const hello = yield* Effect.flatMap(connection.read, decodeHello);
    const served = registrations.get(targetKey(hello.instanceId, hello.sessionId));
    if (served === undefined) {
      return yield* new TalkHandshakeFailed({ reason: "no registration of this listener matches" });
    }
    const listenerNonce = yield* makeNonce;
    const fields = {
      clientNonce: hello.nonce,
      listenerNonce,
      instanceId: hello.instanceId,
      sessionId: hello.sessionId,
    };
    yield* connection.write({
      type: "challenge",
      nonce: listenerNonce,
      hmac: computeHmac(served.secret, { ...fields, role: "listener" }),
    });
    const proof = yield* Effect.flatMap(connection.read, decodeProof);
    if (!verifyHmac(served.secret, { ...fields, role: "client" }, proof.hmac)) {
      return yield* new TalkHandshakeFailed({ reason: "the client proof does not match" });
    }
    // The client accepts `ended` only after the listener proof, so only the secret holder can report the end.
    if (!served.live) {
      yield* connection.write({ type: "ended" });
      const ended: HandshakeEnd = { _tag: "Ended" };
      return ended;
    }
    yield* connection.write({ type: "ready" });
    const ready: HandshakeEnd = { _tag: "Ready", served };
    return ready;
  });

  const answer = Effect.fnUntraced(function* (
    link: ServedConnection,
    served: Served,
    request: RequestFrame,
  ) {
    const handler = handlers.get(request.kind);
    const result: ResponseResult =
      handler === undefined
        ? { status: "unknown-kind" }
        : {
            status: "ok",
            body: yield* handler(request.body, {
              registration: { instanceId, sessionId: served.sessionId },
              kind: request.kind,
            }),
          };
    // A withdrawal answers a held request with `not-live` and takes it out of the set.
    if (!link.held.delete(request.id)) return;
    yield* Effect.ignore(link.connection.write({ type: "response", id: request.id, result }));
  });

  const serveRequests = Effect.fnUntraced(function* (connection: Connection, served: Served) {
    if (!served.live) return yield* connection.finish;
    const link: ServedConnection = { connection, held: new Set() };
    served.connections.add(link);
    yield* Effect.gen(function* () {
      for (;;) {
        const request = yield* Effect.flatMap(connection.read, decodeRequest);
        if (!served.live || link.held.has(request.id)) continue;
        link.held.add(request.id);
        yield* Effect.forkChild(
          answer(link, served, request).pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning(`talk: the handler of ${request.kind} failed`, defect),
            ),
          ),
        );
      }
    }).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.andThen(
          Effect.sync(() => served.connections.delete(link)),
          connection.finish,
        ),
      ),
    );
  });

  const serveSocket = Effect.fnUntraced(function* (socket: Socket) {
    const connection = yield* makeConnection(socket);
    let counted = true;
    const uncount = Effect.sync(() => {
      if (counted) unauthenticated -= 1;
      counted = false;
    });
    // The deadline counts from accept; a failure or a timeout closes the connection before any payload.
    const end = yield* handshake(connection).pipe(
      Effect.timeoutOption(options.handshakeTimeoutMs),
      Effect.result,
      Effect.ensuring(uncount),
    );
    if (Result.isFailure(end) || Option.isNone(end.success)) return yield* connection.close;
    const outcome = end.success.value;
    if (outcome._tag === "Ended") return yield* connection.finish;
    yield* serveRequests(connection, outcome.served);
  });

  const onConnection = (socket: Socket): void => {
    socket.on("error", () => undefined);
    if (unauthenticated >= options.maxUnauthenticated) {
      socket.destroy();
      return;
    }
    unauthenticated += 1;
    runFork(serveSocket(socket));
  };

  // --- Registration ---------------------------------------------------------------

  const bind = bindEndpoint({ folder: registry.folder, platform: options.platform, onConnection });

  const releasePublished = Effect.fnUntraced(function* (served: Served) {
    const published = served.published;
    served.published = undefined;
    if (published !== undefined) yield* registry.release(published);
  });

  // Publishes the entry of a live registration with the current endpoint; a failure leaves it stale.
  const publishServed = Effect.fnUntraced(function* (served: Served) {
    if (bound === undefined) return;
    yield* releasePublished(served);
    served.stale = true;
    const published = yield* Effect.result(registry.publish(entryOf(served, bound.endpoint)));
    if (Result.isFailure(published)) {
      return yield* Effect.logWarning(
        `talk: publication of ${served.fileName} failed: ${describeFailure(published.failure)}`,
      );
    }
    served.published = published.success;
    served.stale = false;
  });

  const register = Effect.fn("TalkListener.register")(function* (input: RegistrationInput) {
    const { sessionId } = input;
    return yield* locked(
      Effect.gen(function* () {
        const key = targetKey(instanceId, sessionId);
        if (registrations.get(key)?.live === true) {
          return yield* new TalkRegisterError({
            sessionId,
            reason: "the session is registered already",
          });
        }
        yield* registry.prepare;
        if (bound === undefined) bound = yield* bind;
        const served: Served = {
          sessionId,
          name: input.name,
          cwd: input.cwd,
          startTime: yield* Clock.currentTimeMillis,
          secret: randomBytes(SECRET_BYTES),
          fileName: entryFileName(instanceId, sessionId),
          live: true,
          stale: true,
          published: undefined,
          connections: new Set(),
        };
        // A pending removal of an earlier registration of this session must not remove the new entry.
        pendingRemovals.delete(served.fileName);
        served.published = yield* registry.publish(entryOf(served, bound.endpoint));
        served.stale = false;
        registrations.set(key, served);
        const registration: Registration = { instanceId, sessionId, fileName: served.fileName };
        return registration;
      }),
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "TalkRegisterError"
          ? error
          : new TalkRegisterError({ sessionId, reason: describeFailure(error) }),
      ),
    );
  });

  // E8 Withdrawal: mark ended, answer held requests with not-live, close the connections, then drop the entry.
  const endServed = Effect.fnUntraced(function* (served: Served) {
    served.live = false;
    for (const link of served.connections) {
      for (const id of link.held) {
        yield* Effect.ignore(
          link.connection.write({ type: "response", id, result: { status: "not-live" } }),
        );
      }
      link.held.clear();
      yield* link.connection.finish;
    }
    served.connections.clear();
    served.stale = false;
    yield* releasePublished(served);
    const removed = yield* Effect.result(registry.remove(served.fileName));
    if (Result.isFailure(removed)) {
      pendingRemovals.add(served.fileName);
      yield* Effect.logWarning(
        `talk: removal of ${served.fileName} failed and is retried: ${describeFailure(removed.failure)}`,
      );
    }
  });

  const withdraw = Effect.fn("TalkListener.withdraw")(function* (sessionId: string) {
    yield* locked(
      Effect.suspend(() => {
        const served = registrations.get(targetKey(instanceId, sessionId));
        return served === undefined || !served.live ? Effect.void : endServed(served);
      }),
    );
  });

  // --- Lifetime (E8) ----------------------------------------------------------------

  const liveServed = (): Array<Served> =>
    [...registrations.values()].filter((served) => served.live);

  const markStale = Effect.fnUntraced(function* (served: Served) {
    yield* releasePublished(served);
    served.stale = true;
  });

  const repairPass = locked(
    Effect.gen(function* () {
      const current = bound;
      if (current === undefined) return;
      for (const fileName of [...pendingRemovals]) {
        const removed = yield* Effect.result(registry.remove(fileName));
        if (Result.isSuccess(removed)) pendingRemovals.delete(fileName);
      }
      const live = liveServed();
      let rebind = false;
      if (!(yield* registry.folderPresent)) {
        // The entries went with the folder; on POSIX the socket went too. Windows keeps its port.
        yield* registry.prepare;
        for (const served of live) yield* markStale(served);
        rebind = registry.endpointKind === "unix";
      } else if (endpointState(current) === "replaced") {
        rebind = true;
      }
      if (rebind) {
        // A failed candidate leaves the current listener as it is; the next pass tries again.
        const candidate = yield* bind;
        bound = candidate;
        yield* closeEndpoint(current);
        closedListeners += 1;
        for (const served of live) yield* markStale(served);
      }
      for (const served of live) {
        if (
          !served.stale &&
          served.published !== undefined &&
          (yield* registry.check(served.published)) === "intact"
        ) {
          continue;
        }
        yield* publishServed(served);
      }
    }),
  );

  const refreshPass = locked(
    Effect.suspend(() =>
      Effect.forEach(
        liveServed(),
        (served) =>
          served.published === undefined
            ? Effect.void
            : Effect.ignore(registry.refresh(served.published)),
        { discard: true },
      ),
    ),
  );

  const every = (intervalMs: number, pass: Effect.Effect<void, unknown>, label: string) =>
    Effect.forever(
      Effect.andThen(
        Effect.sleep(intervalMs),
        pass.pipe(
          Effect.catch((error) =>
            Effect.logWarning(`talk: the ${label} pass failed: ${describeFailure(error)}`),
          ),
        ),
      ),
    );

  yield* Effect.forkScoped(every(options.repairIntervalMs, repairPass, "repair"));
  if (registry.endpointKind === "unix") {
    yield* Effect.forkScoped(every(options.refreshIntervalMs, refreshPass, "refresh"));
  }

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* locked(Effect.forEach(liveServed(), endServed, { discard: true }));
      if (bound !== undefined) yield* closeEndpoint(bound);
    }),
  );

  const status = Effect.sync((): ListenerStatus => {
    let heldRequests = 0;
    for (const served of registrations.values()) {
      for (const link of served.connections) heldRequests += link.held.size;
    }
    return {
      instanceId,
      endpoint: bound?.endpoint,
      closedListeners,
      unauthenticated,
      heldRequests,
      registrations: [...registrations.values()].map((served) => ({
        sessionId: served.sessionId,
        fileName: served.fileName,
        live: served.live,
        stale: served.stale,
      })),
      pendingRemovals: [...pendingRemovals],
    };
  });

  const listener: Listener = {
    instanceId,
    register,
    withdraw,
    handle: (kind, handler) =>
      Effect.sync(() => {
        handlers.set(kind, handler);
      }),
    status,
  };
  return listener;
});
