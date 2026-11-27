import { describe, expect, it } from "vitest";

import {
  DOCKED,
  FULL_SCREEN,
  ID_A,
  ID_B,
  ID_C,
  appendText,
  codeOf,
  composeTo,
  confirmTo,
  fire,
  flush,
  type Harness,
  type FakeNode,
  harness,
  itemsOf,
  key,
  linesOf,
  loadUi,
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
  PICKER_FIXED_ROWS,
  PICKER_LABEL_CHROME,
  PICKER_ROW_LIMIT,
  RESIZE_CUES,
  drawCode,
  listLayout,
  LISTING_TEXT,
  resizeText,
  symbolPreset,
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
    expect(listLayout(undefined).fits).toBe(false);
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
    expect(prop(compose.node, "placeholder")).toBe(
      `To ${literal("gamma")}: the message; ⏎ confirms the destination, ⎋ cancels`,
    );
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
    [
      "no item row fits",
      { columns: 100, rows: PICKER_FIXED_ROWS },
      "talk: enlarge the pane to see the session list",
    ],
    [
      "the instance id does not fit",
      { columns: INSTANCE_ID_LENGTH + PICKER_LABEL_CHROME - 1, rows: 30 },
      "talk: enlarge the pane",
    ],
    ["the pane has one row", { columns: 12, rows: 1 }, "enlarge"],
  ])(
    "shows the resize view instead of the list when %s at open, and mounts the list when it fits",
    async (_name, size, text) => {
      const h = await harness();
      h.tui.size = size;
      const flow = h.run();
      await flush();
      // The list ended inside its factory, so omp mounts nothing of it.
      expect(h.tui.views[0]?.closed).toBe(true);
      expect(h.tui.views[0]?.result).toMatchObject({ _tag: "TooSmall" });
      const resize = h.tui.top;
      expect(resize.options).toMatchObject(FULL_SCREEN);
      // One text node, no frame and no chrome; omp's bare sheet centers its one row vertically.
      expect(resize.node.kind).toBe("text");
      expect(Object.keys(resize.node.props).sort()).toEqual(["onKey", "text"]);
      expect(prop(resize.node, "text")).toBe(text);
      // Enter, h, and other keys do nothing.
      for (const id of ["enter", "h", "a"]) expect(press(resize.node, id)).toBe(true);
      await flush();
      expect(h.tui.top).toBe(resize);
      // The pane grows: the view lists again, then ends with the rows, and the flow mounts the list.
      h.tui.size = { columns: 100, rows: 30 };
      prop(resize.node, "text");
      await flush();
      expect(resize.closed).toBe(true);
      expect(resize.result).toMatchObject({ _tag: "Ready" });
      const list = h.tui.top.node;
      expect(list.kind).toBe("picker");
      expect(itemsOf(list)).toHaveLength(2);
      press(list, "escape");
      await flow;
      expect(h.tui.notices).toEqual([]);
      expect(h.services.sends).toEqual([]);
    },
  );

  it.each([
    ["no item row fits", { columns: 100, rows: PICKER_FIXED_ROWS }],
    [
      "the instance id does not fit",
      { columns: INSTANCE_ID_LENGTH + PICKER_LABEL_CHROME - 1, rows: 30 },
    ],
  ])(
    "replaces the open list with the resize view on a resize where %s; the undersized frame reports no empty registry, and Enter and h never act",
    async (_name, size) => {
      const h = await harness();
      const flow = h.run();
      await flush();
      const list = h.tui.top.node;
      const [, beta] = itemsOf(list);
      h.tui.size = size;
      // Enter stops at the view, so the picker widget reports no activate; h does nothing.
      expect(press(list, "enter")).toBe(true);
      fire(list, "onActivate", beta?.id);
      expect(press(list, "h")).toBe(true);
      // The undersized draw: no rows, and neither an empty-state text nor a key hint.
      expect(itemsOf(list)).toEqual([]);
      expect(prop(list, "empty")).toBe("");
      expect(termOf(list)["hint"]).toBeNull();
      await flush();
      expect(h.tui.views[0]?.closed).toBe(true);
      expect(h.tui.views[0]?.result).toMatchObject({ _tag: "TooSmall" });
      const resize = h.tui.top;
      expect(resize.node.kind).toBe("text");
      // alt+t ends the flow from the resize view.
      expect(press(resize.node, "alt+t")).toBe(true);
      await flow;
      expect(resize.result).toEqual({ _tag: "Close" });
      expect(h.tui.notices).toEqual([]);
      expect(h.services.sends).toEqual([]);
      expect(h.services.turns).toEqual([]);
    },
  );

  it.each([
    [100, "talk: enlarge the pane to see the session list"],
    [30, "talk: enlarge the pane"],
    [16, "enlarge the pane"],
    [12, "enlarge"],
    [7, "enlarge"],
    [5, "grow"],
    [4, "grow"],
  ])("fits a whole resize cue to %i columns, never a cut word", async (columns, text) => {
    const ui = await loadUi();
    for (const preset of ["unicode", "ascii"] as const) {
      const shown = resizeText(ui, columns, preset);
      expect(shown).toBe(text);
      expect(RESIZE_CUES[preset]).toContain(shown);
      expect([...shown].length).toBeLessThanOrEqual(columns);
    }
  });

  it.each([
    ["a unicode theme", { symbols: { preset: "unicode" } }, "unicode"],
    ["a nerd theme", { symbols: { preset: "nerd" } }, "nerd"],
    ["an ascii theme", { symbols: { preset: "ascii" } }, "ascii"],
    ["a theme without symbols", {}, "unicode"],
    ["an unknown preset", { symbols: { preset: "emoji" } }, "unicode"],
    ["no theme", undefined, "unicode"],
  ])("reads the symbol preset of %s", (_name, theme, preset) => {
    expect(symbolPreset(theme)).toBe(preset);
  });

  /**
   * The East Asian Width (UAX #11) of the non-ASCII cue characters, from
   * `EastAsianWidth-17.0.0.txt`: `2900..297F ; N` holds `⤢` (U+2922), and
   * `2190..2194 ; A` holds `↔` (U+2194), the arrow that round 8 rejected.
   */
  const EAST_ASIAN_WIDTH: Record<string, "N" | "A"> = { "\u2922": "N", "\u2194": "A" };
  const PRINTABLE_ASCII = /^[\x20-\x7e]$/u;

  /**
   * The cells of `text` by the rules of pi-tui `text/width.ts` v19.2.1
   * (`Bun.stringWidth` with `ambiguousIsNarrow`): one cell for a narrow or
   * neutral character, and two for an ambiguous one when the terminal draws
   * ambiguous characters wide.
   */
  const paintedWidth = (text: string, ambiguousWide: boolean): number =>
    [...text].reduce((cells, character) => {
      if (PRINTABLE_ASCII.test(character)) return cells + 1;
      const width = EAST_ASIAN_WIDTH[character];
      if (width === undefined) throw new Error(`no width data for ${character}`);
      return cells + (width === "A" && ambiguousWide ? 2 : 1);
    }, 0);

  it.each([
    [3, "unicode", "\u2922"],
    [1, "unicode", "\u2922"],
    [3, "nerd", "\u2922"],
    [1, "nerd", "\u2922"],
    [3, "ascii", "<->"],
    [2, "ascii", "+"],
    [1, "ascii", "+"],
  ] as const)(
    "shows a symbol cue in a pane %i columns wide with the %s preset, also where ambiguous characters are wide",
    async (columns, preset, cue) => {
      const ui = await loadUi();
      const shown = resizeText(ui, columns, preset);
      // `⤢` is `cmd.expand` of pi-tui `src/theme/data/symbols.json` v19.2.1; the ascii preset shows only ASCII.
      expect(shown).toBe(cue);
      if (preset === "ascii") expect(shown).toMatch(/^[\x20-\x7e]+$/u);
      expect(paintedWidth(shown, false)).toBeLessThanOrEqual(columns);
      expect(paintedWidth(shown, true)).toBeLessThanOrEqual(columns);
      // The width rules tell the ambiguous arrow apart: it takes two cells there.
      expect(paintedWidth("\u2194", true)).toBe(2);
    },
  );

  it("shows no cue in a pane without a column", async () => {
    const ui = await loadUi();
    for (const preset of ["unicode", "nerd", "ascii"] as const) {
      expect(resizeText(ui, 0, preset)).toBe("");
      expect(resizeText(ui, undefined, preset)).toBe("");
    }
  });

  it.each([
    ["unicode", { symbols: { preset: "unicode" } }, "\u2922", "\u2922"],
    ["ascii", { symbols: { preset: "ascii" } }, "+", "<->"],
  ])(
    "shows the narrow cues of the %s preset that omp gives the factory",
    async (_name, theme, oneColumn, threeColumns) => {
      const h = await harness();
      h.tui.theme = theme;
      h.tui.size = { columns: 1, rows: 1 };
      const flow = h.run();
      await flush();
      const resize = h.tui.top.node;
      expect(resize.kind).toBe("text");
      expect(prop(resize, "text")).toBe(oneColumn);
      h.tui.size = { columns: 3, rows: 1 };
      expect(prop(resize, "text")).toBe(threeColumns);
      h.tui.key("escape");
      await flow;
    },
  );

  /** Shrinks the pane below the open list; the list ends and the resize view mounts. */
  const shrink = async (h: Harness): Promise<FakeNode> => {
    const list = h.tui.top.node;
    h.tui.size = { columns: 100, rows: PICKER_FIXED_ROWS };
    itemsOf(list);
    await flush();
    const resize = h.tui.top.node;
    expect(resize.kind).toBe("text");
    return resize;
  };

  /** Grows the pane under the resize view and draws it, so it lists again. */
  const grow = async (h: Harness, resize: FakeNode): Promise<void> => {
    h.tui.size = { columns: 100, rows: 30 };
    prop(resize, "text");
    await flush();
  };

  it("lists again only when the pane grows, so a peer change while the warning shows reaches the list", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    expect(itemsOf(h.tui.top.node).map((item) => item.label.slice(0, 16))).toEqual([ID_A, ID_B]);
    const listings = h.services.lives.length;
    const resize = await shrink(h);
    // beta ends and gamma registers after the warning mounted; the shrink listed nothing.
    h.services.rows = [row(ID_A, "self", { own: true }), row(ID_C, "gamma")];
    expect(h.services.lives.length).toBe(listings);
    await grow(h, resize);
    expect(h.services.lives.length).toBe(listings + 1);
    const list = h.tui.top.node;
    expect(list.kind).toBe("picker");
    expect(itemsOf(list).map((item) => item.label.slice(0, 16))).toEqual([ID_A, ID_C]);
    press(list, "escape");
    await flow;
  });

  it("selects the same pair again after a shrink and a grow, and the first other row when that pair ended", async () => {
    const h = await harness();
    h.services.rows = [row(ID_A, "self", { own: true }), row(ID_B, "beta"), row(ID_C, "gamma")];
    const flow = h.run();
    await flush();
    const first = h.tui.top.node;
    const gamma = itemsOf(first)[2]?.id;
    fire(first, "onSelect", gamma);
    let resize = await shrink(h);
    await grow(h, resize);
    expect(prop(h.tui.top.node, "selected")).toBe(gamma);
    // gamma ends after the next warning mounted: the list selects beta, the first row of another session.
    resize = await shrink(h);
    h.services.rows = [row(ID_A, "self", { own: true }), row(ID_B, "beta")];
    await grow(h, resize);
    const list = h.tui.top.node;
    expect(prop(list, "selected")).toBe(itemsOf(list)[1]?.id);
    press(list, "escape");
    await flow;
  });

  it("selects a peer that joined before the first visible list, not a pair of the unmounted list", async () => {
    const h = await harness();
    h.services.rows = [row(ID_A, "self", { own: true })];
    h.tui.size = { columns: 100, rows: PICKER_FIXED_ROWS };
    const flow = h.run();
    await flush();
    const resize = h.tui.top.node;
    expect(resize.kind).toBe("text");
    h.services.rows = [row(ID_A, "self", { own: true }), row(ID_B, "beta")];
    await grow(h, resize);
    const list = h.tui.top.node;
    expect(prop(list, "selected")).toBe(itemsOf(list)[1]?.id);
    press(list, "escape");
    await flow;
  });

  it("keeps the resize view focused while the listing after a grow runs; escape ends the flow and its listing, and no list mounts later", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const resize = await shrink(h);
    const listing = Promise.withResolvers<ListingAnswer>();
    h.services.listing = listing.promise;
    await grow(h, resize);
    // The view stays open and focused while the rows are pending.
    expect(h.tui.top.node).toBe(resize);
    expect(prop(resize, "text")).toBe(LISTING_TEXT);
    // A shrink during the listing: the size decides first, so the view shows the cue.
    h.tui.size = { columns: 1, rows: 1 };
    expect(prop(resize, "text")).toBe("\u2922");
    h.tui.size = { columns: 100, rows: 30 };
    expect(prop(resize, "text")).toBe(LISTING_TEXT);
    const life = h.services.lives.at(-1);
    expect(life?.signal.aborted).toBe(false);
    expect(press(resize, "escape")).toBe(true);
    // The key aborts the flow at once, before any yield.
    expect(life?.signal.aborted).toBe(true);
    await flow;
    const views = h.tui.views.length;
    listing.resolve({ _tag: "Listed", rows: h.services.rows });
    await flush();
    expect(h.tui.views).toHaveLength(views);
    expect(h.tui.views.every((view) => view.closed)).toBe(true);
    expect(h.tui.notices).toEqual([]);
  });

  it("ends the flow with the error when the listing after a grow throws at once", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const resize = await shrink(h);
    h.services.listThrow = new Error("the registry broke");
    await grow(h, resize);
    // The view ends with the failure at once; no listing promise is left open.
    expect(h.tui.views.at(-1)?.node).toBe(resize);
    expect(h.tui.views.at(-1)?.closed).toBe(true);
    await flow;
    expect(h.tui.notices).toEqual([{ text: "talk: the registry broke", level: "error" }]);
  });

  it("keeps the list open at the smallest size that fits", async () => {
    const h = await harness();
    h.tui.size = { columns: INSTANCE_ID_LENGTH + PICKER_LABEL_CHROME, rows: PICKER_FIXED_ROWS + 1 };
    const flow = h.run();
    await flush();
    const list = h.tui.top.node;
    expect(itemsOf(list)).toHaveLength(2);
    await flush();
    expect(h.tui.top.node).toBe(list);
    press(list, "escape");
    await flow;
    expect(h.tui.notices).toEqual([]);
  });

  it("flattens each line break of an edit to a space, so the one-line field shows the whole draft (R3)", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const compose = await composeTo(h, ID_B, "a");
    fire(compose, "onEdit", { from: 1, to: 1, text: "\u2028b\r\nc\u2029d\ne", cursor: 9, len: 1 });
    expect(prop(compose, "text")).toBe("a b c d e");
    expect(prop(compose, "cursor")).toBe(9);
    press(compose, "escape");
    await flow;
  });

  /**
   * The empty row that the input painter of omp 19.2.1 draws (`editor.ts`
   * v19.2.1:586-591, 610-618): the caret bar in one cell, then the
   * placeholder flush right only when at least one cell stays free before it.
   * The test cannot import the pinned painter, so it applies the same rule.
   */
  const emptyComposeRow = (placeholder: string, columns: number): string => {
    const gap = columns - 1 - [...placeholder].length;
    return gap >= 1 ? `|${" ".repeat(gap)}${placeholder}` : "|";
  };

  const LONG = "a-long-destination-session-name-for-the-test";

  it.each([
    ["gamma", 100, `To ${literal("gamma")}: the message; ⏎ confirms the destination, ⎋ cancels`],
    ["gamma", 40, `To ${literal("gamma")} · ⏎ confirm · ⎋ cancel`],
    ["gamma", 20, `To ${literal("gamma")}`],
    ["gamma", 8, "To `ga"],
    [LONG, 40, `To \`${LONG}`.slice(0, 38)],
    [LONG, 8, "To `a-"],
  ])(
    "draws the compose placeholder of %s in %i columns, destination first (R6, L2)",
    async (name, columns, placeholder) => {
      const h = await harness();
      h.services.target = {
        _tag: "Resolved",
        destination: { instanceId: ID_C, sessionId: "session-gamma", name, cwd: "/g" },
      };
      const flow = h.run({ _tag: "Compose", target: name });
      await flush();
      const compose = h.tui.top.node;
      h.tui.size = { columns, rows: 30 };
      const shown = String(prop(compose, "placeholder"));
      expect(shown).toBe(placeholder);
      // The painted row holds the whole placeholder, so the operator sees the destination.
      const painted = emptyComposeRow(shown, columns);
      expect([...painted]).toHaveLength(columns);
      expect(painted.endsWith(shown)).toBe(true);
      press(compose, "escape");
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
    // The send runs under a waiting view, so no gap leaves the composer focused (round 7).
    expect(h.tui.calls).toEqual(["custom", "custom", "custom", "custom", "notify"]);
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

  it("keeps a waiting view focused while the send runs; escape ends the flow and shows no notice (round 7)", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.services.sendGate = gate.promise;
    const flow = h.run();
    await flush();
    const confirm = await confirmTo(h, ID_B, "hello");
    typeCode(confirm, codeOf(confirm).code);
    await flush();
    const waiting = h.tui.top;
    expect(waiting.node.kind).toBe("text");
    expect(waiting.options).toMatchObject(DOCKED);
    expect(prop(waiting.node, "text")).toBe(`talk: sending to ${ID_B} · ⎋ stops waiting`);
    expect(press(waiting.node, "enter")).toBe(true);
    const life = h.services.lives.at(-1);
    expect(press(waiting.node, "escape")).toBe(true);
    // The key aborts the flow at once, before any yield.
    expect(life?.signal.aborted).toBe(true);
    await flow;
    gate.resolve();
    await flush();
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

describe("a buffered escape right after a view-changing key (round 8)", () => {
  const GAMMA = { instanceId: ID_C, sessionId: "session-gamma", name: "gamma", cwd: "/g" };

  /** One transition: the flow, the outgoing view, and the input that leads to the next talk view. */
  interface Transition {
    readonly flow: Promise<void>;
    readonly view: FakeNode;
    readonly trigger: () => void;
  }

  it.each<[string, (h: Harness) => Promise<Transition>]>([
    [
      "activate in the list, to compose",
      async (h) => {
        const flow = h.run();
        await flush();
        const view = h.tui.top.node;
        return { flow, view, trigger: () => fire(view, "onActivate", itemsOf(view)[1]?.id) };
      },
    ],
    [
      "h in the list, to the waiting view of the side turn",
      async (h) => {
        const flow = h.run();
        await flush();
        const view = h.tui.top.node;
        return { flow, view, trigger: () => h.tui.key("h") };
      },
    ],
    [
      "enter in compose, to the confirm view",
      async (h) => {
        const flow = h.run();
        await flush();
        const view = await composeTo(h, ID_B, "hello");
        return { flow, view, trigger: () => h.tui.key("enter") };
      },
    ],
    [
      "the last code letter, to the waiting view of the send",
      async (h) => {
        const flow = h.run();
        await flush();
        const view = await confirmTo(h, ID_B, "hello");
        const { code } = codeOf(view);
        h.tui.key(code.charAt(0));
        return { flow, view, trigger: () => h.tui.key(code.charAt(1)) };
      },
    ],
    [
      "escape in the confirm view, back to compose",
      async (h) => {
        const flow = h.run();
        await flush();
        const view = await confirmTo(h, ID_B, "hello");
        return { flow, view, trigger: () => h.tui.key("escape") };
      },
    ],
    [
      "ctrl+s in the handover review, to the confirm view",
      async (h) => {
        h.services.target = { _tag: "Resolved", destination: GAMMA };
        const flow = h.run({ _tag: "Handover", target: "gamma" });
        await flush();
        const view = h.tui.top.node;
        expect(view.kind).toBe("editor");
        return { flow, view, trigger: () => h.tui.key("ctrl+s") };
      },
    ],
  ])(
    "keeps the outgoing view focused after %s, and a buffered escape ends the flow there",
    async (_name, open) => {
      const h = await harness();
      const { flow, view, trigger } = await open(h);
      expect(h.tui.focused?.node).toBe(view);
      const signal = h.services.lives[0]?.signal;
      const mounted = h.tui.views.length;
      const notices = h.tui.notices.length;
      trigger();
      // No microtask ran: omp routes the next key to its focused node, which must be the outgoing view.
      const consumed = h.tui.key("escape");
      expect(h.tui.composerInput).toEqual([]);
      expect(consumed).toBe(true);
      expect(signal?.aborted).toBe(true);
      await flow;
      await flush();
      // The flow ended before the next talk view mounted; nothing went out, and the composer has the focus again.
      expect(h.tui.views).toHaveLength(mounted);
      expect(h.tui.views.every((candidate) => candidate.closed)).toBe(true);
      expect(h.tui.focused).toBeUndefined();
      expect(h.services.sends).toEqual([]);
      expect(h.tui.notices).toHaveLength(notices);
    },
  );

  it("keeps the text at enter in compose: a paste and an edit after the key change neither the held view nor the send (round 9)", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const compose = await composeTo(h, ID_B, "hello");
    // The open field takes a paste through its widget.
    h.tui.paste(" there");
    expect(h.tui.widgetPastes).toEqual([" there"]);
    expect(prop(compose, "text")).toBe("hello there");
    h.tui.key("enter");
    // omp routes a paste of the same input read to the held view: the view takes it before the widget.
    h.tui.paste(" pasted");
    expect(h.tui.widgetPastes).toEqual([" there"]);
    expect(prop(compose, "text")).toBe("hello there");
    // Tern can report an edit to the held view directly: the view ignores it.
    appendText(compose, " typed");
    expect(prop(compose, "text")).toBe("hello there");
    expect(h.tui.composerInput).toEqual([]);
    await flush();
    const confirm = h.tui.top.node;
    expect(linesOf(confirm)).toContain("Text: hello there");
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends.map((sent) => sent.text)).toEqual(["hello there"]);
  });
});
