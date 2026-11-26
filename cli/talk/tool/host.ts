/**
 * The host interface of the talk receiver (#250 Step 3). `extension.ts` fills
 * it from omp's `pi` and `ctx` (Step 4); the tests fill it with a fake
 * session. Every method reads or acts on the session of one factory binding.
 */
import { Predicate } from "effect";

import type { Target } from "../transport/request";

/** The `customType` of every talk message in a transcript. */
export const TALK_MESSAGE_TYPE = "talk";

/**
 * How the session runs (`ctx.mode`): `tui` and `rpc` stay open, `print` and
 * `json` run one task and exit (E5). An ACP session shows `rpc`.
 */
export type SessionMode = "tui" | "rpc" | "print" | "json";

/** The `details` of a talk message: the message id that the confirmation looks for (E4). */
export interface TalkMessageDetails {
  readonly messageId: string;
}

/** A displayed custom message, as `pi.sendMessage` takes it. */
export interface TalkMessage {
  readonly customType: typeof TALK_MESSAGE_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: TalkMessageDetails;
}

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
  /** `ctx.sessionManager.getEntries()`. */
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
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Runs `callback` in a fresh task after `delayMs`. */
  readonly schedule: (delayMs: number, callback: () => void) => CancelTimer;
}

/**
 * The clock of the process: `Date.now` and `setTimeout`. A timer does not
 * keep the process alive (`unref`), and a throw inside a callback goes to
 * `onError`, because a throw from a raw timer ends the omp session.
 */
export const systemClock = (onError: (error: unknown) => void): TalkClock => ({
  now: () => Date.now(),
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
