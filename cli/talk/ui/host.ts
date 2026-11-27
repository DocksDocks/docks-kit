/**
 * The omp host modules of the talk UI (plan #251 G7, #248 D3b).
 *
 * omp supplies `@oh-my-pi/pi-tui` at run time. The bundle keeps each host
 * import external, and `cli/scripts/build-talk.ts` allows it only as a
 * dynamic `import` of one string literal. omp 19.1.1 has a `@oh-my-pi/pi-tui`
 * with an older API (F11), so the probe checks each export that talk uses by
 * type, not only the module.
 */
import { Predicate } from "effect";

import type * as Tui from "@oh-my-pi/pi-tui";
import type * as Width from "@oh-my-pi/pi-tui/text/width";

/** The host exports that the capability probe checks (#251 G7); the views, cards, and handover call some of them. */
export interface HostUi {
  readonly jsx: typeof Tui.jsx;
  readonly signal: typeof Tui.signal;
  readonly isUiNode: typeof Tui.isUiNode;
  readonly visibleWidth: typeof Width.visibleWidth;
  readonly truncate: typeof Width.truncate;
  readonly wrap: typeof Width.wrap;
}

/** Loads each host module. A test injects modules here, so it needs no omp. */
export interface HostModuleLoader {
  readonly tui: () => Promise<unknown>;
  readonly width: () => Promise<unknown>;
}

/** The loader of omp's own host modules. Each specifier must stay one string literal. */
export const hostModuleLoader: HostModuleLoader = {
  tui: () => import("@oh-my-pi/pi-tui"),
  width: () => import("@oh-my-pi/pi-tui/text/width"),
};

const TUI_MODULE = "@oh-my-pi/pi-tui";
const WIDTH_MODULE = "@oh-my-pi/pi-tui/text/width";

export type HostProbe =
  | { readonly _tag: "Ready"; readonly ui: HostUi }
  | { readonly _tag: "Missing"; readonly missing: ReadonlyArray<string> };

type Loaded = { readonly ok: true; readonly module: unknown } | { readonly ok: false };

const load = (importModule: () => Promise<unknown>): Promise<Loaded> =>
  importModule().then(
    (module): Loaded => ({ ok: true, module }),
    (): Loaded => ({ ok: false }),
  );

/** The function export `name` of a loaded module; undefined when it is no function. */
const exported = <K extends keyof HostUi>(loaded: Loaded, name: K): HostUi[K] | undefined => {
  if (!loaded.ok || !Predicate.hasProperty(loaded.module, name)) return undefined;
  const found = loaded.module[name];
  // The run-time check can only see a function; `cli/talk/types/` declares its signature.
  return Predicate.isFunction(found) ? (found as HostUi[K]) : undefined;
};

/**
 * Loads both host modules and checks each export that talk uses (G7). The
 * result names a module whose import rejects, or each export of a loaded
 * module that is no function.
 */
export const probeHost = async (loader: HostModuleLoader): Promise<HostProbe> => {
  const [tui, width] = await Promise.all([load(loader.tui), load(loader.width)]);
  const jsx = exported(tui, "jsx");
  const signal = exported(tui, "signal");
  const isUiNode = exported(tui, "isUiNode");
  const visibleWidth = exported(width, "visibleWidth");
  const truncate = exported(width, "truncate");
  const wrap = exported(width, "wrap");
  const missingIn = (
    loaded: Loaded,
    module: string,
    checks: ReadonlyArray<readonly [string, unknown]>,
  ): ReadonlyArray<string> =>
    loaded.ok
      ? checks.filter(([, found]) => found === undefined).map(([name]) => `${name} of ${module}`)
      : [module];
  const missing = [
    ...missingIn(tui, TUI_MODULE, [
      ["jsx", jsx],
      ["signal", signal],
      ["isUiNode", isUiNode],
    ]),
    ...missingIn(width, WIDTH_MODULE, [
      ["visibleWidth", visibleWidth],
      ["truncate", truncate],
      ["wrap", wrap],
    ]),
  ];
  if (
    jsx === undefined ||
    signal === undefined ||
    isUiNode === undefined ||
    visibleWidth === undefined ||
    truncate === undefined ||
    wrap === undefined
  )
    return { _tag: "Missing", missing };
  return { _tag: "Ready", ui: { jsx, signal, isUiNode, visibleWidth, truncate, wrap } };
};
