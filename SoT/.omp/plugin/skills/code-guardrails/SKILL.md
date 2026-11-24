---
name: code-guardrails
description: "Use when setting up strict linter rules for TypeScript (oxlint, anti-slop), Rust (clippy), Swift (SwiftLint), Python (Ruff), or Bash (ShellCheck), or when code repeats raw numbers, strings, or test data instead of one named constant. Adds missing rules to the existing lint config, maps derived constants to one owner, and reports each change. Not for a lint error that tempts a suppression (use lint-no-suppressions), naming or comments (use code-clarity), or repo-wide sweeps (use refactor)."
user-invocable: true
metadata:
  pattern: tool-wrapper
  updated: "2026-11-24"
  content_hash: "10ee05e67c5bfbaf9f8f70d55d218a8938c4bec16f02951598c02f99ecf95d80"
---

# Code Guardrails

Agents often write the same raw value in many places, copy a value that another
module already owns, or skip lint rules that would catch low-quality code. This
skill does two jobs:

1. It adds strict linter rules to the project, so a tool rejects the problem on every run.
2. It applies the rules that no linter can check: one mapped source for each value,
   constants built from other constants, test data, and data read from its owner.

<constraint>
Each value has one owner. Before you write a literal that has a meaning, search
the project for an existing constant, config field, enum, or generated type with
the same meaning. If one exists, import it. Do not import a constant only because
its value is equal: two meanings that share a value get two names. If none exists,
define it once in the module that owns that domain, and build related values from
it (`MIB = BINARY_STEP * KIB`, not `1048576`). A second definition drifts: one
copy changes, the other copy does not, and the bug appears only at run time.
</constraint>

<constraint>
When the project has a lint config, change it only by adding rules. Do not loosen,
remove, or reorder an existing rule, and do not change the linter or formatter the
project chose. Report every rule you add.

These steps need approval: the install of a missing linter with the project's package
manager, and any other network step. A network step is any command that can reach the
network: an install, a download, a package runner, a dependency resolve, a build or
plugin that resolves packages, a remote config, or a remote lookup such as
`git ls-remote`. When you cannot tell that a command stays offline, treat it as a
network step. Before such a step, ask the user with the omp `ask` tool.
Do not install, download, or run the step until the user approves.
An error, a cancel, or a timeout result is not approval: do not run the step,
and end the turn. If `ask` is not available, put the question in your final
message and end the turn. An approval covers only the action that the user approved:
an install approval installs the tool, and it does not create or change a config.
To create or change a config, follow the Detect rules of the matching reference.
Propose a first config only for the exact file that the Verify command loads: the linter
that owns linting reads that file by its documented discovery, and the command passes no
flag that skips or replaces it. When the project has no lint command, use the reference's
standalone Verify command and the file that it loads. When you cannot establish which file
the Verify command loads, or the reference gives no config for the linter that owns
linting, report what you found and ask; do not propose a file. When you can propose a
file, show the config and ask before you create it, as this gate says.
For Python, follow the Detect rules of `references/python.md` instead.
A silent dependency or tool change is a change the user did not approve.

**Verify rule.** Verify with the project's own lint command, unchanged: the same
executable, version, arguments, working directory, and environment that the project
or its CI uses. When that command is a network step under the rule above, or when you
cannot tell, take the approval gate first, then run it unchanged. Never substitute
another executable, version, config, or directory. When the command cannot run here,
report that verification did not run.
</constraint>

<constraint>
Keep the raw-number lint rule on in test files. In tests, import production
constants for inputs and configuration. When a test checks a constant or a value
computed from constants, put the expected result in a named literal constant.
An assertion such as `expect(MIB).toBe(BINARY_STEP * KIB)` repeats the code under test,
so it passes even when the definition is wrong. A test-file exemption lets a copied
limit such as `fileOfSize(10485761)` pass lint and drift from production.
</constraint>

## When to use

- A project has no linter, or its linter runs with default rules only.
- Code repeats the same number, string, unit, limit, path, URL, key, or error code.
- A value is defined in two places, or a module copies a default that another module owns.
- A derived value is written as its computed result (`86400`, `1048576`).
- Tests repeat magic values, or assert a constant against itself.

Not for these tasks:

| Task | Use |
|---|---|
| A lint error tempts you to add a suppression comment | `lint-no-suppressions` |
| Unclear names, comments, or function boundaries | `code-clarity` |
| A closed set of states needs a union, enum, or newtype | `type-safety-discipline` |
| A repo-wide pass over dead code and duplicated blocks | `refactor` |
| A review of a diff for bugs and security | `code-review` |

## Workflow

Do only the jobs that the request asks for:

- **Lint setup** (the request asks for linter rules): do steps 1, 2, 3, and 6.
- **Value mapping** (the request is about repeated, copied, or derived values):
  do steps 4, 5, and 6. Do not change a lint config. When the request names
  one value, map that value only, and list the other candidates in the report.
- **Both jobs**: do all steps.

1. **Detect.** List the languages in the project and the lint config for each one.
   Read the matching reference in the table below.
2. **Add missing rules.** Compare the existing config with the reference config.
   Add the missing rules. Keep every existing rule that is stricter.
3. **Run the linter.** Follow the verify rule above. Fix each finding in
   the code. If a fix seems impossible, follow `lint-no-suppressions`.
4. **Find scattered values.** Run the check in "Find scattered values". Linters miss
   repeated strings and most repeated numbers.
5. **Map the values.** Move each repeated or copied value to its owner. Replace every
   use with an import.
6. **Report.** Use the report format below.

| Language | Linter | Reference |
|---|---|---|
| TypeScript, JavaScript | oxlint, plus the upstream anti-slop ruleset | [`references/typescript.md`](references/typescript.md) |
| Rust | clippy (`[lints.clippy]` or `[workspace.lints.clippy]`) | [`references/rust.md`](references/rust.md) |
| Swift | SwiftLint | [`references/swift.md`](references/swift.md) |
| Python | Ruff | [`references/python.md`](references/python.md) |
| Bash, sh | ShellCheck | [`references/bash.md`](references/bash.md) |

Formatters such as oxfmt, Prettier, rustfmt, swift-format, `ruff format`, and shfmt
change layout only. They do not find raw values or copied data.

## The constant map

A constant map is the set of modules that own the project's named values. Each
domain has one module, and every other file imports from it.

| Value kind | Examples | Owner |
|---|---|---|
| Sizes and units | `KIB`, `MIB`, `MAX_UPLOAD_BYTES` | A units or limits module |
| Durations | `REQUEST_TIMEOUT_MS`, `CACHE_TTL` | The module that uses the timer, or a shared limits module |
| Closed sets of states | `"pending"`, `"active"`, `"cancelled"` | A union or enum (`type-safety-discipline`) |
| External names | env var names, header names, API paths, queue names | The boundary module that reads or sends them |
| Runtime settings | ports, URLs, feature flags | One config module that parses the environment once |
| Messages and codes | error codes, user-facing text keys | The error module or the text catalog |
| Generated contracts | API schemas, database types | The generated file; never copy its values by hand |

Rules for the map:

- Put the unit in the name: `TIMEOUT_MS`, `MAX_BODY_BYTES`, `RETRY_DELAY_S`. A bare
  `TIMEOUT = 30` makes the reader guess seconds or milliseconds.
- Build derived values from base values. A reader can check `BINARY_STEP * KIB` in one look.
- Use a name that states the meaning, not the value. `MAX_RETRIES = 3` is useful;
  `THREE = 3` is not.
- Group by domain. A single `constants` file for the whole project becomes a second
  place that every change must touch. Use it only in a small project.
- Do not name values that have no meaning beyond themselves: `0`, `1`, `-1` as
  loop bounds or indexes, and `2` in `x / 2` for a midpoint.

```ts
// BAD — raw results, no units, and a second copy of the limit in another file
if (file.size > 10485760) throw new Error("File too large");
setTimeout(retry, 30000);
// src/api/upload.ts repeats: const limit = 10485760;

// GOOD — one owner, derived values, units in the names, imports elsewhere
// src/limits.ts
export const BINARY_STEP = 1024;
export const KIB = BINARY_STEP;
export const MIB = BINARY_STEP * KIB;
const MAX_UPLOAD_MIB = 10;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MIB * MIB;
const MS_PER_S = 1000;
const RETRY_DELAY_S = 30;
export const RETRY_DELAY_MS = RETRY_DELAY_S * MS_PER_S;

// src/api/upload.ts
import { MAX_UPLOAD_BYTES, RETRY_DELAY_MS } from "../limits";
if (file.size > MAX_UPLOAD_BYTES) throw new Error("File too large");
setTimeout(retry, RETRY_DELAY_MS);
```

Each reference shows the same model in the idiom of its language.

## Read data from its owner

Copied data is the same defect as a copied constant. Check these cases:

- **Configuration:** parse the environment once in the config module. Other code
  imports the parsed value. It does not call `process.env`, `std::env::var`,
  `os.environ`, or `ProcessInfo` again with its own default.
- **Defaults:** a default lives next to the setting it belongs to. Do not repeat it
  in the caller, the command-line parser, and the documentation.
- **API and database data:** use the generated or declared type. Do not write a
  second hand-made copy of a schema, a column list, or a status list.
- **Values that the system computes:** read them from the source, such as a version
  from the package manifest, not from a copied string.

## Find scattered values

Run these checks from the repository root. They read the files that git tracks
and the new files that `.gitignore` does not exclude. They list each value that
appears in 2 or more files. Each line gives the file count, the value, and each
`file:line` location. Change `langs` to match the project languages. To skip a
vendored or generated folder that git tracks, add a pathspec such as `':!vendor/'`.
The commands turn off column output, color, and submodule recursion, and `-z` puts a
NUL character after each file name, so git settings and a colon in a file name do not
change the result. A file name that holds a newline breaks the 3-line framing and
gives wrong results; leave such a file out with a pathspec.

```bash
# Print each value that appears in 2 or more files: file count, value, locations.
# Input: 3 lines per match: file name, line number, matched text.
# Returns failure when awk or sort fails.
group() {
  awk '
    NR % 3 == 1 { file = $0; next }
    NR % 3 == 2 { line = $0; next }
    {
      v = $0
      if (v ~ /^["\047]/) { v = substr(v, 2, length(v) - 2); if (length(v) < 4) next }
      else {
        if (v !~ /^0[xXbBoO]/) sub(/_?f(32|64)$/, "", v)
        sub(/_?[iu](8|16|32|64|128|size)$/, "", v); gsub(/_/, "", v)
      }
      if (!((v, file) in seen)) { seen[v, file] = 1; files[v]++ }
      where[v] = where[v] " " file ":" line
    }
    END { for (v in files) if (files[v] > 1) print files[v] "\t" v "\t" where[v] }' | sort -rn
  local s=("${PIPESTATUS[@]}")
  [ "${s[0]}" -eq 0 ] && [ "${s[1]}" -eq 0 ]
}
langs=('*.ts' '*.rs' '*.swift' '*.py' '*.sh')

# Print the matches as 3 lines each. Return the git grep status, or 2 when tr fails.
matches() {
  git grep --untracked --no-recurse-submodules --no-column --no-color -z -I -n -o \
    "$@" -- "${langs[@]}" | tr '\0' '\n'
  local s=("${PIPESTATUS[@]}")
  [ "${s[1]}" -eq 0 ] || return 2
  return "${s[0]}"
}

# git grep exits with 1 when nothing matches; a higher status is a failed scan.
# git grep also exits with 0 or 1 after a read error, so any error output fails the scan.
# The scan holds the matches in memory and groups them only after these checks pass.
scan() {
  local found='' errors='' status='' vars
  # Read the matches, the error output, and the status of matches into shell variables.
  vars=$( { errors=$( { status=0; found=$(matches "$@") || status=$?
    declare -p found status >&4; } 2>&1 ); declare -p errors; } 4>&1 )
  eval "$vars"
  case $status in '' | *[!0-9]*) echo "scan failed: cannot read the matches" >&2; return 2 ;; esac
  if [ "$status" -le 1 ] && [ -n "$errors" ]; then status=2; fi
  if [ "$status" -gt 1 ]; then
    echo "scan failed with status $status" >&2; printf '%s\n' "$errors" >&2; return "$status"
  fi
  if [ -z "$found" ]; then return 0; fi
  printf '%s\n' "$found" | group || { echo "scan failed: grouping failed" >&2; return 1; }
}

# Numbers: hexadecimal, binary, and octal literals, and decimal numbers with
# 2 or more digits, with an optional Rust type suffix such as u64.
# Single digits are left out because they are mostly counters and indexes.
scan -w -E '(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_.]*[0-9])(_?([iu](8|16|32|64|128|size)|f32|f64))?' &&

# Quoted strings on one line. The grouping drops strings under 4 characters.
scan -E "\"([^\"\\\\]|\\\\.)*\"|'([^'\\\\]|\\\\.)*'"
```

The checks match candidates on one line only. They count `'cache.key'` and
`"cache.key"` as one string. They count `1_024` and the Rust literal `1024u64` as
`1024`. A value that repeats in one file only is not listed. A lone quote can pair
with a later quote and hide a string, for example a Rust lifetime (`&'static`) or
an apostrophe in a comment.

When git grep exits with 1, no file matched, and the scan succeeds. A higher git grep
status, any error output from git grep or `tr` (such as a file that git cannot read),
or a failure of `tr`, `awk`, or `sort` means that the scan failed: the block prints an
error, stops, and returns a nonzero status. Do not read the empty output of a failed
scan as "no repeated values". The scan holds the matches in memory and uses no
temporary file, so a very large match stream uses more memory.

The output is a list of candidates, not a list of defects. The checks include test
files, so they also find a production value copied into a test constant. Short
values such as `10`, `30`, or `60` produce many candidates; check each one that
could be a limit, timeout, or size. Read each location in the output and decide:

| Finding | Action |
|---|---|
| Same meaning in 2 or more places | Define one constant in the owning module and import it |
| A computed result such as `86400` or `1048576` | Replace it with a derived constant |
| Different meanings that share a value | Keep them apart, with two names |
| Log text, test names, or one-time messages | Leave them |

## Test data

- Import production constants for inputs, limits, and configuration. If the limit
  changes, the test follows it.
- Put each expected result in a named constant when the test checks a constant or
  a calculation, such as `EXPECTED_MAX_UPLOAD_BYTES = 10_485_760`. This is the only
  place a copied raw value is the correct choice, and the name says why it is there.
- Keep the raw-number rule on in test files. Linters skip a literal that initializes
  a named constant, so the rule still rejects inline values such as `10485761`.
  SwiftLint always skips test code; for Swift tests, rely on the scan above.
- Put shared fixtures and builders in one test-support module. Do not copy the same
  sample object into every test file.
- Name a test value by its role: `validEmail`, `expiredToken`, not `data1`.

```ts
// BAD — tautology: the expected value repeats the definition
expect(MAX_UPLOAD_BYTES).toBe(10 * MIB);
// BAD — a copy of the production limit that drifts when the limit changes
expect(() => upload(fileOfSize(10485761))).toThrow();

// GOOD — named literal for the definition check, import for the behavior check
const EXPECTED_MAX_UPLOAD_BYTES = 10_485_760;
expect(MAX_UPLOAD_BYTES).toBe(EXPECTED_MAX_UPLOAD_BYTES);
expect(() => upload(fileOfSize(MAX_UPLOAD_BYTES + 1))).toThrow();
```

## Gotchas

| Mistake | Correction |
|---|---|
| Add a new `constants` file while one already exists | Search first; extend the existing owner |
| Turn off a lint rule for the whole project to fix one file | Fix the code, or follow `lint-no-suppressions` |
| Replace ESLint or Prettier with oxlint or oxfmt without a request | Add the rule to the tool the project uses; ask before a migration |
| Name every literal, including `0` and `1` in loops | Name values that carry a meaning only |
| Assume Rust and Bash linters catch raw values | They have no such rule; run "Find scattered values" |
| Turn off the raw-number rule for test files | Keep it on; name expected literals as constants |

## Report

End with this report, one row per change:

```markdown
| Change | File | Reason |
|---|---|---|
| Added `eslint/no-magic-numbers` | `.oxlintrc.json` | No rule caught raw numbers |
| Moved `MAX_UPLOAD_BYTES` to `src/limits.ts` | `src/api/upload.ts`, `src/ui/drop.ts` | Two copies of one limit |
```

Then list the tools you did not install and the questions for the user.

## Verification

- After lint setup, verify as the verify rule says. The lint command must
  pass with the new rules.
- After value mapping, run the two checks in "Find scattered values" again. Each
  remaining repeated value must have a reason in the report.
- Run the project tests. A moved constant must not change behavior.

## Report a problem with this skill

When this skill gives a wrong, outdated, or unsafe instruction, or a script that it ships fails, report the problem in the public DocksDocks/docks-kit repository. Use the `report-skill-issue` skill of the docks-kit kit plugin for the report. If that skill is not installed, do not file anything: give the user a draft instead. The draft names this skill and the docks-kit version, quotes the instruction, and states what happened and what you expected. Leave out secrets and private names.
