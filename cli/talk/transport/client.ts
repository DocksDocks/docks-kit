/**
 * The client of the talk transport (#249 E8 Client outcomes and Pruning): the
 * kept entries, the listing with pruning, and requests with their outcomes.
 * Each request uses one connection: connect, the mutual proof, the request,
 * and the response.
 */
import { type Socket, createConnection } from "node:net";

import { Effect, Option, Predicate, Result, Schema } from "effect";

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
  TalkRegistry,
  describeFailure,
  entryFileName,
} from "./registry";
import {
  PING_KIND,
  type RequestOutcome,
  type ResponseResult,
  type Target,
  TalkRequestFailed,
  decodeResponseResult,
} from "./request";

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

/** What one connection to an endpoint gave. */
type Exchange =
  | { readonly _tag: "Result"; readonly result: ResponseResult }
  | { readonly _tag: "Ended" }
  | { readonly _tag: "AuthFailed" }
  | { readonly _tag: "Absent"; readonly reason: string }
  | { readonly _tag: "Unreachable"; readonly reason: string };

const targetKey = (target: Target): string => `${target.instanceId}\u0000${target.sessionId}`;

const sameEndpoint = (left: Endpoint, right: Endpoint): boolean =>
  left.kind === "unix"
    ? right.kind === "unix" && left.path === right.path
    : right.kind === "tcp" && left.port === right.port;

/**
 * E6: a process id in use counts as alive, whatever process holds it. `EPERM`
 * means a process of another user holds it.
 */
export function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Predicate.hasProperty(error, "code") && error.code === "EPERM";
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
  readonly request: (
    target: Target,
    kind: string,
    body: Schema.Json,
    timeoutMs?: number,
  ) => Effect.Effect<Schema.Json, TalkRequestFailed>;
  /** A `ping` with the probe timeout. */
  readonly probe: (target: Target) => Effect.Effect<void, TalkRequestFailed>;
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
  // The entry of each target that this client listed or reached (E8 Client outcomes).
  const kept = new Map<string, RegistryEntry>();
  let nextRequestId = 0;

  const readEntry = (fileName: string) =>
    registry.read(fileName).pipe(Effect.catch(() => Effect.succeedNone));

  const converse = Effect.fnUntraced(function* (
    connection: Connection,
    entry: RegistryEntry,
    kind: string,
    body: Schema.Json,
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
    if (!verifyHmac(secret, { ...fields, role: "listener" }, challenge.hmac)) {
      const authFailed: Exchange = { _tag: "AuthFailed" };
      return authFailed;
    }
    yield* connection.write({
      type: "proof",
      hmac: computeHmac(secret, { ...fields, role: "client" }),
    });
    const end = yield* Effect.flatMap(connection.read, decodeHandshakeEnd);
    if (end.type === "ended") {
      const ended: Exchange = { _tag: "Ended" };
      return ended;
    }
    const id = nextRequestId;
    nextRequestId += 1;
    yield* connection.write({ type: "request", id, kind, body });
    for (;;) {
      const response = yield* Effect.flatMap(connection.read, decodeResponse);
      if (response.id !== id) continue;
      const exchange: Exchange = {
        _tag: "Result",
        result: yield* decodeResponseResult(response.result),
      };
      return exchange;
    }
  });

  const exchange = Effect.fnUntraced(function* (
    entry: RegistryEntry,
    kind: string,
    body: Schema.Json,
  ) {
    const socket = yield* Effect.result(connectSocket(entry.endpoint));
    if (Result.isFailure(socket)) {
      const { absent, reason } = socket.failure;
      const failure: Exchange = absent
        ? { _tag: "Absent", reason }
        : { _tag: "Unreachable", reason };
      return failure;
    }
    return yield* Effect.acquireUseRelease(
      makeConnection(socket.success),
      (connection) => converse(connection, entry, kind, body),
      (connection) => connection.close,
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed<Exchange>({ _tag: "Unreachable", reason: describeFailure(error) }),
      ),
    );
  });

  const deliver = Effect.fnUntraced(function* (target: Target, kind: string, body: Schema.Json) {
    const key = targetKey(target);
    const fileName = entryFileName(target.instanceId, target.sessionId);
    let entry = kept.get(key) ?? Option.getOrUndefined(yield* readEntry(fileName));
    if (entry === undefined) {
      return yield* failed("not-found", "no entry and no kept entry names the target");
    }
    let outcome = yield* exchange(entry, kind, body);
    if (outcome._tag === "Absent") {
      // The listener may have bound a new endpoint: read the entry once more and retry there.
      const reread = yield* readEntry(fileName);
      if (Option.isSome(reread) && !sameEndpoint(reread.value.endpoint, entry.endpoint)) {
        entry = reread.value;
        kept.set(key, entry);
        outcome = yield* exchange(entry, kind, body);
      }
    }
    switch (outcome._tag) {
      case "Result": {
        kept.set(key, entry);
        const { result } = outcome;
        if (result.status === "ok") return result.body;
        if (result.status === "not-live") {
          return yield* failed("not-live", "the target ended while the listener held the request");
        }
        return yield* failed("unknown-kind", `the target has no handler for the kind ${kind}`);
      }
      case "Ended":
        kept.set(key, entry);
        return yield* failed("not-live", "the listener reported that the registration ended");
      case "AuthFailed":
        return yield* failed(
          "auth-failed",
          "the listener proof does not match the secret of the entry",
        );
      case "Absent":
        return yield* processAlive(entry.processId)
          ? failed("unreachable", `${outcome.reason}; process id ${entry.processId} is in use`)
          : failed("not-live", `${outcome.reason}; no process holds process id ${entry.processId}`);
      case "Unreachable":
        return yield* failed("unreachable", outcome.reason);
    }
  });

  const request = Effect.fn("TalkClient.request")(function* (
    target: Target,
    kind: string,
    body: Schema.Json,
    timeoutMs: number = options.requestTimeoutMs,
  ) {
    return yield* deliver(target, kind, body).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(failed("timeout", `no answer within ${timeoutMs} ms`)),
      }),
    );
  });

  // E8 Pruning: only a decoded entry whose endpoint is missing or refuses the connection while its process id is dead.
  const definitelyDead = Effect.fnUntraced(function* (entry: RegistryEntry) {
    if (processAlive(entry.processId)) return false;
    const reach = yield* connectSocket(entry.endpoint).pipe(
      Effect.timeoutOption(options.probeTimeoutMs),
      Effect.result,
    );
    if (Result.isSuccess(reach)) {
      if (Option.isSome(reach.success)) reach.success.value.destroy();
      return false;
    }
    return reach.failure.absent && !processAlive(entry.processId);
  });

  const list = Effect.gen(function* () {
    const listing = yield* registry.list;
    const peers: Array<Peer> = [];
    const pruned: Array<string> = [];
    for (const { fileName, entry } of listing.entries) {
      const key = targetKey(entry);
      if (yield* definitelyDead(entry)) {
        const removed = yield* Effect.result(
          Effect.andThen(registry.remove(fileName), registry.removeSocket(entry.endpoint)),
        );
        kept.delete(key);
        if (Result.isSuccess(removed)) pruned.push(fileName);
        else
          yield* Effect.logWarning(
            `talk: pruning ${fileName} failed: ${describeFailure(removed.failure)}`,
          );
        continue;
      }
      // A listing replaces the kept entry; a kept entry that it omits stays.
      kept.set(key, entry);
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
    const result: PeerListing = { peers, rejected: listing.rejected, pruned };
    return result;
  }).pipe(Effect.mapError((error) => new TalkListError({ reason: describeFailure(error) })));

  const client: Client = {
    list,
    request,
    probe: (target) => Effect.asVoid(request(target, PING_KIND, null, options.probeTimeoutMs)),
  };
  return client;
});
