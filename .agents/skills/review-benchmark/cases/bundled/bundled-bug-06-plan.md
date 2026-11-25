## Problem

`ompYaml.ts` `mergeOmpConfig` is additive: its `mergeMappings` deployed-key retention loop returns every deployed key absent from the SoT to the merged result. **Removing a key from `SoT/.omp/config.yml` never removes it from an existing `~/.omp/agent/config.yml`.**

That gap has now caused three separate problems:

1. `compaction.thresholdTokens` had to ship as the sentinel `-1` rather than be deleted (#55).
2. The retired `providers.webSearchOrder` survived sync, and cleared only because omp itself drops retired keys when it writes.
3. The 18 keys removed in `cf90481` (#59) would have stayed on every existing machine forever.

## Fix

`cli/src/engine-native/ompRemovals.ts` adds the missing pass, mirroring `claudeRemovals.ts`: an inventory force-pruned on every sync without `--reconcile`. `ompSync.ts` calls it directly after the config merge, so it operates on the merged result.

### Two manifests, two rules

| Manifest | Rule | Why |
|---|---|---|
| `OMP_RETIRED_VALUES` | paired with the exact value the kit deployed; pruned **only while the deployed value still equals it** | a user who changed the setting keeps it. Every recorded value also equals omp's current default, so pruning changes no behaviour today and lets a later upstream default apply |
| `OMP_RETIRED_KEYS` | pruned at **any** value | the key itself no longer means anything; currently `providers.webSearchOrder` alone |

### Details

- Pruning removes an ancestor mapping it leaves empty, so `theme`, `terminal`, and `tui` disappear while `statusLine` keeps `compactThinkingLevel`.
- The document is edited through `parseDocument`, never reserialized, so formatting survives.
- A `commentBefore` holding several blocks keeps everything above the final blank-line separator and moves it to the next sibling. Only the last block sits against the removed key; a file header written directly above the first key would otherwise leave with it. **A test caught this** — the first implementation silently dropped the header.

## Why no fixture

No fixture carries an omp configuration — `home-drift`, `home-fresh`, `home-invalid-json`, `codex-toml`, and `statusline` contain no `.omp` directory and no `.yml` file at all. Seeding one would flip every `home-drift` omp golden from fresh deploy to merge, for weaker evidence than the checks below.

## Verification

`bun run check`: lint, format:check, typecheck, **656 unit tests**, 48 dry-run and 69 mutation golden cases — all pass.

Seven unit cases: value match, user-edited value left alone, outright retirement at an unshipped value, emptied ancestor removed while a populated one survives, comment handling, dry run leaving the file byte-identical, and an unparseable file returning 0 without throwing.

**The call site is proven against a real deployment**, which is stronger than a mocked wiring test. A machine still carrying all 18 keys retired in #59:

```
$ bun cli/src/main.ts sync omp --dry-run
[dry-run] merge embedded:SoT/.omp/config.yml -> ~/.omp/agent/config.yml (backup at …)
[dry-run] prune ~/.omp/agent/config.yml: symbolPreset, theme.dark, statusLine.preset,
  statusLine.showHookStatus, statusLine.sessionAccent, statusLine.transparent,
  terminal.showProgress, tui.textSizing, tui.tight, display.shimmer, omitThinking,
  hideThinkingBlock, autocompleteMaxVisible, emojiAutocomplete, readLineNumbers,
  interruptMode, autoResume, startup.changelogMode
```

Note the invocation: `bun cli/src/main.ts`, not `./docks-kit`. Running the launcher gave a **false negative** because `cli/dist` holds a 0.17.3 binary compiled before this module existed, and the version gate cannot tell a same-version binary from a current one. That is a distinct defect and gets its own PR.

No version bump: `0.17.3` is unreleased.
