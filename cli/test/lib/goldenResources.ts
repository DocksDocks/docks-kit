/**
 * Filesystem resources shared by the golden regression suites.
 */
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hostOs, type PlatformName } from "../../src/engine-native/os";

export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const FIXTURES_DIR = join(REPO_DIR, "cli", "test", "fixtures");

const HARNESS_TEMP_PREFIXES = [
  "golden-bun-cache-",
  "golden-bun-transpiler-",
  "golden-home-",
  "golden-stubs-",
  "golden-mask-",
  "golden-fixture-",
] as const;
const STALE_TEMP_DIR_AGE_MS = 60 * 60 * 1000;
const OWNER_PID_SUFFIX = ".owner-pid";
const TEMP_DIRS = new Set<string>();

/**
 * Heal externally killed runs by using recorded owner liveness.
 *
 * Current harness directories have a sibling marker that records the owner
 * process. We remove a directory only when `kill(pid, 0)` reports ESRCH.
 *
 * Older harness versions have no marker.
 * When marker data is unreadable or invalid, the sweep uses directory age.
 * This fallback heals old orphans while sparing young runs.
 *
 * A sibling marker survives fixture replacement and stays outside snapshots.
 * The sweep removes dead or old orphan markers after their directory disappears.
 */
export function sweepStaleTemporaryDirs(nowMs = Date.now()): void {
  // Windows has no numeric uid; its temp root is user-scoped, so owner
  // marker liveness and age remain the sweep boundary there.
  const ownerUid = process.getuid?.();
  const root = tmpdir();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      sweepOrphanOwnerMarker(root, entry.name, ownerUid, nowMs);
      continue;
    }
    if (!HARNESS_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(root, entry.name);
    try {
      const stat = lstatSync(path);
      if (ownerUid !== undefined && stat.uid !== ownerUid) continue;
      if (TEMP_DIRS.has(path)) continue;

      const ownerPath = `${path}${OWNER_PID_SUFFIX}`;
      const ownerPid = readOwnerPid(ownerPath, ownerUid);
      if (ownerPid !== undefined) {
        if (ownerPid === process.pid || processIsAlive(ownerPid)) continue;
      } else if (nowMs - stat.mtimeMs < STALE_TEMP_DIR_AGE_MS) {
        continue;
      }

      try {
        rmSync(path, { recursive: true, force: true });
        rmSync(ownerPath, { force: true });
      } catch {
        // A protected directory must not stop the remaining stale sweep.
      }
    } catch {
      // An unreadable entry must not stop the remaining stale sweep.
    }
  }
}

function sweepOrphanOwnerMarker(
  root: string,
  entryName: string,
  ownerUid: number | undefined,
  nowMs: number,
): void {
  if (!entryName.endsWith(OWNER_PID_SUFFIX)) return;
  const directoryName = entryName.slice(0, -OWNER_PID_SUFFIX.length);
  if (!HARNESS_TEMP_PREFIXES.some((prefix) => directoryName.startsWith(prefix))) return;

  const directoryPath = join(root, directoryName);
  try {
    lstatSync(directoryPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }

  const ownerPath = join(root, entryName);
  try {
    const stat = lstatSync(ownerPath);
    if (ownerUid !== undefined && stat.uid !== ownerUid) return;
    const ownerPid = readOwnerPid(ownerPath, ownerUid);
    if (ownerPid !== undefined) {
      if (ownerPid === process.pid || processIsAlive(ownerPid)) return;
    } else if (nowMs - stat.mtimeMs < STALE_TEMP_DIR_AGE_MS) {
      return;
    }

    try {
      rmSync(ownerPath, { force: true });
    } catch {
      // A protected marker must not stop the remaining stale sweep.
    }
  } catch {
    // An unreadable marker must not stop the remaining stale sweep.
  }
}

function readOwnerPid(ownerPath: string, ownerUid: number | undefined): number | undefined {
  try {
    if (ownerUid !== undefined && lstatSync(ownerPath).uid !== ownerUid) return undefined;
    const ownerPid = Number(readFileSync(ownerPath, "utf8").trim());
    return Number.isSafeInteger(ownerPid) && ownerPid > 0 ? ownerPid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Report owner liveness. A signal-zero probe that raises ESRCH proves the
 * owner is gone; any other error means the probe itself failed, so the owner
 * counts as alive and its resources stay.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.add(dir);
  writeFileSync(`${dir}${OWNER_PID_SUFFIX}`, `${process.pid}\n`);
  return dir;
}

export function registeredTemporaryDirs(): ReadonlyArray<string> {
  return [...TEMP_DIRS];
}

/** True for the error codes that a missing permission gives. */
function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Give the owner read, write, and search permission on `folder` and on each
 * folder below it, so a recursive removal can list them. Only folders get a
 * stat; a symbolic link is not followed.
 */
function restoreFolderPermissions(folder: string): void {
  const { mode } = lstatSync(folder);
  if ((mode & 0o700) !== 0o700) chmodSync(folder, mode | 0o700);
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreFolderPermissions(join(folder, entry.name));
  }
}

/**
 * Remove `path` and everything below it. A sync can leave a nonempty folder
 * at mode 000: after a permission error on POSIX, this gives the folders
 * below `path` their owner permissions and tries once more. Returns the
 * message of the last failed removal when `path` stays, else undefined; it
 * never throws.
 */
export function removeTree(path: string): string | undefined {
  try {
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    if (process.platform === "win32" || !isPermissionError(error)) return errorMessage(error);
  }
  try {
    restoreFolderPermissions(path);
  } catch {
    // The second removal reports what still blocks it.
  }
  try {
    rmSync(path, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

/** The message of a thrown value, for a problem line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove each registered temporary folder and its owner marker, and return
 * one problem line for each folder that stays; it never throws, so one
 * folder that stays does not keep the next ones. A folder that stays keeps
 * its marker, so a later stale sweep can find its owner. TEMP_DIRS keeps the
 * path strings for snapshot normalization.
 */
export function removeTemporaryDirs(): Array<string> {
  const problems: Array<string> = [];
  for (const dir of TEMP_DIRS) {
    const problem = removeTree(dir);
    if (problem === undefined) {
      problems.push(...removeOwnerMarker(dir));
    } else {
      problems.push(`golden: temporary folder ${dir} cannot be removed: ${problem}`);
    }
  }
  return problems;
}

/** `removeTemporaryDirs` for a test hook: after every removal, a folder that stays throws. */
export function cleanupTemporaryDirs(): void {
  const problems = removeTemporaryDirs();
  if (problems.length > 0) throw new Error(problems.join("\n"));
}

/** Remove the owner marker of `dir`; a problem line when it stays. */
function removeOwnerMarker(dir: string): Array<string> {
  try {
    rmSync(`${dir}${OWNER_PID_SUFFIX}`, { force: true });
    return [];
  } catch (error) {
    return [
      `golden: owner marker ${dir}${OWNER_PID_SUFFIX} cannot be removed: ${errorMessage(error)}`,
    ];
  }
}

/** Run the exit sweep and print each folder that stays. */
function reportTemporaryDirCleanup(): void {
  for (const problem of removeTemporaryDirs()) console.error(problem);
}

function handleSigint(): void {
  try {
    reportTemporaryDirCleanup();
  } finally {
    process.off("SIGINT", handleSigint);
    process.kill(process.pid, "SIGINT");
  }
}

function handleSigterm(): void {
  try {
    reportTemporaryDirCleanup();
  } finally {
    process.off("SIGTERM", handleSigterm);
    process.kill(process.pid, "SIGTERM");
  }
}

sweepStaleTemporaryDirs();
process.on("exit", reportTemporaryDirCleanup);
process.on("SIGINT", handleSigint);
process.on("SIGTERM", handleSigterm);

/** The npm rows of one omp plugin store in a stub inventory. */
type StubNpmRows = ReadonlyArray<Readonly<Record<string, string>>>;

/**
 * The stub omp body: it prints the omp version and answers each
 * `plugin list --json` with no marketplace row and the npm rows of the store
 * that its environment selects, as omp does: `OMP_PROFILE`, else
 * `PI_PROFILE`. `npm` holds the rows of the default store, `profiles` the rows
 * of each named profile; a profile without an entry answers no npm row. Every
 * other omp command succeeds without output.
 */
export function ompStubBody(
  npm: StubNpmRows = [],
  profiles: Readonly<Record<string, StubNpmRows>> = {},
): string {
  const stores = { "": npm, ...profiles };
  return `if (args[0] === "--version") {
  console.log("omp/19.2.1")
} else if (args[0] === "plugin" && args[1] === "list") {
  const stores = ${JSON.stringify(stores)}
  const profile = process.env["OMP_PROFILE"] ?? process.env["PI_PROFILE"] ?? ""
  console.log(JSON.stringify({ npm: Object.hasOwn(stores, profile) ? stores[profile] : [], marketplace: [] }))
}`;
}

/**
 * Canned stub behavior. Each stub appends "<name>\t<args>" to
 * `GOLDEN_ARGV_LOG` and emits just enough output for the engine's probes to
 * take a deterministic branch. Bodies are JavaScript so one runner can back
 * both POSIX launchers and Windows `.cmd` launchers.
 */
const STUB_BODIES: Record<string, string> = {
  // git and jq are version-probed by `toolchain check` but never do real work
  // in the engine — pin them so the goldens don't embed the recording
  // machine's host versions.
  git: `if (args[0] === "--version") console.log("git version 2.43.0")`,
  jq: `if (args[0] === "--version") console.log("jq-1.7.1")`,
  // The inventory stays empty on every call, so a replay row pins the link
  // path rather than the already-linked path; ompSync's present-detection
  // is covered by cli/test/unit/ompPluginInventory.test.ts instead. A case
  // that needs inventory rows overrides this body with `ompStubBody(rows)`.
  omp: ompStubBody(),
  npm: `if (args[0] === "view") console.log("0.0.1")`,
  bun: `if (args[0] === "--version") console.log("1.4.5")`,
  curl: ``,
  // Windows user-environment persistence. A real `setx` writes HKCU and then
  // broadcasts WM_SETTINGCHANGE, which blocks for seconds on a headless runner
  // and mutates the machine outside the fixture home; `reg` reports the value
  // as absent so the engine takes its apply branch deterministically.
  reg: `process.exitCode = 1`,
  setx: ``,
};

/**
 * Inherit the caller's environment, then apply `overrides` so they actually
 * take effect. Windows environment names are case-insensitive but keep their
 * creation spelling, so a plain spread can leave an inherited `UserProfile`
 * beside an explicit `USERPROFILE`; the child then reads whichever the OS
 * happens to hand it and the override is silently lost. Drop every inherited
 * key that matches an override case-insensitively before applying it.
 */
export function childEnv(overrides: Record<string, string>): Record<string, string> {
  const shadowed = new Set(Object.keys(overrides).map((name) => name.toUpperCase()));
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || shadowed.has(name.toUpperCase())) continue;
    inherited[name] = value;
  }
  return { ...inherited, ...overrides };
}

/** The host a child runs as: native recording host, or Linux via the preload. */
export function childHostId(nativeHost: boolean): PlatformName {
  return nativeHost ? hostOs().id : "linux";
}

const STUB_HOST_MARKER = ".golden-stub-host";

export function readStubHost(stubDir: string): string {
  try {
    return readFileSync(join(stubDir, STUB_HOST_MARKER), "utf8").trim();
  } catch {
    return "unrecorded";
  }
}

/**
 * `overrides` replaces a stub's JavaScript body per test row; `null` omits the
 * stub entirely (tool missing). `opts.nativeHost` must match the run helper the
 * stubs are handed to: the launcher form is the host's, so a Linux-preloaded
 * child needs extensionless launchers even when recording on Windows.
 */
export function makeStubDir(
  overrides: Record<string, string | null> = {},
  opts: { readonly nativeHost?: boolean } = {},
): string {
  const unknownNames = Object.keys(overrides)
    .filter((name) => !Object.hasOwn(STUB_BODIES, name))
    .sort();
  if (unknownNames.length > 0) {
    throw new Error(`Unknown golden stub override(s): ${unknownNames.join(", ")}`);
  }
  const hostId = childHostId(opts.nativeHost === true);
  const dir = temporaryDir("golden-stubs-");
  writeFileSync(join(dir, STUB_HOST_MARKER), `${hostId}\n`);
  const runnerPath = join(dir, "golden-stub-runner.mjs");
  const cases: Array<string> = [];
  for (const [name, defaultBody] of Object.entries(STUB_BODIES)) {
    const body = name in overrides ? overrides[name] : defaultBody;
    if (body === null || body === undefined) continue;
    cases.push(`case ${JSON.stringify(name)}: {\n${body}\nbreak\n}`);
  }
  writeFileSync(
    runnerPath,
    `import { appendFileSync } from "node:fs"
const [name, ...args] = process.argv.slice(2)
const argvLog = process.env["GOLDEN_ARGV_LOG"]
if (argvLog !== undefined) appendFileSync(argvLog, \`\${name}\\t\${args.join(" ")}\\n\`)
switch (name) {
${cases.join("\n")}
default: throw new Error(\`unknown golden stub: \${String(name)}\`)
}
`,
  );

  // A Linux-preloaded child resolves extensionless names even when recording on
  // Windows, so the launcher form follows the paired host, not this machine.
  const windows = hostId === "windows";
  const suffix = windows
    ? hostOs("windows").executableSuffixes.find((candidate) => candidate.toLowerCase() === ".cmd")
    : "";
  if (suffix === undefined)
    throw new Error("Windows host facts do not declare a .cmd executable suffix");

  for (const name of Object.keys(STUB_BODIES)) {
    if (name in overrides && overrides[name] === null) continue;
    const path = join(dir, `${name}${suffix}`);
    if (windows) {
      // The engine resolves this suffix and host.invoke routes it through cmd.exe.
      writeFileSync(path, `@echo off\r\n"${process.execPath}" "${runnerPath}" "${name}" %*\r\n`);
    } else {
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${runnerPath}" "${name}" "$@"\n`);
      chmodSync(path, 0o755);
    }
  }
  return dir;
}
