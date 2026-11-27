import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { Effect, Predicate, type Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeAskStore } from "../../../talk/tool/asks";
import type { Attachment } from "../../../talk/tool/attachments";
import {
  ANSWER_WAIT_MS,
  HOLD_MS,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_MESSAGES,
  QUEUE_RETRY_MS,
  SEND_WAIT_MS,
  WATCH_LIMIT_MS,
  type TalkDelivery,
  makeDelivery,
  talkRequestHandlers,
} from "../../../talk/tool/delivery";
import { formatDelivery, formatReply } from "../../../talk/tool/format";
import {
  type SendOptions,
  type SessionMode,
  TALK_MESSAGE_TYPE,
  type TalkHost,
  type TalkMessage,
  decodeTalkMessage,
  systemClock,
  talkMessageId,
} from "../../../talk/tool/host";
import {
  CANCEL_KIND,
  DELIVER_KIND,
  type DeliverBody,
  MAX_MESSAGE_BYTES,
  REPLY_KIND,
  type ReplyBody,
  encodeCancelBody,
  encodeDeliverBody,
  encodeReplyBody,
  messageBytes,
} from "../../../talk/tool/protocol";
import type { Target } from "../../../talk/transport/request";

// The receiver of #250 E2 to E6: gate, guard, confirmation, results, queue, and cancel.
const SESSION_A = "session-a";
const SESSION_B = "session-b";
const REG_A: Target = { instanceId: "00000000000000a1", sessionId: SESSION_A };
const REG_A2: Target = { instanceId: "00000000000000a2", sessionId: SESSION_A };
const SENDER = "session-sender";
const ASKER: Target = { instanceId: "00000000000000c1", sessionId: "session-asker" };

interface FakeState {
  readonly id: string;
  readonly file: string;
  readonly entries: Array<unknown>;
}

interface Sent {
  readonly message: TalkMessage;
  readonly options: SendOptions;
  readonly sessionId: string;
}

const stateFor = (id: string): FakeState => ({ id, file: `/sessions/${id}.jsonl`, entries: [] });

/** The controls of the fake session. */
interface FakeSession {
  state: FakeState;
  active: boolean;
  activeThrows: boolean;
  idle: boolean;
  pendingMessages: boolean;
  mode: SessionMode;
  /** Appends wait for `releaseHeld`, as a slow omp. */
  holdAppends: boolean;
  /** A turn-starting send never lands, as one that the usage preflight refuses. */
  refuseTurns: boolean;
  readonly sent: Array<Sent>;
  readonly held: Array<() => void>;
  readonly unseen: Array<Target>;
  /** Replaces the session in place and returns the previous one. */
  readonly reset: (id: string) => FakeState;
  readonly releaseHeld: () => void;
  readonly sentIds: () => Array<string>;
}

/**
 * A fake omp session: an append lands two microtask turns after the send, in
 * the session that was current at the send; a transition replaces the session
 * in place, so `getEntries()` and `getSessionId()` read the new one at once.
 * `getEntries()` gives the live list, as omp's `getEntriesView()` does.
 */
const makeFakeHost = (): { readonly fake: FakeSession; readonly host: TalkHost } => {
  const fake: FakeSession = {
    state: stateFor(SESSION_A),
    active: true,
    activeThrows: false,
    idle: true,
    pendingMessages: false,
    mode: "tui",
    holdAppends: false,
    refuseTurns: false,
    sent: [],
    held: [],
    unseen: [],
    reset: (id) => {
      const previous = fake.state;
      fake.state = stateFor(id);
      return previous;
    },
    releaseHeld: () => {
      for (const land of fake.held.splice(0)) land();
    },
    sentIds: () => fake.sent.map((entry) => entry.message.details.messageId),
  };
  const host: TalkHost = {
    isActive: () => {
      if (fake.activeThrows) throw new Error("getAllTools is missing");
      return fake.active;
    },
    sessionId: () => fake.state.id,
    sessionFile: () => fake.state.file,
    entries: () => fake.state.entries,
    liveEntries: () => true,
    isIdle: () => fake.idle,
    hasPendingMessages: () => fake.pendingMessages,
    mode: () => fake.mode,
    sendMessage: (message, options) => {
      const target = fake.state;
      fake.sent.push({ message, options, sessionId: target.id });
      // A turn-starting send that the usage preflight refuses leaves no entry.
      if (fake.refuseTurns && options.triggerTurn) return;
      const land = (): void => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            target.entries.push({
              type: "custom_message",
              customType: message.customType,
              content: message.content,
              display: message.display,
              details: message.details,
            });
          });
        });
      };
      if (fake.holdAppends) fake.held.push(land);
      else land();
    },
    unseenSessionChange: (registration) => {
      fake.unseen.push(registration);
    },
  };
  return { fake, host };
};

let clockErrors: Array<unknown> = [];
const clock = systemClock((error) => {
  clockErrors.push(error);
});

beforeEach(() => {
  clockErrors = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
  expect(clockErrors).toEqual([]);
});

/**
 * Runs the fresh task that a timer callback planned with a 0 ms delay: the
 * fake clock runs such a timer 1 ms later, after the task that planned it.
 */
const freshTask = (): Promise<void> => vi.advanceTimersByTimeAsync(1).then(() => undefined);

const flushMicrotasks = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/** The value of a promise once it settled, read without waiting. */
const peek = <A>(promise: Promise<A>): { done: boolean; value: A | undefined } => {
  const state: { done: boolean; value: A | undefined } = { done: false, value: undefined };
  void promise.then((value) => {
    state.done = true;
    state.value = value;
  });
  return state;
};

let messageCounter = 0;
const nextMessageId = (): string => {
  messageCounter += 1;
  return messageCounter.toString(16).padStart(16, "0");
};

setFlagsFromString("--expose-gc");
const gcFunction: unknown = runInNewContext("gc");

/** A full garbage collection, after a fresh task, so that no weak reference of the task stays held. */
const collectGarbage = async (): Promise<void> => {
  if (!Predicate.isFunction(gcFunction)) throw new Error("the V8 gc function is missing");
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
  Reflect.apply(gcFunction, undefined, []);
};

const sendBody = (overrides: Partial<DeliverBody> = {}): DeliverBody => ({
  messageId: nextMessageId(),
  from: { name: "alice", cwd: "/work/alice", sessionId: SENDER },
  text: "Please check the build.",
  attachments: [],
  sentAt: 0,
  noWake: false,
  ...overrides,
});

const askBody = (overrides: Partial<DeliverBody> = {}): DeliverBody =>
  sendBody({ ask: { origin: "main", replyTo: ASKER }, ...overrides });

const replyBody = (overrides: Partial<ReplyBody> = {}): ReplyBody => ({
  messageId: nextMessageId(),
  from: { name: "bob", cwd: "/work/bob", sessionId: SENDER },
  text: "The build passes.",
  attachments: [],
  sentAt: 0,
  noWake: false,
  replier: { instanceId: "00000000000000d1", sessionId: SENDER },
  askId: "00000000000000ee",
  origin: "main",
  ...overrides,
});

const setup = (retain: (pair: Target) => Promise<boolean> = async () => true) => {
  const { fake, host } = makeFakeHost();
  const delivery = makeDelivery({ host, clock, retain });
  delivery.attach(REG_A);
  return { fake, host, delivery };
};

const cancelOf = (delivery: TalkDelivery, messageId: string, registration: Target = REG_A) =>
  delivery.cancel(registration, { messageId, senderSessionId: SENDER }).outcome;

describe("confirmation and wake (E4)", () => {
  it("sends with triggerTurn and answers delivered once the append lands, without a timer", async () => {
    const { fake, delivery } = setup();
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await flushMicrotasks();
    expect(state.value).toEqual({
      outcome: "delivered",
      messageId: body.messageId,
      instanceId: REG_A.instanceId,
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.options).toEqual({ triggerTurn: true });
    expect(fake.sent[0]?.message).toEqual({
      customType: TALK_MESSAGE_TYPE,
      content: formatDelivery(body).content,
      display: true,
      details: {
        v: 1,
        messageId: body.messageId,
        kind: "message",
        from: body.from,
        sentAt: body.sentAt,
        attachments: [],
        body: formatDelivery(body).body,
      },
    });
    expect(fake.state.entries.map(talkMessageId)).toEqual([body.messageId]);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it("sends a noWake message as a plain append", async () => {
    const { fake, delivery } = setup();
    const body = sendBody({ noWake: true });
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    expect(fake.sent[0]?.options).toEqual({ triggerTurn: false });
  });

  it("answers submitted after 1 s and gives the later outcome to cancel", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value?.outcome).toBe("submitted");
    expect(cancelOf(delivery, body.messageId)).toBe("submitted");
    fake.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it("ends a send whose entry never appears as unknown after 10 minutes", async () => {
    const { fake, delivery } = setup();
    fake.refuseTurns = true;
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    expect(state.value?.outcome).toBe("submitted");
    expect(fake.sent[0]?.options.triggerTurn).toBe(true);
    await vi.advanceTimersByTimeAsync(WATCH_LIMIT_MS - ANSWER_WAIT_MS - 20);
    expect(cancelOf(delivery, body.messageId)).toBe("submitted");
    await vi.advanceTimersByTimeAsync(20);
    expect(cancelOf(delivery, body.messageId)).toBe("unknown");
    expect(WATCH_LIMIT_MS).toBe(600_000);
  });

  it("ends a watch after 10 minutes also when the wall clock stepped back (C7)", async () => {
    const { fake, delivery } = setup();
    fake.refuseTurns = true;
    const body = sendBody();
    void delivery.deliver(REG_A, body);
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    vi.setSystemTime(Date.now() - 30 * 60 * 1_000);
    await vi.advanceTimersByTimeAsync(WATCH_LIMIT_MS - ANSWER_WAIT_MS - 20);
    expect(cancelOf(delivery, body.messageId)).toBe("submitted");
    await vi.advanceTimersByTimeAsync(20);
    expect(cancelOf(delivery, body.messageId)).toBe("unknown");
  });

  /** A list of `length` plain entries that counts the reads of its items. */
  const countedEntries = (length: number) => {
    const counter = { reads: 0 };
    const backing: Array<unknown> = Array.from({ length }, () => ({ type: "message" }));
    const entries = new Proxy(backing, {
      get: (target, key, receiver) => {
        if (typeof key === "string" && /^\d+$/u.test(key)) counter.reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    return { counter, entries };
  };

  it("reads no old entry over many checks: a new watch starts at the end of the list (C6)", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    const { counter, entries } = countedEntries(5_000);
    fake.state = { ...fake.state, entries };
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await vi.advanceTimersByTimeAsync(ANSWER_WAIT_MS);
    // About a hundred checks ran; none read an entry from before the send.
    expect(state.value?.outcome).toBe("submitted");
    expect(counter.reads).toBe(0);
    fake.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
    expect(counter.reads).toBe(1);
  });

  it("reads only the new entry of each isolated delivery to an idle session (C6)", async () => {
    const { fake, delivery } = setup();
    const { counter, entries } = countedEntries(5_000);
    fake.state = { ...fake.state, entries };
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("delivered");
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("delivered");
    expect(counter.reads).toBe(2);
  });

  it("reads a list that became shorter again from its start (C6)", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    fake.state.entries.push({ type: "message" }, { type: "message" }, { type: "message" });
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await flushMicrotasks();
    // omp empties the same list, then the message lands as its first entry.
    fake.state.entries.length = 0;
    fake.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value?.outcome).toBe("delivered");
  });

  it("reads a replaced entry list of the same session again from its start (C6)", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    fake.state.entries.push({ type: "message" }, { type: "message" }, { type: "message" });
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    await flushMicrotasks();
    // omp rebuilds the list of the same session: a new, longer array whose first entry is the message.
    fake.state = {
      ...fake.state,
      entries: [
        {
          type: "custom_message",
          customType: TALK_MESSAGE_TYPE,
          content: "",
          display: true,
          details: { messageId: body.messageId },
        },
        { type: "message" },
        { type: "message" },
        { type: "message" },
      ],
    };
    await vi.advanceTimersByTimeAsync(10);
    expect(state.value?.outcome).toBe("delivered");
  });

  it("drops its read of the entry list when the last watch ends, so a list that omp replaced goes (C6)", async () => {
    const { fake, delivery } = setup();
    const watched = ((): WeakRef<Array<unknown>> => {
      const entries: Array<unknown> = Array.from({ length: 1_000 }, () => ({ type: "message" }));
      fake.state = { ...fake.state, entries };
      return new WeakRef(entries);
    })();
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("delivered");
    // omp replaces the live list, and no other talk message comes.
    fake.state = stateFor(SESSION_A);
    await collectGarbage();
    expect(watched.deref()).toBeUndefined();
  });

  it("reads no copy of getEntries() before a send, because the first check would discard it (R7)", async () => {
    const { fake, host } = makeFakeHost();
    let reads = 0;
    const readsAtSend: Array<number> = [];
    const delivery = makeDelivery({
      host: {
        ...host,
        // The getEntries() fallback: a new copy on each read.
        liveEntries: () => false,
        entries: () => {
          reads += 1;
          return [...fake.state.entries];
        },
        sendMessage: (message, options) => {
          readsAtSend.push(reads);
          host.sendMessage(message, options);
        },
      },
      clock,
      retain: async () => true,
    });
    delivery.attach(REG_A);
    fake.state.entries.push({ type: "message" }, { type: "message" });
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("delivered");
    const afterFirst = reads;
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("delivered");
    expect(readsAtSend).toEqual([0, afterFirst]);
  });

  it("keeps no entry list after a send that omp refused with a throw (C6)", async () => {
    const { fake, host } = makeFakeHost();
    const failure = new Error("sendMessage failed");
    const delivery = makeDelivery({
      host: {
        ...host,
        sendMessage: () => {
          throw failure;
        },
      },
      clock,
      retain: async () => true,
    });
    delivery.attach(REG_A);
    const watched = ((): WeakRef<Array<unknown>> => {
      const entries: Array<unknown> = Array.from({ length: 1_000 }, () => ({ type: "message" }));
      fake.state = { ...fake.state, entries };
      return new WeakRef(entries);
    })();
    await expect(delivery.deliver(REG_A, sendBody())).rejects.toBe(failure);
    fake.state = stateFor(SESSION_A);
    await collectGarbage();
    expect(watched.deref()).toBeUndefined();
  });
});

describe("guard (E3)", () => {
  it("answers not-live while the extension is inactive, also when the check throws", async () => {
    const { fake, delivery } = setup();
    fake.active = false;
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("not-live");
    fake.active = true;
    fake.activeThrows = true;
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("not-live");
    expect(fake.sent).toEqual([]);
  });

  it("answers not-live for a registration that is not the current one", async () => {
    const { fake, delivery } = setup();
    expect((await delivery.deliver(REG_A2, sendBody())).outcome).toBe("not-live");
    delivery.detach();
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("not-live");
    expect(fake.sent).toEqual([]);
  });

  it("reports a session id change that no hook announced and answers not-live", async () => {
    const { fake, delivery } = setup();
    fake.reset(SESSION_B);
    expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("not-live");
    expect(fake.unseen).toEqual([REG_A]);
    expect(fake.sent).toEqual([]);
  });
});

describe("transition hold (E2)", () => {
  it("lets a delivery that a transition overlaps land in the old session", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    const body = sendBody();
    const delivered = peek(delivery.deliver(REG_A, body));
    // omp starts the transition in the same tick; the before-handler waits for the append.
    const before = peek(delivery.beforeTransition({ kind: "switch", reason: "new" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(before.done).toBe(false);
    fake.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(before.done).toBe(true);
    expect(delivered.value?.outcome).toBe("delivered");
    // omp resets the session in place after the handler returned.
    const old = fake.reset(SESSION_B);
    delivery.afterTransition({ kind: "switch", reason: "new", previousSessionFile: old.file });
    expect(old.entries.map(talkMessageId)).toEqual([body.messageId]);
    expect(fake.state.entries).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it("reads not-live when the append lands after the before-handler stopped waiting", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    const body = sendBody();
    const state = peek(delivery.deliver(REG_A, body));
    const before = peek(delivery.beforeTransition({ kind: "switch", reason: "new" }));
    await vi.advanceTimersByTimeAsync(SEND_WAIT_MS - 1);
    expect(before.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // The handler returns without a cancel.
    expect(before.done).toBe(true);
    expect(before.value).toBeUndefined();
    expect(state.value?.outcome).toBe("submitted");
    const old = fake.reset(SESSION_B);
    delivery.afterTransition({ kind: "switch", reason: "new", previousSessionFile: old.file });
    fake.releaseHeld();
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelOf(delivery, body.messageId)).toBe("not-live");
    expect(old.entries.map(talkMessageId)).toEqual([body.messageId]);
    expect(fake.state.entries).toEqual([]);
  });

  it("keeps the gate closed while a before-handler runs, past another hold's deadline", async () => {
    const { fake, delivery } = setup();
    fake.holdAppends = true;
    void delivery.deliver(REG_A, sendBody());
    // t = 0: the first handler waits 20 s for the send in flight and leaves a hold until t = 50 s.
    void delivery.beforeTransition({ kind: "tree" });
    await vi.advanceTimersByTimeAsync(45_000);
    // t = 45 s: a second handler starts and waits until t = 65 s.
    const second = peek(delivery.beforeTransition({ kind: "branch", reason: "branch" }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivery.gateOpen).toBe(false);
    const held = sendBody();
    expect((await delivery.deliver(REG_A, held)).outcome).toBe("queued");
    await vi.advanceTimersByTimeAsync(9_000);
    expect(second.done).toBe(false);
    expect(fake.sentIds()).not.toContain(held.messageId);
    await vi.advanceTimersByTimeAsync(1_000);
    // t = 65 s: the second handler returned; its hold lasts until t = 95 s.
    expect(second.done).toBe(true);
    expect(delivery.gateOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(fake.sentIds()).not.toContain(held.messageId);
    await vi.advanceTimersByTimeAsync(1);
    expect(delivery.gateOpen).toBe(true);
    expect(fake.sentIds()).not.toContain(held.messageId);
    await freshTask();
    expect(fake.sentIds()).toContain(held.messageId);
  });

  it("removes a hold when exactly one hold matches the after-event", async () => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "new" });
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    delivery.afterTransition({
      kind: "switch",
      reason: "new",
      previousSessionFile: fake.state.file,
    });
    expect(delivery.gateOpen).toBe(true);
    // The held message never goes out in the task of the after-event.
    await flushMicrotasks();
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sentIds()).toEqual([body.messageId]);
    await flushMicrotasks();
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it("removes no hold when two holds match, and ends each 30 s after its own handler returned", async () => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "new" });
    await vi.advanceTimersByTimeAsync(10_000);
    await delivery.beforeTransition({ kind: "switch", reason: "new" });
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    delivery.afterTransition({
      kind: "switch",
      reason: "new",
      previousSessionFile: fake.state.file,
    });
    await vi.advanceTimersByTimeAsync(HOLD_MS - 10_000);
    // The first hold ended at 30 s; the second lasts until 40 s.
    expect(delivery.gateOpen).toBe(false);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(delivery.gateOpen).toBe(true);
    await freshTask();
    expect(fake.sentIds()).toEqual([body.messageId]);
  });

  it.each([
    ["another kind", { kind: "branch", reason: "new" }],
    ["another reason", { kind: "switch", reason: "fork" }],
    [
      "another session file",
      { kind: "switch", reason: "new", previousSessionFile: "/other.jsonl" },
    ],
  ] as const)("removes no hold for an after-event of %s", async (_name, event) => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "new" });
    delivery.afterTransition(event);
    expect(delivery.gateOpen).toBe(false);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(delivery.gateOpen).toBe(true);
    expect(fake.sent).toEqual([]);
  });

  it("matches by kind alone when the events carry no reason or file", async () => {
    const { delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: undefined });
    delivery.afterTransition({ kind: "switch", reason: "new", previousSessionFile: undefined });
    expect(delivery.gateOpen).toBe(true);
  });

  it("lets an after-event whose before-event was missed end the one hold that it matches (E1 limit)", async () => {
    const { fake, delivery } = setup();
    // The outer transition: a tree navigation. The nested one ran while the extension was suspended.
    await delivery.beforeTransition({ kind: "tree" });
    delivery.afterTransition({
      kind: "branch",
      reason: "branch",
      previousSessionFile: fake.state.file,
    });
    expect(delivery.gateOpen).toBe(false);
    // Tree events carry no data, so the nested tree's after-event matches the outer hold.
    delivery.afterTransition({ kind: "tree" });
    expect(delivery.gateOpen).toBe(true);
  });

  it("releases a held message from a fresh task 30 s after a cancelled transition", async () => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "new" });
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1);
    expect(fake.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent).toEqual([]);
    await freshTask();
    expect(fake.sentIds()).toEqual([body.messageId]);
    await flushMicrotasks();
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it("sends a held message from a fresh task after the after-event also when the wall clock jumped ahead (C7)", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const body = sendBody();
    // A busy session queues the message and plans a try in 100 ms.
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    fake.idle = true;
    await delivery.beforeTransition({ kind: "switch", reason: "resume" });
    vi.setSystemTime(Date.now() + 60 * 60 * 1_000);
    delivery.afterTransition({
      kind: "switch",
      reason: "resume",
      previousSessionFile: fake.state.file,
    });
    await freshTask();
    expect(fake.sentIds()).toEqual([body.messageId]);
  });

  it("keeps the queue across a session_switch that keeps the session id", async () => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "resume" });
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    // A resume of the current session file: the id stays.
    delivery.afterTransition({
      kind: "switch",
      reason: "resume",
      previousSessionFile: fake.state.file,
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
    expect(fake.state.entries.map(talkMessageId)).toEqual([body.messageId]);
  });

  it("holds and then delivers when the session id changes and returns while a transition is pending", async () => {
    const { fake, delivery } = setup();
    await delivery.beforeTransition({ kind: "switch", reason: "resume" });
    // The resume loaded the target session, then rolled back before its session_switch.
    const original = fake.reset(SESSION_B);
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    fake.state = original;
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    await freshTask();
    await flushMicrotasks();
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
    expect(original.entries.map(talkMessageId)).toEqual([body.messageId]);
    expect(fake.unseen).toEqual([]);
  });
});

describe("results, queue, and busy rules (E5)", () => {
  it.each(["tui", "rpc"] as const)(
    "queues for a busy %s session and delivers when idle",
    async (mode) => {
      const { fake, delivery } = setup();
      fake.mode = mode;
      fake.idle = false;
      const first = sendBody();
      const second = sendBody();
      expect((await delivery.deliver(REG_A, first)).outcome).toBe("queued");
      expect((await delivery.deliver(REG_A, second)).outcome).toBe("queued");
      expect(delivery.queuedCount).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fake.sent).toEqual([]);
      fake.idle = true;
      await vi.advanceTimersByTimeAsync(1_000);
      // First in, first out, each from its own task.
      expect(fake.sentIds()).toEqual([first.messageId, second.messageId]);
      expect(cancelOf(delivery, first.messageId)).toBe("delivered");
      expect(cancelOf(delivery, second.messageId)).toBe("delivered");
      expect(delivery.queuedCount).toBe(0);
    },
  );

  it("queues for an idle session with pending messages", async () => {
    const { fake, delivery } = setup();
    fake.mode = "rpc";
    fake.pendingMessages = true;
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    fake.pendingMessages = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });

  it.each(["print", "json"] as const)("answers busy for a busy %s session", async (mode) => {
    const { fake, delivery } = setup();
    fake.mode = mode;
    fake.idle = false;
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("busy");
    expect(delivery.queuedCount).toBe(0);
    expect(cancelOf(delivery, body.messageId)).toBe("not-found");
  });

  it("puts a message behind queued ones even when the session is idle", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const first = sendBody();
    expect((await delivery.deliver(REG_A, first)).outcome).toBe("queued");
    fake.idle = true;
    const second = sendBody();
    expect((await delivery.deliver(REG_A, second)).outcome).toBe("queued");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sentIds()).toEqual([first.messageId, second.messageId]);
  });

  it("cancels a queued message, which then never goes out", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const body = sendBody();
    const result = await delivery.deliver(REG_A, body);
    expect(result).toEqual({
      outcome: "queued",
      messageId: body.messageId,
      instanceId: REG_A.instanceId,
    });
    // Another sender cannot cancel it.
    expect(
      delivery.cancel(REG_A, { messageId: body.messageId, senderSessionId: "session-other" })
        .outcome,
    ).toBe("not-found");
    expect(delivery.cancel(REG_A, { messageId: body.messageId, senderSessionId: SENDER })).toEqual({
      outcome: "cancelled",
      messageId: body.messageId,
      instanceId: REG_A.instanceId,
    });
    expect(delivery.queuedCount).toBe(0);
    fake.idle = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toEqual([]);
    expect(cancelOf(delivery, body.messageId)).toBe("cancelled");
    expect(cancelOf(delivery, "00000000000000ff")).toBe("not-found");
  });

  it("drops the queue with the registration, which then reads not-live", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const body = sendBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    delivery.detach();
    expect(delivery.queuedCount).toBe(0);
    expect(cancelOf(delivery, body.messageId)).toBe("not-live");
    delivery.attach(REG_A2);
    // The new registration does not own the message of the old one.
    expect(cancelOf(delivery, body.messageId, REG_A2)).toBe("not-found");
    fake.idle = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toEqual([]);
  });

  it("answers busy beyond 64 queued messages, before it keeps a record or a pending ask (C8)", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const first = sendBody();
    expect((await delivery.deliver(REG_A, first)).outcome).toBe("queued");
    for (let count = 1; count < MAX_QUEUED_MESSAGES; count += 1)
      expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("queued");
    const over = askBody();
    expect((await delivery.deliver(REG_A, over)).outcome).toBe("busy");
    expect(delivery.queuedCount).toBe(MAX_QUEUED_MESSAGES);
    expect(cancelOf(delivery, over.messageId)).toBe("not-found");
    expect(delivery.pending.list(REG_A)).toEqual([]);
    // A cancelled message frees its place.
    expect(cancelOf(delivery, first.messageId)).toBe("cancelled");
    expect((await delivery.deliver(REG_A, askBody())).outcome).toBe("queued");
    expect(delivery.pending.list(REG_A)).toHaveLength(1);
  });

  it("answers busy at the first wire-valid message that would pass 4 MiB of queued text, and frees the bytes as messages leave (C8)", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    // The longest text of a body that the 512 KiB wire limit still lets through.
    const overhead = messageBytes(
      await Effect.runPromise(encodeDeliverBody(sendBody({ text: "" }))),
    );
    const largest = (): DeliverBody => sendBody({ text: "x".repeat(MAX_MESSAGE_BYTES - overhead) });
    expect(messageBytes(await Effect.runPromise(encodeDeliverBody(largest())))).toBe(
      MAX_MESSAGE_BYTES,
    );
    const tooLarge = await Effect.runPromise(
      Effect.flip(
        encodeDeliverBody(sendBody({ text: "x".repeat(MAX_MESSAGE_BYTES - overhead + 1) })),
      ),
    );
    expect(tooLarge._tag).toBe("TalkMessageTooLarge");
    const contentBytes = Buffer.byteLength(formatDelivery(largest()).content, "utf8");
    const fit = Math.floor(MAX_QUEUED_BYTES / contentBytes);
    // The byte limit, not the count limit, refuses the next one.
    expect(fit).toBeLessThan(MAX_QUEUED_MESSAGES);
    const queued: Array<DeliverBody> = [];
    for (let count = 0; count < fit; count += 1) {
      const body = largest();
      queued.push(body);
      expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    }
    const refused = largest();
    expect((await delivery.deliver(REG_A, refused)).outcome).toBe("busy");
    expect(delivery.queuedCount).toBe(fit);
    expect(cancelOf(delivery, refused.messageId)).toBe("not-found");
    // A small message still fits in the rest.
    const small = sendBody();
    expect(Buffer.byteLength(formatDelivery(small).content, "utf8")).toBeLessThanOrEqual(
      MAX_QUEUED_BYTES - fit * contentBytes,
    );
    expect((await delivery.deliver(REG_A, small)).outcome).toBe("queued");
    // A cancelled message frees its bytes.
    expect(cancelOf(delivery, queued[0]?.messageId ?? "")).toBe("cancelled");
    expect((await delivery.deliver(REG_A, largest())).outcome).toBe("queued");
    // Sent messages free theirs: the queue takes as many again.
    fake.idle = true;
    await vi.advanceTimersByTimeAsync(QUEUE_RETRY_MS * (fit + 2) * 2);
    expect(delivery.queuedCount).toBe(0);
    fake.idle = false;
    for (let count = 0; count < fit; count += 1)
      expect((await delivery.deliver(REG_A, largest())).outcome).toBe("queued");
    expect((await delivery.deliver(REG_A, largest())).outcome).toBe("busy");
  });

  it("counts the bytes of a message only when it joins the queue, after the count check", async () => {
    const { fake, delivery } = setup();
    const sizes = vi.spyOn(Buffer, "byteLength");
    const sizedTexts = (): Array<string> =>
      sizes.mock.calls.flatMap(([value]) => (typeof value === "string" ? [value] : []));
    try {
      const immediate = sendBody({ text: "goes out at once" });
      expect((await delivery.deliver(REG_A, immediate)).outcome).toBe("delivered");
      expect(sizedTexts()).not.toContain(formatDelivery(immediate).content);
      fake.idle = false;
      const queued = sendBody({ text: "joins the queue" });
      expect((await delivery.deliver(REG_A, queued)).outcome).toBe("queued");
      expect(sizedTexts()).toContain(formatDelivery(queued).content);
      for (let count = 1; count < MAX_QUEUED_MESSAGES; count += 1)
        expect((await delivery.deliver(REG_A, sendBody())).outcome).toBe("queued");
      const refused = sendBody({ text: "the queue is full" });
      expect((await delivery.deliver(REG_A, refused)).outcome).toBe("busy");
      expect(sizedTexts()).not.toContain(formatDelivery(refused).content);
    } finally {
      sizes.mockRestore();
    }
  });
});

describe("asks and replies at the receiver (E6)", () => {
  it("retains the reply route before it accepts an ask and lists the ask as pending", async () => {
    const retained: Array<{ readonly pair: Target; readonly sentBefore: number }> = [];
    const { fake, delivery } = setup(async (pair) => {
      retained.push({ pair, sentBefore: fake.sent.length });
      return true;
    });
    const body = askBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    expect(retained).toEqual([{ pair: ASKER, sentBefore: 0 }]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.message.content).toBe(formatDelivery(body).content);
    expect(delivery.pending.list(REG_A).map((entry) => entry.askId)).toEqual([body.messageId]);
  });

  it("answers no-reply-route and sends nothing when the route cannot be retained", async () => {
    const { fake, delivery } = setup(async () => false);
    expect((await delivery.deliver(REG_A, askBody())).outcome).toBe("no-reply-route");
    expect(fake.sent).toEqual([]);
    expect(delivery.pending.list(REG_A)).toEqual([]);
  });

  it("removes the pending ask of a cancelled or dropped message", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const cancelled = askBody();
    const dropped = askBody();
    await delivery.deliver(REG_A, cancelled);
    await delivery.deliver(REG_A, dropped);
    expect(delivery.pending.list(REG_A)).toHaveLength(2);
    cancelOf(delivery, cancelled.messageId);
    expect(delivery.pending.list(REG_A).map((entry) => entry.askId)).toEqual([dropped.messageId]);
    delivery.detach();
    expect(delivery.pending.list(REG_A)).toEqual([]);
    // The asks ended with their registration: a new one of the same session sees none (C1).
    delivery.attach(REG_A);
    expect(delivery.pending.list(REG_A)).toEqual([]);
  });

  it("ends the pending asks when a new registration replaces the old one (C1)", async () => {
    const { delivery } = setup();
    const body = askBody();
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    expect(delivery.pending.list(REG_A)).toHaveLength(1);
    delivery.attach(REG_A2);
    expect(delivery.pending.list(REG_A)).toEqual([]);
    expect(delivery.pending.list(REG_A2)).toEqual([]);
  });

  it("delivers a main reply without a waiter as a message", async () => {
    const { fake, delivery } = setup();
    const body = replyBody({ origin: "main" });
    expect(await delivery.receiveReply(REG_A, body)).toEqual({
      outcome: "delivered",
      messageId: body.messageId,
      instanceId: REG_A.instanceId,
    });
    expect(fake.sent[0]?.message.content).toBe(formatReply(body).content);
  });

  it("follows the busy rules for a main reply without a waiter", async () => {
    const { fake, delivery } = setup();
    fake.mode = "print";
    fake.idle = false;
    expect((await delivery.receiveReply(REG_A, replyBody())).outcome).toBe("busy");
  });

  it("drops a sub reply without a waiter", async () => {
    const { fake, delivery } = setup();
    expect((await delivery.receiveReply(REG_A, replyBody({ origin: "sub" }))).outcome).toBe(
      "not-found",
    );
    expect(fake.sent).toEqual([]);
  });
});

describe("message details (#251 G5)", () => {
  /** The details of the one landed entry, decoded with its content. */
  const landedDetails = (fake: FakeSession) => {
    expect(fake.state.entries).toHaveLength(1);
    const decoded = decodeTalkMessage(fake.state.entries[0]);
    if (decoded === undefined) throw new Error("the landed entry does not decode");
    return decoded;
  };

  const attachments: ReadonlyArray<Attachment> = [
    { type: "file", name: "a.ts", content: "export {};" },
    { type: "context", name: "notes", content: "**Attachment (file): `x`**" },
  ];

  it("writes versioned details for a send that decode, and the watch confirms it", async () => {
    const { fake, delivery } = setup();
    const body = sendBody({ text: "line 1\nline 2", attachments, sentAt: 1_700_000_000_000 });
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    const { content, details } = landedDetails(fake);
    expect(content).toBe(formatDelivery(body).content);
    expect(details).toEqual({
      v: 1,
      messageId: body.messageId,
      kind: "message",
      from: body.from,
      sentAt: body.sentAt,
      attachments: [
        { kind: "file", name: "a.ts" },
        { kind: "context", name: "notes" },
      ],
      body: formatDelivery(body).body,
    });
    expect(content.slice(details.body.start, details.body.end)).toBe(body.text);
    expect(talkMessageId(fake.state.entries[0])).toBe(body.messageId);
  });

  it("writes the kind ask and the ask id for an ask", async () => {
    const { fake, delivery } = setup();
    const body = askBody({ text: "one\ntwo\nthree" });
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    const { content, details } = landedDetails(fake);
    expect(details.kind).toBe("ask");
    expect(details.askId).toBe(body.messageId);
    expect(content.slice(details.body.start, details.body.end)).toBe(body.text);
  });

  it("writes the kind reply and the ask that it answers for a main reply", async () => {
    const { fake, delivery } = setup();
    const body = replyBody({ origin: "main" });
    expect((await delivery.receiveReply(REG_A, body)).outcome).toBe("delivered");
    const { content, details } = landedDetails(fake);
    expect(details.kind).toBe("reply");
    expect(details.askId).toBe(body.askId);
    expect(details.messageId).toBe(body.messageId);
    expect(content.slice(details.body.start, details.body.end)).toBe(body.text);
  });

  it("writes the kind handover with a wake for a handover (#251 G6)", async () => {
    const { fake, delivery } = setup();
    const body = sendBody({ kind: "handover", text: "## Next task\nShip it." });
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("delivered");
    const { content, details } = landedDetails(fake);
    expect(details.kind).toBe("handover");
    expect(details.askId).toBeUndefined();
    expect(content.startsWith("**Handover from ")).toBe(true);
    expect(content.slice(details.body.start, details.body.end)).toBe(body.text);
    expect(fake.sent[0]?.options).toEqual({ triggerTurn: true });
  });

  it("keeps the details of a queued message until it goes out, and the watch confirms it", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const body = askBody({ attachments });
    expect((await delivery.deliver(REG_A, body)).outcome).toBe("queued");
    fake.idle = true;
    await vi.advanceTimersByTimeAsync(QUEUE_RETRY_MS);
    await flushMicrotasks();
    const { details } = landedDetails(fake);
    expect(details.kind).toBe("ask");
    expect(details.attachments.map((attachment) => attachment.kind)).toEqual(["file", "context"]);
    expect(cancelOf(delivery, body.messageId)).toBe("delivered");
  });
});

describe("request handlers", () => {
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

  const handlersFor = (delivery: TalkDelivery | undefined) => {
    const asks = makeAskStore(clock);
    asks.noteAgent({ id: "asker", parentId: undefined, main: true });
    asks.setRegistration("asker", { registration: ASKER, isCurrent: () => true });
    const handlers = new Map(
      talkRequestHandlers({
        receiverFor: (registration) =>
          delivery !== undefined && registration.instanceId === delivery.registration?.instanceId
            ? delivery
            : undefined,
        asks,
      }),
    );
    const call = (kind: string, json: Schema.Json, registration: Target = REG_A) => {
      const handler = handlers.get(kind);
      if (handler === undefined) throw new Error(`no handler for ${kind}`);
      return run(handler(json, { registration, kind }));
    };
    return { asks, call, kinds: [...handlers.keys()] };
  };

  it("handles deliver, reply, and cancel with the Step 1 codecs", async () => {
    const { fake, delivery } = setup();
    fake.idle = false;
    const { call, kinds } = handlersFor(delivery);
    expect([...kinds].sort()).toEqual([CANCEL_KIND, DELIVER_KIND, REPLY_KIND].sort());
    const body = sendBody();
    expect(await call(DELIVER_KIND, await run(encodeDeliverBody(body)))).toEqual({
      outcome: "queued",
      messageId: body.messageId,
      instanceId: REG_A.instanceId,
    });
    expect(
      await call(
        CANCEL_KIND,
        await run(encodeCancelBody({ messageId: body.messageId, senderSessionId: SENDER })),
      ),
    ).toEqual({ outcome: "cancelled", messageId: body.messageId, instanceId: REG_A.instanceId });
    expect(
      await call(DELIVER_KIND, await run(encodeDeliverBody(sendBody())), REG_A2),
    ).toMatchObject({
      outcome: "not-live",
    });
  });

  it("completes a matching waiter before the busy rules, without a transcript append", async () => {
    const { fake, delivery } = setup();
    fake.mode = "print";
    fake.idle = false;
    const { asks, call } = handlersFor(delivery);
    const askId = nextMessageId();
    const replier = REG_A;
    const waiting = asks.ask({
      agent: { id: "asker", parentId: undefined, main: true },
      askId,
      target: replier,
      deliver: async () => ({
        outcome: "delivered",
        messageId: askId,
        instanceId: replier.instanceId,
      }),
    });
    await flushMicrotasks();
    const reply = replyBody({ askId, replier, origin: "main" });
    expect(await call(REPLY_KIND, await run(encodeReplyBody(reply)))).toEqual({
      outcome: "delivered",
      messageId: reply.messageId,
      instanceId: REG_A.instanceId,
    });
    expect(await waiting).toMatchObject({ _tag: "Replied", reply });
    expect(fake.sent).toEqual([]);
  });

  it("drops a sub reply that matches no waiter, also after the ask timed out", async () => {
    const { fake, delivery } = setup();
    const { asks, call } = handlersFor(delivery);
    const askId = nextMessageId();
    const waiting = asks.ask({
      agent: { id: "asker", parentId: undefined, main: true },
      askId,
      target: REG_A,
      timeoutMs: 1_000,
      deliver: async () => ({
        outcome: "delivered",
        messageId: askId,
        instanceId: REG_A.instanceId,
      }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await waiting)._tag).toBe("TimedOut");
    const reply = replyBody({ askId, replier: REG_A, origin: "sub" });
    expect(await call(REPLY_KIND, await run(encodeReplyBody(reply)))).toMatchObject({
      outcome: "not-found",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fake.sent).toEqual([]);
    expect(fake.state.entries).toEqual([]);
  });

  it("answers not-live for a registration without a receiver", async () => {
    const { call } = handlersFor(undefined);
    expect(await call(REPLY_KIND, await run(encodeReplyBody(replyBody())))).toMatchObject({
      outcome: "not-live",
    });
    expect(
      await call(
        CANCEL_KIND,
        await run(encodeCancelBody({ messageId: nextMessageId(), senderSessionId: SENDER })),
      ),
    ).toMatchObject({ outcome: "not-live" });
  });
});
