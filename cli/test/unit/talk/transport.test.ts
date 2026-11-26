import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Endpoint } from "../../../talk/transport/endpoint";
import { PROTOCOL_VERSION } from "../../../talk/transport/handshake";
import { type RegistryEntry, encodeEntry, entryFileName } from "../../../talk/transport/registry";
import { TalkDpapi, sealEntries } from "../../../talk/transport/sealWindows";
import { BUN_RUNTIME } from "../../lib/cliEntry";
import { REPO_DIR } from "../../lib/goldenResources";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

// The spawned-Bun transport test of #249 E9 and a2: two `bun` peers import the
// built bundle and talk through a short test registry folder with a 1 s repair
// interval.

const WINDOWS = process.platform === "win32";
const LINUX = process.platform === "linux";
const BUILD_SCRIPT = join(REPO_DIR, "cli", "scripts", "build-talk.ts");
const PEER_SCRIPT = join(REPO_DIR, "cli", "test", "fixtures", "talk", "peer.ts");
const REPAIR_MS = 1_000;
const MAX_UNAUTHENTICATED = 32;
const HANDSHAKE_DEADLINE_MS = 1_000;

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
  readonly instanceId: string;
  readonly folder: string;
}

interface Registration {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly fileName: string;
}

interface Status {
  readonly folder: string;
  readonly instanceId: string;
  readonly endpoint: Endpoint | undefined;
  readonly closedListeners: number;
  readonly unauthenticated: number;
  readonly heldRequests: number;
  readonly registrations: ReadonlyArray<{ readonly sessionId: string; readonly stale: boolean }>;
}

interface Listing {
  readonly peers: ReadonlyArray<{ readonly instanceId: string; readonly sessionId: string }>;
  readonly rejected: ReadonlyArray<{ readonly fileName: string; readonly reason: string }>;
  readonly pruned: ReadonlyArray<string>;
}

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

  get pid(): number {
    return this.child.pid ?? -1;
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

// The peers are other processes with real timers (repair interval, handshake deadline), so fake timers
// cannot drive them; `waitFor` polls the observed state instead of sleeping a guessed time.
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
    await sleep(50);
  }
  return Date.now() - started;
}

// --- Raw frames for the listener checks ----------------------------------------

const frame = (value: unknown): Buffer => {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
};

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
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.byteLength >= 4 && buffered.byteLength >= 4 + buffered.readUInt32BE(0)) {
      const length = buffered.readUInt32BE(0);
      raw.frames.push(JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")));
      buffered = buffered.subarray(4 + length);
    }
  });
  socket.on("close", () => {
    raw.closedAt = Date.now();
  });
  socket.once("error", reject);
  socket.once("connect", () => resolve(raw));
  return promise;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

describe("talk transport between spawned Bun peers", () => {
  let outDir = "";
  let base = "";
  let folder = "";
  let bundle = "";
  let env: NodeJS.ProcessEnv = {};
  let a: Peer;
  let b: Peer;
  const extraPeers: Array<Peer> = [];
  let aTarget = { instanceId: "", sessionId: "session-a" };
  let bTarget = { instanceId: "", sessionId: "session-b" };
  let aRegistration: Registration;

  const foreignNames = ["foreign.txt", "token", "daemon.sock", "units"];
  const garbageEntry = entryFileName("cccccccccccccccc", "garbage");

  const status = (peer: Peer): Promise<Status> => peer.call<Status>("status");
  const unixPath = (endpoint: Endpoint | undefined): string =>
    endpoint?.kind === "unix" ? endpoint.path : "";

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
    const [readyA, readyB] = await Promise.all([a.ready, b.ready]);
    expect(readyA.folder).toBe(folder);
    aRegistration = await a.call<Registration>("register", { sessionId: "session-a", name: "a" });
    const bRegistration = await b.call<Registration>("register", {
      sessionId: "session-b",
      name: "b",
    });
    aTarget = { instanceId: readyA.instanceId, sessionId: "session-a" };
    bTarget = { instanceId: readyB.instanceId, sessionId: "session-b" };
    expect(aRegistration.instanceId).toBe(readyA.instanceId);
    expect(bRegistration.instanceId).toBe(readyB.instanceId);
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
      expect(await b.call("request", { target: aTarget, kind: "echo", body: { n: 1 } })).toEqual({
        echo: { n: 1 },
        by: "session-a",
      });
      expect(await a.call("request", { target: bTarget, kind: "echo", body: "x" })).toEqual({
        echo: "x",
        by: "session-b",
      });
      expect((await a.send("probe", { target: bTarget })).ok).toBe(true);
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
    "gives auth-failed for a listener without the secret, even when it claims ended",
    async () => {
      const fake: Server = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.once("data", () => {
          socket.write(frame({ type: "challenge", nonce: hex(32), hmac: hex(32) }));
          socket.write(frame({ type: "ended" }));
        });
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
        frame({ type: "hello", version: PROTOCOL_VERSION, ...aTarget, nonce: hex(32) }),
      );
      await waitFor(() => raw.frames.length > 0, 2_000, "the challenge");
      expect(raw.frames[0]).toMatchObject({ type: "challenge" });
      raw.socket.write(frame({ type: "proof", hmac: hex(32) }));
      await waitFor(() => raw.closedAt !== undefined, 2_000, "the close");
      expect(raw.frames.map((received) => received.type)).toEqual(["challenge"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "delivers with the kept entry after the entry file is deleted, and the repair re-creates it",
    async () => {
      await b.call("list");
      const path = join(folder, aRegistration.fileName);
      unlinkSync(path);
      expect(await b.call("request", { target: aTarget, kind: "echo", body: "kept" })).toEqual({
        echo: "kept",
        by: "session-a",
      });
      const elapsed = await waitFor(() => existsSync(path), 3 * REPAIR_MS + 2_000, "the entry");
      expect(elapsed).toBeLessThan(3 * REPAIR_MS + 2_000);
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
        3 * REPAIR_MS + 2_000,
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
      }
      // B still holds the old endpoint; its re-read finds the new one.
      expect(await b.call("request", { target: aTarget, kind: "echo", body: "moved" })).toEqual({
        echo: "moved",
        by: "session-a",
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
    "admits 32 unauthenticated connections, closes the 33rd at once and the others after 1 s",
    async () => {
      const { endpoint } = await status(a);
      const pending = await Promise.all(
        Array.from({ length: MAX_UNAUTHENTICATED }, () => rawConnect(endpoint!)),
      );
      await waitFor(
        async () => (await status(a)).unauthenticated === MAX_UNAUTHENTICATED,
        2_000,
        "32 accepted connections",
      );
      const acceptedAt = Date.now();
      const extra = await rawConnect(endpoint!);
      await waitFor(() => extra.closedAt !== undefined, 500, "the close of the 33rd connection");
      expect(pending.every((raw) => raw.closedAt === undefined)).toBe(true);
      await waitFor(
        () => pending.every((raw) => raw.closedAt !== undefined),
        HANDSHAKE_DEADLINE_MS + 2_000,
        "the handshake deadline",
      );
      const latest = Math.max(...pending.map((raw) => raw.closedAt ?? 0));
      expect(latest - acceptedAt).toBeLessThan(HANDSHAKE_DEADLINE_MS + 1_500);
      expect(pending.every((raw) => raw.frames.length === 0)).toBe(true);
      expect((await status(a)).unauthenticated).toBe(0);
      expect(await b.call("request", { target: aTarget, kind: "echo", body: "after" })).toEqual({
        echo: "after",
        by: "session-a",
      });
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
      await waitFor(() => raw.closedAt !== undefined, 2_000, "the close");
      // The handshake deadline would close it only after 1 s.
      expect((raw.closedAt ?? 0) - openedAt).toBeLessThan(HANDSHAKE_DEADLINE_MS - 200);
      expect(raw.frames).toEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "answers a held request with not-live when the withdrawal starts, then ended on a new connection",
    async () => {
      const held = b.send("request", {
        target: aTarget,
        kind: "wait",
        body: null,
        timeoutMs: 15_000,
      });
      await waitFor(async () => (await status(a)).heldRequests === 1, 3_000, "the held request");
      await a.call("withdraw", { sessionId: "session-a" });
      expect(await held).toMatchObject({
        ok: false,
        outcome: "not-live",
        reason: expect.stringMatching(/held/),
      });
      expect(existsSync(join(folder, aRegistration.fileName))).toBe(false);
      // B keeps the entry; the listener of A proves itself, then reports the end.
      expect(await b.send("request", { target: aTarget, kind: "echo" })).toMatchObject({
        ok: false,
        outcome: "not-live",
        reason: expect.stringMatching(/ended/),
      });
      // A new registration of the same process works on the same listener.
      await a.call<Registration>("register", { sessionId: "session-a2", name: "a2" });
      expect(
        await b.call("request", {
          target: { instanceId: aTarget.instanceId, sessionId: "session-a2" },
          kind: "echo",
          body: 2,
        }),
      ).toEqual({ echo: 2, by: "session-a2" });
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "prunes the entry and the socket of a killed peer",
    async () => {
      const c = Peer.start(bundle, env);
      extraPeers.push(c);
      await c.ready;
      const registration = await c.call<Registration>("register", {
        sessionId: "session-c",
        name: "c",
      });
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
        await b.send("request", {
          target: { instanceId: registration.instanceId, sessionId: "session-c" },
          kind: "echo",
        }),
      ).toMatchObject({ ok: false, outcome: "not-found" });
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
      const before = await status(a);
      const aEntry = join(folder, entryFileName(aTarget.instanceId, "session-a2"));
      const bEntry = join(folder, entryFileName(bTarget.instanceId, "session-b"));
      rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
      let after = before;
      await waitFor(
        async () => {
          after = await status(a);
          return (
            existsSync(aEntry) &&
            existsSync(bEntry) &&
            after.registrations.every((registration) => !registration.stale)
          );
        },
        3 * REPAIR_MS + 2_000,
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
      expect(listing.peers.map((peer) => peer.sessionId).sort()).toEqual([
        "session-a2",
        "session-b",
      ]);
      expect(
        await b.call("request", {
          target: { instanceId: aTarget.instanceId, sessionId: "session-a2" },
          kind: "echo",
          body: "again",
        }),
      ).toEqual({ echo: "again", by: "session-a2" });
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
          await y.call("register", { sessionId: session, name: "y" });
          expect(
            await x.call("request", {
              target: { instanceId: readyY.instanceId, sessionId: session },
              kind: "echo",
              body: "ci",
            }),
          ).toEqual({ echo: "ci", by: session });
        } finally {
          await Promise.all(peers.map((peer) => peer.stop()));
          rmSync(outDir, { recursive: true, force: true });
        }
      },
      SPAWN_TIMEOUT_MS,
    );
  },
);
