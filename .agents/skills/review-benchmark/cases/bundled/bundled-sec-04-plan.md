## Summary

Agents left behind worktrees, temporary directories, processes, and containers, and the guards that protect the home directory also blocked their cleanup. This change adds checked cleanup commands and a kit-owned omp plugin. The Claude Code and Codex SoT files do not change.

- `docks-kit scratch new|remove`: private agent temporary directories. Removal accepts only a real path strictly inside the scratch root, the system temporary directory, or `/var/tmp`, through a directory chain that no other user can change.
- `docks-kit tidy [--apply] [--repo <path>] [--report]`: removes merged, clean, idle worktrees and their local containers, stops orphaned processes in agent directories, and removes idle scratch. It fails closed when it cannot verify the process list or a local Docker endpoint. `--report` lists other disk and memory use without changes.
- `docks-kit sync omp` materializes the plugin `docks-kit-omp` to `~/.docks-kit/omp-plugin` and links it: the tools `scratch_new`, `scratch_remove`, and `tidy_report`, creation reminders, a stop check, the automatic sweep (at most once per 12 hours), the `workspace-hygiene` skill, and `/cleanup`.
- omp denies `find -delete`, `find -exec rm`, and `xargs rm` in every position; idle subagents park after 2 minutes and an idle browser closes after 10 minutes.
- omp prompt rules: checked removal commands, cleanup of created resources, and production cleanup of remote resources only after an `ask`.
- Version 0.21.0; CHANGELOG, README, AGENTS.md, `command-guards` and `flags` topics, and the `omp-sync-context` skill are updated.

Closes #89

## Verification

- `bun run check` exits 0 (83 test files, 1210 tests; dry-run and mutation goldens OK); `bun run check:generated` and `bun run test:runtime:posix` pass.
- `./docks-kit sync omp --dry-run` prints the four plugin `cp` lines and `omp plugin link`, and changes nothing.
- omp smoke runs: the bulk-removal deny blocks `find ... -delete`; the plugin tools, the skill, the reminders, `/cleanup`, and the background sweep work through `omp -e SoT/.omp/plugin`.
- Plan review passed (round 8) and code review passed (round 2). The six MEDIUM findings of code review round 2 are recorded on the issue and are not part of this pull request.

## Deployment

Deployment waits for the release: run `docks-kit update`, which installs the CLI and syncs, and that sync links the plugin. Do not run `./docks-kit sync omp` from a checkout while the global `docks-kit` lacks `scratch` and `tidy`.

