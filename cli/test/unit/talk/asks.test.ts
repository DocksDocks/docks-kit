import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ASK_TIMEOUT_MS,
  type AgentRef,
  PREVIEW_LENGTH,
  makeAskStore,
  makePendingAsks,
} from "../../../talk/tool/asks";
import { systemClock } from "../../../talk/tool/host";
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
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
  store.setRegistration(MAIN.id, MAIN_REG);
  return store;
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
    store.setRegistration(MAIN.id, undefined);
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
    store.setRegistration("main-2", OTHER_REG);
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
    const [entry] = pending.list();
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
    expect(pending.list().map((entry) => entry.askId)).toEqual(["0000000000000002"]);
    await vi.advanceTimersByTimeAsync(ASK_TIMEOUT_MS - 1);
    expect(pending.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.list()).toEqual([]);
  });

  it("selects the reply target by replyTo or as the only pending ask", () => {
    const pending = makePendingAsks(clock);
    expect(pending.select(undefined)).toEqual({ _tag: "None" });
    pending.add(ask("0000000000000001"), PEER);
    expect(pending.select(undefined)).toMatchObject({
      _tag: "Found",
      ask: { askId: "0000000000000001" },
    });
    pending.add(ask("0000000000000002"), PEER);
    expect(pending.select(undefined)).toMatchObject({ _tag: "Ambiguous" });
    expect(pending.select("0000000000000002")).toMatchObject({
      _tag: "Found",
      ask: { askId: "0000000000000002" },
    });
    expect(pending.select("00000000000000ff")).toEqual({ _tag: "NotFound" });
  });
});
