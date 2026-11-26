/**
 * POSIX trust and creation rules of the registry folder and its secret files
 * (#249 E5). The rule evaluation is pure: it reads stat records through a
 * `PathView`. `TalkPosixSystem` holds the system calls. Each operation runs the
 * checks again and keeps no result.
 */
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { posix } from "node:path";
import { Clock, Context, Effect, Layer, Option, Predicate, Schema } from "effect";

import { DARWIN_CHMOD, DARWIN_LS, runTool } from "./folder";

/** The most symbolic links that the walk follows on one path; Linux path lookup has the same limit. */
export const MAX_LINK_HOPS = 40;

const STICKY = 0o1000;
const GROUP_OR_OTHER_WRITE = 0o022;
const PERMISSION_BITS = 0o7777;
const FOLDER_MODE = 0o700;
const SECRET_FILE_MODE = 0o600;
const ROOT_UID = 0;
const ROOT_FOLDER = "/";

/** A check failed. `path` names the object at fault. */
export class TalkTrustError extends Schema.TaggedError<
  TalkTrustError,
  { readonly brand: unique symbol }
>()("TalkTrustError", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** The registry folder does not exist; its ancestors passed the checks. */
export class TalkFolderMissingError extends Schema.TaggedError<
  TalkFolderMissingError,
  { readonly brand: unique symbol }
>()("TalkFolderMissingError", {
  path: Schema.String,
}) {}

/** A file system call failed. `code` is the Node error code, such as `EEXIST`. */
export class TalkFileError extends Schema.TaggedError<
  TalkFileError,
  { readonly brand: unique symbol }
>()("TalkFileError", {
  path: Schema.String,
  reason: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

export type EntryKind = "folder" | "file" | "link" | "socket" | "fifo" | "other";

/** The part of an `lstat` or `fstat` result that the rules read. */
export interface EntryStat {
  readonly kind: EntryKind;
  readonly uid: number;
  /** The permission bits with the setuid, setgid, and sticky bits (`st_mode & 07777`). */
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

export type LstatOutcome =
  | { readonly _tag: "Found"; readonly stat: EntryStat }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failed"; readonly reason: string };

export type ReadlinkOutcome =
  | { readonly _tag: "Target"; readonly target: string }
  | { readonly _tag: "Failed"; readonly reason: string };

/** The reads of the walk; tests give a synthetic view. */
export interface PathView {
  readonly lstat: (path: string) => LstatOutcome;
  readonly readlink: (path: string) => ReadlinkOutcome;
}

export type FolderVerdict =
  | { readonly _tag: "Trusted"; readonly resolved: string }
  | { readonly _tag: "Missing"; readonly path: string }
  | { readonly _tag: "Untrusted"; readonly path: string; readonly reason: string };

const KIND_NAMES: Readonly<Record<EntryKind, string>> = {
  folder: "folder",
  file: "regular file",
  link: "symbolic link",
  socket: "socket",
  fifo: "FIFO",
  other: "special file",
};

const formatMode = (mode: number): string => (mode & PERMISSION_BITS).toString(8).padStart(4, "0");

const untrusted = (path: string, reason: string): FolderVerdict => ({
  _tag: "Untrusted",
  path,
  reason,
});

/** The user and root may own an ancestor or a link above the registry folder. */
const isTrustedOwner = (uid: number, user: number): boolean => uid === user || uid === ROOT_UID;

const childPath = (parent: string, name: string): string =>
  parent === ROOT_FOLDER ? `${ROOT_FOLDER}${name}` : `${parent}/${name}`;

/** The path names without empty and `.` names; `..` stays, because it acts on the real parent. */
const pathNames = (path: string): Array<string> =>
  path.split("/").filter((name) => name !== "" && name !== ".");

/**
 * The F5 rule for a folder on the path: group and others must not write it,
 * unless it is sticky. In a sticky folder POSIX lets only an entry's owner, the
 * folder owner, or root rename the entry; F5 also wants the next entry owned by
 * the user or root, and the owner rules of each entry (`ancestorFault`,
 * `registryFault`) check that before this rule.
 */
function writableFolderFault(folder: EntryStat): string | undefined {
  if ((folder.mode & GROUP_OR_OTHER_WRITE) === 0 || (folder.mode & STICKY) !== 0) return undefined;
  return `group or others can write the folder (mode ${formatMode(folder.mode)}) and it has no sticky bit`;
}

/** An entry above the registry folder is a real folder or a symbolic link of the user or root. */
function ancestorFault(stat: EntryStat, user: number): string | undefined {
  if (stat.kind !== "folder" && stat.kind !== "link")
    return `it is a ${KIND_NAMES[stat.kind]}, not a folder`;
  if (isTrustedOwner(stat.uid, user)) return undefined;
  return `the ${KIND_NAMES[stat.kind]} is owned by uid ${stat.uid}, not by the user or root`;
}

function registryFault(stat: EntryStat, user: number): string | undefined {
  if (stat.kind === "link") return "the registry folder is a symbolic link";
  if (stat.kind !== "folder") return `it is a ${KIND_NAMES[stat.kind]}, not a folder`;
  if (stat.uid !== user)
    return `the folder is owned by uid ${stat.uid}, not by the user (uid ${user})`;
  if ((stat.mode & PERMISSION_BITS) !== FOLDER_MODE) {
    return `the folder has mode ${formatMode(stat.mode)}, not 0700`;
  }
  return undefined;
}

interface Visited {
  readonly path: string;
  readonly stat: EntryStat;
}

/**
 * Walks `folder` from the root down with `lstat` and applies the E5 rules:
 * each ancestor is a real folder of the user or root that passes the F5
 * writability rule; a symbolic link above the registry folder belongs to the
 * user or root, and the walk checks each component of its target, up to
 * `MAX_LINK_HOPS` links; the registry folder is a real folder of the user with
 * mode 0700. A missing registry folder below trusted ancestors gives `Missing`.
 */
export function evaluateRegistryFolder(
  folder: string,
  user: number,
  view: PathView,
): FolderVerdict {
  if (!posix.isAbsolute(folder)) return untrusted(folder, "the path is not absolute");
  const queue = pathNames(folder);
  if (queue.length === 0)
    return untrusted(ROOT_FOLDER, "the registry folder cannot be the root folder");
  const root = view.lstat(ROOT_FOLDER);
  if (root._tag === "Failed") return untrusted(ROOT_FOLDER, `lstat failed: ${root.reason}`);
  if (root._tag === "Missing" || root.stat.kind !== "folder") {
    return untrusted(ROOT_FOLDER, "the root is not a folder");
  }
  if (!isTrustedOwner(root.stat.uid, user)) {
    return untrusted(
      ROOT_FOLDER,
      `the folder is owned by uid ${root.stat.uid}, not by the user or root`,
    );
  }
  const chain: Array<Visited> = [{ path: ROOT_FOLDER, stat: root.stat }];
  let hops = 0;
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (name === "..") {
      if (chain.length > 1) chain.pop();
      continue;
    }
    const parent = chain[chain.length - 1]!;
    const path = childPath(parent.path, name);
    const final = queue.length === 0;
    const entry = view.lstat(path);
    if (entry._tag === "Failed") return untrusted(path, `lstat failed: ${entry.reason}`);
    if (entry._tag === "Missing") {
      if (!final) return untrusted(path, "the folder does not exist");
      const parentFault = writableFolderFault(parent.stat);
      return parentFault === undefined
        ? { _tag: "Missing", path }
        : untrusted(parent.path, parentFault);
    }
    const { stat } = entry;
    const ownFault = final ? registryFault(stat, user) : ancestorFault(stat, user);
    if (ownFault !== undefined) return untrusted(path, ownFault);
    const parentFault = writableFolderFault(parent.stat);
    if (parentFault !== undefined) return untrusted(parent.path, parentFault);
    if (final) return { _tag: "Trusted", resolved: path };
    if (stat.kind === "folder") {
      chain.push({ path, stat });
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS)
      return untrusted(path, `the path has more than ${MAX_LINK_HOPS} symbolic links`);
    const link = view.readlink(path);
    if (link._tag === "Failed") return untrusted(path, `readlink failed: ${link.reason}`);
    if (link.target === "") return untrusted(path, "the symbolic link is empty");
    if (posix.isAbsolute(link.target)) chain.splice(1);
    queue.unshift(...pathNames(link.target));
  }
  // The last name of an absolute path is never `..` after `pathNames`, so the loop returns.
  return untrusted(folder, "the path names no folder");
}

const ACL_ENTRY_LINE = /^\s*\d+: /;

/**
 * Reads the output of macOS `ls -led <folder>`: it must print the folder line
 * and no ACL entry line (`<n>: ...`), whatever marker follows the mode (F8).
 */
export function aclListingFault(listing: string): string | undefined {
  const lines = listing.split(/\r?\n/).filter((line) => line !== "");
  if (lines[0]?.startsWith("d") !== true) return "ls -led printed no folder line";
  const entry = lines.find((line) => ACL_ENTRY_LINE.test(line));
  return entry === undefined ? undefined : `the folder has an ACL entry: ${entry.trim()}`;
}

/** A secret file is a regular file of the user with mode exactly 0600. */
export function secretFileFault(stat: EntryStat, user: number): string | undefined {
  if (stat.kind !== "file") return `it is a ${KIND_NAMES[stat.kind]}, not a regular file`;
  if (stat.uid !== user)
    return `the file is owned by uid ${stat.uid}, not by the user (uid ${user})`;
  if ((stat.mode & PERMISSION_BITS) !== SECRET_FILE_MODE) {
    return `the file has mode ${formatMode(stat.mode)}, not 0600`;
  }
  return undefined;
}

/** True when both records describe one file. */
export const isSameFile = (left: EntryStat, right: EntryStat): boolean =>
  left.dev === right.dev && left.ino === right.ino;

// --- System calls --------------------------------------------------------------

function entryKind(stats: BigIntStats): EntryKind {
  if (stats.isDirectory()) return "folder";
  if (stats.isFile()) return "file";
  if (stats.isSymbolicLink()) return "link";
  if (stats.isSocket()) return "socket";
  if (stats.isFIFO()) return "fifo";
  return "other";
}

const entryStat = (stats: BigIntStats): EntryStat => ({
  kind: entryKind(stats),
  uid: Number(stats.uid),
  mode: Number(stats.mode) & PERMISSION_BITS,
  dev: stats.dev,
  ino: stats.ino,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string | undefined => {
  const code = Predicate.hasProperty(error, "code") ? error.code : undefined;
  return Predicate.isString(code) ? code : undefined;
};

const fileError = (path: string, operation: string, error: unknown): TalkFileError =>
  new TalkFileError({
    path,
    reason: `${operation} failed: ${errorMessage(error)}`,
    code: errorCode(error),
  });

/** Runs one synchronous file system call; a throw becomes `TalkFileError` with the Node error code. */
export const fileCall = <A>(
  path: string,
  operation: string,
  call: () => A,
): Effect.Effect<A, TalkFileError> =>
  Effect.try({ try: call, catch: (error) => fileError(path, operation, error) });

/** The live `lstat` and `readlink` reads. */
export const liveView: PathView = {
  lstat: (path) => {
    try {
      const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      return stats === undefined ? { _tag: "Missing" } : { _tag: "Found", stat: entryStat(stats) };
    } catch (error) {
      return { _tag: "Failed", reason: errorMessage(error) };
    }
  },
  readlink: (path) => {
    try {
      return { _tag: "Target", target: readlinkSync(path, "utf8") };
    } catch (error) {
      return { _tag: "Failed", reason: errorMessage(error) };
    }
  },
};

/** The system calls of the folder rules; tests replace single calls. */
export class TalkPosixSystem extends Context.Service<
  TalkPosixSystem,
  {
    readonly user: number;
    readonly platform: NodeJS.Platform;
    readonly view: PathView;
    /** `mkdir` with mode 0700; false when a folder or another object is already at the path. */
    readonly makeFolder: (path: string) => Effect.Effect<boolean, TalkFileError>;
    readonly setMode: (path: string, mode: number) => Effect.Effect<void, TalkFileError>;
    /** macOS `chmod -N`: removes every ACL entry. */
    readonly clearAcl: (path: string) => Effect.Effect<void, TalkFileError>;
    /** The output of macOS `ls -led`. */
    readonly aclListing: (path: string) => Effect.Effect<string, TalkTrustError>;
    /** `rmdir`, which removes only an empty folder; a failure leaves the folder. */
    readonly removeEmptyFolder: (path: string) => Effect.Effect<void>;
  }
>()("docks-kit/talk/TalkPosixSystem") {
  static readonly layer = Layer.effect(
    TalkPosixSystem,
    Effect.gen(function* () {
      const user = process.getuid?.();
      if (user === undefined) {
        return yield* new TalkTrustError({
          path: "",
          reason: "the POSIX trust rules need a POSIX system",
        });
      }
      const makeFolder = Effect.fn("TalkPosixSystem.makeFolder")(function* (path: string) {
        return yield* Effect.try({
          try: () => {
            mkdirSync(path, { mode: FOLDER_MODE });
            return true;
          },
          catch: (error) => fileError(path, "mkdir", error),
        }).pipe(
          Effect.catchTag("TalkFileError", (failure) =>
            failure.code === "EEXIST" ? Effect.succeed(false) : Effect.fail(failure),
          ),
        );
      });
      const setMode = Effect.fn("TalkPosixSystem.setMode")(function* (path: string, mode: number) {
        yield* fileCall(path, "chmod", () => chmodSync(path, mode));
      });
      const clearAcl = Effect.fn("TalkPosixSystem.clearAcl")(function* (path: string) {
        const result = yield* runTool(DARWIN_CHMOD, ["-N", path]).pipe(
          Effect.mapError((error) => new TalkFileError({ path, reason: error.reason })),
        );
        if (result.status !== 0) {
          return yield* new TalkFileError({
            path,
            reason: `chmod -N failed: ${result.stderr.trim()}`,
          });
        }
      });
      const aclListing = Effect.fn("TalkPosixSystem.aclListing")(function* (path: string) {
        const result = yield* runTool(DARWIN_LS, ["-led", path]).pipe(
          Effect.mapError((error) => new TalkTrustError({ path, reason: error.reason })),
        );
        if (result.status !== 0) {
          return yield* new TalkTrustError({
            path,
            reason: `ls -led failed: ${result.stderr.trim()}`,
          });
        }
        return result.stdout;
      });
      const removeEmptyFolder = (path: string): Effect.Effect<void> =>
        Effect.sync(() => {
          try {
            rmdirSync(path);
          } catch {
            // A folder that is not empty, or that went away, stays as it is.
          }
        });
      return TalkPosixSystem.of({
        user,
        platform: process.platform,
        view: liveView,
        makeFolder,
        setMode,
        clearAcl,
        aclListing,
        removeEmptyFolder,
      });
    }),
  );
}

// --- Folder operations ---------------------------------------------------------

/**
 * Checks the registry folder by the E5 rules, and on macOS its ACL listing.
 * Returns the resolved path of the folder.
 */
export const checkRegistryFolder = Effect.fn("checkRegistryFolder")(function* (folder: string) {
  const system = yield* TalkPosixSystem;
  const verdict = evaluateRegistryFolder(folder, system.user, system.view);
  if (verdict._tag === "Missing") return yield* new TalkFolderMissingError({ path: verdict.path });
  if (verdict._tag === "Untrusted") {
    return yield* new TalkTrustError({ path: verdict.path, reason: verdict.reason });
  }
  if (system.platform === "darwin") {
    const fault = aclListingFault(yield* system.aclListing(folder));
    if (fault !== undefined) return yield* new TalkTrustError({ path: folder, reason: fault });
  }
  return verdict.resolved;
});

const checkCreatedFolder = (folder: string) =>
  checkRegistryFolder(folder).pipe(
    Effect.catchTag("TalkFolderMissingError", (missing) =>
      Effect.fail(
        new TalkTrustError({ path: missing.path, reason: "the folder went away during the check" }),
      ),
    ),
  );

/**
 * Checks the registry folder and creates it when it is missing: `mkdir` with
 * mode 0700, `chmod` 0700 (the umask cannot widen it), macOS `chmod -N`, then
 * the check. When a step fails, it removes the folder that it created, only
 * while that folder is empty, and stops. An existing folder stays unchanged.
 * Returns the resolved path of the folder.
 */
export const ensureRegistryFolder = Effect.fn("ensureRegistryFolder")(function* (folder: string) {
  const system = yield* TalkPosixSystem;
  const existing = yield* checkRegistryFolder(folder).pipe(
    Effect.asSome,
    Effect.catchTag("TalkFolderMissingError", () => Effect.succeed(Option.none<string>())),
  );
  if (Option.isSome(existing)) return existing.value;
  const created = yield* system.makeFolder(folder);
  if (!created) return yield* checkCreatedFolder(folder);
  return yield* Effect.gen(function* () {
    yield* system.setMode(folder, FOLDER_MODE);
    if (system.platform === "darwin") yield* system.clearAcl(folder);
    return yield* checkCreatedFolder(folder);
  }).pipe(Effect.tapError(() => system.removeEmptyFolder(folder)));
});

// --- Secret files --------------------------------------------------------------

/** A published secret file and the read-write descriptor that the publisher keeps. */
export interface SecretFile {
  readonly path: string;
  readonly fd: number;
}

export interface SecretFileWrite {
  /** The final name in the registry folder. */
  readonly path: string;
  /** A temporary name in the same folder. */
  readonly temporaryPath: string;
  readonly bytes: Uint8Array;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.byteLength;) {
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
  }
}

const discardTemporary = (fd: number, temporaryPath: string): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      closeSync(fd);
      unlinkSync(temporaryPath);
    } catch {
      // The error of the failed step tells the caller what went wrong.
    }
  });

/**
 * Publishes a secret file (E5 Secret files): after the folder check, an
 * exclusive `O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW` open of the temporary name
 * with mode 0600, `fchmod` 0600 (the umask can narrow the open mode), the
 * write, and a rename to the final name. Returns the kept read-write
 * descriptor; the caller closes it.
 */
export const publishSecretFile = Effect.fn("publishSecretFile")(function* (write: SecretFileWrite) {
  const { path, temporaryPath, bytes } = write;
  const folder = posix.dirname(path);
  if (posix.dirname(temporaryPath) !== folder) {
    return yield* new TalkFileError({
      path: temporaryPath,
      reason: "the temporary name is not in the folder of the final name",
    });
  }
  yield* checkRegistryFolder(folder);
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = yield* fileCall(temporaryPath, "open", () =>
    openSync(temporaryPath, flags, SECRET_FILE_MODE),
  );
  return yield* Effect.gen(function* () {
    yield* fileCall(temporaryPath, "fchmod", () => fchmodSync(fd, SECRET_FILE_MODE));
    yield* fileCall(temporaryPath, "write", () => writeAll(fd, bytes));
    yield* fileCall(path, "rename", () => renameSync(temporaryPath, path));
    const published: SecretFile = { path, fd };
    return published;
  }).pipe(Effect.tapError(() => discardTemporary(fd, temporaryPath)));
});

/**
 * Reads a secret file as a client (E5 Secret files): after the folder check,
 * `lstat` must show a regular file, else the name is skipped without an open,
 * so no device or FIFO open can block. The open uses `O_RDONLY | O_NOFOLLOW |
 * O_NONBLOCK`; `fstat` must show the same file, owned by the user, with mode
 * exactly 0600; the read uses that descriptor. Returns `None` for a skipped name.
 */
export const readSecretFile = Effect.fn("readSecretFile")(function* (path: string) {
  const system = yield* TalkPosixSystem;
  yield* checkRegistryFolder(posix.dirname(path));
  const named = system.view.lstat(path);
  if (named._tag === "Failed")
    return yield* new TalkFileError({ path, reason: `lstat failed: ${named.reason}` });
  if (named._tag === "Missing" || named.stat.kind !== "file") return Option.none<Uint8Array>();
  const expected = named.stat;
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = yield* Effect.try({
    try: () => openSync(path, flags),
    catch: (error) => fileError(path, "open", error),
  }).pipe(
    Effect.asSome,
    Effect.catchTag("TalkFileError", (failure) =>
      // ENOENT or ELOOP: the name went away or became a link after the `lstat`.
      failure.code === "ENOENT" || failure.code === "ELOOP"
        ? Effect.succeed(Option.none<number>())
        : Effect.fail(failure),
    ),
  );
  if (Option.isNone(opened)) return Option.none<Uint8Array>();
  return yield* Effect.acquireUseRelease(
    Effect.succeed(opened.value),
    (fd) =>
      Effect.gen(function* () {
        const held = yield* fileCall(path, "fstat", () =>
          entryStat(fstatSync(fd, { bigint: true })),
        );
        if (!isSameFile(held, expected)) {
          return yield* new TalkTrustError({
            path,
            reason: "another file replaced the name during the read",
          });
        }
        const fault = secretFileFault(held, system.user);
        if (fault !== undefined) return yield* new TalkTrustError({ path, reason: fault });
        const bytes: Uint8Array = yield* fileCall(path, "read", () => readFileSync(fd));
        return Option.some(bytes);
      }),
    (fd) => Effect.sync(() => closeSync(fd)),
  );
});

// --- Kept descriptors (E8 Lifetime) ---------------------------------------------

/** The state of a published secret file: still the file that the publisher wrote, or replaced. */
export type KeptFileState = "intact" | "replaced";

// Reads up to `limit` bytes from offset 0 of the descriptor.
function readFromStart(fd: number, limit: number): Uint8Array {
  const buffer = new Uint8Array(limit);
  let filled = 0;
  while (filled < limit) {
    const count = readSync(fd, buffer, filled, limit - filled, filled);
    if (count === 0) break;
    filled += count;
  }
  return buffer.subarray(0, filled);
}

/**
 * Checks a published secret file through the descriptor that the publisher
 * kept: `fstat` of the descriptor must show a regular file of the user with
 * mode exactly 0600 and the same file as `lstat` of the name; only then are
 * the bytes read through the descriptor compared with `bytes`. Any other state
 * counts as replaced. The caller checks the registry folder first.
 */
export const keptSecretFileState = Effect.fn("keptSecretFileState")(function* (
  file: SecretFile,
  bytes: Uint8Array,
) {
  const system = yield* TalkPosixSystem;
  const replaced: KeptFileState = "replaced";
  const held = yield* fileCall(file.path, "fstat", () =>
    entryStat(fstatSync(file.fd, { bigint: true })),
  );
  if (secretFileFault(held, system.user) !== undefined) return replaced;
  const named = system.view.lstat(file.path);
  if (named._tag === "Failed") {
    return yield* new TalkFileError({ path: file.path, reason: `lstat failed: ${named.reason}` });
  }
  if (named._tag === "Missing" || !isSameFile(named.stat, held)) return replaced;
  // One byte more than expected shows a longer file.
  const read = yield* fileCall(file.path, "read", () =>
    readFromStart(file.fd, bytes.byteLength + 1),
  );
  const same = Buffer.from(read).equals(Buffer.from(bytes));
  const state: KeptFileState = same ? "intact" : "replaced";
  return state;
});

/** Sets the access and modification times of a kept secret file to now, through its descriptor (`futimes`). */
export const refreshSecretFile = Effect.fn("refreshSecretFile")(function* (file: SecretFile) {
  const seconds = (yield* Clock.currentTimeMillis) / 1000;
  yield* fileCall(file.path, "futimes", () => futimesSync(file.fd, seconds, seconds));
});

/** Closes a kept descriptor. A descriptor that is already closed stays closed. */
export const closeSecretFile = (file: SecretFile): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      closeSync(file.fd);
    } catch {
      // The descriptor is closed already.
    }
  });
