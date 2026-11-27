import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASK_TIMEOUT_MS,
  type AgentRef,
  CLOSED_AFTER_SWEEPS,
  PREVIEW_LENGTH,
  makeAskStore,
  makePendingAsks,
} from "../../../talk/tool/asks";
import { type TalkClock, systemClock } from "../../../talk/tool/host";
import type {
  AskRoute as AskRouteSchema,
  DeliverBody,
  DeliverResult,
  ReplyBody,
} from "../../../talk/tool/protocol";
import type { Target } from "../../../talk/transport/request";

type AskRoute = typeof AskRouteSchema.Type;

// The ask waiters, reply addresses, and pending inbound asks of #250 E6.
const MAIN_REG: Target = { instanceId: "00000000000000a1", sessionId: "session-main" };
const OTHER_REG: Target = { instanceId: "00000000000000a2", sessionId: "session-other" };
const PEER: Target = { instanceId: "00000000000000b1", sessionId: "session-peer" };
const IMPOSTOR: Target = { instanceId: "00000000000000b2", sessionId: "session-peer" };
const ASK_ID = "1122334455667788";

const MAIN: AgentRef = { id: "main-1", parentId: undefined, main: true };
const CHILD: AgentRef = { id: "child-1", parentId: "main-1", main: false };
const GRANDCHILD: AgentRef = { id: "child-2", parentId: "child-1", main: false };

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

const result = (outcome: DeliverResult["outcome"]): DeliverResult => ({
  outcome,
  messageId: ASK_ID,
  instanceId: PEER.instanceId,
});

const reply = (overrides: Partial<ReplyBody> = {}): ReplyBody => ({
  messageId: "99aa99aa99aa99aa",
  from: { name: "peer", cwd: "/work/peer", sessionId: PEER.sessionId },
  text: "The build passes.",
  attachments: [],
  sentAt: 0,
  noWake: false,
  replier: PEER,
  askId: ASK_ID,
  origin: "main",
  ...overrides,
});

const storeWithMain = () => {
  const store = makeAskStore(clock);
  store.noteAgent(MAIN);
  store.noteAgent(CHILD);
  store.noteAgent(GRANDCHILD);
  store.setRegistration(MAIN.id, { registration: MAIN_REG, isCurrent: () => true });
  return store;
};

const MAP_ITERATORS = ["values", "keys", "entries", "forEach", Symbol.iterator] as const;

/**
 * Runs `body` and counts the iterations of a `Map` or a `Set` that start in
 * it. A count of 0 shows that `body` scanned no collection.
 */
const collectionScans = (body: () => void): number => {
  let scans = 0;
  const restore: Array<() => void> = [];
  for (const prototype of [Map.prototype, Set.prototype])
    for (const key of MAP_ITERATORS) {
      const original: unknown = Reflect.get(prototype, key);
      if (typeof original !== "function") continue;
      Reflect.set(prototype, key, function (this: unknown, ...args: Array<unknown>) {
        scans += 1;
        return Reflect.apply(original, this, args);
      });
      restore.push(() => Reflect.set(prototype, key, original));
    }
  try {
    body();
  } finally {
    for (const undo of restore) undo();
  }
  return scans;
};

describe("reply address", () => {
  it("gives a main session its own registration with the flag main", () => {
    expect(storeWithMain().replyAddress(MAIN)).toEqual({ origin: "main", replyTo: MAIN_REG });
  });

  it("gives a subagent the registration of the main session that it descends from", () => {
    const store = storeWithMain();
    expect(store.replyAddress(CHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
    expect(store.replyAddress(GRANDCHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
  });

  it("gives no address when no ancestor has a live registration", () => {
    const store = storeWithMain();
    store.clearRegistration(MAIN.id, MAIN_REG);
    expect(store.replyAddress(MAIN)).toBeUndefined();
    expect(store.replyAddress(GRANDCHILD)).toBeUndefined();
    expect(store.replyAddress({ id: "orphan", parentId: "unknown", main: false })).toBeUndefined();
  });

  it("ends the walk on a cycle in the agent map", () => {
    const store = makeAskStore(clock);
    store.noteAgent({ id: "loop-a", parentId: "loop-b", main: false });
    store.noteAgent({ id: "loop-b", parentId: "loop-a", main: false });
    expect(store.replyAddress({ id: "loop-a", parentId: "loop-b", main: false })).toBeUndefined();
  });

  it("gives no address when the kept registration is no longer its binding's current one", () => {
    const store = storeWithMain();
    let current = true;
    store.setRegistration(MAIN.id, { registration: MAIN_REG, isCurrent: () => current });
    expect(store.replyAddress(CHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
    current = false;
    expect(store.replyAddress(MAIN)).toBeUndefined();
    expect(store.replyAddress(CHILD)).toBeUndefined();
    store.setRegistration(MAIN.id, {
      registration: MAIN_REG,
      isCurrent: () => {
        throw new Error("getAllTools is missing");
      },
    });
    expect(store.replyAddress(MAIN)).toBeUndefined();
  });

  it("never skips a stale nearer registration for a farther one", () => {
    const store = storeWithMain();
    store.setRegistration(CHILD.id, { registration: OTHER_REG, isCurrent: () => false });
    expect(store.replyAddress(GRANDCHILD)).toBeUndefined();
  });

  it("clears a registration only when it is the kept one", () => {
    const store = storeWithMain();
    store.clearRegistration(MAIN.id, OTHER_REG);
    expect(store.replyAddress(MAIN)).toEqual({ origin: "main", replyTo: MAIN_REG });
  });
});

describe("agent map release (C13)", () => {
  /** An agent whose parent is `parentId`: its walk shows whether the map still holds that parent. */
  const probeOf = (parentId: string): AgentRef => ({ id: "probe", parentId, main: false });

  it("keeps an ended agent while a live subagent names it, and releases the chain after", () => {
    const store = storeWithMain();
    store.forgetAgent(CHILD.id);
    // The grandchild still walks through the ended child.
    expect(store.replyAddress(GRANDCHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
    expect(store.replyAddress(probeOf(CHILD.id))).toEqual({ origin: "sub", replyTo: MAIN_REG });
    store.forgetAgent(GRANDCHILD.id);
    // Both entries are gone: a walk that starts at the child finds no parent.
    expect(store.replyAddress(probeOf(CHILD.id))).toBeUndefined();
    expect(store.replyAddress(probeOf(GRANDCHILD.id))).toBeUndefined();
  });

  it("ignores an agent that it never noted, and keeps an agent noted again", () => {
    const store = storeWithMain();
    store.forgetAgent("never-noted");
    store.forgetAgent(CHILD.id);
    store.noteAgent(CHILD);
    store.forgetAgent(GRANDCHILD.id);
    expect(store.replyAddress(probeOf(CHILD.id))).toEqual({ origin: "sub", replyTo: MAIN_REG });
  });

  it("keeps no row for an agent without a parent, such as a main session", () => {
    const store = makeAskStore(clock);
    store.noteAgent(MAIN);
    expect(store.ancestryRows).toBe(0);
    store.noteAgent(CHILD);
    expect(store.ancestryRows).toBe(1);
    store.forgetAgent(MAIN.id);
    store.forgetAgent(CHILD.id);
    expect(store.ancestryRows).toBe(0);
  });

  it("keeps the row of a suspended binding, whose beats go on, for a subagent that it starts later (S6)", () => {
    const store = makeAskStore(clock);
    store.setRegistration(MAIN.id, { registration: MAIN_REG, isCurrent: () => true });
    store.noteAgent(MAIN);
    store.noteAgent(CHILD);
    // omp suspends the child's extension: its marker row goes, and its managed timer still beats (F13).
    for (let sweep = 0; sweep < 4 * CLOSED_AFTER_SWEEPS; sweep += 1) {
      store.beat(CHILD.id);
      store.sweepAgents();
    }
    expect(store.ancestryRows).toBe(1);
    // After the resume, the child starts a subagent that asks before the child calls talk.
    store.noteAgent(GRANDCHILD);
    expect(store.replyAddress(GRANDCHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
  });

  it("releases at the sweep the row of a binding that gave no beat in CLOSED_AFTER_SWEEPS sweeps, after its last subagent", () => {
    const store = makeAskStore(clock);
    store.setRegistration(MAIN.id, { registration: MAIN_REG, isCurrent: () => true });
    store.noteAgent(MAIN);
    store.noteAgent(CHILD);
    store.noteAgent(GRANDCHILD);
    const sweepWithBeats = (...beating: ReadonlyArray<AgentRef>): void => {
      for (const agent of beating) store.beat(agent.id);
      store.sweepAgents();
    };
    // A note counts as a beat, so the missed sweeps of the child start again.
    for (let sweep = 1; sweep < CLOSED_AFTER_SWEEPS; sweep += 1) sweepWithBeats(GRANDCHILD);
    store.noteAgent(CHILD);
    // omp closed the child's binding without a session_shutdown: its beats stop (F16).
    for (let sweep = 1; sweep < CLOSED_AFTER_SWEEPS; sweep += 1) sweepWithBeats(GRANDCHILD);
    expect(store.ancestryRows).toBe(2);
    sweepWithBeats(GRANDCHILD);
    // The child ended; the grandchild still walks through it.
    expect(store.replyAddress(GRANDCHILD)).toEqual({ origin: "sub", replyTo: MAIN_REG });
    expect(store.ancestryRows).toBe(2);
    // A late beat does not bring the ended child back; the grandchild's binding closes too.
    for (let sweep = 0; sweep < CLOSED_AFTER_SWEEPS; sweep += 1) sweepWithBeats(CHILD);
    expect(store.ancestryRows).toBe(0);
    expect(store.replyAddress(probeOf(CHILD.id))).toBeUndefined();
  });

  it("counts the subagents of an agent, also one noted before its parent or noted again under another parent", () => {
    const store = makeAskStore(clock);
    store.setRegistration(MAIN.id, { registration: MAIN_REG, isCurrent: () => true });
    store.noteAgent({ id: "leaf", parentId: "mid", main: false });
    store.noteAgent({ id: "mid", parentId: MAIN.id, main: false });
    store.forgetAgent("mid");
    // The leaf, noted first, still holds the ended parent.
    expect(store.replyAddress(probeOf("mid"))).toEqual({ origin: "sub", replyTo: MAIN_REG });
    expect(store.ancestryRows).toBe(2);
    // The leaf moves to another parent: the ended parent has no subagent left and goes.
    store.noteAgent({ id: "leaf", parentId: MAIN.id, main: false });
    expect(store.ancestryRows).toBe(1);
    expect(store.replyAddress(probeOf("mid"))).toBeUndefined();
    store.forgetAgent("leaf");
    expect(store.ancestryRows).toBe(0);
  });

  it("releases each of many sibling leaves without a scan of the agent map (C13)", () => {
    const store = makeAskStore(clock);
    store.noteAgent(MAIN);
    store.noteAgent({ id: "mid", parentId: MAIN.id, main: false });
    const leaves = Array.from({ length: 1_000 }, (_, index) => `leaf-${index}`);
    for (const id of leaves) store.noteAgent({ id, parentId: "mid", main: false });
    store.forgetAgent("mid");
    expect(store.ancestryRows).toBe(1 + leaves.length);
    const scans = collectionScans(() => {
      for (const id of leaves) store.forgetAgent(id);
    });
    expect(scans).toBe(0);
    expect(store.ancestryRows).toBe(0);
  });
});

describe("ask", () => {
  it("fails at once with no reply address and sends nothing", async () => {
    const store = makeAskStore(clock);
    const deliver = vi.fn(async () => result("delivered"));
    const outcome = await store.ask({ agent: CHILD, askId: ASK_ID, target: PEER, deliver });
    expect(outcome).toEqual({ _tag: "NoReplyAddress" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("completes with the reply of the expected sender, with the route in the ask", async () => {
    const store = storeWithMain();
    const routes: Array<AskRoute> = [];
    const pending = store.ask({
      agent: CHILD,
      askId: ASK_ID,
      target: PEER,
      deliver: async (route) => {
        routes.push(route);
        return result("submitted");
      },
    });
    await flushMicrotasks();
    expect(routes).toEqual([{ origin: "sub", replyTo: MAIN_REG }]);
    expect(store.complete(reply({ origin: "sub" }))).toBe(true);
    expect(await pending).toEqual({
      _tag: "Replied",
      result: result("submitted"),
      reply: reply({ origin: "sub" }),
    });
    // The waiter is gone: a second reply finds none.
    expect(store.complete(reply({ origin: "sub" }))).toBe(false);
  });

  it("does not complete on a reply from another sender or to another ask", async () => {
    const store = storeWithMain();
    const state = peek(
      store.ask({
        agent: MAIN,
        askId: ASK_ID,
        target: PEER,
        deliver: async () => result("delivered"),
      }),
    );
    await flushMicrotasks();
    expect(store.complete(reply({ replier: IMPOSTOR }))).toBe(false);
    expect(store.complete(reply({ askId: "8877665544332211" }))).toBe(false);
    await flushMicrotasks();
    expect(state.done).toBe(false);
    expect(store.complete(reply())).toBe(true);
    await flushMicrotasks();
    expect(state.value?._tag).toBe("Replied");
  });

  it.each(["busy", "not-live", "no-reply-route"] as const)(
    "fails at once when the receiver answers %s and frees the waiter",
    async (outcome) => {
      const store = storeWithMain();
      expect(
        await store.ask({
          agent: MAIN,
          askId: ASK_ID,
          target: PEER,
          deliver: async () => result(outcome),
        }),
      ).toEqual({ _tag: "Refused", result: result(outcome) });
      expect(store.complete(reply())).toBe(false);
      // The session can ask again at once.
      const again = peek(
        store.ask({
          agent: MAIN,
          askId: ASK_ID,
          target: PEER,
          deliver: async () => result("queued"),
        }),
      );
      await flushMicrotasks();
      expect(store.complete(reply())).toBe(true);
      await flushMicrotasks();
      expect(again.value?._tag).toBe("Replied");
    },
  );

  it("frees the waiter and passes on the error when the request fails", async () => {
    const store = storeWithMain();
    const failure = new Error("unreachable");
    await expect(
      store.ask({
        agent: MAIN,
        askId: ASK_ID,
        target: PEER,
        deliver: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(store.complete(reply())).toBe(false);
  });

  it("allows one waiter per session", async () => {
    const store = storeWithMain();
    store.noteAgent({ id: "main-2", parentId: undefined, main: true });
    store.setRegistration("main-2", { registration: OTHER_REG, isCurrent: () => true });
    const deliver = vi.fn(async () => result("delivered"));
    const first = peek(store.ask({ agent: MAIN, askId: ASK_ID, target: PEER, deliver }));
    await flushMicrotasks();
    expect(
      await store.ask({ agent: MAIN, askId: "0000000000000002", target: PEER, deliver }),
    ).toEqual({ _tag: "WaiterBusy" });
    expect(deliver).toHaveBeenCalledTimes(1);
    // Another session of the process waits beside it.
    const other = peek(
      store.ask({
        agent: { id: "main-2", parentId: undefined, main: true },
        askId: "0000000000000003",
        target: PEER,
        deliver,
      }),
    );
    await flushMicrotasks();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(store.complete(reply({ askId: "0000000000000003" }))).toBe(true);
    await flushMicrotasks();
    expect(other.value?._tag).toBe("Replied");
    expect(first.done).toBe(false);
  });

  it("times out after 10 minutes by default and drops a later reply", async () => {
    const store = storeWithMain();
    const state = peek(
      store.ask({
        agent: MAIN,
        askId: ASK_ID,
        target: PEER,
        deliver: async () => result("queued"),
      }),
    );
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.value).toEqual({ _tag: "TimedOut", result: result("queued") });
    expect(ASK_TIMEOUT_MS).toBe(600_000);
    expect(store.complete(reply())).toBe(false);
  });

  it("stops waiting when the tool signal aborts", async () => {
    const store = storeWithMain();
    const controller = new AbortController();
    const state = peek(
      store.ask({
        agent: MAIN,
        askId: ASK_ID,
        target: PEER,
        signal: controller.signal,
        deliver: async () => result("delivered"),
      }),
    );
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    expect(state.value).toEqual({ _tag: "Aborted", result: result("delivered") });
    expect(store.complete(reply())).toBe(false);
  });

  it("sends nothing when the signal aborted before the ask", async () => {
    const store = storeWithMain();
    const controller = new AbortController();
    controller.abort();
    const deliver = vi.fn(async () => result("delivered"));
    expect(
      await store.ask({
        agent: MAIN,
        askId: ASK_ID,
        target: PEER,
        signal: controller.signal,
        deliver,
      }),
    ).toEqual({ _tag: "Aborted", result: undefined });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("ask before its acknowledgement (C3)", () => {
  /** A deliver whose acknowledgement the test settles later. */
  const heldDeliver = () => {
    const acknowledgement = Promise.withResolvers<DeliverResult>();
    return { acknowledgement, deliver: () => acknowledgement.promise };
  };

  it("ends with a reply that comes before the acknowledgement, which a later failure does not undo", async () => {
    const store = storeWithMain();
    const { acknowledgement, deliver } = heldDeliver();
    const state = peek(store.ask({ agent: MAIN, askId: ASK_ID, target: PEER, deliver }));
    await flushMicrotasks();
    expect(store.complete(reply())).toBe(true);
    await flushMicrotasks();
    expect(state.value).toEqual({ _tag: "Replied", result: undefined, reply: reply() });
    acknowledgement.reject(new Error("timeout"));
    await flushMicrotasks();
    expect(state.value?._tag).toBe("Replied");
  });

  it("ends at once with an abort that comes before the acknowledgement", async () => {
    const store = storeWithMain();
    const controller = new AbortController();
    const { deliver } = heldDeliver();
    const state = peek(
      store.ask({ agent: MAIN, askId: ASK_ID, target: PEER, signal: controller.signal, deliver }),
    );
    await flushMicrotasks();
    controller.abort();
    await flushMicrotasks();
    expect(state.value).toEqual({ _tag: "Aborted", result: undefined });
  });

  it("keeps a reply that came first when the acknowledgement refuses", async () => {
    const store = storeWithMain();
    const { acknowledgement, deliver } = heldDeliver();
    const state = peek(store.ask({ agent: MAIN, askId: ASK_ID, target: PEER, deliver }));
    await flushMicrotasks();
    store.complete(reply());
    acknowledgement.resolve(result("not-live"));
    await flushMicrotasks();
    expect(state.value?._tag).toBe("Replied");
  });

  it("fails with the request error while no reply came", async () => {
    const store = storeWithMain();
    const { acknowledgement, deliver } = heldDeliver();
    const failure = new Error("unreachable");
    const asked = store.ask({ agent: MAIN, askId: ASK_ID, target: PEER, deliver });
    acknowledgement.reject(failure);
    await expect(asked).rejects.toBe(failure);
    expect(store.complete(reply())).toBe(false);
  });
});

describe("pending inbound asks", () => {
  const ask = (
    messageId: string,
    text = "Is the build green?",
  ): DeliverBody & { readonly ask: AskRoute } => ({
    messageId,
    from: { name: "alice", cwd: "/work/alice", sessionId: "session-alice" },
    text,
    attachments: [],
    sentAt: 0,
    noWake: false,
    ask: { origin: "main", replyTo: MAIN_REG },
  });

  it("lists an ask with its sender, id, age, and an 80-character preview", async () => {
    const pending = makePendingAsks(clock);
    pending.add(ask("0000000000000001", `line one\nline two ${"x".repeat(200)}`), PEER);
    await vi.advanceTimersByTimeAsync(5_000);
    const [entry] = pending.list(PEER);
    expect(entry).toMatchObject({
      askId: "0000000000000001",
      from: { name: "alice", sessionId: "session-alice" },
      route: { origin: "main", replyTo: MAIN_REG },
      receivedBy: PEER,
      ageMs: 5_000,
    });
    expect(entry?.preview).toHaveLength(PREVIEW_LENGTH);
    expect(entry?.preview.startsWith("line one line two")).toBe(true);
  });

  it("keeps an ask until its reply or the ask timeout", async () => {
    const pending = makePendingAsks(clock);
    pending.add(ask("0000000000000001"), PEER);
    pending.add(ask("0000000000000002"), PEER);
    pending.remove("0000000000000001");
    expect(pending.list(PEER).map((entry) => entry.askId)).toEqual(["0000000000000002"]);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1);
    expect(pending.list(PEER)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.list(PEER)).toEqual([]);
  });

  it("expires asks from a timer of its own, without a read, and keeps no timer when empty", async () => {
    const pending = makePendingAsks(clock);
    expect(vi.getTimerCount()).toBe(0);
    pending.add(ask("0000000000000001"), PEER);
    await vi.advanceTimersByTimeAsync(5_000);
    pending.add(ask("0000000000000002"), PEER);
    expect(vi.getTimerCount()).toBe(1);
    // The first ask expires; the timer plans the expiry of the second.
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 5_000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    // The store is empty: no read ran, and no timer stays.
    expect(vi.getTimerCount()).toBe(0);
    pending.add(ask("0000000000000003"), PEER);
    pending.remove("0000000000000003");
    expect(vi.getTimerCount()).toBe(0);
    pending.add(ask("0000000000000004"), PEER);
    pending.clear();
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.list(PEER)).toEqual([]);
  });

  it("keeps the asks in expiry order: an ask received again moves behind the others and expires at its new deadline", async () => {
    const pending = makePendingAsks(clock);
    pending.add(ask("0000000000000001"), PEER);
    await vi.advanceTimersByTimeAsync(1_000);
    pending.add(ask("0000000000000002"), PEER);
    await vi.advanceTimersByTimeAsync(1_000);
    pending.add(ask("0000000000000001", "Is the build green now?"), PEER);
    const ids = (): Array<string> => pending.list(PEER).map((entry) => entry.askId);
    expect(ids()).toEqual(["0000000000000002", "0000000000000001"]);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1_000);
    expect(ids()).toEqual(["0000000000000001"]);
    await vi.advanceTimersByTimeAsync(999);
    expect(ids()).toEqual(["0000000000000001"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  const MINUTE_MS = 60 * 1_000;

  it("expires an ask that comes after the wall clock stepped back at its own timeout (C7)", async () => {
    const pending = makePendingAsks(clock);
    const ids = (): Array<string> => pending.list(PEER).map((entry) => entry.askId);
    pending.add(ask("0000000000000001"), PEER);
    vi.setSystemTime(Date.now() - 30 * MINUTE_MS);
    pending.add(ask("0000000000000002"), PEER);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1);
    expect(ids()).toEqual(["0000000000000001", "0000000000000002"]);
    // The sender of the second ask stops waiting now, so the ask ends with it.
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives an ask after a clock rollback no deadline of a removed later ask, and ages asks by the monotonic clock (S8)", async () => {
    const pending = makePendingAsks(clock);
    const ids = (): Array<string> => pending.list(PEER).map((entry) => entry.askId);
    pending.add(ask("0000000000000001"), PEER);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    pending.add(ask("0000000000000002"), PEER);
    pending.remove("0000000000000002");
    vi.setSystemTime(Date.now() - 5 * MINUTE_MS);
    pending.add(ask("0000000000000003"), PEER);
    expect(pending.list(PEER).map((entry) => entry.ageMs)).toEqual([5 * MINUTE_MS, 0]);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 5 * MINUTE_MS);
    expect(ids()).toEqual(["0000000000000003"]);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS - 1);
    expect(ids()).toEqual(["0000000000000003"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ids()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("examines only the due asks and the first live ask at an expiry (S4)", () => {
    let time = 0;
    let expiry: (() => void) | undefined;
    const manual: TalkClock = {
      now: () => time,
      elapsed: () => time,
      schedule: (_delayMs, callback) => {
        expiry = callback;
        return () => {
          if (expiry === callback) expiry = undefined;
        };
      },
    };
    const pending = makePendingAsks(manual, 1_000);
    const due = Array.from({ length: 10 }, (_, index) =>
      (index + 1).toString(16).padStart(16, "0"),
    );
    for (const askId of due) {
      pending.add(ask(askId), PEER);
      time += 1;
    }
    time = 500;
    const tail = Array.from({ length: 1_000 }, (_, index) =>
      (0x1000 + index).toString(16).padStart(16, "0"),
    );
    for (const askId of tail) pending.add(ask(askId), PEER);
    // Every ask of `due` is due; no ask of `tail` is.
    time = 1_009;
    const run = expiry;
    if (run === undefined) throw new Error("no expiry is planned");
    // Counts the steps of each `Map` iteration that starts in the expiry.
    let steps = 0;
    const original: unknown = Reflect.get(Map.prototype, Symbol.iterator);
    if (typeof original !== "function") throw new Error("Map has no iterator");
    Reflect.set(Map.prototype, Symbol.iterator, function (this: unknown) {
      const iterator: unknown = Reflect.apply(original, this, []);
      const next: unknown = Reflect.get(Object(iterator), "next");
      if (typeof next !== "function") throw new Error("the iterator has no next");
      return {
        next: () => {
          steps += 1;
          return Reflect.apply(next, iterator, []);
        },
        [Symbol.iterator]() {
          return this;
        },
      };
    });
    try {
      run();
    } finally {
      Reflect.set(Map.prototype, Symbol.iterator, original);
    }
    expect(steps).toBe(due.length + 1);
    expect(pending.list(PEER)).toHaveLength(tail.length);
    expect(expiry).toBeDefined();
  });

  it("shows each ask only to the registration that received it (C1)", () => {
    const pending = makePendingAsks(clock);
    pending.add(ask("0000000000000001"), PEER);
    expect(pending.list(IMPOSTOR)).toEqual([]);
    expect(pending.list(undefined)).toEqual([]);
    expect(pending.select(IMPOSTOR, undefined)).toEqual({ _tag: "None" });
    expect(pending.select(IMPOSTOR, "0000000000000001")).toEqual({ _tag: "NotFound" });
    expect(pending.select(undefined, "0000000000000001")).toEqual({ _tag: "NotFound" });
    expect(pending.list(PEER).map((entry) => entry.askId)).toEqual(["0000000000000001"]);
  });

  it("selects the reply target by replyTo or as the only pending ask", () => {
    const pending = makePendingAsks(clock);
    expect(pending.select(PEER, undefined)).toEqual({ _tag: "None" });
    pending.add(ask("0000000000000001"), PEER);
    expect(pending.select(PEER, undefined)).toMatchObject({
      _tag: "Found",
      ask: { askId: "0000000000000001" },
    });
    pending.add(ask("0000000000000002"), PEER);
    expect(pending.select(PEER, undefined)).toMatchObject({ _tag: "Ambiguous" });
    expect(pending.select(PEER, "0000000000000002")).toMatchObject({
      _tag: "Found",
      ask: { askId: "0000000000000002" },
    });
    expect(pending.select(PEER, "00000000000000ff")).toEqual({ _tag: "NotFound" });
  });
});
