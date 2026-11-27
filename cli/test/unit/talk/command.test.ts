import { describe, expect, it } from "vitest";

import {
  DOCKED,
  FULL_SCREEN,
  ID_A,
  ID_B,
  ID_C,
  codeOf,
  composeTo,
  confirmTo,
  fire,
  flush,
  harness,
  itemsOf,
  key,
  linesOf,
  press,
  prop,
  row,
  termOf,
  typeCode,
} from "../../lib/talkFlowHost";
import { literal } from "../../../talk/tool/attachments";
import { type ListingAnswer, parseTalkArgs, talkCompletions } from "../../../talk/ui/command";
import {
  CONFIRM_TOO_SMALL,
  INSTANCE_ID_LENGTH,
  LIST_TOO_SMALL,
  PICKER_EMPTY_FRAME_ROWS,
  PICKER_FIXED_ROWS,
  PICKER_LABEL_CHROME,
  PICKER_ROW_LIMIT,
  composePlaceholder,
  drawCode,
  listLayout,
} from "../../../talk/ui/views";

// The `/talk` flows of plan #251 G2 and G3 against the fake TUI host of
// `cli/test/lib/talkFlowHost.ts`. The handover flows are in `handover.test.ts`.

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
      framed: true,
    });
    expect(listLayout({ columns: 80, rows: 8 })).toEqual({
      maxRows: 8 - PICKER_FIXED_ROWS,
      fits: true,
      framed: true,
    });
    expect(listLayout({ columns: 80, rows: PICKER_FIXED_ROWS + 1 })).toEqual({
      maxRows: 1,
      fits: true,
      framed: true,
    });
    expect(listLayout({ columns: 80, rows: PICKER_FIXED_ROWS }).fits).toBe(false);
    expect(listLayout({ columns: 80, rows: PICKER_EMPTY_FRAME_ROWS }).framed).toBe(true);
    expect(listLayout({ columns: 80, rows: PICKER_EMPTY_FRAME_ROWS - 1 }).framed).toBe(false);
    expect(listLayout(undefined).framed).toBe(false);
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
    expect(view.options).toMatchObject(FULL_SCREEN);
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
    expect(compose.options).toMatchObject(DOCKED);
    // C3: no prompt shifts the caret; the placeholder names the destination.
    expect(prop(compose.node, "prompt")).toBeUndefined();
    expect(prop(compose.node, "placeholder")).toBe(composePlaceholder(row(ID_C, "gamma")));
    expect(prop(compose.node, "placeholder")).toContain(literal("gamma"));
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

  it.each([1, PICKER_EMPTY_FRAME_ROWS - 1])(
    "puts the request for a larger pane in the top border of a %i-row pane, the first row that omp keeps (S10)",
    async (rows) => {
      const h = await harness();
      const flow = h.run();
      await flush();
      const list = h.tui.top.node;
      h.tui.size = { columns: 100, rows };
      expect(termOf(list)["title"]).toBe(LIST_TOO_SMALL);
      // A pane with room for the empty frame shows the request as the empty text.
      h.tui.size = { columns: 100, rows: PICKER_EMPTY_FRAME_ROWS };
      expect(termOf(list)["title"]).toBeNull();
      expect(prop(list, "empty")).toBe(LIST_TOO_SMALL);
      press(list, "escape");
      await flow;
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
      { pair: { instanceId: ID_C, sessionId: "session-shared" }, text: "hello", kind: "message" },
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
    expect(view.options).toMatchObject(FULL_SCREEN);
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
      {
        pair: { instanceId: ID_B, sessionId: "session-beta-0001" },
        text: "hello there",
        kind: "message",
      },
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
      {
        pair: { instanceId: ID_B, sessionId: "session-beta-0001" },
        text: "keep me",
        kind: "message",
      },
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
    // T1: an edit loses its escape sequences and control characters; the caret goes to its end.
    fire(compose, "onEdit", { from: 3, to: 3, text: "a\u001b[2Jb\u0007", cursor: 9, len: 3 });
    expect(prop(compose, "text")).toBe("   ab");
    expect(prop(compose, "cursor")).toBe(5);
    press(compose, "escape");
    await flow;
  });
});

describe("/talk <target> (G2)", () => {
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
      { pair: { instanceId: ID_C, sessionId: "session-gamma" }, text: "hi", kind: "message" },
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

  it("gives each listing and send the flow's life, whose signal aborts when the flow ends (C1)", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.lives).toHaveLength(2);
    const [listing, send] = h.services.lives;
    expect(listing).toBe(send);
    expect(send?.signal.aborted).toBe(true);
    expect(send?.live()).toBe(false);
  });

  it("posts no notice when the flow ends while its send runs (C1, T2)", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.services.sendGate = gate.promise;
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    typeCode(confirm, codeOf(confirm).code);
    await flush();
    expect(h.services.sends).toHaveLength(1);
    const life = h.services.lives.at(-1);
    expect(life?.live()).toBe(true);
    h.slot.end();
    expect(life?.signal.aborted).toBe(true);
    expect(life?.live()).toBe(false);
    gate.resolve();
    await flow;
    expect(h.tui.notices).toEqual([]);
  });

  it.each([
    ["compose", false],
    ["the list", true],
  ] as const)(
    "cancels %s at the next check when omp closed its overlay without done (C2)",
    async (name, list) => {
      const h = await harness();
      const flow = h.run();
      await flush();
      if (!list) await composeTo(h, ID_B, "draft");
      const view = h.tui.top;
      expect(view.node.kind).toBe(name === "compose" ? "input" : "picker");
      h.slot.check();
      expect(view.closed).toBe(false);
      view.hostClose();
      h.slot.check();
      // The view settles at once, so the flow ends without a key.
      expect(view.closed).toBe(true);
      await flow;
      expect(view.result).toEqual(list ? { _tag: "Close" } : { _tag: "Cancel" });
      expect(h.services.sends).toEqual([]);
      expect(h.tui.notices).toEqual([]);
    },
  );
});
