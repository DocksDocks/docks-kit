/**
 * The host interface of the talk receiver (#250 Step 3). `extension.ts` fills
 * it from omp's `pi` and `ctx` (Step 4); the tests fill it with a fake
 * session. Every method reads or acts on the session of one factory binding.
 */
import { Option, Predicate, Schema } from "effect";

import type { Target } from "../transport/request";
import { ATTACHMENT_KINDS } from "./attachments";
import { MessageId, MessageKind, Sender, SentAt } from "./protocol";

/** The `customType` of every talk message in a transcript. */
export const TALK_MESSAGE_TYPE = "talk";

/**
 * How the session runs (`ctx.mode`): `tui` and `rpc` stay open, `print` and
 * `json` run one task and exit (E5). An ACP session shows `rpc`.
 */
export type SessionMode = "tui" | "rpc" | "print" | "json";

/** The version of the `details` of a talk message (#251 G5). */
export const TALK_DETAILS_VERSION = 1;

/** Whether a message of each kind names an ask: an ask its own id, a reply the ask that it answers. */
const NAMES_ASK: Record<MessageKind, boolean> = {
  message: false,
  ask: true,
  reply: true,
  handover: false,
};

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The UTF-16 start and end of the sender's text in `content`. */
const BodyRange = Schema.Struct({ start: Offset, end: Offset }).check(
  Schema.makeFilter((range) =>
    range.start <= range.end ? undefined : "the body range ends before it starts",
  ),
);

/**
 * The `details` of a talk message (#251 G5): the message id that the
 * confirmation looks for (#250 E4), and the parts that the message card
 * shows. `askId` is the id of an ask, or the ask that a reply answers.
 */
export const TalkDetails = Schema.Struct({
  v: Schema.Literal(TALK_DETAILS_VERSION),
  messageId: MessageId,
  kind: MessageKind,
  from: Sender,
  sentAt: SentAt,
  askId: Schema.optionalKey(MessageId),
  attachments: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(ATTACHMENT_KINDS), name: Schema.NonEmptyString }),
  ),
  body: BodyRange,
}).check(
  Schema.makeFilter((details) =>
    NAMES_ASK[details.kind] === (details.askId !== undefined)
      ? undefined
      : `a ${details.kind} ${NAMES_ASK[details.kind] ? "needs" : "takes no"} askId`,
  ),
);
export type TalkDetails = typeof TalkDetails.Type;

/** A displayed custom message, as `pi.sendMessage` takes it. */
export interface TalkMessage {
  readonly customType: typeof TALK_MESSAGE_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: TalkDetails;
}

/** The text and the details of a talk message whose body range lies inside its text. */
const TalkMessageView = Schema.Struct({ content: Schema.String, details: TalkDetails }).check(
  Schema.makeFilter((message) =>
    message.details.body.end <= message.content.length
      ? undefined
      : "the body range lies outside the content",
  ),
);
export type TalkMessageView = typeof TalkMessageView.Type;

const decodeView = Schema.decodeUnknownOption(TalkMessageView);

/**
 * The text and the details of a talk message, else undefined: a message of
 * #250 has only `details.messageId`, and a body range outside the text is
 * refused.
 */
export const decodeTalkMessage = (message: unknown): TalkMessageView | undefined =>
  Option.getOrUndefined(decodeView(message));

/** The options of `pi.sendMessage`: `triggerTurn` requests a turn (E4, E5). */
export interface SendOptions {
  readonly triggerTurn: boolean;
}

export interface TalkHost {
  /**
   * The activity check of E3: the `talk_active` row of this factory binding
   * is in `pi.getAllTools()` with its own `parameters` object and its source
   * path. A throw counts as inactive.
   */
  readonly isActive: () => boolean;
  /** `ctx.sessionManager.getSessionId()`. */
  readonly sessionId: () => string;
  /** `ctx.sessionManager.getSessionFile()`; undefined for a session without a file. */
  readonly sessionFile: () => string | undefined;
  /**
   * The entries of the session, read only: omp's live `getEntriesView()`
   * where it exists, else the copy of `getEntries()`. The confirmation reads
   * only the entries after its last read of the same list (E4).
   */
  readonly entries: () => ReadonlyArray<unknown>;
  /** `ctx.isIdle()`. */
  readonly isIdle: () => boolean;
  /** `ctx.hasPendingMessages()`. */
  readonly hasPendingMessages: () => boolean;
  /** `ctx.mode`. */
  readonly mode: () => SessionMode;
  /** `pi.sendMessage(message, options)`. */
  readonly sendMessage: (message: TalkMessage, options: SendOptions) => void;
  /**
   * The guard found a session id that differs from the registration while no
   * transition was pending: a change that the extension did not see. The
   * host applies E7: it withdraws the registration and registers the
   * current session id.
   */
  readonly unseenSessionChange: (registration: Target) => void;
}

/** A session transition: `switch`, `branch`, or `tree` (E2). */
export type TransitionKind = "switch" | "branch" | "tree";

/** `session_before_switch`, `session_before_branch`, or `session_before_tree`. Tree events carry no `reason`. */
export interface BeforeTransition {
  readonly kind: TransitionKind;
  readonly reason?: string | undefined;
}

/** `session_switch`, `session_branch`, or `session_tree`. Tree events carry neither field. */
export interface AfterTransition {
  readonly kind: TransitionKind;
  readonly reason?: string | undefined;
  readonly previousSessionFile?: string | undefined;
}

/** Stops a scheduled callback; a second call does nothing. */
export type CancelTimer = () => void;

/** Time and timers of the receiver, so tests can use a fake clock. */
export interface TalkClock {
  /** Epoch milliseconds, for message timestamps only: the wall clock can step back or forward. */
  readonly now: () => number;
  /**
   * Monotonic milliseconds from an arbitrary start, for deadlines and ages: a
   * step of the wall clock does not change it.
   */
  readonly elapsed: () => number;
  /** Runs `callback` in a fresh task after `delayMs`. */
  readonly schedule: (delayMs: number, callback: () => void) => CancelTimer;
}

/**
 * The clock of the process: `Date.now`, `performance.now`, and `setTimeout`.
 * A timer does not keep the process alive (`unref`), and a throw inside a
 * callback goes to `onError`, because a throw from a raw timer ends the omp
 * session.
 */
export const systemClock = (onError: (error: unknown) => void): TalkClock => ({
  now: () => Date.now(),
  elapsed: () => performance.now(),
  schedule: (delayMs, callback) => {
    const timer = setTimeout(() => {
      try {
        callback();
      } catch (error) {
        onError(error);
      }
    }, delayMs);
    timer.unref();
    return () => {
      clearTimeout(timer);
    };
  },
});

const isTalkEntry = (
  entry: unknown,
): entry is { readonly details: { readonly messageId: unknown } } =>
  Predicate.hasProperty(entry, "type") &&
  entry.type === "custom_message" &&
  Predicate.hasProperty(entry, "customType") &&
  entry.customType === TALK_MESSAGE_TYPE &&
  Predicate.hasProperty(entry, "details") &&
  Predicate.hasProperty(entry.details, "messageId");

/** The message id of a talk message entry of `getEntries()`, else undefined. */
export const talkMessageId = (entry: unknown): string | undefined =>
  isTalkEntry(entry) && Predicate.isString(entry.details.messageId)
    ? entry.details.messageId
    : undefined;
