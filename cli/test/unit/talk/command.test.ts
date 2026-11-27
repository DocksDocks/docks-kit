import { Predicate } from "effect";
import { describe, expect, it } from "vitest";

import { literal } from "../../../talk/tool/attachments";
import type { Target } from "../../../talk/transport/request";
import {
  type FlowServices,
  type FlowSlot,
  type FlowUi,
  HANDOVER_NOT_READY,
  type ListingAnswer,
  type SendAnswer,
  type TalkCommand,
  type TargetAnswer,
  makeFlowSlot,
  parseTalkArgs,
  talkCompletions,
} from "../../../talk/ui/command";
import { type HostModuleLoader, type HostUi, probeHost } from "../../../talk/ui/host";
import {
  CONFIRM_TOO_SMALL,
  INSTANCE_ID_LENGTH,
  LIST_TOO_SMALL,
  type ListRow,
  PICKER_FIXED_ROWS,
  PICKER_LABEL_CHROME,
  PICKER_ROW_LIMIT,
  drawCode,
  listLayout,
} from "../../../talk/ui/views";

// The `/talk` flows of plan #251 G2 and G3 against a fake TUI host: a fake
// `ctx.ui` that mounts each view and records every call, fake services in
// place of the transport, and a `jsx` that records each node.

// ── Fake host modules ──

/** One node that the fake `jsx` built: its kind and its props, as given. */
interface FakeNode {
  readonly kind: string;
  readonly props: Readonly<Record<string, unknown>>;
}

const isFakeNode = (value: unknown): value is FakeNode =>
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

const loadUi = async (): Promise<HostUi> => {
  const probe = await probeHost(fakeModules);
  if (probe._tag !== "Ready") throw new Error(`fake host is missing ${probe.missing.join(", ")}`);
  return probe.ui;
};

// ── Node access ──

/** A prop as the host reads it: an accessor gives its current value. */
const prop = (node: FakeNode, name: string): unknown => {
  const value = node.props[name];
  return Predicate.isFunction(value) ? Reflect.apply(value, undefined, []) : value;
};

/** Calls the handler `name` of a node, as the host does. */
const fire = (node: FakeNode, name: string, ...args: ReadonlyArray<unknown>): unknown => {
  const handler = node.props[name];
  if (!Predicate.isFunction(handler)) throw new Error(`no ${name} on ${node.kind}`);
  return Reflect.apply(handler, undefined, args);
};

type KeyKind = "press" | "repeat" | "release";

const key = (id: string, kind: KeyKind = "press", afterPaste = false): object => ({
  id,
  kind,
  raw: id,
  ...(id.length === 1 ? { text: id } : {}),
  ...(afterPaste ? { afterPaste } : {}),
});

const press = (node: FakeNode, id: string, kind: KeyKind = "press"): unknown =>
  fire(node, "onKey", key(id, kind));

interface Item {
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

const itemsOf = (node: FakeNode): ReadonlyArray<Item> => {
  const items = prop(node, "items");
  if (!Array.isArray(items) || !items.every(isItem)) throw new Error("picker without items");
  return items;
};

const termOf = (node: FakeNode): Readonly<Record<string, unknown>> => {
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

const linesOf = (node: FakeNode): ReadonlyArray<string> => {
  const children = prop(node, "children");
  if (!Array.isArray(children)) throw new Error(`${node.kind} without children`);
  return children.map(textOf);
};

const CODE_LINE = /^Send to ([0-9a-f]{16}): type ([a-z])([a-z])$/u;

/** The instance id and the code of a confirm view's first line. */
const codeOf = (node: FakeNode): { readonly instanceId: string; readonly code: string } => {
  const match = CODE_LINE.exec(linesOf(node)[0] ?? "");
  if (match === null) throw new Error(`no code line in ${JSON.stringify(linesOf(node))}`);
  const [, instanceId = "", first = "", second = ""] = match;
  return { instanceId, code: `${first}${second}` };
};

// ── Fake ctx.ui ──

interface View {
  readonly node: FakeNode;
  readonly options: unknown;
  closed: boolean;
  result: unknown;
}

const FULL_SCREEN = { overlay: true, fullscreen: true };

/** A fake TUI `ctx.ui`: it mounts each view at once and records each call by method name. */
class FakeTui {
  size = { columns: 100, rows: 30 };
  readonly views: Array<View> = [];
  readonly calls: Array<string> = [];
  readonly notices: Array<{ readonly text: string; readonly level: string }> = [];
  readonly ui: FlowUi = {
    custom: (factory, options) => {
      this.calls.push("custom");
      const { promise, resolve } = Promise.withResolvers<unknown>();
      const state = { closed: false, result: undefined as unknown };
      const node = factory({ size: () => this.size }, {}, {}, (value) => {
        if (state.closed) throw new Error("done called twice");
        state.closed = true;
        state.result = value;
        resolve(value);
      });
      if (!isFakeNode(node)) throw new Error("the factory gave no node");
      const view: View = {
        node,
        options,
        get closed() {
          return state.closed;
        },
        get result() {
          return state.result;
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

const ID_A = "aaaaaaaaaaaaaaa1";
const ID_B = "bbbbbbbbbbbbbbb2";
const ID_C = "ccccccccccccccc3";

const row = (instanceId: string, name: string, extra: Partial<ListRow> = {}): ListRow => ({
  instanceId,
  sessionId: `session-${name}-0001`,
  name,
  cwd: `/work/${name}`,
  own: false,
  probe: "ok",
  ...extra,
});

class FakeServices implements FlowServices {
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
  readonly sends: Array<{ readonly pair: Target; readonly text: string }> = [];
  answer: SendAnswer = { ok: true, text: "Delivered: the message is in the session." };

  readonly sessionId = (): string => this.session;
  readonly list = (): Promise<ListingAnswer> =>
    this.listError === undefined
      ? (this.listing ?? Promise.resolve({ _tag: "Listed", rows: this.rows }))
      : Promise.reject(this.listError);
  readonly resolve = async (target: string): Promise<TargetAnswer> => {
    this.targets.push(target);
    return this.target;
  };
  readonly send = async (pair: Target, text: string): Promise<SendAnswer> => {
    this.sends.push({ pair, text });
    return this.answer;
  };
}

/** Lets every pending promise step of a flow run. */
const flush = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
};

interface Harness {
  readonly tui: FakeTui;
  readonly services: FakeServices;
  readonly run: (command?: TalkCommand) => Promise<void>;
  readonly slot: FlowSlot;
}

const harness = async (): Promise<Harness> => {
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
const composeTo = async (h: Harness, instanceId: string, text: string): Promise<FakeNode> => {
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
const confirmTo = async (h: Harness, instanceId: string, text: string): Promise<FakeNode> => {
  const compose = await composeTo(h, instanceId, text);
  expect(press(compose, "enter")).toBe(true);
  await flush();
  return h.tui.top.node;
};

const typeCode = (node: FakeNode, code: string): void => {
  for (const letter of code) press(node, letter);
};

// ── Tests ──

describe("/talk arguments (G2)", () => {
  it.each([
    ["", { _tag: "List" }],
    ["   ", { _tag: "List" }],
    ["beta", { _tag: "Compose", target: "beta" }],
    ["  two  words  ", { _tag: "Compose", target: "two  words" }],
    ["handover", { _tag: "Handover", target: undefined }],
    ["handover beta", { _tag: "Handover", target: "beta" }],
    ["handover   two words ", { _tag: "Handover", target: "two words" }],
    ["handovers", { _tag: "Compose", target: "handovers" }],
    ["Handover beta", { _tag: "Compose", target: "Handover beta" }],
  ] as const)("decodes %j", (args, expected) => {
    expect(parseTalkArgs(args)).toEqual(expected);
  });
});

describe("/talk completion (F1, G2)", () => {
  const names = ["beta", "beta", "bravo", "two words", "line\nbreak", "handover desk", ""];

  it("offers handover and each distinct one-line name of the snapshot", () => {
    expect(talkCompletions("", names)?.map((item) => item.value)).toEqual([
      "handover",
      "beta",
      "bravo",
      "two words",
    ]);
  });

  it("filters by the argument prefix", () => {
    expect(talkCompletions("b", names)?.map((item) => item.value)).toEqual(["beta", "bravo"]);
    expect(talkCompletions("ha", names)?.map((item) => item.value)).toEqual(["handover"]);
    expect(talkCompletions("zz", names)).toBeNull();
  });

  it("offers the names as handover targets after the sub-command word", () => {
    expect(talkCompletions("handover b", names)?.map((item) => item.value)).toEqual([
      "handover beta",
      "handover bravo",
    ]);
    expect(talkCompletions("handover ", names)?.map((item) => item.label)).toEqual([
      "beta",
      "bravo",
      "two words",
      "handover desk",
    ]);
  });

  it("offers only handover from an empty snapshot", () => {
    expect(talkCompletions("", [])?.map((item) => item.value)).toEqual(["handover"]);
  });
});

describe("list layout (G3)", () => {
  it("gives the rows after the fixed picker rows, at most 10", () => {
    expect(listLayout({ columns: 80, rows: 40 })).toEqual({
      maxRows: PICKER_ROW_LIMIT,
      fits: true,
    });
    expect(listLayout({ columns: 80, rows: 8 })).toEqual({
      maxRows: 8 - PICKER_FIXED_ROWS,
      fits: true,
    });
    expect(listLayout({ columns: 80, rows: PICKER_FIXED_ROWS + 1 })).toEqual({
      maxRows: 1,
      fits: true,
    });
    expect(listLayout({ columns: 80, rows: PICKER_FIXED_ROWS }).fits).toBe(false);
  });

  it("fits only when the label budget holds the full instance id", () => {
    const narrowest = INSTANCE_ID_LENGTH + PICKER_LABEL_CHROME;
    expect(listLayout({ columns: narrowest, rows: 20 }).fits).toBe(true);
    expect(listLayout({ columns: narrowest - 1, rows: 20 }).fits).toBe(false);
    expect(listLayout(undefined).fits).toBe(false);
  });
});

describe("confirm code (G3)", () => {
  it("draws two different lowercase letters", () => {
    for (let round = 0; round < 200; round += 1) {
      const code = drawCode(undefined);
      expect(code).toMatch(/^[a-z]{2}$/u);
      expect(code.charAt(0)).not.toBe(code.charAt(1));
    }
  });

  it("never gives two equal letters and never repeats the last code", () => {
    // The picks 0 then 0 give `ab`: the second pick skips the first letter.
    const picks = [0, 0, 0, 0, 1, 1];
    const pick = (): number => picks.shift() ?? 0;
    expect(drawCode("ab", pick)).toBe("bc");
  });
});

describe("list view (G3)", () => {
  it("opens a full-screen overlay with a screen-size picker whose labels start with the full instance id", async () => {
    const h = await harness();
    h.services.rows = [
      row(ID_A, "self", { own: true }),
      row(ID_B, "be\nta", { cwd: "/w`x", probe: "timeout" }),
    ];
    const flow = h.run();
    await flush();
    const view = h.tui.top;
    expect(view.options).toEqual(FULL_SCREEN);
    expect(view.node.kind).toBe("picker");
    expect(prop(view.node, "size")).toBe("screen");
    const items = itemsOf(view.node);
    expect(items.map((item) => item.label)).toEqual([
      `${ID_A}  ${literal("self")}`,
      `${ID_B}  ${literal("be\nta")}`,
    ]);
    expect(items[1]?.label).not.toContain("\n");
    expect(items[0]?.detail).toContain("(this session)");
    expect(items[1]?.detail).toContain(literal("/w`x"));
    expect(items[1]?.detail).toContain("unresolved: timeout");
    // The first row that is not this session is selected.
    expect(prop(view.node, "selected")).toBe(items[1]?.id);
    press(view.node, "escape");
    await flow;
    expect(h.tui.calls).toEqual(["custom"]);
    expect(h.services.sends).toEqual([]);
  });

  it("follows select, and opens compose for the activated row", async () => {
    const h = await harness();
    h.services.rows = [row(ID_A, "self", { own: true }), row(ID_B, "beta"), row(ID_C, "gamma")];
    const flow = h.run();
    await flush();
    const list = h.tui.top.node;
    const [, , third] = itemsOf(list);
    fire(list, "onSelect", third?.id);
    expect(prop(list, "selected")).toBe(third?.id);
    // A select of an unknown item changes nothing.
    fire(list, "onSelect", "unknown");
    expect(prop(list, "selected")).toBe(third?.id);
    fire(list, "onActivate", third?.id);
    await flush();
    const compose = h.tui.top;
    expect(compose.node.kind).toBe("input");
    expect(compose.options).toBeUndefined();
    expect(prop(compose.node, "prompt")).toBe(`To ${literal("gamma")}: `);
    press(compose.node, "escape");
    await flow;
    expect(h.services.sends).toEqual([]);
    expect(h.tui.notices).toEqual([]);
  });

  it.each(["escape", "alt+t"])("closes on %s and sends nothing", async (id) => {
    const h = await harness();
    const flow = h.run();
    await flush();
    expect(press(h.tui.top.node, id)).toBe(true);
    await flow;
    expect(h.tui.views.at(-1)?.result).toEqual({ _tag: "Close" });
    expect(h.tui.calls).toEqual(["custom"]);
  });

  it("takes h for handover of the selected row, which this version does not have yet", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    expect(press(h.tui.top.node, "h")).toBe(true);
    await flow;
    expect(h.tui.views.at(-1)?.result).toMatchObject({
      _tag: "Handover",
      row: { instanceId: ID_B },
    });
    expect(h.tui.notices).toEqual([{ text: HANDOVER_NOT_READY, level: "warning" }]);
    expect(h.services.sends).toEqual([]);
  });

  it("sets term.maxRows from the overlay height after the fixed rows, also after a resize", async () => {
    const h = await harness();
    h.tui.size = { columns: 100, rows: 40 };
    const flow = h.run();
    await flush();
    const list = h.tui.top.node;
    expect(termOf(list)["maxRows"]).toBe(PICKER_ROW_LIMIT);
    h.tui.size = { columns: 100, rows: 9 };
    expect(termOf(list)["maxRows"]).toBe(9 - PICKER_FIXED_ROWS);
    h.tui.size = { columns: 100, rows: 5 };
    expect(termOf(list)["maxRows"]).toBe(5 - PICKER_FIXED_ROWS);
    press(list, "escape");
    await flow;
  });

  it.each([
    ["no item row fits", { columns: 100, rows: PICKER_FIXED_ROWS }],
    [
      "the instance id does not fit",
      { columns: INSTANCE_ID_LENGTH + PICKER_LABEL_CHROME - 1, rows: 30 },
    ],
  ])(
    "shows only the request for a larger pane and takes no activate and no h when %s",
    async (_name, size) => {
      const h = await harness();
      const flow = h.run();
      await flush();
      const list = h.tui.top.node;
      const [, beta] = itemsOf(list);
      h.tui.size = size;
      expect(itemsOf(list)).toEqual([]);
      expect(prop(list, "selected")).toBeNull();
      expect(prop(list, "empty")).toBe(LIST_TOO_SMALL);
      expect(termOf(list)["hint"]).toBeNull();
      // Enter stops at the view, so the picker widget reports no activate.
      expect(press(list, "enter")).toBe(true);
      fire(list, "onActivate", beta?.id);
      expect(press(list, "h")).toBe(true);
      await flush();
      expect(h.tui.top.node).toBe(list);
      // A larger pane gives the rows back, and Enter reaches the widget again.
      h.tui.size = { columns: 100, rows: 30 };
      expect(itemsOf(list)).toHaveLength(2);
      expect(press(list, "enter")).toBe(false);
      press(list, "escape");
      await flow;
      expect(h.tui.notices).toEqual([]);
    },
  );

  it("keeps rows that differ only by instance id apart and sends to the chosen pair", async () => {
    const h = await harness();
    const twin = { name: "beta", sessionId: "session-shared", cwd: "/work/beta" };
    h.services.rows = [row(ID_B, "beta", twin), row(ID_C, "beta", twin)];
    const flow = h.run();
    await flush();
    const items = itemsOf(h.tui.top.node);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    const confirm = await confirmTo(h, ID_C, "hello");
    const { instanceId, code } = codeOf(confirm);
    expect(instanceId).toBe(ID_C);
    typeCode(confirm, code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: { instanceId: ID_C, sessionId: "session-shared" }, text: "hello" },
    ]);
  });

  it("reports a failed listing and mounts no view", async () => {
    const h = await harness();
    h.services.listing = Promise.resolve({
      _tag: "Failed",
      text: "talk: the registry could not be listed",
    });
    await h.run();
    expect(h.tui.calls).toEqual(["notify"]);
    expect(h.tui.notices).toEqual([
      { text: "talk: the registry could not be listed", level: "error" },
    ]);
  });
});

describe("compose and confirm views (G3)", () => {
  it("sends nothing before the confirm view, then sends to the selected pair and shows the result", async () => {
    const h = await harness();
    h.services.answer = {
      ok: true,
      text: `Delivered: the message is in the session.\nInstance: ${ID_B}`,
    };
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello there");
    expect(h.services.sends).toEqual([]);
    const view = h.tui.top;
    expect(view.options).toEqual(FULL_SCREEN);
    expect(confirm.kind).toBe("col");
    const { instanceId, code } = codeOf(confirm);
    expect(instanceId).toBe(ID_B);
    expect(code.charAt(0)).not.toBe(code.charAt(1));
    expect(linesOf(confirm).slice(1, 4)).toEqual([
      `${literal("beta")} · ${literal("/work/beta")}`,
      "Kind: message",
      "Text: hello there",
    ]);
    typeCode(confirm, code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: { instanceId: ID_B, sessionId: "session-beta-0001" }, text: "hello there" },
    ]);
    expect(h.tui.notices).toEqual([{ text: h.services.answer.text, level: "info" }]);
    expect(h.tui.calls).toEqual(["custom", "custom", "custom", "notify"]);
  });

  it("shows a failed send as an error notice", async () => {
    const h = await harness();
    h.services.answer = { ok: false, text: "talk: Not live: the session ended or moved." };
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.tui.notices).toEqual([{ text: h.services.answer.text, level: "error" }]);
  });

  it("sends only on the two code letters as two presses", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    const { code } = codeOf(confirm);
    const [first = "", second = ""] = code;
    const wrong =
      "abcdefghijklmnopqrstuvwxyz".split("").find((letter) => !code.includes(letter)) ?? "";
    // A wrong letter clears the typed letter.
    press(confirm, first);
    press(confirm, wrong);
    press(confirm, second);
    // A repeat event clears it.
    press(confirm, first);
    press(confirm, second, "repeat");
    press(confirm, second);
    // A paste clears it, and so does the first key decoded after a paste.
    press(confirm, first);
    expect(fire(confirm, "onPaste", { text: second })).toBe(true);
    press(confirm, second);
    press(confirm, first);
    fire(confirm, "onKey", key(second, "press", true));
    // Enter sends nothing and clears too; the second letter alone does not send.
    press(confirm, first);
    expect(press(confirm, "enter")).toBe(true);
    press(confirm, second);
    // The letters in the wrong order do not send.
    press(confirm, second);
    press(confirm, first);
    press(confirm, wrong);
    await flush();
    expect(h.tui.top.node).toBe(confirm);
    expect(h.services.sends).toEqual([]);
    // A release between the two presses changes nothing.
    press(confirm, first);
    press(confirm, first, "release");
    press(confirm, second);
    await flow;
    expect(h.services.sends).toHaveLength(1);
  });

  it("sends nothing while the first line does not fit the width", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    const { code } = codeOf(confirm);
    const firstLine = `Send to ${ID_B}: type ${code}`;
    h.tui.size = { columns: firstLine.length - 1, rows: 30 };
    expect(linesOf(confirm)).toEqual([CONFIRM_TOO_SMALL]);
    typeCode(confirm, code);
    await flush();
    expect(h.tui.top.node).toBe(confirm);
    // One letter typed while narrow does not count once the pane is wide.
    press(confirm, code.charAt(0));
    h.tui.size = { columns: firstLine.length, rows: 30 };
    expect(linesOf(confirm)[0]).toBe(firstLine);
    press(confirm, code.charAt(1));
    await flush();
    expect(h.services.sends).toEqual([]);
    typeCode(confirm, code);
    await flow;
    expect(h.services.sends).toHaveLength(1);
  });

  it("returns to compose with the text kept on escape, and draws a new code for the next confirm view", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const firstConfirm = await confirmTo(h, ID_B, "keep me");
    const firstCode = codeOf(firstConfirm).code;
    press(firstConfirm, "escape");
    await flush();
    const compose = h.tui.top.node;
    expect(compose.kind).toBe("input");
    expect(prop(compose, "text")).toBe("keep me");
    expect(prop(compose, "cursor")).toBe("keep me".length);
    press(compose, "enter");
    await flush();
    const secondConfirm = h.tui.top.node;
    const secondCode = codeOf(secondConfirm).code;
    expect(secondCode).not.toBe(firstCode);
    // The old code no longer sends.
    typeCode(secondConfirm, firstCode);
    // Enter clears what the old code left typed.
    press(secondConfirm, "enter");
    await flush();
    expect(h.services.sends).toEqual([]);
    typeCode(secondConfirm, secondCode);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: { instanceId: ID_B, sessionId: "session-beta-0001" }, text: "keep me" },
    ]);
  });

  it("closes the flow from the confirm view on alt+t and sends nothing", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    press(confirm, "alt+t");
    await flow;
    expect(h.services.sends).toEqual([]);
    expect(h.tui.notices).toEqual([]);
  });

  it.each(["escape", "alt+t"])("cancels compose on %s", async (id) => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const compose = await composeTo(h, ID_B, "draft");
    press(compose, id);
    await flow;
    expect(h.tui.views).toHaveLength(2);
    expect(h.services.sends).toEqual([]);
    expect(h.tui.notices).toEqual([]);
  });

  it("keeps compose open on enter without text, ignores a stale edit, and lets other keys reach the field", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const compose = await composeTo(h, ID_B, "   ");
    expect(press(compose, "enter")).toBe(true);
    await flush();
    expect(h.tui.top.node).toBe(compose);
    expect(press(compose, "left")).toBe(false);
    fire(compose, "onEdit", { from: 0, to: 0, text: "x", cursor: 1, len: 99 });
    expect(prop(compose, "text")).toBe("   ");
    press(compose, "escape");
    await flow;
  });
});

describe("/talk <target> and /talk handover (G2)", () => {
  it("resolves the target before any view and composes for that pair", async () => {
    const h = await harness();
    h.services.target = {
      _tag: "Resolved",
      destination: { instanceId: ID_C, sessionId: "session-gamma", name: "gamma", cwd: "/g" },
    };
    const flow = h.run({ _tag: "Compose", target: "gam" });
    await flush();
    expect(h.services.targets).toEqual(["gam"]);
    const compose = h.tui.top.node;
    expect(compose.kind).toBe("input");
    fire(compose, "onEdit", { from: 0, to: 0, text: "hi", cursor: 2, len: 0 });
    press(compose, "enter");
    await flush();
    const confirm = h.tui.top.node;
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: { instanceId: ID_C, sessionId: "session-gamma" }, text: "hi" },
    ]);
  });

  it("reports a target that does not resolve and mounts no view", async () => {
    const h = await harness();
    await h.run({ _tag: "Compose", target: "x" });
    expect(h.tui.calls).toEqual(["notify"]);
    expect(h.tui.notices).toEqual([
      { text: h.services.target._tag === "Failed" ? h.services.target.text : "", level: "error" },
    ]);
  });

  it.each([undefined, "beta"])(
    "answers /talk handover %s with the notice that handover is not here yet",
    async (target) => {
      const h = await harness();
      await h.run({ _tag: "Handover", target });
      expect(h.tui.calls).toEqual(["notify"]);
      expect(h.tui.notices).toEqual([{ text: HANDOVER_NOT_READY, level: "warning" }]);
    },
  );
});

describe("flow slot (G3)", () => {
  it("closes the open view of a flow when a second flow starts, and the old flow sends nothing", async () => {
    const h = await harness();
    const first = h.run();
    await flush();
    const oldConfirm = await confirmTo(h, ID_B, "old");
    const { code } = codeOf(oldConfirm);
    const second = h.run();
    await flush();
    await first;
    expect(h.tui.views.at(-2)?.closed).toBe(true);
    expect(h.tui.views.at(-2)?.result).toEqual({ _tag: "Close" });
    expect(h.tui.top.node.kind).toBe("picker");
    // Keys on the closed view do nothing.
    typeCode(oldConfirm, code);
    await flush();
    expect(h.services.sends).toEqual([]);
    press(h.tui.top.node, "escape");
    await second;
    expect(h.services.sends).toEqual([]);
  });

  it("closes the open view on end, and mounts nothing after it", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    await composeTo(h, ID_B, "draft");
    h.slot.end();
    await flow;
    expect(h.tui.views.every((view) => view.closed)).toBe(true);
    expect(h.tui.calls).toEqual(["custom", "custom"]);
    expect(h.services.sends).toEqual([]);
  });

  it("aborts a pending listing on end, so no view mounts when it arrives", async () => {
    const h = await harness();
    const listing = Promise.withResolvers<ListingAnswer>();
    h.services.listing = listing.promise;
    const flow = h.run();
    h.slot.end();
    await flow;
    listing.resolve({ _tag: "Listed", rows: h.services.rows });
    await flush();
    expect(h.tui.calls).toEqual([]);
  });

  it("ends the flow when the session id changes: check closes the view", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    h.slot.check();
    expect(h.tui.top.node.kind).toBe("picker");
    h.services.session = "s-2";
    h.slot.check();
    await flow;
    expect(h.tui.views.every((view) => view.closed)).toBe(true);
  });

  it("sends nothing when the session id changed before the code completes", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    h.services.session = "s-2";
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it.each([
    ["an error whose text has the prefix", "talk: the listing broke"],
    ["an error whose text has no prefix", "the listing broke"],
  ])("shows %s with exactly one talk: prefix", async (_name, message) => {
    const h = await harness();
    h.services.listError = new Error(message);
    await h.run();
    expect(h.tui.notices).toEqual([{ text: "talk: the listing broke", level: "error" }]);
  });

  it("mounts no view when the session id changed while the listing ran", async () => {
    const h = await harness();
    const listing = Promise.withResolvers<ListingAnswer>();
    h.services.listing = listing.promise;
    const flow = h.run();
    h.services.session = "s-2";
    listing.resolve({ _tag: "Listed", rows: h.services.rows });
    await flow;
    expect(h.tui.calls).toEqual([]);
  });
});
