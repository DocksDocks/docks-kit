/**
 * The registry folder of `talk` (#249 E4) and the system commands that the
 * transport starts. The folder is the private runtime folder that each system
 * gives one user on one machine.
 */
import { spawn } from "node:child_process";
import { posix, win32 } from "node:path";
import { Effect, Result, Schema } from "effect";

/** Test and verify flows set this variable to a short folder; it is no user setting. */
export const TALK_DIR_OVERRIDE = "DOCKS_KIT_TALK_DIR";

/** macOS commands, by absolute path (Tool facts). */
export const DARWIN_LS = "/bin/ls";
export const DARWIN_CHMOD = "/bin/chmod";
export const DARWIN_GETCONF = "/usr/bin/getconf";

const LINUX_FOLDER_PREFIX = "/tmp/docks-kit-talk-";
const DARWIN_FOLDER_NAME = "docks-kit-talk";

/** The registry folder could not be chosen. `path` is empty when no path exists yet. */
export class TalkFolderError extends Schema.TaggedError<
  TalkFolderError,
  { readonly brand: unique symbol }
>()("TalkFolderError", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** A system command could not start. */
export class TalkToolError extends Schema.TaggedError<
  TalkToolError,
  { readonly brand: unique symbol }
>()("TalkToolError", {
  command: Schema.String,
  reason: Schema.String,
}) {}

/** The system facts that choose the folder. */
export interface FolderFacts {
  readonly platform: NodeJS.Platform;
  /** The value of `DOCKS_KIT_TALK_DIR`; empty counts as unset. */
  readonly override: string | undefined;
  /** The user id on POSIX systems. */
  readonly uid: number | undefined;
  /** The output of `getconf DARWIN_USER_TEMP_DIR` on macOS. */
  readonly darwinTempDir: string | undefined;
  /** `%LOCALAPPDATA%` on Windows. */
  readonly localAppData: string | undefined;
}

/** The chosen folder, or the reason that no folder exists. */
export type FolderChoice = Result.Result<string, TalkFolderError>;

const folderError = (path: string, reason: string): FolderChoice =>
  Result.fail(new TalkFolderError({ path, reason }));

/** Chooses the registry folder from the facts. It reads nothing from the system. */
export function registryFolderFor(facts: FolderFacts): FolderChoice {
  const { platform } = facts;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    return folderError("", `talk runs on Linux, macOS, and Windows, not on ${platform}`);
  }
  const paths = platform === "win32" ? win32 : posix;
  if (facts.override !== undefined && facts.override !== "") {
    if (!paths.isAbsolute(facts.override)) {
      return folderError(facts.override, `${TALK_DIR_OVERRIDE} must be an absolute path`);
    }
    return Result.succeed(paths.resolve(facts.override));
  }
  if (platform === "linux") {
    if (facts.uid === undefined) return folderError("", "the process has no user id");
    return Result.succeed(`${LINUX_FOLDER_PREFIX}${facts.uid}`);
  }
  if (platform === "darwin") {
    const temp = facts.darwinTempDir?.trim() ?? "";
    if (!posix.isAbsolute(temp)) {
      return folderError(temp, "DARWIN_USER_TEMP_DIR is not an absolute path");
    }
    return Result.succeed(posix.join(temp, DARWIN_FOLDER_NAME));
  }
  const local = facts.localAppData ?? "";
  if (!win32.isAbsolute(local)) {
    return folderError(local, "LOCALAPPDATA is not an absolute path");
  }
  return Result.succeed(win32.join(local, "docks-kit", "talk"));
}

/** `powershell.exe` (Windows PowerShell 5.1) in the Windows system folder. */
export function windowsPowerShellPath(systemRoot: string | undefined): FolderChoice {
  const root = systemRoot ?? "";
  if (!win32.isAbsolute(root)) return folderError(root, "SystemRoot is not an absolute path");
  return Result.succeed(
    win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
}

/** The exit status and the output of a finished command. */
export interface ToolResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The deadline of one system command; past it, the command is killed and fails. */
export const TOOL_TIMEOUT_MS = 30_000;

/**
 * Runs `command` with `args` and no shell, writes `input` to its standard
 * input, and waits for it to end. Interruption and the deadline
 * (`TOOL_TIMEOUT_MS` by default) kill the command.
 */
export const runTool = Effect.fn("runTool")(function* (
  command: string,
  args: ReadonlyArray<string>,
  input = "",
  timeoutMs: number = TOOL_TIMEOUT_MS,
) {
  return yield* Effect.callback<ToolResult, TalkToolError>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<ToolResult, TalkToolError>): void => {
      if (settled) return;
      settled = true;
      resume(effect);
    };
    const child = spawn(command, [...args], { stdio: "pipe", windowsHide: true });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // A command that ends before it reads its input closes the pipe; the exit status tells the result.
    child.stdin.on("error", () => undefined);
    child.on("error", (error) =>
      settle(Effect.fail(new TalkToolError({ command, reason: error.message }))),
    );
    child.on("close", (status) =>
      settle(
        Effect.succeed({
          status,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      ),
    );
    child.stdin.end(input);
    return Effect.sync(() => {
      settled = true;
      child.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new TalkToolError({ command, reason: `the command did not end within ${timeoutMs} ms` }),
        ),
    }),
  );
});

const darwinTempDir = Effect.fn("darwinTempDir")(function* () {
  const result = yield* runTool(DARWIN_GETCONF, ["DARWIN_USER_TEMP_DIR"]).pipe(
    Effect.mapError((error) => new TalkFolderError({ path: "", reason: error.reason })),
  );
  if (result.status !== 0) {
    return yield* new TalkFolderError({
      path: "",
      reason: `${DARWIN_GETCONF} DARWIN_USER_TEMP_DIR failed: ${result.stderr.trim()}`,
    });
  }
  return result.stdout;
});

/**
 * Chooses the registry folder of this process. On macOS without the override,
 * it runs `getconf DARWIN_USER_TEMP_DIR`.
 */
export const resolveRegistryFolder = Effect.fn("resolveRegistryFolder")(function* (
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const override = env[TALK_DIR_OVERRIDE];
  const needsTempDir = process.platform === "darwin" && (override === undefined || override === "");
  const facts: FolderFacts = {
    platform: process.platform,
    override,
    uid: process.getuid?.(),
    darwinTempDir: needsTempDir ? yield* darwinTempDir() : undefined,
    localAppData: env.LOCALAPPDATA,
  };
  const choice = registryFolderFor(facts);
  return Result.isSuccess(choice) ? choice.success : yield* choice.failure;
});
