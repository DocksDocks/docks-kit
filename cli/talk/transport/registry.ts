/**
 * Registry entries of the talk transport (#249 E5, #248 D2 Registry): the
 * entry Schema, the names that talk owns in the registry folder, and the
 * trusted publish, list, read, check, and remove operations. POSIX entries
 * are 0600 files that pass the trust rules of `trustPosix.ts`; Windows entries
 * hold only a DPAPI blob of the whole entry (`sealWindows.ts`).
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import { Context, Effect, Layer, Option, Predicate, Result, Schema } from "effect";

import {
  type Endpoint,
  type EndpointKind,
  Endpoint as EndpointSchema,
  SOCKET_NAME,
  endpointKindFor,
  randomNameHex,
} from "./endpoint";
import { InstanceId, PROTOCOL_VERSION, SessionId } from "./handshake";
import { TalkDpapi, type TalkSealError, sealEntries, unsealEntries } from "./sealWindows";
import {
  type KeptFileState,
  MAX_SECRET_FILE_BYTES,
  TalkFileError,
  type TalkFolderMissingError,
  TalkPosixSystem,
  type TalkTrustError,
  checkRegistryFolder,
  closeSecretFile,
  ensureRegistryFolder,
  fileCall,
  keptSecretFileState,
  liveView,
  publishSecretFile,
  readFromStart,
  readSecretFile,
  refreshSecretFile,
  sizeFault,
} from "./trustPosix";

// --- Names (E5 Names) ----------------------------------------------------------

/** Entry files: `<instance id>-<session key>.entry`. */
export const ENTRY_NAME = /^[0-9a-f]{16}-[0-9a-f]{16}\.entry$/;

/** Temporary files: `.<16 hex>.tmp`. */
export const TEMPORARY_NAME = /^\.[0-9a-f]{16}\.tmp$/;

const SESSION_KEY_LENGTH = 16;

/** The session key: the first 16 hex characters of the SHA-256 of the session id. */
export const sessionKey = (sessionId: string): string =>
  createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, SESSION_KEY_LENGTH);

/** The entry file name of a registration. */
export const entryFileName = (instanceId: string, sessionId: string): string =>
  `${instanceId}-${sessionKey(sessionId)}.entry`;

/** A fresh temporary file name. */
export const temporaryFileName = (): string => `.${randomNameHex()}.tmp`;

/** True for a name of the three talk patterns; talk touches no other name in the folder. */
export const isTalkName = (name: string): boolean =>
  ENTRY_NAME.test(name) || SOCKET_NAME.test(name) || TEMPORARY_NAME.test(name);

// --- Entry ---------------------------------------------------------------------

/** The registration secret: 32 random bytes as 64 lowercase hex characters. It is only an HMAC key. */
export const Secret = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

/** One registration in the registry. */
export const RegistryEntry = Schema.Struct({
  version: Schema.Literal(PROTOCOL_VERSION),
  instanceId: InstanceId,
  sessionId: SessionId,
  name: Schema.String,
  cwd: Schema.String,
  processId: Schema.Int.check(Schema.isGreaterThan(0)),
  endpoint: EndpointSchema,
  /** Milliseconds since the Unix epoch. */
  startTime: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  secret: Secret,
});
export type RegistryEntry = typeof RegistryEntry.Type;

const decodeEntryJson = Schema.decodeUnknownEffect(Schema.fromJsonString(RegistryEntry));

/** An entry file that does not hold a usable entry. */
export class TalkEntryRejected extends Schema.TaggedError<
  TalkEntryRejected,
  { readonly brand: unique symbol }
>()("TalkEntryRejected", {
  fileName: Schema.String,
  reason: Schema.String,
}) {}

/** The entry JSON, with a fixed field order. */
export const encodeEntry = (entry: RegistryEntry): string =>
  JSON.stringify({
    version: entry.version,
    instanceId: entry.instanceId,
    sessionId: entry.sessionId,
    name: entry.name,
    cwd: entry.cwd,
    processId: entry.processId,
    endpoint: entry.endpoint,
    startTime: entry.startTime,
    secret: entry.secret,
  });

const socketPathOk = (path: string, folder: string): boolean =>
  posix.isAbsolute(path) &&
  posix.normalize(path) === path &&
  posix.dirname(path) === folder &&
  SOCKET_NAME.test(posix.basename(path));

/**
 * The rules of a decoded entry: its ids give its file name, its endpoint is of
 * the kind of this system, and a socket path is a talk socket name directly in
 * the registry folder (E5 Names).
 */
export function entryFault(
  entry: RegistryEntry,
  fileName: string,
  folder: string,
  kind: EndpointKind,
): string | undefined {
  if (entryFileName(entry.instanceId, entry.sessionId) !== fileName) {
    return "the ids of the entry do not give its file name";
  }
  if (entry.endpoint.kind !== kind) {
    return `the entry has a ${entry.endpoint.kind} endpoint; this system uses ${kind}`;
  }
  if (entry.endpoint.kind === "unix" && !socketPathOk(entry.endpoint.path, folder)) {
    return `the socket path ${entry.endpoint.path} is not a talk socket name directly in the registry folder`;
  }
  return undefined;
}

/** Decodes entry JSON and applies `entryFault`. */
export const decodeEntry = Effect.fn("decodeEntry")(function* (
  text: string,
  fileName: string,
  folder: string,
  kind: EndpointKind,
) {
  const entry = yield* decodeEntryJson(text).pipe(
    Effect.mapError(
      (issue) => new TalkEntryRejected({ fileName, reason: `not a valid entry: ${issue.message}` }),
    ),
  );
  const fault = entryFault(entry, fileName, folder, kind);
  if (fault !== undefined) return yield* new TalkEntryRejected({ fileName, reason: fault });
  return entry;
});

// --- Registry service ----------------------------------------------------------

/** One line for a failure of the transport: its tag, its reason, and its path. */
export function describeFailure(error: unknown): string {
  const field = (name: string): string | undefined => {
    const value = Predicate.hasProperty(error, name) ? error[name] : undefined;
    return Predicate.isString(value) && value !== "" ? value : undefined;
  };
  const reason = field("reason") ?? field("message") ?? String(error);
  const path = field("path");
  const text = path === undefined || reason.includes(path) ? reason : `${reason} (${path})`;
  const tag = field("_tag");
  return tag === undefined ? text : `${tag}: ${text}`;
}

/** An entry that this process published. */
export interface PublishedEntry {
  readonly fileName: string;
  readonly path: string;
  /** The bytes at the name: the entry JSON on POSIX, the sealed blob on Windows. */
  readonly bytes: Uint8Array;
  /** POSIX: the read-write descriptor that the publisher keeps. */
  readonly fd: number | undefined;
}

export interface ListedEntry {
  readonly fileName: string;
  readonly entry: RegistryEntry;
}

/** An entry name whose file the listing could not use. */
export interface RejectedEntry {
  readonly fileName: string;
  readonly reason: string;
}

export interface Listing {
  readonly entries: ReadonlyArray<ListedEntry>;
  readonly rejected: ReadonlyArray<RejectedEntry>;
}

export type RegistryError = TalkTrustError | TalkFolderMissingError | TalkFileError | TalkSealError;

const EMPTY_LISTING: Listing = { entries: [], rejected: [] };
const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const notEntryName = (folder: string, fileName: string): TalkFileError =>
  new TalkFileError({ path: join(folder, fileName), reason: "not a talk entry name" });

const ignoreMissing = <E extends { readonly code?: string | undefined }>(
  effect: Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.catchIf(
    effect,
    (error) => error.code === "ENOENT",
    () => Effect.void,
  );

const entryNames = (folder: string) =>
  fileCall(folder, "readdir", () =>
    readdirSync(folder)
      .filter((name) => ENTRY_NAME.test(name))
      .sort(),
  );

/** `lstat` of a name; `undefined` when the name is missing. */
const lstatName = (path: string) =>
  fileCall(path, "lstat", () => lstatSync(path, { throwIfNoEntry: false }));

/**
 * Reads a file whose `lstat` showed `size` bytes. The buffer holds that size
 * plus one sentinel byte, within the hard limit. Gives `undefined` when the
 * name went away and `"changed"` when the file has another length now.
 */
export const readObserved = (path: string, size: number) =>
  fileCall(path, "read", () => {
    const fd = openSync(path, "r");
    try {
      return readFromStart(fd, Math.min(size, MAX_SECRET_FILE_BYTES) + 1);
    } finally {
      closeSync(fd);
    }
  }).pipe(
    Effect.map((bytes): Uint8Array | "changed" => (bytes.byteLength === size ? bytes : "changed")),
    Effect.catchIf(
      (error) => error.code === "ENOENT",
      () => Effect.undefined,
    ),
  );

/** The registry folder and its entries; one implementation per system. */
export class TalkRegistry extends Context.Service<
  TalkRegistry,
  {
    readonly folder: string;
    readonly endpointKind: EndpointKind;
    /** Checks the folder and creates it when it is missing (E5 Creation; Windows: `mkdir -p`). */
    readonly prepare: Effect.Effect<void, RegistryError>;
    /** True when the folder exists and passes its checks; false when it is missing. */
    readonly folderPresent: Effect.Effect<boolean, RegistryError>;
    readonly publish: (entry: RegistryEntry) => Effect.Effect<PublishedEntry, RegistryError>;
    /** Compares the name with what this process published (E8 Lifetime). */
    readonly check: (published: PublishedEntry) => Effect.Effect<KeptFileState, RegistryError>;
    /** POSIX: `futimes` on the kept descriptor. Windows: nothing. */
    readonly refresh: (published: PublishedEntry) => Effect.Effect<void, RegistryError>;
    /** Closes the kept descriptor. */
    readonly release: (published: PublishedEntry) => Effect.Effect<void>;
    /** Reads one entry by file name; `None` when no usable entry is there. */
    readonly read: (fileName: string) => Effect.Effect<Option.Option<RegistryEntry>, RegistryError>;
    /** Every usable entry, and the entry names that it rejected. A missing folder lists nothing. */
    readonly list: Effect.Effect<Listing, RegistryError>;
    /** Removes an entry file by name. A missing name is no failure. */
    readonly remove: (fileName: string) => Effect.Effect<void, RegistryError>;
    /** Removes a socket file that has a talk socket name directly in the folder; any other path stays. */
    readonly removeSocket: (endpoint: Endpoint) => Effect.Effect<void, RegistryError>;
  }
>()("docks-kit/talk/TalkRegistry") {
  /** POSIX: 0600 entry files under the E5 trust rules. */
  static readonly layerPosix = (folder: string) =>
    Layer.effect(TalkRegistry, makePosixRegistry(folder));

  /** Windows: DPAPI-sealed entry files in a folder that has no folder rules. */
  static readonly layerWindows = (folder: string, seams: WindowsSeams = {}) =>
    Layer.effect(TalkRegistry, makeWindowsRegistry(folder, seams));

  /** The implementation of this system, with its live dependencies. */
  static readonly layer = (folder: string): Layer.Layer<TalkRegistry, TalkTrustError> =>
    endpointKindFor(process.platform) === "tcp"
      ? TalkRegistry.layerWindows(folder).pipe(Layer.provide(TalkDpapi.layer))
      : TalkRegistry.layerPosix(folder).pipe(Layer.provide(TalkPosixSystem.layer));
}

const makePosixRegistry = Effect.fnUntraced(function* (folder: string) {
  const system = yield* TalkPosixSystem;
  const withSystem = <A, E>(effect: Effect.Effect<A, E, TalkPosixSystem>): Effect.Effect<A, E> =>
    Effect.provideService(effect, TalkPosixSystem, system);

  const folderPresent = withSystem(checkRegistryFolder(folder)).pipe(
    Effect.as(true),
    Effect.catchTag("TalkFolderMissingError", () => Effect.succeed(false)),
  );

  const decodeBytes = (fileName: string, bytes: Uint8Array) =>
    Effect.try({
      try: () => strictUtf8.decode(bytes),
      catch: () => new TalkEntryRejected({ fileName, reason: "the entry is not UTF-8" }),
    }).pipe(Effect.flatMap((text) => decodeEntry(text, fileName, folder, "unix")));

  // One entry through the client read path; `None` for a name that holds no regular file.
  const readOne = (fileName: string) =>
    withSystem(readSecretFile(join(folder, fileName))).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (bytes) => Effect.asSome(decodeBytes(fileName, bytes)),
        }),
      ),
    );

  const list = Effect.gen(function* () {
    if (!(yield* folderPresent)) return EMPTY_LISTING;
    const entries: Array<ListedEntry> = [];
    const rejected: Array<RejectedEntry> = [];
    for (const fileName of yield* entryNames(folder)) {
      const result = yield* Effect.result(readOne(fileName));
      if (Result.isFailure(result)) {
        const failure = result.failure;
        const reason =
          failure._tag === "TalkFolderMissingError"
            ? "the registry folder went away"
            : failure.reason;
        rejected.push({ fileName, reason });
      } else if (Option.isSome(result.success))
        entries.push({ fileName, entry: result.success.value });
    }
    const listing: Listing = { entries, rejected };
    return listing;
  });

  // `None` only for a lookup that completed without a usable entry: a missing name, no regular
  // file, or content that does not decode (also content above the size limit). A trust fault of
  // the entry file (owner, mode, a replaced name), a folder fault, and an I/O failure pass up.
  const read = Effect.fn("TalkRegistry.read")(function* (fileName: string) {
    if (!ENTRY_NAME.test(fileName) || !(yield* folderPresent)) return Option.none<RegistryEntry>();
    return yield* readOne(fileName).pipe(
      Effect.catchTags({
        TalkEntryRejected: () => Effect.succeedNone,
        TalkFileTooLarge: () => Effect.succeedNone,
        TalkFolderMissingError: () => Effect.succeedNone,
      }),
    );
  });

  const publish = Effect.fn("TalkRegistry.publish")(function* (entry: RegistryEntry) {
    const fileName = entryFileName(entry.instanceId, entry.sessionId);
    const bytes = utf8.encode(encodeEntry(entry));
    const file = yield* withSystem(
      publishSecretFile({
        path: join(folder, fileName),
        temporaryPath: join(folder, temporaryFileName()),
        bytes,
      }),
    );
    const published: PublishedEntry = { fileName, path: file.path, bytes, fd: file.fd };
    return published;
  });

  const check = Effect.fn("TalkRegistry.check")(function* (published: PublishedEntry) {
    yield* withSystem(checkRegistryFolder(folder));
    if (published.fd === undefined) return "replaced" satisfies KeptFileState;
    return yield* withSystem(
      keptSecretFileState({ path: published.path, fd: published.fd }, published.bytes),
    );
  });

  const refresh = Effect.fn("TalkRegistry.refresh")(function* (published: PublishedEntry) {
    if (published.fd === undefined) return;
    yield* refreshSecretFile({ path: published.path, fd: published.fd });
  });

  const release = (published: PublishedEntry): Effect.Effect<void> =>
    published.fd === undefined
      ? Effect.void
      : closeSecretFile({ path: published.path, fd: published.fd });

  const remove = Effect.fn("TalkRegistry.remove")(function* (fileName: string) {
    if (!ENTRY_NAME.test(fileName)) return yield* notEntryName(folder, fileName);
    if (!(yield* folderPresent)) return;
    const path = join(folder, fileName);
    yield* ignoreMissing(fileCall(path, "unlink", () => unlinkSync(path)));
  });

  const removeSocket = Effect.fn("TalkRegistry.removeSocket")(function* (endpoint: Endpoint) {
    if (endpoint.kind !== "unix" || !socketPathOk(endpoint.path, folder)) return;
    if (!(yield* folderPresent)) return;
    const named = liveView.lstat(endpoint.path);
    if (named._tag !== "Found" || named.stat.kind !== "socket") return;
    yield* ignoreMissing(fileCall(endpoint.path, "unlink", () => unlinkSync(endpoint.path)));
  });

  return TalkRegistry.of({
    folder,
    endpointKind: "unix",
    prepare: withSystem(ensureRegistryFolder(folder)).pipe(Effect.asVoid),
    folderPresent,
    publish,
    check,
    refresh,
    release,
    read,
    list,
    remove,
    removeSocket,
  });
});

/** Test seams of the Windows registry. */
export interface WindowsSeams {
  /** Writes the sealed blob to the temporary file; default `writeFileSync`. */
  readonly writeFile?: (fd: number, bytes: Uint8Array) => void;
}

const makeWindowsRegistry = Effect.fnUntraced(function* (folder: string, seams: WindowsSeams) {
  const writeFile =
    seams.writeFile ?? ((fd: number, bytes: Uint8Array) => writeFileSync(fd, bytes));
  const dpapi = yield* TalkDpapi;
  const withDpapi = <A, E>(effect: Effect.Effect<A, E, TalkDpapi>): Effect.Effect<A, E> =>
    Effect.provideService(effect, TalkDpapi, dpapi);

  const folderPresent = Effect.gen(function* () {
    const named = liveView.lstat(folder);
    if (named._tag === "Missing") return false;
    if (named._tag === "Failed") {
      return yield* new TalkFileError({ path: folder, reason: `lstat failed: ${named.reason}` });
    }
    if (named.stat.kind !== "folder") {
      return yield* new TalkFileError({
        path: folder,
        reason: "the registry path is not a folder",
      });
    }
    return true;
  });

  // The blob at a name; `None` for a name that holds no regular file. A file above the size limit is
  // rejected without a read.
  const readBlob = (fileName: string) =>
    Effect.gen(function* () {
      const path = join(folder, fileName);
      const stats = yield* lstatName(path);
      if (stats === undefined || !stats.isFile()) return Option.none<Uint8Array>();
      if (stats.size > MAX_SECRET_FILE_BYTES) {
        return yield* new TalkEntryRejected({ fileName, reason: sizeFault(stats.size) });
      }
      const bytes = yield* readObserved(path, stats.size);
      if (bytes === undefined) return Option.none<Uint8Array>();
      if (bytes === "changed") {
        return yield* new TalkEntryRejected({
          fileName,
          reason: "the file changed during the read",
        });
      }
      return Option.some(bytes);
    });

  const openAll = (fileNames: ReadonlyArray<string>, blobs: ReadonlyArray<Uint8Array>) =>
    withDpapi(
      unsealEntries(blobs, (text, index) =>
        decodeEntry(text, fileNames[index] ?? "", folder, "tcp"),
      ),
    );

  const list = Effect.gen(function* () {
    if (!(yield* folderPresent)) return EMPTY_LISTING;
    const rejected: Array<RejectedEntry> = [];
    const names: Array<string> = [];
    const blobs: Array<Uint8Array> = [];
    for (const fileName of yield* entryNames(folder)) {
      const blob = yield* Effect.result(readBlob(fileName));
      if (Result.isFailure(blob)) rejected.push({ fileName, reason: blob.failure.reason });
      else if (Option.isSome(blob.success)) {
        names.push(fileName);
        blobs.push(blob.success.value);
      }
    }
    // One DPAPI batch unseals every entry before any field is used.
    const opened = yield* openAll(names, blobs);
    const entries: Array<ListedEntry> = [];
    opened.forEach((result, index) => {
      const fileName = names[index] ?? "";
      if (Result.isSuccess(result)) entries.push({ fileName, entry: result.success });
      else rejected.push({ fileName, reason: result.failure.reason });
    });
    const listing: Listing = { entries, rejected };
    return listing;
  });

  const read = Effect.fn("TalkRegistry.read")(function* (fileName: string) {
    if (!ENTRY_NAME.test(fileName) || !(yield* folderPresent)) return Option.none<RegistryEntry>();
    const blob = yield* readBlob(fileName).pipe(
      Effect.catchTag("TalkEntryRejected", () => Effect.succeedNone),
    );
    if (Option.isNone(blob)) return Option.none<RegistryEntry>();
    // A failed DPAPI batch passes up; a blob that does not open is a rejected entry.
    const [opened] = yield* openAll([fileName], [blob.value]);
    return opened !== undefined && Result.isSuccess(opened)
      ? Option.some(opened.success)
      : Option.none<RegistryEntry>();
  });

  const publish = Effect.fn("TalkRegistry.publish")(function* (entry: RegistryEntry) {
    const fileName = entryFileName(entry.instanceId, entry.sessionId);
    const path = join(folder, fileName);
    const text = encodeEntry(entry);
    const plainBytes = utf8.encode(text).byteLength;
    if (plainBytes > MAX_SECRET_FILE_BYTES) {
      return yield* new TalkFileError({ path, reason: sizeFault(plainBytes) });
    }
    const [blob] = yield* withDpapi(sealEntries([text]));
    if (blob === undefined) {
      return yield* new TalkFileError({ path, reason: "DPAPI gave no sealed blob" });
    }
    if (blob.byteLength > MAX_SECRET_FILE_BYTES) {
      return yield* new TalkFileError({ path, reason: sizeFault(blob.byteLength) });
    }
    const temporaryPath = join(folder, temporaryFileName());
    const fd = yield* fileCall(temporaryPath, "open", () => openSync(temporaryPath, "wx"));
    // The exclusive open made the temporary file, so any later failure removes it.
    let open = true;
    yield* Effect.gen(function* () {
      yield* fileCall(temporaryPath, "write", () => writeFile(fd, blob));
      open = false;
      yield* fileCall(temporaryPath, "close", () => closeSync(fd));
      yield* fileCall(path, "rename", () => renameSync(temporaryPath, path));
    }).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          try {
            if (open) closeSync(fd);
          } catch {
            // The descriptor is closed already.
          }
          try {
            unlinkSync(temporaryPath);
          } catch {
            // The error of the failed step tells the caller what went wrong.
          }
        }),
      ),
    );
    const published: PublishedEntry = { fileName, path, bytes: blob, fd: undefined };
    return published;
  });

  // Windows file ids can be reused, so the check compares the bytes at the name with the sealed blob.
  const check = Effect.fn("TalkRegistry.check")(function* (published: PublishedEntry) {
    const stats = yield* lstatName(published.path);
    const replaced: KeptFileState = "replaced";
    // Another size means other bytes; the compare then reads nothing.
    if (stats === undefined || !stats.isFile() || stats.size !== published.bytes.byteLength) {
      return replaced;
    }
    const bytes = yield* readObserved(published.path, published.bytes.byteLength);
    const state: KeptFileState =
      bytes instanceof Uint8Array && Buffer.from(bytes).equals(Buffer.from(published.bytes))
        ? "intact"
        : "replaced";
    return state;
  });

  const remove = Effect.fn("TalkRegistry.remove")(function* (fileName: string) {
    if (!ENTRY_NAME.test(fileName)) return yield* notEntryName(folder, fileName);
    const path = join(folder, fileName);
    yield* ignoreMissing(fileCall(path, "unlink", () => unlinkSync(path)));
  });

  return TalkRegistry.of({
    folder,
    endpointKind: "tcp",
    prepare: fileCall(folder, "mkdir", () => mkdirSync(folder, { recursive: true })).pipe(
      Effect.asVoid,
    ),
    folderPresent,
    publish,
    check,
    refresh: () => Effect.void,
    release: () => Effect.void,
    read,
    list,
    remove,
    removeSocket: () => Effect.void,
  });
});
