import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { Command } from "effect/cli";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleepMs } from "node:timers/promises";
import { parse } from "yaml";

import { ompCommand } from "../../src/commands/omp";
import { acquireKitLock, releaseKitLock, type KitLock } from "../../src/engine-native/kitLock";
import {
  FAST_ON_TIER,
  toggleDeployedOpenAiTier,
  toggleOpenAiTier,
} from "../../src/engine-native/ompFastMode";
import { mergeOmpConfig } from "../../src/engine-native/ompYaml";
import { syncLockPath } from "../../src/engine-native/scratch";
import { payloadText } from "../../src/payload";

const roots: Array<string> = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CONFIG = `# user note
tier:
  openai: none
  anthropic: none

advisor:
  enabled: true
`;

/** The toggle of `docks-kit omp --fast`. */
const toggleFast = (text: string) => toggleOpenAiTier(text, FAST_ON_TIER);

describe("toggleOpenAiTier with priority (--fast)", () => {
  it("turns fast on and changes only tier.openai", () => {
    const toggle = toggleFast(CONFIG);
    expect(toggle).toMatchObject({ previous: "none", next: "priority" });
    expect(toggle.text).toBe(CONFIG.replace("openai: none", "openai: priority"));
  });

  it("turns fast off when tier.openai is priority", () => {
    const toggle = toggleFast(toggleFast(CONFIG).text);
    expect(toggle).toMatchObject({ previous: "priority", next: "none" });
    expect(toggle.text).toBe(CONFIG);
  });

  it("replaces ultrafast with plain fast instead of turning off", () => {
    const toggle = toggleFast(CONFIG.replace("openai: none", "openai: ultrafast"));
    expect(toggle).toMatchObject({ previous: "ultrafast", next: "priority" });
  });

  it("treats a missing tier block as off and creates it", () => {
    const toggle = toggleFast("advisor:\n  enabled: true\n");
    expect(toggle).toMatchObject({ previous: "none", next: "priority" });
    expect(parse(toggle.text)).toEqual({
      advisor: { enabled: true },
      tier: { openai: "priority" },
    });
  });

  it("rejects a tier key that is not a mapping", () => {
    expect(() => toggleFast("tier: fast\n")).toThrow("omp config.yml key 'tier' must be a mapping");
  });

  it("survives a sync merge with the shipped SoT config", () => {
    const deployed = toggleFast(CONFIG).text;
    const merged = parse(mergeOmpConfig(payloadText("SoT/.omp/config.yml"), deployed));
    expect(merged.tier.openai).toBe("priority");
  });
});

describe("toggleOpenAiTier with ultrafast", () => {
  it("turns ultrafast on from none and changes only tier.openai", () => {
    const toggle = toggleOpenAiTier(CONFIG, "ultrafast");
    expect(toggle).toMatchObject({ previous: "none", next: "ultrafast" });
    expect(toggle.text).toBe(CONFIG.replace("openai: none", "openai: ultrafast"));
  });

  it("turns ultrafast off when tier.openai is ultrafast", () => {
    const toggle = toggleOpenAiTier(toggleOpenAiTier(CONFIG, "ultrafast").text, "ultrafast");
    expect(toggle).toMatchObject({ previous: "ultrafast", next: "none" });
    expect(toggle.text).toBe(CONFIG);
  });

  it("replaces priority with ultrafast instead of turning off", () => {
    const toggle = toggleOpenAiTier(
      CONFIG.replace("openai: none", "openai: priority"),
      "ultrafast",
    );
    expect(toggle).toMatchObject({ previous: "priority", next: "ultrafast" });
    expect(toggle.text).toBe(CONFIG.replace("openai: none", "openai: ultrafast"));
  });

  it("treats an unset tier.openai as off and keeps tier.anthropic", () => {
    const toggle = toggleOpenAiTier("tier:\n  anthropic: priority\n", "ultrafast");
    expect(toggle).toMatchObject({ previous: "none", next: "ultrafast" });
    expect(parse(toggle.text)).toEqual({ tier: { anthropic: "priority", openai: "ultrafast" } });
  });

  it("lets --fast replace ultrafast with priority", () => {
    const toggle = toggleFast(toggleOpenAiTier(CONFIG, "ultrafast").text);
    expect(toggle).toMatchObject({ previous: "ultrafast", next: "priority" });
    expect(toggle.text).toBe(CONFIG.replace("openai: none", "openai: priority"));
  });
});

describe("toggleDeployedOpenAiTier", () => {
  it("keeps a symlinked config.yml a link", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-fast-link-"));
    roots.push(root);
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    const linkTarget = join(dotfiles, "config.yml");
    writeFileSync(linkTarget, CONFIG);
    const configPath = join(root, "config.yml");
    symlinkSync(linkTarget, configPath);

    const toggle = toggleDeployedOpenAiTier(configPath, "priority");

    expect(toggle).toMatchObject({ previous: "none", next: "priority" });
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(linkTarget, "utf8")).tier.openai).toBe("priority");
  });
});

/** The lock file that a writing sync takes inside the omp agent folder. */
const FOLDER_LOCK = ".docks-kit-sync-lock.db";

/**
 * Run `docks-kit omp <argv>` in this process. Record what it prints and its
 * exit code: the code of a `process.exit` call, else 1 for a failure and 0
 * for a success, as `BunRuntime.runMain` does.
 */
async function runOmp(
  argv: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const lines: Array<string> = [];
  const record = (...values: Array<unknown>) => void lines.push(values.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => record(chunk) ?? true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => record(chunk) ?? true);
  const exitCodes: Array<number> = [];
  vi.spyOn(process, "exit").mockImplementation((code) => {
    exitCodes.push(Number(code ?? 0));
    throw new Error(`exit ${String(code)}`);
  });

  const exit = await Effect.runPromiseExit(
    Command.runWith(ompCommand, { version: "x" })(argv).pipe(Effect.provide(BunServices.layer)),
  );
  vi.restoreAllMocks();

  const exitCode = exitCodes[0] ?? (Exit.isSuccess(exit) ? 0 : 1);
  return { exitCode, output: lines.join("\n") };
}

/** A temporary HOME for `omp --fast` and `omp --ultrafast`, set in-process, with the lock wait bound `waitMs`. */
function fastHome(waitMs: string): { readonly home: string; readonly agentDir: string } {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-fast-lock-")));
  roots.push(home);
  // engineHome reads USERPROFILE on win32, so both keys point at the temp home.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("DOCKS_KIT_SYNC_LOCK_WAIT_MS", waitMs);
  return { home, agentDir: join(home, ".omp", "agent") };
}

/** Take the lock at `path` as another run does, or throw when it is held. */
async function takeLock(path: string, privateDirectory: boolean): Promise<KitLock> {
  const held = await acquireKitLock(path, { waitMs: 0, privateDirectory });
  if (held.kind !== "acquired") throw new Error(`expected a free lock at ${path}`);
  return held.lock;
}

function heldLine(lock: string): string {
  return `another docks-kit sync holds ${lock}; run sync again after it ends`;
}

describe("omp --fast under the folder lock", () => {
  it("exits 1 with the held line and leaves config.yml unchanged while a sync holds the omp agent folder", async () => {
    // A short wait, so that the held lock ends the run quickly.
    const { agentDir } = fastHome("100");
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, "config.yml");
    writeFileSync(configPath, CONFIG);
    const lock = join(agentDir, FOLDER_LOCK);
    const held = await takeLock(lock, false);

    try {
      const run = await runOmp(["--fast"]);

      expect(run.exitCode).toBe(1);
      expect(run.output).toContain(heldLine(lock));
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG);
    } finally {
      releaseKitLock(held);
    }
  });

  it("exits 1 with the held line and leaves config.yml unchanged while a sync holds the home sync lock", async () => {
    const { home, agentDir } = fastHome("100");
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, "config.yml");
    writeFileSync(configPath, CONFIG);
    const lock = syncLockPath(home);
    const held = await takeLock(lock, true);

    try {
      const run = await runOmp(["--fast"]);

      expect(run.exitCode).toBe(1);
      expect(run.output).toContain(heldLine(lock));
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG);
    } finally {
      releaseKitLock(held);
    }
  });

  it("exits 2 before any lock when config.yml is missing, so a folder that appears during the home lock wait is not toggled", async () => {
    // A long wait: a run that waits for the home lock is still waiting when the folder appears.
    const { home, agentDir } = fastHome("10000");
    const configPath = join(agentDir, "config.yml");
    const homeLock = await takeLock(syncLockPath(home), true);
    let folderLock: KitLock | undefined;

    try {
      const pending = runOmp(["--fast"]);
      // The check before the locks ends the run at once; a run that waits is still pending.
      await Promise.race([pending, sleepMs(3000)]);
      expect(existsSync(join(home, ".omp"))).toBe(false);

      // A sync of another home that shares the folder creates it and holds its lock.
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(configPath, CONFIG);
      folderLock = await takeLock(join(agentDir, FOLDER_LOCK), false);
      releaseKitLock(homeLock);
      const run = await pending;

      expect(run.exitCode).toBe(2);
      // The kit joins its paths with "/", so compare the path without its separator style.
      expect(run.output.replaceAll("\\", "/")).toContain(
        `${configPath.replaceAll("\\", "/")} does not exist; run 'docks-kit sync' first`,
      );
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG);
    } finally {
      if (folderLock !== undefined) releaseKitLock(folderLock);
      else releaseKitLock(homeLock);
    }
  });

  it("exits 1 with the held line when another home takes the omp agent folder lock while --fast waits for the home lock", async () => {
    // The home lock goes before this wait ends; the folder lock stays past it.
    const { home, agentDir } = fastHome("1000");
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, "config.yml");
    writeFileSync(configPath, CONFIG);
    const homeLock = await takeLock(syncLockPath(home), true);
    const lock = join(agentDir, FOLDER_LOCK);
    let folderLock: KitLock | undefined;

    try {
      const pending = runOmp(["--fast"]);
      await sleepMs(200);
      folderLock = await takeLock(lock, false);
      releaseKitLock(homeLock);
      const run = await pending;

      expect(run.exitCode).toBe(1);
      expect(run.output).toContain(heldLine(lock));
      expect(readFileSync(configPath, "utf8")).toBe(CONFIG);
    } finally {
      if (folderLock !== undefined) releaseKitLock(folderLock);
      else releaseKitLock(homeLock);
    }
  });
});

describe("omp --ultrafast", () => {
  it("toggles tier.openai to ultrafast and back to none, and keeps tier.anthropic", async () => {
    const { agentDir } = fastHome("100");
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, "config.yml");
    writeFileSync(configPath, CONFIG.replace("anthropic: none", "anthropic: priority"));
    const shownPath = configPath.replaceAll("\\", "/");

    const on = await runOmp(["--ultrafast"]);
    expect(on.exitCode).toBe(0);
    expect(on.output.replaceAll("\\", "/")).toContain(
      `omp ultrafast mode ON for OpenAI/Codex models: tier.openai none -> ultrafast in ${shownPath}`,
    );
    expect(on.output).toContain(
      "New omp sessions use it; in a running session, use /fast ultra|off or restart omp.",
    );
    expect(parse(readFileSync(configPath, "utf8")).tier).toEqual({
      openai: "ultrafast",
      anthropic: "priority",
    });

    const off = await runOmp(["--ultrafast"]);
    expect(off.exitCode).toBe(0);
    expect(off.output.replaceAll("\\", "/")).toContain(
      `omp ultrafast mode OFF for OpenAI/Codex models: tier.openai ultrafast -> none in ${shownPath}`,
    );
    expect(parse(readFileSync(configPath, "utf8")).tier).toEqual({
      openai: "none",
      anthropic: "priority",
    });
  });

  it.each([
    [["--ultrafast", "--fast"]],
    [["--ultrafast", "--model", "free/model"]],
    [["--ultrafast", "--pick"]],
    [["--ultrafast", "hello"]],
  ])("refuses %j and leaves config.yml unchanged", async (argv) => {
    const { agentDir } = fastHome("100");
    mkdirSync(agentDir, { recursive: true });
    const configPath = join(agentDir, "config.yml");
    writeFileSync(configPath, CONFIG);

    const run = await runOmp(argv);

    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("--ultrafast toggles ultrafast mode and exits; pass it alone");
    expect(readFileSync(configPath, "utf8")).toBe(CONFIG);
  });
});
