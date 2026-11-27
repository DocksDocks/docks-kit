#!/usr/bin/env bun
/**
 * Smoke test of the docks-kit kit plugin (`SoT/.omp/plugin`) in the real omp, for verify flow V6.
 *
 * The script links the plugin folder of this checkout into isolated omp state in a docks-kit scratch
 * folder, runs the command, and removes the folder. It uses a fake local OpenAI-compatible model, so no
 * real model credential is used.
 *
 * Each command loads the shipped `talk` extension (`extensions/talk.js`). omp gets `DOCKS_KIT_TALK_DIR` set to a
 * private registry folder, and each command checks that each talk session registered there and not in the
 * default talk registry folder of the user. The script only reads the default folder.
 *
 * Commands:
 *   (default)  Read what omp loads: the linked package, the skills, the task-tool agents, the extension entries,
 *              the `talk` tool, and the warnings.
 *   hooks      Drive the verify-gate, context-tree-nudge, and hygiene extensions in `omp -p` sessions in a
 *              scratch git repository. The fake model plays scripted tool calls. Prints `ok <name>` or
 *              `FAIL <name>: <reason>` for each check.
 *   talk       Link a copy of the plugin, start one omp as an RPC peer and drive a second omp in print mode, both
 *              with `tools.commands` off. The fake model scripts the `talk` calls of each session. Prints
 *              `ok <name>` or `FAIL <name>: <reason>`.
 *   talk-ui    Run omp in TUI mode in a pseudo-terminal beside an omp RPC peer, with the same plugin copy, and
 *              drive `alt+t`, a resize of the pane below the list size, the compose and confirm views, the message
 *              card, and `/talk handover` with key bytes. An omp older than 19.2.0 must show only the talk
 *              capability notice and no `/talk` command.
 *              Prints `ok <name>` or `FAIL <name>: <reason>`.
 *
 * `--omp <binary>` runs that omp binary in place of `omp` from PATH, for every command.
 *
 * Usage: bun .agents/skills/verify/scripts/omp-smoke.ts [hooks|talk|talk-ui] [--repo <path>] [--omp <binary>]
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Result } from "effect";
import { ompPaths } from "../../../../cli/src/engine-native/ompPaths.ts";
import {
  DARWIN_GETCONF,
  registryFolderFor,
  TALK_DIR_OVERRIDE,
} from "../../../../cli/talk/transport/folder.ts";
import { ENTRY_NAME } from "../../../../cli/talk/transport/registry.ts";

/** The `name` of the kit plugin package, and of its npm row in `omp plugin list --json`. */
const PACKAGE_NAME = "docks-kit-omp";
/** The kit plugin folder, relative to the repository root. */
const PLUGIN_DIR = "SoT/.omp/plugin";
/** The shipped `talk` skill: the load mode expects it among the skills that omp loads. */
const TALK_SKILL = "talk";
const REQUIRED_AGENTS = ["code-reviewer", "plan-reviewer"];
const COMMAND_TIMEOUT_MS = 120_000;
const MODEL_PROVIDER = "omp-smoke";
const MODEL_ID = "smoke-model";
const SESSION_PROMPT = "Reply with ok.";
const SCRIPTED_PROMPT = "Do the scripted steps.";
const SCRATCH_LABEL = "omp-smoke";
/** The config root name under the scratch home. omp joins PI_CONFIG_DIR to the home folder. */
const CONFIG_DIR_NAME = ".omp-smoke";
/** The sweep stamp of `hygiene.ts`, under `<home>/.cache/docks-kit`. A fresh stamp keeps the sweep from starting. */
const SWEEP_STAMP = ["docks-kit", "tidy.stamp"];
/** Registry files of the real omp state; the smoke run must not touch them. */
const REAL_REGISTRY_FILES = [
  "marketplaces.json",
  "plugins/installed_plugins.json",
  "plugins/omp-plugins.lock.json",
  "plugins/package.json",
];
/**
 * The real user log of the verify-gate. Other omp sessions can add lines to it during a smoke run;
 * a new line with a `cwd` inside the smoke scratch folder shows that the smoke run wrote to it.
 */
const REAL_GATE_LOG = join(
  process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state"),
  "docks",
  "verify-gate.jsonl",
);
const COMMANDS = ["hooks", "talk", "talk-ui"];

// ---------- JSON narrowing ----------

type Json = null | boolean | number | string | Json[] | JsonObject;
interface JsonObject {
  [key: string]: Json;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseJsonText(source: string): Json | undefined {
  try {
    const parsed: Json = JSON.parse(source);
    return parsed;
  } catch {
    return undefined;
  }
}

// ---------- arguments ----------

const { values: args, positionals } = parseArgs({
  options: {
    repo: { type: "string" },
    omp: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: true,
});
const command = positionals[0] ?? null;
if (
  args.help === true ||
  positionals.length > 1 ||
  (command !== null && !COMMANDS.includes(command))
) {
  console.log("usage: omp-smoke.ts [hooks|talk|talk-ui] [--repo <path>] [--omp <binary>]");
  process.exit(args.help === true ? 0 : 2);
}
// omp resolves the home folder from HOME only on Linux and macOS. On Windows the scratch home would not
// isolate the kit extensions, so the script refuses to run there.
if (process.platform === "win32") {
  console.log("FAIL omp-smoke.ts runs on Linux and macOS only");
  process.exit(2);
}
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(args.repo ?? join(scriptDir, "../../../.."));
const pluginDir = join(repo, PLUGIN_DIR);
/**
 * The omp binary of every run. A path with a folder part is made absolute, because each run starts in a
 * scratch folder; a bare name is looked up in PATH.
 */
const ompBinary =
  args.omp === undefined
    ? "omp"
    : args.omp.includes(sep) && !isAbsolute(args.omp)
      ? resolve(args.omp)
      : args.omp;

// ---------- process and scratch lifecycle ----------

const children = new Set<ChildProcess>();
/** The omp processes that run in a pseudo-terminal (the `talk-ui` mode). */
const terminalChildren = new Set<Bun.Subprocess>();
let scratch: string | null = null;
/** The private talk registry folder of the run. It lies outside the scratch folder; cleanup removes it too. */
let talkDir: string | null = null;
let server: Server | null = null;

/** Removes a temporary folder with `docks-kit scratch remove`. Returns false when the folder stays. */
function removeFolder(path: string): boolean {
  const result = spawnSync("docks-kit", ["scratch", "remove", path], { encoding: "utf8" });
  if (result.status === 0 && !existsSync(path)) return true;
  const detail = (result.stderr || String(result.error ?? "")).trim();
  if (detail) console.error(detail);
  return false;
}

/**
 * Stops children and the fake model, and removes the scratch folder and the talk registry folder.
 * Returns the paths of the folders that it could not remove.
 */
function cleanup(): string[] {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const child of terminalChildren) child.kill("SIGKILL");
  terminalChildren.clear();
  server?.closeAllConnections();
  server?.close();
  server = null;
  const folders = [scratch, talkDir].filter((path) => path !== null);
  scratch = null;
  talkDir = null;
  return folders.filter((path) => !removeFolder(path));
}

function reportCleanup(): boolean {
  const kept = cleanup();
  for (const path of kept) console.log(`FAIL could not remove scratch folder ${path}`);
  return kept.length === 0;
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => {
    reportCleanup();
    process.exit(code);
  });
}

function createScratch(): string {
  const result = spawnSync("docks-kit", ["scratch", "new", SCRATCH_LABEL], { encoding: "utf8" });
  const path = result.stdout?.trim().split("\n").pop();
  if (result.status !== 0 || !path || !existsSync(path)) {
    throw new Error(`docks-kit scratch new failed: ${result.stderr || String(result.error ?? "")}`);
  }
  return path;
}

/** The isolated folders of one run: the private talk registry folder, and the others inside the scratch folder. */
interface Isolation {
  /** The home folder of omp: the kit extensions resolve `~/.cache/docks-kit` here. */
  readonly home: string;
  /** The omp config root, `<home>/<PI_CONFIG_DIR>`. */
  readonly stateDir: string;
  readonly stateHome: string;
  readonly tmpDir: string;
  /** The private talk registry folder (mode 0700) in the system temporary root. */
  readonly registry: string;
}

/**
 * Environment for omp: only the allowed parent variables, so no omp session variable, no docks variable,
 * and no credential reaches omp. HOME is the scratch home, so the kit extensions (`hygiene.ts`) read and write
 * their `~/.cache/docks-kit` files there; PI_CONFIG_DIR names the isolated config root under it; XDG_STATE_HOME
 * is a scratch folder, so the verify-gate writes no line into the user log; TMPDIR is a scratch folder;
 * DOCKS_KIT_TALK_DIR is the private registry folder, so `talk` does not register in the default folder.
 * Each environment that a mode derives from this one keeps these variables.
 */
const ENV_ALLOWLIST = ["PATH", "USER", "LANG", "TERM"];
function isolatedEnv(isolation: Isolation): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (ENV_ALLOWLIST.includes(key) || key.startsWith("LC_")))
      env[key] = value;
  }
  env["HOME"] = isolation.home;
  env["PI_CONFIG_DIR"] = CONFIG_DIR_NAME;
  env["XDG_STATE_HOME"] = isolation.stateHome;
  env["TMPDIR"] = isolation.tmpDir;
  env[TALK_DIR_OVERRIDE] = isolation.registry;
  return env;
}

interface OmpResult {
  readonly argv: readonly string[];
  readonly code: number | "timeout" | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs omp to its exit. `onSpawn` gets the process id of the omp process, or undefined when it did not start. */
function runOmp(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  onSpawn?: (pid: number | undefined) => void,
): Promise<OmpResult> {
  const { promise, resolve: done } = Promise.withResolvers<OmpResult>();
  const child = spawn(ompBinary, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  onSpawn?.(child.pid);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, COMMAND_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    stderr += String(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    children.delete(child);
    done({ argv, code: timedOut ? "timeout" : code, stdout, stderr });
  });
  return promise;
}

// ---------- fake model ----------

interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, string>>;
}
type Turn = readonly ToolCall[] | ((request: JsonObject) => readonly ToolCall[]);
/** The answer of the fake model to one request: tool calls, or a text; an empty list is a plain "ok" answer. */
type Answer = readonly ToolCall[] | string;
interface Script {
  turns: readonly Turn[];
  /**
   * When set, answers every request in place of `turns`. The answer can wait for the driver, so a turn of a
   * session lasts until the driver has acted on another session.
   */
  respond?: (request: JsonObject) => Promise<Answer>;
  /** When set, each answer waits for it first, so the omp session stays live until a check ends. */
  hold?: Promise<unknown>;
}

function sseChunk(model: Json, choice: JsonObject, extra: JsonObject = {}): string {
  return `data: ${JSON.stringify({ id: "omp-smoke", object: "chat.completion.chunk", created: 0, model, choices: [choice], ...extra })}\n\n`;
}

/**
 * The answer of the scripted turn for one request: tool calls, or a text ("ok" when the turn has no call).
 * `script.turns[n]` answers a request that holds n assistant messages, unless `script.respond` is set.
 */
async function scriptedAnswer(script: Script, request: JsonObject): Promise<Answer> {
  if (script.hold !== undefined) await script.hold;
  let answer: Answer | undefined;
  if (script.respond !== undefined) answer = await script.respond(request);
  else {
    const index = objects(request["messages"]).filter(
      (message) => message["role"] === "assistant",
    ).length;
    const turn = script.turns[index];
    answer = typeof turn === "function" ? turn(request) : turn;
  }
  return answer === undefined || answer.length === 0 ? "ok" : answer;
}

/** Fake OpenAI-compatible model: records each request body and answers with the scripted tool calls or text, else with "ok" and a stop. */
function startFakeModel(requests: JsonObject[], script: Script): Promise<Server> {
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url?.endsWith("/chat/completions") !== true) {
        res.writeHead(404).end();
        return;
      }
      const parsed = parseJsonText(body);
      if (!isObject(parsed)) {
        res.writeHead(400).end();
        return;
      }
      requests.push(parsed);
      const model = parsed["model"] ?? null;
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (parsed["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        void scriptedAnswer(script, parsed)
          .catch((): Answer => "ok")
          .then((answer) => {
            // Cleanup closes the connection of a turn that still waits.
            if (res.destroyed) return;
            if (typeof answer !== "string") {
              const toolCalls = answer.map((call, index) => ({
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              }));
              res.write(
                sseChunk(model, {
                  index: 0,
                  delta: { role: "assistant", tool_calls: toolCalls },
                  finish_reason: null,
                }),
              );
              res.write(
                sseChunk(model, { index: 0, delta: {}, finish_reason: "tool_calls" }, { usage }),
              );
            } else {
              res.write(
                sseChunk(model, {
                  index: 0,
                  delta: { role: "assistant", content: answer },
                  finish_reason: null,
                }),
              );
              res.write(sseChunk(model, { index: 0, delta: {}, finish_reason: "stop" }, { usage }));
            }
            res.end("data: [DONE]\n\n");
          });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "omp-smoke",
          object: "chat.completion",
          created: 0,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
    });
  });
  const { promise, resolve: ready, reject: fail } = Promise.withResolvers<Server>();
  fake.once("error", fail);
  fake.listen(0, "127.0.0.1", () => ready(fake));
  return promise;
}

function modelsYaml(port: number, modelIds: readonly string[]): string {
  return [
    "providers:",
    `  ${MODEL_PROVIDER}:`,
    `    baseUrl: http://127.0.0.1:${port}/v1`,
    "    api: openai-completions",
    "    auth: none",
    "    models:",
    ...modelIds.flatMap((id) => [
      `      - id: ${id}`,
      "        name: omp smoke fake model",
      "        reasoning: false",
      "        input: [text]",
      "        contextWindow: 128000",
      "        maxTokens: 4096",
      "        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
    ]),
    "",
  ].join("\n");
}

// ---------- real state ----------

function mtimeOf(file: string): number | null {
  return existsSync(file) ? statSync(file).mtimeMs : null;
}

/**
 * The real omp roots that can hold the registry: the base config root, the XDG data root when one is set,
 * and the config and data roots of the active omp profile, which the kit resolves the same way (`ompPaths`).
 */
function realRegistryRoots(): string[] {
  const roots = [join(homedir(), process.env["PI_CONFIG_DIR"] || ".omp")];
  const dataHome = process.env["XDG_DATA_HOME"];
  if (dataHome) roots.push(join(dataHome, "omp"));
  const active = ompPaths({ home: homedir(), env: process.env, platform: process.platform });
  roots.push(active.configRoot, active.dataRoot);
  return [...new Set(roots)];
}

interface RealState {
  readonly registry: ReadonlyMap<string, number | null>;
  readonly gateLogSize: number;
}

/**
 * A snapshot of the real state: the modification times of the real omp registry files, and the size of the
 * real verify-gate log, so that the check reads only the lines that come after it.
 */
function realStateSnapshot(): RealState {
  const files = realRegistryRoots().flatMap((root) =>
    REAL_REGISTRY_FILES.map((file) => join(root, file)),
  );
  return {
    registry: new Map(files.map((file) => [file, mtimeOf(file)])),
    gateLogSize: existsSync(REAL_GATE_LOG) ? statSync(REAL_GATE_LOG).size : 0,
  };
}

/**
 * The lines added to the real verify-gate log after a size. If the file is now shorter, a different file
 * replaced it, and all its lines count as new.
 */
function newGateLogLines(size: number): string[] {
  if (!existsSync(REAL_GATE_LOG)) return [];
  const bytes = readFileSync(REAL_GATE_LOG);
  return (bytes.length >= size ? bytes.subarray(size) : bytes)
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
}

function realStateChanges(before: RealState): string[] {
  const changes: string[] = [];
  for (const [file, mtime] of before.registry) {
    if (mtimeOf(file) !== mtime) changes.push(`real state changed: ${file}`);
  }
  if (scratch === null) return changes;
  const roots = [...new Set([scratch, realpathSync(scratch)])];
  const inScratch = (cwd: Json | undefined): boolean =>
    typeof cwd === "string" && roots.some((root) => cwd === root || cwd.startsWith(root + sep));
  const smokeLines = newGateLogLines(before.gateLogSize).filter((line) => {
    const record = parseJsonText(line);
    return isObject(record) && inScratch(record["cwd"]);
  });
  if (smokeLines.length > 0) {
    changes.push(
      `real state changed: ${REAL_GATE_LOG} has ${smokeLines.length} new line(s) with a cwd in the scratch folder`,
    );
  }
  return changes;
}

// ---------- talk registry ----------

/**
 * The prefix of the private registry folder in the system temporary root. The scratch folder is too deep:
 * the short path keeps each socket path inside `sun_path`.
 */
const TALK_DIR_PREFIX = "dkt-";
const PRIVATE_FOLDER_MODE = 0o700;
const PERMISSION_BITS = 0o777;
/** talk registers at session start, and its repair timer tries again each second. */
const REGISTRY_TIMEOUT_MS = 10_000;
/** The check line of the registry attribution, in each command. */
const REGISTRY_CHECK = "registry";
const REGISTRY_NOTE = "talk registered only in the private folder";

/** The output line of one check: `ok <name>`, or `FAIL <name>: <problem>`; an empty problem passes. */
function checkLine(name: string, problem: string): string {
  if (problem) return `FAIL ${name}: ${problem}`;
  return name === REGISTRY_CHECK ? `ok ${name}: ${REGISTRY_NOTE}` : `ok ${name}`;
}

/**
 * Makes the private registry folder (mode 0700) in the system temporary root, and keeps it for the cleanup.
 * A wrong mode adds a failure.
 */
function privateRegistry(failures: string[]): string {
  const registry = mkdtempSync(join(tmpdir(), TALK_DIR_PREFIX));
  talkDir = registry;
  const mode = statSync(registry).mode & PERMISSION_BITS;
  if (mode !== PRIVATE_FOLDER_MODE)
    failures.push(`the registry folder ${registry} has mode ${mode.toString(8)}, expected 700`);
  return registry;
}

/**
 * The default talk registry folder of the user: the folder that talk chooses without `DOCKS_KIT_TALK_DIR`
 * (`registryFolderFor` in `cli/talk/transport/folder.ts`), on Linux `/tmp/docks-kit-talk-<uid>`. The script
 * only reads this folder.
 */
function defaultTalkFolder(): string {
  const darwinTempDir =
    process.platform === "darwin"
      ? spawnSync(DARWIN_GETCONF, ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout
      : undefined;
  const choice = registryFolderFor({
    platform: process.platform,
    override: undefined,
    uid: process.getuid?.(),
    darwinTempDir,
    localAppData: process.env["LOCALAPPDATA"],
  });
  if (Result.isSuccess(choice)) return choice.success;
  throw new Error(`the default talk registry folder is unknown: ${choice.failure.reason}`);
}

/** Whether a file system error tells that the path does not exist. */
function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** The real path of `path`, or `path` when it does not resolve. */
function realOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The entry files of a talk registry folder whose JSON has `processId` and, after `realpath`, `cwd`. A missing
 * folder has none. The function only reads the folder.
 */
function attributedEntries(folder: string, processId: number, realCwd: string): string[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter((name) => {
    if (!ENTRY_NAME.test(name)) return false;
    let source: string;
    try {
      source = readFileSync(join(folder, name), "utf8");
    } catch (error) {
      // talk withdrew the entry after the folder read.
      if (isMissing(error)) return false;
      throw error;
    }
    const entry = parseJsonText(source);
    if (!isObject(entry) || entry["processId"] !== processId) return false;
    const cwd = entry["cwd"];
    return typeof cwd === "string" && realOrSame(cwd) === realCwd;
  });
}

/**
 * The registry attribution of one live omp session (H7): waits until the private folder holds an entry with the
 * process id and the work folder of the session, and then requires that the default folder holds no such entry.
 * Entries of other sessions do not count, because each check matches the process id and the folder together.
 * Gives the problem, or an empty text.
 */
async function registryAttribution(
  privateFolder: string,
  defaultFolder: string,
  processId: number,
  cwd: string,
): Promise<string> {
  const realCwd = realOrSame(cwd);
  const deadline = Date.now() + REGISTRY_TIMEOUT_MS;
  try {
    while (attributedEntries(privateFolder, processId, realCwd).length === 0) {
      if (Date.now() > deadline)
        return `no entry of process ${processId} with the folder ${cwd} in the private registry folder ${privateFolder} within ${REGISTRY_TIMEOUT_MS / 1_000} s`;
      await sleep(POLL_MS);
    }
    const leaked = attributedEntries(defaultFolder, processId, realCwd);
    return leaked.length === 0
      ? ""
      : `the default talk registry folder ${defaultFolder} holds the entry ${leaked.join(", ")} of process ${processId} with the folder ${cwd}`;
  } catch (error) {
    return `a talk registry folder could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** The registry attribution of the omp session `label` of a run; the problem names the session. */
async function sessionAttribution(
  run: Run,
  label: string,
  processId: number | undefined,
  cwd: string,
): Promise<string> {
  const problem =
    processId === undefined
      ? "the omp process did not start"
      : await registryAttribution(run.isolation.registry, run.defaultRegistry, processId, cwd);
  return problem && `${label}: ${problem}`;
}

/** The problems of several attributions, as one check problem. */
async function attributionProblem(checks: readonly Promise<string>[]): Promise<string> {
  return (await Promise.all(checks)).filter(Boolean).join("; ");
}

// ---------- plugin discovery ----------

function parseJson(source: string, label: string, failures: string[]): JsonObject | null {
  const parsed = parseJsonText(source);
  if (isObject(parsed)) return parsed;
  failures.push(`${label} did not print a JSON object`);
  return null;
}

function frontmatterName(file: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"));
  const name = match?.[1] === undefined ? null : /^name:\s*(.+?)\s*$/m.exec(match[1]);
  return name?.[1] === undefined ? null : name[1].replace(/^["']|["']$/g, "");
}

function pluginAgentNames(root: string): Set<string> {
  const names = new Set<string>();
  const agentsDir = join(root, "agents");
  if (!existsSync(agentsDir)) return names;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".md")) continue;
    const name = frontmatterName(join(agentsDir, file));
    if (name !== null) names.add(name);
  }
  return names;
}

/** The name of each skill folder of a plugin, sorted: the folders under `skills/` that hold a `SKILL.md`. */
function pluginSkillNames(root: string): string[] {
  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
    .map((entry) => frontmatterName(join(skillsDir, entry.name, "SKILL.md")) ?? entry.name)
    .sort();
}

/** Agent names in the "Available Agents" list of the task tool that the model receives. */
function taskToolAgents(requests: readonly JsonObject[]): string[] | null {
  for (const request of requests) {
    for (const tool of objects(request["tools"])) {
      const fn = isObject(tool["function"]) ? tool["function"] : tool;
      if (fn["name"] !== "task") continue;
      const description = text(fn["description"]);
      if (description !== undefined)
        return [...description.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1] ?? "");
    }
  }
  return null;
}

function stateLogLines(stateDir: string): string[] {
  const logsDir = join(stateDir, "logs");
  if (!existsSync(logsDir)) return [];
  return readdirSync(logsDir)
    .filter((file) => file.endsWith(".log"))
    .flatMap((file) => readFileSync(join(logsDir, file), "utf8").split("\n"));
}

/** The linked kit plugin as omp lists it. */
interface LinkedPlugin {
  /** The `path` of the npm row: the package link under `<state>/plugins/node_modules/`. */
  readonly path: string;
  /** The folder that the link resolves to. */
  readonly realPath: string;
}

/**
 * Folder prefixes of the linked plugin: the package link that omp loads from, the folder it resolves to,
 * and the plugin folder of this checkout.
 */
function pluginRoots(plugin: LinkedPlugin): string[] {
  return [...new Set([plugin.path, plugin.realPath, pluginDir])].map((root) => root + sep);
}

/** Text that marks an omp message as one about the kit plugin: its folders and its package name. */
function pluginMarkers(plugin: LinkedPlugin | null): string[] {
  return [...(plugin === null ? [pluginDir + sep] : pluginRoots(plugin)), PACKAGE_NAME];
}

/**
 * omp warnings about the kit plugin: skill list warnings, warning lines on stderr, and warn/error log records.
 * A "Failed to load extension" record is an error record, so an extension that throws at load counts. The
 * markers cover each extension of the plugin (`hygiene.ts` too), because omp names the file it loads.
 */
function countWarnings(
  skillWarnings: readonly Json[],
  results: readonly OmpResult[],
  stateDir: string,
  markers: readonly string[],
): string[] {
  const mentions = (line: string): boolean => markers.some((marker) => line.includes(marker));
  const warnings = new Set<string>();
  for (const warning of skillWarnings) {
    const line = typeof warning === "string" ? warning : JSON.stringify(warning);
    if (mentions(line)) warnings.add(line);
  }
  for (const result of results) {
    for (const line of result.stderr.split("\n")) {
      if (/warn|error|fail/i.test(line) && mentions(line)) warnings.add(line.trim());
    }
  }
  for (const line of stateLogLines(stateDir)) {
    const record = parseJsonText(line);
    if (!isObject(record)) continue;
    const level = record["level"];
    if (level !== "warn" && level !== "warning" && level !== "error") continue;
    const { timestamp: _timestamp, pid: _pid, ...rest } = record;
    const entry = JSON.stringify(rest);
    if (mentions(entry)) warnings.add(entry);
  }
  return [...warnings];
}

interface OmpOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Gets the process id of the omp process, or undefined when it did not start. */
  readonly onSpawn?: (pid: number | undefined) => void;
}

interface Run {
  readonly isolation: Isolation;
  readonly env: Record<string, string>;
  /** The folder that omp runs in by default. */
  readonly workDir: string;
  readonly requests: JsonObject[];
  readonly script: Script;
  readonly results: OmpResult[];
  readonly omp: (argv: readonly string[], options?: OmpOptions) => Promise<OmpResult>;
  readonly plugin: LinkedPlugin | null;
  /** The modification time of the fresh sweep stamp in the scratch home. */
  readonly sweepStampMtime: number | null;
  /** The default talk registry folder of the user, which the run only reads. */
  readonly defaultRegistry: string;
}

/** The shipped talk bundle and its manifest entry in the kit plugin. */
const TALK_BUNDLE = "talk.js";
const TALK_EXTENSION_ENTRY = `./extensions/${TALK_BUNDLE}`;
const TALK_TOOL = "talk";
/** omp offers each enabled tool to the provider and mounts none as a Bash command, so `talk` is a provider tool. */
const TALK_CONFIG_YAML = "tools:\n  commands: false\n";

/** What a mode changes in the isolated state before omp links the plugin. */
interface InstallSetup {
  /** The model ids that the fake provider offers. */
  readonly modelIds: readonly string[];
  /** The text of `<config root>/agent/config.yml`, or null for no file. */
  readonly configYaml: string | null;
  /** Returns the plugin folder to link; it can make that folder in the scratch folder. */
  readonly pluginFolder: (scratchDir: string, failures: string[]) => string;
}

/** The `hooks` mode: the plugin folder of this checkout and no `config.yml`. */
const DEFAULT_SETUP: InstallSetup = {
  modelIds: [MODEL_ID],
  configYaml: null,
  pluginFolder: () => pluginDir,
};
/** The load mode: as `DEFAULT_SETUP`, and the `talk` tool reaches the first model request as a provider tool. */
const LOAD_SETUP: InstallSetup = { ...DEFAULT_SETUP, configYaml: TALK_CONFIG_YAML };

/**
 * Creates the scratch folder with isolated omp state and the private talk registry folder, starts the fake
 * model, links the kit plugin folder of this checkout (or the folder that `setup` makes), and finds its npm
 * row. Each omp command that exits non-zero adds a failure.
 */
async function install(failures: string[], setup: InstallSetup = DEFAULT_SETUP): Promise<Run> {
  const defaultRegistry = defaultTalkFolder();
  scratch = createScratch();
  const home = join(scratch, "home");
  const isolation: Isolation = {
    home,
    stateDir: join(home, CONFIG_DIR_NAME),
    stateHome: join(scratch, "state"),
    tmpDir: join(scratch, "tmp"),
    registry: privateRegistry(failures),
  };
  const workDir = join(scratch, "work");
  for (const dir of [
    join(isolation.stateDir, "agent"),
    isolation.stateHome,
    isolation.tmpDir,
    workDir,
  ])
    mkdirSync(dir, { recursive: true });
  // A fresh stamp: the `hygiene.ts` session-start sweep (`docks-kit tidy --apply`) is not due, so it does not start.
  const stamp = join(home, ".cache", ...SWEEP_STAMP);
  mkdirSync(dirname(stamp), { recursive: true });
  writeFileSync(stamp, "");
  const env = isolatedEnv(isolation);

  const requests: JsonObject[] = [];
  const script: Script = { turns: [] };
  const fake = await startFakeModel(requests, script);
  server = fake;
  const address = fake.address();
  if (address === null || typeof address === "string")
    throw new Error("the fake model has no TCP port");
  writeFileSync(
    join(isolation.stateDir, "agent", "models.yml"),
    modelsYaml(address.port, setup.modelIds),
  );
  if (setup.configYaml !== null)
    writeFileSync(join(isolation.stateDir, "agent", "config.yml"), setup.configYaml);

  const results: OmpResult[] = [];
  const omp = async (argv: readonly string[], options: OmpOptions = {}): Promise<OmpResult> => {
    const result = await runOmp(argv, options.cwd ?? workDir, options.env ?? env, options.onSpawn);
    results.push(result);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? "";
      failures.push(`omp ${argv.join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  };

  await omp(["plugin", "link", setup.pluginFolder(scratch, failures)]);
  if (!existsSync(join(isolation.stateDir, "plugins")))
    failures.push(`omp kept no plugin state in ${isolation.stateDir}`);
  const pluginList = parseJson(
    (await omp(["plugin", "list", "--json"])).stdout,
    "omp plugin list --json",
    failures,
  );
  const row = objects(pluginList?.["npm"]).find((entry) => entry["name"] === PACKAGE_NAME);
  const path = text(row?.["path"]);
  let plugin: LinkedPlugin | null = null;
  if (path === undefined)
    failures.push(`omp plugin list --json has no npm row ${PACKAGE_NAME} with a path`);
  else if (!existsSync(path)) failures.push(`the ${PACKAGE_NAME} path ${path} does not exist`);
  else plugin = { path, realPath: realpathSync(path) };
  return {
    isolation,
    env,
    workDir,
    requests,
    script,
    results,
    omp,
    plugin,
    sweepStampMtime: mtimeOf(stamp),
    defaultRegistry,
  };
}

/** Problems that show that a kit extension acted outside the scratch state: a started hygiene sweep. */
function isolationProblems(run: Run): string[] {
  const stamp = join(run.isolation.home, ".cache", ...SWEEP_STAMP);
  return mtimeOf(stamp) === run.sweepStampMtime
    ? []
    : [`the hygiene sweep stamp ${stamp} changed, so a sweep started`];
}

function manifestName(failures: string[]): string {
  const manifest = join(pluginDir, "package.json");
  if (!existsSync(manifest)) {
    failures.push(`${manifest} does not exist`);
    return "missing";
  }
  const name =
    text(parseJson(readFileSync(manifest, "utf8"), manifest, failures)?.["name"]) ?? "missing";
  if (name !== PACKAGE_NAME) failures.push(`${manifest} names ${name}, expected ${PACKAGE_NAME}`);
  return name;
}

/**
 * The `omp.extensions` list of the plugin manifest in `root`. A list without the shipped `talk.js` entry, or a
 * plugin without that file, adds a failure.
 */
function talkBundleEntries(root: string, failures: string[]): string[] {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    failures.push(`the manifest ${manifestPath} does not exist`);
    return [];
  }
  const ompField = parseJson(readFileSync(manifestPath, "utf8"), manifestPath, failures)?.["omp"];
  const list = isObject(ompField) ? ompField["extensions"] : undefined;
  const entries = Array.isArray(list)
    ? list.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!entries.includes(TALK_EXTENSION_ENTRY))
    failures.push(`the manifest ${manifestPath} has no entry ${TALK_EXTENSION_ENTRY}`);
  const bundle = join(root, "extensions", TALK_BUNDLE);
  if (!existsSync(bundle)) failures.push(`${bundle} does not exist`);
  return entries;
}

/** The load mode: the linked package, its skills, agents, extension entries, the talk tool, and the warnings. */
async function smoke(): Promise<{ lines: string[]; registry: string | null }> {
  if (!existsSync(pluginDir))
    return { lines: [`FAIL plugin folder ${pluginDir} does not exist`], registry: null };
  const failures: string[] = [];
  const name = manifestName(failures);
  const realBefore = realStateSnapshot();
  const run = await install(failures, LOAD_SETUP);
  const skillList = parseJson(
    (await run.omp(["skill", "list", "--json"])).stdout,
    "omp skill list --json",
    failures,
  );
  let registryCheck = Promise.resolve("session: the omp session did not start");
  await run.omp(
    [
      "-p",
      "--mode",
      "json",
      "--model",
      `${MODEL_PROVIDER}/${MODEL_ID}`,
      "--no-title",
      "--no-session",
      SESSION_PROMPT,
    ],
    {
      onSpawn: (pid) => {
        registryCheck = sessionAttribution(run, "session", pid, run.workDir);
        // The fake model holds the turn until the check ends, so the session is live during the check.
        run.script.hold = registryCheck;
      },
    },
  );
  run.script.hold = undefined;
  const registryProblem = await registryCheck;

  const lines = [`${name} -> ${run.plugin?.realPath ?? "missing"}`];
  let extensions: string[] = [];
  if (run.plugin !== null) {
    if (run.plugin.realPath !== realpathSync(pluginDir))
      failures.push(`${PACKAGE_NAME} resolves to ${run.plugin.realPath}, expected ${pluginDir}`);
    extensions = talkBundleEntries(run.plugin.realPath, failures);
  }

  const roots = run.plugin === null ? [] : pluginRoots(run.plugin);
  const skills = objects(skillList?.["skills"])
    .filter((skill) => {
      const filePath = text(skill["filePath"]);
      return filePath !== undefined && roots.some((root) => filePath.startsWith(root));
    })
    .map((skill) => text(skill["name"]) ?? "(no name)")
    .sort();
  lines.push(`skills: ${skills.length}`, `skill names: ${skills.join(",")}`);
  // The expected skills are the skill folders of the plugin, so a new skill folder needs no change here.
  const shipped = pluginSkillNames(pluginDir);
  if (skills.join(",") !== shipped.join(","))
    failures.push(
      `skills: ${skills.length}, expected the ${shipped.length} skill folders of ${pluginDir}: ${shipped.join(",")}`,
    );
  if (!skills.includes(TALK_SKILL)) failures.push(`the loaded skills do not include ${TALK_SKILL}`);

  const offered = taskToolAgents(run.requests);
  const ownAgents = run.plugin === null ? new Set<string>() : pluginAgentNames(run.plugin.realPath);
  const agents = (offered ?? []).filter((agent) => ownAgents.has(agent)).sort();
  lines.push(`agents: ${agents.join(",")}`);
  if (run.requests.length === 0)
    failures.push("the fake model received no request from the omp session");
  else if (offered === null) failures.push("the model request has no task tool with an agent list");
  const missingAgents = REQUIRED_AGENTS.filter((agent) => !agents.includes(agent));
  if (missingAgents.length > 0)
    failures.push(`agents missing from the task tool: ${missingAgents.join(",")}`);

  lines.push(`extensions: ${extensions.join(",")}`);
  const firstRequest = run.requests[0];
  const talkOffered = firstRequest !== undefined && offersTool(firstRequest, TALK_TOOL);
  lines.push(`talk tool: ${talkOffered ? "offered" : "missing"}`);
  if (firstRequest !== undefined && !talkOffered)
    failures.push(`the first model request does not offer the ${TALK_TOOL} tool`);

  const skillWarnings = Array.isArray(skillList?.["warnings"]) ? skillList["warnings"] : [];
  const warnings = countWarnings(
    skillWarnings,
    run.results,
    run.isolation.stateDir,
    pluginMarkers(run.plugin),
  );
  lines.push(`warnings: ${warnings.length}`);
  if (warnings.length > 0)
    failures.push(
      `omp reported ${warnings.length} warning(s) about the plugin: ${warnings.join(" | ")}`,
    );
  lines.push(checkLine(REGISTRY_CHECK, registryProblem));

  failures.push(...isolationProblems(run), ...realStateChanges(realBefore));
  return {
    lines: [...lines, ...failures.map((failure) => `FAIL ${failure}`)],
    registry: run.isolation.registry,
  };
}

// ---------- hooks ----------

const GATE_REASON = "no Verified: trailer";
const NUDGE_TEXT = "Edited files inside context-tree node(s): scripts";
const NUDGE_PREFIX = "Edited files inside context-tree node(s)";
const BARE_COMMIT = "git commit -m 'docs: fix typo'";
const BARE_SUBJECT = "docs: fix typo";
const TRAILER_COMMIT = "git commit --allow-empty -m 'x' -m 'Verified: none - probe'";
const TRAILER = "Verified: none - probe";
/** The log keeps metadata only; none of these texts of the commands may appear in it. */
const SECRET_TEXTS = ["git commit", "fix typo", "Verified", "probe"];
const LOG_FIELDS = ["cwd", "message_sources", "mode", "session_id", "time"];
/** The `scratch_new` tool description and the reminder after a temporary directory prefer scratch over /tmp. */
const SCRATCH_TOOL_TEXT = "Prefer it over /tmp";
const SCRATCH_REMINDER_TEXT = "Prefer a directory from the `scratch_new` tool";

/** The files of the scratch git repository: a root README.md and a nested `scripts` context-tree node. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "AGENTS.md": "# Rules\n",
  "README.md": "# Smoke repository\n",
  "notes.txt": "notes\n",
  "scripts/AGENTS.md": "# scripts\n",
  "scripts/ci.mjs": "export const ok = true;\n",
};

function bash(id: string, commandText: string): ToolCall[] {
  return [{ id, name: "bash", arguments: { command: commandText } }];
}

function textOf(content: Json | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string" ? part : isObject(part) ? (text(part["text"]) ?? "") : "",
    )
    .join("");
}

/** The snapshot tag of `path` in the result of the read call `readId`, as the model sees it in the request. */
function snapshotTag(request: JsonObject, readId: string, path: string): string {
  const result = objects(request["messages"]).find(
    (message) => message["role"] === "tool" && message["tool_call_id"] === readId,
  );
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return (
    new RegExp(`\\[${escaped}#([0-9A-Za-z]+)\\]`).exec(textOf(result?.["content"]))?.[1] ?? "none"
  );
}

function hashlineEdit(id: string, path: string, tag: string, line: string): ToolCall[] {
  return [{ id, name: "edit", arguments: { input: `[${path}#${tag}]\nPUT 1.=1:\n+${line}\n` } }];
}

/** The messages of an `omp --mode json` event stream, in order. */
function streamMessages(stdout: string): JsonObject[] {
  const messages: JsonObject[] = [];
  for (const line of stdout.split("\n")) {
    const event = parseJsonText(line);
    if (isObject(event) && event["type"] === "message_end" && isObject(event["message"]))
      messages.push(event["message"]);
  }
  return messages;
}

interface CallOutcome {
  readonly isError: boolean;
  readonly text: string;
  /** The texts of the added-context messages that follow the tool result before the next assistant message. */
  readonly context: readonly string[];
}

function callOutcome(messages: readonly JsonObject[], id: string): CallOutcome | null {
  const index = messages.findIndex(
    (message) => message["role"] === "toolResult" && message["toolCallId"] === id,
  );
  const result = messages[index];
  if (result === undefined) return null;
  const context: string[] = [];
  for (const message of messages.slice(index + 1)) {
    if (message["role"] === "assistant") break;
    if (message["role"] === "developer") context.push(textOf(message["content"]));
  }
  return { isError: result["isError"] === true, text: textOf(result["content"]), context };
}

function short(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}...` : flat;
}

function gitIn(cwd: string, env: Record<string, string>, gitArgs: readonly string[]): string {
  const result = spawnSync("git", gitArgs, { cwd, env, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `git ${gitArgs.join(" ")} failed: ${(result.stderr || String(result.error ?? "")).trim()}`,
    );
  return result.stdout;
}

function logLines(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim())
    : [];
}

interface SessionOptions {
  readonly turns: readonly Turn[];
  readonly mode?: string;
  readonly extraArgv?: readonly string[];
}

interface SessionResult {
  readonly messages: JsonObject[];
  readonly log: string;
}

async function hooks(): Promise<{ lines: string[]; registry: string | null }> {
  const checks: string[] = [];
  const check = (name: string, problem: string | null): void => {
    checks.push(checkLine(name, problem ?? ""));
  };
  if (!existsSync(pluginDir)) {
    check("install", `plugin folder ${pluginDir} does not exist`);
    return { lines: checks, registry: null };
  }
  const realBefore = realStateSnapshot();
  const installFailures: string[] = [];
  const run = await install(installFailures);
  check("install", installFailures.join("; "));
  if (scratch === null) throw new Error("the scratch folder is gone");

  // A scratch git repository with its own git config, so no global git setting (signing, hooks) applies.
  const repoDir = join(scratch, "repo");
  const gitConfig = join(scratch, "gitconfig");
  writeFileSync(
    gitConfig,
    "[user]\n\tname = omp smoke\n\temail = omp-smoke@example.invalid\n[commit]\n\tgpgsign = false\n",
  );
  const gitEnv: Record<string, string> = {
    ...run.env,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const [file, content] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(repoDir, file)), { recursive: true });
    writeFileSync(join(repoDir, file), content);
  }
  const git = (...gitArgs: string[]): string => gitIn(repoDir, gitEnv, gitArgs);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: start", "-m", "Verified: none - smoke fixture");
  let change = 0;
  const stageChange = (): void => {
    change += 1;
    writeFileSync(join(repoDir, "notes.txt"), `notes ${change}\n`);
    git("add", "notes.txt");
  };
  const bareCommits = (): number =>
    git("log", "--format=%s")
      .split("\n")
      .filter((subject) => subject === BARE_SUBJECT).length;

  const sessionFailures: string[] = [];
  const registryProblems: string[] = [];
  const stateRoot = run.isolation.stateHome;
  const session = async (
    name: string,
    { turns, mode, extraArgv = [] }: SessionOptions,
  ): Promise<SessionResult> => {
    const env: Record<string, string> = { ...gitEnv, XDG_STATE_HOME: join(stateRoot, name) };
    if (mode !== undefined) env["DOCKS_VERIFY_GATE"] = mode;
    run.script.turns = turns;
    let registryCheck = Promise.resolve(`${name}: the omp session did not start`);
    const result = await run.omp(
      [
        "-p",
        "--mode",
        "json",
        "--model",
        `${MODEL_PROVIDER}/${MODEL_ID}`,
        "--no-title",
        ...extraArgv,
        SCRIPTED_PROMPT,
      ],
      {
        cwd: repoDir,
        env,
        onSpawn: (pid) => {
          registryCheck = sessionAttribution(run, name, pid, repoDir);
          // The fake model holds the first turn until the check ends, so the session is live during the check.
          run.script.hold = registryCheck;
        },
      },
    );
    run.script.turns = [];
    run.script.hold = undefined;
    const registryProblem = await registryCheck;
    if (registryProblem) registryProblems.push(registryProblem);
    if (result.code !== 0)
      sessionFailures.push(
        `${name} session exited ${result.code}: ${short(result.stderr || result.stdout)}`,
      );
    return {
      messages: streamMessages(result.stdout),
      log: join(stateRoot, name, "docks", "verify-gate.jsonl"),
    };
  };

  // Gate, enforce: two bare commits are blocked, the third runs, and a commit with the trailer runs.
  stageChange();
  const bareBefore = bareCommits();
  const enforce = await session("enforce", {
    mode: "enforce",
    turns: [
      bash("enforce-1", BARE_COMMIT),
      bash("enforce-2", BARE_COMMIT),
      bash("enforce-3", BARE_COMMIT),
      bash("enforce-trailer", TRAILER_COMMIT),
    ],
  });
  for (const id of ["enforce-1", "enforce-2"]) {
    const outcome = callOutcome(enforce.messages, id);
    if (!outcome) check(`gate-${id}-blocked`, "no tool result in the event stream");
    else if (!outcome.isError || !outcome.text.includes(GATE_REASON))
      check(`gate-${id}-blocked`, `not blocked with the Verified: reason: ${short(outcome.text)}`);
    else check(`gate-${id}-blocked`, null);
  }
  const third = callOutcome(enforce.messages, "enforce-3");
  const bareAfterEnforce = bareCommits();
  if (!third) check("gate-enforce-3-allowed", "no tool result in the event stream");
  else if (third.isError || third.text.includes(GATE_REASON))
    check("gate-enforce-3-allowed", `the call failed: ${short(third.text)}`);
  else if (bareAfterEnforce !== bareBefore + 1) {
    check(
      "gate-enforce-3-allowed",
      `git log holds ${bareAfterEnforce - bareBefore} new '${BARE_SUBJECT}' commit(s), expected 1`,
    );
  } else check("gate-enforce-3-allowed", null);
  const trailer = callOutcome(enforce.messages, "enforce-trailer");
  if (!trailer) check("gate-enforce-trailer-allowed", "no tool result in the event stream");
  else if (trailer.isError || trailer.text.includes(GATE_REASON))
    check("gate-enforce-trailer-allowed", `the call failed: ${short(trailer.text)}`);
  else if (!git("log", "-1", "--format=%B").includes(TRAILER))
    check("gate-enforce-trailer-allowed", `the last commit has no '${TRAILER}' trailer`);
  else check("gate-enforce-trailer-allowed", null);

  // Gate, observe (DOCKS_VERIFY_GATE unset): the bare commit runs and the log gets one metadata line.
  stageChange();
  const observe = await session("observe", { turns: [bash("observe-1", BARE_COMMIT)] });
  const observed = callOutcome(observe.messages, "observe-1");
  const bareAfterObserve = bareCommits();
  if (!observed) check("gate-observe-commit-runs", "no tool result in the event stream");
  else if (observed.isError)
    check("gate-observe-commit-runs", `the call failed: ${short(observed.text)}`);
  else if (bareAfterObserve !== bareAfterEnforce + 1)
    check("gate-observe-commit-runs", "git log holds no new commit");
  else check("gate-observe-commit-runs", null);
  const observeLines = logLines(observe.log);
  const observeParsed =
    observeLines.length === 1 && observeLines[0] !== undefined
      ? parseJsonText(observeLines[0])
      : undefined;
  const observeRecord = isObject(observeParsed) ? observeParsed : null;
  const observeFields = observeRecord ? Object.keys(observeRecord).sort().join(",") : "";
  if (observeLines.length !== 1)
    check("gate-observe-log", `the log holds ${observeLines.length} line(s), expected 1`);
  else if (observeRecord === null || observeFields !== LOG_FIELDS.join(",")) {
    check(
      "gate-observe-log",
      `the line has the fields ${observeFields || "(not JSON)"}, expected ${LOG_FIELDS.join(",")}`,
    );
  } else if (
    observeRecord["mode"] !== "observe" ||
    JSON.stringify(observeRecord["message_sources"]) !== '["-m"]'
  ) {
    check("gate-observe-log", `unexpected line ${observeLines[0]}`);
  } else check("gate-observe-log", null);

  // Gate, off: the bare commit runs and the log gets no line.
  stageChange();
  const off = await session("off", { mode: "off", turns: [bash("off-1", BARE_COMMIT)] });
  const offOutcome = callOutcome(off.messages, "off-1");
  if (!offOutcome) check("gate-off-commit-runs", "no tool result in the event stream");
  else if (offOutcome.isError)
    check("gate-off-commit-runs", `the call failed: ${short(offOutcome.text)}`);
  else if (bareCommits() !== bareAfterObserve + 1)
    check("gate-off-commit-runs", "git log holds no new commit");
  else check("gate-off-commit-runs", null);
  const offLines = logLines(off.log);
  check(
    "gate-off-no-log",
    offLines.length > 0 ? `the log holds ${offLines.length} line(s), expected none` : null,
  );

  const allLines = [enforce.log, observe.log, off.log].flatMap(logLines);
  const leak = allLines.find((line) => SECRET_TEXTS.some((secret) => line.includes(secret)));
  if (allLines.length === 0) check("gate-log-no-text", "no log line to check");
  else
    check(
      "gate-log-no-text",
      leak === undefined ? null : `a log line holds command or message text: ${leak}`,
    );

  // Nudge: an edit in the `scripts` node adds a context message; an edit of the root README.md, a failed edit,
  // and a write to a URL add none. The session folder lies inside the `scripts` node, so a `local://` write
  // resolves to a file inside the node, and only the URL rule keeps the nudge away.
  const nudge = await session("nudge", {
    extraArgv: ["--session-dir", join(repoDir, "scripts", ".sessions")],
    turns: [
      [{ id: "nudge-read-node", name: "read", arguments: { path: "scripts/ci.mjs" } }],
      (request) =>
        hashlineEdit(
          "nudge-node",
          "scripts/ci.mjs",
          snapshotTag(request, "nudge-read-node", "scripts/ci.mjs"),
          "export const ok = false;",
        ),
      [{ id: "nudge-read-root", name: "read", arguments: { path: "README.md" } }],
      (request) =>
        hashlineEdit(
          "nudge-root",
          "README.md",
          snapshotTag(request, "nudge-read-root", "README.md"),
          "# Smoke repository (edited)",
        ),
      // The tag of the first read is stale after the first edit, so this edit fails.
      (request) =>
        hashlineEdit(
          "nudge-failed",
          "scripts/ci.mjs",
          snapshotTag(request, "nudge-read-node", "scripts/ci.mjs"),
          "export const ok = 0;",
        ),
      [
        {
          id: "nudge-url",
          name: "write",
          arguments: { path: "local://notes.md", content: "notes\n" },
        },
      ],
    ],
  });
  const node = callOutcome(nudge.messages, "nudge-node");
  if (!node) check("nudge-node-edit", "no tool result in the event stream");
  else if (node.isError) check("nudge-node-edit", `the edit failed: ${short(node.text)}`);
  else if (
    node.context.some((line) => line.includes(NUDGE_TEXT)) &&
    !node.text.includes(NUDGE_PREFIX)
  )
    check("nudge-node-edit", null);
  else
    check(
      "nudge-node-edit",
      `no separate added-context message with '${NUDGE_TEXT}' after the tool result`,
    );
  const quiet = (name: string, id: string, expectError: boolean): void => {
    const outcome = callOutcome(nudge.messages, id);
    if (!outcome) return check(name, "no tool result in the event stream");
    if (outcome.isError !== expectError)
      return check(
        name,
        `the call ${expectError ? "did not fail" : "failed"}: ${short(outcome.text)}`,
      );
    const nudged = outcome.context.find((line) => line.includes(NUDGE_PREFIX));
    return check(
      name,
      nudged === undefined ? null : `an added-context message follows: ${short(nudged)}`,
    );
  };
  quiet("nudge-root-edit-none", "nudge-root", false);
  quiet("nudge-failed-edit-none", "nudge-failed", true);
  quiet("nudge-url-write-none", "nudge-url", false);

  // Hygiene: the request lists `scratch_new` as preferred over /tmp, and a `mktemp -d` result gets the reminder.
  const requestsBefore = run.requests.length;
  const hygiene = await session("hygiene", { turns: [bash("hygiene-mktemp", "mktemp -d")] });
  // omp lists an extension tool such as `scratch_new` in the system prompt as "- `<name>` — <description>".
  const scratchLine = run.requests
    .slice(requestsBefore)
    .flatMap((request) => objects(request["messages"]))
    .filter((message) => message["role"] === "system" || message["role"] === "developer")
    .flatMap((message) => textOf(message["content"]).split("\n"))
    .find((line) => line.startsWith("- `scratch_new` — "));
  check(
    "hygiene-scratch-tool",
    scratchLine === undefined
      ? "no request lists the scratch_new tool"
      : scratchLine.includes(SCRATCH_TOOL_TEXT)
        ? null
        : `the scratch_new line lacks '${SCRATCH_TOOL_TEXT}': ${short(scratchLine)}`,
  );
  const temp = callOutcome(hygiene.messages, "hygiene-mktemp");
  if (!temp) check("hygiene-temp-reminder", "no tool result in the event stream");
  else
    check(
      "hygiene-temp-reminder",
      temp.context.some((line) => line.includes(SCRATCH_REMINDER_TEXT))
        ? null
        : `no added-context message with '${SCRATCH_REMINDER_TEXT}' after the tool result`,
    );

  const warnings = countWarnings(
    [],
    run.results,
    run.isolation.stateDir,
    pluginMarkers(run.plugin),
  );
  check(
    "extensions-loaded",
    warnings.length > 0
      ? `omp reported ${warnings.length} warning(s) about the plugin: ${warnings.join(" | ")}`
      : null,
  );
  check("sessions", sessionFailures.join("; "));
  check("isolated", isolationProblems(run).join("; "));
  check("real-state", realStateChanges(realBefore).join("; "));
  check(REGISTRY_CHECK, registryProblems.join("; "));
  return { lines: checks, registry: run.isolation.registry };
}

// ---------- talk ----------

const PEER_MODEL_ID = "talk-peer";
const SENDER_MODEL_ID = "talk-sender";
/** The `customType` of a talk message entry in a session (`TALK_MESSAGE_TYPE` in `cli/talk/tool/host.ts`). */
const TALK_ENTRY_TYPE = "talk";
/** A prompt with this marker makes the fake model hold the peer turn until the cancel check ends. */
const SLOW_MARKER = "SLOW-TURN";
const SLOW_PROMPT = `${SLOW_MARKER}: wait for the driver.`;
/** The reply hint of an ask (`replyHint` in `cli/talk/tool/format.ts`). */
const ASK_HINT = /action "reply", replyTo "([0-9a-f]{16})"/;
/** The id lines of a `send`, `ask`, or `cancel` result (`idLines` in `cli/talk/tool/tool.ts`). */
const MESSAGE_ID_LINE = /^Message id: ([0-9a-f]{16})$/m;
/** A talk message id: 16 lowercase hex digits (`MessageId` in `cli/talk/tool/protocol.ts`). */
const TALK_MESSAGE_ID = /^[0-9a-f]{16}$/;
const INSTANCE_LINE = /^Instance: (\S+)/m;
/**
 * One session line of a `list` result: the own marker, the short session id, and the full instance id. The
 * tool shows peer metadata as code spans (`literal` in `cli/talk/tool/attachments.ts`); a session id has no
 * backtick and no edge space, so its span is one backtick on each side.
 */
const LIST_LINE =
  /^- .* \[[^\]]*\]( \(this session\))?: session `([^`\s]+)`, folder .*, instance ([^\s;]+)/;
const NOT_LIVE_SEND = "the send failed: not-live";
const PONG = "talk smoke pong";
/** The longest wait of one step: a tool call, an RPC command, or a peer state. */
const STEP_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
/** A new registration appears within the 1 s repair timer of talk; the list retries until then. */
const LIST_ATTEMPTS = 20;
const LIST_RETRY_MS = 250;
/** The wait before a check that expects no entry, so that a late append would show. */
const SETTLE_MS = 500;
const PEER_CLOSE_MS = 10_000;
/** The number of session id characters that a `list` line shows. */
const SHORT_ID_LENGTH = 8;

/** The checks of the talk mode, in output order. A check that does not run prints a FAIL line. */
const TALK_CHECKS = [
  "install",
  "talk-offered",
  "talk-list",
  "talk-send",
  "talk-ask-reply",
  "talk-queued",
  "talk-cancel",
  "new-session-list",
  "new-session-send",
  "new-session-old-instance-not-live",
  "fork-list",
  "fork-send",
  "fork-old-instance-not-live",
  "closed-peer-not-live",
  "extensions-loaded",
  "sessions",
  "isolated",
  "real-state",
  REGISTRY_CHECK,
] as const;
type TalkCheck = (typeof TALK_CHECKS)[number];

function sleep(ms: number): Promise<void> {
  const { promise, resolve: done } = Promise.withResolvers<void>();
  setTimeout(done, ms);
  return promise;
}

/** `promise`, or a failure that names `what` when it takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const late = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => late.reject(new Error(`${what} took more than ${ms / 1_000} s`)),
    ms,
  );
  try {
    return await Promise.race([promise, late.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** A promise with the functions that settle it, as `Promise.withResolvers` gives them. */
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
}

function failStep(problem: string): never {
  throw new Error(problem);
}

function offersTool(request: JsonObject, name: string): boolean {
  return objects(request["tools"]).some(
    (tool) => (isObject(tool["function"]) ? tool["function"] : tool)["name"] === name,
  );
}

/** The text of the tool result of call `id` in a request, as the model sees it. */
function toolResultText(request: JsonObject, id: string): string | undefined {
  const result = objects(request["messages"]).find(
    (message) => message["role"] === "tool" && message["tool_call_id"] === id,
  );
  return result === undefined ? undefined : textOf(result["content"]);
}

/**
 * The text of the user messages after the last assistant message, which start this turn; a talk message
 * reaches the provider as a user message. Undefined when a tool result continues the turn.
 */
function newUserText(request: JsonObject): string | undefined {
  const messages = objects(request["messages"]);
  const lastAssistant = messages.map((message) => message["role"]).lastIndexOf("assistant");
  const fresh = messages.slice(lastAssistant + 1).filter((message) => message["role"] === "user");
  return fresh.length === 0
    ? undefined
    : fresh.map((message) => textOf(message["content"])).join("\n");
}

/**
 * A session whose model turns this program writes: each `call` becomes the next tool call of the session,
 * and gives the tool result that the following request of the session carries.
 */
class ScriptedSession {
  readonly #label: string;
  readonly #first = Promise.withResolvers<JsonObject>();
  #next = Promise.withResolvers<ToolCall | null>();
  #pending: { readonly id: string; readonly result: Deferred<string> } | null = null;
  #started = false;
  #ended: Error | null = null;
  #count = 0;

  constructor(label: string) {
    this.#label = label;
    this.#first.promise.catch(() => undefined);
  }

  /** The first provider request of the session. */
  get firstRequest(): Promise<JsonObject> {
    return this.#first.promise;
  }

  async respond(request: JsonObject): Promise<readonly ToolCall[]> {
    if (!this.#started) {
      this.#started = true;
      this.#first.resolve(request);
    }
    const pending = this.#pending;
    if (pending !== null) {
      this.#pending = null;
      const result = toolResultText(request, pending.id);
      if (result === undefined)
        pending.result.reject(
          new Error(`the next request of ${this.#label} holds no result of the call ${pending.id}`),
        );
      else pending.result.resolve(result);
    }
    const call = await this.#next.promise;
    this.#next = Promise.withResolvers();
    return call === null ? [] : [call];
  }

  /** Makes the next turn of the session call `name` with `args`; gives the text of its tool result. */
  call(name: string, toolArgs: Readonly<Record<string, string>>): Promise<string> {
    if (this.#ended !== null) return Promise.reject(this.#ended);
    this.#count += 1;
    const id = `${this.#label}-${this.#count}`;
    const result = Promise.withResolvers<string>();
    this.#pending = { id, result };
    this.#next.resolve({ id, name, arguments: toolArgs });
    return withTimeout(
      result.promise,
      STEP_TIMEOUT_MS,
      `the ${toolArgs["action"] ?? name} call ${id}`,
    );
  }

  /** Ends the script: the next turn answers "ok" without a tool call, so the session ends. */
  finish(): void {
    this.#next.resolve(null);
  }

  /** The omp process exited: a call that waits fails at once. */
  abort(reason: string): void {
    this.#ended = new Error(reason);
    this.#first.reject(this.#ended);
    this.#pending?.result.reject(this.#ended);
    this.#pending = null;
  }
}

/** The fake model of the peer: it replies to an ask, holds the slow turn, and else answers "ok". */
class PeerModel {
  readonly #first = Promise.withResolvers<JsonObject>();
  readonly #slowStarted = Promise.withResolvers<void>();
  readonly #release = Promise.withResolvers<void>();
  #started = false;

  get firstRequest(): Promise<JsonObject> {
    return this.#first.promise;
  }

  /** Resolves when the fake model holds the slow turn, so the peer is busy. */
  get slowStarted(): Promise<void> {
    return this.#slowStarted.promise;
  }

  /** Ends the slow turn. */
  release(): void {
    this.#release.resolve();
  }

  async respond(request: JsonObject): Promise<readonly ToolCall[]> {
    if (!this.#started) {
      this.#started = true;
      this.#first.resolve(request);
    }
    const prompt = newUserText(request);
    if (prompt === undefined) return [];
    if (prompt.includes(SLOW_MARKER)) {
      this.#slowStarted.resolve();
      await withTimeout(this.#release.promise, STEP_TIMEOUT_MS, "the slow turn").catch(
        () => undefined,
      );
      return [];
    }
    const askId = ASK_HINT.exec(prompt)?.[1];
    return askId === undefined
      ? []
      : [
          {
            id: `peer-reply-${askId}`,
            name: TALK_TOOL,
            arguments: { action: "reply", replyTo: askId, message: `${PONG} ${askId}` },
          },
        ];
  }
}

/** An omp process in RPC mode: one JSON command per stdin line, one JSON response or event per stdout line. */
interface RpcPeer {
  /** The process id of the omp process, or undefined when it did not start. */
  readonly pid: number | undefined;
  /** Sends a command; gives the `data` of a response with `success: true`, and fails on any other response. */
  readonly send: (command: JsonObject) => Promise<Json>;
  /** Ends stdin and waits for the exit; SIGTERM, then SIGKILL, when omp does not exit in time. */
  readonly close: () => Promise<OmpResult>;
}

async function startRpcOmp(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RpcPeer> {
  const child = spawn(ompBinary, argv, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let stderr = "";
  let next = 0;
  const waiting = new Map<string, Deferred<Json>>();
  const ready = Promise.withResolvers<void>();
  ready.promise.catch(() => undefined);
  const exited = Promise.withResolvers<number | null>();
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    stderr += String(error);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = parseJsonText(line);
    if (!isObject(message)) return;
    if (message["type"] === "ready") ready.resolve();
    const id = message["id"];
    if (message["type"] !== "response" || typeof id !== "string") return;
    const reply = waiting.get(id);
    if (reply === undefined) return;
    waiting.delete(id);
    if (message["success"] !== true)
      reply.reject(
        new Error(
          `RPC ${String(message["command"])} failed: ${JSON.stringify(message["error"] ?? null)}`,
        ),
      );
    else reply.resolve(message["data"] ?? null);
  });
  child.on("close", (code) => {
    children.delete(child);
    const gone = new Error(`the peer omp exited ${code}: ${short(stderr)}`);
    for (const reply of waiting.values()) reply.reject(gone);
    waiting.clear();
    ready.reject(gone);
    exited.resolve(code);
  });
  await withTimeout(ready.promise, STEP_TIMEOUT_MS, "the ready line of the peer omp");

  const send = (rpcCommand: JsonObject): Promise<Json> => {
    next += 1;
    const id = `smoke-${next}`;
    const reply = Promise.withResolvers<Json>();
    waiting.set(id, reply);
    child.stdin.write(`${JSON.stringify({ id, ...rpcCommand })}\n`);
    return withTimeout(reply.promise, STEP_TIMEOUT_MS, `RPC ${String(rpcCommand["type"])}`);
  };
  const exitWithin = (ms: number): Promise<number | null | undefined> =>
    withTimeout(exited.promise, ms, "the exit").catch(() => undefined);
  const close = async (): Promise<OmpResult> => {
    child.stdin.end();
    let code = await exitWithin(PEER_CLOSE_MS);
    if (code === undefined) {
      child.kill("SIGTERM");
      code = await exitWithin(PEER_CLOSE_MS);
    }
    if (code === undefined) {
      child.kill("SIGKILL");
      code = await exited.promise;
    }
    return { argv, code, stdout: "", stderr };
  };
  return { pid: child.pid, send, close };
}

/**
 * Copies the kit plugin folder, with the shipped `talk.js` and its manifest entry, to the scratch folder.
 * Returns the copy, which omp links. The copy keeps each symbolic link as it is, so a relative link does not
 * point into the source folder. A copy without the bundle or its entry adds a failure.
 */
function talkPluginCopy(scratchDir: string, failures: string[]): string {
  const copy = join(scratchDir, "plugin");
  cpSync(pluginDir, copy, { recursive: true, verbatimSymlinks: true });
  talkBundleEntries(copy, failures);
  return copy;
}

interface ListedSession {
  readonly own: boolean;
  readonly shortId: string;
  readonly instance: string;
}

function listedSessions(listing: string): ListedSession[] {
  return listing.split("\n").flatMap((line) => {
    const match = LIST_LINE.exec(line);
    return match === null
      ? []
      : [{ own: match[1] !== undefined, shortId: match[2] ?? "", instance: match[3] ?? "" }];
  });
}

/** The message id and the instance id that a `send`, `ask`, or `cancel` result names. */
function resultIds(result: string): { readonly messageId: string; readonly instance: string } {
  const messageId = MESSAGE_ID_LINE.exec(result)?.[1];
  const instance = INSTANCE_LINE.exec(result)?.[1];
  if (messageId === undefined || instance === undefined)
    return failStep(`the result names no message id and instance: ${short(result)}`);
  return { messageId, instance };
}

function isAssistantEntry(entry: JsonObject): boolean {
  const message = entry["message"];
  return entry["type"] === "message" && isObject(message) && message["role"] === "assistant";
}

/** The `details.messageId` of a talk message entry, else undefined. */
function talkMessageId(entry: JsonObject): string | undefined {
  const details = entry["details"];
  return entry["type"] === "custom_message" &&
    entry["customType"] === TALK_ENTRY_TYPE &&
    isObject(details)
    ? text(details["messageId"])
    : undefined;
}

/** The index of the talk message entry whose `details.messageId` is `messageId`, else -1. */
function talkEntryIndex(entries: readonly JsonObject[], messageId: string): number {
  return entries.findIndex((entry) => talkMessageId(entry) === messageId);
}

/** Whether an entry holds, in any field, the message id or the payload text of a message. */
function mentionsMessage(
  entries: readonly JsonObject[],
  messageId: string,
  payload: string,
): boolean {
  const escaped = JSON.stringify(payload).slice(1, -1);
  return entries.some((entry) => {
    const serialized = JSON.stringify(entry);
    return serialized.includes(messageId) || serialized.includes(escaped);
  });
}

/**
 * One RPC `get_entries` answer of the peer, checked. `get_entries` without a cursor gives every entry of the
 * session in append order (omp `rpc-compat.ts` v19.2.1:3-19); `parents` maps each entry id to its `parentId`.
 */
interface EntriesAnswer {
  readonly entries: readonly JsonObject[];
  readonly leafId: string;
  readonly parents: ReadonlyMap<string, string | null>;
}

/**
 * Checks the `data` of a `get_entries` response (`RpcPeer.send` already requires `success: true`): a
 * `leafId` that names an entry; each entry with a string `id`, a string `type`, and a `parentId` that is
 * `null` (the root) or names another entry of the answer; each `custom_message` with a string `customType`
 * and a string or array `content`; each talk entry with a string `content` and `details` whose `messageId`
 * is a talk message id.
 */
function checkedEntries(data: Json): EntriesAnswer {
  const bad = (problem: string): never => failStep(`RPC get_entries gives ${problem}`);
  const entries = isObject(data) ? data["entries"] : undefined;
  if (!isObject(data) || !Array.isArray(entries) || !entries.every(isObject))
    return bad(`no array of entry objects: ${short(JSON.stringify(data))}`);
  const parents = new Map<string, string | null>();
  for (const entry of entries) {
    const id = text(entry["id"]);
    if (id === undefined || text(entry["type"]) === undefined || parents.has(id))
      return bad(`an entry without a unique id and a type: ${short(JSON.stringify(entry))}`);
    const parentId = entry["parentId"];
    if (parentId !== null && (typeof parentId !== "string" || parentId === id))
      return bad(`the entry ${id} a parentId that is not null or another id`);
    parents.set(id, parentId);
  }
  for (const entry of entries) {
    const id = String(entry["id"]);
    const parentId = entry["parentId"];
    if (typeof parentId === "string" && !parents.has(parentId))
      return bad(`the entry ${id} the parent ${parentId}, which it does not hold`);
    if (entry["type"] !== "custom_message") continue;
    const content = entry["content"];
    if (
      text(entry["customType"]) === undefined ||
      (typeof content !== "string" && !Array.isArray(content))
    )
      return bad(`the custom message ${id} without a customType and a content`);
    if (entry["customType"] !== TALK_ENTRY_TYPE) continue;
    const details = entry["details"];
    const messageId = isObject(details) ? text(details["messageId"]) : undefined;
    if (typeof content !== "string" || messageId === undefined || !TALK_MESSAGE_ID.test(messageId))
      return bad(`the talk entry ${id} without a text content and a message id`);
  }
  const leafId = text(data["leafId"]);
  if (leafId === undefined || !parents.has(leafId))
    return bad(`a leafId that names no entry: ${short(JSON.stringify(data["leafId"] ?? null))}`);
  return { entries, leafId, parents };
}

/** The ids of the entries on the parent chain from the leaf to the root. */
function leafChain(answer: EntriesAnswer): Set<string> {
  const chain = new Set<string>();
  let id: string | null | undefined = answer.leafId;
  while (typeof id === "string") {
    if (chain.has(id)) return failStep(`RPC get_entries gives a parent cycle at the entry ${id}`);
    chain.add(id);
    id = answer.parents.get(id);
  }
  return chain;
}

/**
 * Fails unless `later` continues the history of `kept`: every kept entry is there again with the same
 * `parentId`, every kept talk entry is there again as a talk entry with the same `details.messageId` and
 * `content`, and the parent chain from the leaf of `later` holds the talk entry of `sentinel` and the leaf of
 * `kept`. Only such an answer can prove the absence of an entry (#251 G9 (1)).
 */
function expectContinues(kept: EntriesAnswer, later: EntriesAnswer, sentinel: string): void {
  for (const [id, parentId] of kept.parents)
    if (!later.parents.has(id) || later.parents.get(id) !== parentId)
      failStep(`RPC get_entries dropped or moved the entry ${id} of an earlier answer`);
  for (const entry of kept.entries) {
    const messageId = talkMessageId(entry);
    if (messageId === undefined) continue;
    const again = later.entries.find((other) => other["id"] === entry["id"]);
    if (
      again === undefined ||
      talkMessageId(again) !== messageId ||
      again["content"] !== entry["content"]
    )
      failStep(
        `RPC get_entries no longer holds the talk message ${messageId} in the entry ${String(entry["id"])}`,
      );
  }
  const chain = leafChain(later);
  if (!chain.has(kept.leafId))
    failStep(`the leaf ${later.leafId} does not descend from the earlier leaf ${kept.leafId}`);
  const sentinelEntry = text(later.entries[talkEntryIndex(later.entries, sentinel)]?.["id"]);
  if (sentinelEntry === undefined || !chain.has(sentinelEntry))
    failStep(`the parent chain of the leaf ${later.leafId} holds no entry of message ${sentinel}`);
}

/** The talk mode (#250 E13): two isolated omp processes that talk through a private registry folder. */
async function talkMode(): Promise<{ lines: string[]; registry: string | null }> {
  const results = new Map<TalkCheck, string>();
  const lines = (): string[] =>
    TALK_CHECKS.map((name) => {
      const problem = results.get(name);
      return checkLine(name, problem ?? "not run, because an earlier check failed");
    });
  if (!existsSync(pluginDir)) {
    results.set("install", `plugin folder ${pluginDir} does not exist`);
    return { lines: lines(), registry: null };
  }
  const realBefore = realStateSnapshot();
  const installFailures: string[] = [];
  const run = await install(installFailures, {
    modelIds: [PEER_MODEL_ID, SENDER_MODEL_ID],
    configYaml: TALK_CONFIG_YAML,
    pluginFolder: talkPluginCopy,
  });
  const registry = run.isolation.registry;
  results.set("install", installFailures.join("; "));
  if (installFailures.length > 0) return { lines: lines(), registry };

  const peerModel = new PeerModel();
  const sender = new ScriptedSession(SENDER_MODEL_ID);
  run.script.respond = (request) =>
    request["model"] === PEER_MODEL_ID
      ? peerModel.respond(request)
      : request["model"] === SENDER_MODEL_ID
        ? sender.respond(request)
        : Promise.resolve([]);

  let step: TalkCheck = "talk-offered";
  const pass = (): void => {
    results.set(step, "");
  };
  let peer: RpcPeer | null = null;
  let peerResult: OmpResult | null = null;
  let senderRun: Promise<OmpResult> | null = null;
  try {
    // The peer: omp in RPC mode. Its first provider turn answers the driver's prompt.
    const rpc = await startRpcOmp(
      ["--mode", "rpc", "--model", `${MODEL_PROVIDER}/${PEER_MODEL_ID}`, "--no-title"],
      run.workDir,
      run.env,
    );
    peer = rpc;
    const peerRegistry = sessionAttribution(run, "peer", rpc.pid, run.workDir);
    const peerState = async (): Promise<JsonObject> => {
      const data = await rpc.send({ type: "get_state" });
      return isObject(data) ? data : {};
    };
    const peerSessionId = async (): Promise<string> =>
      text((await peerState())["sessionId"]) ?? failStep("RPC get_state gives no sessionId");
    // RPC get_entries without a cursor gives `{ entries, leafId }`: every entry of the current session.
    const peerAnswer = async (): Promise<EntriesAnswer> =>
      checkedEntries(await rpc.send({ type: "get_entries" }));
    const waitFor = async (what: string, probe: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (!(await probe())) {
        if (Date.now() > deadline) failStep(`no ${what} within ${STEP_TIMEOUT_MS / 1_000} s`);
        await sleep(POLL_MS);
      }
    };
    const waitPeerIdle = (): Promise<void> =>
      waitFor("idle peer", async () => (await peerState())["isStreaming"] === false);
    /**
     * A `send` result that reads `Delivered`, whose entry the peer session holds; waits for the turn that it
     * starts. Gives the message id and the answer of the idle peer, which holds the entry.
     */
    const expectDelivered = async (
      result: string,
      instance: string,
    ): Promise<{ readonly messageId: string; readonly answer: EntriesAnswer }> => {
      if (!result.includes("Delivered:"))
        failStep(`the send did not read Delivered: ${short(result)}`);
      const ids = resultIds(result);
      if (ids.instance !== instance)
        failStep(`the send reached instance ${ids.instance}, expected ${instance}`);
      await waitFor(`entry of message ${ids.messageId} with an answer after it`, async () => {
        const { entries } = await peerAnswer();
        const at = talkEntryIndex(entries, ids.messageId);
        return at >= 0 && entries.slice(at + 1).some(isAssistantEntry);
      });
      await waitPeerIdle();
      const answer = await peerAnswer();
      if (talkEntryIndex(answer.entries, ids.messageId) < 0)
        failStep(`RPC get_entries of the idle peer lost the message ${ids.messageId}`);
      return { messageId: ids.messageId, answer };
    };
    /**
     * The absence check of #251 G9 (1). `kept` is the last checked answer of the session, which holds a
     * confirmed delivery. After the step that must not deliver, a fresh sentinel message goes to
     * `instance`, the same session; the answer that holds it must continue `kept`, and only then does the
     * absence of `messageId` and `payload` count.
     */
    const expectAbsent = async (
      kept: EntriesAnswer,
      instance: string,
      messageId: string,
      payload: string,
    ): Promise<void> => {
      const sentinel = await expectDelivered(
        await sender.call(TALK_TOOL, {
          action: "send",
          instance,
          message: `talk smoke: sentinel after ${step}`,
        }),
        instance,
      );
      expectContinues(kept, sentinel.answer, sentinel.messageId);
      if (mentionsMessage(sentinel.answer.entries, messageId, payload))
        failStep(`the peer session holds the message ${messageId} or its text`);
    };
    /** Lists until a session line shows `sessionId` with an instance that is not in `ended`; gives that instance. */
    const listUntil = async (sessionId: string, ended: readonly string[]): Promise<string> => {
      const shortId = sessionId.slice(0, SHORT_ID_LENGTH);
      for (let attempt = 1; ; attempt += 1) {
        const listing = await sender.call(TALK_TOOL, { action: "list" });
        const sessions = listedSessions(listing);
        const found = sessions.find(
          (session) =>
            !session.own && session.shortId === shortId && !ended.includes(session.instance),
        );
        if (found !== undefined) {
          const stale = sessions.find((session) => ended.includes(session.instance));
          if (stale !== undefined)
            failStep(`the list still shows the ended instance ${stale.instance}`);
          return found.instance;
        }
        if (attempt >= LIST_ATTEMPTS)
          failStep(
            `${attempt} lists show no new instance of session ${shortId}: ${short(listing)}`,
          );
        await sleep(LIST_RETRY_MS);
      }
    };

    await rpc.send({ type: "prompt", message: SESSION_PROMPT });
    const peerFirst = await withTimeout(
      peerModel.firstRequest,
      STEP_TIMEOUT_MS,
      "the first request of the peer",
    );
    if (!offersTool(peerFirst, TALK_TOOL))
      failStep("the first provider request of the peer does not offer the talk tool");
    await waitPeerIdle();
    // The sender: omp in print mode. Each of its turns waits for this program.
    let senderRegistry = Promise.resolve("sender: the omp session did not start");
    const senderStarted = run.omp(
      [
        "-p",
        "--mode",
        "json",
        "--model",
        `${MODEL_PROVIDER}/${SENDER_MODEL_ID}`,
        "--no-title",
        SCRIPTED_PROMPT,
      ],
      {
        onSpawn: (pid) => {
          senderRegistry = sessionAttribution(run, "sender", pid, run.workDir);
        },
      },
    );
    senderRun = senderStarted;
    void senderStarted.then((result) => sender.abort(`the sender omp exited ${result.code}`));
    const senderFirst = await withTimeout(
      sender.firstRequest,
      STEP_TIMEOUT_MS,
      "the first request of the sender",
    );
    if (!offersTool(senderFirst, TALK_TOOL))
      failStep("the first provider request of the sender does not offer the talk tool");
    pass();
    // Both omp processes are live: the peer waits for RPC commands, and the sender waits in its first turn.
    results.set(REGISTRY_CHECK, await attributionProblem([peerRegistry, senderRegistry]));

    step = "talk-list";
    const firstSession = await peerSessionId();
    const firstInstance = await listUntil(firstSession, []);
    pass();

    step = "talk-send";
    const hello = await expectDelivered(
      await sender.call(TALK_TOOL, {
        action: "send",
        to: firstSession,
        message: "talk smoke: hello",
      }),
      firstInstance,
    );
    pass();

    step = "talk-ask-reply";
    const answer = await sender.call(TALK_TOOL, {
      action: "ask",
      instance: firstInstance,
      message: "talk smoke: ping",
    });
    const askId = resultIds(answer).messageId;
    if (!answer.includes("**Reply from ") || !answer.includes(`${PONG} ${askId}`))
      failStep(`the ask result holds no reply to ask ${askId}: ${short(answer)}`);
    await waitPeerIdle();
    pass();

    // The fake model holds the slow peer turn, so the peer is busy until the cancel check releases it.
    step = "talk-queued";
    const slow = rpc.send({ type: "prompt", message: SLOW_PROMPT });
    slow.catch(() => undefined);
    await withTimeout(peerModel.slowStarted, STEP_TIMEOUT_MS, "the slow peer turn");
    const queuedText = "talk smoke: while busy";
    const queuedResult = await sender.call(TALK_TOOL, {
      action: "send",
      instance: firstInstance,
      message: queuedText,
    });
    if (!queuedResult.includes("Queued:"))
      failStep(`the send to the busy peer did not read Queued: ${short(queuedResult)}`);
    const queued = resultIds(queuedResult);
    if (queued.instance !== firstInstance)
      failStep(`the send reached instance ${queued.instance}, expected ${firstInstance}`);
    pass();

    step = "talk-cancel";
    const cancelResult = await sender.call(TALK_TOOL, {
      action: "cancel",
      instance: queued.instance,
      messageId: queued.messageId,
    });
    if (
      !cancelResult.includes("Cancelled:") ||
      resultIds(cancelResult).messageId !== queued.messageId
    )
      failStep(
        `the cancel of message ${queued.messageId} did not read Cancelled: ${short(cancelResult)}`,
      );
    peerModel.release();
    await slow;
    await waitPeerIdle();
    await sleep(SETTLE_MS);
    await expectAbsent(hello.answer, firstInstance, queued.messageId, queuedText);
    pass();

    /**
     * One session change of the live peer: the list shows the new session id with a new instance, a send to
     * the new id is delivered, and a fresh send to the old instance reads not-live and adds no entry to the new
     * session, whose entries keep `inherited` when it is set. The answer that confirmed the delivery to the
     * new session is the kept answer of the absence check.
     */
    const change = async (
      prefix: "new-session" | "fork",
      rpcCommand: JsonObject,
      before: { readonly sessionId: string; readonly instance: string },
      inherited: string | null,
    ): Promise<{ sessionId: string; instance: string; delivered: string }> => {
      step = `${prefix}-list`;
      const changed = await rpc.send(rpcCommand);
      if (isObject(changed) && changed["cancelled"] === true)
        failStep(`RPC ${String(rpcCommand["type"])} was cancelled`);
      const sessionId = await peerSessionId();
      if (sessionId === before.sessionId)
        failStep(`RPC ${String(rpcCommand["type"])} kept the session id ${sessionId}`);
      const instance = await listUntil(sessionId, [before.instance]);
      pass();

      step = `${prefix}-send`;
      const delivered = await expectDelivered(
        await sender.call(TALK_TOOL, {
          action: "send",
          to: sessionId,
          message: `talk smoke: hello after ${prefix}`,
        }),
        instance,
      );
      pass();

      step = `${prefix}-old-instance-not-live`;
      if (inherited !== null && talkEntryIndex(delivered.answer.entries, inherited) < 0)
        failStep(`RPC get_entries of session ${sessionId} lost the inherited message ${inherited}`);
      const staleText = `talk smoke: to the instance before ${prefix}`;
      const stale = await sender.call(TALK_TOOL, {
        action: "send",
        instance: before.instance,
        message: staleText,
      });
      if (!stale.includes(NOT_LIVE_SEND))
        failStep(`the send to the old instance did not fail not-live: ${short(stale)}`);
      const staleId = resultIds(stale).messageId;
      await sleep(SETTLE_MS);
      await expectAbsent(delivered.answer, instance, staleId, staleText);
      const current = await peerSessionId();
      if (current !== sessionId) failStep(`the peer moved to session ${current}`);
      pass();
      return { sessionId, instance, delivered: delivered.messageId };
    };

    const afterNew = await change(
      "new-session",
      { type: "new_session" },
      { sessionId: firstSession, instance: firstInstance },
      null,
    );
    step = "fork-list";
    const forkAt = text((await peerAnswer()).entries.filter(isAssistantEntry).at(-1)?.["id"]);
    if (forkAt === undefined) failStep("the peer session has no assistant message to fork at");
    const afterFork = await change(
      "fork",
      { type: "fork", entryId: forkAt },
      afterNew,
      afterNew.delivered,
    );

    step = "closed-peer-not-live";
    peerResult = await rpc.close();
    const closed = await sender.call(TALK_TOOL, {
      action: "send",
      instance: afterFork.instance,
      message: "talk smoke: to the closed peer",
    });
    if (!closed.includes(NOT_LIVE_SEND))
      failStep(`the send to the closed peer did not fail not-live: ${short(closed)}`);
    pass();
  } catch (error) {
    results.set(step, error instanceof Error ? error.message : String(error));
  }

  // The sender ends after its next turn, and a slow peer turn that still waits ends; a sender that still
  // waits in a tool call is stopped.
  sender.finish();
  peerModel.release();
  if (peer !== null && peerResult === null) peerResult = await peer.close();
  const senderResult =
    senderRun === null
      ? null
      : await withTimeout(senderRun, PEER_CLOSE_MS, "the sender exit").catch(() => {
          for (const child of children) child.kill("SIGKILL");
          return senderRun;
        });
  const sessionFailures: string[] = [];
  for (const [name, result] of [
    ["sender", senderResult],
    ["peer", peerResult],
  ] as const) {
    if (result === null) sessionFailures.push(`the ${name} omp did not run`);
    else if (result.code !== 0)
      sessionFailures.push(
        `the ${name} omp exited ${result.code}: ${short(result.stderr || result.stdout)}`,
      );
  }
  if (peerResult !== null) run.results.push(peerResult);
  const warnings = countWarnings(
    [],
    run.results,
    run.isolation.stateDir,
    pluginMarkers(run.plugin),
  );
  results.set(
    "extensions-loaded",
    warnings.length > 0
      ? `omp reported ${warnings.length} warning(s) about the plugin: ${warnings.join(" | ")}`
      : "",
  );
  results.set("sessions", sessionFailures.join("; "));
  results.set("isolated", isolationProblems(run).join("; "));
  results.set("real-state", realStateChanges(realBefore).join("; "));
  return { lines: lines(), registry };
}

// ---------- talk-ui ----------

/** The model id of the omp in the pseudo-terminal. */
const UI_MODEL_ID = "talk-ui";
/** The talk config, and no first-run setup wizard (#251 F8), update check, or marketplace update. */
const UI_CONFIG_YAML = `${TALK_CONFIG_YAML}startup:\n  setupWizard: false\n  checkUpdate: false\nmarketplace:\n  autoUpdate: "off"\n`;
/** The first omp release with the reactive UI of talk (`OMP_VERSION_NEEDED` in `cli/talk/extension.ts`). */
const UI_OMP_NEEDED = "19.2.0";
const OMP_VERSION = /\bomp\/(\d+)\.(\d+)\.(\d+)\b/;
/** The pseudo-terminal: wide enough for the card header with the scratch folder, and for the notice. */
const TERMINAL_TYPE = "xterm-256color";
const TERMINAL_COLUMNS = 240;
const TERMINAL_ROWS = 50;
/**
 * The narrow pane of the resize check: one column and a few rows. The resize view shows its symbol cue in place
 * of a word below 4 columns (`RESIZE_TEXTS` in `cli/talk/ui/views.ts`); at one column the cue shows only when
 * omp measures it as one cell, so this pane also checks the width of the cue in the real omp.
 */
const NARROW_COLUMNS = 1;
const NARROW_ROWS = 6;
/** The resize cue of omp's default `unicode` symbol preset (`RESIZE_SYMBOLS` in `cli/talk/ui/views.ts`). */
const RESIZE_CUE = "⤢";
/** The footer shows the name of the fake model when the session has started (#251 F8). */
const UI_READY_TEXT = "omp smoke fake model";
/** `alt+t` as `ESC t` in one write (#251 F2); a lone ESC becomes the Escape key after 20 ms. */
const ALT_T_KEY = "\x1bt";
const ENTER_KEY = "\r";
const CTRL_S_KEY = "\x13";
/** `ctrl+d` on an empty editor exits omp with code 0 (#251 F8). */
const CTRL_D_KEY = "\x04";
/** The title of the list view (`LIST_TITLE` in `cli/talk/ui/views.ts`). */
const LIST_TITLE_TEXT = "talk sessions";
/** The placeholder of the compose view (`composeView` in `cli/talk/ui/views.ts`). */
const COMPOSE_PLACEHOLDER = "the message; ⏎ confirms the destination";
/** The first line of the confirm view (`confirmLine` in `cli/talk/ui/views.ts`): the instance id and the code. */
const CONFIRM_LINE = /Send to (\S+): type ([a-z])([a-z])/;
const COMPOSED_TEXT = "talk-ui smoke: composed hello";
/** The peer message of the card check: four lines, so the collapsed card hides one (#251 G5). */
const CARD_LINES = [
  "talk-ui card line 1",
  "talk-ui card line 2",
  "talk-ui card line 3",
  "talk-ui card line 4",
];
/** The last row of a collapsed card that hides one line; omp's default card does not draw it. */
const CARD_MORE = "… 1 more lines";
/**
 * The card header (`makeTalkCardRenderer` in `cli/talk/ui/card.ts`): the name and the folder are code spans
 * (`literal`), then the local time.
 */
const CARD_HEADER = /talk message from `[^`\n]+` · `([^`\n]+)` · \d\d:\d\d/;
/** The first line of the handover template (`HANDOVER_PROMPT` in `cli/talk/ui/handover.ts`). */
const HANDOVER_PROMPT_TEXT = "Write a handover of the work in this session";
/** The reply of the fake model to the handover side turn, and the text that the flow types before it. */
const HANDOVER_DRAFT = "talk-ui smoke draft: run the next check.\nRisks: none.";
const HANDOVER_EDIT = "edited ";
const HANDOVER_KIND = "handover";
/** The start and the end of the capability notice (`capabilityNotice` in `cli/talk/extension.ts`). */
const CAPABILITY_NOTICE_START = "talk: this omp has no ";
const CAPABILITY_NOTICE_END = `talk needs omp ${UI_OMP_NEEDED} or later, so the talk tool is off.`;
/** A talk notice on the screen: `talk:` and the rest of its row. */
const TALK_NOTICE = /talk: [^\n]*/g;

/** The talk notices of one frame, each one the rest of its row from `talk:`, trimmed. */
function talkNotices(frame: string): string[] {
  return [...frame.matchAll(TALK_NOTICE)].map((match) => match[0].trim());
}

/**
 * Whether one extracted notice is the whole capability notice: its start and its end on the same row. The
 * readiness wait and the final check of `old-notice` both use it, so two rows that each hold one part never
 * count as the notice.
 */
function isCapabilityNotice(notice: string): boolean {
  return notice.startsWith(CAPABILITY_NOTICE_START) && notice.endsWith(CAPABILITY_NOTICE_END);
}

/** The quiet time after which the smoke takes the output of the TUI omp as drained (no open frame either). */
const DRAIN_QUIET_MS = 1_000;
/** A built-in tool of omp: a request that offers it has a tool list that `offersTool` can read. */
const BUILTIN_TOOL = "read";
/** A prompt with one of these markers makes the fake model of the RPC peer call `talk` once. */
const PEER_LIST_MARKER = "SMOKE-LIST";
const PEER_CARD_MARKER = "SMOKE-CARD";

/** The checks of the talk-ui mode on omp 19.2.0 or later, in output order. */
const UI_CHECKS = [
  "install",
  "ui-ready",
  "ui-list",
  "ui-resize",
  "ui-compose-send",
  "ui-card",
  "ui-handover",
  "extensions-loaded",
  "sessions",
  "isolated",
  "real-state",
  REGISTRY_CHECK,
] as const;
/** The checks of the talk-ui mode on an omp older than 19.2.0 (#251 a8, #248 a11). */
const OLD_OMP_CHECKS = [
  "install",
  "old-omp",
  "old-notice",
  "old-no-command",
  "extensions-loaded",
  "sessions",
  "isolated",
  "real-state",
] as const;
type UiCheck = (typeof UI_CHECKS)[number] | (typeof OLD_OMP_CHECKS)[number];

const ESC = "\u001b";
/** The final characters of the cursor moves CUP, HVP, CUD, CNL, CPL, CHA, and VPA. */
const CURSOR_MOVE_FINALS = "HfBEFGd";
/** The second characters of the ESC sequences that run to a string terminator: DCS, SOS, PM, APC, and OSC. */
const STRING_SEQUENCE_KINDS = "P^_X]";
/** omp writes the rows of one frame between autowrap off and autowrap on (`FrameWriter` of pi-tui). */
const AUTOWRAP_OFF = `${ESC}[?7l`;
const AUTOWRAP_ON = `${ESC}[?7h`;

/**
 * Terminal output as screen text. A carriage return or a cursor move becomes a line break, so the text of two
 * screen rows stays apart. Escape sequences (CSI, the string sequences, which OSC can also end with BEL, and
 * the short ESC sequences) and the other control characters are removed.
 */
function screenText(raw: string): string {
  const parts: string[] = [];
  const within = (at: number, low: number, high: number): boolean => {
    const code = raw.charCodeAt(at);
    return code >= low && code <= high;
  };
  let start = 0;
  let index = 0;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (code === 0x0a || (code >= 0x20 && code !== 0x7f)) {
      index += 1;
      continue;
    }
    parts.push(raw.slice(start, index));
    const kind = raw.charAt(index + 1);
    if (code === 0x0d) {
      parts.push("\n");
      index += kind === "\n" ? 2 : 1;
    } else if (code !== 0x1b) index += 1;
    else if (kind === "[") {
      let end = index + 2;
      while (within(end, 0x30, 0x3f)) end += 1;
      while (within(end, 0x20, 0x2f)) end += 1;
      if (end < raw.length && CURSOR_MOVE_FINALS.includes(raw.charAt(end))) parts.push("\n");
      index = end + 1;
    } else if (kind !== "" && STRING_SEQUENCE_KINDS.includes(kind)) {
      const terminator = raw.indexOf(`${ESC}\\`, index + 2);
      const bell = kind === "]" ? raw.indexOf("\u0007", index + 2) : -1;
      const ends = [terminator === -1 ? raw.length : terminator + 2];
      if (bell !== -1) ends.push(bell + 1);
      index = Math.min(...ends);
    } else {
      let end = index + 1;
      while (within(end, 0x20, 0x2f)) end += 1;
      index = end + 1;
    }
    start = index;
  }
  parts.push(raw.slice(start));
  return parts.join("");
}

/** Whether the version in an `omp/<x>.<y>.<z>` match comes before `needed`. */
function olderThan(version: RegExpExecArray, needed: string): boolean {
  const have = version.slice(1, 4).map(Number);
  const want = needed.split(".").map(Number);
  for (const [index, part] of want.entries()) {
    const own = have[index] ?? 0;
    if (own !== part) return own < part;
  }
  return false;
}

/**
 * omp in TUI mode in a pseudo-terminal (#251 F8). The driver writes key bytes and waits for screen text after
 * a mark that it takes before the key. omp repaints by diff, so a search from an older mark could match a
 * stale frame.
 */
class TerminalOmp {
  readonly #argv: readonly string[];
  readonly #process: Bun.Subprocess;
  readonly #decoder = new TextDecoder();
  #raw = "";
  #waiters: Array<() => void> = [];

  constructor(argv: readonly string[], cwd: string, env: Record<string, string>) {
    this.#argv = argv;
    const child = Bun.spawn([ompBinary, ...argv], {
      cwd,
      env,
      terminal: {
        cols: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
        name: TERMINAL_TYPE,
        data: (_terminal, data) => {
          this.#raw += this.#decoder.decode(data, { stream: true });
          for (const wake of this.#waiters.splice(0)) wake();
        },
      },
    });
    this.#process = child;
    terminalChildren.add(child);
    void child.exited.then(() => terminalChildren.delete(child));
  }

  /** The process id of the omp process. */
  get pid(): number {
    return this.#process.pid;
  }

  /** A position in the output; `waitFor` searches the output after it. */
  mark(): number {
    return this.#raw.length;
  }

  /** The screen text after the mark `from`. */
  text(from = 0): string {
    return screenText(this.#raw.slice(from));
  }

  /**
   * The screen text of each complete frame after the mark `from`, in output order: the frame has both its
   * autowrap off and its autowrap on. A diff repaint writes only the rows that changed, so a row shows twice in
   * one frame only when omp draws it twice. A frame whose end has not arrived yet is left out, because its
   * count can still grow.
   */
  frames(from = 0): string[] {
    return this.#raw
      .slice(from)
      .split(AUTOWRAP_OFF)
      .slice(1)
      .flatMap((part) => {
        const end = part.indexOf(AUTOWRAP_ON);
        return end === -1 ? [] : [screenText(part.slice(0, end))];
      });
  }

  /** Waits until a complete frame after the mark `from` satisfies `matches`; fails when none does in time. */
  async waitForFrame(
    matches: (frame: string) => boolean,
    what: string,
    from = 0,
  ): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (!this.frames(from).some(matches)) {
      const left = deadline - Date.now();
      if (left <= 0) {
        const tail = this.text(from).replace(/\s+/g, " ").trim().slice(-300);
        failStep(
          `no complete frame of the screen shows the ${what} within ${STEP_TIMEOUT_MS / 1_000} s; it ends: ${tail}`,
        );
      }
      await this.#nextOutput(left);
    }
  }

  /**
   * Waits until the output drains: no output for `quietMs`, and the last frame has its end. Fails when the
   * output does not drain in time.
   */
  async drain(quietMs: number): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
      const before = this.#raw.length;
      await sleep(quietMs);
      const open = this.#raw.lastIndexOf(AUTOWRAP_OFF) > this.#raw.lastIndexOf(AUTOWRAP_ON);
      if (this.#raw.length === before && !open) return;
      if (Date.now() > deadline)
        failStep(
          `the output of omp did not drain within ${STEP_TIMEOUT_MS / 1_000} s${open ? "; a frame stays open" : ""}`,
        );
    }
  }

  write(bytes: string): void {
    if (this.#process.terminal === undefined) failStep("the omp process has no terminal");
    this.#process.terminal.write(bytes);
  }

  /** Resizes the pseudo-terminal; omp gets SIGWINCH and draws a new frame. */
  resize(columns: number, rows: number): void {
    if (this.#process.terminal === undefined) failStep("the omp process has no terminal");
    this.#process.terminal.resize(columns, rows);
  }

  /** The first match of `pattern` in the screen text after `from`; fails when none shows in time. */
  async waitFor(pattern: RegExp | string, from: number, what: string): Promise<RegExpExecArray> {
    const search =
      typeof pattern === "string"
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
        : pattern;
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    for (;;) {
      const shown = this.text(from);
      const match = search.exec(shown);
      if (match !== null) return match;
      const left = deadline - Date.now();
      if (left <= 0) {
        const tail = shown.replace(/\s+/g, " ").trim().slice(-300);
        failStep(`the screen shows no ${what} within ${STEP_TIMEOUT_MS / 1_000} s; it ends: ${tail}`);
      }
      await this.#nextOutput(left);
    }
  }

  /** Resolves on the next output, or after `ms`. */
  #nextOutput(ms: number): Promise<void> {
    const { promise, resolve: wake } = Promise.withResolvers<void>();
    const timer = setTimeout(wake, ms);
    this.#waiters.push(() => {
      clearTimeout(timer);
      wake();
    });
    return promise;
  }

  /** Writes `ctrl+d` and waits for the exit; SIGKILL when omp does not exit in time. The screen text is `stderr`. */
  async close(): Promise<OmpResult> {
    if (this.#process.exitCode === null) this.write(CTRL_D_KEY);
    const code = await withTimeout(this.#process.exited, PEER_CLOSE_MS, "the exit").catch(
      (): "timeout" => {
        this.#process.kill("SIGKILL");
        return "timeout";
      },
    );
    return { argv: this.#argv, code, stdout: "", stderr: this.text() };
  }
}

/** One `talk` call of the RPC peer that the driver waits for. */
interface MarkedCall {
  readonly marker: string;
  readonly call: ToolCall;
  readonly result: Deferred<string>;
  issued: boolean;
}

/**
 * The fake model of the RPC peer in the talk-ui mode: the turn of a prompt with the marker of the expected
 * call makes that `talk` call, and the driver gets its tool result. Every other turn answers "ok".
 */
class PeerCalls {
  #pending: MarkedCall | null = null;
  #count = 0;

  /** Makes the turn of the next prompt with `marker` call `talk` with `toolArgs`; gives its tool result. */
  expect(marker: string, toolArgs: Readonly<Record<string, string>>): Promise<string> {
    this.#count += 1;
    const result = Promise.withResolvers<string>();
    this.#pending = {
      marker,
      call: { id: `peer-${this.#count}`, name: TALK_TOOL, arguments: toolArgs },
      result,
      issued: false,
    };
    return withTimeout(
      result.promise,
      STEP_TIMEOUT_MS,
      `the ${toolArgs["action"] ?? TALK_TOOL} call of the peer`,
    );
  }

  async respond(request: JsonObject): Promise<Answer> {
    const pending = this.#pending;
    if (pending === null) return [];
    if (!pending.issued) {
      if (newUserText(request)?.includes(pending.marker) !== true) return [];
      pending.issued = true;
      return [pending.call];
    }
    const result = toolResultText(request, pending.call.id);
    if (result !== undefined) {
      this.#pending = null;
      pending.result.resolve(result);
    }
    return [];
  }
}

/**
 * The talk-ui mode (#251 G8): omp in TUI mode in a pseudo-terminal beside an omp RPC peer, both with the talk
 * plugin copy and a private registry folder. On an omp older than 19.2.0, the TUI omp must show the one
 * capability notice and have no `/talk` command (#251 a8).
 */
async function talkUiMode(): Promise<{ lines: string[]; registry: string | null }> {
  const results = new Map<UiCheck, string>();
  let checks: readonly UiCheck[] = UI_CHECKS;
  const lines = (): string[] =>
    checks.map((name) => {
      const problem = results.get(name);
      return checkLine(name, problem ?? "not run, because an earlier check failed");
    });
  if (!existsSync(pluginDir)) {
    results.set("install", `plugin folder ${pluginDir} does not exist`);
    return { lines: lines(), registry: null };
  }
  const realBefore = realStateSnapshot();
  const installFailures: string[] = [];
  const run = await install(installFailures, {
    modelIds: [PEER_MODEL_ID, UI_MODEL_ID],
    configYaml: UI_CONFIG_YAML,
    pluginFolder: talkPluginCopy,
  });
  const registry = run.isolation.registry;
  // The version decides the flow: omp before 19.2.0 has no reactive UI, so talk only shows its notice.
  const versionText = (await run.omp(["--version"])).stdout;
  const version = OMP_VERSION.exec(versionText);
  if (version === null) installFailures.push(`omp --version names no version: ${short(versionText)}`);
  else if (olderThan(version, UI_OMP_NEEDED)) checks = OLD_OMP_CHECKS;
  results.set("install", installFailures.join("; "));
  if (installFailures.length > 0) return { lines: lines(), registry };

  const env: Record<string, string> = { ...run.env, TERM: TERMINAL_TYPE };
  const peerCalls = new PeerCalls();
  run.script.respond = async (request) => {
    if (request["model"] === PEER_MODEL_ID) return peerCalls.respond(request);
    if (request["model"] !== UI_MODEL_ID) return [];
    // The handover side turn gets the draft; every other turn of the TUI omp answers "ok".
    return newUserText(request)?.includes(HANDOVER_PROMPT_TEXT) === true ? HANDOVER_DRAFT : [];
  };

  let step: UiCheck = checks[1] ?? "install";
  const pass = (): void => {
    results.set(step, "");
  };
  let terminal: TerminalOmp | null = null;
  let terminalResult: OmpResult | null = null;
  let peer: RpcPeer | null = null;

  /**
   * omp before 19.2.0: one capability notice, no load error, no `/talk` command, and no `talk` tool. The first
   * complete frame with the notice only shows that talk is ready; the notices are checked once at the end,
   * after the output drains, because a later frame can still draw the notice again.
   */
  const oldOmpFlow = async (screen: TerminalOmp): Promise<void> => {
    // `old-omp`: `omp --version` names a version before 19.2.0, and the TUI omp started.
    pass();

    step = "old-notice";
    await screen.waitForFrame(
      (frame) => talkNotices(frame).some(isCapabilityNotice),
      "talk notice that names omp 19.2.0",
    );
    results.set("old-notice", "not checked, because old-no-command failed before the output drained");

    // omp gives a line that names no command to the model as a prompt. omp 19.1.1 also reads `/talk` as the
    // shipped `talk` skill and gives the skill text with it. The skill hint requests at the start of omp hold
    // `/talk` too, so only the requests after Enter count.
    step = "old-no-command";
    const typed = screen.mark();
    screen.write("/talk");
    await screen.waitFor("/talk", typed, "typed /talk");
    const sentBefore = run.requests.length;
    screen.write(ENTER_KEY);
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    let request: JsonObject | undefined;
    for (;;) {
      request = run.requests
        .slice(sentBefore)
        .find(
          (sent) => sent["model"] === UI_MODEL_ID && newUserText(sent)?.includes("/talk") === true,
        );
      if (request !== undefined) break;
      if (Date.now() > deadline)
        failStep(`omp did not give /talk to the model within ${STEP_TIMEOUT_MS / 1_000} s`);
      await sleep(POLL_MS);
    }
    // The turn of the `/talk` prompt ends with the "ok" answer before ctrl+d can exit omp.
    await screen.waitFor(/\bok\b/, typed, "answer to the /talk prompt");
    // The tool is off too, not only the command (#251 a8).
    if (!offersTool(request, BUILTIN_TOOL))
      failStep(`the request of the /talk prompt offers no ${BUILTIN_TOOL} tool`);
    if (offersTool(request, TALK_TOOL))
      failStep(`the request of the /talk prompt offers the ${TALK_TOOL} tool`);
    pass();

    // The PTY can split a frame between two reads, so only complete frames count, after the output drains.
    step = "old-notice";
    await screen.drain(DRAIN_QUIET_MS);
    const perFrame = screen.frames().map(talkNotices);
    const others = new Set(perFrame.flat().filter((notice) => !isCapabilityNotice(notice)));
    if (others.size > 0)
      failStep(
        `the screen shows talk notices that are not the whole capability notice: ${[...others].join(" | ")}`,
      );
    // omp draws the notice again in later frames, so the count of one frame is the count of notices.
    const most = Math.max(0, ...perFrame.map((frame) => frame.length));
    if (most !== 1)
      failStep(
        most === 0
          ? "no complete frame of the screen shows the capability notice"
          : `one frame of the screen shows ${most} capability notices`,
      );
    const texts = new Set(perFrame.flat());
    if (texts.size !== 1) failStep(`the screen shows ${texts.size} different capability notices`);
    pass();
  };

  /** omp 19.2.0 or later: the list, compose and confirm, the card, and handover (#251 G8). */
  const currentFlow = async (screen: TerminalOmp, rpc: RpcPeer): Promise<void> => {
    const peerState = async (): Promise<JsonObject> => {
      const data = await rpc.send({ type: "get_state" });
      return isObject(data) ? data : {};
    };
    const waitFor = async (what: string, probe: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      while (!(await probe())) {
        if (Date.now() > deadline) failStep(`no ${what} within ${STEP_TIMEOUT_MS / 1_000} s`);
        await sleep(POLL_MS);
      }
    };
    const waitPeerIdle = (): Promise<void> =>
      waitFor("idle peer", async () => (await peerState())["isStreaming"] === false);
    /** One prompt of the peer whose turn makes the expected `talk` call; gives its tool result. */
    const peerCall = async (
      marker: string,
      toolArgs: Readonly<Record<string, string>>,
    ): Promise<string> => {
      const result = peerCalls.expect(marker, toolArgs);
      result.catch(() => undefined);
      await rpc.send({ type: "prompt", message: `${marker}: do the scripted step.` });
      const output = await result;
      await waitPeerIdle();
      return output;
    };
    /** Waits until the peer session holds a talk entry that `matches`, and then until the peer is idle. */
    const peerTalkEntry = async (
      what: string,
      matches: (entry: JsonObject) => boolean,
    ): Promise<void> => {
      await waitFor(what, async () =>
        checkedEntries(await rpc.send({ type: "get_entries" })).entries.some(
          (entry) =>
            entry["type"] === "custom_message" &&
            entry["customType"] === TALK_ENTRY_TYPE &&
            matches(entry),
        ),
      );
      await waitPeerIdle();
    };
    /** Reads the code from the confirm line, checks the instance id, and types the code as two key presses. */
    const confirm = async (from: number, instance: string, kind: string): Promise<void> => {
      const line = await screen.waitFor(CONFIRM_LINE, from, "confirm line");
      const [, shownInstance = "", first = "", second = ""] = line;
      if (shownInstance !== instance)
        failStep(`the confirm line names ${shownInstance}, expected the peer instance ${instance}`);
      await screen.waitFor(`Kind: ${kind}`, from, `kind ${kind} in the confirm view`);
      const typed = screen.mark();
      screen.write(first);
      await screen.waitFor(`Typed: ${first}_`, typed, "first typed code letter");
      screen.write(second);
    };

    // The peer lists until it sees the TUI omp; its own row gives the peer instance id.
    let uiInstance: string | undefined;
    let peerInstance: string | undefined;
    for (let attempt = 1; uiInstance === undefined; attempt += 1) {
      const listing = await peerCall(PEER_LIST_MARKER, { action: "list" });
      const sessions = listedSessions(listing);
      const others = sessions.filter((session) => !session.own);
      if (others.length > 1) failStep(`the peer lists more than one other session: ${short(listing)}`);
      const own = sessions.find((session) => session.own);
      if (own !== undefined && others[0] !== undefined) {
        peerInstance = own.instance;
        uiInstance = others[0].instance;
      } else if (attempt >= LIST_ATTEMPTS)
        failStep(`${attempt} lists of the peer show no other session: ${short(listing)}`);
      else await sleep(LIST_RETRY_MS);
    }
    if (peerInstance === undefined) return failStep("the peer list has no own row");
    pass();

    step = "ui-list";
    const listed = screen.mark();
    screen.write(ALT_T_KEY);
    await screen.waitFor(LIST_TITLE_TEXT, listed, "list title");
    await screen.waitFor(peerInstance, listed, `peer row with the instance id ${peerInstance}`);
    pass();

    // The list is open. The resize goes from the full size straight to one column: no item row fits, the list
    // ends, and the resize view paints the symbol cue as its one row. At the full size again the view lists once
    // more and shows the list.
    step = "ui-resize";
    const narrowed = screen.mark();
    screen.resize(NARROW_COLUMNS, NARROW_ROWS);
    await screen.waitForFrame(
      (frame) => frame.split("\n").some((row) => row.trim() === RESIZE_CUE),
      `row ${RESIZE_CUE} in a pane of ${NARROW_COLUMNS} column`,
      narrowed,
    );
    const widened = screen.mark();
    screen.resize(TERMINAL_COLUMNS, TERMINAL_ROWS);
    await screen.waitFor(LIST_TITLE_TEXT, widened, "list title after the resize back");
    await screen.waitFor(peerInstance, widened, "peer row after the resize back");
    const closed = screen.mark();
    screen.write(ALT_T_KEY);
    await screen.waitFor(UI_READY_TEXT, closed, "footer after alt+t closed the list");
    pass();

    step = "ui-compose-send";
    const reopened = screen.mark();
    screen.write(ALT_T_KEY);
    await screen.waitFor(peerInstance, reopened, "peer row in the list opened again");
    const composing = screen.mark();
    screen.write(ENTER_KEY);
    await screen.waitFor(COMPOSE_PLACEHOLDER, composing, "compose view");
    const typing = screen.mark();
    screen.write(COMPOSED_TEXT);
    await screen.waitFor(COMPOSED_TEXT, typing, "typed message");
    const confirming = screen.mark();
    screen.write(ENTER_KEY);
    await confirm(confirming, peerInstance, "message");
    await peerTalkEntry(
      "talk entry with the composed message",
      (entry) => text(entry["content"])?.includes(COMPOSED_TEXT) === true,
    );
    pass();

    step = "ui-card";
    const carded = screen.mark();
    const cardResult = await peerCall(PEER_CARD_MARKER, {
      action: "send",
      instance: uiInstance,
      message: CARD_LINES.join("\n"),
    });
    if (!cardResult.includes("Delivered:"))
      failStep(`the send of the peer did not read Delivered: ${short(cardResult)}`);
    const header = await screen.waitFor(CARD_HEADER, carded, "card header");
    const folders = new Set([run.workDir, realpathSync(run.workDir)]);
    if (!folders.has(header[1] ?? ""))
      failStep(`the card header names the folder ${header[1]}, expected ${run.workDir}`);
    for (const line of CARD_LINES.slice(0, 3))
      await screen.waitFor(line, carded, `card line ${JSON.stringify(line)}`);
    await screen.waitFor(CARD_MORE, carded, `card row ${JSON.stringify(CARD_MORE)}`);
    const hidden = CARD_LINES[3] ?? "";
    if (screen.text(carded).includes(hidden))
      failStep(`the collapsed card shows its fourth line ${JSON.stringify(hidden)}`);
    pass();

    step = "ui-handover";
    const sessionId =
      text((await peerState())["sessionId"]) ?? failStep("RPC get_state gives no sessionId");
    const commandText = `/talk handover ${sessionId}`;
    const commanded = screen.mark();
    screen.write(commandText);
    await screen.waitFor(commandText, commanded, "typed handover command");
    const started = screen.mark();
    screen.write(ENTER_KEY);
    const [draftFirst = ""] = HANDOVER_DRAFT.split("\n");
    await screen.waitFor(draftFirst, started, "side-turn draft in the review");
    const editing = screen.mark();
    screen.write(HANDOVER_EDIT);
    await screen.waitFor(`${HANDOVER_EDIT}${draftFirst}`, editing, "edited draft");
    const approving = screen.mark();
    screen.write(CTRL_S_KEY);
    await confirm(approving, peerInstance, HANDOVER_KIND);
    const edited = `${HANDOVER_EDIT}${HANDOVER_DRAFT}`;
    await peerTalkEntry(`talk entry of kind ${HANDOVER_KIND} with the edited draft`, (entry) => {
      const details = entry["details"];
      return (
        isObject(details) &&
        details["kind"] === HANDOVER_KIND &&
        text(entry["content"])?.includes(edited) === true
      );
    });
    pass();
  };

  try {
    const screen = new TerminalOmp(
      ["--model", `${MODEL_PROVIDER}/${UI_MODEL_ID}`, "--no-title"],
      run.workDir,
      env,
    );
    terminal = screen;
    // `step` is the first check after `install`: the TUI omp must start. The peer starts only after it, so
    // the two omp processes do not set up the fresh state folder at the same time.
    await screen.waitFor(UI_READY_TEXT, 0, "footer with the model name");
    if (checks === OLD_OMP_CHECKS) await oldOmpFlow(screen);
    else {
      peer = await startRpcOmp(
        ["--mode", "rpc", "--model", `${MODEL_PROVIDER}/${PEER_MODEL_ID}`, "--no-title"],
        run.workDir,
        env,
      );
      // Both omp processes are live: the TUI omp shows its footer, and the peer waits for RPC commands.
      results.set(
        REGISTRY_CHECK,
        await attributionProblem([
          sessionAttribution(run, "TUI", screen.pid, run.workDir),
          sessionAttribution(run, "peer", peer.pid, run.workDir),
        ]),
      );
      await currentFlow(screen, peer);
    }
    terminalResult = await screen.close();
  } catch (error) {
    results.set(step, error instanceof Error ? error.message : String(error));
  }

  if (terminal !== null && terminalResult === null) terminalResult = await terminal.close();
  const peerResult = peer === null ? null : await peer.close();
  const sessionFailures: string[] = [];
  const sessions: Array<readonly [string, OmpResult | null]> = [["TUI", terminalResult]];
  if (checks === UI_CHECKS) sessions.push(["peer", peerResult]);
  for (const [name, result] of sessions) {
    if (result === null) sessionFailures.push(`the ${name} omp did not run`);
    else if (result.code !== 0)
      sessionFailures.push(
        `the ${name} omp exited ${result.code}: ${short(result.stderr.slice(-600))}`,
      );
  }
  for (const result of [terminalResult, peerResult]) if (result !== null) run.results.push(result);
  const warnings = countWarnings(
    [],
    run.results,
    run.isolation.stateDir,
    pluginMarkers(run.plugin),
  );
  results.set(
    "extensions-loaded",
    warnings.length > 0
      ? `omp reported ${warnings.length} warning(s) about the plugin: ${warnings.join(" | ")}`
      : "",
  );
  results.set("sessions", sessionFailures.join("; "));
  results.set("isolated", isolationProblems(run).join("; "));
  results.set("real-state", realStateChanges(realBefore).join("; "));
  return { lines: lines(), registry };
}

let exitCode = 1;
try {
  const outcome =
    command === "hooks"
      ? await hooks()
      : command === "talk"
        ? await talkMode()
        : command === "talk-ui"
          ? await talkUiMode()
          : await smoke();
  for (const line of outcome.lines) console.log(line);
  // The registry folder lies outside the scratch folder, so the check runs after the cleanup.
  const removed = reportCleanup();
  const kept =
    outcome.registry === null
      ? "no registry folder was made"
      : existsSync(outcome.registry)
        ? `the registry folder ${outcome.registry} still exists`
        : "";
  console.log(checkLine("registry-removed", kept));
  exitCode =
    removed && !kept && !outcome.lines.some((line) => line.startsWith("FAIL")) ? 0 : 1;
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!reportCleanup()) exitCode = 1;
}
process.exit(exitCode);
