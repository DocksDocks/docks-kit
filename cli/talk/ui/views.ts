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

/** The glyph sets of omp (`SymbolSet.preset`, pi-tui `src/theme/contract.ts` v19.2.1). */
export type SymbolPreset = "unicode" | "nerd" | "ascii";

/**
 * The symbol preset of the factory theme (`theme.symbols.preset`). omp gives
 * each factory `extensionTheme(currentTheme())`, whose `symbols` is the
 * active glyph set. A theme without a known preset reads as `unicode`, the
 * default of omp (pi-tui `src/theme/theme.ts` v19.2.1:194).
 */
export const symbolPreset = (theme: unknown): SymbolPreset => {
  const symbols = Predicate.hasProperty(theme, "symbols") ? theme.symbols : undefined;
  const preset = Predicate.hasProperty(symbols, "preset") ? symbols.preset : undefined;
  return preset === "ascii" || preset === "nerd" ? preset : "unicode";
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

/** The name of a destination as a literal, for the views and the start notice of a handover (#260 H2). */
export const shownName = (destination: Destination): string =>
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

/** What the list view can show in its space. */
export interface ListLayout {
  /** The list rows before the list scrolls, at least 1. */
  readonly maxRows: number;
  /** At least one item row fits, and the label budget holds the full instance id. */
  readonly fits: boolean;
}

/** G3: the rows after the fixed picker rows, at most 10, and the width guard of the label. */
export const listLayout = (size: ViewSize | undefined): ListLayout => {
  if (size === undefined) return { maxRows: 1, fits: false };
  const rows = Math.min(PICKER_ROW_LIMIT, size.rows - PICKER_FIXED_ROWS);
  return {
    maxRows: Math.max(1, rows),
    fits: rows >= 1 && size.columns - PICKER_LABEL_CHROME >= INSTANCE_ID_LENGTH,
  };
};

/**
 * The word texts of the resize view, longest first (G3): the view shows the
 * longest one that fits the width, so one screen row holds a whole cue and
 * no word is cut. A pane narrower than 4 cells shows a symbol cue of the
 * active symbol preset instead (`RESIZE_SYMBOLS`).
 */
export const RESIZE_TEXTS = [
  "talk: enlarge the pane to see the session list",
  "talk: enlarge the pane",
  "enlarge the pane",
  "enlarge",
  "grow",
] as const;

/**
 * The symbol cues of the resize view per preset, longest first. The
 * `unicode` and `nerd` presets show `⤢` (U+2922), the expand symbol of omp
 * (`cmd.expand` in pi-tui `src/theme/data/symbols.json` v19.2.1). Its East
 * Asian Width is neutral (`2900..297F ; N` in `EastAsianWidth.txt` 17.0.0),
 * so it takes one cell also where a terminal draws ambiguous characters
 * wide; the nerd glyph of `cmd.expand` is a private-use character, whose
 * width is ambiguous. The `ascii` preset has no `cmd.expand` glyph, and its
 * font can lack `⤢`: it shows `<->`, an arrow with two heads that asks for
 * a wider pane, and in one or two cells `+`, the ASCII `nav.expand` glyph
 * of omp.
 */
const RESIZE_SYMBOLS: Readonly<Record<SymbolPreset, ReadonlyArray<string>>> = {
  unicode: ["⤢"],
  nerd: ["⤢"],
  ascii: ["<->", "+"],
};

/** Every resize cue per preset, longest first: the word texts, then the symbol cues. */
export const RESIZE_CUES: Readonly<Record<SymbolPreset, ReadonlyArray<string>>> = {
  unicode: [...RESIZE_TEXTS, ...RESIZE_SYMBOLS.unicode],
  nerd: [...RESIZE_TEXTS, ...RESIZE_SYMBOLS.nerd],
  ascii: [...RESIZE_TEXTS, ...RESIZE_SYMBOLS.ascii],
};
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

/**
 * How the list view ends. `TooSmall` when its space cannot show one item
 * row; it carries the selected pair, so the list can select it again.
 */
export type ListChoice =
  | { readonly _tag: "Compose"; readonly row: ListRow }
  | { readonly _tag: "Handover"; readonly row: ListRow }
  | { readonly _tag: "Close" }
  | { readonly _tag: "TooSmall"; readonly selected: Target | undefined };

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
 * mode; `h` chooses handover; `escape` and `alt+t` close. It selects the
 * row of `preferred` when one is listed, else the first row of another
 * session. When no item row with the full instance id fits at open, it ends
 * with `TooSmall` before omp mounts it; a resize below that size ends it
 * with `TooSmall` at the next draw, and that draw shows no empty-state text
 * and no key hint, so an undersized frame never reads as an empty
 * registry. Neither `activate` nor `h` acts while it does not fit.
 */
export const listView = (
  ui: HostUi,
  size: SizeReader,
  rows: ReadonlyArray<ListRow>,
  mode: ListMode,
  done: (choice: ListChoice) => void,
  preferred?: Target,
): JSXNode => {
  const byId = new Map(rows.map((row) => [itemId(row), row]));
  const kept = preferred === undefined ? undefined : byId.get(itemId(preferred));
  const first = kept ?? rows.find((row) => !row.own) ?? rows[0];
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
  const tooSmall = (): void => {
    const row = byId.get(selected.peek() ?? "");
    done({
      _tag: "TooSmall",
      selected:
        row === undefined ? undefined : { instanceId: row.instanceId, sessionId: row.sessionId },
    });
  };
  // omp mounts no view whose `done` ran while its factory ran (`showHookCustom` v19.2.1). The
  // operator saw no selection of this picker, so it carries forward only an earlier pair.
  if (!layout().fits) done({ _tag: "TooSmall", selected: preferred });
  return ui.jsx("picker", {
    title: LIST_TITLE[mode],
    noun: "sessions",
    size: "screen",
    items: () => {
      if (layout().fits) return items;
      // A resize below the size: the view ends after this draw; `done` runs once only.
      queueMicrotask(() => {
        tooSmall();
      });
      return [];
    },
    selected: () => (layout().fits ? selected() : null),
    // An undersized frame shows neither the empty-state text nor the key hint.
    empty: () => (layout().fits ? LIST_EMPTY : ""),
    term: () => {
      const { maxRows, fits } = layout();
      return { maxRows, hint: fits ? LIST_HINT[mode] : null };
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

// ── Waiting views ──

/**
 * How a view that waits for a talk step ends: the result of the step, its
 * rejection, or a close by the operator. A close ends the flow, and the
 * flow's abort signal stops the step.
 */
export type Waited<R> =
  | { readonly _tag: "Ready"; readonly result: R }
  | { readonly _tag: "Failed"; readonly cause: unknown }
  | { readonly _tag: "Close" };

/**
 * Runs `task` once and ends the view with its result; `done` runs once
 * only. A task that throws at once ends the view as `Failed`, as a
 * rejection does (round 8).
 */
const settleWith = <R>(task: () => Promise<R>, done: (choice: Waited<R>) => void): void => {
  let running: Promise<R>;
  try {
    running = task();
  } catch (cause) {
    done({ _tag: "Failed", cause });
    return;
  }
  running.then(
    (result) => {
      done({ _tag: "Ready", result });
    },
    (cause: unknown) => {
      done({ _tag: "Failed", cause });
    },
  );
};

/**
 * The keys of a waiting view: `escape` and `alt+t` end the flow; every other
 * key does nothing. The view keeps the focus, so no key reaches the
 * composer of omp while a talk step runs.
 */
const waitingKeys =
  <R>(done: (choice: Waited<R>) => void) =>
  (key: ViewKey): boolean => {
    if (key.kind !== "release" && (key.id === CLOSE_KEY || key.id === TALK_SHORTCUT))
      done({ _tag: "Close" });
    return true;
  };

/**
 * The start line that a waiting view must show whole before its flow goes
 * on (#260 H2): `start` leads its text, `narrow` stands in while one row of
 * the pane cannot show `start`, and `drawn` runs each time omp draws the
 * whole start line.
 */
export interface StartLine {
  readonly size: SizeReader;
  readonly start: string;
  readonly narrow: string;
  readonly drawn: () => void;
}

/**
 * A view that holds the focus while one talk step runs, such as the side
 * turn of a handover or a send: one `text` node with `text`. It starts
 * `task` at once and ends with its result. With `line`, the text is an
 * accessor that omp reads on each draw: while the reported size shows the
 * whole start line in one row, the view shows `text` cut to the width and
 * calls `drawn`; otherwise it shows the narrow text, so a tool-started
 * handover can wait until its start line was visible.
 */
export const pendingView = <R>(
  ui: HostUi,
  text: string,
  task: () => Promise<R>,
  done: (choice: Waited<R>) => void,
  line?: StartLine,
): JSXNode => {
  settleWith(task, done);
  const shown =
    line === undefined
      ? text
      : (): string => {
          const current = line.size();
          if (
            current === undefined ||
            current.rows < 1 ||
            ui.visibleWidth(line.start) > current.columns
          )
            return line.narrow;
          line.drawn();
          // No ellipsis: a cut never takes a cell of the start line.
          return ui.truncate(text, current.columns, "");
        };
  return ui.jsx("text", { text: shown, onKey: waitingKeys(done) });
};

// ── Resize view ──

/** The text of the resize view while it lists the registry again. */
export const LISTING_TEXT = "talk: listing sessions";

/** The resize text for `columns` cells: the longest whole cue of `preset` that fits; none without a cell. */
export const resizeText = (
  ui: HostUi,
  columns: number | undefined,
  preset: SymbolPreset,
): string => {
  const width = Math.max(0, columns ?? 0);
  return RESIZE_CUES[preset].find((text) => ui.visibleWidth(text) <= width) ?? "";
};

/**
 * The resize view (G3): a full-screen overlay whose root is one `text` node,
 * with no frame, no title, and no hint. omp's bare sheet centers the one row
 * vertically on the screen, so a one-row pane shows only it. It reads
 * `ui.size()` on each draw. When the list fits again, the view stays open,
 * shows `talk: listing sessions`, and runs `relist` once; it ends with the
 * fresh listing, so a talk view holds the focus until the list mounts.
 * Enter, `h`, and every other key do nothing; `escape` and `alt+t` end the
 * flow, whose abort signal stops the listing. `preset` picks the symbol cue
 * of a narrow pane.
 */
export const resizeView = <R>(
  ui: HostUi,
  size: SizeReader,
  preset: SymbolPreset,
  relist: () => Promise<R>,
  done: (choice: Waited<R>) => void,
): JSXNode => {
  const listing = ui.signal(false);
  const start = (): void => {
    if (listing.peek()) return;
    listing.set(true);
    settleWith(relist, done);
  };
  if (listLayout(size()).fits) start();
  return ui.jsx("text", {
    text: () => {
      // The current size decides first: the progress text shows only while the list fits.
      const current = size();
      if (!listLayout(current).fits) return resizeText(ui, current?.columns, preset);
      if (listing()) return LISTING_TEXT;
      // A draw at a size that fits starts the listing after the draw.
      queueMicrotask(start);
      return LISTING_TEXT;
    },
    onKey: waitingKeys(done),
  });
};

// ── Compose view ──

/** How a text view ends: the compose view, or the handover review. */
export type TextChoice =
  | { readonly _tag: "Confirm"; readonly text: string }
  | { readonly _tag: "Cancel" };

/**
 * Applies one edit of a text field (T1). The inserted text passes `clean`,
 * `safeMultiline` by default, so no escape sequence or other control
 * character reaches the field or the send; the caret of a cleaned insertion
 * goes to its end. A stale edit saw another text, and pi-tui says to ignore
 * it.
 */
export const applyEdit = (
  draft: Signal<string>,
  cursor: Signal<number>,
  edit: ViewEdit,
  clean: (text: string) => string = safeMultiline,
): void => {
  const before = draft.peek();
  if (edit.len !== before.length) return;
  const text = clean(edit.text);
  draft.set(before.slice(0, edit.from) + text + before.slice(edit.to));
  cursor.set(text === edit.text ? edit.cursor : edit.from + text.length);
};

/**
 * Text for the one-line compose field (R3): `safeMultiline`, then each line
 * feed becomes a space, so the field shows the whole draft that it sends.
 */
export const safeOneLine = (text: string): string => safeMultiline(text).replaceAll("\n", " ");

/** The cells of an empty compose row that the placeholder cannot use: the caret bar and the free cell before the placeholder. */
export const COMPOSE_PLACEHOLDER_CHROME = 2;

/**
 * The placeholder of the compose field in `columns` cells (R6, L2). The
 * editor painter of omp 19.2.1 draws the caret of an empty field as a bar in
 * one cell (`editor.ts` v19.2.1:589-591) and then the placeholder only when
 * at least one cell stays free before it (`editor.ts` v19.2.1:614-615), so
 * the text takes at most `columns - 2` cells: the destination first, and the
 * key help only while it fits.
 */
export const composePlaceholder = (
  ui: HostUi,
  destination: Destination,
  columns: number | undefined,
): string => {
  const target = `To ${shownName(destination)}`;
  const budget = Math.max(0, (columns ?? 0) - COMPOSE_PLACEHOLDER_CHROME);
  const fitting = [
    `${target}: the message; ⏎ confirms the destination, ⎋ cancels`,
    `${target} · ⏎ confirm · ⎋ cancel`,
    target,
  ].find((text) => ui.visibleWidth(text) <= budget);
  return fitting ?? ui.truncate(target, budget);
};

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
  size: SizeReader,
  destination: Destination,
  text: string,
  done: (choice: TextChoice) => void,
): JSXNode => {
  const draft = ui.signal(text);
  const cursor = ui.signal(text.length);
  return ui.jsx("input", {
    text: () => draft(),
    cursor: () => cursor(),
    placeholder: () => composePlaceholder(ui, destination, size()?.columns),
    onEdit: (edit: ViewEdit) => {
      applyEdit(draft, cursor, edit, safeOneLine);
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

/**
 * The first line of the confirm view (G3). A handover that the `talk` tool
 * started names the agent as its starter on this line, so the user sees who
 * started it at the point of approval (#260 H2).
 */
export const confirmLine = (instanceId: string, code: string, byAgent: boolean): string =>
  byAgent
    ? `Send to ${instanceId} (a handover that the agent started): type ${code}`
    : `Send to ${instanceId}: type ${code}`;

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
  /** The `talk` tool started the handover (#260 H2). */
  readonly byAgent: boolean;
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * The confirm view: a `col` root whose first line names the full instance
 * id and the code, then the name and folder, the kind, and the first line of
 * the text, each cut to one row (G3). The first line of a handover that the
 * `talk` tool started also says that the agent started it (#260 H2). Only
 * the two code letters, typed as two separate presses, send. A repeat event,
 * a paste, a key after a paste, or any other key clears the typed letters;
 * `enter` sends nothing. While the first line does not fit the width, the
 * view shows only a request for a wider pane, and no key sends. `escape`
 * returns to the compose view; `alt+t` closes the flow.
 */
export const confirmView = (
  ui: HostUi,
  size: SizeReader,
  destination: Destination,
  content: ConfirmContent,
  done: (choice: ConfirmChoice) => void,
): JSXNode => {
  const typed = ui.signal("");
  const first = confirmLine(destination.instanceId, content.code, content.byAgent);
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
