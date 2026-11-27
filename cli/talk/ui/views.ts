/**
 * The views of `/talk` (plan #251 G3): the session list, the compose view,
 * and the confirm view. Each builder returns the root node of one
 * `ctx.ui.custom` view, built with the loaded `jsx` and `signal` of omp
 * (F6), and closes the view only through `done`. The handover review view
 * is in `handover.ts`.
 *
 * - The list is a `picker` root with `size: "screen"`, shown as a full-screen
 *   overlay. It selects a registration pair; it sends nothing. Its mode sets
 *   what Enter starts: compose, or handover (G2, G6).
 * - The compose view is an `input` root, so the field has the focus (F5).
 * - The confirm view is a full-screen `col` root. Its first line names the
 *   full instance id of the destination and a code of two letters; only the
 *   two letters, typed as two separate key presses, send.
 *
 * Every peer string passes the #250 cleaners before it reaches a node:
 * metadata goes through `literal`, and the text line goes through `oneLine`.
 */
import { randomInt } from "node:crypto";

import { Predicate } from "effect";

import type { JSXNode, Signal } from "@oh-my-pi/pi-tui";

import { literal, oneLine, safeMultiline } from "../tool/attachments";
import type { ProbeResult } from "../tool/targets";
import type { Target } from "../transport/request";
import type { HostUi } from "./host";

// ── Host shapes ──

/** The space that a view owns, from `ui.size()` of the factory host (F5). */
export interface ViewSize {
  readonly columns: number;
  readonly rows: number;
}

/** Reads the current size; undefined when the host gives no valid size. */
export type SizeReader = () => ViewSize | undefined;

/** The parts of a pi-tui key event (`src/events.ts`) that the views read in `onKey`. */
export interface ViewKey {
  readonly id: string;
  readonly kind: "press" | "repeat" | "release";
  /** The bytes of the key: `enter` comes from `\r`, or from `\n` for `ctrl+j` (F5). */
  readonly raw?: string;
  /** The first key decoded from the same read right after a bracketed paste. */
  readonly afterPaste?: boolean;
}

/** One edit of an `input` (`TextEdit` of pi-tui): replace `[from, to)` with `text`; `len` is the text length that the edit saw. */
export interface ViewEdit {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly cursor: number;
  readonly len: number;
}

/**
 * `ui.size()` of the factory host, checked on each read. A host without a
 * valid size reads as undefined, so no view sends while it cannot check its
 * space.
 */
export const sizeReader =
  (host: unknown): SizeReader =>
  () => {
    if (!Predicate.hasProperty(host, "size") || !Predicate.isFunction(host.size)) return undefined;
    const size: unknown = Reflect.apply(host.size, host, []);
    return Predicate.hasProperty(size, "columns") &&
      Predicate.isNumber(size.columns) &&
      Predicate.hasProperty(size, "rows") &&
      Predicate.isNumber(size.rows)
      ? { columns: size.columns, rows: size.rows }
      : undefined;
  };

/** The keys that close a view: `escape`, and the shortcut that opens the list (F2). */
export const CLOSE_KEY = "escape";
export const TALK_SHORTCUT = "alt+t";

// ── Destinations ──

/** One registration pair that a view can send to, with the metadata of its listing. */
export interface Destination extends Target {
  readonly name: string | undefined;
  readonly cwd: string | undefined;
}

/** One row of the list view: a destination and what the listing knows about it. */
export interface ListRow extends Destination {
  readonly own: boolean;
  readonly probe: ProbeResult;
}

/** The session id characters that the list shows. */
const SHORT_SESSION_LENGTH = 8;
/** The length of a full instance id: 16 hex digits. */
export const INSTANCE_ID_LENGTH = 16;

const shownName = (destination: Destination): string =>
  destination.name === undefined ? "(no name)" : literal(destination.name);
const shownFolder = (destination: Destination): string =>
  destination.cwd === undefined ? "(no folder)" : literal(destination.cwd);

// ── List view ──

/** The list rows of the picker painter by default (`term.maxRows`, `picker.ts` v19.2.1). */
export const PICKER_ROW_LIMIT = 10;
/** The picker rows besides the list: the top border, the bottom border, and the hint row. */
export const PICKER_FIXED_ROWS = 3;
/**
 * The cells of a list row that the label cannot use (`picker.ts` v19.2.1:272-304, 450-475):
 * the frame (4), the scrollbar (1), the pointer (2), and the two cells that the
 * painter keeps when it cuts a label (2).
 */
export const PICKER_LABEL_CHROME = 9;
/** The rows of the empty picker frame without a hint: the top border, the empty text, and the bottom border. */
export const PICKER_EMPTY_FRAME_ROWS = 3;

/** What the list view can show in its space. */
export interface ListLayout {
  /** The list rows before the list scrolls, at least 1. */
  readonly maxRows: number;
  /** At least one item row fits, and the label budget holds the full instance id. */
  readonly fits: boolean;
  /**
   * The empty frame fits, so its empty text can hold the request for a
   * larger pane. Otherwise the top border holds it: omp clips an overflowing
   * frame to its first rows (S10).
   */
  readonly framed: boolean;
}

/** G3: the rows after the fixed picker rows, at most 10, and the width guard of the label. */
export const listLayout = (size: ViewSize | undefined): ListLayout => {
  if (size === undefined) return { maxRows: 1, fits: false, framed: false };
  const rows = Math.min(PICKER_ROW_LIMIT, size.rows - PICKER_FIXED_ROWS);
  return {
    maxRows: Math.max(1, rows),
    fits: rows >= 1 && size.columns - PICKER_LABEL_CHROME >= INSTANCE_ID_LENGTH,
    framed: size.rows >= PICKER_EMPTY_FRAME_ROWS,
  };
};

export const LIST_TOO_SMALL = "talk: make the pane larger to show the sessions.";
const LIST_EMPTY = "No live talk sessions.";

/** What Enter (`activate`) starts in the list: compose, or handover (G2, G6). */
export type ListMode = "message" | "handover";

const LIST_TITLE: Record<ListMode, string> = {
  message: "talk sessions",
  handover: "talk: hand over to",
};
const LIST_HINT: Record<ListMode, string> = {
  message: "⏎ message · h handover · ⎋ close",
  handover: "⏎ hand over · ⎋ close",
};

/** How the list view ends. */
export type ListChoice =
  | { readonly _tag: "Compose"; readonly row: ListRow }
  | { readonly _tag: "Handover"; readonly row: ListRow }
  | { readonly _tag: "Close" };

/** The picker item id of a row: its exact pair. */
const itemId = (row: Target): string => `${row.instanceId}/${row.sessionId}`;

/** The item label starts with the full instance id, then the name (G3). */
export const rowLabel = (row: ListRow): string => `${row.instanceId}  ${shownName(row)}`;

/** The detail: the own marker and the probe state first, the folder last, so a cut row keeps them. */
const rowDetail = (row: ListRow): string =>
  [
    ...(row.own ? ["(this session)"] : []),
    ...(row.probe === "ok" ? [] : [`unresolved: ${row.probe}`]),
    `session ${literal(row.sessionId.slice(0, SHORT_SESSION_LENGTH))}`,
    shownFolder(row),
  ].join(" · ");

/**
 * The list view: a `picker` root with `size: "screen"`, one item per row
 * (G3). Enter (`activate`) chooses compose, or handover in the handover
 * mode; `h` chooses handover; `escape` and `alt+t` close. While no item row
 * fits or the label cannot hold the instance id, the picker shows only the
 * request for a larger pane, and neither `activate` nor `h` does anything.
 */
export const listView = (
  ui: HostUi,
  size: SizeReader,
  rows: ReadonlyArray<ListRow>,
  mode: ListMode,
  done: (choice: ListChoice) => void,
): JSXNode => {
  const byId = new Map(rows.map((row) => [itemId(row), row]));
  const first = rows.find((row) => !row.own) ?? rows[0];
  const selected = ui.signal<string | null>(first === undefined ? null : itemId(first));
  const items = rows.map((row) => ({
    id: itemId(row),
    label: rowLabel(row),
    detail: rowDetail(row),
  }));
  const layout = (): ListLayout => listLayout(size());
  /** The selected row while the view fits; undefined otherwise. */
  const chosen = (item: string | null): ListRow | undefined =>
    item === null || !layout().fits ? undefined : byId.get(item);
  return ui.jsx("picker", {
    title: LIST_TITLE[mode],
    noun: "sessions",
    size: "screen",
    items: () => (layout().fits ? items : []),
    selected: () => (layout().fits ? selected() : null),
    empty: () => (layout().fits ? LIST_EMPTY : LIST_TOO_SMALL),
    term: () => {
      const { maxRows, fits, framed } = layout();
      if (fits) return { maxRows, hint: LIST_HINT[mode] };
      return { maxRows, hint: null, title: framed ? null : LIST_TOO_SMALL };
    },
    onSelect: (item: string) => {
      if (byId.has(item)) selected.set(item);
    },
    onActivate: (item: string) => {
      const row = chosen(item);
      if (row === undefined) return;
      done(mode === "handover" ? { _tag: "Handover", row } : { _tag: "Compose", row });
    },
    onKey: (key: ViewKey): boolean => {
      if (key.kind === "release") return false;
      if (key.id === CLOSE_KEY || key.id === TALK_SHORTCUT) {
        done({ _tag: "Close" });
        return true;
      }
      if (key.id === "h") {
        const row = chosen(selected.peek());
        if (row !== undefined) done({ _tag: "Handover", row });
        return true;
      }
      // Enter reaches the picker widget, which reports `activate`, only while the list fits.
      return key.id === "enter" && !layout().fits;
    },
  });
};

// ── Compose view ──

/** How a text view ends: the compose view, or the handover review. */
export type TextChoice =
  | { readonly _tag: "Confirm"; readonly text: string }
  | { readonly _tag: "Cancel" };

/**
 * Applies one edit of a text field (T1). The inserted text passes
 * `safeMultiline`, so no escape sequence or other control character reaches
 * the field or the send; the caret of a cleaned insertion goes to its end.
 * A stale edit saw another text, and pi-tui says to ignore it.
 */
export const applyEdit = (draft: Signal<string>, cursor: Signal<number>, edit: ViewEdit): void => {
  const before = draft.peek();
  if (edit.len !== before.length) return;
  const text = safeMultiline(edit.text);
  draft.set(before.slice(0, edit.from) + text + before.slice(edit.to));
  cursor.set(text === edit.text ? edit.cursor : edit.from + text.length);
};

/** The placeholder of the compose field: the destination and the keys. */
export const composePlaceholder = (destination: Destination): string =>
  `To ${shownName(destination)}: the message; ⏎ confirms the destination, ⎋ cancels`;

/**
 * The compose view: an `input` root, so the field takes the typing (F5).
 * `enter` with text goes to the confirm view; `escape` and `alt+t` cancel.
 * The field starts with `text`, so the text is kept when the confirm view
 * returns here. The destination is in the placeholder, not in a prompt:
 * omp 19.2.1 scrolls an `input` without the width of its prompt, so a
 * prompt can hide the caret of a long text (C3). The confirm view names
 * the destination again.
 */
export const composeView = (
  ui: HostUi,
  destination: Destination,
  text: string,
  done: (choice: TextChoice) => void,
): JSXNode => {
  const draft = ui.signal(text);
  const cursor = ui.signal(text.length);
  return ui.jsx("input", {
    text: () => draft(),
    cursor: () => cursor(),
    placeholder: composePlaceholder(destination),
    onEdit: (edit: ViewEdit) => {
      applyEdit(draft, cursor, edit);
    },
    onKey: (key: ViewKey): boolean => {
      if (key.kind === "release") return false;
      if (key.id === CLOSE_KEY || key.id === TALK_SHORTCUT) {
        done({ _tag: "Cancel" });
        return true;
      }
      if (key.id !== "enter") return false;
      const value = draft.peek();
      if (value.trim() !== "") done({ _tag: "Confirm", text: value });
      return true;
    },
  });
};

// ── Confirm view ──

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** The number of letters of a confirm code. */
export const CODE_LENGTH = 2;

/**
 * A fresh code of two different random lowercase letters, other than `last`
 * (G3). `pick(n)` gives a random integer in `[0, n)`.
 */
export const drawCode = (
  last: string | undefined,
  pick: (bound: number) => number = randomInt,
): string => {
  for (;;) {
    const firstIndex = pick(LETTERS.length);
    const offset = pick(LETTERS.length - 1);
    const secondIndex = offset >= firstIndex ? offset + 1 : offset;
    const code = `${LETTERS.charAt(firstIndex)}${LETTERS.charAt(secondIndex)}`;
    if (code !== last) return code;
  }
};

/** The first line of the confirm view (G3). */
export const confirmLine = (instanceId: string, code: string): string =>
  `Send to ${instanceId}: type ${code}`;

export const CONFIRM_TOO_SMALL = "talk: make the pane wider to confirm the destination.";

/** How the confirm view ends. */
export type ConfirmChoice =
  | { readonly _tag: "Send" }
  | { readonly _tag: "Back" }
  | { readonly _tag: "Close" };

/** What the confirm view shows besides the destination. */
export interface ConfirmContent {
  readonly kind: string;
  readonly text: string;
  readonly code: string;
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * The confirm view: a `col` root whose first line names the full instance
 * id and the code, then the name and folder, the kind, and the first line of
 * the text, each cut to one row (G3). Only the two code letters, typed as two
 * separate presses, send. A repeat event, a paste, a key after a paste, or
 * any other key clears the typed letters; `enter` sends nothing. While the
 * first line does not fit the width, the view shows only a request for a
 * wider pane, and no key sends. `escape` returns to the compose view;
 * `alt+t` closes the flow.
 */
export const confirmView = (
  ui: HostUi,
  size: SizeReader,
  destination: Destination,
  content: ConfirmContent,
  done: (choice: ConfirmChoice) => void,
): JSXNode => {
  const typed = ui.signal("");
  const first = confirmLine(destination.instanceId, content.code);
  /** The current size while the first line fits its width; undefined otherwise. */
  const space = (): ViewSize | undefined => {
    const current = size();
    return current !== undefined && ui.visibleWidth(first) <= current.columns ? current : undefined;
  };
  const textLine = (text: string): JSXNode => ui.jsx("text", { text });
  const dimLine = (text: string): JSXNode => ui.jsx("text", { spans: [{ t: text, s: "dim" }] });
  const firstTextLine = content.text.split(LINE_BREAK)[0] ?? "";
  return ui.jsx("col", {
    children: () => {
      const shown = space();
      if (shown === undefined) return [textLine(CONFIRM_TOO_SMALL)];
      const cut = (text: string): string => ui.truncate(text, shown.columns);
      return [
        textLine(first),
        textLine(cut(`${shownName(destination)} · ${shownFolder(destination)}`)),
        textLine(cut(`Kind: ${content.kind}`)),
        textLine(cut(`Text: ${oneLine(firstTextLine)}`)),
        dimLine(
          cut(
            `Typed: ${typed().padEnd(CODE_LENGTH, "_")} · type the two letters as two key presses · ⎋ back`,
          ),
        ),
      ];
    },
    onPaste: (): boolean => {
      typed.set("");
      return true;
    },
    onKey: (key: ViewKey): boolean => {
      if (key.kind === "release") return true;
      if (key.id === CLOSE_KEY) {
        done({ _tag: "Back" });
        return true;
      }
      if (key.id === TALK_SHORTCUT) {
        done({ _tag: "Close" });
        return true;
      }
      const sofar = typed.peek();
      const expected = content.code.charAt(sofar.length);
      const counts =
        space() !== undefined &&
        key.kind === "press" &&
        key.afterPaste !== true &&
        key.id === expected;
      if (!counts) {
        typed.set("");
        return true;
      }
      const next = sofar + expected;
      if (next.length < CODE_LENGTH) {
        typed.set(next);
        return true;
      }
      typed.set("");
      done({ _tag: "Send" });
      return true;
    },
  });
};
