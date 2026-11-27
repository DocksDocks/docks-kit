import { describe, expect, it } from "vitest";

import {
  DRAFT,
  FULL_SCREEN,
  type FakeNode,
  type Harness,
  ID_B,
  ID_C,
  appendText,
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
import type { FlowEnd } from "../../../talk/tool/tool";
import {
  HANDOVER_CUT_LINE,
  HANDOVER_EMPTY,
  HANDOVER_NO_SIDE_TURN,
  HANDOVER_PROMPT,
  HANDOVER_STARTED,
  MAX_HANDOVER_BYTES,
  OMP_CUT_MARK,
  agentHandoverWaiting,
  safeDiagnostic,
} from "../../../talk/ui/handover";
import {
  HANDOVER_TARGET_IS_THIS_SESSION,
  HANDOVER_WAITING,
  sendingText,
} from "../../../talk/ui/command";
import { CONFIRM_TOO_SMALL } from "../../../talk/ui/views";

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
const handoverToGamma = async (h: Harness): Promise<{ readonly flow: Promise<FlowEnd> }> => {
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
    // The side turn and the send each run under a waiting view: no gap leaves the composer focused.
    expect(h.tui.calls).toEqual(["notify", "custom", "custom", "custom", "custom", "notify"]);
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

  it("keeps the text at ctrl+s: a paste and an edit after the key change neither the held review, the review after escape, nor the send (round 9)", async () => {
    const h = await harness();
    const { flow } = await handoverToGamma(h);
    const review = reviewOf(h);
    replaceText(review, "reviewed");
    // The open field takes a paste at the caret through its widget.
    h.tui.paste(" text");
    expect(h.tui.widgetPastes).toEqual([" text"]);
    expect(prop(review, "text")).toBe("reviewed text");
    h.tui.key("ctrl+s");
    // omp routes a paste of the same input read to the held review: the view takes it before the widget.
    h.tui.paste(" pasted");
    expect(h.tui.widgetPastes).toEqual([" text"]);
    expect(prop(review, "text")).toBe("reviewed text");
    // Tern can report an edit to the held review directly: the view ignores it.
    appendText(review, " typed");
    expect(prop(review, "text")).toBe("reviewed text");
    expect(h.tui.composerInput).toEqual([]);
    await flush();
    // escape in the confirm view returns to the review with the text at ctrl+s.
    h.tui.key("escape");
    await flush();
    expect(prop(reviewOf(h), "text")).toBe("reviewed text");
    h.tui.key("ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(linesOf(confirm)).toContain("Text: reviewed text");
    typeCode(confirm, codeOf(confirm).code);
    await flow;
    expect(h.services.sends).toEqual([
      { pair: GAMMA_PAIR, text: "reviewed text", kind: "handover" },
    ]);
    expect(h.tui.composerInput).toEqual([]);
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
      expect(h.tui.calls).toEqual(["notify", "custom", "notify"]);
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
    // No review: at most the waiting view of the side turn mounted, and it closed.
    expect(h.tui.views.every((view) => view.node.kind === "text" && view.closed)).toBe(true);
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
    readonly flow: Promise<FlowEnd>;
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
    // The waiting view holds the focus while the side turn runs.
    expect(h.tui.views.map((view) => view.node.kind)).toEqual(["text"]);
    expect(prop(h.tui.top.node, "text")).toBe(HANDOVER_WAITING);
    return { flow, reply, signal };
  };

  it.each([
    [
      "a second flow",
      (h: Harness): Promise<unknown> => {
        const second = h.run();
        return flush().then(() => {
          press(h.tui.top.node, "escape");
          return second;
        });
      },
    ],
    [
      "the end of the flow (session_clear, a transition, or shutdown)",
      (h: Harness): Promise<unknown> => {
        h.slot.end();
        return Promise.resolve();
      },
    ],
    [
      "a session switch that check sees",
      (h: Harness): Promise<unknown> => {
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
    expect(h.tui.views.every((view) => view.node.kind !== "editor")).toBe(true);
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

  it("ends the flow and aborts the side turn on escape in its waiting view, and no review mounts later (round 7)", async () => {
    const h = await harness();
    const { flow, reply, signal } = await pending(h);
    expect(press(h.tui.top.node, "a")).toBe(true);
    expect(press(h.tui.top.node, "escape")).toBe(true);
    // The key aborts the flow and the side turn at once, before any yield.
    expect(signal.aborted).toBe(true);
    await flow;
    reply.resolve({ replyText: DRAFT });
    await flush();
    expect(h.tui.views.map((view) => view.node.kind)).toEqual(["text"]);
    expect(h.services.sends).toEqual([]);
  });
});

describe("agent-started handover (#260 H2, H4, H5)", () => {
  /** The note of the agent: a line break as CRLF, an escape sequence, and a bell. */
  const NOTE = "Please \u001b[31mtake\u001b[0m over.\r\nThanks\u0007";
  const CLEAN_NOTE = "Please take over.\nThanks";

  /**
   * Starts the handover of the `talk` tool to gamma and lets it run up to
   * its first wait. `note.text` is the note of the agent; an undefined text
   * gives no note. `ended` gives the end of the flow once it came.
   */
  const agentHandover = async (
    h: Harness,
    signal?: AbortSignal,
    note: { readonly text: string | undefined } = { text: NOTE },
    isOwn: () => boolean = () => false,
  ): Promise<{ readonly flow: Promise<FlowEnd>; readonly ended: () => FlowEnd | undefined }> => {
    const state: { end: FlowEnd | undefined } = { end: undefined };
    const flow = h
      .run({ _tag: "AgentHandover", destination: GAMMA, note: note.text, isOwn }, signal)
      .then((end) => {
        state.end = end;
        return end;
      });
    await flush();
    return { flow, ended: () => state.end };
  };

  /** The first line of the confirm view of a handover to gamma that the `talk` tool started. */
  const AGENT_LINE = new RegExp(
    `^Send to ${ID_C} \\(a handover that the agent started\\): type ([a-z]{2})$`,
    "u",
  );

  /** The code of a confirm view whose first line names gamma and the agent as the starter. */
  const agentCode = (node: FakeNode): string => {
    const match = AGENT_LINE.exec(linesOf(node)[0] ?? "");
    if (match === null)
      throw new Error(`no agent confirm line in ${JSON.stringify(linesOf(node))}`);
    return match[1] ?? "";
  };

  /** `ctrl+s` in the review, then the code in the confirm view. */
  const approve = async (h: Harness): Promise<void> => {
    press(reviewOf(h), "ctrl+s");
    await flush();
    typeCode(h.tui.top.node, agentCode(h.tui.top.node));
  };

  it("names the agent and the target in the waiting view and in the first line of the confirm view, shows no notice, and starts the review with the cleaned note and the draft alone", async () => {
    const h = await harness();
    const reply = Promise.withResolvers<unknown>();
    h.services.reply = () => reply.promise;
    const { flow } = await agentHandover(h);
    // The destination is exact: the flow resolves nothing.
    expect(h.services.targets).toEqual([]);
    expect(h.services.turns.map((turn) => turn.promptText)).toEqual([HANDOVER_PROMPT]);
    const waiting = agentHandoverWaiting(GAMMA);
    expect(waiting).toBe(`talk: agent handover to ${literal("gamma")} (${ID_C}) · ⎋ cancels`);
    expect(prop(h.tui.top.node, "text")).toBe(waiting);
    reply.resolve({ replyText: DRAFT });
    await flush();
    const review = reviewOf(h);
    // The editor holds only text that can be sent: no row of talk's own.
    expect(prop(review, "text")).toBe(`${CLEAN_NOTE}\n\n${DRAFT}`);
    expect(prop(review, "cursor")).toBe(0);
    // omp shows a notice only after the tool call ends, so the tool path shows none.
    expect(h.tui.notices).toEqual([]);
    press(review, "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(linesOf(confirm)[0]).toBe(
      `Send to ${ID_C} (a handover that the agent started): type ${agentCode(confirm)}`,
    );
    press(confirm, "escape");
    await flush();
    press(reviewOf(h), "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.services.sends).toEqual([]);
  });

  it("cleans the name of the target in the waiting view as the views clean names", () => {
    const evil = { ...GAMMA, name: "ga\u001b[31m\nmma`" };
    const text = agentHandoverWaiting(evil);
    expect(text).toContain(literal("ga\u001b[31m\nmma`"));
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\n");
  });

  it.each([
    ["no note", undefined],
    ["a note with only blanks and controls", " \u001b[2J \r\n\t"],
  ])("starts the review with the draft alone for %s", async (_name, note) => {
    const h = await harness();
    const { flow } = await agentHandover(h, undefined, { text: note });
    expect(prop(reviewOf(h), "text")).toBe(DRAFT);
    press(reviewOf(h), "escape");
    await flow;
  });

  it("sends exactly what the editor holds after select all and a paste", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h);
    const review = reviewOf(h);
    // omp's editor selects from offset 0, and a paste replaces the selection.
    const length = String(prop(review, "text")).length;
    fire(review, "onEdit", { from: 0, to: length, text: "Pasted.", cursor: 7, len: length });
    expect(prop(review, "text")).toBe("Pasted.");
    await approve(h);
    await flow;
    expect(h.services.sends).toEqual([{ pair: GAMMA_PAIR, text: "Pasted.", kind: "handover" }]);
  });

  it("sends exactly what the editor holds after a cut of the first line and a yank at the end", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h, undefined, { text: undefined });
    const review = reviewOf(h);
    const cut = "## Next task\n";
    fire(review, "onEdit", { from: 0, to: cut.length, text: "", cursor: 0, len: DRAFT.length });
    const rest = DRAFT.slice(cut.length);
    expect(prop(review, "text")).toBe(rest);
    // The yank inserts the cut text at the caret; the caret moved to the end first.
    fire(review, "onEdit", {
      from: rest.length,
      to: rest.length,
      text: `\n${cut}`,
      cursor: rest.length + cut.length + 1,
      len: rest.length,
    });
    const held = String(prop(review, "text"));
    expect(held).toBe(`${rest}\n${cut}`);
    await approve(h);
    await flow;
    expect(h.services.sends).toEqual([{ pair: GAMMA_PAIR, text: held, kind: "handover" }]);
  });

  it("names the agent in the confirm view of a one-row pane and sends exactly what the editor holds", async () => {
    const h = await harness();
    h.tui.size = { columns: 100, rows: 1 };
    const { flow } = await agentHandover(h);
    const review = reviewOf(h);
    expect(prop(review, "maxLines")).toBe(1);
    appendText(review, "\nDone.");
    const held = String(prop(review, "text"));
    expect(held).toBe(`${CLEAN_NOTE}\n\n${DRAFT}\nDone.`);
    press(review, "ctrl+s");
    await flush();
    // The confirm view draws its first line in every height that it gets.
    const confirm = h.tui.top.node;
    typeCode(confirm, agentCode(confirm));
    await flow;
    expect(h.services.sends).toEqual([{ pair: GAMMA_PAIR, text: held, kind: "handover" }]);
  });

  it("takes no code while the pane is too narrow for the line that names the agent", async () => {
    const h = await harness();
    const { flow, ended } = await agentHandover(h);
    // The line of a `/talk` handover fits these columns; the line that names the agent does not.
    h.tui.size = { columns: 40, rows: 30 };
    press(reviewOf(h), "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(linesOf(confirm)).toEqual([CONFIRM_TOO_SMALL]);
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      press(confirm, letter);
      press(confirm, letter);
    }
    await flush();
    expect(ended()).toBeUndefined();
    expect(h.services.sends).toEqual([]);
    h.tui.size = { columns: 100, rows: 30 };
    typeCode(confirm, agentCode(confirm));
    await flow;
    expect(h.services.sends).toHaveLength(1);
  });

  it("sends nothing and returns OwnTarget when the destination became this session's registration before the send (#260 H3)", async () => {
    const h = await harness();
    const own = { now: false };
    const { flow } = await agentHandover(h, undefined, { text: undefined }, () => own.now);
    press(reviewOf(h), "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    own.now = true;
    typeCode(confirm, agentCode(confirm));
    expect(await flow).toEqual({ _tag: "OwnTarget" });
    expect(h.services.sends).toEqual([]);
    expect(h.tui.notices).toEqual([{ text: HANDOVER_TARGET_IS_THIS_SESSION, level: "error" }]);
    expect(h.tui.views.every((view) => view.closed)).toBe(true);
  });

  it("keeps the body back at the body write when the destination becomes this session's registration during the send (#260 H3)", async () => {
    const h = await harness();
    const own = { now: false };
    const gate = Promise.withResolvers<void>();
    h.services.sendGate = gate.promise;
    const { flow } = await agentHandover(h, undefined, { text: undefined }, () => own.now);
    await approve(h);
    await flush();
    const [record] = h.services.records;
    expect(record).toBeDefined();
    const life = h.services.lives.at(-1);
    expect(life?.live()).toBe(true);
    own.now = true;
    // The transport asks `live` right before the body write, so it keeps the body back now.
    expect(life?.live()).toBe(false);
    gate.resolve();
    expect(await flow).toEqual({ _tag: "OwnTarget" });
    expect(h.tui.notices).toEqual([{ text: HANDOVER_TARGET_IS_THIS_SESSION, level: "error" }]);
  });

  it("mounts the review only after the waiting view that names the agent and the target drew a frame (#260 H2)", async () => {
    const h = await harness();
    h.tui.drawOnMount = false;
    const { flow } = await agentHandover(h);
    // The side turn answered at once, but omp drew no frame of the waiting view yet.
    expect(h.services.turns).toHaveLength(1);
    const waiting = h.tui.views.at(-1);
    if (waiting === undefined) throw new Error("no waiting view");
    expect(waiting.node.kind).toBe("text");
    await flush();
    expect(h.tui.views.at(-1)).toBe(waiting);
    h.tui.draw(waiting);
    await flush();
    expect(prop(reviewOf(h), "text")).toBe(`${CLEAN_NOTE}\n\n${DRAFT}`);
    press(reviewOf(h), "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
  });

  it("ends the flow on escape while it waits for the frame of the waiting view", async () => {
    const h = await harness();
    h.tui.drawOnMount = false;
    const { flow } = await agentHandover(h);
    const waiting = h.tui.views.at(-1);
    if (waiting === undefined) throw new Error("no waiting view");
    press(waiting.node, "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.tui.views.map((view) => view.node.kind)).toEqual(["text"]);
  });

  it("ends the flow when omp closes the waiting view without done before its first frame (#260 H2)", async () => {
    const h = await harness();
    h.tui.drawOnMount = false;
    const { flow, ended } = await agentHandover(h);
    const waiting = h.tui.views.at(-1);
    if (waiting === undefined) throw new Error("no waiting view");
    // The side turn answered; the flow waits for the first frame.
    await flush();
    expect(ended()).toBeUndefined();
    waiting.hostClose();
    // The repair timer of the binding checks the open flow.
    h.slot.check();
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.tui.views.map((view) => view.node.kind)).toEqual(["text"]);
    expect(h.slot.isOpen()).toBe(false);
  });

  it("mounts the review after the first draw also in a one-row pane of 40 columns: no size holds it (#260 H2)", async () => {
    const h = await harness();
    h.tui.size = { columns: 40, rows: 1 };
    const { flow } = await agentHandover(h);
    expect(prop(reviewOf(h), "text")).toBe(`${CLEAN_NOTE}\n\n${DRAFT}`);
    press(reviewOf(h), "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
  });

  it.each([
    [
      "a failed side turn",
      () => Promise.reject(new Error("down")),
      "talk: the handover side turn failed. Nothing was sent. Host error: down",
    ],
    ["an empty reply", () => Promise.resolve({ replyText: " " }), HANDOVER_EMPTY],
  ] as const)(
    "reports %s at once, before the waiting view drew a frame (#260 H4)",
    async (_name, reply, notice) => {
      const h = await harness();
      h.tui.drawOnMount = false;
      h.services.reply = reply;
      const { flow, ended } = await agentHandover(h);
      await flush();
      expect(ended()).toEqual({ _tag: "SideTurnFailed" });
      expect(h.tui.notices).toEqual([{ text: notice, level: "error" }]);
      expect(await flow).toEqual({ _tag: "SideTurnFailed" });
    },
  );

  it("fits the whole waiting line of an unnamed peer with its full instance id into 80 columns", async () => {
    const h = await harness();
    h.tui.size = { columns: 80, rows: 1 };
    const reply = Promise.withResolvers<unknown>();
    h.services.reply = () => reply.promise;
    // A session without a name lists as `session-` and the first 8 characters of its session id.
    const unnamed = { ...GAMMA, name: "session-0123abcd" };
    const flow = h.run({
      _tag: "AgentHandover",
      destination: unnamed,
      note: undefined,
      isOwn: () => false,
    });
    await flush();
    const text = String(prop(h.tui.top.node, "text"));
    expect(text).toBe(
      `talk: agent handover to ${literal("session-0123abcd")} (${ID_C}) · ⎋ cancels`,
    );
    expect([...text].length).toBeLessThanOrEqual(80);
    press(h.tui.top.node, "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
  });

  it("cleans a host error for a notice: one line, no terminal controls, and a space for each tab", () => {
    expect(safeDiagnostic("open\t/home/u/x\u001b[31m failed\nretry")).toBe(
      "open /home/u/x failed retry",
    );
  });

  it("keeps the review open on ctrl+s while the text is blank", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h, undefined, { text: undefined });
    const review = reviewOf(h);
    replaceText(review, " \n ");
    expect(press(review, "ctrl+s")).toBe(true);
    await flush();
    expect(h.tui.top.node).toBe(review);
    press(review, "escape");
    await flow;
    expect(h.services.sends).toEqual([]);
  });

  it("sends the reviewed text with the note after ctrl+s and the code, and returns the dispatch record of that send", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h);
    press(reviewOf(h), "ctrl+s");
    await flush();
    const confirm = h.tui.top.node;
    expect(agentCode(confirm)).toMatch(/^[a-z]{2}$/u);
    expect(linesOf(confirm)).toContain("Kind: handover");
    typeCode(confirm, agentCode(confirm));
    const end = await flow;
    expect(h.services.sends).toEqual([
      { pair: GAMMA_PAIR, text: `${CLEAN_NOTE}\n\n${DRAFT}`, kind: "handover" },
    ]);
    const [record] = h.services.records;
    expect(record).toBeDefined();
    expect(end).toEqual({ _tag: "Dispatched", record, settled: true });
    expect(end._tag === "Dispatched" ? end.record : undefined).toBe(record);
  });

  it("returns to the review with the text kept on escape in the confirm view, while the flow and the tool call wait", async () => {
    const h = await harness();
    const { flow, ended } = await agentHandover(h, undefined, { text: undefined });
    replaceText(reviewOf(h), "edited");
    press(h.tui.top.node, "ctrl+s");
    await flush();
    expect(h.tui.top.node.kind).toBe("col");
    press(h.tui.top.node, "escape");
    await flush();
    expect(prop(reviewOf(h), "text")).toBe("edited");
    expect(ended()).toBeUndefined();
    expect(h.slot.isOpen()).toBe(true);
    press(reviewOf(h), "escape");
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.slot.isOpen()).toBe(false);
    expect(h.services.sends).toEqual([]);
  });

  it("returns Cancelled on alt+t in the confirm view and sends nothing", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h);
    press(reviewOf(h), "ctrl+s");
    await flush();
    press(h.tui.top.node, "alt+t");
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.services.sends).toEqual([]);
  });

  it.each(["side turn", "review", "confirm view"] as const)(
    "ends on an abort of the tool call's signal during the %s, returns Cancelled, closes its view, and sends nothing",
    async (stage) => {
      const h = await harness();
      const reply = Promise.withResolvers<unknown>();
      if (stage === "side turn") h.services.reply = () => reply.promise;
      const controller = new AbortController();
      const { flow } = await agentHandover(h, controller.signal);
      if (stage === "side turn")
        expect(prop(h.tui.top.node, "text")).toBe(agentHandoverWaiting(GAMMA));
      if (stage === "review") expect(reviewOf(h).kind).toBe("editor");
      if (stage === "confirm view") {
        press(reviewOf(h), "ctrl+s");
        await flush();
        expect(h.tui.top.node.kind).toBe("col");
      }
      controller.abort();
      expect(await flow).toEqual({ _tag: "Cancelled" });
      expect(h.services.turns[0]?.signal.aborted).toBe(true);
      expect(h.tui.views.every((view) => view.closed)).toBe(true);
      reply.resolve({ replyText: DRAFT });
      await flush();
      expect(h.tui.views.every((view) => view.closed)).toBe(true);
      expect(h.services.sends).toEqual([]);
    },
  );

  it("returns Cancelled and shows nothing for a signal that aborted before the start", async () => {
    const h = await harness();
    const { flow } = await agentHandover(h, AbortSignal.abort());
    expect(await flow).toEqual({ _tag: "Cancelled" });
    expect(h.services.turns).toEqual([]);
    expect(h.tui.calls).toEqual([]);
  });

  it("returns the record unsettled when the user stops the sending view while the send runs", async () => {
    const h = await harness();
    const gate = Promise.withResolvers<void>();
    h.services.sendGate = gate.promise;
    const { flow } = await agentHandover(h);
    press(reviewOf(h), "ctrl+s");
    await flush();
    typeCode(h.tui.top.node, agentCode(h.tui.top.node));
    await flush();
    expect(prop(h.tui.top.node, "text")).toBe(sendingText(GAMMA));
    press(h.tui.top.node, "escape");
    const [record] = h.services.records;
    expect(await flow).toEqual({ _tag: "Dispatched", record, settled: false });
    gate.resolve();
  });

  const HOST_ERROR = "provider \u001b[31mMARKER-7731\u001b[0m\tfailed\nretry later";
  const CLEAN_FAILURE =
    "talk: the handover side turn failed. Nothing was sent. Host error: provider MARKER-7731 failed retry later";

  it.each([
    ["the agent path", (h: Harness) => agentHandover(h)],
    ["the /talk path", (h: Harness) => handoverToGamma(h)],
  ])(
    "shows the host error of a failed side turn on one line without terminal controls on %s, and returns SideTurnFailed",
    async (_name, start) => {
      const h = await harness();
      h.services.reply = () => Promise.reject(new Error(HOST_ERROR));
      const { flow } = await start(h);
      expect(await flow).toEqual({ _tag: "SideTurnFailed" });
      expect(h.tui.notices.at(-1)).toEqual({ text: CLEAN_FAILURE, level: "error" });
      expect(h.services.sends).toEqual([]);
    },
  );

  it("returns SideTurnFailed for an empty reply", async () => {
    const h = await harness();
    h.services.reply = () => Promise.resolve({ replyText: " " });
    const { flow } = await agentHandover(h);
    expect(await flow).toEqual({ _tag: "SideTurnFailed" });
    expect(h.tui.notices.at(-1)).toEqual({ text: HANDOVER_EMPTY, level: "error" });
  });
});
