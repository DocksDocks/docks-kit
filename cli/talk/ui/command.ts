/**
 * The `/talk` command and its flows (plan #251 G1 to G3, G6).
 *
 * `/talk` opens the session list; `/talk <target>` opens the compose view
 * for the one pair that the target resolves to; `/talk handover <target>`
 * starts handover to that pair, and `/talk handover` opens the list in
 * handover mode (G2). `h` in the normal list starts handover to the selected
 * row. The `alt+t` shortcut opens the list (G4).
 *
 * Each binding runs at most one flow at a time, tied to the session id of
 * the context that started it. A flow ends when another flow starts, when
 * the binding calls `end` (a session transition, `session_clear`, or
 * shutdown), and when the session id differs from the one it started in.
 * An ended flow aborts its listing or side turn, closes its open view
 * through the view's own `done`, mounts no other view, and sends nothing. A
 * flow calls only `ctx.ui.custom` and `ctx.ui.notify` (#248 D9).
 *
 * This module runs no effect: the binding in `cli/talk/extension.ts` gives
 * each flow the listing, the resolver, the pair send, and the side turn as
 * promises.
 */
import { Predicate } from "effect";

import type { JSXNode } from "@oh-my-pi/pi-tui";

import { oneLine } from "../tool/attachments";
import type { DeliverKind } from "../tool/protocol";
import type { Target } from "../transport/request";
import {
  HANDOVER_NO_SIDE_TURN,
  HANDOVER_STARTED,
  type SideTurn,
  requestDraft,
  reviewView,
} from "./handover";
import type { HostUi } from "./host";
import {
  CLOSE_KEY,
  type ConfirmChoice,
  type Destination,
  TALK_SHORTCUT,
  type ListChoice,
  type Waited,
  type ListMode,
  type ListRow,
  type SizeReader,
  type TextChoice,
  type ViewKey,
  composeView,
  confirmView,
  drawCode,
  listView,
  pendingView,
  resizeView,
  sizeReader,
} from "./views";

export const TALK_COMMAND = "talk";
export const TALK_COMMAND_DESCRIPTION =
  "Talk to other live omp sessions: /talk opens the list, /talk <session> composes a message, /talk handover <session> hands over the work";
export const TALK_SHORTCUT_DESCRIPTION = "Open the talk session list";

/** The word that starts the handover sub-command (G2). */
export const HANDOVER_WORD = "handover";

/** G1: the notice of `/talk` and `alt+t` outside the TUI. */
export const VIEWS_NEED_TUI =
  "talk: the /talk views need an interactive omp session in a terminal or in Tern. The talk tool works in every mode.";

// ── Arguments (G2) ──

/** What `/talk` asks for, decoded from the argument text. */
export type TalkCommand =
  | { readonly _tag: "List" }
  | { readonly _tag: "Compose"; readonly target: string }
  | { readonly _tag: "Handover"; readonly target: string | undefined };

const WHITESPACE = /\s+/u;

/**
 * Decodes the argument text of `/talk` (G2). The word `handover` as the first
 * argument always starts the sub-command; every other text is one target, so
 * a session name with spaces works.
 */
export const parseTalkArgs = (args: string): TalkCommand => {
  const trimmed = args.trim();
  if (trimmed === "") return { _tag: "List" };
  const [first = ""] = trimmed.split(WHITESPACE, 1);
  if (first !== HANDOVER_WORD) return { _tag: "Compose", target: trimmed };
  const rest = trimmed.slice(HANDOVER_WORD.length).trim();
  return { _tag: "Handover", target: rest === "" ? undefined : rest };
};

/** One completion item of omp (`AutocompleteItem` v19.2.1): `value` replaces the argument text. */
export interface TalkCompletion {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** A name that completion can offer as it is: one line, no outer spaces, not empty. */
const offerable = (name: string): boolean =>
  name !== "" && name.trim() === name && oneLine(name) === name;

/**
 * Synchronous completion of `/talk` (F1, G2): `handover` and the names of the
 * binding's last listing snapshot. After `handover `, it offers the names as
 * handover targets. A name whose first word is `handover` is reached from the
 * list, so plain completion leaves it out.
 */
export const talkCompletions = (
  prefix: string,
  names: ReadonlyArray<string>,
): Array<TalkCompletion> | null => {
  const unique = [...new Set(names)].filter(offerable);
  const lead = prefix.trimStart();
  const handoverLead = `${HANDOVER_WORD} `;
  const items: Array<TalkCompletion> = lead.startsWith(handoverLead)
    ? unique
        .filter((name) => name.startsWith(lead.slice(handoverLead.length).trimStart()))
        .map((name) => ({
          value: `${handoverLead}${name}`,
          label: name,
          description: "hand over to this session",
        }))
    : [
        ...(HANDOVER_WORD.startsWith(lead)
          ? [{ value: HANDOVER_WORD, label: HANDOVER_WORD, description: "hand over the work" }]
          : []),
        ...unique
          .filter((name) => name.startsWith(lead) && name.split(WHITESPACE, 1)[0] !== HANDOVER_WORD)
          .map((name) => ({ value: name, label: name, description: "talk session" })),
      ];
  return items.length === 0 ? null : items;
};

// ── Flow services ──

/**
 * The options of each flow view: every view is an overlay, so no other view
 * of omp replaces it in the editor slot (C2). `onHandle` gets the overlay
 * handle of omp (`ExtensionOverlayHandle` v19.2.1).
 */
export interface ViewOptions {
  readonly overlay: true;
  readonly fullscreen: boolean;
  readonly onHandle: (handle: unknown) => void;
}

/** The `ctx.ui` methods that a flow calls; no other (#248 D9). */
export interface FlowUi {
  /** `ctx.ui.custom(factory, options)`: omp calls the factory with `(ui, theme, keybindings, done)`. */
  readonly custom: (
    factory: (
      ui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => JSXNode,
    options: ViewOptions,
  ) => Promise<unknown>;
  readonly notify: (text: string, level: "info" | "warning" | "error") => void;
}

export type ListingAnswer =
  | { readonly _tag: "Listed"; readonly rows: ReadonlyArray<ListRow> }
  | { readonly _tag: "Failed"; readonly text: string };

export type TargetAnswer =
  | { readonly _tag: "Resolved"; readonly destination: Destination }
  | { readonly _tag: "Failed"; readonly text: string };

/** The result of one send, with the text of the tool result (E5). */
export interface SendAnswer {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * The life of one flow, as its services see it (G3). The services run each
 * transport call with `signal`, so the end of the flow interrupts the call,
 * and they start no call while `live` is false.
 */
export interface FlowLife {
  readonly signal: AbortSignal;
  /** True while the flow goes on; a changed session id ends the flow and reads false. */
  readonly live: () => boolean;
}

/** What one flow reads and calls, bound to the context that started it. */
export interface FlowServices {
  /** The session id of the flow's context now. */
  readonly sessionId: () => string;
  /** The typed listing; its probed rows refresh the completion snapshot. */
  readonly list: (life: FlowLife) => Promise<ListingAnswer>;
  /** The E8 resolver of a `/talk <target>` text. */
  readonly resolve: (target: string, life: FlowLife) => Promise<TargetAnswer>;
  /** The send to one exact pair through the `instance` path (G3), as a message or a handover (G6). */
  readonly send: (
    pair: Target,
    text: string,
    kind: DeliverKind,
    life: FlowLife,
  ) => Promise<SendAnswer>;
  /** `ctx.runEphemeralTurn` of the flow's context; undefined when the host has none (F7). */
  readonly sideTurn: SideTurn | undefined;
}

// ── Flow slot (G3) ──

export interface FlowSlot {
  /** Runs one flow; a running flow ends first. It reports its errors with `notify` and never rejects. */
  readonly run: (ui: FlowUi, services: FlowServices, command: TalkCommand) => Promise<void>;
  /** Ends the running flow. */
  readonly end: () => void;
  /**
   * Ends the running flow when its session id changed, and cancels its open
   * view when omp closed that view without `done`.
   */
  readonly check: () => void;
}

/** The open view of a flow: the overlay handle that omp gave, and the cancel of the view. */
interface OpenView {
  handle: unknown;
  cancel: () => void;
}

interface Flow {
  readonly controller: AbortController;
  readonly sessionId: string;
  readonly services: FlowServices;
  readonly life: FlowLife;
  view: OpenView | undefined;
  /**
   * Closes the outgoing view: a view that settled while the flow goes on
   * stays shown and focused until the next talk view mounts (round 8).
   */
  held: (() => void) | undefined;
}

const TALK_PREFIX = "talk: ";

/** The text of a flow error with exactly one `talk:` prefix, whether its cause has one or not. */
export const talkErrorText = (cause: unknown): string => {
  const text = Predicate.isError(cause) ? cause.message : String(cause);
  return text.startsWith(TALK_PREFIX) ? text : `${TALK_PREFIX}${text}`;
};

/** The list, the confirm view, and the handover review own the whole screen; compose docks at the bottom. */
const FULL_SCREEN = true;
const DOCKED = false;

/** The waiting view of a handover side turn. */
export const HANDOVER_WAITING = "talk: a side turn writes the handover summary · ⎋ cancels";

/** The waiting view of a send. */
export const sendingText = (destination: Destination): string =>
  `talk: sending to ${destination.instanceId} · ⎋ stops waiting`;

/** The result of a waited step: undefined after a close; a rejection goes to the flow's error notice. */
const resultOf = <R>(waited: Waited<R>): R | undefined => {
  if (waited._tag === "Failed") throw waited.cause;
  return waited._tag === "Ready" ? waited.result : undefined;
};

/** The `_tag` of a view choice. */
const tagOf = (value: unknown): unknown =>
  Predicate.hasProperty(value, "_tag") ? value._tag : undefined;

/**
 * The host UI of one view (round 8, round 9): each node with `onKey`,
 * `onEdit`, or `onPaste` gets its input while the view is open. A settled
 * view that omp still shows consumes every key: `escape` and `alt+t` end
 * the flow, and every other key does nothing, so no key reaches the
 * composer before the next talk view mounts. A settled text field also
 * consumes each paste, so no paste reaches its widget, and it ignores each
 * late edit, also an edit that Tern reports to it. So its text stays the
 * text that the view settled with.
 */
const settledInput = (ui: HostUi, isOpen: () => boolean, end: () => void): HostUi => ({
  ...ui,
  jsx: (kind, props, key) => {
    const onKey = props["onKey"];
    const onEdit = props["onEdit"];
    const onPaste = props["onPaste"];
    const guarded: Record<string, unknown> = { ...props };
    if (Predicate.isFunction(onKey))
      guarded["onKey"] = (event: ViewKey): boolean => {
        if (isOpen()) return Reflect.apply(onKey, undefined, [event]) === true;
        if (event.kind !== "release" && (event.id === CLOSE_KEY || event.id === TALK_SHORTCUT))
          end();
        return true;
      };
    if (Predicate.isFunction(onEdit))
      guarded["onEdit"] = (edit: unknown): void => {
        if (isOpen()) Reflect.apply(onEdit, undefined, [edit]);
      };
    // A text field gets a paste handler, so a held field takes no paste; an open one gives it to its widget.
    if (Predicate.isFunction(onEdit) || Predicate.isFunction(onPaste))
      guarded["onPaste"] = (paste: unknown): boolean => {
        if (!isOpen()) return true;
        return Predicate.isFunction(onPaste) && Reflect.apply(onPaste, undefined, [paste]) === true;
      };
    return ui.jsx(kind, guarded, key);
  },
});

export interface FlowSlotOptions {
  /** Default: `drawCode` of `views.ts` with `crypto.randomInt`. */
  readonly drawCode?: ((last: string | undefined) => string) | undefined;
}

/** The flow slot of one binding. */
export const makeFlowSlot = (ui: HostUi, options: FlowSlotOptions = {}): FlowSlot => {
  const nextCode = options.drawCode ?? ((last: string | undefined) => drawCode(last));
  let current: Flow | undefined;
  /** The last confirm code of this binding, so each confirm view draws another. */
  let lastCode: string | undefined;

  /** The flow may go on: not ended, and its session id is the one it started in. */
  const live = (flow: Flow): boolean => {
    if (flow.controller.signal.aborted) return false;
    let same = false;
    try {
      same = flow.services.sessionId() === flow.sessionId;
    } catch {
      // A context that cannot name its session no longer serves the flow.
    }
    if (!same) flow.controller.abort();
    return same;
  };

  /** Waits for `promise`, or for the end of the flow. */
  const untilEnded = <A>(flow: Flow, promise: Promise<A>): Promise<A | undefined> => {
    const { signal } = flow.controller;
    if (signal.aborted) return Promise.resolve(undefined);
    const ended = Promise.withResolvers<undefined>();
    const onAbort = (): void => {
      ended.resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.race([promise, ended.promise]).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  };

  /** Closes the outgoing view of the flow, if one is held. */
  const release = (flow: Flow): void => {
    const close = flow.held;
    flow.held = undefined;
    close?.();
  };

  /**
   * Mounts one view as an overlay and resolves with its choice (G3).
   *
   * A choice that is not `ended` leaves the view shown and focused until the
   * factory of the next view of the flow runs, in the microtasks after the
   * key: a key that omp dispatches before them still reaches a talk view,
   * never the composer. A settled view consumes every key: `escape` and
   * `alt+t` end the flow, and every other key does nothing. A settled text
   * field consumes each paste and ignores each late edit. The outgoing view closes
   * inside the next factory, before omp opens the next overlay, because omp
   * gives the focus back to the node that was focused when an overlay
   * opened (`overlays.ts` v19.2.1:63-79); a closed talk view must not be that
   * node. A choice equal to `ended` ends the flow at once, before any later
   * key runs. The view closes through its own `done` with `ended` when the
   * flow ends, and `check` cancels it with `ended` when omp closed its
   * overlay without `done`.
   */
  const mount = <T>(
    flow: Flow,
    flowUi: FlowUi,
    build: (viewUi: HostUi, size: SizeReader, done: (choice: T) => void) => JSXNode,
    ended: T,
    fullscreen: boolean,
  ): Promise<T> => {
    if (!live(flow)) return Promise.resolve(ended);
    const { controller } = flow;
    const { signal } = controller;
    const settled = Promise.withResolvers<T>();
    const view: OpenView = { handle: undefined, cancel: () => undefined };
    flow.view = view;
    flowUi
      .custom(
        (host, _theme, _keybindings, done) => {
          // The outgoing view closes now, before omp opens this overlay.
          release(flow);
          let open = true;
          let building = true;
          const finish = (value: T): void => {
            if (!open) return;
            open = false;
            signal.removeEventListener("abort", onAbort);
            if (flow.view === view) flow.view = undefined;
            if (tagOf(value) === tagOf(ended)) controller.abort();
            // omp mounts no view whose `done` ran while its factory ran, and an ended flow mounts
            // no next view: both close at once. Otherwise the view waits for the next one.
            if (signal.aborted || building) done(value);
            else {
              release(flow);
              flow.held = () => {
                done(value);
              };
            }
            settled.resolve(value);
          };
          const onAbort = (): void => {
            finish(ended);
          };
          view.cancel = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
          // omp can run the factory after the flow ended; the view then closes at once.
          if (!live(flow)) finish(ended);
          const node = build(
            settledInput(
              ui,
              () => open,
              () => {
                controller.abort();
              },
            ),
            sizeReader(host),
            finish,
          );
          building = false;
          return node;
        },
        {
          overlay: true,
          fullscreen,
          onHandle: (handle) => {
            view.handle = handle;
          },
        },
      )
      .catch((error: unknown) => {
        // A failed mount ends the flow with its error.
        settled.reject(error);
      });
    return settled.promise;
  };

  /**
   * Runs one talk step while a docked waiting view holds the focus, so no key
   * reaches the composer of omp between two talk views. `escape` and `alt+t`
   * end the flow, whose abort signal stops the step.
   */
  const waitFor = <R>(
    flow: Flow,
    flowUi: FlowUi,
    text: string,
    task: () => Promise<R>,
  ): Promise<Waited<R>> =>
    mount<Waited<R>>(
      flow,
      flowUi,
      // omp can run the factory after the flow ended; the step then does not start.
      (viewUi, _size, done) =>
        pendingView(
          viewUi,
          text,
          () => (live(flow) ? task() : Promise.reject(new Error("the /talk flow ended"))),
          done,
        ),
      { _tag: "Close" },
      DOCKED,
    );

  /** A view that edits the text of one send: compose, or the handover review. */
  type EditView = (
    viewUi: HostUi,
    size: SizeReader,
    text: string,
    done: (choice: TextChoice) => void,
  ) => JSXNode;

  /**
   * Edit, confirm, and send to one destination (G3, G6). `escape` in the
   * confirm view returns to the edit view with the text kept. A flow that
   * ended while the send ran posts no notice: the send stopped before its
   * request, or the request went out and the peer can hold the text.
   */
  const editConfirmSend = async (
    flow: Flow,
    flowUi: FlowUi,
    destination: Destination,
    kind: DeliverKind,
    first: string,
    edit: EditView,
    fullscreen: boolean,
  ): Promise<void> => {
    let text = first;
    for (;;) {
      const edited = await mount<TextChoice>(
        flow,
        flowUi,
        (viewUi, size, done) => edit(viewUi, size, text, done),
        { _tag: "Cancel" },
        fullscreen,
      );
      if (edited._tag !== "Confirm") return;
      text = edited.text;
      const code = nextCode(lastCode);
      lastCode = code;
      const confirmed = await mount<ConfirmChoice>(
        flow,
        flowUi,
        (viewUi, size, done) => confirmView(viewUi, size, destination, { kind, text, code }, done),
        { _tag: "Close" },
        FULL_SCREEN,
      );
      if (confirmed._tag === "Back") continue;
      if (confirmed._tag !== "Send" || !live(flow)) return;
      const pair: Target = { instanceId: destination.instanceId, sessionId: destination.sessionId };
      // A talk view holds the focus while the send runs; `escape` ends the flow and its signal.
      const sent = resultOf(
        await waitFor(flow, flowUi, sendingText(destination), () =>
          flow.services.send(pair, text, kind, flow.life),
        ),
      );
      if (sent === undefined || !live(flow)) return;
      if (sent.ok) flowUi.notify(sent.text, "info");
      else flowUi.notify(talkErrorText(sent.text), "error");
      return;
    }
  };

  /**
   * G6: a side turn writes the draft with the flow's signal; the review, the
   * confirm view, and the send follow. A flow that ended while the side turn
   * ran mounts no review.
   */
  const handover = async (flow: Flow, flowUi: FlowUi, destination: Destination): Promise<void> => {
    // A flow that ended at the key that chose the handover shows nothing more.
    if (!live(flow)) return;
    const { sideTurn } = flow.services;
    if (sideTurn === undefined) {
      flowUi.notify(HANDOVER_NO_SIDE_TURN, "error");
      return;
    }
    flowUi.notify(HANDOVER_STARTED, "info");
    // A talk view holds the focus while the side turn runs; `escape` ends the flow and aborts it.
    const draft = resultOf(
      await waitFor(flow, flowUi, HANDOVER_WAITING, () =>
        requestDraft(sideTurn, flow.controller.signal),
      ),
    );
    if (draft === undefined || !live(flow)) return;
    if (draft._tag === "Failed") {
      flowUi.notify(draft.text, "error");
      return;
    }
    await editConfirmSend(
      flow,
      flowUi,
      destination,
      "handover",
      draft.text,
      (viewUi, size, text, done) => reviewView(viewUi, size, text, done),
      FULL_SCREEN,
    );
  };

  const compose = (flow: Flow, flowUi: FlowUi, destination: Destination): Promise<void> =>
    editConfirmSend(
      flow,
      flowUi,
      destination,
      "message",
      "",
      (viewUi, size, text, done) => composeView(viewUi, size, destination, text, done),
      DOCKED,
    );

  /** The rows of one listing answer; undefined after an end or after the error notice. */
  const rowsOf = (
    flow: Flow,
    flowUi: FlowUi,
    answer: ListingAnswer | undefined,
  ): ReadonlyArray<ListRow> | undefined => {
    if (answer === undefined || !live(flow)) return undefined;
    if (answer._tag === "Listed") return answer.rows;
    flowUi.notify(talkErrorText(answer.text), "error");
    return undefined;
  };

  const listFlow = async (flow: Flow, flowUi: FlowUi, mode: ListMode): Promise<void> => {
    let rows = rowsOf(flow, flowUi, await untilEnded(flow, flow.services.list(flow.life)));
    let preferred: Target | undefined;
    // G3: while the list does not fit, the resize view stands in for it. When the list fits
    // again, the resize view lists again and stays open until the rows are ready, so a talk
    // view keeps the focus; the rows leave out ended registrations, and the list selects
    // the pair that it selected before, while that pair is listed.
    while (rows !== undefined) {
      const shown = rows;
      const choice = await mount<ListChoice>(
        flow,
        flowUi,
        (viewUi, size, done) => listView(viewUi, size, shown, mode, done, preferred),
        { _tag: "Close" },
        FULL_SCREEN,
      );
      switch (choice._tag) {
        case "Close":
          return;
        case "TooSmall": {
          const resized = await mount<Waited<ListingAnswer>>(
            flow,
            flowUi,
            (viewUi, size, done) =>
              resizeView(viewUi, size, () => flow.services.list(flow.life), done),
            { _tag: "Close" },
            FULL_SCREEN,
          );
          preferred = choice.selected;
          rows = rowsOf(flow, flowUi, resultOf(resized));
          continue;
        }
        case "Handover":
          await handover(flow, flowUi, choice.row);
          return;
        case "Compose":
          await compose(flow, flowUi, choice.row);
          return;
      }
    }
  };

  /** The one pair of a `/talk` target, resolved before any view opens (G2); undefined after a notice or an end. */
  const resolveTarget = async (
    flow: Flow,
    flowUi: FlowUi,
    target: string,
  ): Promise<Destination | undefined> => {
    const answer = await untilEnded(flow, flow.services.resolve(target, flow.life));
    if (answer === undefined || !live(flow)) return undefined;
    if (answer._tag === "Resolved") return answer.destination;
    flowUi.notify(talkErrorText(answer.text), "error");
    return undefined;
  };

  const steps = async (flow: Flow, flowUi: FlowUi, command: TalkCommand): Promise<void> => {
    switch (command._tag) {
      case "List":
        await listFlow(flow, flowUi, "message");
        return;
      case "Handover": {
        if (command.target === undefined) {
          await listFlow(flow, flowUi, "handover");
          return;
        }
        const destination = await resolveTarget(flow, flowUi, command.target);
        if (destination !== undefined) await handover(flow, flowUi, destination);
        return;
      }
      case "Compose": {
        const destination = await resolveTarget(flow, flowUi, command.target);
        if (destination !== undefined) await compose(flow, flowUi, destination);
        return;
      }
    }
  };

  return {
    run: async (flowUi, services, command) => {
      current?.controller.abort();
      const controller = new AbortController();
      let sessionId: string;
      try {
        sessionId = services.sessionId();
      } catch (error) {
        flowUi.notify(talkErrorText(error), "error");
        return;
      }
      const flow: Flow = {
        controller,
        sessionId,
        services,
        life: { signal: controller.signal, live: () => live(flow) },
        view: undefined,
        held: undefined,
      };
      current = flow;
      try {
        await steps(flow, flowUi, command);
      } catch (error) {
        if (live(flow)) flowUi.notify(talkErrorText(error), "error");
      } finally {
        flow.controller.abort();
        release(flow);
        if (current === flow) current = undefined;
      }
    },
    end: () => {
      current?.controller.abort();
    },
    check: () => {
      if (current === undefined || !live(current)) return;
      const handle = current.view?.handle;
      // omp closed the overlay without `done`: the view reads as cancelled (C2).
      if (Predicate.hasProperty(handle, "closed") && handle.closed === true) current.view?.cancel();
    },
  };
};
