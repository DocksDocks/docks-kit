import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Result } from "effect";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type FolderChoice,
  TALK_DIR_OVERRIDE,
  registryFolderFor,
  resolveRegistryFolder,
  windowsPowerShellPath,
} from "../../../talk/transport/folder";
import {
  DPAPI_ENTROPY,
  TalkDpapi,
  TalkSealError,
  TalkUnsealRejected,
  encodeDpapiInput,
  parseDpapiOutput,
  sealEntries,
  unsealEntries,
} from "../../../talk/transport/sealWindows";
import {
  type EntryKind,
  type EntryStat,
  MAX_LINK_HOPS,
  type PathView,
  TalkFileError,
  TalkFolderMissingError,
  TalkPosixSystem,
  TalkTrustError,
  aclListingFault,
  checkRegistryFolder,
  ensureRegistryFolder,
  evaluateRegistryFolder,
  publishSecretFile,
  readSecretFile,
  secretFileFault,
} from "../../../talk/transport/trustPosix";

// Trust rules of #249 E4 and E5: the registry folder choice, the POSIX walk and
// creation, the secret files, and the Windows DPAPI seal.

const WINDOWS = process.platform === "win32";
const DARWIN = process.platform === "darwin";
const POSIX = !WINDOWS;
const USER = 1000;
const ROOT = 0;
const OTHER = 1234;

// --- Synthetic file system for the pure walk ---------------------------------

interface FakeEntry {
  readonly kind: EntryKind;
  readonly uid: number;
  readonly mode: number;
  readonly target?: string;
}

const folder = (uid: number, mode: number): FakeEntry => ({ kind: "folder", uid, mode });
const link = (uid: number, target: string): FakeEntry => ({
  kind: "link",
  uid,
  mode: 0o777,
  target,
});
const file = (uid: number, mode: number): FakeEntry => ({ kind: "file", uid, mode });

function fakeView(
  entries: Readonly<Record<string, FakeEntry>>,
  failures: Readonly<Record<string, string>> = {},
): PathView {
  const paths = Object.keys(entries);
  return {
    lstat: (path) => {
      const failure = failures[path];
      if (failure !== undefined) return { _tag: "Failed", reason: failure };
      const entry = entries[path];
      if (entry === undefined) return { _tag: "Missing" };
      const stat: EntryStat = {
        kind: entry.kind,
        uid: entry.uid,
        mode: entry.mode,
        dev: 1n,
        ino: BigInt(paths.indexOf(path) + 1),
      };
      return { _tag: "Found", stat };
    },
    readlink: (path) => {
      const target = entries[path]?.target;
      return target === undefined
        ? { _tag: "Failed", reason: "EINVAL" }
        : { _tag: "Target", target };
    },
  };
}

/** A Linux-like base: root-owned `/` and a sticky `/tmp`. */
const BASE: Readonly<Record<string, FakeEntry>> = {
  "/": folder(ROOT, 0o755),
  "/tmp": folder(ROOT, 0o1777),
};

describe("evaluateRegistryFolder (synthetic)", () => {
  it("trusts a 0700 folder of the user below a sticky /tmp", () => {
    const view = fakeView({ ...BASE, "/tmp/reg": folder(USER, 0o700) });
    expect(evaluateRegistryFolder("/tmp/reg", USER, view)).toEqual({
      _tag: "Trusted",
      resolved: "/tmp/reg",
    });
  });

  it("reports a missing registry folder below trusted ancestors", () => {
    const view = fakeView(BASE);
    expect(evaluateRegistryFolder("/tmp/reg", USER, view)).toEqual({
      _tag: "Missing",
      path: "/tmp/reg",
    });
  });

  it.each([
    ["another owner", folder(OTHER, 0o700), /uid 1234/],
    ["root as owner", folder(ROOT, 0o700), /uid 0/],
    ["mode 0750", folder(USER, 0o750), /0750/],
    ["mode 0600", folder(USER, 0o600), /0600/],
    ["mode 0777", folder(USER, 0o777), /0777/],
    ["the setgid bit", folder(USER, 0o2700), /2700/],
    ["a symbolic link", link(USER, "/tmp/real"), /symbolic link/],
    ["a regular file", file(USER, 0o700), /not a folder/],
  ])("rejects a registry folder with %s", (_name, entry, reason) => {
    const view = fakeView({ ...BASE, "/tmp/real": folder(USER, 0o700), "/tmp/reg": entry });
    const verdict = evaluateRegistryFolder("/tmp/reg", USER, view);
    expect(verdict._tag).toBe("Untrusted");
    if (verdict._tag !== "Untrusted") return;
    expect(verdict.path).toBe("/tmp/reg");
    expect(verdict.reason).toMatch(reason);
  });

  it("rejects an ancestor of another owner", () => {
    const view = fakeView({
      ...BASE,
      "/tmp/x": folder(OTHER, 0o755),
      "/tmp/x/reg": folder(USER, 0o700),
    });
    expect(evaluateRegistryFolder("/tmp/x/reg", USER, view)).toMatchObject({
      _tag: "Untrusted",
      path: "/tmp/x",
    });
  });

  it.each([0o775, 0o757, 0o777])(
    "rejects a writable ancestor of mode %o without the sticky bit",
    (mode) => {
      const view = fakeView({
        ...BASE,
        "/tmp/x": folder(USER, mode),
        "/tmp/x/reg": folder(USER, 0o700),
      });
      expect(evaluateRegistryFolder("/tmp/x/reg", USER, view)).toMatchObject({
        _tag: "Untrusted",
        path: "/tmp/x",
      });
    },
  );

  it("names a squatted default folder and its owner below the sticky /tmp", () => {
    // E4 pre-mortem: the error names the folder and its owner, so an administrator can remove it.
    // The entry's own owner rule comes before the sticky rule of its parent.
    const view = fakeView({ ...BASE, "/tmp/docks-kit-talk-1000": folder(OTHER, 0o700) });
    expect(evaluateRegistryFolder("/tmp/docks-kit-talk-1000", USER, view)).toEqual({
      _tag: "Untrusted",
      path: "/tmp/docks-kit-talk-1000",
      reason: "the folder is owned by uid 1234, not by the user (uid 1000)",
    });
  });

  it("rejects an ancestor that is a file or that is missing", () => {
    const fileView = fakeView({ ...BASE, "/tmp/x": file(USER, 0o600) });
    expect(evaluateRegistryFolder("/tmp/x/reg", USER, fileView)).toMatchObject({
      _tag: "Untrusted",
      path: "/tmp/x",
      reason: expect.stringMatching(/not a folder/),
    });
    expect(evaluateRegistryFolder("/tmp/x/reg", USER, fakeView(BASE))).toMatchObject({
      _tag: "Untrusted",
      path: "/tmp/x",
      reason: expect.stringMatching(/does not exist/),
    });
  });

  it("rejects a relative path and the root folder", () => {
    expect(evaluateRegistryFolder("tmp/reg", USER, fakeView(BASE))).toMatchObject({
      _tag: "Untrusted",
      reason: expect.stringMatching(/absolute/),
    });
    expect(evaluateRegistryFolder("/", USER, fakeView(BASE))).toMatchObject({
      _tag: "Untrusted",
      path: "/",
    });
  });

  it("names the path and the reason when lstat fails", () => {
    const view = fakeView({ ...BASE, "/tmp/reg": folder(USER, 0o700) }, { "/tmp/reg": "EACCES" });
    expect(evaluateRegistryFolder("/tmp/reg", USER, view)).toMatchObject({
      _tag: "Untrusted",
      path: "/tmp/reg",
      reason: expect.stringMatching(/EACCES/),
    });
  });

  it("follows the macOS /var link hop by hop", () => {
    const view = fakeView({
      "/": folder(ROOT, 0o755),
      "/var": link(ROOT, "private/var"),
      "/private": folder(ROOT, 0o755),
      "/private/var": folder(ROOT, 0o755),
      "/private/var/folders": folder(ROOT, 0o755),
      "/private/var/folders/ab": folder(USER, 0o755),
      "/private/var/folders/ab/T": folder(USER, 0o700),
      "/private/var/folders/ab/T/docks-kit-talk": folder(USER, 0o700),
    });
    expect(evaluateRegistryFolder("/var/folders/ab/T/docks-kit-talk", USER, view)).toEqual({
      _tag: "Trusted",
      resolved: "/private/var/folders/ab/T/docks-kit-talk",
    });
  });

  it("resolves a relative link target with `..` against the real parent", () => {
    const view = fakeView({
      ...BASE,
      "/tmp/a": folder(USER, 0o700),
      "/tmp/a/l": link(USER, "../b"),
      "/tmp/b": folder(USER, 0o700),
      "/tmp/b/reg": folder(USER, 0o700),
    });
    expect(evaluateRegistryFolder("/tmp/a/l/reg", USER, view)).toEqual({
      _tag: "Trusted",
      resolved: "/tmp/b/reg",
    });
  });

  it("rejects a link above the folder that another user owns", () => {
    const view = fakeView({
      ...BASE,
      "/tmp/l": link(OTHER, "/tmp/b"),
      "/tmp/b": folder(USER, 0o700),
      "/tmp/b/reg": folder(USER, 0o700),
    });
    // The sticky /tmp rejects the next entry of another owner first.
    expect(evaluateRegistryFolder("/tmp/l/reg", USER, view)).toMatchObject({ _tag: "Untrusted" });
    const home = fakeView({
      "/": folder(ROOT, 0o755),
      "/h": folder(USER, 0o700),
      "/h/l": link(OTHER, "/h/b"),
      "/h/b": folder(USER, 0o700),
      "/h/b/reg": folder(USER, 0o700),
    });
    expect(evaluateRegistryFolder("/h/l/reg", USER, home)).toMatchObject({
      _tag: "Untrusted",
      path: "/h/l",
      reason: expect.stringMatching(/symbolic link/),
    });
  });

  it("checks each component of a link target", () => {
    const view = fakeView({
      ...BASE,
      "/tmp/a": folder(USER, 0o700),
      "/tmp/a/l": link(USER, "/open/b"),
      "/open": folder(ROOT, 0o777),
      "/open/b": folder(USER, 0o700),
      "/open/b/reg": folder(USER, 0o700),
    });
    expect(evaluateRegistryFolder("/tmp/a/l/reg", USER, view)).toMatchObject({
      _tag: "Untrusted",
      path: "/open",
    });
  });

  it("rejects a link loop after the hop limit", () => {
    const view = fakeView({
      ...BASE,
      "/tmp/a": link(USER, "/tmp/b"),
      "/tmp/b": link(USER, "/tmp/a"),
    });
    expect(evaluateRegistryFolder("/tmp/a/reg", USER, view)).toMatchObject({
      _tag: "Untrusted",
      reason: expect.stringMatching(/40 symbolic links/),
    });
  });

  it("accepts a link chain up to the hop limit and rejects a longer one", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_LINK_HOPS + 10 }), (hops) => {
        const entries: Record<string, FakeEntry> = {
          ...BASE,
          "/tmp/real": folder(USER, 0o700),
          "/tmp/real/reg": folder(USER, 0o700),
        };
        for (let index = 0; index < hops; index++) {
          const next = index + 1 === hops ? "/tmp/real" : `/tmp/l${index + 1}`;
          entries[`/tmp/l${index}`] = link(USER, next);
        }
        const start = hops === 0 ? "/tmp/real/reg" : "/tmp/l0/reg";
        const verdict = evaluateRegistryFolder(start, USER, fakeView(entries));
        expect(verdict._tag).toBe(hops <= MAX_LINK_HOPS ? "Trusted" : "Untrusted");
      }),
    );
  });
});

describe("aclListingFault", () => {
  it("accepts a folder line with no ACL entry, whatever marker follows the mode", () => {
    expect(aclListingFault("drwx------  2 u  staff  64 Nov 26 10:00 /f\n")).toBeUndefined();
    expect(aclListingFault("drwx------+ 2 u  staff  64 Nov 26 10:00 /f\n")).toBeUndefined();
    expect(aclListingFault("drwx------@ 2 u  staff  64 Nov 26 10:00 /f\n")).toBeUndefined();
  });

  it("rejects an ACL entry line", () => {
    const listing =
      "drwx------+ 2 u  staff  64 Nov 26 10:00 /f\n 0: group:everyone allow list,search\n";
    expect(aclListingFault(listing)).toMatch(/ACL/);
  });

  it("rejects an empty listing and a line that is not a folder", () => {
    expect(aclListingFault("")).toMatch(/no folder line/);
    expect(aclListingFault("-rw-------  1 u  staff  0 Nov 26 10:00 /f\n")).toMatch(
      /no folder line/,
    );
  });
});

describe("secretFileFault", () => {
  const stat = (kind: EntryKind, uid: number, mode: number): EntryStat => ({
    kind,
    uid,
    mode,
    dev: 1n,
    ino: 1n,
  });

  it("accepts a regular file of the user with mode 0600", () => {
    expect(secretFileFault(stat("file", USER, 0o600), USER)).toBeUndefined();
  });

  it.each([
    ["mode 0644", stat("file", USER, 0o644), /0644/],
    ["mode 0400", stat("file", USER, 0o400), /0400/],
    ["the setuid bit", stat("file", USER, 0o4600), /4600/],
    ["another owner", stat("file", OTHER, 0o600), /uid 1234/],
    ["a FIFO", stat("fifo", USER, 0o600), /not a regular file/],
    ["a link", stat("link", USER, 0o600), /not a regular file/],
  ])("rejects %s", (_name, entry, reason) => {
    expect(secretFileFault(entry, USER)).toMatch(reason);
  });
});

// --- Registry folder choice (E4) ---------------------------------------------

describe("registryFolderFor", () => {
  const facts = {
    platform: "linux" as NodeJS.Platform,
    override: undefined,
    uid: 1000,
    darwinTempDir: undefined,
    localAppData: undefined,
  };
  const ok = (result: FolderChoice): string => {
    if (Result.isFailure(result)) throw new Error(result.failure.reason);
    return result.success;
  };
  const reason = (result: FolderChoice): string => {
    if (Result.isSuccess(result)) throw new Error(`expected a failure, got ${result.success}`);
    return result.failure.reason;
  };

  it("uses /tmp/docks-kit-talk-<uid> on Linux", () => {
    expect(ok(registryFolderFor(facts))).toBe("/tmp/docks-kit-talk-1000");
  });

  it("uses docks-kit-talk in the DARWIN_USER_TEMP_DIR folder on macOS", () => {
    expect(
      ok(
        registryFolderFor({
          ...facts,
          platform: "darwin",
          darwinTempDir: "/var/folders/ab/cd/T/\n",
        }),
      ),
    ).toBe("/var/folders/ab/cd/T/docks-kit-talk");
    expect(
      reason(registryFolderFor({ ...facts, platform: "darwin", darwinTempDir: "relative/T" })),
    ).toMatch(/absolute/);
  });

  it("uses %LOCALAPPDATA%\\docks-kit\\talk on Windows", () => {
    expect(
      ok(
        registryFolderFor({
          ...facts,
          platform: "win32",
          uid: undefined,
          localAppData: "C:\\Users\\u\\AppData\\Local",
        }),
      ),
    ).toBe("C:\\Users\\u\\AppData\\Local\\docks-kit\\talk");
    expect(reason(registryFolderFor({ ...facts, platform: "win32", uid: undefined }))).toMatch(
      /LOCALAPPDATA/,
    );
  });

  it("takes an absolute override and rejects a relative one", () => {
    expect(ok(registryFolderFor({ ...facts, override: "/tmp/t/../talk" }))).toBe("/tmp/talk");
    expect(reason(registryFolderFor({ ...facts, override: "talk" }))).toMatch(/absolute/);
    expect(ok(registryFolderFor({ ...facts, override: "" }))).toBe("/tmp/docks-kit-talk-1000");
  });

  it("rejects an unsupported system and a Linux process without a uid", () => {
    expect(reason(registryFolderFor({ ...facts, platform: "freebsd" }))).toMatch(/freebsd/);
    expect(reason(registryFolderFor({ ...facts, uid: undefined }))).toMatch(/user id/);
  });

  it("names powershell.exe in the Windows system folder", () => {
    const path = windowsPowerShellPath("C:\\Windows");
    expect(Result.isSuccess(path) && path.success).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(Result.isFailure(windowsPowerShellPath(undefined))).toBe(true);
    expect(Result.isFailure(windowsPowerShellPath("Windows"))).toBe(true);
  });

  it("resolves the override from the environment", async () => {
    const env = { [TALK_DIR_OVERRIDE]: WINDOWS ? "C:\\t\\talk" : "/tmp/t/talk" };
    expect(await Effect.runPromise(resolveRegistryFolder(env))).toBe(env[TALK_DIR_OVERRIDE]);
  });

  it.skipIf(process.platform !== "linux")("resolves the Linux default", async () => {
    expect(await Effect.runPromise(resolveRegistryFolder({}))).toBe(
      `/tmp/docks-kit-talk-${process.getuid?.()}`,
    );
  });

  it.skipIf(!DARWIN)("resolves the macOS default through getconf", async () => {
    const temp = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
    expect(await Effect.runPromise(resolveRegistryFolder({}))).toBe(
      join(temp.stdout.trim(), "docks-kit-talk"),
    );
  });
});

// --- Real POSIX rules (Linux and macOS) ---------------------------------------

const mode = (path: string): number => lstatSync(path).mode & 0o7777;

const run = <A, E>(effect: Effect.Effect<A, E, TalkPosixSystem>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TalkPosixSystem.layer));

const fail = <A, E>(effect: Effect.Effect<A, E, TalkPosixSystem>): Promise<E> =>
  Effect.runPromise(Effect.provide(Effect.flip(effect), TalkPosixSystem.layer));

const withUmask = async <A>(mask: number, body: () => Promise<A>): Promise<A> => {
  const previous = process.umask(mask);
  try {
    return await body();
  } finally {
    process.umask(previous);
  }
};

describe.skipIf(!POSIX)("POSIX registry folder (real)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "talk-trust-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it.each([0o022, 0o277, 0o000])(
    "creates the folder with mode 0700 under umask %o",
    async (mask) => {
      const registry = join(base, "reg");
      const resolved = await withUmask(mask, () => run(ensureRegistryFolder(registry)));
      expect(resolved).toBe(join(realpathSync(base), "reg"));
      expect(mode(registry)).toBe(0o700);
      expect(await run(checkRegistryFolder(registry))).toBe(resolved);
    },
  );

  it("reports a missing folder on a check", async () => {
    const error = await fail(checkRegistryFolder(join(base, "reg")));
    expect(error).toBeInstanceOf(TalkFolderMissingError);
  });

  it("rejects an existing folder of mode 0750 and leaves it unchanged", async () => {
    const registry = join(base, "reg");
    mkdirSync(registry);
    chmodSync(registry, 0o750);
    const error = await fail(ensureRegistryFolder(registry));
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({
      path: expect.stringMatching(/reg$/),
      reason: expect.stringMatching(/0750/),
    });
    expect(mode(registry)).toBe(0o750);
  });

  it("rejects a registry folder that is a symbolic link", async () => {
    const real = join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(base, "reg"));
    const error = await fail(checkRegistryFolder(join(base, "reg")));
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ reason: expect.stringMatching(/symbolic link/) });
  });

  it("follows a symbolic link above the folder", async () => {
    mkdirSync(join(base, "real"), { mode: 0o700 });
    symlinkSync("real", join(base, "link"));
    const resolved = await run(ensureRegistryFolder(join(base, "link", "reg")));
    expect(resolved).toBe(join(realpathSync(base), "real", "reg"));
  });

  it("rejects a link loop above the folder", async () => {
    symlinkSync(join(base, "b"), join(base, "a"));
    symlinkSync(join(base, "a"), join(base, "b"));
    const error = await fail(ensureRegistryFolder(join(base, "a", "reg")));
    expect(error).toMatchObject({ reason: expect.stringMatching(/40 symbolic links/) });
  });

  it("rejects a writable ancestor without the sticky bit and accepts a sticky one", async () => {
    const open = join(base, "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    const error = await fail(ensureRegistryFolder(join(open, "reg")));
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ path: expect.stringMatching(/open$/) });
    expect(existsSync(join(open, "reg"))).toBe(false);
    chmodSync(open, 0o1777);
    await run(ensureRegistryFolder(join(open, "reg")));
    expect(mode(join(open, "reg"))).toBe(0o700);
  });

  const failingSetMode = (inside: boolean) =>
    Layer.effect(
      TalkPosixSystem,
      Effect.gen(function* () {
        const live = yield* TalkPosixSystem;
        return TalkPosixSystem.of({
          ...live,
          setMode: (path: string) =>
            Effect.sync(() => {
              if (inside) writeFileSync(join(path, "keep"), "x");
              chmodSync(path, 0o755);
            }),
        });
      }),
    ).pipe(Layer.provide(TalkPosixSystem.layer));

  it("removes the folder that a failed creation made while it is empty", async () => {
    const registry = join(base, "reg");
    const error = await Effect.runPromise(
      Effect.provide(Effect.flip(ensureRegistryFolder(registry)), failingSetMode(false)),
    );
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ reason: expect.stringMatching(/0755/) });
    expect(existsSync(registry)).toBe(false);
  });

  it("keeps the folder that a failed creation made when it is not empty", async () => {
    const registry = join(base, "reg");
    const error = await Effect.runPromise(
      Effect.provide(Effect.flip(ensureRegistryFolder(registry)), failingSetMode(true)),
    );
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(readdirSync(registry)).toEqual(["keep"]);
  });
});

describe.skipIf(!POSIX)("POSIX secret files (real)", () => {
  let base = "";
  let registry = "";

  beforeEach(async () => {
    base = mkdtempSync(join(tmpdir(), "talk-secret-"));
    registry = join(base, "reg");
    await run(ensureRegistryFolder(registry));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const bytes = new TextEncoder().encode('{"secret":"s"}');

  it.each([0o022, 0o277, 0o000])(
    "publishes a file of mode exactly 0600 under umask %o and keeps a read-write descriptor",
    async (mask) => {
      const path = join(registry, "a-b.entry");
      const temporaryPath = join(registry, ".0123456789abcdef.tmp");
      const published = await withUmask(mask, () =>
        run(publishSecretFile({ path, temporaryPath, bytes })),
      );
      try {
        expect(published.path).toBe(path);
        expect(mode(path)).toBe(0o600);
        expect(readFileSync(path)).toEqual(Buffer.from(bytes));
        expect(existsSync(temporaryPath)).toBe(false);
        const held = fstatSync(published.fd);
        expect(held.ino).toBe(lstatSync(path).ino);
        // The kept descriptor is read-write.
        expect(writeSync(published.fd, "!", bytes.byteLength)).toBe(1);
      } finally {
        closeSync(published.fd);
      }
    },
  );

  it("replaces a file at the name", async () => {
    const path = join(registry, "a-b.entry");
    writeFileSync(path, "old", { mode: 0o600 });
    const published = await run(
      publishSecretFile({ path, temporaryPath: join(registry, ".1.tmp"), bytes }),
    );
    closeSync(published.fd);
    expect(readFileSync(path, "utf8")).toBe('{"secret":"s"}');
  });

  it("fails without touching an object at the temporary name", async () => {
    const path = join(registry, "a-b.entry");
    const temporaryPath = join(registry, ".2.tmp");
    symlinkSync(join(base, "elsewhere"), temporaryPath);
    const error = await fail(publishSecretFile({ path, temporaryPath, bytes }));
    expect(error).toBeInstanceOf(TalkFileError);
    expect(error).toMatchObject({ path: temporaryPath });
    expect(lstatSync(temporaryPath).isSymbolicLink()).toBe(true);
    expect(existsSync(join(base, "elsewhere"))).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  it("refuses to publish into an untrusted folder", async () => {
    chmodSync(registry, 0o755);
    const error = await fail(
      publishSecretFile({
        path: join(registry, "a.entry"),
        temporaryPath: join(registry, ".3.tmp"),
        bytes,
      }),
    );
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(readdirSync(registry)).toEqual([]);
  });

  it("reads a 0600 file of the user", async () => {
    const path = join(registry, "a.entry");
    writeFileSync(path, bytes, { mode: 0o600 });
    const read = await run(readSecretFile(path));
    expect(Option.isSome(read) && Buffer.from(read.value)).toEqual(Buffer.from(bytes));
  });

  it("rejects a file whose mode is not exactly 0600", async () => {
    const path = join(registry, "a.entry");
    writeFileSync(path, bytes);
    chmodSync(path, 0o640);
    const error = await fail(readSecretFile(path));
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ path, reason: expect.stringMatching(/0640/) });
  });

  it("skips a missing name, a link, and a FIFO without opening them", async () => {
    const target = join(registry, "real.entry");
    writeFileSync(target, bytes, { mode: 0o600 });
    symlinkSync(target, join(registry, "link.entry"));
    const fifo = join(registry, "fifo.entry");
    const made = spawnSync("mkfifo", ["-m", "600", fifo]);
    expect(made.status).toBe(0);
    // A blocking open of a FIFO without a writer never returns, so the test would time out.
    expect(Option.isNone(await run(readSecretFile(fifo)))).toBe(true);
    expect(Option.isNone(await run(readSecretFile(join(registry, "link.entry"))))).toBe(true);
    expect(Option.isNone(await run(readSecretFile(join(registry, "gone.entry"))))).toBe(true);
  });

  it("refuses to read from an untrusted folder", async () => {
    const path = join(registry, "a.entry");
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(registry, 0o750);
    const error = await fail(readSecretFile(path));
    expect(error).toBeInstanceOf(TalkTrustError);
    // The error names the checked component; on macOS the temporary root lies behind the /var link.
    expect(error).toMatchObject({ path: join(realpathSync(base), "reg") });
  });
});

describe.skipIf(!DARWIN)("macOS ACL entries (real)", () => {
  let base = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "talk-acl-"));
  });

  afterEach(() => {
    spawnSync("/bin/chmod", ["-R", "-N", base]);
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects a registry folder with an ACL entry", async () => {
    const registry = join(base, "reg");
    await run(ensureRegistryFolder(registry));
    expect(spawnSync("/bin/chmod", ["+a", "everyone allow list", registry]).status).toBe(0);
    const error = await fail(checkRegistryFolder(registry));
    expect(error).toBeInstanceOf(TalkTrustError);
    expect(error).toMatchObject({ reason: expect.stringMatching(/ACL/) });
  });

  it("clears the entries that a new folder inherits from its parent", async () => {
    const parent = join(base, "parent");
    mkdirSync(parent, { mode: 0o700 });
    const inherit = "everyone allow list,add_file,file_inherit,directory_inherit";
    expect(spawnSync("/bin/chmod", ["+a", inherit, parent]).status).toBe(0);
    const registry = join(parent, "reg");
    await run(ensureRegistryFolder(registry));
    const listing = spawnSync("/bin/ls", ["-led", registry], { encoding: "utf8" });
    expect(aclListingFault(listing.stdout)).toBeUndefined();
  });
});

// --- Windows DPAPI seal (E5 Windows) ------------------------------------------

describe("DPAPI batch protocol", () => {
  it("encodes a count line and one base64 line per item", () => {
    const input = encodeDpapiInput([new Uint8Array([1, 2, 3]), new TextEncoder().encode("hi")]);
    expect(input).toBe("2\nAQID\naGk=\n");
  });

  it("parses one result line per item, with `-` for a failed item", () => {
    const parsed = parseDpapiOutput("+AQID\r\n-\r\n", 2);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isFailure(parsed)) return;
    expect(parsed.success.map((item) => (item === undefined ? undefined : [...item]))).toEqual([
      [1, 2, 3],
      undefined,
    ]);
  });

  it("rejects output with another count or an unknown line", () => {
    expect(Result.isFailure(parseDpapiOutput("+AQID\n", 2))).toBe(true);
    expect(Result.isFailure(parseDpapiOutput("AQID\n", 1))).toBe(true);
  });

  it("uses the docks-kit-talk/v1 entropy", () => {
    expect(DPAPI_ENTROPY).toBe("docks-kit-talk/v1");
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

interface Ids {
  readonly instanceId: string;
  readonly sessionKey: string;
}

/** The caller's id check: the decoded ids must give the expected file name. */
const expectIds = (expected: Ids) => (json: string) =>
  Effect.try({
    try: () => JSON.parse(json) as Ids,
    catch: () => "not JSON",
  }).pipe(
    Effect.filterOrFail(
      (ids) => ids.instanceId === expected.instanceId && ids.sessionKey === expected.sessionKey,
      () => "foreign ids",
    ),
  );

describe("sealEntries and unsealEntries", () => {
  const entry = JSON.stringify({ instanceId: "aaaa", sessionKey: "bbbb" });
  const ids: Ids = { instanceId: "aaaa", sessionKey: "bbbb" };

  it("seals and unseals a batch through the DPAPI service", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = yield* sealEntries([entry, entry]);
        return yield* unsealEntries(blobs, expectIds(ids));
      }).pipe(Effect.provide(fakeDpapi)),
    );
    expect(results.map((result) => Result.isSuccess(result) && result.success)).toEqual([ids, ids]);
  });

  it("rejects a blob that DPAPI refuses, a value that is not UTF-8, and foreign ids", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const [good] = yield* sealEntries([entry]);
        const notUtf8 = new Uint8Array([0xff, 0xfe, 7]);
        const tampered = new Uint8Array([1, 2, 3]);
        return yield* unsealEntries(
          [good!, tampered, notUtf8],
          expectIds({ ...ids, sessionKey: "cccc" }),
        );
      }).pipe(Effect.provide(fakeDpapi)),
    );
    expect(results.map((result) => (Result.isFailure(result) ? result.failure : "ok"))).toEqual([
      "foreign ids",
      expect.any(TalkUnsealRejected),
      expect.any(TalkUnsealRejected),
    ]);
  });

  it("starts no process for an empty batch", async () => {
    expect(await Effect.runPromise(sealEntries([]).pipe(Effect.provide(TalkDpapi.layer)))).toEqual(
      [],
    );
  });

  it.skipIf(WINDOWS)("fails off Windows with a named reason", async () => {
    const error = await Effect.runPromise(
      sealEntries([entry]).pipe(Effect.flip, Effect.provide(TalkDpapi.layer)),
    );
    expect(error).toBeInstanceOf(TalkSealError);
    expect(error.reason).toMatch(/Windows/);
  });
});

describe.skipIf(!WINDOWS)("Windows DPAPI (real)", () => {
  const entry = JSON.stringify({ instanceId: "aaaa", sessionKey: "bbbb", secret: "s" });
  const ids: Ids = { instanceId: "aaaa", sessionKey: "bbbb" };
  const live = <A, E>(effect: Effect.Effect<A, E, TalkDpapi>): Promise<A> =>
    Effect.runPromise(Effect.provide(effect, TalkDpapi.layer));

  it("seals and unseals entries in one batch", async () => {
    const blobs = await live(sealEntries([entry, entry]));
    expect(blobs).toHaveLength(2);
    expect(Buffer.from(blobs[0]!).includes("aaaa")).toBe(false);
    const opened = await live(unsealEntries(blobs, expectIds(ids)));
    expect(opened.map((result) => Result.isSuccess(result) && result.success)).toEqual([ids, ids]);
  });

  it("rejects a tampered blob and foreign ids", async () => {
    const [blob] = await live(sealEntries([entry]));
    const tampered = new Uint8Array(blob!);
    tampered[tampered.length - 8] = (tampered[tampered.length - 8]! + 1) % 256;
    const opened = await live(unsealEntries([tampered], expectIds(ids)));
    expect(Result.isFailure(opened[0]!)).toBe(true);
    const foreign = await live(unsealEntries([blob!], expectIds({ ...ids, instanceId: "cccc" })));
    expect(Result.isFailure(foreign[0]!) && foreign[0].failure).toBe("foreign ids");
  });
});
