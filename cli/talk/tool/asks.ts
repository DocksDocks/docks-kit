/**
 * Asks and replies of the talk tool (#250 E6): the process store of ask
 * waiters and reply addresses, which Step 4 keeps in the process singleton
 * (E12), and the pending inbound asks of one session.
 */
import { oneLine } from "./attachments";
import type { TalkClock } from "./host";
import type {
  AskRoute as AskRouteSchema,
  DeliverBody,
  DeliverResult,
  ReplyBody,
  Sender as SenderSchema,
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

/** The end of one ask. */
export type AskOutcome =
  /** No live registration of the session or of an ancestor: nothing was sent. */
  | { readonly _tag: "NoReplyAddress" }
  /** The session already waits for a reply: nothing was sent. */
  | { readonly _tag: "WaiterBusy" }
  /** The receiver did not accept the ask: `busy`, `not-live`, or `no-reply-route`. */
  | { readonly _tag: "Refused"; readonly result: DeliverResult }
  | { readonly _tag: "Replied"; readonly result: DeliverResult; readonly reply: ReplyBody }
  | { readonly _tag: "TimedOut"; readonly result: DeliverResult }
  /** `result` is undefined when the signal aborted before the ask went out. */
  | { readonly _tag: "Aborted"; readonly result: DeliverResult | undefined };

/** The process store of E6. */
export interface AskStore {
  /** Records the parent of an agent session; each binding calls it at `session_start`. */
  readonly noteAgent: (agent: AgentRef) => void;
  /** Sets or clears the live registration of a main session. */
  readonly setRegistration: (agentId: string, registration: Target | undefined) => void;
  /**
   * The reply address of an ask: the session's own registration for a main
   * session, else the registration of the nearest ancestor that has one.
   * Undefined when none is live.
   */
  readonly replyAddress: (agent: AgentRef) => AskRoute | undefined;
  /** Sends an ask and waits for its reply, its timeout, or the abort of its signal. */
  readonly ask: (request: AskRequest) => Promise<AskOutcome>;
  /**
   * Completes the waiter of a reply that matches it by ask id and by the
   * registration that received the ask. False when no waiter matches.
   */
  readonly complete: (reply: ReplyBody) => boolean;
}

/** Whether an outcome of the receiver accepts an ask. */
const ACCEPTS: Record<DeliverResult["outcome"], boolean> = {
  delivered: true,
  queued: true,
  submitted: true,
  busy: false,
  "not-live": false,
  "no-reply-route": false,
};

interface Waiter {
  readonly expected: Target;
  readonly settled: Promise<WaitResult>;
  readonly settle: (result: WaitResult) => void;
}

export const makeAskStore = (clock: TalkClock): AskStore => {
  const parents = new Map<string, string | undefined>();
  const registrations = new Map<string, Target>();
  const waitersByAsk = new Map<string, Waiter>();
  const waitingAgents = new Set<string>();

  const replyAddress = (agent: AgentRef): AskRoute | undefined => {
    if (agent.main) {
      const own = registrations.get(agent.id);
      return own === undefined ? undefined : { origin: "main", replyTo: own };
    }
    const seen = new Set<string>([agent.id]);
    let ancestor = agent.parentId;
    while (ancestor !== undefined && !seen.has(ancestor)) {
      const registration = registrations.get(ancestor);
      if (registration !== undefined) return { origin: "sub", replyTo: registration };
      seen.add(ancestor);
      ancestor = parents.get(ancestor);
    }
    return undefined;
  };

  /** Registers a waiter before the ask goes out, so a fast reply finds it. */
  const begin = (request: AskRequest): Waiter => {
    const { promise: settled, resolve } = Promise.withResolvers<WaitResult>();
    let cancelTimer: () => void = () => {};
    const onAbort = (): void => {
      waiter.settle({ _tag: "Aborted" });
    };
    const waiter: Waiter = {
      expected: request.target,
      settled,
      settle: (result) => {
        if (waitersByAsk.get(request.askId) !== waiter) return;
        waitersByAsk.delete(request.askId);
        waitingAgents.delete(request.agent.id);
        cancelTimer();
        request.signal?.removeEventListener("abort", onAbort);
        resolve(result);
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
    let result: DeliverResult;
    try {
      result = await request.deliver(route);
    } catch (error) {
      waiter.settle({ _tag: "Aborted" });
      throw error;
    }
    if (!ACCEPTS[result.outcome]) {
      waiter.settle({ _tag: "Aborted" });
      return { _tag: "Refused", result };
    }
    const ended = await waiter.settled;
    return ended._tag === "Replied"
      ? { _tag: "Replied", result, reply: ended.reply }
      : { _tag: ended._tag, result };
  };

  const complete = (reply: ReplyBody): boolean => {
    const waiter = waitersByAsk.get(reply.askId);
    if (
      waiter === undefined ||
      waiter.expected.instanceId !== reply.replier.instanceId ||
      waiter.expected.sessionId !== reply.replier.sessionId
    )
      return false;
    waiter.settle({ _tag: "Replied", reply });
    return true;
  };

  return {
    noteAgent: (agent) => {
      parents.set(agent.id, agent.parentId);
    },
    setRegistration: (agentId, registration) => {
      if (registration === undefined) registrations.delete(agentId);
      else registrations.set(agentId, registration);
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

/** The pending inbound asks of one session (E6). */
export interface PendingAsks {
  /** Keeps an accepted ask until its reply or the ask timeout. */
  readonly add: (body: DeliverBody & { readonly ask: AskRoute }, receivedBy: Target) => void;
  readonly remove: (askId: string) => void;
  /** The unexpired asks, oldest first. */
  readonly list: () => ReadonlyArray<PendingAsk>;
  readonly select: (replyTo: string | undefined) => PendingSelection;
}

interface StoredAsk {
  readonly askId: string;
  readonly from: Sender;
  readonly route: AskRoute;
  readonly receivedBy: Target;
  readonly receivedAt: number;
  readonly preview: string;
}

export const makePendingAsks = (clock: TalkClock, timeoutMs = ASK_TIMEOUT_MS): PendingAsks => {
  const asks = new Map<string, StoredAsk>();

  const list = (): ReadonlyArray<PendingAsk> => {
    const now = clock.now();
    const live: Array<PendingAsk> = [];
    for (const [askId, { receivedAt, ...stored }] of asks) {
      if (now - receivedAt >= timeoutMs) asks.delete(askId);
      else live.push({ ...stored, ageMs: now - receivedAt });
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
    },
    remove: (askId) => {
      asks.delete(askId);
    },
    list,
    select: (replyTo) => {
      const live = list();
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
