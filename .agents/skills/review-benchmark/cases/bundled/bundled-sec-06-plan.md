## Plan #137: omp: warn when a plugin upgrade removes a folder that running sessions use (#129)

Pull request: https://github.com/DocksDocks/public/pull/138. Checks: 8 of 8 passed. Reviewed head: `55be2fc8327eecd4f8f26b04c66d0019e72a1731`.

### What changed
- `docks-kit sync omp` warns for each marketplace plugin whose version changed: `omp plugin <id> <before> -> <after>: running omp sessions lose its plugin agents and skill script paths until they restart.` The next step then says `Restart running omp sessions: a plugin upgrade removed the plugin folders that they loaded.`
- Sync records each such upgrade as one event file in `~/.cache/docks-kit/omp-plugin-upgrades/` (folder 0700, files 0600, atomic rename, newest 100 kept). If the versions cannot be read after the upgrade, it records `<before> -> unknown`. If the log cannot be written, it warns and keeps the restart advice.
- The kit omp plugin has a new extension, `pluginUpgrades.ts`. In each main session whose omp process started before a logged upgrade, the first tool result after the sync carries one reminder that names the upgrades and says to ask the user to restart omp.
- Docs: `AGENTS.md`, `cli/docs/sync-layers.md`, and the changelog describe the warning, the log, the reminder, and their limits. docks-kit is 0.22.12.

### Why
omp 18.16.0 deletes the previous plugin folder on upgrade, and a running session keeps the old paths (#129). Upstream can1357/oh-my-pi#16981 is open; its fix PR was closed without a merge. I posted this case there.

### Limits
- An omp process that started before a sync deployed `pluginUpgrades.ts` does not have it, so its sessions get no reminder, also for the upgrades of that sync.
- Upgrades that `docks-kit sync` does not run (for example `omp plugin upgrade` by hand) give no reminder.
- The warning, the next step, and the reminder assume the session loaded the user-scope install; a session on a project-scope install keeps its folder. The reminder says "may".
- A session idle through more than 100 later upgrades loses the oldest events.

### Reviews
Plan review passed in round 4; the edit after that pass (the session id API) passed in round 5. Code review passed in round 2 (round 1 a panel with a self-review per lens).
Open findings: three MEDIUM findings of the passing round 2, recorded in its comment and not changed: a cross-process race test, a recovery copy when the cache write fails, and a visible notice for a persistent read error.

### Verification
- `bun run check`: exit 0 (1491 passed, 11 skipped; goldens OK). `bun run check:generated`: exit 0.
- Live probe: the kit plugin folder was deployed from the branch without `docks-kit sync` (no omp command ran). A fresh `omp -p` session wrote one test event and got exactly one reminder, `docks-kit sync upgraded these omp plugins after this omp process started: probe@docks-kit-probe 0.0.1 -> 0.0.2. ...`. The test event and its folder were removed.

### Kept resources
- The deployed kit plugin folder `~/.docks-kit/omp-plugin` holds the branch version (0.22.12). The next `docks-kit sync omp` writes the same files.
- After `Leave pull request open`: also the linked branch (local and remote) and the open pull request.

### After merge
- Release `cli-v0.22.12` (its own question).
- Restart open omp sessions, so they load `pluginUpgrades.ts`.

Closes #137
Closes #129

