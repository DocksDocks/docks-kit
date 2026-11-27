import { createHash } from "node:crypto";
import {
  type BigIntStats,
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Effect, Layer, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BoundEndpoint,
  type Endpoint,
  SOCKET_NAME,
  SUN_PATH_BYTES,
  TalkEndpointError,
  bindEndpoint,
  closeEndpoint,
  endpointState,
  socketFault,
  socketFileName,
  socketProcessId,
  sunPathFault,
} from "../../../talk/transport/endpoint";
import { PROTOCOL_VERSION } from "../../../talk/transport/handshake";
import {
  ENTRY_NAME,
  type RegistryEntry,
  TEMPORARY_NAME,
  TalkEntryRejected,
  TalkRegistry,
  decodeEntry,
  encodeEntry,
  entryFault,
  entryFileName,
  isTalkName,
  readObserved,
  sessionKey,
  temporaryFileName,
} from "../../../talk/transport/registry";
import { TalkDpapi, TalkSealError } from "../../../talk/transport/sealWindows";
import {
  type EntryStat,
  MAX_SECRET_FILE_BYTES,
  TalkFileError,
  TalkFileTooLarge,
  TalkPosixSystem,
  TalkTrustError,
  readSecretBytes,
  readSecretFile,
} from "../../../talk/transport/trustPosix";

// Registry entries, their names, and the endpoint choice (#249 E5 Names, E7).

const WINDOWS = process.platform === "win32";
const POSIX = !WINDOWS;
const USER = 1000;

const INSTANCE = "0123456789abcdef";
const SESSION = "session-1";
const SECRET = "ab".repeat(32);

const sha16 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);

const entryFor = (folder: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry => ({
  version: PROTOCOL_VERSION,
  instanceId: INSTANCE,
  sessionId: SESSION,
  name: "main",
  cwd: "/work",
  processId: 4242,
  endpoint: { kind: "unix", path: posix.join(folder, "4242-fedcba9876543210.sock") },
  startTime: 1_700_000_000_000,
  secret: SECRET,
  ...overrides,
});

const socketStat = (overrides: Partial<EntryStat> = {}): EntryStat => ({
  kind: "socket",
  uid: USER,
  mode: 0o755,
  dev: 1n,
  ino: 2n,
  ...overrides,
});

describe("E5 names", () => {
  it("derives the session key from the first 16 hex characters of SHA-256", () => {
    expect(sessionKey(SESSION)).toBe(sha16(SESSION));
    expect(entryFileName(INSTANCE, SESSION)).toBe(`${INSTANCE}-${sha16(SESSION)}.entry`);
  });

  it("makes a fresh temporary name of the pattern each time", () => {
    const first = temporaryFileName();
    expect(first).toMatch(TEMPORARY_NAME);
    expect(first).toMatch(/^\.[0-9a-f]{16}\.tmp$/);
    expect(temporaryFileName()).not.toBe(first);
  });

  it("owns only the three patterns, never the omp daemon names", () => {
    expect(isTalkName(entryFileName(INSTANCE, SESSION))).toBe(true);
    expect(isTalkName("4242-fedcba9876543210.sock")).toBe(true);
    expect(isTalkName(".fedcba9876543210.tmp")).toBe(true);
    for (const foreign of [
      "daemon",
      "daemon.sock",
      "daemon.db",
      "daemon.lock",
      "token",
      "handover.json",
      "units",
      "modules",
      "foreign.txt",
      // The #249 socket pattern, without the owner process id.
      "fedcba9876543210.sock",
      "4242-0123456789ABCDEF.sock",
      "0-fedcba9876543210.sock",
      "04242-fedcba9876543210.sock",
      "-fedcba9876543210.sock",
      "4242-fedcba987654321.sock",
      "0123456789abcdef.entry",
      `${INSTANCE}-${sha16(SESSION)}.entry.bak`,
    ]) {
      expect(isTalkName(foreign), foreign).toBe(false);
    }
    expect(ENTRY_NAME.test(`${INSTANCE}-${sha16(SESSION)}.entry`)).toBe(true);
    expect(SOCKET_NAME.test("4242-fedcba9876543210.sock")).toBe(true);
  });

  it("makes socket names that carry the owner process id", () => {
    const name = socketFileName(4242);
    expect(name).toMatch(/^4242-[0-9a-f]{16}\.sock$/);
    expect(socketFileName(4242)).not.toBe(name);
    expect(socketProcessId(name)).toBe(4242);
    expect(socketProcessId("1-fedcba9876543210.sock")).toBe(1);
    for (const foreign of ["fedcba9876543210.sock", "daemon.sock", "0-fedcba9876543210.sock"]) {
      expect(socketProcessId(foreign), foreign).toBeUndefined();
    }
  });
});

describe("entry Schema and rules", () => {
  const folder = "/tmp/docks-kit-talk-1000";
  const fileName = entryFileName(INSTANCE, SESSION);

  it("encodes and decodes an entry", async () => {
    const entry = entryFor(folder);
    const decoded = await Effect.runPromise(
      decodeEntry(encodeEntry(entry), fileName, folder, "unix"),
    );
    expect(decoded).toEqual(entry);
  });

  it("rejects text that is not an entry, and names the file", async () => {
    for (const text of ["not json", "{}", encodeEntry({ ...entryFor(folder), secret: "short" })]) {
      const error = await Effect.runPromise(
        Effect.flip(decodeEntry(text, fileName, folder, "unix")),
      );
      expect(error).toBeInstanceOf(TalkEntryRejected);
      expect(error.fileName).toBe(fileName);
    }
  });

  it("rejects ids that do not give the file name", () => {
    expect(entryFault(entryFor(folder), fileName, folder, "unix")).toBeUndefined();
    expect(
      entryFault(entryFor(folder, { sessionId: "session-2" }), fileName, folder, "unix"),
    ).toMatch(/file name/);
    expect(
      entryFault(entryFor(folder, { instanceId: "1111111111111111" }), fileName, folder, "unix"),
    ).toMatch(/file name/);
  });

  it("rejects a socket path that is not a socket name directly in the folder", () => {
    for (const path of [
      "/tmp/elsewhere/4242-fedcba9876543210.sock",
      posix.join(folder, "daemon.sock"),
      posix.join(folder, "fedcba9876543210.sock"),
      posix.join(folder, "sub", "4242-fedcba9876543210.sock"),
      `${folder}/../4242-fedcba9876543210.sock`,
      "4242-fedcba9876543210.sock",
      posix.join(folder, "4242-fedcba9876543210.entry"),
    ]) {
      const entry = entryFor(folder, { endpoint: { kind: "unix", path } });
      expect(entryFault(entry, fileName, folder, "unix"), path).toMatch(/socket path/);
    }
  });

  it("wants a Unix socket on POSIX and a TCP port on Windows", () => {
    const tcp = entryFor(folder, { endpoint: { kind: "tcp", port: 50_000 } });
    expect(entryFault(tcp, fileName, folder, "unix")).toMatch(/endpoint/);
    expect(entryFault(tcp, fileName, folder, "tcp")).toBeUndefined();
    expect(entryFault(entryFor(folder), fileName, folder, "tcp")).toMatch(/endpoint/);
  });
});

describe("E7 endpoint rules", () => {
  it("keeps a socket path below the sun_path size of each system", () => {
    expect(SUN_PATH_BYTES).toEqual({ linux: 108, darwin: 104 });
    const at = (bytes: number): string => `/${"a".repeat(bytes - 1)}`;
    expect(sunPathFault(at(107), "linux")).toBeUndefined();
    expect(sunPathFault(at(108), "linux")).toContain(at(108));
    expect(sunPathFault(at(103), "darwin")).toBeUndefined();
    expect(sunPathFault(at(104), "darwin")).toMatch(/sun_path/);
    // Bytes count, not characters.
    expect(sunPathFault(`/${"é".repeat(54)}`, "linux")).toMatch(/109 bytes/);
  });

  it("accepts a socket of the user with the owner write bit only", () => {
    expect(socketFault(socketStat(), USER)).toBeUndefined();
    expect(socketFault(socketStat({ mode: 0o200 }), USER)).toBeUndefined();
    expect(socketFault(socketStat({ kind: "file" }), USER)).toMatch(/not a socket/);
    expect(socketFault(socketStat({ uid: 1234 }), USER)).toMatch(/uid 1234/);
    const noWrite = socketFault(socketStat({ mode: 0o500 }), USER);
    expect(noWrite).toMatch(/owner write/);
    expect(noWrite).toMatch(/umask/);
    expect(noWrite).toMatch(/default ACL/);
  });
});

// --- Real endpoints ------------------------------------------------------------

const withUmask = async <A>(mask: number, body: () => Promise<A>): Promise<A> => {
  const previous = process.umask(mask);
  try {
    return await body();
  } finally {
    process.umask(previous);
  }
};

const reachable = (endpoint: Endpoint): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket =
    endpoint.kind === "unix"
      ? connect({ path: endpoint.path })
      : connect({ host: "127.0.0.1", port: endpoint.port });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
};

const bind = (folder: string, platform: NodeJS.Platform = process.platform) =>
  Effect.runPromise(bindEndpoint({ folder, platform, onConnection: (socket) => socket.destroy() }));

const close = (bound: BoundEndpoint) => Effect.runPromise(closeEndpoint(bound));

describe.skipIf(!POSIX)("POSIX endpoint (real)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tr-"));
    chmodSync(base, 0o700);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("binds a fresh socket name in the folder for each bind and passes the E7 check", async () => {
    const first = await bind(base);
    const second = await bind(base);
    try {
      for (const bound of [first, second]) {
        expect(bound.endpoint.kind).toBe("unix");
        const path = bound.endpoint.kind === "unix" ? bound.endpoint.path : "";
        expect(join(path, "..")).toBe(base);
        expect(path.slice(base.length + 1)).toMatch(SOCKET_NAME);
        expect(socketProcessId(path.slice(base.length + 1))).toBe(process.pid);
        expect(lstatSync(path).isSocket()).toBe(true);
        expect(await reachable(bound.endpoint)).toBe(true);
        expect(endpointState(bound)).toBe("intact");
      }
      expect(first.endpoint).not.toEqual(second.endpoint);
    } finally {
      await close(first);
      await close(second);
    }
  });

  it("reports a deleted socket file as replaced", async () => {
    const bound = await bind(base);
    try {
      if (bound.endpoint.kind === "unix") unlinkSync(bound.endpoint.path);
      expect(endpointState(bound)).toBe("replaced");
    } finally {
      await close(bound);
    }
  });

  it("fails a socket without owner write, names the umask, and never changes the mode", async () => {
    const error = await withUmask(0o277, () =>
      Effect.runPromise(
        Effect.flip(
          bindEndpoint({ folder: base, platform: process.platform, onConnection: () => {} }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(TalkEndpointError);
    expect(error.reason).toMatch(/owner write/);
    expect(error.reason).toMatch(/umask/);
    expect(error.path.startsWith(base)).toBe(true);
    // The candidate is closed and was never made writable.
    expect(await reachable({ kind: "unix", path: error.path })).toBe(false);
  });

  it("fails a path above the sun_path size with an error that names it", async () => {
    const deep = join(base, "x".repeat(120));
    mkdirSync(deep, { mode: 0o700 });
    const error = await Effect.runPromise(
      Effect.flip(
        bindEndpoint({ folder: deep, platform: process.platform, onConnection: () => {} }),
      ),
    );
    expect(error).toBeInstanceOf(TalkEndpointError);
    expect(error.path.startsWith(deep)).toBe(true);
    expect(error.reason).toMatch(/sun_path/);
  });
});

describe("Windows endpoint branch (TCP on any system)", () => {
  it("binds 127.0.0.1 with a port that the system picks, with no socket file", async () => {
    const bound = await bind("/unused", "win32");
    try {
      expect(bound.endpoint.kind).toBe("tcp");
      const port = bound.endpoint.kind === "tcp" ? bound.endpoint.port : 0;
      expect(port).toBeGreaterThan(0);
      expect(bound.server.address()).toMatchObject({ address: "127.0.0.1", port });
      expect(await reachable(bound.endpoint)).toBe(true);
      expect(endpointState(bound)).toBe("intact");
    } finally {
      await close(bound);
    }
  });
});

// --- Registry operations -----------------------------------------------------

const posixRegistry = (folder: string) =>
  TalkRegistry.layerPosix(folder).pipe(Layer.provide(TalkPosixSystem.layer));

const runIn = <A, E>(
  layer: Layer.Layer<TalkRegistry, never>,
  effect: Effect.Effect<A, E, TalkRegistry>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, layer));

const failIn = <A, E>(
  layer: Layer.Layer<TalkRegistry, never>,
  effect: Effect.Effect<A, E, TalkRegistry>,
): Promise<E> => Effect.runPromise(Effect.provide(Effect.flip(effect), layer));

describe.skipIf(!POSIX)("POSIX registry (real)", () => {
  let base = "";
  let folder = "";
  let layer: Layer.Layer<TalkRegistry, never>;

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "tr-"));
    folder = join(base, "reg");
    layer = posixRegistry(folder).pipe(Layer.orDie);
    await runIn(
      layer,
      TalkRegistry.use((registry) => registry.prepare),
    );
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const publish = (entry: RegistryEntry) =>
    runIn(
      layer,
      TalkRegistry.use((registry) => registry.publish(entry)),
    );

  it("publishes a 0600 entry, lists it, reads it, and removes it", async () => {
    const entry = entryFor(folder);
    const published = await publish(entry);
    try {
      const fileName = entryFileName(INSTANCE, SESSION);
      expect(published.path).toBe(join(folder, fileName));
      expect(lstatSync(published.path).mode & 0o777).toBe(0o600);
      expect(published.fd).toBeTypeOf("number");
      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.entries).toEqual([{ fileName, entry }]);
      expect(listing.rejected).toEqual([]);
      const read = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.read(fileName)),
      );
      expect(Option.getOrUndefined(read)).toEqual(entry);
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.check(published)),
        ),
      ).toBe("intact");
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.remove(fileName)),
      );
      expect(existsSync(published.path)).toBe(false);
      // A second removal of a missing name succeeds.
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.remove(fileName)),
      );
    } finally {
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.release(published)),
      );
    }
  });

  it("skips foreign names and rejects bad entries without failing the listing", async () => {
    const good = entryFor(folder);
    const published = await publish(good);
    try {
      writeFileSync(join(folder, "foreign.txt"), "keep");
      writeFileSync(join(folder, "token"), "keep");
      const badSocket = entryFor(folder, {
        instanceId: "1111111111111111",
        endpoint: { kind: "unix", path: join(base, "4242-fedcba9876543210.sock") },
      });
      const badName = entryFileName("1111111111111111", SESSION);
      writeFileSync(join(folder, badName), encodeEntry(badSocket), { mode: 0o600 });
      const foreignIds = entryFileName("2222222222222222", SESSION);
      writeFileSync(join(folder, foreignIds), encodeEntry(entryFor(folder)), { mode: 0o600 });
      const garbage = entryFileName("3333333333333333", SESSION);
      writeFileSync(join(folder, garbage), "garbage", { mode: 0o600 });
      const open = entryFileName("4444444444444444", SESSION);
      writeFileSync(
        join(folder, open),
        encodeEntry(entryFor(folder, { instanceId: "4444444444444444" })),
        {
          mode: 0o644,
        },
      );
      chmodSync(join(folder, open), 0o644);

      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.entries.map((listed) => listed.fileName)).toEqual([
        entryFileName(INSTANCE, SESSION),
      ]);
      const rejected = new Map(listing.rejected.map((item) => [item.fileName, item.reason]));
      expect([...rejected.keys()].sort()).toEqual([badName, foreignIds, garbage, open].sort());
      expect(rejected.get(badName)).toMatch(/socket path/);
      expect(rejected.get(foreignIds)).toMatch(/file name/);
      expect(rejected.get(open)).toMatch(/0644/);
      expect(
        Option.isNone(
          await runIn(
            layer,
            TalkRegistry.use((registry) => registry.read(badName)),
          ),
        ),
      ).toBe(true);
      // Nothing outside the talk names was touched.
      expect(readFileSync(join(folder, "foreign.txt"), "utf8")).toBe("keep");
      expect(readFileSync(join(folder, "token"), "utf8")).toBe("keep");
    } finally {
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.release(published)),
      );
    }
  });

  it("refuses to remove a name that is not a talk entry name", async () => {
    writeFileSync(join(folder, "foreign.txt"), "keep");
    const error = await failIn(
      layer,
      TalkRegistry.use((registry) => registry.remove("foreign.txt")),
    );
    expect(error).toBeInstanceOf(TalkFileError);
    expect(error).toMatchObject({ reason: "not a talk entry name" });
    expect(existsSync(join(folder, "foreign.txt"))).toBe(true);
  });

  it("removes a socket file of the name rules only", async () => {
    const socketPath = join(folder, "4242-fedcba9876543210.sock");
    const bound = await bind(folder);
    try {
      writeFileSync(join(folder, "keep.sock"), "keep");
      await runIn(
        layer,
        TalkRegistry.use((registry) =>
          registry.removeSocket({ kind: "unix", path: join(folder, "keep.sock") }),
        ),
      );
      expect(existsSync(join(folder, "keep.sock"))).toBe(true);
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.removeSocket(bound.endpoint)),
      );
      expect(bound.endpoint.kind === "unix" && existsSync(bound.endpoint.path)).toBe(false);
      // A missing socket name is no failure.
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.removeSocket({ kind: "unix", path: socketPath })),
      );
    } finally {
      await close(bound);
    }
  });

  it("lists the files of the socket pattern with the process id that each name carries", async () => {
    const bound = await bind(folder);
    try {
      writeFileSync(join(folder, "keep.sock"), "keep");
      writeFileSync(join(folder, "fedcba9876543210.sock"), "keep");
      const path = bound.endpoint.kind === "unix" ? bound.endpoint.path : "";
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.sockets),
        ),
      ).toEqual([{ path, processId: process.pid }]);
    } finally {
      await close(bound);
    }
    rmSync(folder, { recursive: true, force: true });
    expect(
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.sockets),
      ),
    ).toEqual([]);
  });

  it("reports a deleted, rewritten, or re-moded entry as replaced", async () => {
    const entry = entryFor(folder);
    for (const damage of [
      (path: string) => unlinkSync(path),
      (path: string) => writeFileSync(path, encodeEntry({ ...entry, name: "other" })),
      (path: string) => chmodSync(path, 0o644),
      (path: string) => {
        unlinkSync(path);
        writeFileSync(path, encodeEntry(entry), { mode: 0o600 });
      },
    ]) {
      const published = await publish(entry);
      try {
        damage(published.path);
        expect(
          await runIn(
            layer,
            TalkRegistry.use((registry) => registry.check(published)),
          ),
        ).toBe("replaced");
      } finally {
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.release(published)),
        );
      }
    }
  });

  it("refreshes the times of its own file through the kept descriptor, not the name", async () => {
    const published = await publish(entryFor(folder));
    const aside = join(base, "aside.entry");
    try {
      const old = new Date("2001-01-01T00:00:00Z");
      utimesSync(published.path, old, old);
      // The published file moves aside, and a new file takes its old name.
      renameSync(published.path, aside);
      writeFileSync(published.path, "other", { mode: 0o600 });
      utimesSync(published.path, old, old);
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.refresh(published)),
      );
      expect(statSync(aside).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
      expect(statSync(published.path).mtimeMs).toBe(old.getTime());
    } finally {
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.release(published)),
      );
    }
  });

  it("reports a missing folder and creates it again with prepare", async () => {
    rmSync(folder, { recursive: true });
    expect(
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.folderPresent),
      ),
    ).toBe(false);
    const listing = await runIn(
      layer,
      TalkRegistry.use((registry) => registry.list),
    );
    expect(listing).toEqual({ entries: [], rejected: [] });
    await runIn(
      layer,
      TalkRegistry.use((registry) => registry.prepare),
    );
    expect(lstatSync(folder).mode & 0o777).toBe(0o700);
    expect(
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.folderPresent),
      ),
    ).toBe(true);
  });

  it("refuses to publish into an untrusted folder", async () => {
    chmodSync(folder, 0o755);
    const error = await failIn(
      layer,
      TalkRegistry.use((registry) => registry.publish(entryFor(folder))),
    );
    expect(error).toBeInstanceOf(TalkTrustError);
  });

  it("passes trust faults of a lookup up and gives None only for an entry that is not there or does not decode", async () => {
    const published = await publish(entryFor(folder));
    try {
      const lookup = (fileName: string) => TalkRegistry.use((registry) => registry.read(fileName));
      // A missing name and content that does not decode complete without an entry.
      expect(
        Option.isNone(await runIn(layer, lookup(entryFileName("1111111111111111", SESSION)))),
      ).toBe(true);
      const garbage = entryFileName("2222222222222222", SESSION);
      writeFileSync(join(folder, garbage), "garbage", { mode: 0o600 });
      chmodSync(join(folder, garbage), 0o600);
      expect(Option.isNone(await runIn(layer, lookup(garbage)))).toBe(true);
      // A mode other than 0600 is a trust fault of the entry file, with its path and reason.
      chmodSync(published.path, 0o644);
      const modeError = await failIn(layer, lookup(published.fileName));
      expect(modeError).toBeInstanceOf(TalkTrustError);
      expect(modeError).toMatchObject({
        path: published.path,
        reason: expect.stringMatching(/0644/),
      });
      // A listing reports it as rejected with the reason and goes on.
      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.rejected).toContainEqual({
        fileName: published.fileName,
        reason: expect.stringMatching(/0644/),
      });
      chmodSync(folder, 0o755);
      const folderError = await failIn(layer, lookup(published.fileName));
      expect(folderError).toBeInstanceOf(TalkTrustError);
      // The folder check names the real path; macOS keeps its temporary folder behind `/var`.
      expect(folderError).toMatchObject({
        path: realpathSync(folder),
        reason: expect.stringMatching(/0755/),
      });
    } finally {
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.release(published)),
      );
    }
  });

  it("refuses to publish an entry above the size limit and rejects a larger file without a read", async () => {
    const big = entryFor(folder, { name: "n".repeat(MAX_SECRET_FILE_BYTES) });
    const error = await failIn(
      layer,
      TalkRegistry.use((registry) => registry.publish(big)),
    );
    expect(error).toBeInstanceOf(TalkFileError);
    expect(error).toMatchObject({ reason: expect.stringMatching(/limit of 65536 bytes/) });
    expect(readdirSync(folder)).toEqual([]);
    const fileName = entryFileName(INSTANCE, SESSION);
    writeFileSync(join(folder, fileName), encodeEntry(big), { mode: 0o600 });
    chmodSync(join(folder, fileName), 0o600);
    const listing = await runIn(
      layer,
      TalkRegistry.use((registry) => registry.list),
    );
    expect(listing.entries).toEqual([]);
    expect(listing.rejected).toEqual([
      { fileName, reason: expect.stringMatching(/above the limit of 65536 bytes/) },
    ]);
    const read = await runIn(
      layer,
      TalkRegistry.use((registry) => registry.read(fileName)),
    );
    expect(Option.isNone(read)).toBe(true);
  });

  /** The live POSIX system with one call changed. */
  const posixWith = (
    change: (live: TalkPosixSystem["Service"]) => TalkPosixSystem["Service"],
  ): Layer.Layer<TalkPosixSystem> =>
    Layer.effect(
      TalkPosixSystem,
      Effect.gen(function* () {
        return change(yield* TalkPosixSystem);
      }),
    ).pipe(Layer.provide(TalkPosixSystem.layer), Layer.orDie);

  it("reports a link that replaced the entry file after the lstat as a lookup error, not absence", async () => {
    const target = join(base, "target.entry");
    writeFileSync(target, encodeEntry(entryFor(folder)), { mode: 0o600 });
    chmodSync(target, 0o600);
    const fileName = entryFileName(INSTANCE, SESSION);
    const path = join(folder, fileName);
    symlinkSync(target, path);
    // The `lstat` saw a regular file; at the `O_NOFOLLOW` open the name is a link.
    const changed = TalkRegistry.layerPosix(folder).pipe(
      Layer.provide(
        posixWith((live) => ({
          ...live,
          view: {
            ...live.view,
            lstat: (name) => live.view.lstat(name === path ? target : name),
          },
        })),
      ),
    );
    const error = await failIn(
      changed,
      TalkRegistry.use((registry) => registry.read(fileName)),
    );
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ path, reason: expect.stringMatching(/symbolic link replaced/) });
    const listing = await runIn(
      changed,
      TalkRegistry.use((registry) => registry.list),
    );
    expect(listing.rejected).toEqual([
      { fileName, reason: expect.stringMatching(/symbolic link replaced/) },
    ]);
  });

  it("bounds a production read of a file that grows after the fstat size check", async () => {
    const big = join(folder, "big.entry");
    const grown = join(folder, "grown.entry");
    writeFileSync(big, Buffer.alloc(MAX_SECRET_FILE_BYTES + 100, 1), { mode: 0o600 });
    // Distinct bytes before and after the 11 bytes of the first buffer, so a lost prefix shows.
    const grownBytes = Buffer.concat([Buffer.alloc(11, 0x61), Buffer.alloc(39, 0x62)]);
    writeFileSync(grown, grownBytes, { mode: 0o600 });
    chmodSync(big, 0o600);
    chmodSync(grown, 0o600);
    interface Read {
      readonly position: number;
      readonly count: number;
    }
    // `fstat` shows `size` bytes; the file has more by the time of the read. Each read through
    // the descriptor is recorded.
    const observed = (size: bigint, reads: Array<Read>) =>
      posixWith((live) => ({
        ...live,
        fstat: (fd) => {
          const real = live.fstat(fd);
          return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
            size,
          }) as BigIntStats;
        },
        read: (fd, buffer, offset, length, position) => {
          const count = live.read(fd, buffer, offset, length, position);
          reads.push({ position, count });
          return count;
        },
      }));
    const total = (reads: ReadonlyArray<Read>): number =>
      reads.reduce((sum, read) => sum + read.count, 0);
    const restarts = (reads: ReadonlyArray<Read>): number =>
      reads.slice(1).filter((read) => read.position === 0).length;
    const hardLimit = MAX_SECRET_FILE_BYTES + 1;

    // Growth past the limit: the read goes on after the first buffer and stops at the hard limit.
    const bigReads: Array<Read> = [];
    const error = await Effect.runPromise(
      Effect.flip(readSecretFile(big)).pipe(Effect.provide(observed(10n, bigReads))),
    );
    expect(error).toBeInstanceOf(TalkFileTooLarge);
    expect(error).toMatchObject({ path: big });
    expect(total(bigReads)).toBe(hardLimit);
    expect(restarts(bigReads)).toBe(0);

    // A first buffer at the hard limit that fills is rejected with no further read.
    const fullReads: Array<Read> = [];
    const full = await Effect.runPromise(
      Effect.flip(readSecretFile(big)).pipe(
        Effect.provide(observed(BigInt(MAX_SECRET_FILE_BYTES), fullReads)),
      ),
    );
    expect(full).toBeInstanceOf(TalkFileTooLarge);
    expect(total(fullReads)).toBe(hardLimit);
    expect(restarts(fullReads)).toBe(0);

    // Growth within the limit: every byte is read once.
    const grownReads: Array<Read> = [];
    const read = await Effect.runPromise(
      readSecretFile(grown).pipe(Effect.provide(observed(10n, grownReads))),
    );
    expect(Buffer.from(Option.getOrThrow(read))).toEqual(grownBytes);
    expect(total(grownReads)).toBe(50);
    expect(restarts(grownReads)).toBe(0);
  });

  it("sizes the read buffer from the fstat size plus one sentinel byte", async () => {
    const path = join(folder, "small.entry");
    writeFileSync(path, "abc", { mode: 0o600 });
    chmodSync(path, 0o600);
    const read = await Effect.runPromise(
      readSecretFile(path).pipe(Effect.provide(TalkPosixSystem.layer)),
    );
    const bytes = Option.getOrThrow(read);
    expect(Buffer.from(bytes)).toEqual(Buffer.from("abc"));
    expect(bytes.buffer.byteLength).toBe(4);
  });
});

/** A stand-in for DPAPI on every system: it reverses the bytes behind a marker byte. */
const fakeDpapi = Layer.succeed(
  TalkDpapi,
  TalkDpapi.of({
    protect: (items) => Effect.succeed(items.map((item) => new Uint8Array([7, ...item].reverse()))),
    unprotect: (items) =>
      Effect.succeed(
        items.map((item) => {
          const plain = [...item].reverse();
          return plain[0] === 7 ? new Uint8Array(plain.slice(1)) : undefined;
        }),
      ),
  }),
);

const windowsCases = (label: string, dpapi: Layer.Layer<TalkDpapi>) =>
  describe(label, () => {
    let base = "";
    let folder = "";
    let layer: Layer.Layer<TalkRegistry, never>;

    beforeEach(async () => {
      base = mkdtempSync(join(tmpdir(), "tr-"));
      folder = join(base, "docks-kit", "talk");
      layer = TalkRegistry.layerWindows(folder).pipe(Layer.provide(dpapi));
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.prepare),
      );
    });

    afterEach(() => {
      rmSync(base, { recursive: true, force: true });
    });

    const tcpEntry = (overrides: Partial<RegistryEntry> = {}) =>
      entryFor(folder, { endpoint: { kind: "tcp", port: 50_123 }, ...overrides });

    it("creates the folder recursively, seals the whole entry, and lists it", async () => {
      expect(lstatSync(folder).isDirectory()).toBe(true);
      const entry = tcpEntry();
      const published = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.publish(entry)),
      );
      const fileName = entryFileName(INSTANCE, SESSION);
      expect(published.fd).toBeUndefined();
      const onDisk = readFileSync(join(folder, fileName));
      expect(onDisk).toEqual(Buffer.from(published.bytes));
      expect(onDisk.includes(SECRET)).toBe(false);
      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.entries).toEqual([{ fileName, entry }]);
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.check(published)),
        ),
      ).toBe("intact");
      writeFileSync(published.path, "other");
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.check(published)),
        ),
      ).toBe("replaced");
      unlinkSync(published.path);
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.check(published)),
        ),
      ).toBe("replaced");
    });

    it("rejects a tampered blob, foreign ids, and a Unix endpoint in one listing", async () => {
      const good = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.publish(tcpEntry())),
      );
      const tampered = entryFileName("1111111111111111", SESSION);
      writeFileSync(join(folder, tampered), Buffer.from([1, 2, 3]));
      const foreign = await runIn(
        layer,
        TalkRegistry.use((registry) =>
          registry.publish(tcpEntry({ instanceId: "2222222222222222" })),
        ),
      );
      const copied = entryFileName("3333333333333333", SESSION);
      writeFileSync(join(folder, copied), readFileSync(foreign.path));
      const unix = await runIn(
        layer,
        TalkRegistry.use((registry) =>
          registry.publish(entryFor(folder, { instanceId: "4444444444444444" })),
        ),
      );
      writeFileSync(join(folder, "foreign.txt"), "keep");
      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.entries.map((listed) => listed.fileName).sort()).toEqual(
        [good, foreign].map((published) => published.fileName).sort(),
      );
      const rejected = new Map(listing.rejected.map((item) => [item.fileName, item.reason]));
      expect([...rejected.keys()].sort()).toEqual([tampered, copied, unix.fileName].sort());
      expect(rejected.get(copied)).toMatch(/file name/);
      expect(rejected.get(unix.fileName)).toMatch(/endpoint/);
      expect(readFileSync(join(folder, "foreign.txt"), "utf8")).toBe("keep");
    });

    it("reports a missing folder and creates it again", async () => {
      rmSync(join(base, "docks-kit"), { recursive: true });
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.folderPresent),
        ),
      ).toBe(false);
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.prepare),
      );
      expect(
        await runIn(
          layer,
          TalkRegistry.use((registry) => registry.folderPresent),
        ),
      ).toBe(true);
    });

    it("rejects a blob above the size limit without a read", async () => {
      const fileName = entryFileName(INSTANCE, SESSION);
      writeFileSync(join(folder, fileName), Buffer.alloc(MAX_SECRET_FILE_BYTES + 1, 7));
      const listing = await runIn(
        layer,
        TalkRegistry.use((registry) => registry.list),
      );
      expect(listing.rejected).toEqual([
        { fileName, reason: expect.stringMatching(/above the limit of 65536 bytes/) },
      ]);
    });

    it("removes its temporary file when the rename fails", async () => {
      const entry = tcpEntry();
      // A folder at the entry name makes the rename fail.
      mkdirSync(join(folder, entryFileName(INSTANCE, SESSION)));
      writeFileSync(join(folder, "keep.txt"), "keep");
      const error = await failIn(
        layer,
        TalkRegistry.use((registry) => registry.publish(entry)),
      );
      expect(error).toBeInstanceOf(TalkFileError);
      expect(readdirSync(folder).sort()).toEqual([entryFileName(INSTANCE, SESSION), "keep.txt"]);
    });

    it("removes its temporary file when the write after the exclusive open fails", async () => {
      const failing = TalkRegistry.layerWindows(folder, {
        writeFile: () => {
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
      }).pipe(Layer.provide(dpapi));
      writeFileSync(join(folder, "keep.txt"), "keep");
      const error = await failIn(
        failing,
        TalkRegistry.use((registry) => registry.publish(tcpEntry())),
      );
      expect(error).toMatchObject({ code: "ENOSPC" });
      expect(readdirSync(folder)).toEqual(["keep.txt"]);
    });
  });

describe("bounded entry reads (any system)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tr-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("reads a secret file through its descriptor up to the limit and rejects more bytes", async () => {
    const small = join(base, "small");
    const large = join(base, "large");
    writeFileSync(small, "abc");
    writeFileSync(large, Buffer.alloc(MAX_SECRET_FILE_BYTES + 100, 1));
    const smallFd = openSync(small, "r");
    const largeFd = openSync(large, "r");
    try {
      expect(Buffer.from(await Effect.runPromise(readSecretBytes(small, smallFd, 3)))).toEqual(
        Buffer.from("abc"),
      );
      // `fstat` showed 3 bytes, and the file has more than the limit: the read stops at the limit.
      const error = await Effect.runPromise(Effect.flip(readSecretBytes(large, largeFd, 3)));
      expect(error).toBeInstanceOf(TalkFileTooLarge);
      expect(error).toMatchObject({ path: large });
    } finally {
      closeSync(smallFd);
      closeSync(largeFd);
    }
  });

  it("reads a file at its observed length plus one sentinel byte and reports a length change", async () => {
    const path = join(base, "blob");
    writeFileSync(path, Buffer.alloc(10, 2));
    const same = await Effect.runPromise(readObserved(path, 10));
    expect(same instanceof Uint8Array && same.byteLength).toBe(10);
    // The file has more or fewer bytes than its `lstat` showed.
    expect(await Effect.runPromise(readObserved(path, 5))).toBe("changed");
    expect(await Effect.runPromise(readObserved(path, 20))).toBe("changed");
    expect(await Effect.runPromise(readObserved(join(base, "missing"), 3))).toBeUndefined();
  });
});

describe("Windows registry branch lookup failures (any system)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "tr-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("passes a failed DPAPI batch of a read up instead of None", async () => {
    const failing = Layer.succeed(
      TalkDpapi,
      TalkDpapi.of({
        protect: (items) => Effect.succeed(items),
        unprotect: () => Effect.fail(new TalkSealError({ reason: "DPAPI is not there" })),
      }),
    );
    const layer = TalkRegistry.layerWindows(base).pipe(Layer.provide(failing));
    const fileName = entryFileName(INSTANCE, SESSION);
    writeFileSync(join(base, fileName), Buffer.from([1, 2, 3]));
    const error = await failIn(
      layer,
      TalkRegistry.use((registry) => registry.read(fileName)),
    );
    expect(error).toBeInstanceOf(TalkSealError);
  });

  it("reports a length change between the lstat and the read as a lookup error, not absence", async () => {
    const layer = TalkRegistry.layerWindows(base, {
      beforeRead: (path) => appendFileSync(path, "x"),
    }).pipe(Layer.provide(fakeDpapi));
    const fileName = entryFileName(INSTANCE, SESSION);
    const path = join(base, fileName);
    writeFileSync(path, Buffer.from([1, 2, 3]));
    const error = await failIn(
      layer,
      TalkRegistry.use((registry) => registry.read(fileName)),
    );
    expect(error).toBeInstanceOf(TalkFileError);
    expect(error).toMatchObject({ path, reason: "the file changed during the read" });
    const listing = await runIn(
      layer,
      TalkRegistry.use((registry) => registry.list),
    );
    expect(listing.rejected).toEqual([{ fileName, reason: "the file changed during the read" }]);
  });
});

windowsCases("Windows registry branch (DPAPI stand-in, any system)", fakeDpapi);

if (WINDOWS) windowsCases("Windows registry (real DPAPI)", TalkDpapi.layer);
