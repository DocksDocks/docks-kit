import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  sessionKey,
  temporaryFileName,
} from "../../../talk/transport/registry";
import { TalkDpapi } from "../../../talk/transport/sealWindows";
import {
  type EntryStat,
  TalkFileError,
  TalkPosixSystem,
  TalkTrustError,
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
  endpoint: { kind: "unix", path: join(folder, "fedcba9876543210.sock") },
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
    expect(isTalkName("fedcba9876543210.sock")).toBe(true);
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
      "0123456789ABCDEF.sock",
      "0123456789abcdef.entry",
      `${INSTANCE}-${sha16(SESSION)}.entry.bak`,
    ]) {
      expect(isTalkName(foreign), foreign).toBe(false);
    }
    expect(ENTRY_NAME.test(`${INSTANCE}-${sha16(SESSION)}.entry`)).toBe(true);
    expect(SOCKET_NAME.test("fedcba9876543210.sock")).toBe(true);
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
      "/tmp/elsewhere/fedcba9876543210.sock",
      join(folder, "daemon.sock"),
      join(folder, "sub", "fedcba9876543210.sock"),
      join(folder, "..", "fedcba9876543210.sock"),
      "fedcba9876543210.sock",
      join(folder, "fedcba9876543210.entry"),
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
        endpoint: { kind: "unix", path: join(base, "fedcba9876543210.sock") },
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
    const socketPath = join(folder, "fedcba9876543210.sock");
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

  it("refreshes the times of its own entry file through the kept descriptor", async () => {
    const published = await publish(entryFor(folder));
    try {
      const old = new Date("2001-01-01T00:00:00Z");
      utimesSync(published.path, old, old);
      await runIn(
        layer,
        TalkRegistry.use((registry) => registry.refresh(published)),
      );
      expect(statSync(published.path).mtimeMs).toBeGreaterThan(old.getTime() + 1000);
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
  });

windowsCases("Windows registry branch (DPAPI stand-in, any system)", fakeDpapi);

if (WINDOWS) windowsCases("Windows registry (real DPAPI)", TalkDpapi.layer);
