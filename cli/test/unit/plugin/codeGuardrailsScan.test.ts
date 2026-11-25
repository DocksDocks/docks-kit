import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IS_ROOT } from "../../lib/agentDocs/harness.ts";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

/**
 * The "Find scattered values" block of the code-guardrails skill, which the
 * kit plugin ships, run with `bash` on fixture Git repositories as an agent
 * runs it (DocksDocks/docks-kit#237). The block is Bash code that needs `bash`,
 * `git`, `tr`, `awk`, `sort`, and POSIX file modes, so the suite does not run on Windows.
 */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const SKILL = join(REPO_ROOT, "SoT/.omp/plugin/skills/code-guardrails/SKILL.md");
const FENCE = "```bash\n";
/** The last write of the capture: the error field and the end mark. */
const END_WRITE = `printf '%s\\0%s\\0' "\${segments[*]}" end`;

/** The bash block of the "Find scattered values" section of the shipped skill. */
function scanBlock(): string {
  const text = readFileSync(SKILL, "utf8");
  const section = text.slice(text.indexOf("## Find scattered values"));
  const start = section.indexOf(FENCE) + FENCE.length;
  return section.slice(start, section.indexOf("\n```", start) + 1);
}

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly env: NodeJS.ProcessEnv;
}

/** A temporary root with an empty HOME and TMPDIR, and Git without user or system settings. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "guardrails-scan-"));
  roots.push(root);
  const home = join(root, "home");
  const tmp = join(root, "tmp");
  mkdirSync(home);
  mkdirSync(tmp);
  writeFileSync(join(home, ".gitconfig"), "");
  const env = {
    PATH: process.env["PATH"],
    HOME: home,
    TMPDIR: tmp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
  };
  return { root, home, tmp, env };
}

function git(fx: Fixture, cwd: string, ...args: ReadonlyArray<string>): void {
  const child = spawnSync("git", [...args], {
    cwd,
    env: fx.env,
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  expect(child.status, child.stderr).toBe(0);
}

/** A Git repository at `dir` with `files` added to the index. */
function repo(fx: Fixture, dir: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(fx, dir, "init", "-q");
  git(fx, dir, "add", "-A");
  return dir;
}

interface ScanRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ScanOptions {
  /** Options of the `bash` command line, such as `-u`. */
  readonly flags?: ReadonlyArray<string>;
  /** Shell code that runs before the block, in the same shell. */
  readonly before?: string;
  /** Shell code that runs after the block; it ends the script. */
  readonly after?: string;
  /** The block to run, by default the shipped one. */
  readonly block?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Room for the output of the large match stream case (60000 lines). */
const SCAN_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Runs the block with `bash` in `cwd`, as an agent sources it. */
function scan(fx: Fixture, cwd: string, options: ScanOptions = {}): ScanRun {
  const script = join(mkdtempSync(join(fx.root, "scan-")), "scan.sh");
  writeFileSync(
    script,
    `${options.before ?? ""}\n${options.block ?? scanBlock()}\n${options.after ?? ""}\n`,
  );
  // A timeout stops a scan that hangs, so the case fails with its name instead of blocking the run.
  const child = spawnSync("bash", [...(options.flags ?? []), script], {
    cwd,
    env: { ...fx.env, ...options.env },
    encoding: "utf8",
    maxBuffer: SCAN_OUTPUT_BYTES,
    timeout: SPAWN_TIMEOUT_MS,
  });
  expect(child.signal, `the scan stopped on ${child.signal}`).toBeNull();
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

/** A folder with a command `name` that runs `body`, first on the PATH of the scan. */
function shim(fx: Fixture, name: string, body: string, shebang = "#!/bin/sh"): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(fx.root, `shim-${name}-`));
  writeFileSync(join(dir, name), `${shebang}\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return { PATH: `${dir}:${fx.env["PATH"]}` };
}

/** `text` as one single-quoted shell word, also when it holds a single quote. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The absolute path of the command `name` that the scan finds on PATH. */
function realCommand(fx: Fixture, name: string): string {
  const child = spawnSync("sh", ["-c", `command -v ${name}`], { env: fx.env, encoding: "utf8" });
  return child.stdout.trim();
}

const lines = (text: string): Array<string> => text.split("\n").filter((line) => line !== "");

/** The repository of the earlier scan checks (plan #215, R37, R38, R49). */
function valuesRepo(fx: Fixture): string {
  const dir = repo(fx, join(fx.root, "values"), {
    "src/a.rs": 'a = 1024u64; b = 1_024; c = 64u64;\ns = "don\'t retry"; p = "price in $";\n',
    "src/b.sh":
      'k=\'cache.key\'\nx=8080 y=8080 m=4096\ns="don\'t retry" p="price in $"\nt="key:a:b" p=31337\n',
    "src/x:y.py": 't = "key:a:b"\np = 31337\n',
    "src/c.py": 'a = "ok"; b = "cache.key"\n',
    "gen/g.py": "g = 4096\n",
    ".gitignore": "gen/\n",
  });
  for (const [key, value] of [
    ["grep.column", "true"],
    ["color.grep", "always"],
    ["color.ui", "always"],
    ["submodule.recurse", "true"],
  ] as const) {
    git(fx, dir, "config", key, value);
  }
  // Created after `git add`, so it stays untracked; the scan still reads it.
  writeFileSync(join(dir, "src/d.ts"), 'a = "ok"; b = "cache.key"\nconst n = 64;\n');
  return dir;
}

/** A repository with `count` numbers in each of two files: a large match stream. */
function largeRepo(fx: Fixture, count: number): string {
  const numbers = Array.from({ length: count }, (_, index) => String(100_000 + index)).join("\n");
  return repo(fx, join(fx.root, "large"), { "a.py": `${numbers}\n`, "b.py": `${numbers}\n` });
}

const pairRepo = (fx: Fixture, dir: string): string =>
  repo(fx, dir, { "a.py": "a = 1234\n", "b.py": "b = 1234\n" });

const WINDOWS = process.platform === "win32";

/** A UTF-8 locale of this host, if it has one; not probed on Windows, where the suite does not run. */
const UTF8_LOCALE = WINDOWS
  ? undefined
  : lines(
      spawnSync("locale", ["-a"], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS }).stdout ?? "",
    ).find((name) => /utf-?8$/i.test(name));
/**
 * Environment names that the commands of the scan may get. The shell of a shim adds PWD, and also SHLVL and `_`
 * when `/bin/sh` is Bash (macOS).
 */
const KEPT_NAMES =
  "^(PATH|HOME|TMPDIR|XDG_CONFIG_HOME|LANG|LC_[A-Z_]*|GIT_[A-Za-z0-9_]*|PWD|SHLVL|_)=";

describe.skipIf(WINDOWS)("code-guardrails scan block", () => {
  describe("earlier behavior", () => {
    it("lists each value that 2 or more files hold, with every location, under any Git display setting", () => {
      const fx = fixture();
      const run = scan(fx, valuesRepo(fx));
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const out = lines(run.stdout);
      expect(out).toContain("3\tcache.key\t src/b.sh:1 src/c.py:1 src/d.ts:1");
      expect(out).toContain("2\t64\t src/a.rs:1 src/d.ts:2");
      expect(out).toContain("2\tkey:a:b\t src/b.sh:4 src/x:y.py:1");
      expect(out).toContain("2\t31337\t src/b.sh:4 src/x:y.py:2");
      expect(out.some((line) => line.startsWith("2\tdon't retry\t"))).toBe(true);
      expect(out.some((line) => line.startsWith("2\tprice in $\t"))).toBe(true);
      // No color, no value from one file only (8080, and 1024 as 1_024 and 1024u64), no ignored copy
      // (4096), and no separator text between two quoted strings.
      expect(run.stdout).not.toContain("\u001b");
      expect(out.some((line) => /\t(8080|1024|4096)\t/.test(line))).toBe(false);
      expect(run.stdout).not.toContain("; b = ");
    });

    it("gives the same result under noclobber and nounset, and leaves no file in TMPDIR", () => {
      const fx = fixture();
      const dir = valuesRepo(fx);
      const plain = scan(fx, dir);
      for (const flags of [["-o", "noclobber"], ["-u"]]) {
        const run = scan(fx, dir, { flags });
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toBe(plain.stdout);
      }
      expect(readdirSync(fx.tmp)).toEqual([]);
    });

    it("succeeds without output when nothing matches, under errexit and pipefail", () => {
      const fx = fixture();
      const run = scan(fx, repo(fx, join(fx.root, "none"), { "a.py": "n = 64\n" }), {
        flags: ["-e", "-o", "pipefail"],
      });
      expect(run).toEqual({ status: 0, stdout: "", stderr: "" });
    });

    it("stops with the status of a failed git grep", () => {
      const fx = fixture();
      const dir = join(fx.root, "no-repository");
      mkdirSync(dir);
      const run = scan(fx, dir, { env: { GIT_CEILING_DIRECTORIES: fx.root } });
      expect(run.status).toBe(128);
      expect(
        lines(run.stderr).filter((line) => line === "scan failed with status 128"),
      ).toHaveLength(1);
    });

    it.skipIf(IS_ROOT)("fails on a file that git cannot read, also under noclobber", () => {
      const fx = fixture();
      const dir = repo(fx, join(fx.root, "unreadable"), { "a.py": "n = 64\n", "b.py": "n = 64\n" });
      chmodSync(join(dir, "b.py"), 0o000);
      for (const flags of [[], ["-o", "noclobber"]]) {
        const run = scan(fx, dir, { flags });
        expect(run.status).toBe(2);
        expect(lines(run.stderr)).toContain("scan failed with status 2");
        expect(run.stderr).toContain("'b.py': Permission denied");
      }
      chmodSync(join(dir, "b.py"), 0o644);
    });

    it.each([
      ["tr", "scan failed with status 2"],
      ["awk", "scan failed: grouping failed"],
      ["sort", "scan failed: grouping failed"],
    ])("fails when %s fails", (tool, message) => {
      const fx = fixture();
      // The shim reads its input first, so git grep does not meet a closed pipe.
      const run = scan(fx, valuesRepo(fx), { env: shim(fx, tool, "cat > /dev/null\nexit 3") });
      expect(run.status).not.toBe(0);
      expect(lines(run.stderr)).toContain(message);
    });
  });

  describe("capture", () => {
    it("runs no text that Git writes into the capture descriptor", () => {
      const fx = fixture();
      const dir = pairRepo(fx, join(fx.root, "s;touch PWNED;"));
      const run = scan(fx, dir, { env: { GIT_TRACE_SETUP: "4" } });
      expect(existsSync(join(dir, "PWNED"))).toBe(false);
      expect(run.stderr).not.toContain("command not found");
    });

    it("gives no command of the capture its private descriptor", () => {
      const fx = fixture();
      const dir = mkdtempSync(join(fx.root, "probes-"));
      // Each probe reports when descriptor 4 is open in it, then runs the real command.
      for (const name of ["git", "tr"]) {
        const real = shellQuote(realCommand(fx, name));
        // `true` is a regular builtin: a failed redirection of it does not end the shell.
        const body = `if ( true >&4 ) 2>/dev/null; then echo "descriptor 4 is open in ${name}" >&2; fi\nexec ${real} "$@"`;
        writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
        chmodSync(join(dir, name), 0o755);
      }
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
        env: { PATH: `${dir}:${fx.env["PATH"]}` },
      });
      expect(run.stderr).not.toContain("descriptor 4 is open");
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(["2\t1234\t a.py:1 b.py:1"]);
    });

    it("keeps a large match stream out of the environment of its commands, and keeps the caller's allexport", () => {
      const fx = fixture();
      const count = 60_000;
      const run = scan(fx, largeRepo(fx, count), {
        before: "export found=caller; set -a",
        after: 'status=$?; case $- in *a*) exit "$status" ;; *) exit 9 ;; esac',
      });
      expect(run.stderr).not.toContain("Argument list too long");
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toHaveLength(count);
    });

    it.each([
      ["without its end mark", `printf '%s\\0' "\${segments[*]}"`],
      ["with another end mark", `printf '%s\\0%s\\0' "\${segments[*]}" ends`],
    ])("fails when the capture ends %s", (_, write) => {
      const fx = fixture();
      const block = scanBlock();
      expect(block).toContain(END_WRITE);
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
        block: block.replace(END_WRITE, write),
      });
      expect(run.status).toBe(2);
      expect(lines(run.stderr)).toContain("scan failed: cannot read the matches");
    });

    it.each([
      ["a line break", String.raw`printf '\n' >&2`],
      ["a NUL byte", String.raw`printf '\000' >&2`],
    ])("fails when a stage writes only %s to its error output", (_, write) => {
      const fx = fixture();
      const tr = realCommand(fx, "tr");
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
        env: shim(fx, "tr", `${write}\nexec ${shellQuote(tr)} "$@"`),
      });
      expect(run.status).toBe(2);
      expect(lines(run.stderr)).toContain("scan failed with status 2");
    });
  });

  describe("caller state", () => {
    const NORMAL = ["2\t1234\t a.py:1 b.py:1"];

    it.each([
      [
        "readonly and integer variables with the names of the scan",
        "readonly part=; declare -i errors found status",
      ],
      ["functions named printf and read", "printf() { echo hijack >&2; }; read() { return 1; }"],
      ["a debug hook that every function inherits", 'trap "echo hook >&2" DEBUG; set -T'],
      // EXECIGNORE would also change the command search of the calling shell itself, so it is not in this case.
      [
        "exported variables that change how Bash runs",
        "export FUNCNEST=2 BASH_COMPAT=31 POSIXLY_CORRECT=1",
      ],
    ])("gives the normal result with %s in the calling shell", (_, before) => {
      const fx = fixture();
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), { before });
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(NORMAL);
      expect(run.stderr).not.toContain("hijack");
    });

    it("starts the scan shell without the caller's trace setting and BASH_ENV file", () => {
      const fx = fixture();
      const marker = join(fx.root, "bash-env-ran");
      const bashEnv = join(fx.root, "bash-env.sh");
      writeFileSync(bashEnv, `touch ${shellQuote(marker)}\n`);
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
        before: `set -x; export SHELLOPTS BASH_ENV=${shellQuote(bashEnv)}`,
      });
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(NORMAL);
      // The caller traces its own launch line; a traced scan shell would also print its scan calls.
      expect(run.stderr).not.toContain("+ scan -w");
      expect(existsSync(marker)).toBe(false);
    });

    it("keeps the script of the scan shell from an env wrapper that reads its input", () => {
      const fx = fixture();
      // The wrapper reads all of its input when it lists the environment or would start a shell.
      const drain = `case " $* " in *" -0 "* | *" bash "*) cat > /dev/null ;; esac\nexec ${shellQuote(realCommand(fx, "env"))} "$@"`;
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), { env: shim(fx, "env", drain) });
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(NORMAL);
    });

    it("waits for a slow scan when the caller exports a read timeout", () => {
      const fx = fixture();
      const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
        env: {
          ...shim(fx, "git", `sleep 2\nexec ${shellQuote(realCommand(fx, "git"))} "$@"`),
          TMOUT: "1",
        },
      });
      expect(run.status, run.stderr).toBe(0);
      expect(lines(run.stdout)).toEqual(NORMAL);
    });

    it("lists the environment once, starts no git, and fails when env -0 cannot list it all", () => {
      const fx = fixture();
      const realEnv = realCommand(fx, "env");
      const realGit = realCommand(fx, "git");
      const dir = pairRepo(fx, join(fx.root, "pair"));
      // `first` is the env -0 behavior of the first call, `later` of each later call.
      const withShims = (name: string, first: string, later: string) => {
        const calls = join(fx.root, `${name}-calls`);
        const shims = mkdtempSync(join(fx.root, `${name}-`));
        const scripts = {
          env: [
            'case "$1" in -0)',
            `  if [ -e ${shellQuote(calls)} ]; then echo env >> ${shellQuote(calls)}; ${later}; fi`,
            `  echo env >> ${shellQuote(calls)}; ${first} ;;`,
            "esac",
            `exec ${shellQuote(realEnv)} "$@"`,
          ].join("\n"),
          git: `echo git >> ${shellQuote(calls)}\nexec ${shellQuote(realGit)} "$@"`,
        };
        for (const [command, body] of Object.entries(scripts)) {
          writeFileSync(join(shims, command), `#!/bin/sh\n${body}\n`);
          chmodSync(join(shims, command), 0o755);
        }
        const run = scan(fx, dir, { env: { PATH: `${shims}:${fx.env["PATH"]}` } });
        return { run, calls: lines(readFileSync(calls, "utf8")) };
      };
      const partial = "printf 'A=1\\000'; exit 3";
      const failing = withShims("failing", partial, partial);
      expect(failing.run.status).toBe(2);
      expect(lines(failing.run.stderr)).toContain(
        "scan failed: env -0 cannot list the environment",
      );
      expect(failing.calls).toEqual(["env"]);
      // A second, partial list would hide a failure if the scan read it.
      const once = withShims("once", `exec ${shellQuote(realEnv)} -0`, partial);
      expect(once.run.status, once.run.stderr).toBe(0);
      expect(lines(once.run.stdout)).toEqual(NORMAL);
      expect(once.calls.filter((call) => call === "env")).toEqual(["env"]);
    });

    it("gives no command of the scan a function of the caller, also through a Bash-based wrapper", () => {
      const fx = fixture();
      const dir = pairRepo(fx, join(fx.root, "pair"));
      const wrapper = shim(
        fx,
        "tr",
        `printf x > /dev/null\nexec ${shellQuote(realCommand(fx, "tr"))} "$@"`,
        "#!/usr/bin/env bash",
      );
      const exported = scan(fx, dir, {
        env: wrapper,
        before: "printf() { echo hijack >&2; }; export -f printf",
      });
      // A caller in privileged mode passes on a function entry that it did not take itself.
      const passedOn = scan(fx, dir, {
        flags: ["-p"],
        env: { ...wrapper, "BASH_FUNC_printf%%": "() { echo hijack >&2; }" },
      });
      for (const run of [exported, passedOn]) {
        expect(run.status, run.stderr).toBe(0);
        expect(lines(run.stdout)).toEqual(NORMAL);
      }
    });

    it.skipIf(UTF8_LOCALE === undefined)(
      "keeps other variables from its commands in a UTF-8 locale, also after values with a broken character",
      () => {
        const fx = fixture();
        // Each BROKEN_ value ends in the first byte of a two-byte UTF-8 character, which can hide the NUL after
        // it from a reader in a UTF-8 locale on Bash 5.2. The tr shim reports each name outside the kept list,
        // so the entry after a broken value counts, whatever its name.
        const tr = realCommand(fx, "tr");
        const report = `env | grep -v -E '${KEPT_NAMES}' | sed 's/=.*//; s/^/leaked /' >&2`;
        const run = scan(fx, pairRepo(fx, join(fx.root, "pair")), {
          env: { ...shim(fx, "tr", `${report}\nexec ${shellQuote(tr)} "$@"`), LC_ALL: UTF8_LOCALE },
          before:
            "export BROKEN_A=$'a\\xc3' SECRET_1=1 BROKEN_B=$'b\\xc3' SECRET_2=2 BROKEN_C=$'c\\xc3' SECRET_3=3",
        });
        expect(run.stderr).not.toContain("leaked");
        expect(run.status, run.stderr).toBe(0);
        expect(lines(run.stdout)).toEqual(NORMAL);
      },
    );
  });
});
