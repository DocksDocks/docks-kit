## Summary

- **Live model catalogs.** `docks-kit models` reads the model list from each enabled harness:
  - Claude: the Anthropic models API with the Claude Code login (`~/.claude/.credentials.json`), cached 6 h in `kit.db`.
  - Codex: `~/.codex/models_cache.json` (rows with `visibility: "list"`).
  - omp: `omp models --json`.
  - `SoT/models.json` stays the overlay for aliases and notes, and the fallback when a live list is unavailable. The output names the fallback reason. `--refresh` bypasses the cache. `models omp` is new.
  - `docks-kit model`, the `model` engine mode, and `--claude-model` / `--codex-model` validation use the same resolved list.
- **SQLite kit store.** Per-machine state moves from `~/.docks-kit/state.json` to `~/.docks-kit/kit.db` (`node:sqlite`, WAL, mode 0600). `kitDb.ts withKitDb` is the only opener and runs append-only migrations. The first run imports `state.json` once and renames it to `state.json.migrated`. A store from a newer schema is refused, and reads fall back to defaults.
- **`docks-kit toolchain outdated [--refresh]`.** It compares each `verified` pin with the newest upstream release named by the new `SoT/toolchain.json` `upstream` field (npm, optional major line, or GitHub releases). Report only; successful lookups cache 24 h.
- Version 0.19.0, CHANGELOG, docs topics, and kit-mechanic skills updated.

## Verification

- `bun run check` and `bun run check:generated` pass (672 unit tests, golden dry-run 48, golden mutation 69).
- `cli/test/goldens/dryrun.json`: four public rows changed by design (`--help` descriptions and the `(live list unavailable: …)` line in `models`). No engine-mode golden changed.
- Live smoke on Linux x64: the real `state.json` migrated; `models claude` is live with a cache hit on the second run; `models codex` and `models omp` are live; an empty HOME gets curated lists with reasons and no `kit.db`; `sync --dry-run --claude-model=claude-bogus-1` warns and exits 0; `toolchain outdated` reports omp, typescript-language-server, skills-cli, and pi-intercom as newer.
- Compiled `linux-x64` binary: legacy import, migration, WAL checkpoint, and mode 0600 verified; `bun run smoke:native` passes.

## Notes

- macOS keeps the Claude Code login in the Keychain. The kit does not read it, so macOS gets the curated Claude list with the no-login reason.
- To go back to an older docks-kit, rename `state.json.migrated` back to `state.json`. An older kit ignores `kit.db`.

