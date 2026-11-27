/**
 * Golden mutation regression suite.
 *
 * Executes real EngineNative commands against disposable fixture HOMEs with
 * external tools stubbed. Each golden records the resulting HOME tree, child
 * argv log, normalized output, and exit code. `--prove-red` intentionally
 * compares each run to a mismatched golden and exits non-zero after proving the
 * suite can fail.
 *
 *   bun cli/test/golden-mutation.ts --update-goldens
 *   bun cli/test/golden-mutation.ts
 *   bun cli/test/golden-mutation.ts --prove-red
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isObject, parseJson } from "../src/engine-native/jq";
import { hostOs } from "../src/engine-native/os";
import { banner, labelSelected, parseArgs } from "./lib/goldenCli";
import {
  cleanupProblems,
  readArgvLog,
  runEngine,
  runEngineSplit,
  runPublicCli,
} from "./lib/goldenExecution";
import { MATRIX, REPLAYS, type MutationMatrixCase } from "./lib/goldenMutationCatalog";
import { REPO_DIR, makeStubDir } from "./lib/goldenResources";
import {
  diffText,
  diffTrees,
  seededTreeProblems,
  snapshotTreeResult,
  stableStringify,
  type TreeSnapshot,
} from "./lib/goldenSnapshot";
import { readGolden, selectProveRedMismatch } from "./lib/goldenProveRed";

interface MutationGolden {
  readonly version: 1;
  readonly cases: Record<string, MutationCaseGolden>;
}

interface MutationCaseGolden {
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly tree: TreeSnapshot;
  readonly argvLog: string;
  readonly output: string;
}

const GOLDEN_PATH = join(REPO_DIR, "cli", "test", "goldens", "mutation.json");
const options = parseArgs(process.argv);
const hostExecutableSuffixes = hostOs().executableSuffixes;
if (hostExecutableSuffixes.length !== 1 || !hostExecutableSuffixes.includes("")) {
  console.error(
    "golden-mutation: unsupported host: snapshots are Linux-canonical and run only in the Linux snapshot lane. On Windows, run `bun run typecheck` and `bun run test:unit` instead; the CI job `portable (windows-2025) checks` proves the global install of the bundle on Windows.",
  );
  process.exit(2);
}
const defaultStubs = makeStubDir();

function matrixLabel(
  fixture: string,
  cmd: ReadonlyArray<string>,
  stubs?: Record<string, string | null>,
  variant?: string,
): string {
  const stubPart = stubs !== undefined ? ` stubs=${Object.keys(stubs).join(",")}` : "";
  const variantPart = variant !== undefined ? ` variant=${variant}` : "";
  return `fixture=${fixture} cmd=${cmd.join(" ")}${stubPart}${variantPart}`;
}

/**
 * A matrix or replay run: its golden, and the problems of its direct case
 * checks (snapshot, seed, and notice). `golden` is undefined when the snapshot
 * of HOME failed: the case then fails, and no partial snapshot is compared or
 * recorded.
 */
interface MatrixRun {
  readonly golden: MutationCaseGolden | undefined;
  readonly problems: ReadonlyArray<string>;
}

/** The facts of a run that the case checks read besides the tree. */
type RunFacts = Pick<MutationCaseGolden, "exitCode" | "argvLog" | "output">;

/** The golden of `run`, or the snapshot problem that leaves it without one. */
function caseGolden(
  cmd: ReadonlyArray<string>,
  home: string,
  facts: RunFacts,
): { readonly golden: MutationCaseGolden | undefined; readonly problems: Array<string> } {
  const snapshot = snapshotTreeResult(home);
  if (snapshot.kind === "failed") return { golden: undefined, problems: [snapshot.problem] };
  return { golden: { command: [...cmd], ...facts, tree: snapshot.tree }, problems: [] };
}

function runCase(
  row: MutationMatrixCase,
  stubDir: string,
  maskTools: ReadonlyArray<string>,
): MatrixRun {
  const run = runEngine(row.cmd, row.fixture, stubDir, {
    maskTools,
    ...(row.env !== undefined ? { env: row.env } : {}),
    ...(row.seed !== undefined ? { seed: row.seed } : {}),
  });
  let result: MatrixRun;
  try {
    const facts: RunFacts = {
      exitCode: run.exitCode,
      argvLog: readArgvLog(run),
      output: run.output,
    };
    const { golden, problems } = caseGolden(row.cmd, run.home, facts);
    problems.push(
      ...(row.seed !== undefined ? seededTreeProblems(run.home, row.seed) : []),
      ...(row.piIntercomNotice !== undefined
        ? piIntercomProblems(run.home, facts, row.piIntercomNotice)
        : []),
    );
    result = { golden, problems };
  } catch (error) {
    // A harness error ends the matrix; the home goes first.
    cleanupProblems([run]);
    throw error;
  }
  // A home that cannot be removed fails the case, which keeps its result.
  return { golden: result.golden, problems: [...result.problems, ...cleanupProblems([run])] };
}

/**
 * The checks of a pi-intercom cutover case: sync exits 0, runs no install or
 * uninstall of pi-intercom, prints `notice` exactly once and no other notice
 * or removal command, and deploys the kit plugin with `talk.js` (the bytes of
 * the SoT copy) in its manifest and with the `talk` skill.
 */
function piIntercomProblems(home: string, facts: RunFacts, notice: string): Array<string> {
  const problems: Array<string> = [];
  if (facts.exitCode !== 0) problems.push(`  exit code ${facts.exitCode}, expected 0`);
  const changes = facts.argvLog
    .split("\n")
    .filter((line) => line.includes("pi-intercom") && /\b(?:install|uninstall)\b/.test(line));
  if (changes.length > 0) problems.push(`  argv log changes pi-intercom: ${changes.join(" | ")}`);
  const lines = facts.output.split("\n");
  const notices = lines.filter((line) => line.includes("Notice:"));
  if (notices.length !== 1 || notices[0] !== notice) {
    problems.push(`  expected the notice once: ${notice}; got: ${notices.join(" | ") || "none"}`);
  }
  const removals = lines.filter((line) => /\b(?:uninstall|remove)\b.*pi-intercom/.test(line));
  if (removals.length > 0) problems.push(`  output names a removal: ${removals.join(" | ")}`);

  const plugin = join(home, ".docks-kit", "omp-plugin");
  const manifestBytes = deployedBytes(join(plugin, "package.json"), "package.json", problems);
  if (manifestBytes !== undefined) {
    const manifest = parseJson(manifestBytes.toString("utf8"));
    const omp = manifest !== undefined && isObject(manifest) ? manifest["omp"] : undefined;
    const extensions = omp !== undefined && isObject(omp) ? omp["extensions"] : undefined;
    if (!Array.isArray(extensions) || !extensions.includes("./extensions/talk.js")) {
      problems.push("  the deployed kit plugin manifest does not list ./extensions/talk.js");
    }
  }
  const shipped = readFileSync(join(REPO_DIR, "SoT", ".omp", "plugin", "extensions", "talk.js"));
  const deployed = deployedBytes(
    join(plugin, "extensions", "talk.js"),
    "extensions/talk.js",
    problems,
  );
  if (deployed !== undefined && !deployed.equals(shipped)) {
    problems.push(
      "  the deployed extensions/talk.js differs from SoT/.omp/plugin/extensions/talk.js",
    );
  }
  if (!existsSync(join(plugin, "skills", "talk", "SKILL.md"))) {
    problems.push("  the deployed kit plugin has no skills/talk/SKILL.md");
  }
  return problems;
}

/**
 * The bytes of the deployed kit plugin file `path`, or undefined after a
 * problem that names `name`: the file is missing, is not a regular file, or
 * cannot be read. A problem fails the case, and the matrix goes on.
 */
function deployedBytes(path: string, name: string, problems: Array<string>): Buffer | undefined {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat === undefined) {
      problems.push(`  the deployed kit plugin has no ${name}`);
      return undefined;
    }
    if (!stat.isFile()) {
      problems.push(`  the deployed kit plugin ${name} is not a regular file`);
      return undefined;
    }
    return readFileSync(path);
  } catch (error) {
    problems.push(
      `  the deployed kit plugin ${name} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function runReplayCase(fixture: string, cmd: ReadonlyArray<string>): MatrixRun {
  const first = runEngine(cmd, fixture, defaultStubs);
  let result: MatrixRun;
  try {
    if (first.exitCode !== 0) {
      throw new Error(
        `first replay failed for '${cmd.join(" ")}' with exit code ${first.exitCode}`,
      );
    }
    if (!first.output.includes("--- Sync complete ---")) {
      throw new Error(`first replay for '${cmd.join(" ")}' produced no sync completion summary`);
    }
    const second = runEngine(cmd, fixture, defaultStubs, { reuseHome: first.home });
    result = caseGolden(cmd, second.home, {
      exitCode: second.exitCode,
      argvLog: readArgvLog(second),
      output: second.output,
    });
  } catch (error) {
    // A harness error ends the matrix; the shared home goes first.
    cleanupProblems([first]);
    throw error;
  }
  // The second run reuses the home of the first, so one removal covers both.
  return { golden: result.golden, problems: [...result.problems, ...cleanupProblems([first])] };
}

/**
 * Channel-purity invariants (stdout = data, stderr = logs). The ordered
 * goldens above merge channels via 2>&1 and cannot see a violation; these
 * split runs can. Not golden-compared — asserted directly.
 */
function channelInvariantProblems(): Array<string> {
  const problems: Array<string> = [];
  const logPrefixes = ["[ok]", "[warn]", "[err]"];

  const syncSplit = runEngineSplit(["sync"], "home-fresh", defaultStubs);
  if (syncSplit.exitCode !== 0) {
    problems.push(`  channel: sync exited ${syncSplit.exitCode}; expected 0`);
  }
  if (!syncSplit.stdout.includes("--- Sync complete ---")) {
    problems.push("  channel: summary block missing from stdout (sync)");
  }
  for (const prefix of logPrefixes) {
    if (syncSplit.stdout.includes(prefix)) {
      problems.push(`  channel: '${prefix}' log prefix leaked to stdout (sync)`);
    }
  }
  if (syncSplit.stderr.includes("--- Sync complete ---")) {
    problems.push("  channel: summary block leaked to stderr (sync)");
  }

  // Dry-run under verbose env: the report must stay a complete stdout
  // inspection artifact and no log prefix may ride along on stdout.
  const drySplit = runEngineSplit(["sync", "--dry-run"], "home-drift", defaultStubs, {
    env: { DOCKS_KIT_VERBOSE: "1" },
  });
  if (!drySplit.stdout.includes("[dry-run]")) {
    problems.push("  channel: no [dry-run] lines on stdout (sync --dry-run)");
  }
  if (drySplit.stderr.includes("[dry-run]")) {
    problems.push("  channel: [dry-run] lines leaked to stderr (sync --dry-run)");
  }
  for (const prefix of logPrefixes) {
    if (drySplit.stdout.includes(prefix)) {
      problems.push(`  channel: '${prefix}' log prefix leaked to stdout (verbose sync --dry-run)`);
    }
  }

  // A warn-emitting run (masked git): warns must land on stderr, never stdout.
  // The fully-stubbed cases above emit no warns, so without this leg a
  // stdout-routed warn would pass every channel check.
  const warnSplit = runEngineSplit(["sync"], "home-fresh", makeStubDir({ git: null }), {
    maskTools: ["git"],
  });
  if (warnSplit.stdout.includes("[warn]")) {
    problems.push("  channel: '[warn]' leaked to stdout (git-masked sync)");
  }
  if (!warnSplit.stderr.includes("git not installed —")) {
    problems.push("  channel: expected git warn missing from stderr (git-masked sync)");
  }

  for (const [args, error, label] of [
    [
      ["toolchain", "--no-verbose"],
      "unknown flag --no-verbose for 'toolchain'",
      "negated toolchain option --no-verbose",
    ],
    [["sync", "-x"], "unknown flag -x for 'sync'", "single-dash unknown flag -x"],
    [
      ["sync", "--verbose", "--verbose"],
      "flag --verbose was given more than once",
      "duplicate non-repeatable flag --verbose",
    ],
  ] as const) {
    const bare = runPublicCli(args, "home-fresh", defaultStubs);
    if (bare.exitCode !== 2 || !bare.stderr.includes(error)) {
      problems.push(`  modifiers: public ${label} lost error/exit-2 behavior`);
    }
    if (bare.stdout !== "")
      problems.push(`  modifiers: public ${label} wrote error data to stdout`);
    problems.push(...cleanupProblems([bare]));
  }

  // Before this guard, an invocation that read as a dry run performed a real mutating sync.
  const booleanWithValue = runPublicCli(["sync", "--dry-run=false"], "home-fresh", defaultStubs);
  if (
    booleanWithValue.exitCode !== 2 ||
    !booleanWithValue.stderr.includes("flag --dry-run does not take a value")
  ) {
    problems.push("  modifiers: public --dry-run=false lost error/exit-2 behavior");
  }
  if (booleanWithValue.stdout !== "") {
    problems.push("  modifiers: public --dry-run=false wrote error data to stdout");
  }
  problems.push(...cleanupProblems([booleanWithValue]));

  // The kit refuses these flags outright so Effect 4 cannot negate a declared boolean into a real mutating sync.
  for (const flag of ["--no-dry-run", "--no-verbose"] as const) {
    const bare = runPublicCli(["sync", flag], "home-fresh", defaultStubs);
    if (bare.exitCode !== 2 || bare.stderr !== `unknown flag ${flag} for 'sync'\n`) {
      problems.push(`  modifiers: public negated ${flag} lost unknown-flag/exit-2 behavior`);
    }
    if (bare.stdout !== "")
      problems.push(`  modifiers: public negated ${flag} wrote error data to stdout`);
    problems.push(...cleanupProblems([bare]));
  }

  // Verbosity contract: default second run is quiet about the status quo;
  // --verbose (public flag, short alias, and raw-channel env) brings it back.
  // Exact demoted no-op shapes — NOT a loose /already/ match: change lines
  // may legitimately embed count phrasing like "(+1 new, 0 already present)".
  const NOOP_RE = /already in sync|up to date|\bpresent \(|left as-is/;
  const first = runEngineSplit(["sync"], "home-fresh", defaultStubs);
  const second = runEngineSplit(["sync"], "home-fresh", defaultStubs, { reuseHome: first.home });
  if (NOOP_RE.test(second.stderr)) {
    problems.push("  verbosity: no-op confirmation leaked into default second-run stderr");
  }
  const secondVerbose = runEngineSplit(["sync"], "home-fresh", defaultStubs, {
    reuseHome: first.home,
    env: { DOCKS_KIT_VERBOSE: "1" },
  });
  if (!NOOP_RE.test(secondVerbose.stderr)) {
    problems.push("  verbosity: DOCKS_KIT_VERBOSE=1 second run shows no no-op confirmations");
  }
  // Public-flag forwarding: each command surface and spelling must reach
  // EngineNative's verbosity gate — a known verbose-only line must land on
  // stderr (an exit-0 check alone would pass a forwarding regression).
  const pubFirst = runPublicCli(["sync"], "home-fresh", defaultStubs);
  for (const flag of ["--verbose", "-v"]) {
    const replay = runPublicCli(["sync", flag], "home-fresh", defaultStubs, {
      reuseHome: pubFirst.home,
    });
    if (!NOOP_RE.test(replay.stderr)) {
      problems.push(
        `  verbosity: public 'sync ${flag}' replay shows no no-op confirmations on stderr`,
      );
    }
    if (NOOP_RE.test(replay.stdout)) {
      problems.push(`  verbosity: no-op confirmations leaked to stdout (public 'sync ${flag}')`);
    }
  }

  // first/second/secondVerbose share one home, and all public forwarding legs reuse pubFirst's.
  problems.push(...cleanupProblems([syncSplit, warnSplit, drySplit, second, pubFirst]));
  return problems;
}

function compareCase(actual: MutationCaseGolden, expected: MutationCaseGolden): Array<string> {
  return [
    ...(actual.exitCode === expected.exitCode
      ? []
      : [`  exit codes differ: actual=${actual.exitCode} expected=${expected.exitCode}`]),
    ...diffTrees(expected.tree, actual.tree),
    ...diffText("argv log", actual.argvLog, expected.argvLog),
    ...diffText("output", actual.output, expected.output),
  ];
}

function collectCases(): {
  cases: Record<string, MutationCaseGolden>;
  invariantFailures: number;
  selectedChecks: number;
} {
  const cases: Record<string, MutationCaseGolden> = {};
  // Labels, also of a case whose snapshot failed and that `cases` lacks.
  const labels = new Set<string>();
  let invariantFailures = 0;
  let selectedChecks = 0;

  /** Keeps the golden of `run`, and prints its problems as one case failure. */
  const record = (label: string, run: MatrixRun): void => {
    if (run.golden !== undefined) cases[label] = run.golden;
    if (run.problems.length > 0) {
      invariantFailures++;
      banner(`CASE CHECK FAILURE ${label}`);
      for (const problem of run.problems) console.log(problem);
    }
  };

  for (const row of MATRIX) {
    const { fixture, cmd, stubs, variant } = row;
    const label = matrixLabel(fixture, cmd, stubs, variant);
    if (labels.has(label))
      throw new Error(`duplicate matrix label ${label} — add a variant to disambiguate`);
    labels.add(label);
    if (!labelSelected(label, options.filter)) continue;
    selectedChecks++;
    const stubDir = stubs !== undefined ? makeStubDir(stubs) : defaultStubs;
    const maskTools =
      stubs !== undefined
        ? Object.entries(stubs)
            .filter(([, body]) => body === null)
            .map(([name]) => name)
        : [];
    record(label, runCase(row, stubDir, maskTools));
  }

  for (const { fixture, cmd } of REPLAYS) {
    const label = `fixture=${fixture} cmd=${cmd.join(" ")} replay=2nd`;
    if (labels.has(label)) throw new Error(`duplicate replay label ${label}`);
    labels.add(label);
    if (!labelSelected(label, options.filter)) continue;
    selectedChecks++;
    record(label, runReplayCase(fixture, cmd));
  }

  if (labelSelected("channel-invariants", options.filter)) {
    selectedChecks++;
    const problems = channelInvariantProblems();
    if (problems.length > 0) {
      invariantFailures++;
      banner("CHANNEL INVARIANT FAILURE");
      for (const p of problems) console.log(p);
    }
  }

  return { cases, invariantFailures, selectedChecks };
}

if (options.updateGoldens) {
  const { cases: selectedCases, invariantFailures, selectedChecks } = collectCases();
  if (options.filter !== undefined && selectedChecks === 0) {
    console.error("GOLDEN_FILTER matched no cases");
    process.exit(2);
  }
  if (invariantFailures > 0) {
    console.error(
      `\ngolden-mutation: ${invariantFailures} invariant failure(s); goldens not updated`,
    );
    process.exit(1);
  }
  if (options.filter !== undefined && Object.keys(selectedCases).length === 0) {
    console.error("GOLDEN_FILTER selected no snapshot cases");
    process.exit(2);
  }

  const cases =
    options.filter === undefined
      ? selectedCases
      : { ...readGolden<MutationCaseGolden>(GOLDEN_PATH).cases, ...selectedCases };
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  writeFileSync(GOLDEN_PATH, stableStringify({ version: 1, cases } satisfies MutationGolden));
  console.log(
    `golden-mutation: updated ${Object.keys(selectedCases).length} case(s) at ${GOLDEN_PATH}`,
  );
  console.log(
    "run 'bun run format' before committing; the golden writer does not match bun fmt output",
  );
  process.exit(0);
}

const goldens = readGolden<MutationCaseGolden>(GOLDEN_PATH);
const { cases: actualCases, invariantFailures, selectedChecks } = collectCases();
if (options.filter !== undefined && selectedChecks === 0) {
  console.error("GOLDEN_FILTER matched no cases");
  process.exit(2);
}
let goldenFailures = 0;
let checked = 0;
const proveRed = options.proveRed ? selectProveRedMismatch(goldens.cases) : undefined;

for (const [label, actual] of Object.entries(actualCases)) {
  const expected = proveRed?.expectedFor(label) ?? goldens.cases[label];
  if (expected === undefined) {
    goldenFailures++;
    banner(`MISSING GOLDEN ${label}`);
    console.log("  run with --update-goldens to record this case");
    continue;
  }
  checked++;
  const problems = compareCase(actual, expected);
  proveRed?.recordComparison(problems.length > 0);
  if (problems.length > 0) {
    goldenFailures++;
    banner(`GOLDEN MISMATCH ${label}`);
    for (const p of problems) console.log(p);
  }
}

if (proveRed !== undefined) {
  const result = proveRed.result();
  if (!result.succeeded) {
    console.error(
      `prove-red FAILED: golden-mutation compared ${result.comparedCases} case(s) and detected ${result.comparatorMismatches} comparator mismatch(es); ${invariantFailures} invariant failure(s) do not satisfy prove-red`,
    );
    process.exit(1);
  }
  console.error(
    `prove-red OK: golden-mutation compared ${result.comparedCases} case(s) and detected ${result.comparatorMismatches} planted comparator mismatch(es); intentionally exiting 1`,
  );
  process.exit(1);
}

const failures = invariantFailures + goldenFailures;
if (failures > 0) {
  console.error(
    `\ngolden-mutation: ${failures} failure(s) (${invariantFailures} invariant, ${goldenFailures} golden)`,
  );
  process.exit(1);
}
console.log(`golden-mutation: OK (${checked} case(s))`);
