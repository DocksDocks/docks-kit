/**
 * `omp plugin list --json` keys marketplace rows on a composite `id`
 * ("<plugin>@<marketplace>") with a `scope`, and npm rows on `name`, with an
 * optional `version` and `path`. The marketplace rows drive the retirement of
 * the old docks marketplace plugins: the sync uninstalls each user-scope row,
 * warns about each project-scope row, and then removes the `docks`
 * marketplace. The npm rows drive the kit plugin link (the kit links its
 * directory unless the kit plugin entry already resolves to it) and the
 * pi-intercom notice: sync no longer installs, updates, or configures
 * pi-intercom, and it prints one notice while the store lists it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ExecModule from "../../src/engine-native/exec";

const mocks = vi.hoisted(() => ({
  payloadText: vi.fn<(path: string) => string>(),
  spawnProcess: vi.fn(),
}));

vi.mock("../../src/payload", () => ({
  payloadText: mocks.payloadText,
  payloadDisplayPath: (path: string) => `embedded:${path}`,
  // The kit plugin files are covered by ompKitPlugin.test.ts.
  payloadPaths: () => [],
}));
vi.mock("../../src/engine-native/exec", async () => {
  const actual = await vi.importActual<typeof ExecModule>("../../src/engine-native/exec");
  return { ...actual, spawnProcess: mocks.spawnProcess };
});
vi.mock("../../src/engine-native/bun", () => ({
  bunBootstrap: async () => ({ kind: "ready", executable: "bun" }),
}));

import type { Ctx } from "../../src/engine-native";
import { piIntercomNotice, syncPlugins } from "../../src/engine-native/ompPlugins";
import {
  ompNextSteps,
  ompSync,
  ompWriteFolders,
  type OmpState,
} from "../../src/engine-native/ompSync";
import {
  makeDependencyManager,
  makeEngineServices,
  makePlatform,
} from "../../src/engine-native/services";

/** The fixed part of the pi-intercom notice, after the store and the version. */
const NOTICE_TAIL =
  "docks-kit no longer installs or updates pi-intercom. The talk tool of the kit plugin replaces it. pi-intercom 0.19.0 from npm does not load on omp 19.2 or later.";

/** The notice for `store`, with `version` as `version <v>` or `unknown version`. */
function expectedNotice(store: string, version: string): string {
  return `Notice: the omp plugin store ${store} lists pi-intercom, ${version}. ${NOTICE_TAIL}`;
}
const roots: Array<string> = [];
/**
 * `ompSync` resolves its deploy roots from `process.env`, so an ambient
 * override on the developer's machine would send these writes outside the
 * temporary root. Each case starts from a cleared set.
 */
const OMP_ENV_KEYS = [
  "XDG_DATA_HOME",
  "OMP_PROFILE",
  "PI_PROFILE",
  "PI_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
] as const;
const ORIGINAL_OMP_ENV = new Map(OMP_ENV_KEYS.map((key) => [key, process.env[key]] as const));

const DOCKS_USER_ROW = { id: "docks@docks", scope: "user", entries: [{ version: "0.29.2" }] };
const PLAN_USER_ROW = {
  id: "plan-lifecycle@docks",
  scope: "user",
  entries: [{ version: "0.27.0" }],
};
const UNINSTALL_DOCKS = "plugin uninstall --scope user docks@docks";
const UNINSTALL_PLAN = "plugin uninstall --scope user plan-lifecycle@docks";
const REMOVE_MARKETPLACE = "plugin marketplace remove docks";
const RESTART_NEXT_STEP = "Restart omp to load any refreshed plugins, skills, or tools.";

/**
 * An inventory whose npm rows hold the kit plugin linked to the kit
 * directory under `root` and the given extra rows, with the given
 * marketplace rows.
 */
function inventory(
  root: string,
  marketplace: ReadonlyArray<object> = [],
  npm: ReadonlyArray<object> = [],
): string {
  const kitDir = join(root, ".docks-kit", "omp-plugin");
  mkdirSync(kitDir, { recursive: true });
  return JSON.stringify({
    npm: [...npm, { name: "docks-kit-omp", version: "0.0.0", path: kitDir }],
    marketplace,
  });
}
const INVENTORY_EMPTY = JSON.stringify({ npm: [], marketplace: [] });

/** The omp argv that links the kit plugin directory under `root`. */
function kitLink(root: string): string {
  return `plugin link ${root}/.docks-kit/omp-plugin`;
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "docks-omp-inventory-"));
  roots.push(root);
  mkdirSync(join(root, ".omp"), { recursive: true });
  return root;
}

/** Writes `<dir>/marketplaces.json` with one entry for each name. */
function writeRegistry(dir: string, names: ReadonlyArray<string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "marketplaces.json"),
    JSON.stringify({ version: 1, marketplaces: names.map((name) => ({ name })) }),
  );
}

/**
 * Sets an XDG data root whose omp folder exists, so omp and the sync use it
 * as the active data root. The legacy registry stays in `<root>/.omp`.
 */
function useXdgDataRoot(root: string): string {
  const dataHome = join(root, "xdg");
  mkdirSync(join(dataHome, "omp"), { recursive: true });
  process.env["XDG_DATA_HOME"] = dataHome;
  return join(dataHome, "omp");
}

function makeCtx(
  root: string,
  options: {
    missingTool?: "omp" | "git";
    dryRun?: boolean;
    output?: Array<string>;
  } = {},
): Ctx {
  const platform = makePlatform("linux");
  const write = (chunk: string): void => {
    options.output?.push(chunk);
  };
  const services = {
    ...makeEngineServices({ sinks: { stderr: write, stdout: write } }),
    deps: makeDependencyManager(platform, {
      commandExists: (name) => name !== options.missingTool,
      capture: async () => "",
      which: (name) => `/usr/bin/${name}`,
    }),
    platform,
  };
  return {
    home: root,
    dryRun: options.dryRun ?? false,
    verbose: false,
    services,
    nextStepTriggers: { ompRestart: false },
    failures: [],
  } as unknown as Ctx;
}

/** Run the omp pipeline in the folders that a sync of `ctx` resolves, as `runSync` does. */
function syncOmp(ctx: Ctx): Promise<OmpState> {
  return ompSync(ctx, ompWriteFolders(ctx));
}

/** Run the plugin pass on the omp paths that a sync of `ctx` resolves. */
function syncOmpPlugins(ctx: Ctx): Promise<number> {
  return syncPlugins(ctx, ompWriteFolders(ctx).paths);
}

/** Every `omp` argv the pipeline spawned, as one joined string per call. */
function ompCommands(): Array<string> {
  return mocks.spawnProcess.mock.calls.map((call) => (call[1] as ReadonlyArray<string>).join(" "));
}

/**
 * Answers each `plugin list --json` call with the next inventory; the last
 * inventory answers every later call. `failingCommand` exits 1.
 */
function respondWithInventory(
  inventories: string | ReadonlyArray<string>,
  failingCommand?: string,
): void {
  const answers = typeof inventories === "string" ? [inventories] : inventories;
  let listCalls = 0;
  mocks.spawnProcess.mockImplementation(async (_cmd: string, args: ReadonlyArray<string>) => {
    const failed = args.join(" ") === failingCommand;
    const list = args[0] === "plugin" && args[1] === "list";
    const stdout = list ? (answers[Math.min(listCalls++, answers.length - 1)] ?? "") : "";
    return {
      error: undefined,
      exitCode: failed ? 1 : 0,
      stdout,
      stderr: failed ? "stub omp operation failure\n" : "",
    };
  });
}

/** The text of the plugin summary line, from its message start to the line end. */
function pluginSummary(output: ReadonlyArray<string>): string | undefined {
  const line = output
    .join("")
    .split("\n")
    .find((candidate) => candidate.includes("omp plugins synced"));
  return line?.slice(line.indexOf("omp plugins synced"));
}

/** Each line that contains `start`, from `start` to the line end. */
function messageLines(output: ReadonlyArray<string>, start: string): Array<string> {
  return output
    .join("")
    .split("\n")
    .filter((line) => line.includes(start))
    .map((line) => line.slice(line.indexOf(start)));
}

/** The folder of the retired upgrade log under `root`, as `kitCacheDir` gives it. */
function upgradeLog(root: string): string {
  return join(root, ".cache", "docks-kit", "omp-plugin-upgrades");
}

describe("omp plugin inventory", () => {
  beforeEach(() => {
    mocks.payloadText.mockReset().mockImplementation((path) => {
      if (path === "SoT/.omp/AGENTS.md") return "# omp\n";
      if (path === "SoT/.omp/mcp.json") return "{}\n";
      if (path === "SoT/.omp/models.yml") return "providers: {}\n";
      if (path === "SoT/.omp/config.yml") return "theme: dark\n";
      if (path === "SoT/toolchain.json") return '{"tools":{}}';
      throw new Error(`Unexpected payload: ${path}`);
    });
    mocks.spawnProcess.mockReset();
    for (const key of OMP_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const [key, value] of ORIGINAL_OMP_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("retirement of the docks marketplace plugins", () => {
    it("uninstalls each user-scope retired plugin", async () => {
      const root = makeRoot();
      respondWithInventory(inventory(root, [DOCKS_USER_ROW, PLAN_USER_ROW]));
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });

      const installed = await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS, UNINSTALL_PLAN]);
      expect(installed).toBe(1);
      expect(pluginSummary(output)).toBe(
        "omp plugins synced: docks@docks uninstalled, plan-lifecycle@docks uninstalled",
      );
      expect(ctx.failures).toEqual([]);
      expect(ctx.nextStepTriggers.ompRestart).toBe(true);
      expect(ompNextSteps(ctx)).toEqual([RESTART_NEXT_STEP]);
    });

    it("warns about a project-scope row and runs nothing for it", async () => {
      const root = makeRoot();
      respondWithInventory(
        inventory(root, [
          { id: "docks@docks", scope: "project", entries: [{ version: "0.29.2" }] },
          PLAN_USER_ROW,
        ]),
      );
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });

      await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_PLAN]);
      expect(messageLines(output, "omp plugin docks@docks")).toEqual([
        "omp plugin docks@docks is installed at project scope and docks-kit no longer ships it; run from that project: omp plugin uninstall --scope project docks@docks",
      ]);
      expect(ctx.failures).toEqual([]);
    });

    it("uninstalls the user-scope row and warns about the project-scope row of one plugin", async () => {
      const root = makeRoot();
      respondWithInventory(
        inventory(root, [{ ...DOCKS_USER_ROW, scope: "project" }, DOCKS_USER_ROW]),
      );
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS]);
      expect(messageLines(output, "omp plugin docks@docks is installed")).toHaveLength(1);
    });

    it("removes the marketplace after the uninstalls when the active registry lists docks", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root, [DOCKS_USER_ROW, PLAN_USER_ROW]));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(ompCommands()).toEqual([
        "plugin list --json",
        UNINSTALL_DOCKS,
        UNINSTALL_PLAN,
        REMOVE_MARKETPLACE,
      ]);
      expect(pluginSummary(output)).toBe(
        "omp plugins synced: docks@docks uninstalled, plan-lifecycle@docks uninstalled, docks marketplace removed",
      );
    });

    it("reads a registry that keys each marketplace by its name", async () => {
      const root = makeRoot();
      writeFileSync(
        join(root, ".omp", "marketplaces.json"),
        JSON.stringify({ docks: { source: "git" } }),
      );
      respondWithInventory(inventory(root));

      await syncOmpPlugins(makeCtx(root));

      expect(ompCommands()).toEqual(["plugin list --json", REMOVE_MARKETPLACE]);
    });

    it("removes the marketplace when the active XDG registry lists docks", async () => {
      const root = makeRoot();
      writeRegistry(useXdgDataRoot(root), ["docks"]);
      writeRegistry(join(root, ".omp"), ["another-marketplace"]);
      respondWithInventory(inventory(root));

      await syncOmpPlugins(makeCtx(root));

      expect(ompCommands()).toEqual(["plugin list --json", REMOVE_MARKETPLACE]);
    });

    it("removes the marketplace when only the legacy registry lists docks and no active registry exists", async () => {
      const root = makeRoot();
      useXdgDataRoot(root);
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root, [DOCKS_USER_ROW]));

      await syncOmpPlugins(makeCtx(root));

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS, REMOVE_MARKETPLACE]);
    });

    it("removes no marketplace when the active registry exists without docks and the legacy registry lists it", async () => {
      const root = makeRoot();
      writeRegistry(useXdgDataRoot(root), ["another-marketplace"]);
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root, [DOCKS_USER_ROW, PLAN_USER_ROW]));

      await syncOmpPlugins(makeCtx(root));

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS, UNINSTALL_PLAN]);
    });

    it("removes no marketplace when no registry lists docks", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["another-marketplace"]);
      respondWithInventory(inventory(root));
      const ctx = makeCtx(root);

      await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json"]);
      expect(ctx.nextStepTriggers.ompRestart).toBe(false);
    });

    it("warns and removes no marketplace when the active registry cannot be parsed", async () => {
      const root = makeRoot();
      const registry = join(root, ".omp", "marketplaces.json");
      writeFileSync(registry, '{ "docks": ');
      respondWithInventory(inventory(root, [DOCKS_USER_ROW]));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS]);
      // The engine joins its paths with `/` on every host, so the message names that form.
      const named = `${root}/.omp/marketplaces.json`;
      expect(messageLines(output, `omp marketplace registry ${named} cannot be read`)).toHaveLength(
        1,
      );
    });

    it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
      "warns and does not fall back to the legacy registry when the active registry cannot be read",
      async () => {
        const root = makeRoot();
        const dataRoot = useXdgDataRoot(root);
        writeRegistry(dataRoot, ["docks"]);
        writeRegistry(join(root, ".omp"), ["docks"]);
        respondWithInventory(inventory(root, [DOCKS_USER_ROW]));
        const output: Array<string> = [];
        // No search permission on the folder: the registry exists, but its read fails with EACCES.
        chmodSync(dataRoot, 0o000);
        try {
          await syncOmpPlugins(makeCtx(root, { output }));
        } finally {
          chmodSync(dataRoot, 0o700);
        }

        expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS]);
        expect(
          messageLines(output, `omp marketplace registry ${join(dataRoot, "marketplaces.json")}`),
        ).toHaveLength(1);
      },
    );

    it("removes no marketplace after a failed uninstall", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root, [DOCKS_USER_ROW, PLAN_USER_ROW]), UNINSTALL_DOCKS);
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });

      await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json", UNINSTALL_DOCKS, UNINSTALL_PLAN]);
      expect(ctx.failures).toEqual([
        "omp plugin operation failed for docks@docks: stub omp operation failure; run manually: omp plugin uninstall --scope user docks@docks",
      ]);
      expect(pluginSummary(output)).toBe("omp plugins synced: plan-lifecycle@docks uninstalled");
      expect(ctx.nextStepTriggers.ompRestart).toBe(true);
    });

    it("records a failed marketplace removal", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root), REMOVE_MARKETPLACE);
      const ctx = makeCtx(root);

      await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json", REMOVE_MARKETPLACE]);
      expect(ctx.failures).toEqual([
        "omp plugin operation failed for docks marketplace: stub omp operation failure; run manually: omp plugin marketplace remove docks",
      ]);
    });

    it("warns and skips the retirement when the inventory cannot be read", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory("not json");
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });

      await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json", kitLink(root)]);
      expect(messageLines(output, "omp plugin inventory")).toEqual([
        "omp plugin inventory unavailable — retirement of the docks marketplace plugins skipped until the next sync; the kit plugin takes the full refresh path",
      ]);
      expect(ctx.failures).toEqual([]);
    });

    it.each([
      ["an empty inventory", (): string => INVENTORY_EMPTY],
      ["an unreadable inventory", (): string => "not json"],
      ["an inventory without the retired plugins", (root: string): string => inventory(root)],
    ])("installs no marketplace plugin and adds no marketplace for %s", async (_name, answer) => {
      const root = makeRoot();
      respondWithInventory(answer(root));

      await syncOmp(makeCtx(root));

      expect(
        ompCommands().filter((command) =>
          /^plugin (install|upgrade) |^plugin marketplace (add|update|list)/.test(command),
        ),
      ).toEqual([]);
    });

    it("runs no omp mutation on a second sync after a successful retirement", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(inventory(root, [DOCKS_USER_ROW, PLAN_USER_ROW]));
      await syncOmp(makeCtx(root));
      expect(ompCommands()).toEqual([
        "plugin list --json",
        UNINSTALL_DOCKS,
        UNINSTALL_PLAN,
        REMOVE_MARKETPLACE,
      ]);

      // The state that the omp commands of the first sync left.
      writeRegistry(join(root, ".omp"), []);
      mocks.spawnProcess.mockReset();
      respondWithInventory(inventory(root));
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });
      await syncOmp(ctx);

      expect(ompCommands()).toEqual(["plugin list --json"]);
      expect(pluginSummary(output)).toBeUndefined();
      expect(ctx.failures).toEqual([]);
      expect(ctx.nextStepTriggers.ompRestart).toBe(false);
    });

    it("removes the retired upgrade log folder in a real sync", async () => {
      const root = makeRoot();
      mkdirSync(upgradeLog(root), { recursive: true });
      writeFileSync(join(upgradeLog(root), "1000-aa.json"), "{}\n");
      respondWithInventory(inventory(root));

      await syncOmp(makeCtx(root));

      expect(existsSync(upgradeLog(root))).toBe(false);
      expect(existsSync(join(root, ".cache", "docks-kit"))).toBe(true);
    });

    it("keeps the retired upgrade log folder in a dry run", async () => {
      const root = makeRoot();
      mkdirSync(upgradeLog(root), { recursive: true });

      await syncOmp(makeCtx(root, { dryRun: true }));

      expect(existsSync(upgradeLog(root))).toBe(true);
    });

    it.each([
      ["lists docks", ["docks"], true],
      ["does not list docks", ["another-marketplace"], false],
    ])(
      "previews the retirement in a dry run when the registry %s",
      async (_name, names, removal) => {
        const root = makeRoot();
        writeRegistry(join(root, ".omp"), names);
        const output: Array<string> = [];

        await syncOmp(makeCtx(root, { dryRun: true, output }));

        const lines = output
          .join("")
          .split("\n")
          .filter((line) => line.startsWith("[dry-run] omp "));
        expect(lines).toEqual([
          `[dry-run] omp ${UNINSTALL_DOCKS}`,
          `[dry-run] omp ${UNINSTALL_PLAN}`,
          ...(removal ? [`[dry-run] omp ${REMOVE_MARKETPLACE}`] : []),
          `[dry-run] omp ${kitLink(root)}`,
        ]);
        expect(ompCommands()).toEqual([]);
      },
    );
  });

  it("counts no plugin when the kit plugin link fails", async () => {
    const root = makeRoot();
    respondWithInventory(INVENTORY_EMPTY, kitLink(root));
    const ctx = makeCtx(root);

    const state = await syncOmp(ctx);

    expect(ompCommands()).toEqual(["plugin list --json", kitLink(root)]);
    expect(state.pluginsInstalled).toBe(0);
    expect(ctx.failures).toEqual([
      `omp plugin operation failed for docks-kit-omp: stub omp operation failure; run manually: omp ${kitLink(root)}`,
    ]);
  });

  it("keeps a versionless npm row: a kit plugin link without a version needs no new link", async () => {
    const root = makeRoot();
    const kitDir = join(root, ".docks-kit", "omp-plugin");
    mkdirSync(kitDir, { recursive: true });
    respondWithInventory(
      JSON.stringify({ npm: [{ name: "docks-kit-omp", path: kitDir }], marketplace: [] }),
    );
    const output: Array<string> = [];

    const installed = await syncOmpPlugins(makeCtx(root, { output }));

    expect(ompCommands()).toEqual(["plugin list --json"]);
    expect(installed).toBe(1);
    expect(pluginSummary(output)).toBeUndefined();
  });

  it("reads only the inventory and changes no plugin when git is unavailable", async () => {
    const root = makeRoot();
    writeRegistry(join(root, ".omp"), ["docks"]);
    // Every plugin change would run with git: two uninstalls, the marketplace removal, the link.
    respondWithInventory(JSON.stringify({ npm: [], marketplace: [DOCKS_USER_ROW, PLAN_USER_ROW] }));
    const output: Array<string> = [];
    const ctx = makeCtx(root, { missingTool: "git", output });

    const state = await syncOmp(ctx);

    expect(readFileSync(join(root, ".omp", "agent", "config.yml"), "utf8")).toBe("theme: dark\n");
    expect(ompCommands()).toEqual(["plugin list --json"]);
    expect(messageLines(output, "git not installed")).toHaveLength(1);
    expect(state.pluginsInstalled).toBe(0);
    expect(ctx.failures).toEqual([]);
  });

  it("previews no omp command in a dry run when omp is unavailable", async () => {
    const root = makeRoot();
    // A registry that lists docks would make a dry run with omp preview its removal.
    writeRegistry(join(root, ".omp"), ["docks"]);
    const output: Array<string> = [];

    await syncOmp(makeCtx(root, { missingTool: "omp", dryRun: true, output }));

    const lines = output.join("").split("\n");
    expect(lines.filter((line) => line.startsWith("[dry-run] omp "))).toEqual([]);
    expect(lines.filter((line) => line.includes("omp not installed"))).toHaveLength(1);
    expect(ompCommands()).toEqual([]);
  });

  it.each([
    ["the default profile", undefined, [".pi", "agent", "intercom"]],
    ["a named profile", "work", [".omp", "profiles", "work", "agent", "intercom"]],
  ])(
    "leaves the pi-intercom state folder of %s unchanged and writes no pi-intercom configuration",
    async (_name, profile, folder) => {
      const root = makeRoot();
      if (profile !== undefined) process.env["OMP_PROFILE"] = profile;
      const state = join(root, ...folder);
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "config.json"), '{\r\n  "user": true\r\n}\r\n');
      writeFileSync(join(state, "marker"), "kept\n");
      respondWithInventory(inventory(root));

      await syncOmp(makeCtx(root));

      expect(readdirSync(state).sort()).toEqual(["config.json", "marker"]);
      expect(readFileSync(join(state, "config.json"), "utf8")).toBe('{\r\n  "user": true\r\n}\r\n');
      expect(readFileSync(join(state, "marker"), "utf8")).toBe("kept\n");
      const other = profile === undefined ? [".omp", "agent", "intercom"] : [".pi"];
      expect(existsSync(join(root, ...other))).toBe(false);
    },
  );

  it("keeps only the id in the summary when the inventory cannot be read", async () => {
    respondWithInventory("not json");
    const root = makeRoot();
    const output: Array<string> = [];
    const state = await syncOmp(makeCtx(root, { output }));

    expect(state.pluginsInstalled).toBe(1);
    expect(pluginSummary(output)).toBe("omp plugins synced: docks-kit-omp linked");
  });

  it("links the kit plugin again when omp's entry resolves elsewhere", async () => {
    const root = makeRoot();
    const elsewhere = join(root, "old-plugin");
    mkdirSync(elsewhere);
    respondWithInventory(
      JSON.stringify({
        npm: [{ name: "docks-kit-omp", version: "0.0.0", path: elsewhere }],
        marketplace: [],
      }),
    );
    const output: Array<string> = [];
    const ctx = makeCtx(root, { output });
    const state = await syncOmpPlugins(ctx);

    // A link names no version, so no second inventory read runs.
    expect(ompCommands()).toEqual(["plugin list --json", kitLink(root)]);
    expect(state).toBe(1);
    expect(pluginSummary(output)).toBe("omp plugins synced: docks-kit-omp linked");
    expect(ctx.nextStepTriggers.ompRestart).toBe(true);
  });

  it("previews the kit plugin link in a dry run without spawning omp", async () => {
    const root = makeRoot();
    const output: Array<string> = [];

    await syncOmp(makeCtx(root, { dryRun: true, output }));

    const lines = output.join("").split("\n");
    expect(lines).toContain(`[dry-run] omp plugin link ${root}/.docks-kit/omp-plugin`);
    expect(ompCommands()).toEqual([]);
  });

  describe("pi-intercom notice", () => {
    /** The omp plugin store of the default profile under `root`, as the engine names it. */
    function store(root: string): string {
      return `${root}/.omp/plugins`;
    }

    /** Each output line that starts the notice, from `Notice:` to the line end. */
    function notices(output: ReadonlyArray<string>): Array<string> {
      return messageLines(output, "Notice:");
    }

    /** The output text and the omp argv, both free of every pi-intercom change. */
    function expectNoPiIntercomChange(output: ReadonlyArray<string>): void {
      expect(ompCommands().filter((command) => command.includes("pi-intercom"))).toEqual([]);
      expect(output.join("")).not.toMatch(/(uninstall|remove)[^\n]*pi-intercom/);
    }

    it("names the store and the version of a registry install, once, and changes nothing", async () => {
      const root = makeRoot();
      const row = {
        name: "pi-intercom",
        version: "0.19.0",
        path: `${store(root)}/node_modules/pi-intercom`,
      };
      respondWithInventory(inventory(root, [], [row]));
      const output: Array<string> = [];
      const ctx = makeCtx(root, { output });

      const installed = await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json"]);
      expect(notices(output)).toEqual([expectedNotice(store(root), "version 0.19.0")]);
      // Informational: no warning tag, no failure, no restart advice.
      expect(output.join("")).not.toMatch(/\[warn\][^\n]*Notice:/);
      expect(ctx.failures).toEqual([]);
      expect(ctx.nextStepTriggers.ompRestart).toBe(false);
      expect(installed).toBe(1);
      expectNoPiIntercomChange(output);
    });

    it("names a link without a version as unknown version", async () => {
      const root = makeRoot();
      respondWithInventory(
        inventory(root, [], [{ name: "pi-intercom", path: "/opt/src/pi-intercom" }]),
      );
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(ompCommands()).toEqual(["plugin list --json"]);
      expect(notices(output)).toEqual([expectedNotice(store(root), "unknown version")]);
      expectNoPiIntercomChange(output);
    });

    it.each([
      ["an escape sequence", "0.19.0\u001b[31m"],
      ["a line break", "0.19.0\nrun: omp uninstall pi-intercom"],
      ["65 characters", "1".repeat(65)],
      ["an empty string", ""],
      ["a space", "0.19.0 beta"],
      ["a number", 19],
    ])("names a version with %s as unknown version", async (_name, version) => {
      const root = makeRoot();
      respondWithInventory(inventory(root, [], [{ name: "pi-intercom", version }]));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(notices(output)).toEqual([expectedNotice(store(root), "unknown version")]);
      expectNoPiIntercomChange(output);
    });

    it("keeps a version of 64 characters from the allowed set", async () => {
      const root = makeRoot();
      const version = `1.0.0-rc.1+build.${"a".repeat(47)}`;
      expect(version).toHaveLength(64);
      respondWithInventory(inventory(root, [], [{ name: "pi-intercom", version }]));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(notices(output)).toEqual([expectedNotice(store(root), `version ${version}`)]);
    });

    it("renders the store path as one line of terminal-safe text", () => {
      const notice = piIntercomNotice(
        "/home/u\u001b]0;title\u0007/.omp\r\n/plug\u2028ins",
        "0.19.0",
      );

      expect(notice).toBe(expectedNotice("/home/u]0;title/.omp/plugins", "version 0.19.0"));
      expect(notice).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}]/u);
    });

    it("names the store of a named omp profile", async () => {
      const root = makeRoot();
      process.env["OMP_PROFILE"] = "work";
      respondWithInventory(inventory(root, [], [{ name: "pi-intercom", version: "0.19.0" }]));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(notices(output)).toEqual([
        expectedNotice(`${root}/.omp/profiles/work/plugins`, "version 0.19.0"),
      ]);
      expectNoPiIntercomChange(output);
    });

    it("prints the notice without git, reads only the inventory, and changes no plugin", async () => {
      const root = makeRoot();
      writeRegistry(join(root, ".omp"), ["docks"]);
      respondWithInventory(
        JSON.stringify({
          npm: [{ name: "pi-intercom", version: "0.19.0" }],
          marketplace: [DOCKS_USER_ROW],
        }),
      );
      const output: Array<string> = [];
      const ctx = makeCtx(root, { missingTool: "git", output });

      const installed = await syncOmpPlugins(ctx);

      expect(ompCommands()).toEqual(["plugin list --json"]);
      expect(notices(output)).toEqual([expectedNotice(store(root), "version 0.19.0")]);
      expect(messageLines(output, "git not installed")).toHaveLength(1);
      expect(installed).toBe(0);
      expect(ctx.failures).toEqual([]);
      expectNoPiIntercomChange(output);
    });

    it("spawns nothing and prints no notice in a dry run", async () => {
      const root = makeRoot();
      respondWithInventory(inventory(root, [], [{ name: "pi-intercom", version: "0.19.0" }]));
      const output: Array<string> = [];

      await syncOmp(makeCtx(root, { dryRun: true, output }));

      expect(ompCommands()).toEqual([]);
      expect(notices(output)).toEqual([]);
      expect(output.join("")).not.toContain("pi-intercom");
    });

    it("reads no inventory and prints no notice when omp is unavailable", async () => {
      const root = makeRoot();
      respondWithInventory(inventory(root, [], [{ name: "pi-intercom", version: "0.19.0" }]));
      const output: Array<string> = [];

      await syncOmp(makeCtx(root, { missingTool: "omp", output }));

      expect(ompCommands()).toEqual([]);
      expect(notices(output)).toEqual([]);
      expect(messageLines(output, "omp not installed")).toHaveLength(1);
    });

    it("prints no notice when the inventory lists no pi-intercom", async () => {
      const root = makeRoot();
      respondWithInventory(inventory(root));
      const output: Array<string> = [];

      await syncOmpPlugins(makeCtx(root, { output }));

      expect(notices(output)).toEqual([]);
    });
  });
});
