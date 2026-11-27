/**
 * Asks and replies of the talk tool (#250 E6): the process store of ask
 * waiters and reply addresses, which Step 4 keeps in the process singleton
 * (E12), and the pending inbound asks of one session.
 */
import { oneLine } from "./attachments";
import type { CancelTimer, TalkClock } from "./host";
import {
  type AskRoute as AskRouteSchema,
  type DeliverBody,
  type DeliverResult,
  type ReplyBody,
  type Sender as SenderSchema,
  acceptsDelivery,
} from "./protocol";
import type { Target } from "../transport/request";

type AskRoute = typeof AskRouteSchema.Type;
type Sender = typeof SenderSchema.Type;

/** The default ask timeout (#248 D2 Frames). */
export const ASK_TIMEOUT_MS = 10 * 60 * 1_000;

/** The characters of text that `pending` shows for each ask (F1). */
export const PREVIEW_LENGTH = 80;

/** One agent session: `ctx.agent.id`, `ctx.agent.parentId`, and whether `ctx.agent.kind` is `main`. */
export interface AgentRef {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly main: boolean;
}

/**
 * The registration of a main session and the check of its owning binding:
 * true while the registration is still the binding's current one. A check
 * that throws counts as false.
 */
export interface LiveRegistration {
  readonly registration: Target;
  readonly isCurrent: () => boolean;
}

/** How a waiter ended. */
export type WaitResult =
  | { readonly _tag: "Replied"; readonly reply: ReplyBody }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "Aborted" };

/** One ask of the `ask` action. */
export interface AskRequest {
  readonly agent: AgentRef;
  /** The message id of the ask. */
  readonly askId: string;
  /** The registration that the ask goes to; only its reply completes the waiter. */
  readonly target: Target;
  /** Default `ASK_TIMEOUT_MS`. */
  readonly timeoutMs?: number | undefined;
  /** The tool `signal`: an abort ends the wait. */
  readonly signal?: AbortSignal | undefined;
  /** Sends the ask with its route; a rejection means that the request failed. */
  readonly deliver: (route: AskRoute) => Promise<DeliverResult>;
}

/**
 * The end of one ask. `result` is the receiver's acknowledgement; it is
 * undefined when the waiter ended before the acknowledgement came.
 */
export type AskOutcome =
  /** No live registration of the session or of an ancestor: nothing was sent. */
  | { readonly _tag: "NoReplyAddress" }
  /** The session already waits for a reply: nothing was sent. */
  | { readonly _tag: "WaiterBusy" }
  /** The receiver did not accept the ask: `busy`, `not-live`, or `no-reply-route`. */
  | { readonly _tag: "Refused"; readonly result: DeliverResult }
  | {
      readonly _tag: "Replied";
      readonly result: DeliverResult | undefined;
      readonly reply: ReplyBody;
    }
  | { readonly _tag: "TimedOut"; readonly result: DeliverResult | undefined }
  /** `result` is also undefined when the signal aborted before the ask went out. */
  | { readonly _tag: "Aborted"; readonly result: DeliverResult | undefined };

/** The process store of E6. */
export interface AskStore {
  /** Records the parent of an agent session; each binding calls it at `session_start`. */
  readonly noteAgent: (agent: AgentRef) => void;
  /**
   * The binding of an agent session ended. Its entry of the agent map goes
   * once no noted agent session names it as parent, and so on up the map.
   */
  readonly forgetAgent: (agentId: string) => void;
  /** Sets the live registration of a main session. */
  readonly setRegistration: (agentId: string, live: LiveRegistration) => void;
  /** Clears the registration of a main session when it is the given one. */
  readonly clearRegistration: (agentId: string, registration: Target) => void;
  /**
   * The reply address of an ask: the session's own registration for a main
   * session, else the registration of the nearest ancestor that has one.
   * Undefined when none is kept, or when the kept one is no longer the
   * current registration of its binding.
   */
  readonly replyAddress: (agent: AgentRef) => AskRoute | undefined;
  /**
   * Sends an ask and waits for its reply, its timeout, or the abort of its
   * signal. A reply or an abort ends the wait also before the receiver's
   * acknowledgement; a refusal or a failed request ends it only while no
   * reply came.
   */
  readonly ask: (request: AskRequest) => Promise<AskOutcome>;
  /**
   * Completes the waiter of a reply that matches it by ask id and by the
   * registration that received the ask. False when no waiter matches.
   */
  readonly complete: (reply: ReplyBody) => boolean;
}

interface Waiter {
  readonly expected: Target;
  readonly settled: Promise<WaitResult>;
  /** Ends the wait; false when it ended before. */
  readonly settle: (result: WaitResult) => boolean;
}

type Acknowledgement =
  | { readonly _tag: "Acknowledged"; readonly result: DeliverResult }
  | { readonly _tag: "RequestFailed"; readonly error: unknown };

type FirstEnd = Acknowledgement | { readonly _tag: "Waited"; readonly ended: WaitResult };

const isCurrent = (live: LiveRegistration): boolean => {
  try {
    return live.isCurrent();
  } catch {
    return false;
  }
};

const waited = (ended: WaitResult, result: DeliverResult | undefined): AskOutcome =>
  ended._tag === "Replied"
    ? { _tag: "Replied", result, reply: ended.reply }
    : { _tag: ended._tag, result };

export const makeAskStore = (clock: TalkClock): AskStore => {
  const parents = new Map<string, string | undefined>();
  /** Agents whose binding ended while a noted agent still named them as parent. */
  const ended = new Set<string>();
  const registrations = new Map<string, LiveRegistration>();
  const waitersByAsk = new Map<string, Waiter>();
  const waitingAgents = new Set<string>();

  const replyAddress = (agent: AgentRef): AskRoute | undefined => {
    if (agent.main) {
      const own = registrations.get(agent.id);
      return own === undefined || !isCurrent(own)
        ? undefined
        : { origin: "main", replyTo: own.registration };
    }
    const seen = new Set<string>([agent.id]);
    let ancestor = agent.parentId;
    while (ancestor !== undefined && !seen.has(ancestor)) {
      const live = registrations.get(ancestor);
      // The nearest registration decides: a stale one gives no address, never a farther one.
      if (live !== undefined)
        return isCurrent(live) ? { origin: "sub", replyTo: live.registration } : undefined;
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    return undefined;
  };

  const hasChild = (agentId: string): boolean => {
    for (const parentId of parents.values()) if (parentId === agentId) return true;
    return false;
  };

  /** Drops the entries of ended agents that no noted agent names as parent, up the map. */
  const release = (agentId: string): void => {
    let next: string | undefined = agentId;
    while (next !== undefined && ended.has(next) && !hasChild(next)) {
      const parentId = parents.get(next);
      ended.delete(next);
      parents.delete(next);
      next = parentId;
    }
  };

  /** Registers a waiter before the ask goes out, so a fast reply finds it. */
  const begin = (request: AskRequest): Waiter => {
    const { promise: settled, resolve } = Promise.withResolvers<WaitResult>();
    let cancelTimer: CancelTimer = () => {};
    const onAbort = (): void => {
      waiter.settle({ _tag: "Aborted" });
    };
    const waiter: Waiter = {
      expected: request.target,
      settled,
      settle: (result) => {
        if (waitersByAsk.get(request.askId) !== waiter) return false;
        waitersByAsk.delete(request.askId);
        waitingAgents.delete(request.agent.id);
        cancelTimer();
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
        return true;
      },
    };
    waitersByAsk.set(request.askId, waiter);
    waitingAgents.add(request.agent.id);
    cancelTimer = clock.schedule(request.timeoutMs ?? ASK_TIMEOUT_MS, () => {
      waiter.settle({ _tag: "TimedOut" });
    });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    return waiter;
  };

  const ask = async (request: AskRequest): Promise<AskOutcome> => {
    const route = replyAddress(request.agent);
    if (route === undefined) return { _tag: "NoReplyAddress" };
    if (waitingAgents.has(request.agent.id)) return { _tag: "WaiterBusy" };
    if (request.signal?.aborted === true) return { _tag: "Aborted", result: undefined };
    const waiter = begin(request);
    const acknowledged: Promise<Acknowledgement> = request.deliver(route).then(
      (result) => ({ _tag: "Acknowledged", result }),
      (error: unknown) => ({ _tag: "RequestFailed", error }),
    );
    // A reply or an abort can come before the acknowledgement: it ends the call at once.
    const first: FirstEnd = await Promise.race([
      acknowledged,
      waiter.settled.then((end): FirstEnd => ({ _tag: "Waited", ended: end })),
    ]);
    switch (first._tag) {
      case "Waited":
        return waited(first.ended, undefined);
      case "RequestFailed":
        // A reply that came first wins over the failure of its request.
        if (!waiter.settle({ _tag: "Aborted" })) return waited(await waiter.settled, undefined);
        throw first.error;
      case "Acknowledged": {
        const { result } = first;
        if (acceptsDelivery(result.outcome)) return waited(await waiter.settled, result);
        // A refusal ends the call only while no reply came.
        if (!waiter.settle({ _tag: "Aborted" })) return waited(await waiter.settled, result);
        return { _tag: "Refused", result };
      }
    }
  };

  const complete = (reply: ReplyBody): boolean => {
    const waiter = waitersByAsk.get(reply.askId);
    if (
      waiter === undefined ||
      waiter.expected.instanceId !== reply.replier.instanceId ||
      waiter.expected.sessionId !== reply.replier.sessionId
    )
      return false;
    return waiter.settle({ _tag: "Replied", reply });
  };

  return {
    noteAgent: (agent) => {
      parents.set(agent.id, agent.parentId);
      ended.delete(agent.id);
    },
    forgetAgent: (agentId) => {
      if (!parents.has(agentId)) return;
      ended.add(agentId);
      release(agentId);
    },
    setRegistration: (agentId, live) => {
      registrations.set(agentId, live);
    },
    clearRegistration: (agentId, registration) => {
      const kept = registrations.get(agentId)?.registration;
      if (kept?.instanceId === registration.instanceId && kept.sessionId === registration.sessionId)
        registrations.delete(agentId);
    },
    replyAddress,
    ask,
    complete,
  };
};

/** One unanswered inbound ask, as `pending` and `reply` read it. */
export interface PendingAsk {
  readonly askId: string;
  readonly from: Sender;
  /** The origin flag and the reply address of the ask. */
  readonly route: AskRoute;
  /** The registration that received the ask: the `replier` of the reply. */
  readonly receivedBy: Target;
  readonly ageMs: number;
  /** The first `PREVIEW_LENGTH` characters of the text, on one line. */
  readonly preview: string;
}

/** The reply target that `reply` takes from the pending asks (F2). */
export type PendingSelection =
  | { readonly _tag: "Found"; readonly ask: PendingAsk }
  /** `replyTo` names no pending ask. */
  | { readonly _tag: "NotFound" }
  /** No `replyTo` and no pending ask. */
  | { readonly _tag: "None" }
  /** No `replyTo` and more than one pending ask. */
  | { readonly _tag: "Ambiguous"; readonly asks: ReadonlyArray<PendingAsk> };

/**
 * The pending inbound asks of one binding (E6). Each ask belongs to the
 * registration that received it: `list` and `select` show only the asks of
 * the registration that the caller names, and none for an undefined one.
 */
export interface PendingAsks {
  /** Keeps an accepted ask until its reply, the ask timeout, or `clear`. */
  readonly add: (body: DeliverBody & { readonly ask: AskRoute }, receivedBy: Target) => void;
  readonly remove: (askId: string) => void;
  /** Ends every pending ask: their registration ended. */
  readonly clear: () => void;
  /** The unexpired asks of the registration, oldest first. */
  readonly list: (receivedBy: Target | undefined) => ReadonlyArray<PendingAsk>;
  readonly select: (
    receivedBy: Target | undefined,
    replyTo: string | undefined,
  ) => PendingSelection;
}

interface StoredAsk {
  readonly askId: string;
  readonly from: Sender;
  readonly route: AskRoute;
  readonly receivedBy: Target;
  readonly receivedAt: number;
  readonly preview: string;
}

/**
 * The store expires each ask from a timer of its own, so an ask that no call
 * reads does not stay; the timer runs only while the store holds an ask.
 */
export const makePendingAsks = (clock: TalkClock, timeoutMs = ASK_TIMEOUT_MS): PendingAsks => {
  const asks = new Map<string, StoredAsk>();
  let cancelExpiry: CancelTimer | undefined;

  const stopExpiry = (): void => {
    cancelExpiry?.();
    cancelExpiry = undefined;
  };

  /** Removes the expired asks and plans the next expiry, or none for an empty store. */
  const expire = (): void => {
    stopExpiry();
    const now = clock.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [askId, stored] of asks) {
      const deadline = stored.receivedAt + timeoutMs;
      if (now >= deadline) asks.delete(askId);
      else next = Math.min(next, deadline);
    }
    if (asks.size > 0) cancelExpiry = clock.schedule(next - now, expire);
  };

  const list = (receivedBy: Target | undefined): ReadonlyArray<PendingAsk> => {
    if (receivedBy === undefined) return [];
    const now = clock.now();
    const live: Array<PendingAsk> = [];
    for (const { receivedAt, ...stored } of asks.values()) {
      if (
        now - receivedAt < timeoutMs &&
        stored.receivedBy.instanceId === receivedBy.instanceId &&
        stored.receivedBy.sessionId === receivedBy.sessionId
      )
        live.push({ ...stored, ageMs: now - receivedAt });
    }
    return live;
  };

  return {
    add: (body, receivedBy) => {
      asks.set(body.messageId, {
        askId: body.messageId,
        from: body.from,
        route: body.ask,
        receivedBy,
        receivedAt: clock.now(),
        preview: oneLine(body.text).slice(0, PREVIEW_LENGTH),
      });
      cancelExpiry ??= clock.schedule(timeoutMs, expire);
    },
    remove: (askId) => {
      asks.delete(askId);
      if (asks.size === 0) stopExpiry();
    },
    clear: () => {
      asks.clear();
      stopExpiry();
    },
    list,
    select: (receivedBy, replyTo) => {
      const live = list(receivedBy);
      if (replyTo !== undefined) {
        const found = live.find((entry) => entry.askId === replyTo);
        return found === undefined ? { _tag: "NotFound" } : { _tag: "Found", ask: found };
      }
      const [only, ...rest] = live;
      if (only === undefined) return { _tag: "None" };
      return rest.length === 0 ? { _tag: "Found", ask: only } : { _tag: "Ambiguous", asks: live };
    },
  };
};
