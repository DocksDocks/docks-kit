/**
 * The `/talk` command and its flows (plan #251 G1 to G3).
 *
 * `/talk` opens the session list; `/talk <target>` opens the compose view
 * for the one pair that the target resolves to; `/talk handover` and
 * `/talk handover <target>` are the handover sub-command (G2). The `alt+t`
 * shortcut opens the list (G4).
 *
 * Each binding runs at most one flow at a time, tied to the session id of
 * the context that started it. A flow ends when another flow starts, when
 * the binding calls `end` (a session transition, `session_clear`, or
 * shutdown), and when the session id differs from the one it started in.
 * An ended flow closes its open view through the view's own `done`, mounts
 * no other view, and sends nothing. A flow calls only `ctx.ui.custom` and
 * `ctx.ui.notify` (#248 D9).
 *
 * This module runs no effect: the binding in `cli/talk/extension.ts` gives
 * each flow the listing, the resolver, and the pair send as promises.
 */
import { Predicate } from "effect";

import type { JSXNode } from "@oh-my-pi/pi-tui";

import { oneLine } from "../tool/attachments";
import type { Target } from "../transport/request";
import type { HostUi } from "./host";
import {
  type ComposeChoice,
  type ConfirmChoice,
  type Destination,
  type ListChoice,
  type ListRow,
  type SizeReader,
  composeView,
  confirmView,
  drawCode,
  listView,
  sizeReader,
} from "./views";

export const TALK_COMMAND = "talk";
export const TALK_COMMAND_DESCRIPTION =
  "Talk to other live omp sessions: /talk opens the list, /talk <session> composes a message";
export const TALK_SHORTCUT_DESCRIPTION = "Open the talk session list";

/** The word that starts the handover sub-command (G2). */
export const HANDOVER_WORD = "handover";

/** G1: the notice of `/talk` and `alt+t` outside the TUI. */
export const VIEWS_NEED_TUI =
  "talk: the /talk views need an interactive omp session in a terminal or in Tern. The talk tool works in every mode.";

/** Handover (G6) is not in this version; `/talk handover` and `h` in the list say so. */
export const HANDOVER_NOT_READY =
  "talk: handover is not available in this version of talk. Nothing was sent.";

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
    options: { readonly overlay: true; readonly fullscreen: true } | undefined,
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

/** What one flow reads and calls, bound to the context that started it. */
export interface FlowServices {
  /** The session id of the flow's context now. */
  readonly sessionId: () => string;
  /** The typed listing; it also refreshes the completion snapshot. */
  readonly list: () => Promise<ListingAnswer>;
  /** The E8 resolver of a `/talk <target>` text. */
  readonly resolve: (target: string) => Promise<TargetAnswer>;
  /** The send to one exact pair through the `instance` path (G3). */
  readonly send: (pair: Target, text: string) => Promise<SendAnswer>;
}

// ── Flow slot (G3) ──

export interface FlowSlot {
  /** Runs one flow; a running flow ends first. It reports its errors with `notify` and never rejects. */
  readonly run: (ui: FlowUi, services: FlowServices, command: TalkCommand) => Promise<void>;
  /** Ends the running flow. */
  readonly end: () => void;
  /** Ends the running flow when its session id changed. */
  readonly check: () => void;
}

interface Flow {
  readonly controller: AbortController;
  readonly sessionId: string;
  readonly services: FlowServices;
}

const TALK_PREFIX = "talk: ";

/** The text of a flow error with exactly one `talk:` prefix, whether its cause has one or not. */
export const talkErrorText = (cause: unknown): string => {
  const text = Predicate.isError(cause) ? cause.message : String(cause);
  return text.startsWith(TALK_PREFIX) ? text : `${TALK_PREFIX}${text}`;
};

const FULL_SCREEN = { overlay: true, fullscreen: true } as const;

/** The message kind that the confirm view names. Step 5 adds `handover`. */
const MESSAGE_KIND = "message";

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

  /**
   * Mounts one view and waits for its choice. The view closes through its own
   * `done` with `ended` when the flow ends; a view that omp closes without
   * `done` reads as `ended` too.
   */
  const mount = async <T>(
    flow: Flow,
    flowUi: FlowUi,
    build: (size: SizeReader, done: (choice: T) => void) => JSXNode,
    ended: T,
    overlay: typeof FULL_SCREEN | undefined,
  ): Promise<T> => {
    if (!live(flow)) return ended;
    const { signal } = flow.controller;
    let choice = ended;
    await flowUi.custom((host, _theme, _keybindings, done) => {
      let open = true;
      const finish = (value: T): void => {
        if (!open) return;
        open = false;
        signal.removeEventListener("abort", onAbort);
        choice = value;
        done(value);
      };
      const onAbort = (): void => {
        finish(ended);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // omp can run the factory after the flow ended; the view then closes at once.
      if (!live(flow)) finish(ended);
      return build(sizeReader(host), finish);
    }, overlay);
    return choice;
  };

  /** Compose, confirm, and send to one destination (G3). */
  const composeAndSend = async (
    flow: Flow,
    flowUi: FlowUi,
    destination: Destination,
  ): Promise<void> => {
    let text = "";
    for (;;) {
      const composed = await mount<ComposeChoice>(
        flow,
        flowUi,
        (_size, done) => composeView(ui, destination, text, done),
        { _tag: "Cancel" },
        undefined,
      );
      if (composed._tag !== "Confirm") return;
      text = composed.text;
      const code = nextCode(lastCode);
      lastCode = code;
      const confirmed = await mount<ConfirmChoice>(
        flow,
        flowUi,
        (size, done) =>
          confirmView(ui, size, destination, { kind: MESSAGE_KIND, text, code }, done),
        { _tag: "Close" },
        FULL_SCREEN,
      );
      if (confirmed._tag === "Back") continue;
      if (confirmed._tag !== "Send" || !live(flow)) return;
      const pair: Target = { instanceId: destination.instanceId, sessionId: destination.sessionId };
      const sent = await flow.services.send(pair, text);
      if (sent.ok) flowUi.notify(sent.text, "info");
      else flowUi.notify(talkErrorText(sent.text), "error");
      return;
    }
  };

  const listFlow = async (flow: Flow, flowUi: FlowUi): Promise<void> => {
    const answer = await untilEnded(flow, flow.services.list());
    if (answer === undefined || !live(flow)) return;
    if (answer._tag === "Failed") {
      flowUi.notify(talkErrorText(answer.text), "error");
      return;
    }
    const choice = await mount<ListChoice>(
      flow,
      flowUi,
      (size, done) => listView(ui, size, answer.rows, done),
      { _tag: "Close" },
      FULL_SCREEN,
    );
    switch (choice._tag) {
      case "Close":
        return;
      case "Handover":
        flowUi.notify(HANDOVER_NOT_READY, "warning");
        return;
      case "Compose":
        await composeAndSend(flow, flowUi, choice.row);
        return;
    }
  };

  const steps = async (flow: Flow, flowUi: FlowUi, command: TalkCommand): Promise<void> => {
    switch (command._tag) {
      case "List":
        await listFlow(flow, flowUi);
        return;
      case "Handover":
        flowUi.notify(HANDOVER_NOT_READY, "warning");
        return;
      case "Compose": {
        const answer = await untilEnded(flow, flow.services.resolve(command.target));
        if (answer === undefined || !live(flow)) return;
        if (answer._tag === "Failed") {
          flowUi.notify(talkErrorText(answer.text), "error");
          return;
        }
        await composeAndSend(flow, flowUi, answer.destination);
        return;
      }
    }
  };

  return {
    run: async (flowUi, services, command) => {
      current?.controller.abort();
      let flow: Flow;
      try {
        flow = { controller: new AbortController(), sessionId: services.sessionId(), services };
      } catch (error) {
        flowUi.notify(talkErrorText(error), "error");
        return;
      }
      current = flow;
      try {
        await steps(flow, flowUi, command);
      } catch (error) {
        flowUi.notify(talkErrorText(error), "error");
      } finally {
        flow.controller.abort();
        if (current === flow) current = undefined;
      }
    },
    end: () => {
      current?.controller.abort();
    },
    check: () => {
      if (current !== undefined) live(current);
    },
  };
};
