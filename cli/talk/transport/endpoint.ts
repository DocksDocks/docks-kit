/**
 * The endpoint of the process listener (#249 E7, #248 D2 POSIX and Windows
 * endpoint). POSIX: a Unix socket with a fresh random name for each bind,
 * directly in the registry folder, checked with `lstat` after the bind. The
 * transport never changes the mode of a socket path. Windows: TCP on
 * 127.0.0.1 with a port that the system picks, and no socket file.
 */
import { randomBytes } from "node:crypto";
import { type Server, type Socket, createServer } from "node:net";
import { posix } from "node:path";
import { Effect, Schema } from "effect";

import { type EntryStat, isSameFile, liveView } from "./trustPosix";

/** Socket names that talk owns in the registry folder (E5 Names). */
export const SOCKET_NAME = /^[0-9a-f]{16}\.sock$/;

/** The byte count of the random part of a talk name: 16 hex characters. */
export const NAME_RANDOM_BYTES = 8;

/** The size of `sun_path` with its terminating null byte (#248 F9). */
export const SUN_PATH_BYTES = { linux: 108, darwin: 104 } as const;

const OWNER_WRITE = 0o200;
const LOOPBACK = "127.0.0.1";

export const UnixEndpoint = Schema.Struct({
  kind: Schema.Literal("unix"),
  path: Schema.NonEmptyString,
});

export const TcpEndpoint = Schema.Struct({
  kind: Schema.Literal("tcp"),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
});

/** The endpoint that a registry entry records. */
export const Endpoint = Schema.Union([UnixEndpoint, TcpEndpoint]);
export type Endpoint = typeof Endpoint.Type;

/** The endpoint kind of a system: a Unix socket on POSIX, TCP on Windows. */
export type EndpointKind = Endpoint["kind"];

export const endpointKindFor = (platform: NodeJS.Platform): EndpointKind =>
  platform === "win32" ? "tcp" : "unix";

/** A bind failed or its result failed the E7 check. `path` names the socket path, or is empty for TCP. */
export class TalkEndpointError extends Schema.TaggedError<
  TalkEndpointError,
  { readonly brand: unique symbol }
>()("TalkEndpointError", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** A fresh random talk name part: 16 lowercase hex characters. */
export const randomNameHex = (): string => randomBytes(NAME_RANDOM_BYTES).toString("hex");

/** Fails a socket path that does not fit in `sun_path` with its null byte. */
export function sunPathFault(path: string, platform: NodeJS.Platform): string | undefined {
  const limit = platform === "darwin" ? SUN_PATH_BYTES.darwin : SUN_PATH_BYTES.linux;
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes < limit) return undefined;
  return `the socket path ${path} has ${bytes} bytes; sun_path on ${platform} holds at most ${limit - 1} bytes`;
}

/** E7: the bound path must be a socket of the user with the owner write bit. */
export function socketFault(stat: EntryStat, user: number): string | undefined {
  if (stat.kind !== "socket") return `the path is a ${stat.kind}, not a socket`;
  if (stat.uid !== user)
    return `the socket is owned by uid ${stat.uid}, not by the user (uid ${user})`;
  if ((stat.mode & OWNER_WRITE) === 0) {
    return (
      `the socket has no owner write bit (mode ${stat.mode.toString(8).padStart(4, "0")}); ` +
      "check the umask and the default ACL of the registry folder"
    );
  }
  return undefined;
}

/** A listening server and the endpoint that it serves. */
export interface BoundEndpoint {
  readonly server: Server;
  readonly endpoint: Endpoint;
  /** POSIX: the socket file as the E7 check saw it. */
  readonly socket: EntryStat | undefined;
}

export interface BindOptions {
  readonly folder: string;
  readonly platform: NodeJS.Platform;
  readonly onConnection: (socket: Socket) => void;
}

const listen = (
  server: Server,
  options: { readonly path: string } | { readonly host: string; readonly port: number },
  path: string,
) =>
  Effect.callback<void, TalkEndpointError>((resume) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      resume(
        Effect.fail(new TalkEndpointError({ path, reason: `listen failed: ${error.message}` })),
      );
    };
    const onListening = (): void => {
      server.off("error", onError);
      resume(Effect.void);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options);
    return Effect.sync(() => {
      if (server.listening) server.close();
    });
  });

const closeServer = (server: Server): void => {
  if (server.listening) server.close();
};

/**
 * Binds a new listener. POSIX: a fresh socket name in `folder`, the
 * `sun_path` size check, and after the bind the E7 `lstat` check; a candidate
 * that fails the check is closed. Windows: 127.0.0.1 with port 0.
 */
export const bindEndpoint = Effect.fn("bindEndpoint")(function* (options: BindOptions) {
  const server = createServer(options.onConnection);
  if (endpointKindFor(options.platform) === "tcp") {
    yield* listen(server, { host: LOOPBACK, port: 0 }, "");
    const address = server.address();
    if (address === null || typeof address === "string") {
      closeServer(server);
      return yield* new TalkEndpointError({ path: "", reason: "the TCP listener has no port" });
    }
    server.on("error", () => undefined);
    const bound: BoundEndpoint = {
      server,
      endpoint: { kind: "tcp", port: address.port },
      socket: undefined,
    };
    return bound;
  }
  const user = process.getuid?.();
  const path = posix.join(options.folder, `${randomNameHex()}.sock`);
  if (user === undefined) {
    return yield* new TalkEndpointError({ path, reason: "a Unix socket needs a POSIX user id" });
  }
  const sizeFault = sunPathFault(path, options.platform);
  if (sizeFault !== undefined) return yield* new TalkEndpointError({ path, reason: sizeFault });
  yield* listen(server, { path }, path);
  const named = liveView.lstat(path);
  const fault =
    named._tag === "Found"
      ? socketFault(named.stat, user)
      : named._tag === "Missing"
        ? "the socket file is missing after the bind"
        : `lstat failed: ${named.reason}`;
  if (fault !== undefined || named._tag !== "Found") {
    closeServer(server);
    return yield* new TalkEndpointError({ path, reason: fault ?? "the socket check failed" });
  }
  server.on("error", () => undefined);
  const bound: BoundEndpoint = { server, endpoint: { kind: "unix", path }, socket: named.stat };
  return bound;
});

/**
 * Checks a bound endpoint again (E8 Lifetime): a POSIX socket path must still
 * hold the socket that the bind made, with the E7 rule. A missing path or
 * another object counts as replaced. TCP has no file.
 */
export function endpointState(bound: BoundEndpoint): "intact" | "replaced" {
  if (!bound.server.listening) return "replaced";
  if (bound.endpoint.kind === "tcp" || bound.socket === undefined) return "intact";
  const named = liveView.lstat(bound.endpoint.path);
  if (named._tag !== "Found") return "replaced";
  const user = process.getuid?.() ?? -1;
  return socketFault(named.stat, user) === undefined && isSameFile(named.stat, bound.socket)
    ? "intact"
    : "replaced";
}

/** Stops new connections. Open connections stay; Bun and libuv remove the bound socket path. */
export const closeEndpoint = (bound: BoundEndpoint): Effect.Effect<void> =>
  Effect.sync(() => closeServer(bound.server));
