/**
 * EngineNative omp plugin pass: the retirement of the docks marketplace
 * plugins, the link of the kit plugin that `ompKitPlugin.ts syncKitPlugin`
 * writes, and the pi-intercom notice. Split from ompSync.ts; the
 * orchestration still lives there.
 *
 * The kit plugin now ships the content of the retired `docks@docks` and
 * `plan-lifecycle@docks` marketplace plugins. Each real sync uninstalls their
 * user-scope installs, warns about their project-scope installs, and then
 * removes the `docks` marketplace. A second sync after a successful
 * retirement runs no omp mutation for it.
 *
 * Sync no longer installs, updates, or configures pi-intercom; the `talk`
 * tool of the kit plugin replaces it. While the inventory of the store lists
 * pi-intercom, each real sync prints one notice and changes nothing for it.
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";

import { p, processFailureSummary } from "./exec";
import { recordFailure } from "./failures";
import type { Ctx } from "./index";
import { isObject, parseJson } from "./jq";
import { spawnOmp } from "./ompChild";
import { KIT_PLUGIN_NAME, kitPluginDir } from "./ompKitPlugin";
import type { OmpPaths } from "./ompPaths";
import { kitCacheDir } from "./scratch";

/** The marketplace plugins whose content the kit plugin now ships. */
const RETIRED_PLUGIN_IDS = ["docks@docks", "plan-lifecycle@docks"] as const;
/** The marketplace of the retired plugins. */
const RETIRED_MARKETPLACE = "docks";
/** The label of the marketplace in progress, failure, and summary texts. */
const RETIRED_MARKETPLACE_LABEL = `${RETIRED_MARKETPLACE} marketplace`;

// -------------------------------------------------------------- plugins ----

interface InstalledNpmPlugin {
  /** The `version` string of the row; omp lists a local link without one. */
  readonly version: string | undefined;
  /** The `node_modules` entry of the plugin, a symbolic link for a linked plugin. */
  readonly path: string | undefined;
}

/** The install scopes of omp marketplace plugins. */
type MarketplaceScope = "user" | "project";

interface InstalledMarketplacePlugin {
  /** The composite id `<plugin>@<marketplace>`. */
  readonly id: string;
  readonly scope: MarketplaceScope;
}

interface InstalledPlugins {
  /** One row for each scope that holds a marketplace plugin. */
  readonly marketplace: ReadonlyArray<InstalledMarketplacePlugin>;
  readonly npm: Map<string, InstalledNpmPlugin>;
}

/** One successful plugin operation, named in the sync summary line. */
type PluginOperation =
  | { readonly kind: "link"; readonly id: string }
  | { readonly kind: "uninstall"; readonly id: string }
  | { readonly kind: "marketplaceRemove" };

async function installedPluginsFromCli(paths: OmpPaths): Promise<InstalledPlugins | undefined> {
  const result = await spawnOmp(paths, ["plugin", "list", "--json"], ["ignore", "pipe", "ignore"]);
  if (result.error !== undefined || result.exitCode !== 0) return undefined;

  const value = parseJson(result.stdout);
  if (
    value === undefined ||
    !isObject(value) ||
    !Array.isArray(value["marketplace"]) ||
    !Array.isArray(value["npm"])
  ) {
    return undefined;
  }

  // `omp plugin list --json` reports marketplace rows as
  // `{ id: "<plugin>@<marketplace>", scope, entries: [...] }`. The composite
  // id is the token that `omp plugin uninstall` takes. omp emits one row for
  // each scope that holds the plugin.
  const marketplace: Array<InstalledMarketplacePlugin> = [];
  for (const row of value["marketplace"]) {
    if (!isObject(row) || typeof row["id"] !== "string") continue;
    const scope = row["scope"];
    if (scope !== "user" && scope !== "project") continue;
    marketplace.push({ id: row["id"], scope });
  }

  const npm = new Map<string, InstalledNpmPlugin>();
  for (const row of value["npm"]) {
    if (!isObject(row) || typeof row["name"] !== "string") continue;
    const version = typeof row["version"] === "string" ? row["version"] : undefined;
    const path = typeof row["path"] === "string" ? row["path"] : undefined;
    npm.set(row["name"], { version, path });
  }
  return { marketplace, npm };
}

/** The npm package that sync installed and configured before the `talk` tool replaced it. */
const PI_INTERCOM = "pi-intercom";
/** A version that the notice prints as it is: 1 to 64 characters, none of them a control or a space. */
const NOTICE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
/** Control characters and line breaks, which a one-line terminal text must not hold. */
const TERMINAL_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

/**
 * The notice for a store whose inventory lists pi-intercom. `store` is the
 * plugin store folder; `version` is the `version` of the inventory row. The
 * store path loses its control characters and line breaks, and a version
 * outside `NOTICE_VERSION` reads as `unknown version`, so the notice stays one
 * line of terminal-safe text. The notice gives no removal command: omp
 * resolves a name at removal time, and no record shows who installed the
 * package.
 */
export function piIntercomNotice(store: string, version: string | undefined): string {
  const safeStore = store.replace(TERMINAL_UNSAFE, "");
  const installed =
    version !== undefined && NOTICE_VERSION.test(version)
      ? `version ${version}`
      : "unknown version";
  return `Notice: the omp plugin store ${safeStore} lists ${PI_INTERCOM}, ${installed}. docks-kit no longer installs or updates ${PI_INTERCOM}. The talk tool of the kit plugin replaces it. ${PI_INTERCOM} 0.19.0 from npm does not load on omp 19.2 or later.`;
}

/** Names one operation. */
function describeOperation(operation: PluginOperation): string {
  switch (operation.kind) {
    case "link":
      return `${operation.id} linked`;
    case "uninstall":
      return `${operation.id} uninstalled`;
    case "marketplaceRemove":
      return `${RETIRED_MARKETPLACE_LABEL} removed`;
  }
}

async function runPluginCommand(
  ctx: Ctx,
  paths: OmpPaths,
  plugin: string,
  args: ReadonlyArray<string>,
): Promise<boolean> {
  const { clearProgress, progress } = ctx.services.logger;
  progress(`Updating omp plugin ${plugin}...`);
  const result = await spawnOmp(paths, args, ["ignore", "pipe", "pipe"]);
  clearProgress();
  if (result.error === undefined && result.exitCode === 0) return true;

  recordFailure(
    ctx,
    `omp plugin operation failed for ${plugin}: ${processFailureSummary(result)}; run manually: omp ${args.join(" ")}`,
  );
  return false;
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

// ----------------------------------------------------------- retirement ----

/**
 * What a registry file says about the `docks` marketplace. `unreadable` names a
 * file that exists but cannot be read or parsed: it can still hold the entry.
 */
type RegistryState =
  | { readonly kind: "listed" | "absent" }
  | { readonly kind: "unreadable"; readonly file: string };

function registryState(registryFile: string): RegistryState | { readonly kind: "missing" } {
  let registryText: string;
  try {
    registryText = readFileSync(registryFile, "utf8");
  } catch (error) {
    // Only a missing path is no registry; a denied or failed read can hide the entry.
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", file: registryFile };
  }
  const registry = parseJson(registryText);
  if (registry === undefined) return { kind: "unreadable", file: registryFile };
  if (isObject(registry) && Object.hasOwn(registry, RETIRED_MARKETPLACE)) return { kind: "listed" };

  const entries = Array.isArray(registry)
    ? registry
    : isObject(registry) && Array.isArray(registry["marketplaces"])
      ? registry["marketplaces"]
      : [];
  return entries.some((entry) => isObject(entry) && entry["name"] === RETIRED_MARKETPLACE)
    ? { kind: "listed" }
    : { kind: "absent" };
}

/**
 * Whether omp knows the `docks` marketplace. omp reads the active registry
 * `<data root>/marketplaces.json`. Upstream `getMarketplacesRegistryPath`
 * copies a legacy `<config root>/marketplaces.json` forward only when it
 * resolves an XDG data root that has no active registry yet. So a legacy
 * entry counts only when no active registry exists; beside an active
 * registry it is stale.
 */
function docksRegistryState(paths: OmpPaths): RegistryState {
  const active = registryState(p(paths.dataRoot, "marketplaces.json"));
  if (active.kind !== "missing") return active;
  if (paths.dataRoot === paths.configRoot) return { kind: "absent" };
  const legacy = registryState(p(paths.configRoot, "marketplaces.json"));
  return legacy.kind === "missing" ? { kind: "absent" } : legacy;
}

/** The warning for a registry that can hold the `docks` entry but cannot be read. */
function unreadableRegistryWarning(file: string): string {
  return `omp marketplace registry ${file} cannot be read or parsed — the docks marketplace is not removed; repair the file, then run docks-kit sync again`;
}

/**
 * Removes the folder of the retired plugin upgrade log, which only the
 * marketplace plugin upgrades wrote. The kit owns the folder.
 */
function removeUpgradeLog(ctx: Ctx): void {
  const dir = p(kitCacheDir(ctx.home), "omp-plugin-upgrades");
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
    ctx.services.logger.verbose(`removed the retired omp plugin upgrade log ${dir}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.services.logger.warn(`retired omp plugin upgrade log not removed: ${detail}`);
  }
}

/**
 * Uninstalls each user-scope install of a retired plugin and warns about each
 * project-scope install, which belongs to that project. Then removes the
 * `docks` marketplace when no uninstall failed and omp knows the marketplace.
 * Returns the successful operations.
 */
async function retireMarketplacePlugins(
  ctx: Ctx,
  paths: OmpPaths,
  installed: InstalledPlugins,
): Promise<Array<PluginOperation>> {
  const { warn } = ctx.services.logger;
  const operations: Array<PluginOperation> = [];
  let uninstallFailed = false;

  for (const pluginId of RETIRED_PLUGIN_IDS) {
    const rows = installed.marketplace.filter((row) => row.id === pluginId);
    if (rows.some((row) => row.scope === "project")) {
      warn(
        `omp plugin ${pluginId} is installed at project scope and docks-kit no longer ships it; run from that project: omp plugin uninstall --scope project ${pluginId}`,
      );
    }
    if (!rows.some((row) => row.scope === "user")) continue;

    const args = ["plugin", "uninstall", "--scope", "user", pluginId];
    if (await runPluginCommand(ctx, paths, pluginId, args)) {
      operations.push({ kind: "uninstall", id: pluginId });
    } else {
      uninstallFailed = true;
    }
  }

  // A failed uninstall keeps the marketplace, so the manual command still resolves the id.
  if (uninstallFailed) return operations;
  const registry = docksRegistryState(paths);
  if (registry.kind === "unreadable") {
    warn(unreadableRegistryWarning(registry.file));
  } else if (registry.kind === "listed") {
    const args = ["plugin", "marketplace", "remove", RETIRED_MARKETPLACE];
    if (await runPluginCommand(ctx, paths, RETIRED_MARKETPLACE_LABEL, args)) {
      operations.push({ kind: "marketplaceRemove" });
    }
  }
  return operations;
}

/**
 * Run the plugin pass. `paths` are the omp paths that the sync locked.
 *
 * Only the plugin changes need git. Without git, a real run reads the
 * inventory, prints the pi-intercom notice, and changes no plugin. omp itself
 * can copy its legacy marketplace registry into the active data root during
 * that read, as it does on any plugin command. A dry run and a run without
 * omp spawn no omp command and print no notice.
 */
export async function syncPlugins(ctx: Ctx, paths: OmpPaths): Promise<number> {
  const { change, clearProgress, echo, progress, verbose, warn } = ctx.services.logger;

  if (!ctx.dryRun) removeUpgradeLog(ctx);

  if (ctx.services.deps.probe("omp").state === "missing") {
    ctx.services.deps.warnMissing(
      "omp",
      ctx.services.logger,
      "deployed omp config only — plugin pass skipped; re-run sync after installing",
    );
    return 0;
  }
  const gitMissing = ctx.services.deps.probe("git").state === "missing";
  if (gitMissing) {
    ctx.services.deps.warnMissing(
      "git",
      ctx.services.logger,
      "omp plugin changes skipped; re-run sync after installing",
    );
  }

  if (ctx.dryRun) {
    if (gitMissing) return 0;
    // A dry run reads no inventory, so it previews the uninstall of each retired id.
    for (const pluginId of RETIRED_PLUGIN_IDS) {
      echo(`[dry-run] omp plugin uninstall --scope user ${pluginId}`);
    }
    const registry = docksRegistryState(paths);
    if (registry.kind === "unreadable") {
      warn(unreadableRegistryWarning(registry.file));
    } else if (registry.kind === "listed") {
      echo(`[dry-run] omp plugin marketplace remove ${RETIRED_MARKETPLACE}`);
    }
    echo(`[dry-run] omp plugin link ${kitPluginDir(ctx.home)}`);
    return 0;
  }

  progress("Checking installed omp plugins...");
  const installed = await installedPluginsFromCli(paths);
  clearProgress();

  const piIntercom = installed?.npm.get(PI_INTERCOM);
  if (piIntercom !== undefined) {
    echo(piIntercomNotice(p(paths.dataRoot, "plugins"), piIntercom.version));
  }
  if (gitMissing) return 0;

  const operations: Array<PluginOperation> = [];
  if (installed === undefined) {
    warn(
      "omp plugin inventory unavailable — retirement of the docks marketplace plugins skipped until the next sync; the kit plugin takes the full refresh path",
    );
  } else {
    operations.push(...(await retireMarketplacePlugins(ctx, paths, installed)));
  }

  let pluginsInstalled = installed?.npm.has(KIT_PLUGIN_NAME) === true ? 1 : 0;

  // The kit plugin is linked when omp's entry resolves to the kit directory.
  // A refresh never applies: the link always points at the current files.
  const kitDir = kitPluginDir(ctx.home);
  const kitPluginPath = installed?.npm.get(KIT_PLUGIN_NAME)?.path;
  const linkedTarget = kitPluginPath === undefined ? undefined : realPath(kitPluginPath);
  if (linkedTarget !== undefined && linkedTarget === realPath(kitDir)) {
    verbose(`omp kit plugin ${KIT_PLUGIN_NAME} already linked`);
  } else if (await runPluginCommand(ctx, paths, KIT_PLUGIN_NAME, ["plugin", "link", kitDir])) {
    operations.push({ kind: "link", id: KIT_PLUGIN_NAME });
    if (installed?.npm.has(KIT_PLUGIN_NAME) !== true) pluginsInstalled++;
  }

  if (operations.length === 0) {
    verbose("omp plugins already in sync");
    return pluginsInstalled;
  }

  change(`omp plugins synced: ${operations.map(describeOperation).join(", ")}`);
  // A link or an uninstall changes the plugins that omp loads. A marketplace
  // removal alone changes no loaded plugin.
  if (operations.some((operation) => operation.kind !== "marketplaceRemove")) {
    ctx.nextStepTriggers.ompRestart = true;
  }
  return pluginsInstalled;
}
