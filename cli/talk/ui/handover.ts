/**
 * Handover (plan #251 G6, #260 H2): the template of the side turn, the
 * reading of its reply, and the review view.
 *
 * The flow in `command.ts` resolves the destination to one registration
 * pair, asks `ctx.runEphemeralTurn` for a summary with `HANDOVER_PROMPT`,
 * and opens the review view with the reply. The operator edits the draft
 * there; `ctrl+s` goes to the confirm view of `views.ts`. The send carries
 * `kind: "handover"` and a wake, so the receiver acts on the summary. The
 * `handover` action of the `talk` tool starts the same flow for an exact
 * pair; its waiting view and the first line of its confirm view name the
 * agent as the starter, and the note of the agent starts the text.
 *
 * This module runs no effect.
 */
import { Predicate } from "effect";

import type { JSXNode } from "@oh-my-pi/pi-tui";

import { safeMultiline } from "../tool/attachments";
import type { HostUi } from "./host";
import {
  CLOSE_KEY,
  type Destination,
  type SizeReader,
  TALK_SHORTCUT,
  type TextChoice,
  type ViewEdit,
  type ViewKey,
  type ViewSize,
  applyEdit,
  safeOneLine,
  shownName,
} from "./views";

/** omp caps the reply of a side turn at 4 KiB (F7); the template stays inside it too. */
export const MAX_HANDOVER_BYTES = 4096;

/**
 * A host error for a notice (#260 H4): one line without terminal controls,
 * and each tab a space, so the notice shows it as plain text. The draft
 * keeps its tabs.
 */
export const safeDiagnostic = (text: string): string => safeOneLine(text).replaceAll("\t", " ");

/**
 * The prompt of the side turn (G6). The side turn runs on a copy of this
 * session's conversation, so the model writes from this session's view. The
 * sections follow pi-intercom `handover.ts` (F10); the text is talk's own.
 */
export const HANDOVER_PROMPT = [
  "Write a handover of the work in this session for another agent session.",
  "The other session cannot see this conversation, so the handover must stand alone.",
  "Write it from the view of this session: what this session did, what it knows, and what it leaves open.",
  "",
  "Use Markdown with exactly these five sections, in this order:",
  "",
  "## Next task",
  "The one thing that the receiver must do next, as an instruction.",
  "",
  "## Decisions",
  "The decisions and findings that the receiver must keep, each with its reason. Name the approaches that failed or that were rejected.",
  "",
  "## Files",
  "The files, folders, and repositories that matter, with absolute paths and one line about each.",
  "",
  "## Current state",
  "What is done, what is in progress, uncommitted changes, branches, and the last test or check results that this session saw.",
  "",
  "## Risks",
  "Open questions, known risks, and what the receiver must check first.",
  "",
  "Rules:",
  "- Keep the whole handover under 3500 bytes of UTF-8 text: about 3500 ASCII characters, and fewer characters in other scripts. omp cuts a reply above 4096 bytes.",
  "- Use short bullets. Write no greeting, no preamble, and no closing line.",
  "- Do not copy secrets: API keys, tokens, passwords, credentials, or private keys.",
  "- Do not call tools and do not answer other questions. Reply with the handover only.",
].join("\n");

/** The options of `ctx.runEphemeralTurn` that the flow gives: no `maxTokens` and no `tools` (F7). */
export interface SideTurnRequest {
  readonly promptText: string;
  readonly signal: AbortSignal;
}

/** `ctx.runEphemeralTurn` of the flow's context. */
export type SideTurn = (request: SideTurnRequest) => Promise<unknown>;

export const HANDOVER_STARTED =
  "talk: a side turn writes the handover summary. In the review, ctrl+s confirms the destination, alt+enter adds a line, and escape cancels.";

/**
 * The waiting view of the side turn of a handover that the `talk` tool
 * started (#260 H2). omp shows a notice of a tool call only after the call
 * ends, so talk's own view says who started the handover and names its
 * target, cleaned as the views clean names. The confirm view names the agent
 * again at the point of approval.
 */
export const agentHandoverWaiting = (destination: Destination): string =>
  `talk: the agent started a handover to ${shownName(destination)} (instance ${destination.instanceId}) · a side turn writes the summary · ⎋ cancels`;

/**
 * The first text of the review (#260 H1): the note of the agent, cleaned as
 * the draft is, above the draft. A note without text adds nothing.
 */
export const reviewText = (note: string | undefined, draft: string): string => {
  const lead = note === undefined ? "" : safeMultiline(note).trim();
  return lead === "" ? draft : `${lead}\n\n${draft}`;
};

export const HANDOVER_NO_SIDE_TURN =
  "talk: this omp gives no ctx.runEphemeralTurn, so talk cannot write a handover. Nothing was sent.";

export const HANDOVER_EMPTY = "talk: the side turn gave no handover text. Nothing was sent.";

/** The line that omp puts at the end of a side-turn reply that it cut at 4 KiB (`dedupeEphemeralReply` v19.2.1). */
export const OMP_CUT_MARK = "\n[…truncated]";

/** The review shows this line in place of omp's mark, so the operator sees that the end is missing (C8). */
export const HANDOVER_CUT_LINE =
  "[talk: omp cut this handover at 4096 bytes, so its end is missing. Complete or shorten it before you send it.]";

/** What the side turn gave: a draft, or the text of its error. */
export type DraftAnswer =
  | { readonly _tag: "Draft"; readonly text: string }
  | { readonly _tag: "Failed"; readonly text: string };

/**
 * Runs the side turn with the template and the flow's signal (G6). The
 * answer never rejects: a throw, a rejection, or an empty reply gives
 * `Failed` with the host error.
 */
export const requestDraft = async (
  sideTurn: SideTurn,
  signal: AbortSignal,
): Promise<DraftAnswer> => {
  try {
    const reply = await sideTurn({ promptText: HANDOVER_PROMPT, signal });
    const raw =
      Predicate.hasProperty(reply, "replyText") && Predicate.isString(reply.replyText)
        ? reply.replyText.trimEnd()
        : "";
    // R5: omp's mark is found in the raw reply, before cleaning and trimming can change it.
    const cut = raw.endsWith(OMP_CUT_MARK);
    // T1: the reply is model text; no escape sequence of it reaches the terminal.
    const body = safeMultiline(cut ? raw.slice(0, -OMP_CUT_MARK.length) : raw).trim();
    if (body === "") return { _tag: "Failed", text: HANDOVER_EMPTY };
    return { _tag: "Draft", text: cut ? `${body}\n${HANDOVER_CUT_LINE}` : body };
  } catch (cause) {
    // H4: the host error is one line without terminal controls or tabs, on every path of the flow.
    const hostError = safeDiagnostic(Predicate.isError(cause) ? cause.message : String(cause));
    return {
      _tag: "Failed",
      text: `talk: the handover side turn failed. Nothing was sent. Host error: ${hostError}`,
    };
  }
};

/** The review fits while one editable row of the draft fits the screen that it owns (C4). */
export const reviewFits = (size: ViewSize | undefined): boolean =>
  size !== undefined && size.rows >= 1 && size.columns >= 1;

/**
 * The review view: an `editor` root, so the field takes the typing (F5),
 * shown as a full-screen overlay, so the view owns the screen that
 * `ui.size()` reports. It starts with the draft and the caret at its start.
 * `ctrl+s` with text goes to the confirm view while an editable row fits;
 * `alt+enter`, `shift+enter`, and `ctrl+j` reach the widget, which adds a
 * line; `enter` from `\r` adds nothing; `escape` and `alt+t` cancel. The
 * view shows a window of screen rows around the caret. The field holds only
 * the text that can be sent, so the send is exactly what the editor holds.
 */
export const reviewView = (
  ui: HostUi,
  size: SizeReader,
  text: string,
  done: (choice: TextChoice) => void,
): JSXNode => {
  const draft = ui.signal(text);
  const cursor = ui.signal(0);
  return ui.jsx("editor", {
    text: () => draft(),
    cursor: () => cursor(),
    placeholder: "the handover summary; ctrl+s confirms the destination, ⎋ cancels",
    maxLines: () => Math.max(1, size()?.rows ?? 1),
    onEdit: (edit: ViewEdit) => {
      applyEdit(draft, cursor, edit);
    },
    onKey: (key: ViewKey): boolean => {
      if (key.kind === "release") return false;
      if (key.id === CLOSE_KEY || key.id === TALK_SHORTCUT) {
        done({ _tag: "Cancel" });
        return true;
      }
      if (key.id === "ctrl+s") {
        const value = draft.peek();
        if (value.trim() !== "" && reviewFits(size())) done({ _tag: "Confirm", text: value });
        return true;
      }
      // `ctrl+j` arrives as `enter` with a raw LF, and the widget adds a line for it (F5).
      if (key.id === "enter") return key.raw !== "\n";
      return false;
    },
  });
};
