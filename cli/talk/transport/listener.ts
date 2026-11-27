/**
 * The process listener of the talk transport (#248 D2 Process scope, #249 E7,
 * E8): one endpoint per process, opened at the first registration and kept
 * until the process ends; registrations and their entries; the handshake, the
 * requests, withdrawal, and the repair and refresh passes. Each registration
 * has its own random instance id, so a later registration of the same session
 * id is another target, and several live registrations of one session id can
 * share the listener (#250 E7). The admission hook can refuse a request for a
 * registration; the refusal withdraws it.
 */
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";

import { Clock, Effect, Fiber, FiberSet, Option, Result, Schema, Semaphore } from "effect";

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
  InstanceId,
  PROTOCOL_VERSION,
  type RequestFrame,
  SessionId,
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
import { PING_KIND, type RequestHandler, type ResponseResult, type Target } from "./request";

const SECRET_BYTES = 32;

const decodeSessionId = Schema.decodeUnknownEffect(SessionId);
const decodeInstanceId = Schema.decodeUnknownEffect(InstanceId);

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
  /** Asked in the tick that the listener admits a request; `undefined` admits every request. */
  readonly admit?: AdmissionCheck | undefined;
}

/**
 * The admission hook (#250 E7): true admits a request for the registration.
 * The listener asks it in the tick that it admits a request, `ping` included.
 * False, or a throw, answers `not-live` and withdraws the registration.
 */
export type AdmissionCheck = (registration: Target) => boolean;

export interface RegistrationInput {
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  /**
   * The instance id of the new registration (16 lowercase hex digits), so the
   * caller knows the exact pair before the entry is published (#250 E7).
   * Default: a random one. An id that this listener already served fails.
   */
  readonly instanceId?: string | undefined;
}

/** The new name and folder of a live registration (#250 E7, E8). */
export interface RegistrationUpdate {
  readonly name: string;
  readonly cwd: string;
}

/** A registration: its own instance id, its session id, and its entry file name. */
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

/** A registration could not be updated: it is not live, or its entry could not be published. */
export class TalkUpdateError extends Schema.TaggedError<
  TalkUpdateError,
  { readonly brand: unique symbol }
>()("TalkUpdateError", {
  instanceId: Schema.String,
  reason: Schema.String,
}) {}

class TalkHandshakeFailed extends Schema.TaggedError<
  TalkHandshakeFailed,
  { readonly brand: unique symbol }
>()("TalkHandshakeFailed", {
  reason: Schema.String,
}) {}

export interface RegistrationStatus {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly fileName: string;
  readonly live: boolean;
  /** The entry waits for a publication. */
  readonly stale: boolean;
}

export interface ListenerStatus {
  readonly endpoint: Endpoint | undefined;
  /** Listeners that a rebind closed. */
  readonly closedListeners: number;
  readonly unauthenticated: number;
  readonly heldRequests: number;
  readonly registrations: ReadonlyArray<RegistrationStatus>;
  /** Entry files of ended registrations whose removal failed and is retried. */
  readonly pendingRemovals: ReadonlyArray<string>;
  /** Repair passes that ran to their end or failed. */
  readonly repairPasses: number;
  /** The failure of the last repair pass, or of one of its entries; empty when the pass had none. */
  readonly lastRepairFailure: string;
}

/**
 * The requests that one authenticated connection holds (E8 Withdrawal). A
 * withdrawal ends the set: it takes every held id in one step, so a handler
 * that did not start does not start, and a handler that ends later has no
 * claim to answer.
 */
export class HeldRequests {
  #ended = false;
  readonly #ids = new Set<number>();

  get size(): number {
    return this.#ids.size;
  }

  /** Admits a request id; false after the end and for an id that the set holds. */
  admit(id: number): boolean {
    if (this.#ended || this.#ids.has(id)) return false;
    this.#ids.add(id);
    return true;
  }

  /** True while the set holds the id: the handler may start. The end takes every id. */
  mayStart(id: number): boolean {
    return this.#ids.has(id);
  }

  /** Takes the right to answer the request; false when the end took it first. */
  claim(id: number): boolean {
    return this.#ids.delete(id);
  }

  /** Ends the set: gives every held id and admits no more. */
  end(): ReadonlyArray<number> {
    this.#ended = true;
    const ids = [...this.#ids];
    this.#ids.clear();
    return ids;
  }
}

/** An authenticated connection and the requests that it waits for. */
interface ServedConnection {
  readonly connection: Connection;
  readonly held: HeldRequests;
}

/**
 * The end of a request whose handler failed with a defect: the request gets no
 * answer, so the connection closes and the client fails at once. When a
 * withdrawal took the request first, the withdrawal answers `not-live` and
 * ends the connection, so this leaves the connection alone.
 */
export const closeAfterDefect = (
  held: HeldRequests,
  id: number,
  connection: Connection,
): Effect.Effect<void> => Effect.suspend(() => (held.claim(id) ? connection.close : Effect.void));

/** A registration that this listener served; ended ones stay until the process ends. */
interface Served {
  readonly instanceId: string;
  readonly sessionId: string;
  /** `update` changes the name and the folder; the identity stays. */
  name: string;
  cwd: string;
  readonly startTime: number;
  readonly secret: Buffer;
  readonly fileName: string;
  live: boolean;
  /** The entry needs a publication: never published, replaced, or its endpoint changed. */
  stale: boolean;
  /** The last successful publication; its descriptor stays until a replacement publishes. */
  published: PublishedEntry | undefined;
  readonly connections: Set<ServedConnection>;
}

type HandshakeEnd =
  | { readonly _tag: "Ready"; readonly served: Served }
  | { readonly _tag: "Ended" };

const targetKey = (instanceId: string, sessionId: string): string =>
  `${instanceId}\u0000${sessionId}`;

export interface Listener {
  /** Registers a session; one listener can hold several live registrations of one session id. */
  readonly register: (input: RegistrationInput) => Effect.Effect<Registration, TalkRegisterError>;
  /** Publishes a live registration again with a new name and folder, under the same identity. */
  readonly update: (
    registration: Target,
    input: RegistrationUpdate,
  ) => Effect.Effect<void, TalkUpdateError>;
  /** Ends a registration (E8 Withdrawal). An unknown or ended registration is no failure. */
  readonly withdraw: (registration: Target) => Effect.Effect<void>;
  /** Sets the handler of a request kind. */
  readonly handle: (kind: string, handler: RequestHandler) => Effect.Effect<void>;
  readonly status: Effect.Effect<ListenerStatus>;
}

/** Makes the listener of this process. Its scope ends every live registration and closes the endpoint. */
export const makeListener = Effect.fnUntraced(function* (options: ListenerOptions) {
  const registry = yield* TalkRegistry;
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();
  const registrations = new Map<string, Served>();
  /** The instance id of every registration that `registrations` keeps, withdrawn ones included. */
  const servedIds = new Set<string>();
  const handlers = new Map<string, RequestHandler>([[PING_KIND, () => Effect.succeed("pong")]]);
  const pendingRemovals = new Set<string>();
  // Accepted sockets whose handshake has not ended; disposal destroys them.
  const handshaking = new Set<Socket>();
  let bound: BoundEndpoint | undefined;
  let closedListeners = 0;
  let repairPasses = 0;
  let lastRepairFailure = "";

  /** The entry of a registration; `metadata` gives the name and folder to publish. */
  const entryOf = (
    served: Served,
    endpoint: Endpoint,
    metadata: RegistrationUpdate = served,
  ): RegistryEntry => ({
    version: PROTOCOL_VERSION,
    instanceId: served.instanceId,
    sessionId: served.sessionId,
    name: metadata.name,
    cwd: metadata.cwd,
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
    // A withdrawal that came first took the request: the handler does not start.
    if (!served.live || !link.held.mayStart(request.id)) return;
    const handler = handlers.get(request.kind);
    const result: ResponseResult =
      handler === undefined
        ? { status: "unknown-kind" }
        : {
            status: "ok",
            body: yield* handler(request.body, {
              registration: { instanceId: served.instanceId, sessionId: served.sessionId },
              kind: request.kind,
            }),
          };
    // A withdrawal answers a held request with `not-live` and takes its claim.
    if (!link.held.claim(request.id)) return;
    const written = yield* Effect.result(
      link.connection.write({ type: "response", id: request.id, result }),
    );
    if (Result.isFailure(written)) {
      // A response that cannot go out (for example above the frame cap) closes the connection,
      // so the client fails at once.
      yield* Effect.logWarning(
        `talk: the response to ${request.kind} failed: ${describeFailure(written.failure)}`,
      );
      yield* link.connection.close;
    }
  });

  // #250 E7: a refusal, or a throw, of the admission hook counts as an inactive registration.
  const admitted = (served: Served): boolean => {
    if (options.admit === undefined) return true;
    try {
      return options.admit({ instanceId: served.instanceId, sessionId: served.sessionId });
    } catch {
      return false;
    }
  };

  const serveRequests = Effect.fnUntraced(function* (connection: Connection, served: Served) {
    if (!served.live) return yield* connection.finish;
    const link: ServedConnection = { connection, held: new HeldRequests() };
    served.connections.add(link);
    yield* Effect.gen(function* () {
      for (;;) {
        const request = yield* Effect.flatMap(connection.read, decodeRequest);
        if (!served.live || !link.held.admit(request.id)) continue;
        if (!admitted(served)) {
          // The withdrawal answers the held request with `not-live` and ends the connection.
          yield* withdraw(served);
          continue;
        }
        yield* Effect.forkChild(
          answer(link, served, request).pipe(
            Effect.catchDefect((defect) =>
              Effect.andThen(
                Effect.logWarning(`talk: the handler of ${request.kind} failed`, defect),
                closeAfterDefect(link.held, request.id, connection),
              ),
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
    // The deadline counts from accept; a failure or a timeout closes the connection before any payload.
    const end = yield* handshake(connection).pipe(
      Effect.timeoutOption(options.handshakeTimeoutMs),
      Effect.result,
      Effect.onInterrupt(() => connection.close),
      Effect.ensuring(Effect.sync(() => handshaking.delete(socket))),
    );
    if (Result.isFailure(end) || Option.isNone(end.success)) return yield* connection.close;
    const outcome = end.success.value;
    if (outcome._tag === "Ended") return yield* connection.finish;
    yield* serveRequests(connection, outcome.served);
  });

  const onConnection = (socket: Socket): void => {
    socket.on("error", () => undefined);
    if (handshaking.size >= options.maxUnauthenticated) {
      socket.destroy();
      return;
    }
    handshaking.add(socket);
    runFork(serveSocket(socket));
  };

  // --- Registration ---------------------------------------------------------------

  const bind = bindEndpoint({ folder: registry.folder, platform: options.platform, onConnection });

  /**
   * Publishes the entry of a registration with `endpoint`, and with
   * `metadata` as its name and folder. The kept descriptor of the last
   * publication stays until the new one succeeds, and the served name and
   * folder change only then; a failure leaves the entry stale with the old
   * name and folder, and passes up.
   */
  const publishServed = Effect.fnUntraced(function* (
    served: Served,
    endpoint: Endpoint,
    metadata: RegistrationUpdate = served,
  ) {
    served.stale = true;
    const published = yield* registry.publish(entryOf(served, endpoint, metadata));
    const previous = served.published;
    served.published = published;
    served.name = metadata.name;
    served.cwd = metadata.cwd;
    served.stale = false;
    // A replacement of that name is published: a pending removal of the name must not remove it.
    pendingRemovals.delete(served.fileName);
    if (previous !== undefined) yield* registry.release(previous);
  });

  const register = Effect.fn("TalkListener.register")(function* (input: RegistrationInput) {
    const sessionId = yield* decodeSessionId(input.sessionId).pipe(
      Effect.mapError(
        (issue) =>
          new TalkRegisterError({
            sessionId: String(input.sessionId),
            reason: `the session id is not valid: ${issue.message}`,
          }),
      ),
    );
    const chosen =
      input.instanceId === undefined
        ? undefined
        : yield* decodeInstanceId(input.instanceId).pipe(
            Effect.mapError(
              (issue) =>
                new TalkRegisterError({
                  sessionId,
                  reason: `the instance id is not valid: ${issue.message}`,
                }),
            ),
          );
    return yield* locked(
      Effect.gen(function* () {
        if (chosen !== undefined && servedIds.has(chosen))
          return yield* new TalkRegisterError({ sessionId, reason: "the instance id is in use" });
        yield* registry.prepare;
        if (bound === undefined) bound = yield* bind;
        const instanceId = chosen ?? randomNameHex();
        const served: Served = {
          instanceId,
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
        yield* publishServed(served, bound.endpoint);
        registrations.set(targetKey(instanceId, sessionId), served);
        servedIds.add(instanceId);
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

  const update = Effect.fn("TalkListener.update")(function* (
    registration: Target,
    input: RegistrationUpdate,
  ) {
    const { instanceId } = registration;
    yield* locked(
      Effect.gen(function* () {
        const served = registrations.get(targetKey(instanceId, registration.sessionId));
        if (served === undefined || !served.live || bound === undefined) {
          return yield* new TalkUpdateError({
            instanceId,
            reason: "no live registration of this listener matches",
          });
        }
        // The publication commits the new name and folder only when it succeeds, so a failed
        // one leaves the old ones, and the repair pass publishes those again.
        yield* publishServed(served, bound.endpoint, input);
      }),
    ).pipe(
      Effect.mapError((error) =>
        error._tag === "TalkUpdateError"
          ? error
          : new TalkUpdateError({ instanceId, reason: describeFailure(error) }),
      ),
    );
  });

  // E8 Withdrawal: mark ended, answer held requests with not-live, close the connections, then drop the entry.
  const endServed = Effect.fnUntraced(function* (served: Served) {
    // One step: the registration ends and takes every held request before any other fiber runs.
    const claims = yield* Effect.sync(() => {
      served.live = false;
      return [...served.connections].map((link) => ({ link, ids: link.held.end() }));
    });
    for (const { link, ids } of claims) {
      for (const id of ids) {
        yield* Effect.ignore(
          link.connection.write({ type: "response", id, result: { status: "not-live" } }),
        );
      }
      yield* link.connection.finish;
    }
    served.connections.clear();
    served.stale = false;
    const published = served.published;
    served.published = undefined;
    if (published !== undefined) yield* registry.release(published);
    const removed = yield* Effect.result(registry.remove(served.fileName));
    if (Result.isFailure(removed)) {
      pendingRemovals.add(served.fileName);
      yield* Effect.logWarning(
        `talk: removal of ${served.fileName} failed and is retried: ${describeFailure(removed.failure)}`,
      );
    }
  });

  const withdraw = Effect.fn("TalkListener.withdraw")(function* (registration: Target) {
    yield* locked(
      Effect.suspend(() => {
        const served = registrations.get(
          targetKey(registration.instanceId, registration.sessionId),
        );
        return served === undefined || !served.live ? Effect.void : endServed(served);
      }),
    );
  });

  // --- Lifetime (E8) ----------------------------------------------------------------

  const liveServed = (): Array<Served> =>
    [...registrations.values()].filter((served) => served.live);

  const noteRepairFailure = (subject: string, error: unknown) => {
    lastRepairFailure = `${subject}: ${describeFailure(error)}`;
    return Effect.logWarning(`talk: repair of ${lastRepairFailure}`);
  };

  // One entry: check it, and publish it again when it is stale or replaced.
  const repairEntry = Effect.fnUntraced(function* (served: Served, endpoint: Endpoint) {
    if (
      !served.stale &&
      served.published !== undefined &&
      (yield* registry.check(served.published)) === "intact"
    ) {
      return;
    }
    yield* publishServed(served, endpoint);
  });

  const repairPass = locked(
    Effect.gen(function* () {
      lastRepairFailure = "";
      const current = bound;
      if (current === undefined) return;
      for (const fileName of [...pendingRemovals]) {
        const removed = yield* Effect.result(registry.remove(fileName));
        if (Result.isSuccess(removed)) pendingRemovals.delete(fileName);
      }
      const live = liveServed();
      let rebind = false;
      // A folder that fails its trust check stops the pass here.
      if (!(yield* registry.folderPresent)) {
        // The entries went with the folder; on POSIX the socket went too. Windows keeps its port.
        yield* registry.prepare;
        for (const served of live) served.stale = true;
        rebind = registry.endpointKind === "unix";
      } else if (endpointState(current) === "replaced") {
        rebind = true;
      }
      let endpoint = current.endpoint;
      if (rebind) {
        // A failed candidate leaves the current listener as it is; the next pass tries again.
        const candidate = yield* bind;
        bound = candidate;
        endpoint = candidate.endpoint;
        yield* closeEndpoint(current);
        closedListeners += 1;
        for (const served of live) served.stale = true;
      }
      // Each entry on its own: a failure of one entry does not stop the others.
      for (const served of live) {
        const repaired = yield* Effect.result(repairEntry(served, endpoint));
        if (Result.isFailure(repaired)) yield* noteRepairFailure(served.fileName, repaired.failure);
      }
    }),
  ).pipe(
    Effect.catch((error) => noteRepairFailure("the pass", error)),
    Effect.ensuring(
      Effect.sync(() => {
        repairPasses += 1;
      }),
    ),
  );

  const refreshPass = locked(
    Effect.suspend(() =>
      Effect.forEach(
        liveServed(),
        (served) => {
          const published = served.published;
          if (published === undefined) return Effect.void;
          return registry
            .refresh(published)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `talk: refresh of ${published.path} failed: ${describeFailure(error)}`,
                ),
              ),
            );
        },
        { discard: true },
      ),
    ),
  );

  const every = (intervalMs: number, pass: Effect.Effect<void>) =>
    Effect.forever(Effect.andThen(Effect.sleep(intervalMs), pass));

  const repairFiber = yield* Effect.forkScoped(every(options.repairIntervalMs, repairPass));
  const refreshFiber =
    registry.endpointKind === "unix"
      ? yield* Effect.forkScoped(every(options.refreshIntervalMs, refreshPass))
      : undefined;

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Stop the passes first, so the shutdown never waits for a pass that holds the lock.
      yield* Fiber.interrupt(repairFiber);
      if (refreshFiber !== undefined) yield* Fiber.interrupt(refreshFiber);
      yield* locked(Effect.forEach(liveServed(), endServed, { discard: true }));
      if (bound !== undefined) yield* closeEndpoint(bound);
      // Accepted sockets in the handshake: their fibers stop with the scope, so close them here.
      for (const socket of handshaking) socket.destroy();
      handshaking.clear();
    }),
  );

  const status = Effect.sync((): ListenerStatus => {
    let heldRequests = 0;
    for (const served of registrations.values()) {
      for (const link of served.connections) heldRequests += link.held.size;
    }
    return {
      endpoint: bound?.endpoint,
      closedListeners,
      unauthenticated: handshaking.size,
      heldRequests,
      registrations: [...registrations.values()].map((served) => ({
        instanceId: served.instanceId,
        sessionId: served.sessionId,
        fileName: served.fileName,
        live: served.live,
        stale: served.stale,
      })),
      pendingRemovals: [...pendingRemovals],
      repairPasses,
      lastRepairFailure,
    };
  });

  const listener: Listener = {
    register,
    update,
    withdraw,
    handle: (kind, handler) =>
      Effect.sync(() => {
        handlers.set(kind, handler);
      }),
    status,
  };
  return listener;
});
