/**
 * The client of the talk transport (#249 E8 Client outcomes and Pruning,
 * #250 Step 2): the kept entries, the listing with pruning, the dial slots,
 * and requests with their routes and outcomes. Each connection runs connect,
 * the mutual proof, the request, and the response. A request tries the #249
 * path (the kept endpoint, then the endpoint of a fresh entry) and, on POSIX,
 * each other socket whose name carries the process id of the target. The
 * first route that completes the mutual proof alone sends the request body,
 * and the other routes stop at that moment.
 */
import { type Socket, createConnection } from "node:net";

import { Deferred, Effect, Option, Predicate, Result, Schema, Semaphore } from "effect";

import { type Connection, makeConnection } from "./connection";
import type { Endpoint } from "./endpoint";
import {
  PROTOCOL_VERSION,
  computeHmac,
  decodeChallenge,
  decodeHandshakeEnd,
  decodeResponse,
  makeNonce,
  verifyHmac,
} from "./handshake";
import {
  type RegistryEntry,
  type RejectedEntry,
  type SocketFile,
  TalkRegistry,
  describeFailure,
  entryFileName,
} from "./registry";
import {
  PING_KIND,
  type RequestOutcome,
  type RequestTrace,
  type ResponseResult,
  type Target,
  TalkRequestFailed,
  decodeResponseResult,
} from "./request";

/** #250 E8: the most connections that this process opens to one target process id at a time. */
export const DIAL_SLOTS = 8;

export interface ClientOptions {
  /** The default timeout of a request. */
  readonly requestTimeoutMs: number;
  /** The timeout of a probe and of the connect test before pruning. */
  readonly probeTimeoutMs: number;
}

/** A listed registration, without its secret. */
export interface Peer {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  readonly processId: number;
  readonly startTime: number;
  readonly endpoint: Endpoint;
}

export interface PeerListing {
  readonly peers: ReadonlyArray<Peer>;
  /** Entry names whose files hold no usable entry; they stay in the folder. */
  readonly rejected: ReadonlyArray<RejectedEntry>;
  /** Entry names of dead registrations that this listing removed. */
  readonly pruned: ReadonlyArray<string>;
}

/** A connect failed. `absent`: the endpoint is missing or refuses the connection. */
class TalkConnectFailed extends Schema.TaggedError<
  TalkConnectFailed,
  { readonly brand: unique symbol }
>()("TalkConnectFailed", {
  absent: Schema.Boolean,
  reason: Schema.String,
}) {}

/** What a request got from its routes. */
type Exchange =
  | { readonly _tag: "Result"; readonly result: ResponseResult }
  | { readonly _tag: "Ended" }
  | { readonly _tag: "AuthFailed" }
  | { readonly _tag: "Absent"; readonly reason: string }
  | { readonly _tag: "Unreachable"; readonly reason: string }
  /** The #249 path could not read the fresh entry. */
  | { readonly _tag: "LookupFailed"; readonly failure: TalkRequestFailed }
  /** The guard of the caller refused the body after the mutual proof; no body went out. */
  | { readonly _tag: "Cancelled" };

/** What one connection gave: an exchange, or `Lost` when another route completed the proof first. */
type Attempt = Exchange | { readonly _tag: "Lost" };

/** The end of one route; `won` when it took the claim of the request. */
interface RouteEnd {
  readonly won: boolean;
  readonly attempt: Attempt;
}

const LOST: Attempt = { _tag: "Lost" };
const AUTH_FAILED: Attempt = { _tag: "AuthFailed" };
const ENDED: Attempt = { _tag: "Ended" };
const CANCELLED: Attempt = { _tag: "Cancelled" };

/** What a request sends, and the check that runs right before its body goes out. */
interface Outgoing {
  readonly kind: string;
  readonly body: Schema.Json;
  /** False keeps the body back: the connection closes and the request ends as interrupted. */
  readonly beforeBody: () => boolean;
  /** Set: the route that sends the body records its write and its answer there (#260 H5). */
  readonly trace: RequestTrace | undefined;
}

const ALWAYS_SEND = (): boolean => true;

/** The one immutable request of every probe: the target varies, the ping does not (L7). */
const PING: Outgoing = Object.freeze({
  kind: PING_KIND,
  body: null,
  beforeBody: ALWAYS_SEND,
  trace: undefined,
});

/** POSIX: the paths of the talk sockets in the folder, by the process id that each name carries. */
type SocketIndex = ReadonlyMap<number, ReadonlyArray<string>>;

const NO_SOCKETS: SocketIndex = new Map();

const indexSockets = (sockets: ReadonlyArray<SocketFile>): SocketIndex => {
  const index = new Map<number, Array<string>>();
  for (const socket of sockets) {
    const paths = index.get(socket.processId);
    if (paths === undefined) index.set(socket.processId, [socket.path]);
    else paths.push(socket.path);
  }
  return index;
};

const targetKey = (target: Target): string => `${target.instanceId}\u0000${target.sessionId}`;

const sameEndpoint = (left: Endpoint, right: Endpoint): boolean =>
  left.kind === "unix"
    ? right.kind === "unix" && left.path === right.path
    : right.kind === "tcp" && left.port === right.port;

/**
 * E6: a process id in use counts as alive, whatever process holds it. Only
 * `ESRCH` proves that no process holds it; every other error counts as alive.
 * `kill` is a test seam.
 */
export function processAlive(
  processId: number,
  kill: (processId: number, signal: number) => unknown = (pid, signal) => process.kill(pid, signal),
): boolean {
  try {
    kill(processId, 0);
    return true;
  } catch (error) {
    return !(Predicate.hasProperty(error, "code") && error.code === "ESRCH");
  }
}

const connectSocket = (endpoint: Endpoint) =>
  Effect.callback<Socket, TalkConnectFailed>((resume) => {
    const socket =
      endpoint.kind === "unix"
        ? createConnection({ path: endpoint.path })
        : createConnection({ host: "127.0.0.1", port: endpoint.port });
    const onError = (error: Error): void => {
      const code = Predicate.hasProperty(error, "code") ? String(error.code) : "";
      resume(
        Effect.fail(
          new TalkConnectFailed({
            absent: code === "ENOENT" || code === "ECONNREFUSED",
            reason: error.message,
          }),
        ),
      );
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      // Later errors reach the connection through its close.
      socket.on("error", () => undefined);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => {
      socket.destroy();
    });
  });

const failed = (outcome: RequestOutcome, reason: string): TalkRequestFailed =>
  new TalkRequestFailed({ outcome, reason });

export interface Client {
  readonly list: Effect.Effect<PeerListing, TalkListError>;
  /**
   * `beforeBody` runs after the mutual proof, right before the body goes out.
   * When it returns false, no body goes out, the connection closes, and the
   * request ends as interrupted, as an abort of its caller does (#251 G3).
   * `trace` gets the state of the body write and the answer of the response
   * frame as they happen, so it holds them also after an interrupt (#260 H5).
   */
  readonly request: (
    target: Target,
    kind: string,
    body: Schema.Json,
    timeoutMs?: number,
    beforeBody?: () => boolean,
    trace?: RequestTrace,
  ) => Effect.Effect<Schema.Json, TalkRequestFailed>;
  /**
   * A `ping` to each target with the probe timeout, all at the same time; the
   * results are in the order of the targets. The batch reads the socket names
   * of the folder once and shares that snapshot.
   */
  readonly probeAll: (
    targets: ReadonlyArray<Target>,
  ) => Effect.Effect<ReadonlyArray<Result.Result<void, TalkRequestFailed>>>;
  /**
   * Reads the entry of the pair now and keeps it like a listed entry, so a
   * later request reaches the pair without its entry file; `not-found` when no
   * entry names the pair.
   */
  readonly retain: (target: Target) => Effect.Effect<void, TalkRequestFailed>;
  /** The pair of a kept entry with exactly this instance id; never its secret. */
  readonly known: (instanceId: string) => Effect.Effect<Option.Option<Target>>;
}

/** The registry folder could not be listed. */
export class TalkListError extends Schema.TaggedError<
  TalkListError,
  { readonly brand: unique symbol }
>()("TalkListError", {
  reason: Schema.String,
}) {}

export const makeClient = Effect.fnUntraced(function* (options: ClientOptions) {
  const registry = yield* TalkRegistry;
  // The entry of each target that this client listed, retained, or reached (E8 Client outcomes).
  const kept = new Map<string, RegistryEntry>();
  // The pair of each kept instance id, for `known`.
  const keptPairs = new Map<string, Target>();
  // The dial slots of each target process id and the count of dials that use them.
  const slotPools = new Map<number, { readonly slots: Semaphore.Semaphore; users: number }>();
  let nextRequestId = 0;

  const keep = (entry: RegistryEntry): void => {
    kept.set(targetKey(entry), entry);
    keptPairs.set(entry.instanceId, { instanceId: entry.instanceId, sessionId: entry.sessionId });
  };

  /**
   * #250 E8: every connection to one target process id holds one of its
   * slots from the connect to the close, whichever caller opens it. A dial
   * without a free slot waits within the deadline of its caller.
   */
  const withDialSlot = <A, E>(processId: number, effect: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      let pool = slotPools.get(processId);
      if (pool === undefined) {
        pool = { slots: Semaphore.makeUnsafe(DIAL_SLOTS), users: 0 };
        slotPools.set(processId, pool);
      }
      const used = pool;
      used.users += 1;
      return used.slots
        .withPermits(1)(effect)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              used.users -= 1;
              if (used.users === 0) slotPools.delete(processId);
            }),
          ),
        );
    });

  // A lookup that fails (trust check, I/O, DPAPI) is no absence: it gives `unreachable` with the reason.
  const readEntry = (fileName: string) =>
    registry
      .read(fileName)
      .pipe(
        Effect.mapError((error) =>
          failed("unreachable", `the entry lookup failed: ${describeFailure(error)}`),
        ),
      );

  const converse = Effect.fnUntraced(function* (
    connection: Connection,
    entry: RegistryEntry,
    endpoint: Endpoint,
    outgoing: Outgoing,
    take: Effect.Effect<boolean>,
  ) {
    const clientNonce = yield* makeNonce;
    const { instanceId, sessionId } = entry;
    yield* connection.write({
      type: "hello",
      version: PROTOCOL_VERSION,
      instanceId,
      sessionId,
      nonce: clientNonce,
    });
    const challenge = yield* Effect.flatMap(connection.read, decodeChallenge);
    const secret = Buffer.from(entry.secret, "hex");
    const fields = { clientNonce, listenerNonce: challenge.nonce, instanceId, sessionId };
    if (!verifyHmac(secret, { ...fields, role: "listener" }, challenge.hmac)) return AUTH_FAILED;
    // The listener proved the secret at this endpoint: the client keeps the entry with it, unless
    // a newer observation (a listing, a re-read, or another route) replaced the entry that this
    // attempt used.
    const current = kept.get(targetKey(entry));
    if (current === undefined || current === entry) {
      keep(sameEndpoint(entry.endpoint, endpoint) ? entry : { ...entry, endpoint });
    }
    yield* connection.write({
      type: "proof",
      hmac: computeHmac(secret, { ...fields, role: "client" }),
    });
    const end = yield* Effect.flatMap(connection.read, decodeHandshakeEnd);
    // The mutual proof is complete; only the first route to get here sends the body.
    if (!(yield* take)) return LOST;
    if (end.type === "ended") return ENDED;
    // The last check of the caller: a body that goes out can reach the peer.
    if (!outgoing.beforeBody()) return CANCELLED;
    const id = nextRequestId;
    nextRequestId += 1;
    const { trace } = outgoing;
    yield* connection.write(
      { type: "request", id, kind: outgoing.kind, body: outgoing.body },
      trace === undefined
        ? undefined
        : (state) => {
            trace.write = state;
          },
    );
    for (;;) {
      const response = yield* Effect.flatMap(connection.read, decodeResponse);
      if (response.id !== id) continue;
      const result = yield* decodeResponseResult(response.result);
      if (trace !== undefined) trace.answer = result;
      const answered: Attempt = { _tag: "Result", result };
      return answered;
    }
  });

  /** One connection to `endpoint` for the pair of `entry`; `dialed` runs once the connect settled. */
  const attempt = (
    entry: RegistryEntry,
    endpoint: Endpoint,
    outgoing: Outgoing,
    take: Effect.Effect<boolean>,
    dialed: Effect.Effect<void> = Effect.void,
  ): Effect.Effect<Attempt> =>
    withDialSlot(
      entry.processId,
      Effect.gen(function* () {
        const socket = yield* Effect.result(connectSocket(endpoint));
        yield* dialed;
        if (Result.isFailure(socket)) {
          const { absent, reason } = socket.failure;
          const failure: Attempt = absent
            ? { _tag: "Absent", reason }
            : { _tag: "Unreachable", reason };
          return failure;
        }
        return yield* Effect.acquireUseRelease(
          makeConnection(socket.success),
          (connection) => converse(connection, entry, endpoint, outgoing, take),
          (connection) => connection.close,
        ).pipe(
          Effect.catch((error) =>
            Effect.succeed<Attempt>({ _tag: "Unreachable", reason: describeFailure(error) }),
          ),
        );
      }),
    );

  /**
   * POSIX: one read of the socket names in the folder. A failed read gives no
   * sockets, so only the #249 path dials.
   */
  const readSockets: Effect.Effect<SocketIndex> =
    registry.endpointKind === "unix"
      ? registry.sockets.pipe(
          Effect.map(indexSockets),
          Effect.orElseSucceed(() => NO_SOCKETS),
        )
      : Effect.succeed(NO_SOCKETS);

  /** POSIX: the other sockets in the snapshot whose name carries the process id of the entry. */
  const sameProcessSockets = (
    entry: RegistryEntry,
    sockets: SocketIndex,
  ): ReadonlyArray<Endpoint> => {
    const cached = entry.endpoint;
    if (cached.kind !== "unix") return [];
    return (sockets.get(entry.processId) ?? [])
      .filter((path) => path !== cached.path)
      .map((path): Endpoint => ({ kind: "unix", path }));
  };

  /**
   * #250 Step 2: the routes of one request. The #249 path dials first: the
   * kept endpoint and, when that is missing or refuses, the endpoint of a
   * fresh entry of the pair. Once its first connect settled, each other
   * socket of the process in `sockets` dials as a slot frees. No route stops
   * because another one exists before a route completes the mutual proof. The
   * first route that completes it alone sends the body; at that moment every
   * other route stops, so its connection closes and its slot, or its wait for
   * a slot, ends. Without such a route, the result of the #249 path stands.
   */
  const deliver = Effect.fnUntraced(function* (
    target: Target,
    outgoing: Outgoing,
    sockets: Effect.Effect<SocketIndex>,
  ) {
    const key = targetKey(target);
    const fileName = entryFileName(target.instanceId, target.sessionId);
    const first = kept.get(key) ?? Option.getOrUndefined(yield* readEntry(fileName));
    if (first === undefined) {
      return yield* failed("not-found", "no entry and no kept entry names the target");
    }
    const others = sameProcessSockets(first, yield* sockets);
    // The first route that completes the mutual proof completes the claim.
    const claim = yield* Deferred.make<void>();
    // The entry of the last attempt of the #249 path.
    let last = first;

    const route = (run: (take: Effect.Effect<boolean>) => Effect.Effect<Attempt>) =>
      Effect.suspend(() => {
        let won = false;
        // `won` is set before the claim completes: completion can resume the waiters at once.
        const take = Effect.sync(() => {
          if (Deferred.isDoneUnsafe(claim)) return false;
          won = true;
          return Deferred.doneUnsafe(claim, Effect.void);
        });
        // Another route took the claim: this one stops. The route that took it runs to its end.
        const lost = Effect.andThen(
          Deferred.await(claim),
          Effect.suspend(() => (won ? Effect.never : Effect.succeed(LOST))),
        );
        return Effect.map(Effect.raceFirst(run(take), lost), (end): RouteEnd => ({
          won,
          attempt: end,
        }));
      });

    const path249 = (dialed: Effect.Effect<void>) =>
      route((take) =>
        Effect.gen(function* () {
          const outcome = yield* attempt(first, first.endpoint, outgoing, take, dialed);
          if (outcome._tag !== "Absent") return outcome;
          // The listener may have bound a new endpoint: read the entry once more and dial there.
          const reread = yield* Effect.result(readEntry(fileName));
          if (Result.isFailure(reread)) {
            const lookupFailed: Attempt = { _tag: "LookupFailed", failure: reread.failure };
            return lookupFailed;
          }
          const fresh = Option.getOrUndefined(reread.success);
          if (fresh === undefined || sameEndpoint(fresh.endpoint, first.endpoint)) return outcome;
          last = fresh;
          keep(fresh);
          return yield* attempt(fresh, fresh.endpoint, outgoing, take);
        }),
      );

    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const settled = yield* Deferred.make<Exchange>();
        const dialed = yield* Deferred.make<void>();
        let open = 1 + others.length;
        let fallback: Exchange = { _tag: "Unreachable", reason: "no route answered" };
        const settle = (end: RouteEnd, of249: boolean) =>
          Effect.suspend(() => {
            const result = end.attempt;
            if (result._tag === "Lost") {
              open -= 1;
              return Effect.void;
            }
            if (end.won) return Deferred.succeed(settled, result);
            // A socket found by process id alone never replaces the result of the #249 path.
            if (of249) fallback = result;
            open -= 1;
            return open === 0 ? Deferred.succeed(settled, fallback) : Effect.void;
          });
        yield* Effect.forkScoped(
          Effect.flatMap(path249(Deferred.succeed(dialed, undefined)), (end) => settle(end, true)),
        );
        if (others.length > 0) {
          yield* Effect.forkScoped(
            Effect.andThen(
              Deferred.await(dialed),
              Effect.forEach(
                others,
                (endpoint) =>
                  Effect.forkScoped(
                    Effect.flatMap(
                      route((take) => attempt(first, endpoint, outgoing, take)),
                      (end) => settle(end, false),
                    ),
                  ),
                { discard: true },
              ),
            ),
          );
        }
        return yield* Deferred.await(settled);
      }),
    );

    switch (outcome._tag) {
      case "Result": {
        const { result } = outcome;
        if (result.status === "ok") return result.body;
        if (result.status === "not-live") {
          return yield* failed("not-live", "the target ended while the listener held the request");
        }
        return yield* failed(
          "unknown-kind",
          `the target has no handler for the kind ${outgoing.kind}`,
        );
      }
      case "Ended":
        return yield* failed("not-live", "the listener reported that the registration ended");
      case "AuthFailed":
        return yield* failed(
          "auth-failed",
          "the listener proof does not match the secret of the entry",
        );
      case "Absent":
        return yield* processAlive(last.processId)
          ? failed("unreachable", `${outcome.reason}; process id ${last.processId} is in use`)
          : failed("not-live", `${outcome.reason}; no process holds process id ${last.processId}`);
      case "Unreachable":
        return yield* failed("unreachable", outcome.reason);
      case "LookupFailed":
        return yield* outcome.failure;
      case "Cancelled":
        return yield* Effect.interrupt;
    }
  });

  const deliverWithin = (
    target: Target,
    outgoing: Outgoing,
    timeoutMs: number,
    sockets: Effect.Effect<SocketIndex>,
  ) =>
    deliver(target, outgoing, sockets).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(failed("timeout", `no answer within ${timeoutMs} ms`)),
      }),
    );

  // A request alone reads the socket names now, so it finds a socket that a rebind made just before.
  const request = Effect.fn("TalkClient.request")(function* (
    target: Target,
    kind: string,
    body: Schema.Json,
    timeoutMs: number = options.requestTimeoutMs,
    beforeBody: () => boolean = ALWAYS_SEND,
    trace?: RequestTrace,
  ) {
    return yield* deliverWithin(target, { kind, body, beforeBody, trace }, timeoutMs, readSockets);
  });

  // A probe batch reads the socket names once, when its first route needs them.
  const probeAll = Effect.fn("TalkClient.probeAll")(function* (targets: ReadonlyArray<Target>) {
    const sockets = yield* Effect.cached(readSockets);
    return yield* Effect.forEach(
      targets,
      (target) =>
        Effect.result(Effect.asVoid(deliverWithin(target, PING, options.probeTimeoutMs, sockets))),
      { concurrency: "unbounded" },
    );
  });

  // E8 Pruning: an endpoint that is missing or refuses the connection while its process id is dead.
  const gone = Effect.fnUntraced(function* (processId: number, endpoint: Endpoint) {
    if (processAlive(processId)) return false;
    const reach = yield* withDialSlot(
      processId,
      Effect.tap(connectSocket(endpoint), (socket) => Effect.sync(() => socket.destroy())),
    ).pipe(Effect.timeoutOption(options.probeTimeoutMs), Effect.result);
    if (Result.isSuccess(reach)) return false;
    return reach.failure.absent && !processAlive(processId);
  });

  // #250 Step 2: a socket file that no entry names, whose owner process is gone, and that refuses.
  const pruneOrphanSockets = Effect.fnUntraced(function* (named: ReadonlySet<string>) {
    const sockets = yield* Effect.result(registry.sockets);
    if (Result.isFailure(sockets)) {
      return yield* Effect.logWarning(
        `talk: the socket sweep failed: ${describeFailure(sockets.failure)}`,
      );
    }
    for (const socket of sockets.success) {
      const endpoint: Endpoint = { kind: "unix", path: socket.path };
      if (named.has(socket.path) || !(yield* gone(socket.processId, endpoint))) continue;
      const removed = yield* Effect.result(registry.removeSocket(endpoint));
      if (Result.isFailure(removed)) {
        yield* Effect.logWarning(
          `talk: removing ${socket.path} failed: ${describeFailure(removed.failure)}`,
        );
      }
    }
  });

  const list = Effect.gen(function* () {
    const listing = yield* registry.list;
    const peers: Array<Peer> = [];
    const pruned: Array<string> = [];
    const named = new Set<string>();
    for (const { fileName, entry } of listing.entries) {
      if (entry.endpoint.kind === "unix") named.add(entry.endpoint.path);
      if (yield* gone(entry.processId, entry.endpoint)) {
        const removed = yield* Effect.result(
          Effect.andThen(registry.remove(fileName), registry.removeSocket(entry.endpoint)),
        );
        if (Result.isSuccess(removed)) pruned.push(fileName);
        else
          yield* Effect.logWarning(
            `talk: pruning ${fileName} failed: ${describeFailure(removed.failure)}`,
          );
        continue;
      }
      // A listing replaces the kept entry; a kept entry that it omits, pruned ones too, stays.
      keep(entry);
      peers.push({
        instanceId: entry.instanceId,
        sessionId: entry.sessionId,
        name: entry.name,
        cwd: entry.cwd,
        processId: entry.processId,
        startTime: entry.startTime,
        endpoint: entry.endpoint,
      });
    }
    if (registry.endpointKind === "unix") yield* pruneOrphanSockets(named);
    const result: PeerListing = { peers, rejected: listing.rejected, pruned };
    return result;
  }).pipe(Effect.mapError((error) => new TalkListError({ reason: describeFailure(error) })));

  const retain = Effect.fn("TalkClient.retain")(function* (target: Target) {
    const entry = yield* readEntry(entryFileName(target.instanceId, target.sessionId));
    if (Option.isNone(entry)) {
      return yield* failed("not-found", "no entry names the target");
    }
    keep(entry.value);
  });

  const client: Client = {
    list,
    request,
    probeAll,
    retain,
    known: (instanceId) => Effect.sync(() => Option.fromNullishOr(keptPairs.get(instanceId))),
  };
  return client;
});
