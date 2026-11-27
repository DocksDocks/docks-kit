import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  checkedSpawnExitCode,
  cleanup,
  cleanupProblems,
  runEngine,
  type EngineRun,
} from "../lib/goldenExecution";
import {
  childHostId,
  cleanupTemporaryDirs,
  makeStubDir,
  readStubHost,
} from "../lib/goldenResources";

describe("run home cleanup", () => {
  /**
   * A run home whose nonempty folders a sync left at mode 000, as `run`
   * gets it. The `finally` gives the folders back their mode when a removal
   * failed, so a failed test leaves no folder that a later removal cannot list.
   */
  function withLockedHome(run: (home: EngineRun) => void): void {
    const home = mkdtempSync(join(tmpdir(), "golden-cleanup-test-"));
    const outer = join(home, ".pi", "agent", "intercom");
    const inner = join(outer, "notes");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, "config.json"), "{}\n");
    writeFileSync(join(inner, "marker"), "kept\n");
    chmodSync(inner, 0o000);
    chmodSync(outer, 0o000);
    try {
      run({ home } as EngineRun);
    } finally {
      if (existsSync(home)) {
        chmodSync(outer, 0o700);
        chmodSync(inner, 0o700);
        rmSync(home, { recursive: true, force: true });
      }
    }
  }

  // A permission does not stop root, and Windows ignores the POSIX mode.
  const lockable = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!lockable)(
    "removes a home with nonempty folders at mode 000 and reports no problem",
    () => {
      withLockedHome((run) => {
        expect(cleanupProblems([run])).toEqual([]);
        expect(existsSync(run.home)).toBe(false);
      });
    },
  );

  it.skipIf(!lockable)("lets cleanup remove such a home without a throw", () => {
    withLockedHome((run) => {
      cleanup([run]);
      expect(existsSync(run.home)).toBe(false);
    });
  });

  it("reports a home that cannot be removed as a problem line, without a throw", () => {
    // A NUL byte makes every file system call fail at once.
    expect(cleanupProblems([{ home: join(tmpdir(), "golden\0cleanup") } as EngineRun])).toEqual([
      expect.stringMatching(/^ {2}the run home .* cannot be removed: /),
    ]);
  });
});

describe("checkedSpawnExitCode", () => {
  it("classifies an ETIMEDOUT spawn error before a numeric status", () => {
    const error = Object.assign(new Error("spawnSync bash ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(() => checkedSpawnExitCode("bash", { status: 130, signal: "SIGTERM", error })).toThrow(
      "bash timed out: Error: spawnSync bash ETIMEDOUT",
    );
  });

  it("reports the killing signal when no status is available", () => {
    expect(() => checkedSpawnExitCode("bash", { status: null, signal: "SIGTERM" })).toThrow(
      "bash terminated by signal SIGTERM",
    );
  });

  it("rejects a result with neither status nor signal", () => {
    expect(() => checkedSpawnExitCode("bash", { status: null, signal: null })).toThrow(
      "bash completed without status or signal",
    );
  });
});

describe("stub host pairing", () => {
  afterAll(() => {
    cleanupTemporaryDirs();
  });

  it("records the native host so a native run pairs on any recording host", () => {
    expect(readStubHost(makeStubDir({}, { nativeHost: true }))).toBe(childHostId(true));
  });

  it("fails before spawning when the planted host is not the host the child runs as", () => {
    // Written, not recorded on a foreign machine: the canonical child is always
    // Linux, so a Windows marker is a mismatch on every runner - including a
    // Linux one, where the native and canonical hosts are the same id.
    const stubs = makeStubDir();
    writeFileSync(join(stubs, ".golden-stub-host"), "windows\n");

    expect(() => runEngine(["--version"], "home-fresh", stubs)).toThrow(
      /stub host mismatch: stubs were planted for windows but this child runs as linux/,
    );
  });
});
