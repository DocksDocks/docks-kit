/**
 * Handover (plan #251 G6): the template of the side turn, the reading of its
 * reply, and the review view.
 *
 * The flow in `command.ts` resolves the destination to one registration
 * pair, asks `ctx.runEphemeralTurn` for a summary with `HANDOVER_PROMPT`,
 * and opens the review view with the reply. The operator edits the draft
 * there; `ctrl+s` goes to the confirm view of `views.ts`. The send carries
 * `kind: "handover"` and a wake, so the receiver acts on the summary.
 *
 * This module runs no effect.
 */
import { Predicate } from "effect";

import type { JSXNode } from "@oh-my-pi/pi-tui";

import type { HostUi } from "./host";
import {
  CLOSE_KEY,
  type SizeReader,
  TALK_SHORTCUT,
  type TextChoice,
  type ViewEdit,
  type ViewKey,
} from "./views";

/** omp caps the reply of a side turn at 4 KiB (F7); the template stays inside it too. */
export const MAX_HANDOVER_BYTES = 4096;

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
  "- Keep the whole handover under 3500 characters. omp cuts a longer reply.",
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

export const HANDOVER_NO_SIDE_TURN =
  "talk: this omp gives no ctx.runEphemeralTurn, so talk cannot write a handover. Nothing was sent.";

export const HANDOVER_EMPTY = "talk: the side turn gave no handover text. Nothing was sent.";

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
    const text =
      Predicate.hasProperty(reply, "replyText") && Predicate.isString(reply.replyText)
        ? reply.replyText.trim()
        : "";
    return text === "" ? { _tag: "Failed", text: HANDOVER_EMPTY } : { _tag: "Draft", text };
  } catch (cause) {
    const hostError = Predicate.isError(cause) ? cause.message : String(cause);
    return {
      _tag: "Failed",
      text: `talk: the handover side turn failed. Nothing was sent. Host error: ${hostError}`,
    };
  }
};

/** The rows under the review that omp keeps for its status panel and dock (F5). */
export const REVIEW_KEPT_ROWS = 6;
/** The review shows at least these rows of the draft, also in a small pane. */
const REVIEW_MIN_ROWS = 3;

/**
 * The review view: an `editor` root, so the field takes the typing (F5). It
 * starts with the draft and the caret at its start. `ctrl+s` with text goes
 * to the confirm view; `alt+enter`, `shift+enter`, and `ctrl+j` reach the
 * widget, which adds a line; `enter` from `\r` adds nothing; `escape` and
 * `alt+t` cancel. The view shows a window of rows around the caret, so a
 * long draft does not push the frame past the pane.
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
    maxLines: () => Math.max(REVIEW_MIN_ROWS, (size()?.rows ?? REVIEW_MIN_ROWS) - REVIEW_KEPT_ROWS),
    onEdit: (edit: ViewEdit) => {
      const before = draft.peek();
      // A stale edit saw another text: pi-tui says to ignore it.
      if (edit.len !== before.length) return;
      draft.set(before.slice(0, edit.from) + edit.text + before.slice(edit.to));
      cursor.set(edit.cursor);
    },
    onKey: (key: ViewKey): boolean => {
      if (key.kind === "release") return false;
      if (key.id === CLOSE_KEY || key.id === TALK_SHORTCUT) {
        done({ _tag: "Cancel" });
        return true;
      }
      if (key.id === "ctrl+s") {
        const value = draft.peek();
        if (value.trim() !== "") done({ _tag: "Confirm", text: value });
        return true;
      }
      // `ctrl+j` arrives as `enter` with a raw LF, and the widget adds a line for it (F5).
      if (key.id === "enter") return key.raw !== "\n";
      return false;
    },
  });
};
