/**
 * Output normalization and stable snapshot helpers for golden regressions.
 */
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registeredTemporaryDirs } from "./goldenResources";

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function packageVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8"));
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error("package.json declares no version");
  }
  const version = manifest.version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`package.json version is not a non-empty string: ${String(version)}`);
  }
  return version;
}

/**
 * Only the CURRENT package version is replaced, never an arbitrary version
 * shape. A release bump therefore leaves the recorded `--version` case valid,
 * while a CLI that prints a stale or wrong version still fails to match.
 */
const PACKAGE_VERSION = packageVersion();

/**
 * Replace per-run temp paths so two runs' outputs are comparable. Each root is
 * scrubbed in its native and forward-slash spelling. The temp roots also get
 * a basename fallback because their mkdtemp suffix is unique.
 */
export function normalizeOutput(out: string, home: string, stubDir: string): string {
  let normalized = out.replaceAll("\r\n", "\n");
  for (const form of pathForms(home)) normalized = normalized.replaceAll(form, "<HOME>");
  for (const form of pathForms(stubDir)) normalized = normalized.replaceAll(form, "<STUBS>");
  for (const form of pathForms(REPO_DIR)) normalized = normalized.replaceAll(form, "<REPO>");
  normalized = normalized.replace(
    new RegExp(`\\b${escapeRegExp(PACKAGE_VERSION)}\\b`, "g"),
    "<VERSION>",
  );
  return normalized
    .replace(new RegExp(`[^\\s'"]*${escapeRegExp(basename(home))}`, "g"), "<HOME>")
    .replace(new RegExp(`[^\\s'"]*${escapeRegExp(basename(stubDir))}`, "g"), "<STUBS>");
}

function pathForms(path: string): Array<string> {
  const forwardSlash = path.replaceAll("\\", "/");
  return [...new Set([path, forwardSlash])];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TreeSnapshot = Record<string, string>;
const TEXT_ARTIFACT_SUFFIXES = [
  ".js",
  ".json",
  ".json.bak",
  ".md",
  ".md.bak",
  ".mjs",
  ".rules",
  ".sh",
  ".toml",
  ".toml.bak",
  ".ts",
  ".txt",
  ".yaml",
  ".yml",
] as const;
const TEXT_ARTIFACT_NAMES: Record<string, true> = {
  ".bashrc": true,
  ".gitkeep": true,
  ".kit-managed-skills": true,
  "session-relay": true,
};

function isTextArtifact(relative: string): boolean {
  return (
    Object.hasOwn(TEXT_ARTIFACT_NAMES, basename(relative)) ||
    TEXT_ARTIFACT_SUFFIXES.some((suffix) => relative.endsWith(suffix))
  );
}

function normalizeTreeBody(
  body: string,
  root: string,
  temporaryDirs: ReadonlyArray<string>,
): string {
  let normalized = body.replaceAll("\r\n", "\n");
  for (const form of pathForms(root)) normalized = normalized.replaceAll(form, "<HOME>");
  for (const temporary of temporaryDirs) {
    if (!basename(temporary).startsWith("golden-stubs-")) continue;
    for (const form of pathForms(temporary)) normalized = normalized.replaceAll(form, "<STUBS>");
  }
  return normalized;
}

export function snapshotTree(root: string, dir = root, acc: TreeSnapshot = {}): TreeSnapshot {
  return snapshotTreeWithTemporaryDirs(root, dir, acc, registeredTemporaryDirs());
}

/** A snapshot of a whole tree, or the problem that stopped it. A partial snapshot is never a result. */
export type TreeSnapshotResult =
  | { readonly kind: "snapshot"; readonly tree: TreeSnapshot }
  | { readonly kind: "failed"; readonly problem: string };

/**
 * `snapshotTree(root)`, with an entry that cannot be read (a file without
 * read permission, for example) as a problem line instead of a throw, so the
 * driver can fail one case and go on with the matrix.
 */
export function snapshotTreeResult(root: string): TreeSnapshotResult {
  try {
    return { kind: "snapshot", tree: snapshotTree(root) };
  } catch (error) {
    return {
      kind: "failed",
      problem: `  the snapshot of HOME cannot be read: ${errorMessage(error)}`,
    };
  }
}

function snapshotTreeWithTemporaryDirs(
  root: string,
  dir: string,
  acc: TreeSnapshot,
  temporaryDirs: ReadonlyArray<string>,
): TreeSnapshot {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const relative = path.slice(root.length + 1).replaceAll("\\", "/");
    if (relative === ".golden-argv.log") continue;
    // `.bun/install` is a runtime artifact of the native side's bun
    // interpreter (module cache keyed off $HOME) — the engine never writes
    // there. `.bun` itself is still recursed (engine bootstraps can create
    // `.bun/bin`) but not recorded as an entry, so a cache-only `.bun`
    // contributes nothing to the diff.
    if (relative === ".bun/install") continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const target = normalizeTreeBody(readlinkSync(path), root, temporaryDirs).replaceAll(
        "\\",
        "/",
      );
      acc[relative] = `link:${target}`;
    } else if (stat.isDirectory()) {
      if (relative !== ".bun" && relative !== ".local" && relative !== ".local/bin")
        acc[`${relative}/`] = "dir";
      snapshotTreeWithTemporaryDirs(root, path, acc, temporaryDirs);
    } else {
      const bytes = readFileSync(path);
      const snapshotBytes = isTextArtifact(relative)
        ? Buffer.from(normalizeTreeBody(bytes.toString("utf8"), root, temporaryDirs))
        : bytes;
      acc[relative] = `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`;
    }
  }
  return acc;
}

export function diffTrees(a: TreeSnapshot, b: TreeSnapshot): Array<string> {
  const output: Array<string> = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[key] === b[key]) continue;
    output.push(`  ${key}: A=${a[key] ?? "(absent)"} B=${b[key] ?? "(absent)"}`);
  }
  return output.sort();
}

/** Files that a golden case writes below HOME before its run, with their exact bytes. */
export interface SeededTree {
  /** The seeded folder, relative to HOME, with `/` separators. */
  readonly root: string;
  /** Each seeded file, by its path below `root` with `/` separators, with its text. */
  readonly files: Readonly<Record<string, string>>;
}

/** Write each file of `seed` below `home`, with its parent folders. */
export function writeSeededTree(home: string, seed: SeededTree): void {
  for (const [name, text] of Object.entries(seed.files)) {
    const path = join(home, ...seed.root.split("/"), ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** The message of a thrown value, for a problem line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The differences between the seeded folder below `home` and `seed`: first
 * the sorted entry list (files and folders), compared name by name, then the
 * raw bytes of each seeded file, and each seeded file that is missing. Unlike
 * `snapshotTree`, it normalizes no line ending and no path, so a rewrite from
 * CRLF to LF and a new lock file both show. A folder or file that cannot be
 * read is a problem line, not a throw, so the driver fails one case and goes on.
 */
export function seededTreeProblems(home: string, seed: SeededTree): Array<string> {
  const folder = join(home, ...seed.root.split("/"));
  let isFolder: boolean;
  try {
    isFolder = lstatSync(folder, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (error) {
    return [`  seeded folder ${seed.root} cannot be read: ${errorMessage(error)}`];
  }
  if (!isFolder) return [`  seeded folder ${seed.root} is missing`];
  const names = Object.keys(seed.files).sort();
  const expected = [
    ...new Set(
      names.flatMap((name) => {
        const parts = name.split("/");
        return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
      }),
    ),
  ].sort();
  const problems: Array<string> = [];
  try {
    const actual = readdirSync(folder, { recursive: true, encoding: "utf8" })
      .map((entry) => entry.replaceAll("\\", "/"))
      .sort();
    if (
      expected.length !== actual.length ||
      expected.some((name, index) => name !== actual[index])
    ) {
      problems.push(
        `  seeded folder ${seed.root} entries differ: expected ${JSON.stringify(expected)} actual ${JSON.stringify(actual)}`,
      );
    }
  } catch (error) {
    problems.push(`  seeded folder ${seed.root} entries cannot be read: ${errorMessage(error)}`);
  }
  for (const name of names) {
    const path = join(folder, ...name.split("/"));
    try {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined) {
        problems.push(`  seeded file ${seed.root}/${name} is missing`);
      } else if (
        !stat.isFile() ||
        !readFileSync(path).equals(Buffer.from(seed.files[name]!, "utf8"))
      ) {
        problems.push(`  seeded file ${seed.root}/${name} changed its bytes`);
      }
    } catch (error) {
      problems.push(`  seeded file ${seed.root}/${name} cannot be read: ${errorMessage(error)}`);
    }
  }
  return problems;
}

export function diffText(label: string, a: string, b: string): Array<string> {
  if (a === b) return [];
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const output: Array<string> = [
    `  ${label} differs (${linesA.length} vs ${linesB.length} lines):`,
  ];
  for (let index = 0; index < Math.max(linesA.length, linesB.length); index++) {
    if (linesA[index] !== linesB[index]) {
      output.push(
        `    line ${index + 1}: A=${JSON.stringify(linesA[index] ?? "")} B=${JSON.stringify(linesB[index] ?? "")}`,
      );
      if (output.length > 12) {
        output.push("    …");
        break;
      }
    }
  }
  return output;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(stableJson(value), null, 2)}\n`;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableJson(item)]),
  );
}
