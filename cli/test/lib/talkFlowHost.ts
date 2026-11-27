// A fake TUI host for the `/talk` flows of plan #251 G2 to G6: a fake
// `ctx.ui` that mounts each view and records every call, fake services in
// place of the transport and the side turn, and a `jsx` that records each
// node. `command.test.ts` and `handover.test.ts` share it.
import { Predicate } from "effect";
import { expect } from "vitest";

import type { DeliverKind } from "../../talk/tool/protocol";
import type { Target } from "../../talk/transport/request";
import {
  type FlowLife,
  type FlowServices,
  type FlowSlot,
  type FlowUi,
  type ListingAnswer,
  type SendAnswer,
  type TalkCommand,
  type TargetAnswer,
  makeFlowSlot,
} from "../../talk/ui/command";
import type { SideTurn, SideTurnRequest } from "../../talk/ui/handover";
import { type HostModuleLoader, type HostUi, probeHost } from "../../talk/ui/host";
import type { ListRow } from "../../talk/ui/views";

// ── Fake host modules ──

/** One node that the fake `jsx` built: its kind and its props, as given. */
export interface FakeNode {
  readonly kind: string;
  readonly props: Readonly<Record<string, unknown>>;
}

export const isFakeNode = (value: unknown): value is FakeNode =>
  Predicate.hasProperty(value, "kind") &&
  Predicate.isString(value.kind) &&
  Predicate.hasProperty(value, "props") &&
  Predicate.isObject(value.props);

/** A signal without reactivity: tests read each accessor again after each step. */
const fakeSignal = (initial: unknown): unknown => {
  let value = initial;
  return Object.assign(() => value, {
    set: (next: unknown) => {
      value = next;
    },
    update: (fn: (current: unknown) => unknown) => {
      value = fn(value);
    },
    peek: () => value,
  });
};

const fakeModules: HostModuleLoader = {
  tui: async () => ({
    jsx: (kind: unknown, props: Readonly<Record<string, unknown>>): FakeNode => ({
      kind: String(kind),
      props,
    }),
    signal: fakeSignal,
    isUiNode: isFakeNode,
  }),
  width: async () => ({
    visibleWidth: (text: string) => [...text].length,
    truncate: (text: string, width: number) => [...text].slice(0, width).join(""),
    wrap: (text: string) => [text],
  }),
};

export const loadUi = async (): Promise<HostUi> => {
  const probe = await probeHost(fakeModules);
  if (probe._tag !== "Ready") throw new Error(`fake host is missing ${probe.missing.join(", ")}`);
  return probe.ui;
};

// ── Node access ──

/** A prop as the host reads it: an accessor gives its current value. */
export const prop = (node: FakeNode, name: string): unknown => {
  const value = node.props[name];
  return Predicate.isFunction(value) ? Reflect.apply(value, undefined, []) : value;
};

/** Calls the handler `name` of a node, as the host does. */
export const fire = (node: FakeNode, name: string, ...args: ReadonlyArray<unknown>): unknown => {
  const handler = node.props[name];
  if (!Predicate.isFunction(handler)) throw new Error(`no ${name} on ${node.kind}`);
  return Reflect.apply(handler, undefined, args);
};

export type KeyKind = "press" | "repeat" | "release";

/** A key event; `raw` defaults to the id, as a test needs no real bytes for most keys. */
export const key = (
  id: string,
  kind: KeyKind = "press",
  afterPaste = false,
  raw: string = id,
): object => ({
  id,
  kind,
  raw,
  ...(id.length === 1 ? { text: id } : {}),
  ...(afterPaste ? { afterPaste } : {}),
});

export const press = (node: FakeNode, id: string, kind: KeyKind = "press"): unknown =>
  fire(node, "onKey", key(id, kind));

/** Presses a key with the raw bytes of the terminal, such as `enter` from `\r` or from `\n`. */
export const pressRaw = (node: FakeNode, id: string, raw: string): unknown =>
  fire(node, "onKey", key(id, "press", false, raw));

export interface Item {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

const isItem = (value: unknown): value is Item =>
  Predicate.hasProperty(value, "id") &&
  Predicate.isString(value.id) &&
  Predicate.hasProperty(value, "label") &&
  Predicate.isString(value.label) &&
  Predicate.hasProperty(value, "detail") &&
  Predicate.isString(value.detail);

export const itemsOf = (node: FakeNode): ReadonlyArray<Item> => {
  const items = prop(node, "items");
  if (!Array.isArray(items) || !items.every(isItem)) throw new Error("picker without items");
  return items;
};

export const termOf = (node: FakeNode): Readonly<Record<string, unknown>> => {
  const term = prop(node, "term");
  if (!Predicate.isObject(term)) throw new Error("picker without term");
  return Object.fromEntries(Object.entries(term));
};

/** The text of a `text` node: its `text` prop, or its spans joined. */
const textOf = (node: unknown): string => {
  if (!isFakeNode(node)) throw new Error("not a node");
  const text = prop(node, "text");
  if (Predicate.isString(text)) return text;
  const spans = prop(node, "spans");
  if (Array.isArray(spans))
    return spans
      .map((span: unknown) =>
        Predicate.hasProperty(span, "t") && Predicate.isString(span.t) ? span.t : "",
      )
      .join("");
  throw new Error("text node without text");
};

export const linesOf = (node: FakeNode): ReadonlyArray<string> => {
  const children = prop(node, "children");
  if (!Array.isArray(children)) throw new Error(`${node.kind} without children`);
  return children.map(textOf);
};

const CODE_LINE = /^Send to ([0-9a-f]{16}): type ([a-z])([a-z])$/u;

/** The instance id and the code of a confirm view's first line. */
export const codeOf = (node: FakeNode): { readonly instanceId: string; readonly code: string } => {
  const match = CODE_LINE.exec(linesOf(node)[0] ?? "");
  if (match === null) throw new Error(`no code line in ${JSON.stringify(linesOf(node))}`);
  const [, instanceId = "", first = "", second = ""] = match;
  return { instanceId, code: `${first}${second}` };
};

// ── Fake ctx.ui ──

export interface View {
  readonly node: FakeNode;
  readonly options: unknown;
  readonly closed: boolean;
  readonly result: unknown;
  /** omp closes the overlay without `done`, as no omp 19.2.1 path does but a later one can. */
  readonly hostClose: () => void;
}

export const FULL_SCREEN = { overlay: true, fullscreen: true };
/** The compose view: an overlay docked at the bottom. */
export const DOCKED = { overlay: true, fullscreen: false };

/** A fake TUI `ctx.ui`: it mounts each view at once and records each call by method name. */
export class FakeTui {
  size = { columns: 100, rows: 30 };
  readonly views: Array<View> = [];
  readonly calls: Array<string> = [];
  readonly notices: Array<{ readonly text: string; readonly level: string }> = [];
  readonly ui: FlowUi = {
    custom: (factory, options) => {
      this.calls.push("custom");
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const state = { closed: false, hostClosed: false, result: undefined as unknown };
      const node = factory({ size: () => this.size }, {}, {}, (value) => {
        if (state.closed) throw new Error("done called twice");
        state.closed = true;
        state.result = value;
        resolve(value);
      });
      if (!isFakeNode(node)) throw new Error("the factory gave no node");
      // omp gives the overlay handle once the overlay is open (`ExtensionCustomOptions` v19.2.1).
      options.onHandle({
        get closed() {
          return state.closed || state.hostClosed;
        },
        close: () => {
          state.hostClosed = true;
        },
      });
      const view: View = {
        node,
        options,
        get closed() {
          return state.closed;
        },
        get result() {
          return state.result;
        },
        hostClose: () => {
          state.hostClosed = true;
        },
      };
      this.views.push(view);
      return promise;
    },
    notify: (text, level) => {
      this.calls.push("notify");
      this.notices.push({ text, level });
    },
  };

  /** The last view; it must be open. */
  get top(): View {
    const view = this.views.at(-1);
    if (view === undefined || view.closed) throw new Error("no open view");
    return view;
  }
}

// ── Fake services ──

export const ID_A = "aaaaaaaaaaaaaaa1";
export const ID_B = "bbbbbbbbbbbbbbb2";
export const ID_C = "ccccccccccccccc3";

export const row = (instanceId: string, name: string, extra: Partial<ListRow> = {}): ListRow => ({
  instanceId,
  sessionId: `session-${name}-0001`,
  name,
  cwd: `/work/${name}`,
  own: false,
  probe: "ok",
  ...extra,
});

/** The draft that the fake side turn answers. */
export const DRAFT = "## Next task\nShip it.\n\n## Risks\nNone.";

export interface Sent {
  readonly pair: Target;
  readonly text: string;
  readonly kind: DeliverKind;
}

export class FakeServices implements FlowServices {
  session = "s-1";
  rows: ReadonlyArray<ListRow> = [row(ID_A, "self", { own: true }), row(ID_B, "beta")];
  listing: Promise<ListingAnswer> | undefined;
  /** Set: the listing rejects with it, as a defect of the transport runtime. */
  listError: Error | undefined;
  target: TargetAnswer = {
    _tag: "Failed",
    text: "talk: no listed session matches `x` (not-found).",
  };
  readonly targets: Array<string> = [];
  readonly sends: Array<Sent> = [];
  answer: SendAnswer = { ok: true, text: "Delivered: the message is in the session." };
  /** Set: each send waits for it after it records the send, as a slow lookup does. */
  sendGate: Promise<void> | undefined;
  /** The flow life of each listing, resolution, and send, in call order. */
  readonly lives: Array<FlowLife> = [];
  /** Each side-turn request, as the flow made it. */
  readonly turns: Array<SideTurnRequest> = [];
  /** What the side turn gives; the default answers with `DRAFT`. */
  reply: () => Promise<unknown> = () => Promise.resolve({ replyText: DRAFT });

  readonly sessionId = (): string => this.session;
  readonly list = (life: FlowLife): Promise<ListingAnswer> => {
    this.lives.push(life);
    return this.listError === undefined
      ? (this.listing ?? Promise.resolve({ _tag: "Listed", rows: this.rows }))
      : Promise.reject(this.listError);
  };
  readonly resolve = async (target: string, life: FlowLife): Promise<TargetAnswer> => {
    this.lives.push(life);
    this.targets.push(target);
    return this.target;
  };
  readonly send = async (
    pair: Target,
    text: string,
    kind: DeliverKind,
    life: FlowLife,
  ): Promise<SendAnswer> => {
    this.lives.push(life);
    this.sends.push({ pair, text, kind });
    if (this.sendGate !== undefined) await this.sendGate;
    return this.answer;
  };
  sideTurn: SideTurn | undefined = (request) => {
    this.turns.push(request);
    return this.reply();
  };
}

/** Lets every pending promise step of a flow run. */
export const flush = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

export interface Harness {
  readonly tui: FakeTui;
  readonly services: FakeServices;
  readonly run: (command?: TalkCommand) => Promise<void>;
  readonly slot: FlowSlot;
}

export const harness = async (): Promise<Harness> => {
  const tui = new FakeTui();
  const services = new FakeServices();
  const slot = makeFlowSlot(await loadUi());
  return {
    tui,
    services,
    slot,
    run: async (command = { _tag: "List" }) => {
      const flow = slot.run(tui.ui, services, command);
      await flush();
      return flow;
    },
  };
};

/** Activates the item of `instanceId` in the open list and types `text` in the compose view. */
export const composeTo = async (
  h: Harness,
  instanceId: string,
  text: string,
): Promise<FakeNode> => {
  const list = h.tui.top.node;
  const item = itemsOf(list).find((candidate) => candidate.label.startsWith(instanceId));
  if (item === undefined) throw new Error(`no item of ${instanceId}`);
  fire(list, "onSelect", item.id);
  fire(list, "onActivate", item.id);
  await flush();
  const compose = h.tui.top.node;
  expect(compose.kind).toBe("input");
  fire(compose, "onEdit", { from: 0, to: 0, text, cursor: text.length, len: 0 });
  return compose;
};

/** Composes `text` to `instanceId` and confirms it with enter; returns the confirm node. */
export const confirmTo = async (
  h: Harness,
  instanceId: string,
  text: string,
): Promise<FakeNode> => {
  const compose = await composeTo(h, instanceId, text);
  expect(press(compose, "enter")).toBe(true);
  await flush();
  return h.tui.top.node;
};

export const typeCode = (node: FakeNode, code: string): void => {
  for (const letter of code) press(node, letter);
};
