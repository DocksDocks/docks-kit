## Yolo run: #104 docks-kit harnesses: a clear checklist picker

Pull request: https://github.com/DocksDocks/public/pull/107. Checks: all pass (check, lint, golden-dryrun, golden-mutation, and portable on ubuntu-24.04, macos-26, and windows-2025). Reviewed head: `59522a6`.

This branch contains the reviewed commits of #106 (plan #105), merged without a rebase. Merge #106 first; this diff then shows only the changes of plan #104.

### What changed
- `docks-kit harnesses` opens a new checklist picker. Enter or Space ticks the harness under the cursor, a Save row stores the selection, a hint line names the keys, and Escape, Ctrl+C, or Ctrl+D leaves the selection unchanged (`cli/src/commands/harnesses.ts`).
- The picker is a shared component on Effect's `Prompt.Custom`, with no new dependency (`cli/src/checklistPrompt.ts`). It draws a rounded panel that fits the terminal width, shows an error on the Save row when nothing is ticked, uses ASCII on a Windows console outside Windows Terminal, and drops color when `NO_COLOR` is set.
- The picker measures text in terminal cells from the pinned Unicode 18.0.0 East Asian Width table, and it erases the rows of the frame on screen after the terminal changes its width (`cli/src/terminalCells.ts`).
- `cli/docs/flags.md`, the root `AGENTS.md` layout table, and the 0.22.0 changelog entry describe the picker.

### Decisions and corrections
- The owner chose in this session: `Prompt.Custom` instead of OpenTUI or Ink, Enter or Space to toggle with a Save row, and only `docks-kit harnesses` in this change.
- The keys follow the APG keyboard conventions: arrows, `j` and `k`, Tab and Shift+Tab move; Home and End jump; Enter and Space activate; Escape cancels.
- Code review rounds 1 and 2 found that a wide character used two cells and that a resize changed the row count. The fix pins the full East Asian Width data and counts rows the way a terminal wraps.

### Reviews
Plan review passed in round 2. Code review passed in round 3.
Open findings: none.

### Verification
- `bun run check`: exit 0 (1365 tests passed, 11 skipped; golden-dryrun OK, 49 cases; golden-mutation OK, 73 cases).
- The plan issue records the red baseline of each step and of review rounds 1 and 2.
- `bun run check:generated`: exit 0.
- Live terminal runs in an empty tmpfs home: Down, Enter, End, and Space store `claude, agents, omp`; Down, Enter, and Escape print `Harness selection unchanged.`; `./docks-kit sync --dry-run` exits 0.
- A terminal emulator rendered the real command at 100 and 60 columns: the panel, the ticks, the count, the error on the Save row, and the wrapped note and hint.

### Limits and failures
- The first implementation run failed the type check and 27 tests, because a stale edit had deleted a helper; the restored helper passed every gate before the step commit.
- `clear` assumes that the terminal reflows a long line when the terminal narrows. On a terminal without reflow, a narrowing resize can make the panel erase a row above itself.
- The live terminal runs used Linux x64. The `check` and `parity` workflows of this pull request cover macOS and Windows.

### Kept resources
- After `Merge now`: none.
- After `Leave pull request open`: this branch, local and remote, its worktree, and this pull request.

### After merge
- The `cli-v0.22.0` release needs its own question.

Closes #104

