import { describe, expect, it } from "vitest";

import {
  DRAFT,
  FULL_SCREEN,
  type FakeNode,
  type Harness,
  ID_B,
  ID_C,
  codeOf,
  fire,
  flush,
  harness,
  itemsOf,
  linesOf,
  press,
  pressRaw,
  prop,
  termOf,
  typeCode,
} from "../../lib/talkFlowHost";
import { literal } from "../../../talk/tool/attachments";
import {
  HANDOVER_CUT_LINE,
  HANDOVER_EMPTY,
  HANDOVER_NO_SIDE_TURN,
  HANDOVER_PROMPT,
  HANDOVER_STARTED,
  MAX_HANDOVER_BYTES,
  OMP_CUT_MARK,
} from "../../../talk/ui/handover";

// The handover flows of plan #251 G6 against the fake TUI host of
// `cli/test/lib/talkFlowHost.ts`: `/talk handover <target>`, the
// handover-mode list, and `h` in the normal list. The fake side turn records
// each request and answers with `DRAFT`.

const GAMMA = { instanceId: ID_C, sessionId: "session-gamma", name: "gamma", cwd: "/g" };
const GAMMA_PAIR = { instanceId: ID_C, sessionId: "session-gamma" };

/**
 * Starts `/talk handover gamma` with a target that resolves to gamma, and
 * lets the flow run up to its first wait. The flow promise is in an object,
 * so the caller does not wait for the end of the flow.
 */
const handoverToGamma = async (h: Harness): Promise<{ readonly flow: Promise<void> }> => {
  h.services.target = { _tag: "Resolved", destination: GAMMA };
  const flow = h.run({ _tag: "Handover", target: "gamma" });
  await flush();
  return { flow };
};

/** The open review view: an editor root. */
const reviewOf = (h: Harness): FakeNode => {
  const review = h.tui.top.node;
  expect(review.kind).toBe("editor");
  return review;
};

/** Replaces the whole text of an editor with `text`. */
const replaceText = (node: FakeNode, text: string): void => {
  const before = prop(node, "text");
  const length = typeof before === "string" ? before.length : 0;
  fire(node, "onEdit", { from: 0, to: length, text, cursor: text.length, len: length });
};

describe("handover template (G6)", () => {
  it("asks for the five sections, from this session's view, within a UTF-8 byte budget under omp's 4 KiB cap (C8, S9)", () => {
    for (const section of ["Next task", "Decisions", "Files", "Current state", "Risks"])
      expect(HANDOVER_PROMPT).toContain(`## ${section}`);
    expect(HANDOVER_PROMPT).toContain("this session");
    // The budget counts UTF-8 bytes, as omp's cap does, not characters.
    expect(HANDOVER_PROMPT).toContain("under 3500 bytes of UTF-8 text");
    expect(HANDOVER_PROMPT).toContain("above 4096 bytes");
    expect(HANDOVER_PROMPT).not.toMatch(/3500 characters/u);
    expect(new TextEncoder().encode(HANDOVER_PROMPT).byteLength).toBeLessThanOrEqual(
      MAX_HANDOVER_BYTES,
    );
  });
});

describe("/talk handover <target> (G2, G6)", () => {
  it("requests the template with the flow's signal and without maxTokens or tools, then opens the review", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    expect(h.services.targets).toEqual(["gamma"]);
    expect(h.services.turns).toHaveLength(1);
    const [request] = h.services.turns;
    expect(Object.keys(request ?? {}).sort()).toEqual(["promptText", "signal"]);
    expect(request?.promptText).toBe(HANDOVER_PROMPT);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.signal.aborted).toBe(false);
    expect(h.tui.notices).toEqual([{ text: HANDOVER_STARTED, level: "info" }]);
    const review = reviewOf(h);
    // C4: a full-screen overlay, so the review owns the rows that `ui.size()` reports.
    expect(h.tui.top.options).toMatchObject(FULL_SCREEN);
    expect(prop(review, "maxLines")).toBe(h.tui.size.rows);
    h.tui.size = { columns: 100, rows: 5 };
    expect(prop(review, "maxLines")).toBe(5);
    expect(prop(review, "text")).toBe(DRAFT);
    expect(prop(review, "cursor")).toBe(0);
    press(review, "escape");
    await flow;
    // The flow ended, so its signal is aborted; nothing was sent.
    expect(request?.signal.aborted).toBe(true);
    expect(h.services.sends).toEqual([]);
  });

  it("reviews, edits, approves with ctrl+s, confirms the code, and sends a handover to the exact pair", async () => {
    const h = await harness();
    h.services.answer = {
      ok: true,
      text: `Delivered: the message is in the session.\nInstance: ${ID_C}`,
    };
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    replaceText(review, "## Next task\nShip the fix.");
    // enter from `\r` adds nothing and stays in the review.
    expect(pressRaw(review, "enter", "\r")).toBe(true);
    // ctrl+j, alt+enter, and shift+enter reach the editor widget, which adds a line.
    expect(pressRaw(review, "enter", "\n")).toBe(false);
    expect(press(review, "alt+enter")).toBe(false);
    expect(press(review, "shift+enter")).toBe(false);
    expect(press(review, "a")).toBe(false);
    await flush();
    expect(h.tui.top.node).toBe(review);
    expect(h.services.sends).toEqual([]);
    expect(press(review, "ctrl+s")).toBe(true);
    await flush();
    const confirm = h.tui.top.node;
    expect(h.tui.top.options).toMatchObject(FULL_SCREEN);
    const { instanceId, code } = codeOf(confirm);
    expect(instanceId).toBe(ID_C);
    expect(linesOf(confirm).slice(1, 4)).toEqual([
      `${literal("gamma")} · ${literal("/g")}`,
      "Kind: handover",
      "Text: ## Next task",
    ]);
    expect(h.services.sends).toEqual([]);
    typeCode(confirm, code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: GAMMA_PAIR, text: "## Next task\nShip the fix.", kind: "handover" },
    ]);
    expect(h.tui.notices).toEqual([
      { text: HANDOVER_STARTED, level: "info" },
      { text: h.services.answer.text, level: "info" },
    ]);
    expect(h.tui.calls).toEqual(["notify", "custom", "custom", "notify"]);
  });

  it("returns from the confirm view to the review with the edited text kept", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    replaceText(reviewOf(h), "edited");
    press(h.tui.top.node, "ctrl+s");
    await flush();
    const firstCode = codeOf(h.tui.top.node).code;
    press(h.tui.top.node, "escape");
    await flush();
    const review = reviewOf(h);
    expect(prop(review, "text")).toBe("edited");
    press(review, "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(codeOf(confirm).code).not.toBe(firstCode);
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([{ pair: GAMMA_PAIR, text: "edited", kind: "handover" }]);
    // The side turn ran once.
    expect(h.services.turns).toHaveLength(1);
  });

  it("keeps the review open on ctrl+s without text, and ignores a stale edit", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    replaceText(review, "  \n ");
    expect(press(review, "ctrl+s")).toBe(true);
    await flush();
    expect(h.tui.top.node).toBe(review);
    fire(review, "onEdit", { from: 0, to: 0, text: "x", cursor: 1, len: 99 });
    expect(prop(review, "text")).toBe("  \n ");
    press(review, "escape");
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it("does not approve while no editable row fits the screen (C4)", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    h.tui.size = { columns: 100, rows: 0 };
    expect(press(review, "ctrl+s")).toBe(true);
    await flush();
    expect(h.tui.top.node).toBe(review);
    h.tui.size = { columns: 100, rows: 1 };
    press(review, "ctrl+s");
    await flush();
    expect(h.tui.top.node.kind).toBe("col");
    press(h.tui.top.node, "alt+t");
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it("cleans escape sequences and control characters from the draft and each edit, and sends exactly the reviewed text (T1)", async () => {
    const h = await harness();
    h.services.reply = () =>
      Promise.resolve({
        replyText:
          "## Next\u001b]52;c;ZXZpbA==\u0007 task\r\nShip\u009b31m it\u001b[2J.\u0000\n\tDone.",
      });
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    expect(prop(review, "text")).toBe("## Next task\nShip it.\n\tDone.");
    const length = String(prop(review, "text")).length;
    fire(review, "onEdit", {
      from: length,
      to: length,
      text: "\u001b[31m!\u001b[0m",
      cursor: length + 10,
      len: length,
    });
    expect(prop(review, "text")).toBe("## Next task\nShip it.\n\tDone.!");
    expect(prop(review, "cursor")).toBe(length + 1);
    press(review, "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: GAMMA_PAIR, text: "## Next task\nShip it.\n\tDone.!", kind: "handover" },
    ]);
  });

  it("shows a line that says omp cut the draft in place of omp's mark (C8, S9)", async () => {
    const h = await harness();
    h.services.reply = () => Promise.resolve({ replyText: `## Next task\nShip${OMP_CUT_MARK}` });
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    expect(prop(review, "text")).toBe(`## Next task\nShip\n${HANDOVER_CUT_LINE}`);
    press(review, "escape");
    await flow;
  });

  it.each([
    ["blank", "   "],
    ["only an escape sequence", "\u001b[2J"],
  ])(
    "refuses a cut reply whose kept part is %s, and opens no review with omp's raw mark (R5)",
    async (_name, kept) => {
      const h = await harness();
      h.services.reply = () => Promise.resolve({ replyText: `${kept}${OMP_CUT_MARK}` });
      const { flow } = await handoverToGamma(h);
      // No review mounts, so the flow ends without a key.
      expect(h.tui.calls).toEqual(["notify", "notify"]);
      await flow;
      expect(h.tui.notices.at(-1)).toEqual({ text: HANDOVER_EMPTY, level: "error" });
      expect(h.services.sends).toEqual([]);
    },
  );

  it("finds omp's mark before the cleaner, also when the kept part ends in an escape sequence and spaces (R5)", async () => {
    const h = await harness();
    h.services.reply = () =>
      Promise.resolve({ replyText: `## Next task\nShip\u001b[0m  \t${OMP_CUT_MARK}` });
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    expect(prop(review, "text")).toBe(`## Next task\nShip\n${HANDOVER_CUT_LINE}`);
    press(review, "escape");
    await flow;
  });

  it.each(["escape", "alt+t"])("cancels the review on %s and sends nothing", async (id) => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    expect(press(reviewOf(h), id)).toBe(true);
    await flow;
    expect(h.tui.views.at(-1)?.result).toEqual({ _tag: "Cancel" });
    expect(h.services.sends).toEqual([]);
    expect(h.tui.notices).toEqual([{ text: HANDOVER_STARTED, level: "info" }]);
  });

  it("closes the flow from the confirm view on alt+t and sends nothing", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    press(reviewOf(h), "ctrl+s");
    await flush();
    press(h.tui.top.node, "alt+t");
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it("shows a failed send as an error notice", async () => {
    const h = await harness();
    h.services.answer = { ok: false, text: "talk: Not live: the session ended or moved." };
    const { flow } = await handoverToGamma(h);
    press(reviewOf(h), "ctrl+s");
    await flush();
    typeCode(h.tui.top.node, codeOf(h.tui.top.node).code);
    await flow;
    expect(h.tui.notices.at(-1)).toEqual({ text: h.services.answer.text, level: "error" });
  });

  it("reports a target that does not resolve before any side turn", async () => {
    const h = await harness();
    await h.run({ _tag: "Handover", target: "x" });
    expect(h.services.turns).toEqual([]);
    expect(h.tui.calls).toEqual(["notify"]);
    expect(h.tui.notices[0]?.level).toBe("error");
  });
});

describe("handover errors (G6)", () => {
  const failsWith = async (
    setup: (h: Harness) => void,
    text: string | RegExp,
  ): Promise<Harness> => {
    const h = await harness();
    setup(h);
    const { flow } = await handoverToGamma(h);
    await flow;
    expect(h.services.sends).toEqual([]);
    expect(h.tui.views).toEqual([]);
    const last = h.tui.notices.at(-1);
    expect(last?.level).toBe("error");
    if (typeof text === "string") expect(last?.text).toBe(text);
    else expect(last?.text).toMatch(text);
    return h;
  };

  it("shows a notice and sends nothing when the host has no runEphemeralTurn", async () => {
    const h = await failsWith((setup) => {
      setup.services.sideTurn = undefined;
    }, HANDOVER_NO_SIDE_TURN);
    expect(h.tui.calls).toEqual(["notify"]);
  });

  it("shows the host error of a rejected side turn and sends nothing", async () => {
    await failsWith((h) => {
      h.services.reply = () => Promise.reject(new Error("the model is not available"));
    }, /^talk: .*the model is not available/u);
  });

  it("shows the host error of a side turn that throws at once", async () => {
    await failsWith((h) => {
      h.services.sideTurn = () => {
        throw new Error("nested side turn");
      };
    }, /^talk: .*nested side turn/u);
  });

  it.each([
    ["an empty reply", { replyText: "" }],
    ["a blank reply", { replyText: " \n\t " }],
    ["a reply without text", {}],
    ["no reply object", undefined],
  ])("shows a notice for %s and sends nothing", async (_name, reply) => {
    await failsWith((h) => {
      h.services.reply = () => Promise.resolve(reply);
    }, HANDOVER_EMPTY);
  });
});

describe("handover-mode list and h (G2, G6)", () => {
  it("opens the list in handover mode for /talk handover, and activate starts handover, not compose", async () => {
    const h = await harness();
    const flow = h.run({ _tag: "Handover", target: undefined });
    await flush();
    const list = h.tui.top.node;
    expect(list.kind).toBe("picker");
    expect(h.tui.top.options).toMatchObject(FULL_SCREEN);
    expect(String(termOf(list)["hint"])).toContain("hand over");
    expect(h.services.turns).toEqual([]);
    const beta = itemsOf(list).find((item) => item.label.startsWith(ID_B));
    fire(list, "onActivate", beta?.id);
    await flush();
    expect(h.services.turns).toHaveLength(1);
    const review = reviewOf(h);
    press(review, "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(codeOf(confirm).instanceId).toBe(ID_B);
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: { instanceId: ID_B, sessionId: "session-beta-0001" }, text: DRAFT, kind: "handover" },
    ]);
  });

  it("starts handover for the selected row on h in the normal list", async () => {
    const h = await harness();
    const flow = h.run();
    await flush();
    const list = h.tui.top.node;
    expect(String(termOf(list)["hint"])).toContain("h handover");
    expect(press(list, "h")).toBe(true);
    await flush();
    expect(h.tui.views[0]?.result).toMatchObject({ _tag: "Handover", row: { instanceId: ID_B } });
    expect(h.services.turns).toHaveLength(1);
    press(reviewOf(h), "ctrl+s");
    await flush();
    expect(codeOf(h.tui.top.node).instanceId).toBe(ID_B);
    press(h.tui.top.node, "alt+t");
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it("starts nothing from the handover-mode list on escape", async () => {
    const h = await harness();
    const flow = h.run({ _tag: "Handover", target: undefined });
    await flush();
    press(h.tui.top.node, "escape");
    await flow;
    expect(h.services.turns).toEqual([]);
    expect(h.tui.calls).toEqual(["custom"]);
  });
});

describe("handover flow end during the side turn (G3, G6)", () => {
  /** Starts a handover whose side turn waits; returns the pending reply. */
  const pending = async (
    h: Harness,
  ): Promise<{
    readonly flow: Promise<void>;
    readonly reply: {
      readonly resolve: (value: unknown) => void;
      readonly reject: (reason: unknown) => void;
    };
    readonly signal: AbortSignal;
  }> => {
    const reply = Promise.withResolvers<unknown>();
    h.services.reply = () => reply.promise;
    const { flow } = await handoverToGamma(h);
    const signal = h.services.turns[0]?.signal;
    if (signal === undefined) throw new Error("no side turn");
    expect(h.tui.views).toEqual([]);
    return { flow, reply, signal };
  };

  it.each([
    [
      "a second flow",
      (h: Harness): Promise<void> => {
        const second = h.run();
        return flush().then(() => {
          press(h.tui.top.node, "escape");
          return second;
        });
      },
    ],
    [
      "the end of the flow (session_clear, a transition, or shutdown)",
      (h: Harness): Promise<void> => {
        h.slot.end();
        return Promise.resolve();
      },
    ],
    [
      "a session switch that check sees",
      (h: Harness): Promise<void> => {
        h.services.session = "s-2";
        h.slot.check();
        return Promise.resolve();
      },
    ],
  ])(
    "aborts the side turn on %s, and no review mounts when the reply arrives",
    async (_name, end) => {
      const h = await harness();
      const { flow, reply, signal } = await pending(h);
      await end(h);
      expect(signal.aborted).toBe(true);
      await flow;
      const views = h.tui.views.length;
      reply.resolve({ replyText: DRAFT });
      await flush();
      expect(h.tui.views).toHaveLength(views);
      expect(h.tui.views.every((view) => view.node.kind !== "editor")).toBe(true);
      expect(h.services.sends).toEqual([]);
      expect(h.tui.notices).toEqual([{ text: HANDOVER_STARTED, level: "info" }]);
    },
  );

  it("mounts no review when the session id changed before the reply arrived", async () => {
    const h = await harness();
    const { flow, reply } = await pending(h);
    h.services.session = "s-2";
    reply.resolve({ replyText: DRAFT });
    await flow;
    expect(h.tui.views).toEqual([]);
    expect(h.services.sends).toEqual([]);
  });

  it("shows no error for a side turn that rejects because the flow ended", async () => {
    const h = await harness();
    const { flow, reply } = await pending(h);
    h.slot.end();
    reply.reject(new Error("aborted"));
    await flow;
    await flush();
    expect(h.tui.notices).toEqual([{ text: HANDOVER_STARTED, level: "info" }]);
  });
});
