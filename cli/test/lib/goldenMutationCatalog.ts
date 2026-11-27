import { ompStubBody } from "./goldenResources";
import type { SeededTree } from "./goldenSnapshot";

export interface MutationMatrixCase {
  fixture: string;
  cmd: Array<string>;
  stubs?: Record<string, string | null>;
  variant?: string;
  /** Extra environment of the run, such as `OMP_PROFILE` for a named omp profile. */
  env?: Record<string, string>;
  /** Files that the case writes below HOME before the run; the run must leave their bytes and entries as they are. */
  seed?: SeededTree;
  /**
   * The pi-intercom notice that the output must hold exactly once, with the
   * run home as `<HOME>`. A case with a notice also checks that sync changes
   * no pi-intercom install and that the deployed kit plugin ships `talk`.
   */
  piIntercomNotice?: string;
}

export interface MutationReplayCase {
  fixture: string;
  cmd: Array<string>;
}

/**
 * The old pi-intercom state folder below the agent root `agentRoot`, where
 * pi-intercom keeps its state: `~/.pi/agent` for the default profile, the
 * profile agent folder for a named profile. `config.json` has CRLF line
 * endings, so a rewrite that only normalizes them shows too.
 */
function piIntercomState(agentRoot: string): SeededTree {
  return {
    root: `${agentRoot}/intercom`,
    files: {
      "config.json": '{\r\n  "brokerCommand": "bun",\r\n  "brokerArgs": []\r\n}\r\n',
      "user-marker.txt": "kept by the user\n",
    },
  };
}

/** The expected pi-intercom notice for `store`, with `version` as `version <v>` or `unknown version`. */
function piIntercomNotice(store: string, version: string): string {
  return `Notice: the omp plugin store ${store} lists pi-intercom, ${version}. docks-kit no longer installs or updates pi-intercom. The talk tool of the kit plugin replaces it. pi-intercom 0.19.0 from npm does not load on omp 19.2 or later.`;
}

/** An npm row of a registry install of pi-intercom 0.19.0, the last release that sync installed. */
const PI_INTERCOM_REGISTRY_ROW = { name: "pi-intercom", version: "0.19.0" };

// `variant` disambiguates rows whose fixture+cmd+stub-keys are identical but
// whose stub BODIES differ — without it their labels collide and the later
// row silently overwrites the earlier one's golden.
export const MATRIX: Array<MutationMatrixCase> = [
  { fixture: "home-fresh", cmd: ["sync"] },
  { fixture: "home-fresh", cmd: ["sync"], stubs: { omp: null } },
  // omp is present but every plugin/marketplace subcommand exits non-zero: the
  // run must list each failed operation under `--- Failures ---` and exit 1
  // instead of reporting a clean sync over a stale plugin.
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: {
      omp: `if (args[0] === "--version") {
  console.log("omp/19.2.1")
} else if (args[0] === "plugin" && args[1] === "list") {
  console.log('{"npm":[],"marketplace":[]}')
} else {
  console.error("stub omp operation failure")
  process.exitCode = 1
}`,
    },
    variant: "plugin-failure",
  },
  { fixture: "home-fresh", cmd: ["toolchain", "check"] },
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: { jq: null },
    variant: "jq-absent-native-sync",
  },
  // Missing git: one hint-bearing warn from the dependency registry.
  { fixture: "home-fresh", cmd: ["sync"], stubs: { git: null } },
  // pi-intercom cutover: sync installs, updates, configures, and locks
  // nothing of pi-intercom, prints one notice while the store lists it, and
  // leaves its state folder byte-identical.
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: { omp: ompStubBody([PI_INTERCOM_REGISTRY_ROW]) },
    variant: "pi-intercom-registry",
    seed: piIntercomState(".pi/agent"),
    piIntercomNotice: piIntercomNotice("<HOME>/.omp/plugins", "version 0.19.0"),
  },
  // omp lists a local link without a version.
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: { omp: ompStubBody([{ name: "pi-intercom", path: "/opt/src/pi-intercom" }]) },
    variant: "pi-intercom-link",
    seed: piIntercomState(".pi/agent"),
    piIntercomNotice: piIntercomNotice("<HOME>/.omp/plugins", "unknown version"),
  },
  // A named omp profile: sync and omp take the profile from OMP_PROFILE. The
  // default store lists another version, so a sync whose omp child loses the
  // profile prints a notice that does not match.
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: {
      omp: ompStubBody([{ name: "pi-intercom", version: "0.18.0" }], {
        work: [PI_INTERCOM_REGISTRY_ROW],
      }),
    },
    variant: "pi-intercom-profile",
    env: { OMP_PROFILE: "work" },
    seed: piIntercomState(".omp/profiles/work/agent"),
    piIntercomNotice: piIntercomNotice("<HOME>/.omp/profiles/work/plugins", "version 0.19.0"),
  },
  // Without git, sync still reads the inventory and prints the notice, and it changes no plugin.
  {
    fixture: "home-fresh",
    cmd: ["sync"],
    stubs: { omp: ompStubBody([PI_INTERCOM_REGISTRY_ROW]), git: null },
    variant: "pi-intercom-git-missing",
    seed: piIntercomState(".pi/agent"),
    piIntercomNotice: piIntercomNotice("<HOME>/.omp/plugins", "version 0.19.0"),
  },
];

/**
 * Sequential same-HOME replay rows — run the command twice against ONE home
 * and golden the SECOND run, so repeat-run output (the "already in sync"
 * surface) is pinned explicitly.
 */
export const REPLAYS: Array<MutationReplayCase> = [
  { fixture: "home-fresh", cmd: ["sync"] },
  { fixture: "home-drift", cmd: ["sync"] },
  // Verbose replay: the demoted no-op confirmations must come back.
  { fixture: "home-fresh", cmd: ["sync", "--verbose"] },
];
