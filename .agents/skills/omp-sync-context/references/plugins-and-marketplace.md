# omp Plugins And Marketplace

Part of `omp-sync-context`. Read the SKILL.md constraints first.

The kit plugin `docks-kit-omp` ships the docks and plan-lifecycle skills, the
`code-reviewer` and `plan-reviewer` agents, and the `verify-gate` and
`context-tree-nudge` extensions. So sync installs no marketplace plugin. The
plugin pass tries to retire the former `docks@docks` and `plan-lifecycle@docks`
plugins (user-scope uninstall; a project-scope install only gets a warning)
and the `docks` marketplace, with the conditions below, prints the
pi-intercom notice, and links the kit plugin.

## Plugin And Marketplace Constraints

<constraint>
Read marketplace plugin identity from the composite `id` field, and read the
install scope from `scope`.
omp emits one row per scope that holds the plugin.
Uninstall only a `scope: "user"` row, with `--scope user`: omp needs the scope
when the plugin exists in both scopes.
For a `scope: "project"` row, warn with the manual command
`omp plugin uninstall --scope project <id>` and change nothing in that project.
Read npm plugin identity from `name`; `version` is optional.
A wrong key makes every run attempt a failing command or miss a row.
</constraint>

<constraint>
Remove the `docks` marketplace only when no user uninstall failed, and only in
two registry states, because omp copies a legacy config-root registry forward
only when no active registry exists:
the active registry (`<data root>/marketplaces.json`) lists `docks`, or no
active registry exists and the legacy registry (`<config root>/marketplaces.json`)
lists it. A legacy entry beside an existing active registry is stale and starts
no command. `ompPlugins.ts docksRegistryState` reads both files. Only a missing
file counts as no registry: a registry that exists but cannot be read or parsed
gives a warning that names it, and no removal runs.
omp `marketplace.md` says that removing a marketplace "does not uninstall
plugins already cached and registered", so the uninstalls run first.
</constraint>

<constraint>
`ompPlugins.ts syncPlugins` probes omp before any spawn. When omp is missing,
it emits one `warnMissing` message and returns, so a host that lacks omp
records no false failure. Git gates only the omp plugin commands: the
uninstalls, the marketplace removal, and the kit plugin link. When git is
missing, it emits one `warnMissing` message, and a real run reads the
inventory, prints the pi-intercom notice, returns the kit plugin count that
the inventory lists, and runs no other omp command. `ompSync.ts` still
deploys the kit plugin files through `syncKitPlugin`, so a kit plugin that omp
already links loads them after a restart. omp can copy its legacy marketplace
registry into the active data root during that read, as it does on any
plugin command.
Report a real non-zero omp exit through `failures.ts recordFailure` in
`runPluginCommand`, with the manual command in the message.
Keep `warn` for the project-scope rows and the unavailable inventory.
</constraint>

Verify the constraints:
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "warns about a project-scope row and runs nothing for it"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "removes the marketplace when only the legacy registry lists docks and no active registry exists"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "removes no marketplace when the active registry exists without docks and the legacy registry lists it"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "removes no marketplace after a failed uninstall"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "reads only the inventory and changes no plugin when git is unavailable"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "of the inventory without git, counts no plugin, and changes no plugin"`,
and `bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "counts the kit plugin that the inventory lists when git is unavailable"`.

## Plugin Inventory Contract

Call `omp plugin list --json` once for inventory before the plugin operations.
Expect top-level `marketplace` and `npm` arrays.
When the inventory shape is invalid or the read fails, warn
`omp plugin inventory unavailable — …` without a ledger row, skip the
pi-intercom check and the retirement, and return no plugin count, so the
summary shows `omp plugins: unknown (plugin inventory unavailable)`. With
git, the pass then runs `omp plugin link` for the kit plugin, because no
inventory row shows that the link is current; a successful link counts one
plugin. Without git, the warning says that sync runs no omp plugin change,
and no link runs. The next sync tries the retirement again.

Read each marketplace row from its composite `id` field.
The value already has the `<plugin>@<marketplace>` form.
Compare it with `docks@docks` and `plan-lifecycle@docks`.
Use the same value in the uninstall command.

Read each npm row from `name`, `version`, and `path`. Keep a row without a
`version`: omp lists a local link without one.
Use `name` to find the kit plugin `docks-kit-omp` and a `pi-intercom` row for
the notice.

```ts
// BAD — marketplace rows do not use name as their installed identity, and a
// project-scope row needs a manual uninstall in that project.
const retire = row.name === pluginId

// GOOD — id is the composite plugin token, and scope says where it is installed.
const retire = row.id === pluginId && row.scope === "user"
```

Uninstall each retired id that has a user-scope row.
Link the kit plugin with `omp plugin link <kitPluginDir>` unless its npm row `path` resolves to the real kit plugin directory.
Run the link also when the inventory is unavailable.
Remove the folder `<kit cache>/omp-plugin-upgrades` of the retired upgrade log
in each real sync when it exists.

When at least one plugin operation succeeds, print one summary line that names each operation:
`omp plugins synced: docks@docks uninstalled, plan-lifecycle@docks uninstalled, docks marketplace removed, docks-kit-omp linked`.
Read the inventory once per real run, before the operations, and never again
after them. A dry run and a run without omp read no inventory.
Each uninstall sets `ompRestart`, because the retired plugins ship extensions.
`ompKitPlugin.ts syncKitPlugin` adds `(docks-kit-omp <old> -> <new>)` to its line
when the deployed `package.json` had a different version.

Verify the inventory rules:
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "warns and skips the retirement when the inventory cannot be read"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "runs no omp mutation on a second sync after a successful retirement"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "keeps a versionless npm row: a kit plugin link without a version needs no new link"`,
and `bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "links the kit plugin again when omp"`.

## Dry Run Rules And The pi-intercom Notice

Guard plugin inventory before its omp subprocess.
Guard every uninstall, marketplace removal, and link before its
`ompChild.ts spawnOmp` call.

A dry run prints `[dry-run] omp plugin uninstall --scope user <id>` for both
retired ids, because it reads no inventory.
It prints `[dry-run] omp plugin marketplace remove docks` only when a registry
lists `docks` in one of the two removal states above.
A dry run prints the kit plugin link.
A dry run does not remove the upgrade-log folder.
A dry run checks PATH for omp and git first. When either tool is missing, the
dry run prints the same single skip warning as a real run and previews no omp
command.
A dry run does not use omp's own `--dry-run` option.

Sync no longer installs, updates, or configures `pi-intercom`; the `talk`
extension of the kit plugin replaces it. While the inventory lists a
`pi-intercom` npm row, each real sync prints one notice
(`ompPlugins.ts piIntercomNotice`) with the store `<dataRoot>/plugins` and the
version of the row. The store path loses its control characters and line
breaks. A missing version, or a version outside `NOTICE_VERSION` (1 to 64
characters of `[0-9A-Za-z.+-]`), reads `unknown version`. The notice gives no
removal command, because omp resolves a name at removal time and no record
shows who installed the package. The notice prints before the git gate, so it
prints also without git. A dry run and a run without omp print no notice. The
pass changes nothing for pi-intercom and its old state folder.

| State | Real sync |
|---|---|
| Retired plugin in user scope | Uninstall with `--scope user` |
| Retired plugin in project scope only | Warn with the manual command |
| `docks` in a removal registry state, no failed uninstall | `marketplace remove docks` |
| `pi-intercom` row in the inventory | Print the notice; change nothing |
| Kit plugin not linked, or linked elsewhere | `omp plugin link` |

Anchor this behavior at `ompPlugins.ts syncPlugins`, `ompPlugins.ts retireMarketplacePlugins`, and `ompPlugins.ts piIntercomNotice` — dry-run boundary and pi-intercom notice.

Verify the dry-run boundary and the notice:
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "previews no omp command in a dry run when omp is unavailable"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "previews the retirement in a dry run when the registry"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "uninstalls each user-scope retired plugin"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "names the store and the version of a registry install, once, and changes nothing"`,
`bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "prints the notice without git, reads only the inventory, and changes no plugin"`,
and `bunx vitest run cli/test/unit/ompPluginInventory.test.ts -t "spawns nothing and prints no notice in a dry run"`.
