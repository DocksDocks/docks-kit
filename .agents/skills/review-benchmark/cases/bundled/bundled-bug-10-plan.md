## Yolo run: #164 Close the sync lock gaps of #163

Pull request: https://github.com/DocksDocks/public/pull/165. Checks: all 10 pass on `265f4bf`. Reviewed head: `265f4bf`.

### What changed
- A writing `docks-kit sync` now also locks each omp folder that it writes: the omp agent folder, the intercom folder, and the omp data root (plugin cache), in the same sorted folder-lock set as the Codex and agents folders (`syncDispatch.ts`, `ompSync.ts ompWriteFolders`).
- Folder creation happens under the locks, parent first: a sync creates a missing folder (mode 0700) only after it holds the locks of that folder's ancestors in the set, so a waiting sync never changes a shared folder that another sync holds.
- The omp paths are resolved once for the run. Every `omp` child that a sync starts goes through `ompChild.ts spawnOmp`, which keeps it on the locked data root. If the data root moves during the omp pipeline, the sync fails and asks for a new sync.
- `docks-kit omp --fast` checks `config.yml` first, then takes the home lock and the omp agent folder lock before it rewrites `config.yml`.
- A dry run requested through the `DRY_RUN` environment global (raw channel) takes no lock, like `--dry-run` and `--help`.
- Version 0.22.20 with a `CHANGELOG.md` entry; docs and skills updated.

### Decisions and corrections
- The user approved follow-up issue #163 and asked to run it as a yolo plan.
- The omp data root and `omp --fast` are locked too, because a sync's `omp plugin` child and `--fast` write the same folders (D1, D3, D9).
- A deployed file that is a symlink to another folder is locked through the deploy folder, not the target, so no lock file appears in a user-managed folder such as a dotfiles repository (D11).
- If the omp data root moves after the sync's last check, the sync can still exit 0; the next sync repairs it. The root appears only through `mkdir`, `omp config init-xdg`, or another home's `PI_CONFIG_DIR` (D13).

### Reviews
Plan review passed in round 11 (the user chose `Continue yolo` at the round-10 stall). Code review passed in round 4 with no open finding; round 3's two findings were rejected with evidence (D13).
Self-review (correctness, spec and tests, text and safety) found 1 correctness, 4 spec, and 4 text findings; each was fixed.
Open findings: none.

### Verification
- Red baselines: 8 spec tests failed before the fix (omp folder locks, `DRY_RUN`, `--fast`); the review-round tests for `--fast`, the child pin, and the moved root failed before their fixes.
- `bun run check`: exit 0 (1670 tests; golden suites 73 and 49 OK). `./docks-kit sync --dry-run`: exit 0.
- Acceptance A1-A15 pass; A15 is all 10 pull-request checks, including both Windows unit shards.

### Limits and failures
- CI on `3719bad` failed one Windows test that compared a path with backslashes against the kit's `/`-joined path; `265f4bf` fixes the test.
- Residuals that the plan records: a symlinked deployed file whose target two homes share (D11); a data root that moves after the last check (D13).
- New empty lock files when omp is selected: `.docks-kit-sync-lock.db` in the omp config root, the agent folder, and the intercom folder.

### Kept resources
- After `Merge now`: none.
- After `Leave pull request open`: the linked branch and its remote branch.

### After merge
- none

Closes #164
Closes #163

