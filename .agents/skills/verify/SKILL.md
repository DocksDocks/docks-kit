---
name: verify
description: "Use when checking a change to docks-kit end to end: run the CLI the way a user does (sync dry run, toolchain doctor, removed target and flag), the dry-run goldens, the real omp on the kit trigger rules, the kit plugin smoke in an isolated omp state, the talk tool between two isolated omp processes, and the talk UI of an omp in a pseudo-terminal, and inspect exit codes and output lines. Not for unit tests (run `bun run test:unit`), lint, or a release."
metadata:
  updated: "2026-11-27"
---

# Verify docks-kit

docks-kit is a CLI that a user runs from the checkout (`./docks-kit`) or from the global install. Flows V1 to V4 run it from the repository root and read its exit code and output. V5 runs the real omp on the kit trigger rules. V6 links the kit plugin into the real omp in an isolated state. No flow writes to the home folder outside a docks-kit scratch folder: `sync --dry-run` plans the deploy only, the golden suite runs each case in its own temporary home, `omp ttsr test --rule` tests one rule file without loading other rules, and V6 writes only to its scratch folder and removes it at the end.

Hosts: the commands below are POSIX shell for Linux and macOS. On Windows, run `.\docks-kit.ps1` in place of `./docks-kit` for V1 and V4 and read the exit code from `$LASTEXITCODE`; for V2, read the omp row of `.\docks-kit.ps1 toolchain check`. V3 does not run on Windows: `cli/test/golden-dryrun.ts` exits 2 on a host whose executables need a suffix, because the snapshots are Linux-canonical. On Windows, run `bun run typecheck` and `bun run test:unit` instead; `bun run smoke:package` runs on POSIX hosts only, and the CI job `portable (windows-2025) checks` proves the global install of the bundle on Windows. V6 does not run on Windows: omp reads the home folder from `HOME` only on Linux and macOS, so `omp-smoke.ts` prints `FAIL omp-smoke.ts runs on Linux and macOS only` and exits 2.

## Prerequisites

| Need | Check command | Expected result |
|---|---|---|
| Bun at the CI pin | `bun --version` | `1.4.5` |
| omp at the toolchain floor | `omp --version` | `omp/19.2.1` |
| Dependencies installed | `test -d node_modules && echo present` (PowerShell: `if (Test-Path node_modules) { 'present' }`) | `present` |
| docks-kit on PATH (V6 scratch folder) | `docks-kit --version` | One version line |

## Drive and inspect

| Id | Flow | Command or tool action | Expected result |
|---|---|---|---|
| V1 | omp sync plan | `./docks-kit sync --dry-run; echo "exit $?"` | Lines that start with `[dry-run]` and name only omp, `~/.pi/agent/intercom`, and `~/.docks-kit/omp-plugin` paths, never `~/.agents` or `~/.claude`; then `--- Sync complete ---`, a `Repo:` line, an `omp:` line, and `exit 0`. The kit plugin is one line, `[dry-run] sync embedded:SoT/.omp/plugin/ -> <home>/.docks-kit/omp-plugin`, not one `cp` line for each file. Then `[dry-run] omp plugin uninstall --scope user docks@docks` and `[dry-run] omp plugin uninstall --scope user plan-lifecycle@docks`, and `[dry-run] omp plugin marketplace remove docks` only when an omp registry lists the `docks` marketplace. No `omp plugin install` line names `docks@docks` or `plan-lifecycle@docks`. Observed 2026-11-20 on Linux x64 with omp 19.0.1, on a home whose registry lists `docks`: 9 `[dry-run]` lines (`cp embedded:SoT/.omp/...` for the 3 agent-folder files that differ, `sync embedded:SoT/.omp/plugin/ -> /home/<user>/.docks-kit/omp-plugin`, `omp plugin uninstall --scope user docks@docks`, `omp plugin uninstall --scope user plan-lifecycle@docks`, `omp plugin marketplace remove docks`, `omp install pi-intercom@0.14.0`, `omp plugin link /home/<user>/.docks-kit/omp-plugin`), a blank line, `--- Sync complete ---`, `Repo:     <checkout>`, `omp:      /home/<user>/.omp/agent`, `exit 0` |
| V2 | Toolchain doctor | `./docks-kit toolchain check 2>&1 \| grep -E '^omp '` | One omp row whose INSTALLED, FLOOR, and VERIFIED columns are equal and whose STATUS is `ok` |
| V3 | Dry-run goldens through the engine and the public CLI | `bun run golden:dryrun` | A line `golden-dryrun: OK (<n> case(s))` and exit 0 |
| V4 | Removed sync target and flag | `./docks-kit sync omp --dry-run; echo "exit $?"; ./docks-kit sync --dry-run --prune; echo "exit $?"` | First the sync help on stdout, then `ERROR` and `Unexpected positional argument: "omp"` on stderr, and `exit 1`. Then `unknown flag --prune for 'sync'` and `exit 2`. Observed 2026-11-19 on Linux x64: exactly these lines |
| V5 | Trigger rules on a large tool call, in the real omp | `bun .agents/skills/verify/scripts/ttsr-snippet.ts big-reset \| omp ttsr test --rule SoT/.omp/plugin/rules/git-safety.md --source tool --tool eval --file -`, then the same command with `big-quiet` | For `big-reset`, `Triggered (1)` and a `git-safety` line within a few seconds. For `big-quiet`, `No rules triggered. (evaluated 1)`. The `big-reset` snippet is a 21 KB eval cell with many `\"` escapes that ends with `sh("git reset --hard HEAD")`. The rules of 0.22.29 stayed quiet on it after 4.7 s: JavaScriptCore stopped at its match limit and reported no match, so the rule failed open |
| V6 | Kit plugin in the real omp, isolated | `bun .agents/skills/verify/scripts/omp-smoke.ts; echo "exit $?"`, then `bun .agents/skills/verify/scripts/omp-smoke.ts hooks; echo "exit $?"`, then `bun .agents/skills/verify/scripts/omp-smoke.ts talk; echo "exit $?"`, then `bun .agents/skills/verify/scripts/omp-smoke.ts talk-ui; echo "exit $?"` | The load mode prints `docks-kit-omp -> <checkout>/SoT/.omp/plugin`, `skills: 33`, `agents: code-reviewer,plan-reviewer`, `warnings: 0`, and `exit 0`. The `hooks` mode prints the 20 `ok` lines of the V6 section below and `exit 0`. The `talk` mode prints the 19 `ok` lines of the V6 `talk` section below and `exit 0`. The `talk-ui` mode prints the 11 `ok` lines of the V6 `talk-ui` section below and `exit 0`. Observed 2026-11-26 on Linux x64 with omp 19.2.1: exactly these lines; the load mode took 1 s, the `hooks` mode 4 s, and the `talk` mode 4 s to 13 s. Observed 2026-11-27 on Linux x64 with omp 19.2.1: the `talk-ui` mode printed exactly these lines in 3 s to 4 s |

## V6 — Kit plugin smoke in an isolated omp state

`omp-smoke.ts` creates a docks-kit scratch folder and makes all omp state of the run live there. omp gets only `PATH`, `USER`, `LANG`, `LC_*`, and `TERM` from the environment, so no credential and no omp session variable reaches it. It also gets `HOME` set to a home folder in the scratch folder, `PI_CONFIG_DIR` set to a config root relative to that home, and `XDG_STATE_HOME` and `TMPDIR` set to scratch folders. The scratch home holds a fresh `.cache/docks-kit/tidy.stamp`, so the session-start sweep of `hygiene.ts` (`docks-kit tidy --apply`) is not due and does not start. The script starts a fake local OpenAI-compatible model, runs `omp plugin link <checkout>/SoT/.omp/plugin`, and finds the package through the npm row `docks-kit-omp` of `omp plugin list --json`. It removes the scratch folder at the end, also after a failure. The run writes nothing outside the scratch folder: the real `~/.omp`, the real `~/.cache/docks-kit`, and the real `verify-gate.jsonl` stay unchanged. Use `--repo <path>` to test another checkout. Use `--omp <binary>` to run another omp binary in place of `omp` from `PATH`, in each mode; the script resolves a relative path from the current folder.

The load mode reads `omp skill list --json` and the task tool of one `omp -p` session. It counts the skills whose file is inside the linked plugin folder (the 32 skills moved from DocksDocks/docks and `workspace-hygiene`), and it lists the plugin agents that the task tool offers. It fails when the `omp.extensions` list of the linked `package.json` has a `talk.js` entry, because the kit plugin does not load `talk` before the cutover; omp loads such an entry without a warning. The `hooks` mode makes a scratch git repository with its own git config. The repository holds a root `AGENTS.md`, a root `README.md`, `notes.txt`, and the nested node `scripts/AGENTS.md` with `scripts/ci.mjs`. The fake model plays scripted tool calls in `omp -p --mode json` sessions, and the script reads the JSON event stream, the requests that the fake model receives, `git log`, and the `verify-gate.jsonl` log of each session. Each session has its own `XDG_STATE_HOME` in the scratch folder. Expected output of the `hooks` mode, in order:

```text
ok install
ok gate-enforce-1-blocked
ok gate-enforce-2-blocked
ok gate-enforce-3-allowed
ok gate-enforce-trailer-allowed
ok gate-observe-commit-runs
ok gate-observe-log
ok gate-off-commit-runs
ok gate-off-no-log
ok gate-log-no-text
ok nudge-node-edit
ok nudge-root-edit-none
ok nudge-failed-edit-none
ok nudge-url-write-none
ok hygiene-scratch-tool
ok hygiene-temp-reminder
ok extensions-loaded
ok sessions
ok isolated
ok real-state
exit 0
```

| Line | Session and tool calls | Expected result |
|---|---|---|
| `gate-enforce-1-blocked`, `gate-enforce-2-blocked` | `DOCKS_VERIFY_GATE=enforce`: `bash` `git commit -m 'docs: fix typo'`, two times | Each call is blocked. Its tool result is an error with the reason that names the `Verified:` trailer. |
| `gate-enforce-3-allowed` | Same session: the same commit a third time | The gate allows the commit after two denials in one session. `git log` holds one new `docs: fix typo` commit. |
| `gate-enforce-trailer-allowed` | Same session: `git commit --allow-empty -m 'x' -m 'Verified: none - probe'` | The commit runs, and the last commit holds the trailer. |
| `gate-observe-commit-runs`, `gate-observe-log` | `DOCKS_VERIFY_GATE` unset (observe): one bare commit | The commit runs. The log holds one line with only the fields `time`, `session_id`, `cwd`, `mode` (`observe`), and `message_sources` (`["-m"]`). |
| `gate-off-commit-runs`, `gate-off-no-log` | `DOCKS_VERIFY_GATE=off`: one bare commit | The commit runs. The log holds no line. |
| `gate-log-no-text` | The logs of all gate sessions | No line holds the command or the message text (`git commit`, `fix typo`, `Verified`, `probe`). |
| `nudge-node-edit` | `edit` of `scripts/ci.mjs` | The edit succeeds. After the tool result, the event stream holds a separate added-context message (role `developer`) with `Edited files inside context-tree node(s): scripts`. The tool result itself does not hold that text. |
| `nudge-root-edit-none` | `edit` of the root `README.md` | The edit succeeds. No added-context message follows. |
| `nudge-failed-edit-none` | `edit` of `scripts/ci.mjs` with the stale snapshot tag of the first read | The edit fails. No added-context message follows. |
| `nudge-url-write-none` | `write` to `local://notes.md`; the session folder is inside the `scripts` node | The write succeeds. No added-context message follows. |
| `hygiene-scratch-tool` | The requests of a session with one `bash` `mktemp -d` call | A request lists the `scratch_new` tool with `Prefer it over /tmp`. |
| `hygiene-temp-reminder` | Same session: the `mktemp -d` result | After the tool result, an added-context message holds the reminder `Prefer a directory from the \`scratch_new\` tool`. |
| `extensions-loaded` | All sessions | omp reported no warning that names the linked plugin folder or `docks-kit-omp`, and no `Failed to load extension` record for a plugin file, `hygiene.ts` included. |
| `isolated` | The whole run | The `tidy.stamp` of the scratch home kept its modification time, so no hygiene sweep started. |
| `real-state` | The whole run | The real omp registry files kept their modification times. The real `verify-gate.jsonl` has no new line with a `cwd` inside the scratch folder. Lines that other omp sessions add during the run do not count. |

A `FAIL <reason>` line in the load mode, or a `FAIL <name>: <reason>` line in the `hooks`, `talk`, or `talk-ui` mode, and `exit 1` mean that the check failed; the reason tells what the run saw. A warning count above 0 is a failure, and the `FAIL` line names each warning. `install` and `sessions` fail when an omp command exits with a status other than 0. `FAIL could not remove scratch folder <path>` and `exit 1` mean that the folder stays; remove it with `docks-kit scratch remove <path>`. In the `talk` and `talk-ui` modes, this line can also name the registry folder.

### The `talk` mode

`omp-smoke.ts talk` checks the `talk` tool of `cli/talk/` (#250) in two real omp processes. The kit plugin does not load `talk` yet, so the mode links a changed copy of the plugin:

1. It builds `talk.js` with `bun cli/scripts/build-talk.ts --out <scratch>/talk-build`, copies `SoT/.omp/plugin` to `<scratch>/plugin`, adds `extensions/talk.js` and the manifest entry `./extensions/talk.js` to the copy, and links the copy. The copy keeps each symbolic link as it is. The mode refuses a symbolic link on the copy, on its `extensions` folder, and on its `package.json`, and it refuses a copy that already has `extensions/talk.js`, so no write goes through a link to a file outside the scratch folder. `SoT/.omp/plugin` does not change, so the load mode still counts 33 skills and finds no `talk.js` entry.
2. It makes a private registry folder (mode 0700) with `mkdtemp` in the system temporary root, for example `/tmp/dkt-AbC123`, and sets `DOCKS_KIT_TALK_DIR` to it for both omp processes. A socket path in the scratch folder is too long for `sun_path`. The cleanup removes the registry folder with the scratch folder, also after a failure, SIGINT, or SIGTERM. The last line, `registry-removed`, checks after the cleanup that the folder is gone.
3. The isolated `config.yml` sets `tools.commands: false`. Thus omp gives `talk` to the model as a provider tool and does not mount it as a Bash command.
4. It starts the peer as `omp --mode rpc` and sends RPC commands to it: `prompt`, `get_state`, `get_entries`, `new_session`, and `fork`. Each RPC response must have `success: true`, and each `get_entries` response must have an `entries` array of objects and a `leafId` that names one of them. Each entry has a string `id`, a string `type`, and a `parentId` that is `null` or names another entry. Each `custom_message` entry has a string `customType` and a string or array `content`. Each talk entry has a string `content` and `details.messageId` of 16 lowercase hex digits. Else the step fails. A delivered message is the entry with `type` `custom_message`, `customType` `talk`, and `details.messageId` equal to the message id of the result. An absent message is one whose message id and payload text are in no field of any entry of an answer that continues the kept answer of the session: after the step, a sentinel talk message goes to the same session, and the answer that holds it must contain every entry of the kept answer with the same `parentId`, each talk entry of the kept answer must be there again as a talk entry with the same `details.messageId` and `content`, and the parent chain from its `leafId` must hold the sentinel and the kept leaf. It runs the sender as `omp -p --mode json`. The fake model gives each process its own model id (`talk-peer`, `talk-sender`). The script writes each turn of the sender, and a turn waits until the script has acted on the peer, so one sender process does all the `talk` calls. The peer model answers an ask with a `reply` call. It holds the turn of the RPC prompt `SLOW-TURN: wait for the driver.` until the cancel check ends, so the peer is busy.

Expected output of the `talk` mode, in order:

```text
ok install
ok talk-offered
ok talk-list
ok talk-send
ok talk-ask-reply
ok talk-queued
ok talk-cancel
ok new-session-list
ok new-session-send
ok new-session-old-instance-not-live
ok fork-list
ok fork-send
ok fork-old-instance-not-live
ok closed-peer-not-live
ok extensions-loaded
ok sessions
ok isolated
ok real-state
ok registry-removed
exit 0
```

| Line | Action | Expected result |
|---|---|---|
| `install` | Build, copy, link, and registry folder | The build and each omp command exit 0. The plugin copy has no symbolic link on a path that the mode writes. The registry folder has mode 0700. |
| `talk-offered` | The first provider request of the peer (for the RPC prompt `Reply with ok.`) and of the sender | Each request offers the `talk` tool. The script makes no `talk` call before this check. |
| `talk-list` | Sender: `list`; again after 250 ms, at most 20 times | A line without `(this session)` shows the first 8 characters of the peer session id from RPC `get_state`. The script keeps the full instance id of that line. |
| `talk-send` | Sender: `send` with `to` set to the full peer session id | The result reads `Delivered:` and names the kept instance id. RPC `get_entries` of the peer holds the talk entry with that message id, and the answer of the turn that the message started comes after it. |
| `talk-ask-reply` | Sender: `ask` with `instance`. The peer model calls `reply` with `replyTo` set to the ask id. | The result of the waiting `ask` holds `**Reply from` and the reply text with the ask id. |
| `talk-queued` | RPC `prompt` `SLOW-TURN: wait for the driver.` makes the peer busy. Sender: `send` with `instance`. | The result reads `Queued:` and names a message id and the kept instance id. |
| `talk-cancel` | Sender: `cancel` with the message id and the instance id of the `talk-queued` result. Then the slow turn ends. | The result reads `Cancelled:` and names the same message id. When the peer is idle again, a sentinel `send` to the same instance is delivered, the answer continues the `talk-send` answer, and no entry of `get_entries` holds that message id or the payload text `talk smoke: while busy`. |
| `new-session-list` | RPC `new_session`. Sender: `list`, with the same retries. | The session id changed. A line shows the new session with an instance id that is not the old one, and no line shows the old instance id. Session ids of one run can start with the same 8 characters, so the check also compares the instance ids. |
| `new-session-send` | Sender: `send` with `to` set to the full new session id | As `talk-send`, for the new instance id. |
| `new-session-old-instance-not-live` | Sender: `send` with `instance` set to the old instance id, which the same sender process listed before | The result reads `talk: the send failed: not-live`. After 0.5 s, a sentinel `send` to the new instance is delivered, the answer continues the `new-session-send` answer, the peer is still in the new session, and no entry of that answer holds the message id or the payload text of that send. |
| `fork-list`, `fork-send`, `fork-old-instance-not-live` | RPC `fork` with `entryId` set to the last assistant message of the new session. Then the same actions as for `new_session`, with the instance id of `new-session-list` as the old instance id. | As the `new-session-` lines. Also, the answer that confirmed `fork-send`, which is the kept answer, holds the talk entry of `new-session-send`, which the fork inherited. The sentinel answer of `fork-old-instance-not-live` continues the kept answer, so it holds that entry again with the same `id`, `parentId`, `details.messageId`, and `content`. |
| `closed-peer-not-live` | The peer stdin ends and the peer exits. Sender: `send` with `instance` set to the instance id of `fork-list`. | The result reads `talk: the send failed: not-live`. |
| `extensions-loaded`, `isolated`, `real-state` | The whole run; the warnings include the standard error of the peer | As in the `hooks` mode |
| `sessions` | Both omp processes | The sender exits 0 after its last turn. The peer exits 0 after its stdin ends. |
| `registry-removed` | After the cleanup | The registry folder does not exist. |

A failed scenario check stops the scenario. Each scenario line after it prints `FAIL <name>: not run, because an earlier check failed`. The lines from `extensions-loaded` on run in each case.

### The `talk-ui` mode

`omp-smoke.ts talk-ui` checks the interactive parts of `talk` (#251, `cli/talk/ui/`) in a real omp in TUI mode: the list that `alt+t` opens, the compose and confirm views, the message card, and `/talk handover`. It links the same plugin copy and uses the same private registry folder and cleanup as the `talk` mode (steps 1 and 2 above). Then:

1. The isolated `config.yml` sets `tools.commands: false`, `startup.setupWizard: false`, `startup.checkUpdate: false`, and `marketplace.autoUpdate: "off"`. An interactive omp in a fresh home stops at the setup wizard unless `startup.setupWizard` is `false`.
2. It reads `omp --version`. omp 19.2.0 or later runs the checks below. An older omp runs the checks of "omp before 19.2.0".
3. It starts omp with the model `omp-smoke/talk-ui` in a pseudo-terminal of 240 columns and 50 rows (`Bun.spawn` with `terminal`, `TERM=xterm-256color`). The script writes key bytes and waits for screen text that shows after a mark. It takes the mark before it writes the key. It removes the ANSI codes, and it reads a carriage return or a cursor move as a line break. omp repaints by diff, so a search from an older mark could find a stale frame. Each wait fails after 30 s. The TUI omp is ready when its footer shows `omp smoke fake model`.
4. After the TUI omp is ready, it starts the peer as `omp --mode rpc` with the model `talk-peer`. When two omp processes started at the same time in the fresh state folder, the peer exited 1 in one run, so the script starts them one after the other. A prompt with the marker `SMOKE-LIST` or `SMOKE-CARD` makes the peer model call `talk` once, and the script reads the tool result from the next request. The fake model answers the handover side turn of the TUI omp (the request that holds the handover template) with a two-line draft, and every other turn with `ok`.

Expected output of the `talk-ui` mode with omp 19.2.0 or later, in order:

```text
ok install
ok ui-ready
ok ui-list
ok ui-compose-send
ok ui-card
ok ui-handover
ok extensions-loaded
ok sessions
ok isolated
ok real-state
ok registry-removed
exit 0
```

| Line | Action | Expected result |
|---|---|---|
| `install` | As in the `talk` mode, and `omp --version` | As in the `talk` mode. Also, `omp --version` names a version `omp/<x>.<y>.<z>`. |
| `ui-ready` | Start the TUI omp, then the peer. Peer: `list` (prompt `SMOKE-LIST`); again after 250 ms, at most 20 times | The footer shows the model name. The peer list shows the own row and exactly one other row. The script keeps the instance id of each row. |
| `ui-list` | `ESC t` (`alt+t`) in one write | The screen shows the list title `talk sessions` and the peer instance id. |
| `ui-compose-send` | Enter on the peer row, which the list selects first. Type `talk-ui smoke: composed hello`, then Enter. | The compose view shows its placeholder and then the typed text. The confirm view shows `Send to <peer instance id>: type <code>` and `Kind: message`. The script reads the code from that line. It types the first letter, waits for `Typed: <letter>_`, and then types the second letter in a separate write. RPC `get_entries` of the peer then holds a talk entry with the composed text. |
| `ui-card` | Peer: `send` with `instance` set to the TUI instance id and a message of four lines (prompt `SMOKE-CARD`) | The result reads `Delivered:`. The TUI screen shows the card header ``talk message from `<name>` · `<peer folder>` · <HH:MM>``, where `<peer folder>` is the work folder of the run. It shows the first three lines and `… 1 more lines`, and not the fourth line. omp's default card does not draw `… 1 more lines`. |
| `ui-handover` | Type `/talk handover <full peer session id>`, then Enter. The side turn gives the draft. Type `edited ` at the start of the draft, then `ctrl+s`. | The review shows the draft, and then the edited first line. The confirm view names the peer instance id and `Kind: handover`, and the script types the code as in `ui-compose-send`. RPC `get_entries` of the peer then holds a talk entry with `details.kind` `handover` whose content holds the whole edited text. |
| `extensions-loaded`, `isolated`, `real-state` | The whole run; the warnings include the screen text of the TUI omp and the standard error of the peer | As in the `hooks` mode |
| `sessions` | Both omp processes | The TUI omp exits 0 after `ctrl+d`. The peer exits 0 after its stdin ends. |
| `registry-removed` | After the cleanup | The registry folder does not exist. |

A failed check stops the flow in the same way as in the `talk` mode. The reason of a failed screen wait quotes the end of the screen text. The mode was run on Linux only; no macOS host was available.

#### omp before 19.2.0

omp before 19.2.0 has no reactive UI (#251 G7), so `talk` must turn itself off there with one notice (#251 a8, #248 a11). Run the mode with the omp 19.1.1 release binary: download `omp-linux-x64` and `SHA256SUMS.txt` from the GitHub release v19.1.1 of omp to one folder, run `sha256sum -c --ignore-missing SHA256SUMS.txt` there (expected: `omp-linux-x64: OK`), run `chmod +x omp-linux-x64` there only after the check passes, and run `bun .agents/skills/verify/scripts/omp-smoke.ts talk-ui --omp <folder>/omp-linux-x64; echo "exit $?"`. The TUI omp runs alone, and no peer starts.

Expected output, in order:

```text
ok install
ok old-omp
ok old-notice
ok old-no-command
ok extensions-loaded
ok sessions
ok isolated
ok real-state
ok registry-removed
exit 0
```

| Line | Action | Expected result |
|---|---|---|
| `old-omp` | `omp --version`, then start the TUI omp | The version comes before 19.2.0, and the footer shows the model name. |
| `old-notice` | Wait for the first complete frame that shows the notice; at the end, after `old-no-command`, wait until the output drains | The first complete frame that shows the notice that ends with `talk needs omp 19.2.0 or later, so the talk tool is off.` only tells the script that talk is ready; it is not the check. A complete frame is the rows between autowrap off `ESC [?7l` and autowrap on `ESC [?7h`, with both markers received. The pseudo-terminal can split a frame between two reads, and a later frame can draw the notice again, so the script checks the notices one time, after `old-no-command` and before `ctrl+d`: it waits until no output comes for 1 s and no frame stays open, and then reads all complete frames. Each `talk:` text in a complete frame is that notice, no complete frame shows it two times, and all the complete frames show the same notice text. When `old-no-command` fails, this line reads `not checked`. |
| `old-no-command` | Type `/talk`, then Enter | omp gives `/talk` to the model as a prompt, and the screen shows the `ok` answer. So omp has no `/talk` command. The model request of that prompt offers the built-in `read` tool and does not offer `talk`, so the tool is off too. |
| `extensions-loaded` | The whole run; the warnings include the screen text | No warning and no `Failed to load extension` record names the plugin copy, so `talk.js` loaded without an error. |
| `sessions` | The TUI omp | It exits 0 after `ctrl+d`. |

The other lines are as above. Observed 2026-11-27 on Linux x64 with omp 19.1.1 (the release binary matched its `SHA256SUMS.txt`): exactly these lines in 6 s, with the build and the drain wait of `old-notice`. The screen showed `Warning: talk: this omp has no jsx of @oh-my-pi/pi-tui, signal of @oh-my-pi/pi-tui, isUiNode of @oh-my-pi/pi-tui, @oh-my-pi/pi-tui/text/width. talk needs omp 19.2.0 or later, so the talk tool is off.`

## Failure signs

| Sign | Meaning | Next step |
|---|---|---|
| `=== GOLDEN MISMATCH` in V3 | The CLI output changed | Read the diff; when the change is intended, run `bun cli/test/golden-dryrun.ts --update-goldens`, then `bun run format` |
| omp row status `below-floor` or `above-verified` in V2 | The installed omp differs from `SoT/toolchain.json` | Check the omp release against the kit before you move the pin |
| V5 prints `No rules triggered.` for `big-reset`, or takes seconds | A condition scans the buffer in more than linear time, or hits the JavaScriptCore match limit | Run `bunx vitest run cli/test/unit/ompTriggerRules.test.ts cli/test/unit/ompTriggerBackstop.test.ts` and fix the condition that the shape guard or the Bun backstop names (`cli/docs/command-guards.md`, omp trigger rules) |
| V6 prints `skills:` other than `33`, or misses an agent | omp did not load a skill or agent file of `SoT/.omp/plugin`, or a folder moved | Check the folders under `SoT/.omp/plugin/skills/` and `SoT/.omp/plugin/agents/`, and the `name` frontmatter of each `SKILL.md` and agent file |
| V6 prints `FAIL extensions-loaded` or `warnings:` above `0` with `Failed to load extension` | A kit extension throws when omp loads it | Fix the file that the `FAIL` line names in `SoT/.omp/plugin/extensions/` |
| V6 prints a `FAIL gate-` or `FAIL nudge-` line | The gate or the nudge acted on the wrong command, path, or node | Check `checkCommand` in `SoT/.omp/plugin/extensions/verify-gate-core.ts` or `nudgeText` in `SoT/.omp/plugin/extensions/context-tree-core.ts`, and their adapters `verify-gate.ts` and `context-tree-nudge.ts` |
| V6 prints a `FAIL hygiene-` line | The `scratch_new` description or the temporary-file reminder lost its preference for scratch, or the reminder did not run | Check the `scratch_new` description and `SCRATCH_NOTE` in `SoT/.omp/plugin/extensions/hygiene.ts` |
| V6 `talk` prints `FAIL install` with `build-talk.ts failed` | The talk bundle does not build | Run `bun cli/scripts/build-talk.ts --out <folder>` with a scratch folder and fix the error that it names |
| V6 `talk` prints `FAIL talk-offered` | omp did not load `talk.js`, or it mounted `talk` as a Bash command | Read the `extensions-loaded` line. Check that the omp version supports `tools.commands` (`omp --version`, V2) |
| V6 `talk` prints a `FAIL talk-`, `FAIL new-session-`, `FAIL fork-`, or `FAIL closed-peer-` line | The `talk` tool or the talk transport gave a wrong result; the reason quotes the tool result | Run `node node_modules/vitest/vitest.mjs run cli/test/unit/talk`, and check `cli/talk/tool/` and `cli/docs/talk-transport.md` |
| V6 `talk-ui` prints `FAIL ui-ready` or `FAIL old-omp` with `footer with the model name` | The TUI omp did not start in the pseudo-terminal, for example because it shows the setup wizard | Read the screen text in the reason. Check `startup.setupWizard` in the isolated `config.yml` and the omp version (V2) |
| V6 `talk-ui` prints a `FAIL ui-` line with `the screen shows no` or `no talk entry` | A view, the card, or the review did not draw the expected text, or the send did not arrive in the peer session; the reason of a screen wait quotes the end of the screen | Run `node node_modules/vitest/vitest.mjs run cli/test/unit/talk`, and check `cli/talk/ui/` and `cli/docs/talk-ui.md` |
| V6 `talk-ui` with an omp before 19.2.0 prints `FAIL old-notice` or `FAIL old-no-command` | `talk` did not turn itself off on the old omp, or it showed another notice | Check the capability probe in `cli/talk/extension.ts` and `cli/talk/ui/host.ts` |
