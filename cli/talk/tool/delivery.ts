/**
 * The receiver of the talk tool (#250 E2 to E6) for one factory binding: the
 * transition hold (E2), the synchronous guard (E3), the confirmation watch
 * (E4), the results, queue, wake, busy rules, and `cancel` (E5), and the
 * pending inbound asks (E6). It works on the host interface of `host.ts`,
 * which `extension.ts` fills from omp's `pi` and `ctx`.
 */
import { Effect, Schema } from "effect";

import { type AskStore, type PendingAsks, makePendingAsks } from "./asks";
import { type BodyRange, formatDelivery, formatReply } from "./format";
import {
  type AfterTransition,
  type BeforeTransition,
  type CancelTimer,
  type SessionMode,
  TALK_DETAILS_VERSION,
  TALK_MESSAGE_TYPE,
  type TalkDetails,
  type TalkClock,
  type TalkHost,
  type TransitionKind,
  talkMessageId,
} from "./host";
import {
  CANCEL_KIND,
  type CancelBody,
  type CancelResult,
  DELIVER_KIND,
  type DeliverBody,
  type DeliverResult,
  type MessageKind,
  REPLY_KIND,
  type ReplyBody,
  type ReplyResult,
  decodeCancelBody,
  decodeDeliverBody,
  decodeReplyBody,
  encodeCancelResult,
  encodeDeliverResult,
  encodeReplyResult,
} from "./protocol";
import type { RequestHandler, Target } from "../transport/request";

/** The longest time that a before-handler waits for the sends in flight (E2). */
export const SEND_WAIT_MS = 20_000;
/** The longest time that a hold lasts after its handler returned (E2). */
export const HOLD_MS = 30_000;
/** A request answers the outcome of a watch that ends within this time, else `submitted` (E4). */
export const ANSWER_WAIT_MS = 1_000;
/**
 * The watch reads the entries that omp appended since its last read, at this
 * interval after its microtask checks (E4).
 */
export const WATCH_INTERVAL_MS = 10;
/** A watch that sees neither the entry nor a session id change ends `unknown` after this time (E4). */
export const WATCH_LIMIT_MS = 10 * 60 * 1_000;
/**
 * The microtask turns after a send in which the watch reads `getEntries()`.
 * An idle send appends after two turns (F10). The count is finite because
 * each check queues the next turn, so an endless loop would starve the task.
 */
export const MICROTASK_CHECKS = 8;
/** A queue that cannot go out yet tries again after this time (E5). */
export const QUEUE_RETRY_MS = 100;
/** The most messages that the queue of one registration holds (E5); one more answers `busy`. */
export const MAX_QUEUED_MESSAGES = 64;
/** The most UTF-8 bytes of message text that the queue of one registration holds (E5). */
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** The finished outcomes that a receiver keeps for `cancel` answers; older ones read `not-found`. */
export const KEPT_OUTCOMES = 1_024;

/** `tui` and `rpc` sessions stay open, so a busy one queues; `print` and `json` answer `busy` (E5). */
const LONG_LIVED: Record<SessionMode, boolean> = {
  tui: true,
  rpc: true,
  print: false,
  json: false,
};

type MessageState = "queued" | "submitted" | "delivered" | "not-live" | "unknown" | "cancelled";
type WatchEnd = "delivered" | "not-live" | "unknown";

const FINAL: Record<MessageState, boolean> = {
  queued: false,
  submitted: false,
  delivered: true,
  "not-live": true,
  unknown: true,
  cancelled: true,
};

/** A message that this receiver accepted: its outcome for `cancel`. */
interface MessageRecord {
  readonly messageId: string;
  readonly senderSessionId: string;
  readonly instanceId: string;
  readonly isAsk: boolean;
  state: MessageState;
}

/** A message on its way out: a record does not keep the text, so kept outcomes stay small. */
interface Outgoing {
  readonly record: MessageRecord;
  readonly content: string;
  readonly details: TalkDetails;
  readonly triggerTurn: boolean;
}

interface QueuedMessage extends Outgoing {
  /** The UTF-8 size of `content`, counted against `MAX_QUEUED_BYTES`. */
  readonly bytes: number;
}

interface Watch {
  readonly record: MessageRecord;
  readonly sessionId: string;
  readonly deadline: number;
  readonly ended: Promise<WatchEnd>;
  readonly end: (outcome: WatchEnd) => void;
}

/** What a before-handler left: its event kind and, where present, its `reason` and session file. */
interface Hold {
  readonly kind: TransitionKind;
  readonly reason: string | undefined;
  readonly sessionFile: string | undefined;
}

/** One message on its way into the session. */
interface Incoming {
  readonly content: string;
  readonly details: TalkDetails;
  readonly triggerTurn: boolean;
  /** Runs when the receiver accepts the message: an ask becomes pending. */
  readonly onAccept: (() => void) | undefined;
}

/** The details that the receiver writes for a message (#251 G5). */
const talkDetails = (
  kind: MessageKind,
  body: DeliverBody | ReplyBody,
  range: BodyRange,
  askId: string | undefined,
): TalkDetails => ({
  v: TALK_DETAILS_VERSION,
  messageId: body.messageId,
  kind,
  from: body.from,
  sentAt: body.sentAt,
  ...(askId === undefined ? {} : { askId }),
  attachments: body.attachments.map((attachment) => ({
    kind: attachment.type,
    name: attachment.name,
  })),
  body: range,
});

type AcceptOutcome = "delivered" | "queued" | "submitted" | "busy" | "not-live";

export interface DeliveryOptions {
  readonly host: TalkHost;
  readonly clock: TalkClock;
  /**
   * The transport's `retain` of a reply address (E6, Step 2): true when the
   * route is kept, false when the registry has no entry for the pair.
   */
  readonly retain: (pair: Target) => Promise<boolean>;
}

/** The receiver of one factory binding. */
export interface TalkDelivery {
  /** The registration of the binding; its queue and its pending asks belong to it. */
  readonly registration: Target | undefined;
  /** Sets the registration of the binding; another previous one ends as in `detach`. */
  readonly attach: (registration: Target) => void;
  /**
   * Ends the registration: its queue is dropped, each dropped message reads
   * `not-live`, and its pending asks end.
   */
  readonly detach: () => void;
  /** Open while no before-handler runs and no hold remains (E2). */
  readonly gateOpen: boolean;
  readonly queuedCount: number;
  readonly pending: PendingAsks;
  /**
   * The handler of `session_before_switch`, `session_before_branch`, and
   * `session_before_tree`: it closes the gate, waits up to `SEND_WAIT_MS`
   * for the sends in flight, and leaves a hold. It never cancels.
   */
  readonly beforeTransition: (event: BeforeTransition) => Promise<void>;
  /** The handler of `session_switch`, `session_branch`, and `session_tree`. */
  readonly afterTransition: (event: AfterTransition) => void;
  readonly deliver: (registration: Target, body: DeliverBody) => Promise<DeliverResult>;
  /** A reply that completed no waiter (E6): a `main` reply becomes a message, a `sub` reply is dropped. */
  readonly receiveReply: (registration: Target, body: ReplyBody) => Promise<ReplyResult>;
  readonly cancel: (registration: Target, body: CancelBody) => CancelResult;
}

export const makeDelivery = ({ host, clock, retain }: DeliveryOptions): TalkDelivery => {
  const pending = makePendingAsks(clock);
  const records = new Map<string, MessageRecord>();
  const watches = new Map<string, Watch>();
  /** The before-handlers that wait until no send is in flight. */
  const drainWaiters = new Set<() => void>();
  const holds = new Map<Hold, CancelTimer>();
  let queue: Array<QueuedMessage> = [];
  let queuedBytes = 0;
  /**
   * The confirmation reads only the entries appended since its last read:
   * `scanned` is the entry list that it read last, `scannedTo` its length
   * then. Another list, or a shorter one, is a reset and is read again from
   * the start. The cursor exists only while a watch runs, so it keeps no
   * list that omp replaced after the last watch.
   */
  let scanned: ReadonlyArray<unknown> | undefined;
  let scannedTo = 0;
  let handlersRunning = 0;
  let registration: Target | undefined;
  let cancelFlush: CancelTimer | undefined;
  let flushAt = Number.POSITIVE_INFINITY;
  let cancelTick: CancelTimer | undefined;

  const gateOpen = (): boolean => handlersRunning === 0 && holds.size === 0;

  const isCurrent = (target: Target): boolean =>
    registration !== undefined &&
    registration.instanceId === target.instanceId &&
    registration.sessionId === target.sessionId;

  /** E3: a throw of the activity check counts as inactive. */
  const active = (): boolean => {
    try {
      return host.isActive();
    } catch {
      return false;
    }
  };

  const settle = (record: MessageRecord, state: MessageState): void => {
    record.state = state;
    if (record.isAsk && (state === "not-live" || state === "cancelled"))
      pending.remove(record.messageId);
  };

  const keep = (record: MessageRecord): void => {
    records.set(record.messageId, record);
    if (records.size <= KEPT_OUTCOMES) return;
    for (const [messageId, kept] of records) {
      if (records.size <= KEPT_OUTCOMES) break;
      if (FINAL[kept.state]) records.delete(messageId);
    }
  };

  // ── Confirmation watch (E4) ──

  const endWatch = (watch: Watch, outcome: WatchEnd): void => {
    if (watches.get(watch.record.messageId) !== watch) return;
    watches.delete(watch.record.messageId);
    settle(watch.record, outcome);
    watch.end(outcome);
    if (watches.size > 0) return;
    cancelTick?.();
    cancelTick = undefined;
    scanned = undefined;
    scannedTo = 0;
    for (const drained of [...drainWaiters]) drained();
  };

  /**
   * One read of the session for every watch: the entries appended since the
   * last read end their watches `delivered`. A failed read ends them `unknown`.
   */
  const check = (): void => {
    try {
      const sessionId = host.sessionId();
      const entries = host.entries();
      if (entries !== scanned || entries.length < scannedTo) {
        scanned = entries;
        scannedTo = 0;
      }
      const found = new Set<Watch>();
      for (let index = scannedTo; index < entries.length; index += 1) {
        const messageId = talkMessageId(entries[index]);
        const watch = messageId === undefined ? undefined : watches.get(messageId);
        if (watch !== undefined) found.add(watch);
      }
      scannedTo = entries.length;
      const now = clock.now();
      for (const watch of [...watches.values()]) {
        if (sessionId !== watch.sessionId) endWatch(watch, "not-live");
        else if (found.has(watch)) endWatch(watch, "delivered");
        else if (now >= watch.deadline) endWatch(watch, "unknown");
      }
    } catch {
      scanned = undefined;
      for (const watch of [...watches.values()]) endWatch(watch, "unknown");
    }
  };

  const tick = (): void => {
    cancelTick = undefined;
    check();
    if (watches.size > 0) cancelTick = clock.schedule(WATCH_INTERVAL_MS, tick);
  };

  const checkMicrotasks = async (watch: Watch): Promise<void> => {
    for (let turn = 0; turn < MICROTASK_CHECKS; turn += 1) {
      await Promise.resolve();
      if (watches.get(watch.record.messageId) !== watch) return;
      check();
    }
  };

  /** Hands a message to omp and starts its watch. Call only in the tick of a passed guard. */
  const send = (message: Outgoing, target: Target): Watch => {
    const { record } = message;
    try {
      host.sendMessage(
        {
          customType: TALK_MESSAGE_TYPE,
          content: message.content,
          display: true,
          details: message.details,
        },
        { triggerTurn: message.triggerTurn },
      );
    } catch (error) {
      settle(record, "unknown");
      throw error;
    }
    settle(record, "submitted");
    const { promise, resolve } = Promise.withResolvers<WatchEnd>();
    const watch: Watch = {
      record,
      sessionId: target.sessionId,
      deadline: clock.now() + WATCH_LIMIT_MS,
      ended: promise,
      end: resolve,
    };
    watches.set(record.messageId, watch);
    void checkMicrotasks(watch);
    cancelTick ??= clock.schedule(WATCH_INTERVAL_MS, tick);
    return watch;
  };

  /** The outcome of a watch that ends within `ANSWER_WAIT_MS`, else `submitted`. */
  const answer = async (watch: Watch): Promise<"delivered" | "not-live" | "submitted"> => {
    const { promise: deadline, resolve } = Promise.withResolvers<"submitted">();
    const cancel = clock.schedule(ANSWER_WAIT_MS, () => {
      resolve("submitted");
    });
    const outcome = await Promise.race([watch.ended, deadline]);
    cancel();
    return outcome === "unknown" ? "submitted" : outcome;
  };

  /** True while the target does not take a message now: a turn runs or a message waits (E5). */
  const busy = (): boolean => !host.isIdle() || host.hasPendingMessages();

  // ── Queue (E5) ──

  /** Plans the next try of the queue from a fresh task; an earlier plan wins. */
  const scheduleFlush = (delayMs: number): void => {
    if (queue.length === 0) return;
    const at = clock.now() + delayMs;
    if (cancelFlush !== undefined && flushAt <= at) return;
    cancelFlush?.();
    flushAt = at;
    cancelFlush = clock.schedule(delayMs, flush);
  };

  /** Sends the first queued message when the guard passes; the gate opening plans the next try. */
  const flush = (): void => {
    cancelFlush = undefined;
    flushAt = Number.POSITIVE_INFINITY;
    const next = queue[0];
    if (next === undefined || registration === undefined || !gateOpen()) return;
    // Planned first, so a host call that throws below does not stop the queue.
    scheduleFlush(QUEUE_RETRY_MS);
    if (!active()) return;
    if (host.sessionId() !== registration.sessionId) {
      host.unseenSessionChange(registration);
      return;
    }
    if (busy()) return;
    queue.shift();
    queuedBytes -= next.bytes;
    send(next, registration);
  };

  // ── Guard (E3) and acceptance ──

  type Admission = "not-live" | "busy" | "queued" | "send";

  /** The synchronous guard of E3 and the rules of E5, in the tick of the send. */
  const admit = (target: Target): Admission => {
    if (!isCurrent(target) || !active()) return "not-live";
    if (!gateOpen()) return "queued";
    if (host.sessionId() !== target.sessionId) {
      // No transition is pending, so the extension did not see this change (E7).
      host.unseenSessionChange(target);
      return "not-live";
    }
    if (busy()) return LONG_LIVED[host.mode()] ? "queued" : "busy";
    return queue.length > 0 ? "queued" : "send";
  };

  const accept = async (target: Target, incoming: Incoming): Promise<AcceptOutcome> => {
    const admission = admit(target);
    if (admission === "not-live" || admission === "busy") return admission;
    // A full queue refuses before a record or a pending ask exists (E5). Only a
    // message that joins the queue needs its size, so the count check runs first.
    let bytes = 0;
    if (admission === "queued") {
      if (queue.length >= MAX_QUEUED_MESSAGES) return "busy";
      bytes = Buffer.byteLength(incoming.content, "utf8");
      if (queuedBytes + bytes > MAX_QUEUED_BYTES) return "busy";
    }
    const record: MessageRecord = {
      messageId: incoming.details.messageId,
      senderSessionId: incoming.details.from.sessionId,
      instanceId: target.instanceId,
      isAsk: incoming.onAccept !== undefined,
      state: "queued",
    };
    keep(record);
    incoming.onAccept?.();
    const message: Outgoing = {
      record,
      content: incoming.content,
      details: incoming.details,
      triggerTurn: incoming.triggerTurn,
    };
    if (admission === "queued") {
      queue.push({ ...message, bytes });
      queuedBytes += bytes;
      // A closed gate plans the next try when it opens.
      if (gateOpen()) scheduleFlush(QUEUE_RETRY_MS);
      return "queued";
    }
    return answer(send(message, target));
  };

  // ── Transition hold (E2) ──

  const removeHold = (hold: Hold): void => {
    const cancel = holds.get(hold);
    if (cancel === undefined) return;
    holds.delete(hold);
    cancel();
    // Held messages go out from a fresh task, never in the task of an after-event.
    if (gateOpen()) scheduleFlush(0);
  };

  const addHold = (event: BeforeTransition): void => {
    const hold: Hold = {
      kind: event.kind,
      reason: event.reason,
      sessionFile: host.sessionFile(),
    };
    holds.set(
      hold,
      clock.schedule(HOLD_MS, () => {
        removeHold(hold);
      }),
    );
  };

  /** Resolves when no send is in flight, or after `SEND_WAIT_MS`. */
  const sendsSettled = (): Promise<void> => {
    if (watches.size === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    let cancel: CancelTimer = () => {};
    const done = (): void => {
      drainWaiters.delete(done);
      cancel();
      resolve();
    };
    drainWaiters.add(done);
    cancel = clock.schedule(SEND_WAIT_MS, done);
    return promise;
  };

  /** Fields compare only where both events carry them. */
  const matches = (hold: Hold, event: AfterTransition): boolean =>
    hold.kind === event.kind &&
    (hold.reason === undefined || event.reason === undefined || hold.reason === event.reason) &&
    (hold.sessionFile === undefined ||
      event.previousSessionFile === undefined ||
      hold.sessionFile === event.previousSessionFile);

  /** Ends the registration: its queue reads `not-live`, and its pending asks end (E6). */
  const detach = (): void => {
    registration = undefined;
    for (const { record } of queue) settle(record, "not-live");
    queue = [];
    queuedBytes = 0;
    pending.clear();
    cancelFlush?.();
    cancelFlush = undefined;
    flushAt = Number.POSITIVE_INFINITY;
  };

  return {
    get registration() {
      return registration;
    },
    attach: (target) => {
      if (registration !== undefined && !isCurrent(target)) detach();
      registration = target;
    },
    detach,
    get gateOpen() {
      return gateOpen();
    },
    get queuedCount() {
      return queue.length;
    },
    pending,
    beforeTransition: async (event) => {
      handlersRunning += 1;
      try {
        await sendsSettled();
      } finally {
        handlersRunning -= 1;
        addHold(event);
      }
    },
    afterTransition: (event) => {
      const matching = [...holds.keys()].filter((hold) => matches(hold, event));
      // Events do not name their transition: remove a hold only when exactly one matches.
      const [only] = matching;
      if (only !== undefined && matching.length === 1) removeHold(only);
    },
    deliver: async (target, body) => {
      const result = (outcome: DeliverResult["outcome"]): DeliverResult => ({
        outcome,
        messageId: body.messageId,
        instanceId: target.instanceId,
      });
      if (!isCurrent(target) || !active()) return result("not-live");
      const { ask } = body;
      // E6: an ask is accepted only after its reply route is retained.
      if (ask !== undefined && !(await retain(ask.replyTo))) return result("no-reply-route");
      const formatted = formatDelivery(body);
      return result(
        await accept(target, {
          content: formatted.content,
          details:
            ask === undefined
              ? talkDetails(body.kind ?? "message", body, formatted.body, undefined)
              : talkDetails("ask", body, formatted.body, body.messageId),
          triggerTurn: !body.noWake,
          onAccept:
            ask === undefined
              ? undefined
              : () => {
                  pending.add({ ...body, ask }, target);
                },
        }),
      );
    },
    receiveReply: async (target, body) => {
      const result = (outcome: ReplyResult["outcome"]): ReplyResult => ({
        outcome,
        messageId: body.messageId,
        instanceId: target.instanceId,
      });
      // A reply from a subagent's ask never enters a main session (E6).
      if (body.origin === "sub") return result("not-found");
      const formatted = formatReply(body);
      return result(
        await accept(target, {
          content: formatted.content,
          details: talkDetails("reply", body, formatted.body, body.askId),
          triggerTurn: !body.noWake,
          onAccept: undefined,
        }),
      );
    },
    cancel: (target, body) => {
      const result = (outcome: CancelResult["outcome"]): CancelResult => ({
        outcome,
        messageId: body.messageId,
        instanceId: target.instanceId,
      });
      if (!isCurrent(target)) return result("not-live");
      const record = records.get(body.messageId);
      if (
        record === undefined ||
        record.instanceId !== target.instanceId ||
        record.senderSessionId !== body.senderSessionId
      )
        return result("not-found");
      if (record.state !== "queued") return result(record.state);
      const index = queue.findIndex((message) => message.record === record);
      const [removed] = index === -1 ? [] : queue.splice(index, 1);
      if (removed !== undefined) queuedBytes -= removed.bytes;
      settle(record, "cancelled");
      return result("cancelled");
    },
  };
};

/** How the request handlers find the receiver of a registration and the ask waiters. */
export interface ReceiverRoutes {
  /** The receiver whose binding owns the registration; undefined after it ended. */
  readonly receiverFor: (registration: Target) => TalkDelivery | undefined;
  /** The process store of ask waiters (E6, E12). */
  readonly asks: AskStore;
}

/** A receiver call that rejected: a host call threw. */
class TalkReceiverFailed extends Schema.TaggedError<
  TalkReceiverFailed,
  { readonly brand: unique symbol }
>()("TalkReceiverFailed", {
  cause: Schema.Defect(),
}) {}

/** A failed receiver call is a defect: the listener logs it and the request gets no answer. */
const fromPromise = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => new TalkReceiverFailed({ cause }) }).pipe(
    Effect.orDie,
  );

/**
 * The transport handlers of `deliver`, `reply`, and `cancel` (Step 1 bodies
 * and results). A body that does not decode is a defect, as above.
 */
export const talkRequestHandlers = ({
  receiverFor,
  asks,
}: ReceiverRoutes): ReadonlyArray<readonly [kind: string, handler: RequestHandler]> => [
  [
    DELIVER_KIND,
    (json, { registration }) =>
      decodeDeliverBody(json).pipe(
        Effect.flatMap((body) => {
          const receiver = receiverFor(registration);
          return receiver === undefined
            ? Effect.succeed<DeliverResult>({
                outcome: "not-live",
                messageId: body.messageId,
                instanceId: registration.instanceId,
              })
            : fromPromise(() => receiver.deliver(registration, body));
        }),
        Effect.flatMap(encodeDeliverResult),
        Effect.orDie,
      ),
  ],
  [
    REPLY_KIND,
    (json, { registration }) =>
      decodeReplyBody(json).pipe(
        Effect.flatMap((body) => {
          const result = (outcome: ReplyResult["outcome"]): ReplyResult => ({
            outcome,
            messageId: body.messageId,
            instanceId: registration.instanceId,
          });
          // A reply that matches a waiter completes it before the busy rules, without an append.
          if (asks.complete(body)) return Effect.succeed(result("delivered"));
          const receiver = receiverFor(registration);
          if (receiver !== undefined)
            return fromPromise(() => receiver.receiveReply(registration, body));
          return Effect.succeed(result(body.origin === "sub" ? "not-found" : "not-live"));
        }),
        Effect.flatMap(encodeReplyResult),
        Effect.orDie,
      ),
  ],
  [
    CANCEL_KIND,
    (json, { registration }) =>
      decodeCancelBody(json).pipe(
        Effect.map((body): CancelResult => {
          const receiver = receiverFor(registration);
          return receiver === undefined
            ? {
                outcome: "not-live",
                messageId: body.messageId,
                instanceId: registration.instanceId,
              }
            : receiver.cancel(registration, body);
        }),
        Effect.flatMap(encodeCancelResult),
        Effect.orDie,
      ),
  ],
];
