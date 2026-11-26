import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect, Fiber, Layer, Logger, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeClient, processAlive } from "../../../talk/transport/client";
import {
  type Connection,
  MAX_BUFFERED_BYTES,
  makeConnection,
} from "../../../talk/transport/connection";
import type { Endpoint } from "../../../talk/transport/endpoint";
import { Nonce, PROTOCOL_VERSION, computeHmac } from "../../../talk/transport/handshake";
import {
  HeldRequests,
  type Listener,
  type ListenerStatus,
  closeAfterDefect,
  makeListener,
} from "../../../talk/transport/listener";
import {
  type PublishedEntry,
  type RegistryEntry,
  TalkRegistry,
  encodeEntry,
  entryFileName,
} from "../../../talk/transport/registry";
import { TalkDpapi, sealEntries } from "../../../talk/transport/sealWindows";
import { TalkTransport } from "../../../talk/transport/transport";
import { TalkFileError, TalkPosixSystem } from "../../../talk/transport/trustPosix";
import { BUN_RUNTIME } from "../../lib/cliEntry";
import { REPO_DIR } from "../../lib/goldenResources";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

// The transport tests of #249 E9 and a2. In-process cases drive the listener
// with a controlled clock, so they prove the exact deadline and repair
// interval. Spawned cases start `bun` peers that import the built bundle and
// talk through a short test registry folder with a 1 s repair interval.

const WINDOWS = process.platform === "win32";
const POSIX = !WINDOWS;
const LINUX = process.platform === "linux";
const BUILD_SCRIPT = join(REPO_DIR, "cli", "scripts", "build-talk.ts");
const PEER_SCRIPT = join(REPO_DIR, "cli", "test", "fixtures", "talk", "peer.ts");
const REPAIR_MS = 1_000;
const MAX_UNAUTHENTICATED = 32;
const HANDSHAKE_DEADLINE_MS = 1_000;
// The longest wait for a reaction that real I/O carries out (a close, a file), not a timer under test.
const SETTLE_MS = 2_000;

// The peers are other processes with real timers, so fake timers cannot drive them; `waitFor` polls
// the observed state instead of sleeping a guessed time.
const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Polls `check` until it gives true; fails after `timeoutMs`. Gives the time that it waited. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
  return Date.now() - started;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

// --- Raw frames for the listener checks ----------------------------------------

const frame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
};

/** Splits frames off a growing buffer; gives the rest. */
function takeFrames(buffered: Buffer, into: Array<{ readonly type?: string }>): Buffer {
  let rest = buffered;
  while (rest.byteLength >= 4 && rest.byteLength >= 4 + rest.readUInt32BE(0)) {
    const length = rest.readUInt32BE(0);
    into.push(JSON.parse(rest.subarray(4, 4 + length).toString("utf8")));
    rest = rest.subarray(4 + length);
  }
  return rest;
}

/** A raw connection that collects the frames that it receives and the time of its close. */
interface RawConnection {
  readonly socket: Socket;
  readonly frames: Array<{ readonly type?: string }>;
  closedAt: number | undefined;
}

function rawConnect(endpoint: Endpoint): Promise<RawConnection> {
  const { promise, resolve, reject } = Promise.withResolvers<RawConnection>();
  const socket =
    endpoint.kind === "unix"
      ? connect({ path: endpoint.path })
      : connect({ host: "127.0.0.1", port: endpoint.port });
  const raw: RawConnection = { socket, frames: [], closedAt: undefined };
  let buffered: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = takeFrames(Buffer.concat([buffered, chunk]), raw.frames);
  });
  socket.on("close", () => {
    raw.closedAt = Date.now();
  });
  socket.once("error", reject);
  socket.once("connect", () => resolve(raw));
  return promise;
}

// --- Pure parts ----------------------------------------------------------------

describe("withdrawal fence of held requests", () => {
  it("admits ids once, lets a handler start, and gives the claim to one side only", () => {
    const held = new HeldRequests();
    expect(held.admit(1)).toBe(true);
    expect(held.admit(1)).toBe(false);
    expect(held.mayStart(1)).toBe(true);
    expect(held.claim(1)).toBe(true);
    expect(held.claim(1)).toBe(false);
    expect(held.size).toBe(0);
  });

  it("takes every held id at the end, so no handler starts and no late answer has a claim", () => {
    const held = new HeldRequests();
    held.admit(1);
    held.admit(2);
    expect(held.end()).toEqual([1, 2]);
    expect(held.mayStart(1)).toBe(false);
    expect(held.claim(2)).toBe(false);
    expect(held.admit(3)).toBe(false);
    expect(held.size).toBe(0);
  });

  const fakeConnection = (closes: Array<string>): Connection => ({
    read: Effect.never,
    write: () => Effect.void,
    finish: Effect.void,
    close: Effect.sync(() => {
      closes.push("close");
    }),
    bufferedBytes: () => 0,
  });

  it("closes the connection after a handler defect only while the request is still held", async () => {
    const closes: Array<string> = [];
    const held = new HeldRequests();
    held.admit(1);
    held.admit(2);
    await Effect.runPromise(closeAfterDefect(held, 1, fakeConnection(closes)));
    expect(closes).toEqual(["close"]);
    // A withdrawal took request 2 first: it answers `not-live` and ends the connection itself.
    held.end();
    await Effect.runPromise(closeAfterDefect(held, 2, fakeConnection(closes)));
    expect(closes).toEqual(["close"]);
  });
});

describe("processAlive (E6)", () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(code), { code });
  };

  it("counts a process as dead only on ESRCH", () => {
    expect(processAlive(4242, () => true)).toBe(true);
    expect(processAlive(4242, failing("ESRCH"))).toBe(false);
    expect(processAlive(4242, failing("EPERM"))).toBe(true);
    expect(processAlive(4242, failing("EINVAL"))).toBe(true);
    expect(processAlive(process.pid)).toBe(true);
  });
});

describe("bounded connection input", () => {
  it("pauses the socket above one maximum frame of unread input and resumes as reads drain it", async () => {
    const server: Server = createServer();
    const accepted = Promise.withResolvers<Socket>();
    server.on("connection", (socket) => accepted.resolve(socket));
    const listening = Promise.withResolvers<void>();
    server.listen({ host: "127.0.0.1", port: 0 }, () => listening.resolve());
    await listening.promise;
    const address = server.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    const client = connect({ host: "127.0.0.1", port });
    try {
      const socket = await accepted.promise;
      const connection = await Effect.runPromise(makeConnection(socket));
      const body = "x".repeat(512 * 1024);
      const count = 12;
      for (let index = 0; index < count; index += 1) client.write(frame({ index, body }));
      await waitFor(() => socket.isPaused(), SETTLE_MS, "the paused socket");
      // Six MiB were sent; the buffer stays near one maximum frame.
      expect(connection.bufferedBytes()).toBeGreaterThan(MAX_BUFFERED_BYTES);
      expect(connection.bufferedBytes()).toBeLessThan(2 * MAX_BUFFERED_BYTES);
      const indexes: Array<unknown> = [];
      for (let index = 0; index < count; index += 1) {
        const value = (await Effect.runPromise(connection.read)) as { readonly index: number };
        indexes.push(value.index);
      }
      expect(indexes).toEqual(Array.from({ length: count }, (_, index) => index));
      expect(socket.isPaused()).toBe(false);
    } finally {
      client.destroy();
      server.close();
    }
  });
});

// --- In-process listener with a controlled clock ---------------------------------

type RegistryService = TalkRegistry["Service"];

/** The log lines of an in-process listener, for checks of its warnings. */
const logLines: Array<string> = [];
const collectLogs = Logger.layer([
  Logger.make((options) => {
    logLines.push(String(options.message));
  }),
]);

// A refresh period that is a whole number of repair periods, so a test clock can reach it.
const IN_PROCESS_REFRESH_MS = 5 * REPAIR_MS;

/** Runs `body` with a listener on a real POSIX registry that `wrap` can change, under a test clock. */
function withListener<A>(
  folder: string,
  wrap: (real: RegistryService) => RegistryService,
  body: (listener: Listener, registry: RegistryService) => Effect.Effect<A, unknown, Scope.Scope>,
): Promise<A> {
  const registry = Layer.effect(
    TalkRegistry,
    Effect.gen(function* () {
      return wrap(yield* TalkRegistry);
    }),
  ).pipe(Layer.provide(TalkRegistry.layerPosix(folder)), Layer.provide(TalkPosixSystem.layer));
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const listener = yield* makeListener({
          platform: process.platform,
          repairIntervalMs: REPAIR_MS,
          refreshIntervalMs: IN_PROCESS_REFRESH_MS,
          handshakeTimeoutMs: HANDSHAKE_DEADLINE_MS,
          maxUnauthenticated: MAX_UNAUTHENTICATED,
        });
        return yield* body(listener, yield* TalkRegistry);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(registry, collectLogs, TestClock.layer()))),
  );
}

const promised = <A>(run: () => Promise<A>) => Effect.promise(run);

/** Polls a listener status in real time, while the test clock stands still. */
const statusUntil = (
  source: { readonly status: Effect.Effect<ListenerStatus> },
  check: (status: ListenerStatus) => boolean,
  what: string,
) =>
  Effect.gen(function* () {
    const started = Date.now();
    while (!check(yield* source.status)) {
      if (Date.now() - started > SETTLE_MS) {
        return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      }
      yield* TestClock.withLive(Effect.sleep(25));
    }
  });

describe.skipIf(!POSIX)("listener lifetime under a test clock (in-process)", () => {
  let base = "";
  let folder = "";

  const fresh = (): void => {
    base = mkdtempSync(join(tmpdir(), "tl-"));
    folder = join(base, "reg");
  };

  const cleanUp = (): void => {
    rmSync(base, { recursive: true, force: true });
  };

  const register = (listener: Listener, sessionId: string) =>
    listener.register({ sessionId, name: sessionId, cwd: base });

  it("closes an unauthenticated connection at exactly the handshake deadline", async () => {
    fresh();
    try {
      await withListener(
        folder,
        (real) => real,
        (listener) =>
          Effect.gen(function* () {
            yield* register(listener, "deadline");
            const { endpoint } = yield* listener.status;
            const raw = yield* promised(() => rawConnect(endpoint!));
            yield* statusUntil(listener, (s) => s.unauthenticated === 1, "the accepted connection");
            yield* TestClock.adjust(HANDSHAKE_DEADLINE_MS - 1);
            yield* promised(() => sleep(200));
            expect(raw.closedAt).toBeUndefined();
            yield* TestClock.adjust(1);
            yield* promised(() =>
              waitFor(() => raw.closedAt !== undefined, SETTLE_MS, "the close at the deadline"),
            );
            expect(raw.frames).toEqual([]);
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("re-creates a deleted entry at exactly the repair interval", async () => {
    fresh();
    try {
      await withListener(
        folder,
        (real) => real,
        (listener) =>
          Effect.gen(function* () {
            const registration = yield* register(listener, "interval");
            const path = join(folder, registration.fileName);
            unlinkSync(path);
            yield* TestClock.adjust(REPAIR_MS - 1);
            yield* promised(() => sleep(200));
            expect(existsSync(path)).toBe(false);
            yield* TestClock.adjust(1);
            yield* promised(() => waitFor(() => existsSync(path), SETTLE_MS, "the entry"));
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("repairs each entry on its own when the check of another one fails", async () => {
    fresh();
    let failing = "";
    try {
      await withListener(
        folder,
        (real) => ({
          ...real,
          check: (published) =>
            published.fileName === failing
              ? Effect.fail(
                  new TalkFileError({ path: published.path, reason: "the read is denied" }),
                )
              : real.check(published),
        }),
        (listener) =>
          Effect.gen(function* () {
            const first = yield* register(listener, "first");
            const second = yield* register(listener, "second");
            failing = first.fileName;
            unlinkSync(join(folder, second.fileName));
            yield* TestClock.adjust(REPAIR_MS);
            yield* promised(() =>
              waitFor(
                () => existsSync(join(folder, second.fileName)),
                SETTLE_MS,
                "the second entry",
              ),
            );
            const status = yield* listener.status;
            expect(status.lastRepairFailure).toContain(first.fileName);
            expect(status.lastRepairFailure).toContain("the read is denied");
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("keeps the published descriptor until a replacement publishes", async () => {
    fresh();
    let failPublish = false;
    const published: Array<PublishedEntry> = [];
    const released: Array<number | undefined> = [];
    try {
      await withListener(
        folder,
        (real) => ({
          ...real,
          publish: (entry) =>
            failPublish
              ? Effect.fail(new TalkFileError({ path: folder, reason: "the disk is full" }))
              : Effect.tap(real.publish(entry), (done) => Effect.sync(() => published.push(done))),
          release: (entry) =>
            Effect.andThen(
              Effect.sync(() => released.push(entry.fd)),
              real.release(entry),
            ),
        }),
        (listener) =>
          Effect.gen(function* () {
            const registration = yield* register(listener, "kept");
            const path = join(folder, registration.fileName);
            const first = published[0]!;
            failPublish = true;
            unlinkSync(path);
            yield* TestClock.adjust(REPAIR_MS);
            yield* statusUntil(listener, (s) => s.repairPasses === 1, "the failed pass");
            expect(released).toEqual([]);
            expect(() => fstatSync(first.fd!)).not.toThrow();
            expect((yield* listener.status).registrations[0]?.stale).toBe(true);
            failPublish = false;
            yield* TestClock.adjust(REPAIR_MS);
            yield* promised(() => waitFor(() => existsSync(path), SETTLE_MS, "the new entry"));
            expect(released).toEqual([first.fd]);
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("retries a failed removal of a withdrawn entry, and the entry never comes back", async () => {
    fresh();
    let blockRemoval = true;
    try {
      await withListener(
        folder,
        (real) => ({
          ...real,
          remove: (fileName) =>
            blockRemoval
              ? Effect.fail(new TalkFileError({ path: fileName, reason: "the file is in use" }))
              : real.remove(fileName),
        }),
        (listener) =>
          Effect.gen(function* () {
            const registration = yield* register(listener, "withdrawn");
            const path = join(folder, registration.fileName);
            yield* listener.withdraw(registration);
            expect((yield* listener.status).pendingRemovals).toEqual([registration.fileName]);
            expect(existsSync(path)).toBe(true);
            blockRemoval = false;
            yield* TestClock.adjust(REPAIR_MS);
            yield* promised(() => waitFor(() => !existsSync(path), SETTLE_MS, "the removal"));
            for (let pass = 0; pass < 2; pass += 1) {
              yield* TestClock.adjust(REPAIR_MS);
              yield* promised(() => sleep(100));
            }
            expect(existsSync(path)).toBe(false);
            const status = yield* listener.status;
            expect(status.pendingRemovals).toEqual([]);
            expect(status.registrations.map((item) => item.live)).toEqual([false]);
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("logs a failed refresh with its path and reason and refreshes the other entries", async () => {
    fresh();
    let failing = "";
    const refreshed: Array<string> = [];
    try {
      await withListener(
        folder,
        (real) => ({
          ...real,
          refresh: (published) =>
            published.fileName === failing
              ? Effect.fail(
                  new TalkFileError({ path: published.path, reason: "futimes is denied" }),
                )
              : Effect.andThen(
                  Effect.sync(() => refreshed.push(published.fileName)),
                  real.refresh(published),
                ),
        }),
        (listener) =>
          Effect.gen(function* () {
            const first = yield* register(listener, "first");
            const second = yield* register(listener, "second");
            failing = first.fileName;
            yield* TestClock.adjust(IN_PROCESS_REFRESH_MS);
            yield* promised(() =>
              waitFor(() => refreshed.includes(second.fileName), SETTLE_MS, "the refresh"),
            );
            const line = logLines.find((item) => item.includes("refresh of"));
            expect(line).toContain(join(folder, first.fileName));
            expect(line).toContain("futimes is denied");
          }),
      );
    } finally {
      cleanUp();
    }
  });

  it("keeps the current listener when a rebind candidate fails the post-bind check", async () => {
    fresh();
    const held = join(base, "held.sock");
    try {
      await withListener(
        folder,
        (real) => real,
        (listener) =>
          Effect.gen(function* () {
            const heldPath = join(base, "held.sock");
            yield* register(listener, "rebind");
            const before = yield* listener.status;
            const oldPath = before.endpoint?.kind === "unix" ? before.endpoint.path : "";
            if (LINUX) linkSync(oldPath, heldPath);
            unlinkSync(oldPath);
            const previous = process.umask(0o277);
            try {
              yield* TestClock.adjust(REPAIR_MS);
              yield* statusUntil(listener, (s) => s.repairPasses === 1, "the failed rebind");
            } finally {
              process.umask(previous);
            }
            const failed = yield* listener.status;
            expect(failed.lastRepairFailure).toMatch(/owner write/);
            expect(failed.endpoint).toEqual(before.endpoint);
            expect(failed.closedListeners).toBe(0);
            if (LINUX) {
              const raw = yield* promised(() => rawConnect({ kind: "unix", path: heldPath }));
              raw.socket.destroy();
            }
            yield* TestClock.adjust(REPAIR_MS);
            yield* statusUntil(listener, (s) => s.closedListeners === 1, "the rebind");
            expect((yield* listener.status).endpoint).not.toEqual(before.endpoint);
            if (LINUX) {
              const refused = yield* promised(() =>
                rawConnect({ kind: "unix", path: heldPath }).then(
                  (raw) => {
                    raw.socket.destroy();
                    return "";
                  },
                  (error: NodeJS.ErrnoException) => error.code ?? "",
                ),
              );
              expect(refused).toBe("ECONNREFUSED");
            }
          }),
      );
    } finally {
      rmSync(held, { force: true });
      cleanUp();
    }
  });

  it("closes an unauthenticated connection at the production default deadline of 1 s", async () => {
    fresh();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* TalkTransport;
          yield* transport.register({ sessionId: "default", name: "default", cwd: base });
          const { endpoint } = yield* transport.status;
          const raw = yield* promised(() => rawConnect(endpoint!));
          yield* statusUntil(transport, (s) => s.unauthenticated === 1, "the accepted connection");
          yield* TestClock.adjust(999);
          yield* promised(() => sleep(200));
          expect(raw.closedAt).toBeUndefined();
          yield* TestClock.adjust(1);
          yield* promised(() =>
            waitFor(() => raw.closedAt !== undefined, SETTLE_MS, "the close at 1 s"),
          );
        }).pipe(
          // No handshake option: the layer uses its default.
          Effect.provide(
            TalkTransport.layer({ folder }).pipe(Layer.provideMerge(TestClock.layer())),
          ),
        ),
      );
    } finally {
      cleanUp();
    }
  });

  it("keeps a newer kept entry when a late proof of an older attempt arrives", async () => {
    fresh();
    const servers: Array<Server> = [];
    const secret = randomBytes(32);
    const instanceId = hex(8);
    const sessionId = "late";
    const target = { instanceId, sessionId };
    try {
      mkdirSync(folder, { mode: 0o700 });
      chmodSync(folder, 0o700);
      const entryPath = join(folder, entryFileName(instanceId, sessionId));
      // A rebind keeps the start time of a registration and changes only its endpoint.
      const startTime = 1_700_000_000_000;
      const writeEntryAt = (path: string): void => {
        const entry: RegistryEntry = {
          version: PROTOCOL_VERSION,
          instanceId,
          sessionId,
          name: sessionId,
          cwd: base,
          processId: process.pid,
          endpoint: { kind: "unix", path },
          startTime,
          secret: secret.toString("hex"),
        };
        writeFileSync(entryPath, encodeEntry(entry), { mode: 0o600 });
        chmodSync(entryPath, 0o600);
      };
      // A listener that holds the secret; `gate` holds back its challenge.
      const startFake = async (path: string, label: string, gate: Promise<void>) => {
        let hellos = 0;
        const server = createServer((socket) => {
          socket.on("error", () => undefined);
          const frames: Array<{ readonly type?: string }> = [];
          let buffered: Buffer = Buffer.alloc(0);
          let listenerNonce = Nonce.make(hex(32));
          let clientNonce = listenerNonce;
          socket.on("data", (chunk: Buffer) => {
            const before = frames.length;
            buffered = takeFrames(Buffer.concat([buffered, chunk]), frames);
            for (const received of frames.slice(before) as Array<Record<string, unknown>>) {
              if (received["type"] === "hello") {
                hellos += 1;
                clientNonce = Nonce.make(String(received["nonce"]));
                listenerNonce = Nonce.make(hex(32));
                void gate.then(() =>
                  socket.write(
                    frame({
                      type: "challenge",
                      nonce: listenerNonce,
                      hmac: computeHmac(secret, {
                        role: "listener",
                        clientNonce,
                        listenerNonce,
                        instanceId,
                        sessionId,
                      }),
                    }),
                  ),
                );
              } else if (received["type"] === "proof") {
                socket.write(frame({ type: "ready" }));
              } else if (received["type"] === "request") {
                socket.write(
                  frame({
                    type: "response",
                    id: received["id"],
                    result: { status: "ok", body: label },
                  }),
                );
              }
            }
          });
        });
        servers.push(server);
        const listening = Promise.withResolvers<void>();
        server.listen({ path }, () => listening.resolve());
        await listening.promise;
        return { hellos: () => hellos };
      };
      const gate = Promise.withResolvers<void>();
      const firstPath = join(folder, `${hex(8)}.sock`);
      const secondPath = join(folder, `${hex(8)}.sock`);
      const first = await startFake(firstPath, "first", gate.promise);
      await startFake(secondPath, "second", Promise.resolve());
      writeEntryAt(firstPath);
      const results = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* makeClient({ requestTimeoutMs: 5_000, probeTimeoutMs: 500 });
          const early = yield* Effect.forkChild(client.request(target, "echo", null));
          yield* promised(() => waitFor(() => first.hellos() === 1, SETTLE_MS, "the first hello"));
          // A listing observes the rebound endpoint before the first attempt proves the secret.
          writeEntryAt(secondPath);
          yield* client.list;
          gate.resolve();
          const earlyResult = yield* Fiber.join(early);
          unlinkSync(entryPath);
          const laterResult = yield* client.request(target, "echo", null);
          return [earlyResult, laterResult];
        }).pipe(
          Effect.provide(
            TalkRegistry.layerPosix(folder).pipe(Layer.provide(TalkPosixSystem.layer)),
          ),
        ),
      );
      // The late proof did not roll the kept entry back to the first endpoint.
      expect(results).toEqual(["first", "second"]);
    } finally {
      for (const server of servers) server.close();
      cleanUp();
    }
  });
});

// --- Spawned peers ---------------------------------------------------------------

interface Reply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly tag?: string;
  readonly outcome?: string;
  readonly reason?: string;
}

interface Ready {
  readonly pid: number;
  readonly folder: string;
}

interface Registration {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly fileName: string;
}

interface Status {
  readonly folder: string;
  readonly endpoint: Endpoint | undefined;
  readonly closedListeners: number;
  readonly unauthenticated: number;
  readonly heldRequests: number;
  readonly registrations: ReadonlyArray<{
    readonly instanceId: string;
    readonly sessionId: string;
    readonly live: boolean;
    readonly stale: boolean;
  }>;
}

interface Listing {
  readonly peers: ReadonlyArray<{ readonly instanceId: string; readonly sessionId: string }>;
  readonly rejected: ReadonlyArray<{ readonly fileName: string; readonly reason: string }>;
  readonly pruned: ReadonlyArray<string>;
}

const targetOf = (registration: Registration) => ({
  instanceId: registration.instanceId,
  sessionId: registration.sessionId,
});

/** One spawned peer, driven by JSON lines. */
class Peer {
  private nextId = 0;
  private readonly waiting = new Map<number, (reply: Reply) => void>();
  readonly stderr: Array<string> = [];
  readonly ready: Promise<Ready>;
  readonly exited: Promise<number | null>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const ready = Promise.withResolvers<Ready>();
    this.ready = ready.promise;
    const exited = Promise.withResolvers<number | null>();
    this.exited = exited.promise;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    child.on("exit", (code) => {
      ready.reject(new Error(`peer exited with ${code}: ${this.stderr.join("")}`));
      exited.resolve(code);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      // Effect log lines of the transport go to standard output too; replies are JSON objects.
      if (!line.startsWith("{")) {
        this.stderr.push(`${line}\n`);
        return;
      }
      const message = JSON.parse(line) as Reply & { readonly ready?: boolean };
      if (message.ready === true) {
        ready.resolve(message as unknown as Ready);
        return;
      }
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    });
  }

  static start(bundle: string, env: NodeJS.ProcessEnv): Peer {
    return new Peer(
      spawn(BUN_RUNTIME, [PEER_SCRIPT, bundle], { cwd: REPO_DIR, env, stdio: "pipe" }),
    );
  }

  send(op: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++;
    const reply = Promise.withResolvers<Reply>();
    this.waiting.set(id, reply.resolve);
    this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    return reply.promise;
  }

  async call<A>(op: string, args: Record<string, unknown> = {}): Promise<A> {
    const reply = await this.send(op, args);
    if (!reply.ok) {
      throw new Error(`${op} failed: ${reply.tag} ${reply.outcome} ${reply.reason}`);
    }
    return reply.value as A;
  }

  kill(): void {
    this.child.kill("SIGKILL");
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timer = setTimeout(() => this.kill(), 5_000);
    void this.send("exit");
    await this.exited;
    clearTimeout(timer);
  }
}

describe("talk transport between spawned Bun peers", () => {
  let outDir = "";
  let base = "";
  let folder = "";
  let bundle = "";
  let env: NodeJS.ProcessEnv = {};
  let a: Peer;
  let b: Peer;
  const extraPeers: Array<Peer> = [];
  let aRegistration: Registration;
  let bRegistration: Registration;

  const foreignNames = ["foreign.txt", "token", "daemon.sock", "units"];
  const garbageEntry = entryFileName("cccccccccccccccc", "garbage");

  const status = (peer: Peer): Promise<Status> => peer.call<Status>("status");
  const unixPath = (endpoint: Endpoint | undefined): string =>
    endpoint?.kind === "unix" ? endpoint.path : "";
  const startPeer = async (extraEnv: NodeJS.ProcessEnv = {}): Promise<Peer> => {
    const peer = Peer.start(bundle, { ...env, ...extraEnv });
    extraPeers.push(peer);
    await peer.ready;
    return peer;
  };

  /** Writes an entry file as the registry would; sealed on Windows. */
  const writeEntry = async (entry: RegistryEntry): Promise<string> => {
    const path = join(folder, entryFileName(entry.instanceId, entry.sessionId));
    if (WINDOWS) {
      const [blob] = await Effect.runPromise(
        sealEntries([encodeEntry(entry)]).pipe(Effect.provide(TalkDpapi.layer)),
      );
      writeFileSync(path, blob!);
    } else {
      writeFileSync(path, encodeEntry(entry), { mode: 0o600 });
      chmodSync(path, 0o600);
    }
    return path;
  };

  beforeAll(async () => {
    outDir = mkdtempSync(join(tmpdir(), "tb-"));
    const build = spawnSync(BUN_RUNTIME, [BUILD_SCRIPT, "--out", outDir], {
      cwd: REPO_DIR,
      encoding: "utf8",
    });
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);
    bundle = join(outDir, "talk.js");

    base = mkdtempSync(join(tmpdir(), "tt-"));
    folder = join(base, "reg");
    mkdirSync(folder, { mode: 0o700 });
    if (!WINDOWS) chmodSync(folder, 0o700);
    // Names that talk does not own; they must survive every step.
    writeFileSync(join(folder, "foreign.txt"), "keep");
    writeFileSync(join(folder, "token"), "keep");
    writeFileSync(join(folder, "daemon.sock"), "keep");
    mkdirSync(join(folder, "units"));
    writeFileSync(join(folder, garbageEntry), "garbage", { mode: 0o600 });

    env = { ...process.env, DOCKS_KIT_TALK_DIR: folder, TALK_PEER_REPAIR_MS: String(REPAIR_MS) };
    a = Peer.start(bundle, env);
    b = Peer.start(bundle, env);
    const [readyA] = await Promise.all([a.ready, b.ready]);
    expect(readyA.folder).toBe(folder);
    aRegistration = await a.call<Registration>("register", { sessionId: "session-a", name: "a" });
    bRegistration = await b.call<Registration>("register", { sessionId: "session-b", name: "b" });
    expect(aRegistration.instanceId).toMatch(/^[0-9a-f]{16}$/);
  }, SPAWN_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([a, b, ...extraPeers].filter(Boolean).map((peer) => peer.stop()));
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }, SPAWN_TIMEOUT_MS);

  it(
    "lists both peers and carries a request in each direction",
    async () => {
      const listing = await b.call<Listing>("list");
      expect(listing.peers.map((peer) => peer.sessionId).sort()).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(
        await b.call("request", { target: targetOf(aRegistration), kind: "echo", body: { n: 1 } }),
      ).toEqual({ echo: { n: 1 }, by: "session-a" });
      expect(
        await a.call("request", { target: targetOf(bRegistration), kind: "echo", body: "x" }),
      ).toEqual({ echo: "x", by: "session-b" });
      expect((await a.send("probe", { target: targetOf(bRegistration) })).ok).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "gives not-found for a target that no entry names",
    async () => {
      const reply = await b.send("request", {
        target: { instanceId: "ffffffffffffffff", sessionId: "nobody" },
        kind: "echo",
      });
      expect(reply).toMatchObject({ ok: false, outcome: "not-found" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects an empty session id before it binds or publishes",
    async () => {
      const reply = await a.send("register", { sessionId: "" });
      expect(reply).toMatchObject({
        ok: false,
        tag: "TalkRegisterError",
        reason: expect.stringMatching(/session id is not valid/),
      });
      expect((await status(a)).registrations.map((item) => item.sessionId)).toEqual(["session-a"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "gives auth-failed for a listener without the secret, and the client sends it only hello",
    async () => {
      const received: Array<{ readonly type?: string }> = [];
      const closed = Promise.withResolvers<void>();
      const fake: Server = createServer((socket) => {
        socket.on("error", () => undefined);
        let buffered: Buffer = Buffer.alloc(0);
        let answered = false;
        socket.on("data", (chunk: Buffer) => {
          buffered = takeFrames(Buffer.concat([buffered, chunk]), received);
          if (!answered && received.length > 0) {
            answered = true;
            socket.write(frame({ type: "challenge", nonce: hex(32), hmac: hex(32) }));
            // A listener without the secret also claims the end; the client must not believe it.
            socket.write(frame({ type: "ended" }));
          }
        });
        socket.on("close", () => closed.resolve());
      });
      const endpoint: Endpoint = WINDOWS
        ? { kind: "tcp", port: 0 }
        : { kind: "unix", path: join(folder, `${hex(8)}.sock`) };
      const listening = Promise.withResolvers<void>();
      fake.listen(
        endpoint.kind === "unix" ? { path: endpoint.path } : { host: "127.0.0.1", port: 0 },
        () => listening.resolve(),
      );
      await listening.promise;
      const address = fake.address();
      const forgedEndpoint: Endpoint =
        endpoint.kind === "tcp" && address !== null && typeof address === "object"
          ? { kind: "tcp", port: address.port }
          : endpoint;
      const forged = await writeEntry({
        version: PROTOCOL_VERSION,
        instanceId: "aaaaaaaaaaaaaaaa",
        sessionId: "forged",
        name: "forged",
        cwd: base,
        processId: process.pid,
        endpoint: forgedEndpoint,
        startTime: Date.now(),
        secret: hex(32),
      });
      try {
        const reply = await b.send("request", {
          target: { instanceId: "aaaaaaaaaaaaaaaa", sessionId: "forged" },
          kind: "echo",
        });
        expect(reply).toMatchObject({ ok: false, outcome: "auth-failed" });
        await closed.promise;
        expect(received.map((item) => item.type)).toEqual(["hello"]);
      } finally {
        fake.close();
        rmSync(forged, { force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "closes a connection whose client proof does not match, before any ready",
    async () => {
      const { endpoint } = await status(a);
      const raw = await rawConnect(endpoint!);
      raw.socket.write(
        frame({
          type: "hello",
          version: PROTOCOL_VERSION,
          ...targetOf(aRegistration),
          nonce: hex(32),
        }),
      );
      await waitFor(() => raw.frames.length > 0, SETTLE_MS, "the challenge");
      expect(raw.frames[0]).toMatchObject({ type: "challenge" });
      raw.socket.write(frame({ type: "proof", hmac: hex(32) }));
      await waitFor(() => raw.closedAt !== undefined, SETTLE_MS, "the close");
      expect(raw.frames.map((received) => received.type)).toEqual(["challenge"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "delivers with the kept entry while the entry file is absent, also after a timed-out first request",
    async () => {
      // A long repair interval keeps the entry absent during the sends.
      const slow = await startPeer({ TALK_PEER_REPAIR_MS: "600000" });
      const registration = await slow.call<Registration>("register", { sessionId: "slow" });
      await b.call("list");
      // A never listed this target; its first request passes the proof, then times out. The
      // timeout leaves room for a slow first lookup (a cold PowerShell start on Windows), and the
      // test sees the blocked handler start before the request expires.
      const firstTimeoutMs = WINDOWS ? 20_000 : 2_000;
      const first = a.send("request", {
        target: targetOf(registration),
        kind: "wait",
        timeoutMs: firstTimeoutMs,
      });
      await waitFor(
        async () => (await status(slow)).heldRequests === 1,
        firstTimeoutMs,
        "the blocked handler",
      );
      expect(await first).toMatchObject({ ok: false, outcome: "timeout" });
      const path = join(folder, registration.fileName);
      unlinkSync(path);
      expect(
        await b.call("request", { target: targetOf(registration), kind: "echo", body: "kept" }),
      ).toEqual({ echo: "kept", by: "slow" });
      expect(
        await a.call("request", { target: targetOf(registration), kind: "echo", body: "reached" }),
      ).toEqual({ echo: "reached", by: "slow" });
      expect(existsSync(path)).toBe(false);
      await slow.stop();
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "re-creates a deleted entry file within the repair interval (integration bound)",
    async () => {
      const path = join(folder, aRegistration.fileName);
      unlinkSync(path);
      // The exact interval is proven in-process with a test clock; this bound only covers slow runners.
      await waitFor(() => existsSync(path), 3 * REPAIR_MS + SETTLE_MS, "the entry");
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(WINDOWS)(
    "rebinds after the socket file is deleted, closes the old listener, and the kept entry reaches the new endpoint",
    async () => {
      await b.call("list");
      const before = await status(a);
      const oldPath = unixPath(before.endpoint);
      const held = join(base, "held.sock");
      // A hard link keeps the old socket reachable while its listener is open.
      if (LINUX) {
        linkSync(oldPath, held);
        const probe = await rawConnect({ kind: "unix", path: held });
        probe.socket.destroy();
      }
      unlinkSync(oldPath);
      let after = before;
      await waitFor(
        async () => {
          after = await status(a);
          return (
            unixPath(after.endpoint) !== oldPath &&
            after.registrations.every((registration) => !registration.stale)
          );
        },
        3 * REPAIR_MS + SETTLE_MS,
        "the rebind",
      );
      expect(after.closedListeners).toBe(before.closedListeners + 1);
      const entry = JSON.parse(
        readFileSync(join(folder, aRegistration.fileName), "utf8"),
      ) as RegistryEntry;
      expect(entry.endpoint).toEqual(after.endpoint);
      if (LINUX) {
        const refused = await rawConnect({ kind: "unix", path: held }).then(
          (raw) => {
            raw.socket.destroy();
            return "";
          },
          (error: NodeJS.ErrnoException) => error.code ?? "",
        );
        expect(refused).toBe("ECONNREFUSED");
        rmSync(held, { force: true });
      }
      // B still holds the old endpoint; its re-read finds the new one.
      expect(
        await b.call("request", { target: targetOf(aRegistration), kind: "echo", body: "moved" }),
      ).toEqual({ echo: "moved", by: "session-a" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "gives unreachable with the reason when the entry lookup fails a trust check",
    async () => {
      // A target that A never listed or reached, so A must read its entry.
      const fresh = await b.call<Registration>("register", { sessionId: "lookup" });
      if (!WINDOWS) chmodSync(folder, 0o755);
      try {
        const reply = await a.send("request", { target: targetOf(fresh), kind: "echo" });
        if (WINDOWS) {
          expect(reply).toMatchObject({ ok: true });
        } else {
          expect(reply).toMatchObject({
            ok: false,
            outcome: "unreachable",
            reason: expect.stringMatching(/entry lookup failed.*0755/),
          });
        }
      } finally {
        if (!WINDOWS) chmodSync(folder, 0o700);
      }
      expect(await a.call("request", { target: targetOf(fresh), kind: "echo", body: 1 })).toEqual({
        echo: 1,
        by: "lookup",
      });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "rejects an entry whose socket path breaks the name rules and leaves it in place",
    async () => {
      const endpoint: Endpoint = WINDOWS
        ? { kind: "unix", path: "C:\\outside.sock" }
        : { kind: "unix", path: join(base, "fedcba9876543210.sock") };
      const path = await writeEntry({
        version: PROTOCOL_VERSION,
        instanceId: "bbbbbbbbbbbbbbbb",
        sessionId: "bad-path",
        name: "bad",
        cwd: base,
        processId: 999_999_999,
        endpoint,
        startTime: Date.now(),
        secret: hex(32),
      });
      try {
        const listing = await b.call<Listing>("list");
        const rejected = listing.rejected.find(
          (item) => item.fileName === entryFileName("bbbbbbbbbbbbbbbb", "bad-path"),
        );
        expect(rejected?.reason).toMatch(WINDOWS ? /endpoint/ : /socket path/);
        expect(listing.peers.some((peer) => peer.sessionId === "bad-path")).toBe(false);
        expect(existsSync(path)).toBe(true);
      } finally {
        rmSync(path, { force: true });
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "admits 32 unauthenticated connections, closes the 33rd at once and the others at the deadline",
    async () => {
      const { endpoint } = await status(a);
      const pending = await Promise.all(
        Array.from({ length: MAX_UNAUTHENTICATED }, () => rawConnect(endpoint!)),
      );
      await waitFor(
        async () => (await status(a)).unauthenticated === MAX_UNAUTHENTICATED,
        SETTLE_MS,
        "32 accepted connections",
      );
      const extra = await rawConnect(endpoint!);
      await waitFor(() => extra.closedAt !== undefined, 500, "the close of the 33rd connection");
      expect(pending.every((raw) => raw.closedAt === undefined)).toBe(true);
      // The exact deadline is proven in-process with a test clock; this bound only covers slow runners.
      await waitFor(
        () => pending.every((raw) => raw.closedAt !== undefined),
        HANDSHAKE_DEADLINE_MS + SETTLE_MS,
        "the handshake deadline",
      );
      expect(pending.every((raw) => raw.frames.length === 0)).toBe(true);
      expect((await status(a)).unauthenticated).toBe(0);
      expect(
        await b.call("request", { target: targetOf(aRegistration), kind: "echo", body: "after" }),
      ).toEqual({ echo: "after", by: "session-a" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "closes a connection that announces a frame above 1 MiB",
    async () => {
      const { endpoint } = await status(a);
      const raw = await rawConnect(endpoint!);
      const openedAt = Date.now();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1_048_577);
      raw.socket.write(Buffer.concat([header, Buffer.from("{}")]));
      await waitFor(() => raw.closedAt !== undefined, SETTLE_MS, "the close");
      // The handshake deadline would close it only after 1 s.
      expect((raw.closedAt ?? 0) - openedAt).toBeLessThan(HANDSHAKE_DEADLINE_MS - 200);
      expect(raw.frames).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "closes the connection when the response is above the frame cap or the handler fails",
    async () => {
      // The request fits in one frame; the echo response with its wrapper does not.
      const body = "x".repeat(1_048_576 - 60);
      const started = Date.now();
      expect(
        await b.send("request", {
          target: targetOf(aRegistration),
          kind: "echo",
          body,
          timeoutMs: 15_000,
        }),
      ).toMatchObject({ ok: false, outcome: "unreachable" });
      expect(
        await b.send("request", {
          target: targetOf(aRegistration),
          kind: "die",
          timeoutMs: 15_000,
        }),
      ).toMatchObject({ ok: false, outcome: "unreachable" });
      // Both fail at once, not at the request timeout.
      expect(Date.now() - started).toBeLessThan(5_000);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "answers a held request with not-live at withdrawal, then ended for the old target before and after a listing",
    async () => {
      const oldTarget = targetOf(aRegistration);
      const held = b.send("request", {
        target: oldTarget,
        kind: "wait",
        body: null,
        timeoutMs: 15_000,
      });
      await waitFor(
        async () => (await status(a)).heldRequests === 1,
        SETTLE_MS,
        "the held request",
      );
      await a.call("withdraw", { target: oldTarget });
      expect(await held).toMatchObject({
        ok: false,
        outcome: "not-live",
        reason: expect.stringMatching(/held/),
      });
      expect(existsSync(join(folder, aRegistration.fileName))).toBe(false);
      // The same session id registers again: a new target on the same listener.
      const resumed = await a.call<Registration>("register", { sessionId: "session-a" });
      expect(resumed.instanceId).not.toBe(oldTarget.instanceId);
      const ended = {
        ok: false,
        outcome: "not-live",
        reason: expect.stringMatching(/ended/),
      };
      expect(await b.send("request", { target: oldTarget, kind: "echo" })).toMatchObject(ended);
      const listing = await b.call<Listing>("list");
      expect(listing.peers.map((peer) => peer.instanceId)).toContain(resumed.instanceId);
      expect(listing.peers.map((peer) => peer.instanceId)).not.toContain(oldTarget.instanceId);
      expect(await b.send("request", { target: oldTarget, kind: "echo" })).toMatchObject(ended);
      expect(await b.call("request", { target: targetOf(resumed), kind: "echo", body: 2 })).toEqual(
        { echo: 2, by: "session-a" },
      );
      aRegistration = resumed;
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "prunes a killed peer: a client that knew it gets not-live, a fresh client not-found",
    async () => {
      const c = await startPeer();
      const registration = await c.call<Registration>("register", { sessionId: "session-c" });
      const cStatus = await status(c);
      const listed = await b.call<Listing>("list");
      expect(listed.peers.some((peer) => peer.sessionId === "session-c")).toBe(true);
      c.kill();
      await c.exited;
      const listing = await b.call<Listing>("list");
      expect(listing.pruned).toEqual([registration.fileName]);
      expect(listing.peers.some((peer) => peer.sessionId === "session-c")).toBe(false);
      expect(existsSync(join(folder, registration.fileName))).toBe(false);
      if (cStatus.endpoint?.kind === "unix") expect(existsSync(cStatus.endpoint.path)).toBe(false);
      expect(
        await b.send("request", { target: targetOf(registration), kind: "echo" }),
      ).toMatchObject({ ok: false, outcome: "not-live" });
      // A never listed or reached C.
      expect(
        await a.send("request", { target: targetOf(registration), kind: "echo" }),
      ).toMatchObject({ ok: false, outcome: "not-found" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "destroys connections in the handshake when the transport ends",
    async () => {
      const d = await startPeer();
      await d.call("register", { sessionId: "session-d" });
      const { endpoint } = await status(d);
      const raw = await rawConnect(endpoint!);
      await waitFor(async () => (await status(d)).unauthenticated === 1, SETTLE_MS, "the accept");
      const disposedAt = Date.now();
      await d.call("dispose");
      await waitFor(() => raw.closedAt !== undefined, SETTLE_MS, "the close");
      // Before the handshake deadline, which ended with the transport.
      expect((raw.closedAt ?? 0) - disposedAt).toBeLessThan(HANDSHAKE_DEADLINE_MS - 200);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "leaves every name that talk does not own in place",
    async () => {
      for (const name of foreignNames) expect(existsSync(join(folder, name)), name).toBe(true);
      expect(readFileSync(join(folder, garbageEntry), "utf8")).toBe("garbage");
      const listing = await b.call<Listing>("list");
      expect(listing.rejected.map((item) => item.fileName)).toContain(garbageEntry);
      expect(listing.pruned).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "re-creates a removed registry folder, rebinds on POSIX, and republishes",
    async () => {
      const own = await a.call<Registration>("register", { sessionId: "folder-a" });
      const other = await b.call<Registration>("register", { sessionId: "folder-b" });
      const before = await status(a);
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
      let after = before;
      await waitFor(
        async () => {
          after = await status(a);
          return (
            existsSync(join(folder, own.fileName)) &&
            existsSync(join(folder, other.fileName)) &&
            after.registrations.every((registration) => !registration.stale)
          );
        },
        3 * REPAIR_MS + SETTLE_MS,
        "the republished entries",
      );
      if (WINDOWS) {
        // Windows keeps its port and only republishes.
        expect(after.endpoint).toEqual(before.endpoint);
      } else {
        expect(statSync(folder).mode & 0o777).toBe(0o700);
        expect(unixPath(after.endpoint)).not.toBe(unixPath(before.endpoint));
        expect(after.closedListeners).toBe(before.closedListeners + 1);
      }
      const listing = await b.call<Listing>("list");
      expect(listing.peers.map((peer) => peer.sessionId)).toEqual(
        expect.arrayContaining(["folder-a", "folder-b"]),
      );
      expect(
        await b.call("request", { target: targetOf(own), kind: "echo", body: "again" }),
      ).toEqual({ echo: "again", by: "folder-a" });
    },
    SPAWN_TIMEOUT_MS,
  );
});

/** The folder of E4 for this system, without the override. */
function defaultFolder(): string {
  if (process.platform === "linux") return `/tmp/docks-kit-talk-${process.getuid?.()}`;
  if (process.platform === "darwin") {
    const temp = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
    return join(temp.stdout.trim(), "docks-kit-talk");
  }
  return join(process.env["LOCALAPPDATA"] ?? "", "docks-kit", "talk");
}

describe.runIf(process.env["CI"] !== undefined && process.env["CI"] !== "")(
  "talk transport in the default folder (CI only)",
  () => {
    it(
      "uses the folder of the system and carries a request between two peers",
      async () => {
        const outDir = mkdtempSync(join(tmpdir(), "tb-"));
        const env: NodeJS.ProcessEnv = { ...process.env, TALK_PEER_REPAIR_MS: String(REPAIR_MS) };
        delete env["DOCKS_KIT_TALK_DIR"];
        const peers: Array<Peer> = [];
        // The case leaves the system as it found it: it removes the default folder only when it made it.
        const folderExisted = existsSync(defaultFolder());
        try {
          const build = spawnSync(BUN_RUNTIME, [BUILD_SCRIPT, "--out", outDir], {
            cwd: REPO_DIR,
            encoding: "utf8",
          });
          expect(build.status).toBe(0);
          const bundle = join(outDir, "talk.js");
          const x = Peer.start(bundle, env);
          const y = Peer.start(bundle, env);
          peers.push(x, y);
          const [readyX, readyY] = await Promise.all([x.ready, y.ready]);
          expect(readyX.folder).toBe(defaultFolder());
          expect(readyY.folder).toBe(defaultFolder());
          const session = `ci-${hex(4)}`;
          const registration = await y.call<Registration>("register", { sessionId: session });
          expect(
            await x.call("request", { target: targetOf(registration), kind: "echo", body: "ci" }),
          ).toEqual({ echo: "ci", by: session });
        } finally {
          await Promise.all(peers.map((peer) => peer.stop()));
          rmSync(outDir, { recursive: true, force: true });
          // `rmdir` fails on a folder that is not empty, so a folder in use stays.
          if (!folderExisted) {
            try {
              rmdirSync(defaultFolder());
            } catch {
              // The folder holds files of another talk process.
            }
          }
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);
