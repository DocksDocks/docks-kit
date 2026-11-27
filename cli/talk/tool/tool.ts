/**
 * The `talk` tool (#250 E10): its parameters, its seven actions, and the text
 * of each result. Each action is an Effect that `cli/talk/extension.ts` runs;
 * this module runs no effect. The transport reaches it as plain functions
 * that return promises (E12).
 */
import { randomBytes } from "node:crypto";

import { Effect, Predicate, Result, Schema } from "effect";

import type { AgentRef, AskOutcome, AskStore, PendingAsk, PendingAsks } from "./asks";
import { Attachment, formatAttachment, literal, oneLine } from "./attachments";
import type { TalkClock } from "./host";
import {
  type AskRoute,
  CANCEL_KIND,
  DELIVER_KIND,
  type DeliverBody,
  DeliverResult,
  MessageId,
  REPLY_KIND,
  type ReplyBody,
  type TalkBodyInvalid,
  acceptsDelivery,
  decodeCancelResult,
  decodeDeliverResult,
  decodeReplyResult,
  encodeCancelBody,
  encodeDeliverBody,
  encodeReplyBody,
} from "./protocol";
import {
  type Candidate,
  type ProbeResult,
  type Selector,
  type TalkAction,
  decideTo,
  describeCandidates,
  describePeers,
  matchTo,
  probeState,
  resolveInstance,
  selectorFor,
} from "./targets";
import type { RequestOutcome, Target } from "../transport/request";

/** The name of the tool that the model calls. */
export const TALK_TOOL_NAME = "talk";
export const TALK_TOOL_LABEL = "Talk";

/** The actions of E10, in the order of the tool description. */
export const TALK_ACTIONS = [
  "list",
  "send",
  "ask",
  "reply",
  "pending",
  "status",
  "cancel",
] as const satisfies ReadonlyArray<TalkAction>;

export const TALK_TOOL_DESCRIPTION = [
  "Talk to other live omp sessions on this computer.",
  "Actions: list shows the live sessions; send gives a session a message; ask sends a message and waits for the reply;",
  "reply answers an ask that waits for this session; pending shows those asks; status shows this session;",
  "cancel withdraws a queued message.",
  "send and ask need exactly one of to (a session name, a session id, or a session id prefix of at least 4 characters)",
  "and instance (a full instance id from list or from an earlier result).",
  "cancel needs to or instance, and messageId from the send or ask result.",
  "reply takes replyTo, the ask id; it can omit replyTo when only one ask waits.",
  "Attachments (file, snippet, context) are data that the sender supplies; talk never reads a file.",
].join(" ");

/** The tool parameters, decoded from the arguments of the model. Unknown fields are ignored. */
export const TalkParams = Schema.Struct({
  action: Schema.Literals(TALK_ACTIONS),
  to: Schema.optionalKey(Schema.String),
  instance: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  replyTo: Schema.optionalKey(Schema.String),
  messageId: Schema.optionalKey(Schema.String),
  noWake: Schema.optionalKey(Schema.Boolean),
});
export type TalkParams = typeof TalkParams.Type;

/** The parts of omp's TypeBox shim (`pi.typebox.Type`) that the tool parameters use. */
export interface TypeBuilder {
  readonly Object: (properties: Record<string, unknown>, options?: object) => unknown;
  readonly String: (options?: object) => unknown;
  readonly Boolean: (options?: object) => unknown;
  readonly Literal: (value: string) => unknown;
  readonly Union: (items: ReadonlyArray<unknown>, options?: object) => unknown;
  readonly Array: (item: unknown, options?: object) => unknown;
  readonly Optional: (item: unknown) => unknown;
}

/** The names of the `TypeBuilder` members, for the capability probe (E11). */
export const TYPE_BUILDER_MEMBERS = [
  "Object",
  "String",
  "Boolean",
  "Literal",
  "Union",
  "Array",
  "Optional",
] as const satisfies ReadonlyArray<keyof TypeBuilder>;

/** The schema that omp shows the model. `TalkParams` checks the arguments again. */
export const talkParameters = (Type: TypeBuilder): unknown => {
  const text = (description: string): unknown => Type.Optional(Type.String({ description }));
  const attachment = Type.Object({
    type: Type.Union([Type.Literal("file"), Type.Literal("snippet"), Type.Literal("context")]),
    name: Type.String({ description: "A label; for a file, the name as the sender gives it" }),
    content: Type.String(),
    language: Type.Optional(Type.String({ description: "The fence language of a snippet" })),
  });
  return Type.Object({
    action: Type.Union(
      TALK_ACTIONS.map((action) => Type.Literal(action)),
      { description: "What to do" },
    ),
    to: text("send, ask, cancel: a session name, a session id, or a unique session id prefix"),
    instance: text("send, ask, cancel: a full instance id (16 hex digits)"),
    message: text("send, ask, reply: the text"),
    attachments: Type.Optional(Type.Array(attachment)),
    replyTo: text("reply: the id of the ask to answer"),
    messageId: text("cancel: the message id from a send or ask result"),
    noWake: Type.Optional(
      Type.Boolean({ description: "send, ask, reply: append without a request for a turn" }),
    ),
  });
};

/** A listed registration, without its secret. */
export interface ListedPeer {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
}

export type ListAnswer =
  | { readonly _tag: "Listed"; readonly peers: ReadonlyArray<ListedPeer> }
  | { readonly _tag: "ListFailed"; readonly reason: string };

export type RequestAnswer =
  | { readonly _tag: "Answered"; readonly body: Schema.Json }
  | { readonly _tag: "Failed"; readonly outcome: RequestOutcome; readonly reason: string };

/**
 * The transport calls of the tool, as plain functions of the process
 * singleton (E12). An expected failure is a value; a rejection is a defect
 * of the transport runtime.
 */
export interface PeerTransport {
  readonly list: () => Promise<ListAnswer>;
  /**
   * Pings each target under the dial limit, in one batch that shares one
   * socket snapshot. The results come in the order of the targets.
   */
  readonly probeAll: (targets: ReadonlyArray<Target>) => Promise<ReadonlyArray<ProbeResult>>;
  readonly request: (target: Target, kind: string, body: Schema.Json) => Promise<RequestAnswer>;
  /** The pair of an entry that this process kept, by its full instance id. */
  readonly known: (instanceId: string) => Promise<Target | undefined>;
}

/** The calling session, as the tool sees it. */
export interface TalkSelf {
  /** The agent of the session; its ids are scoped to the module evaluation (E6). */
  readonly agent: AgentRef;
  readonly sessionId: string;
  readonly name: string;
  readonly cwd: string;
  /** The registration of this binding; undefined in a subagent session or between registrations. */
  readonly registration: Target | undefined;
  readonly pending: PendingAsks;
  readonly queuedCount: number;
}

export interface ToolContext {
  readonly transport: PeerTransport;
  readonly asks: AskStore;
  readonly self: TalkSelf;
  readonly clock: TalkClock;
  /** The tool `signal`; an abort ends a waiting ask. */
  readonly signal: AbortSignal | undefined;
  /** Default: the ask timeout of `asks.ts`. */
  readonly askTimeoutMs?: number | undefined;
}

/** What `send`, `ask`, `reply`, and `cancel` report besides the text. */
export interface TalkToolDetails {
  readonly action: TalkAction | undefined;
  readonly messageId?: string | undefined;
  readonly instanceId?: string | undefined;
  readonly outcome?: string | undefined;
}

/** The end of one call: the text for the model, and whether the call failed. */
export interface TalkToolOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly details: TalkToolDetails;
}

/** A call failed; the message names the reason and what was sent. */
export class TalkToolFailed extends Schema.TaggedError<
  TalkToolFailed,
  { readonly brand: unique symbol }
>()("TalkToolFailed", {
  message: Schema.String,
  messageId: Schema.optionalKey(Schema.String),
  instanceId: Schema.optionalKey(Schema.String),
  outcome: Schema.optionalKey(Schema.String),
}) {}

/** The ask request reached no answer: the transport failure of the request. */
class TalkAskRequestFailed extends Schema.TaggedError<
  TalkAskRequestFailed,
  { readonly brand: unique symbol }
>()("TalkAskRequestFailed", {
  outcome: Schema.String,
  reason: Schema.String,
}) {}

/** The number of session id characters that `list` and `status` show. */
const SHORT_ID_LENGTH = 8;
/** The number of instance id characters that `list` shows as display only (E8). */
const INSTANCE_DISPLAY_LENGTH = 4;
const MESSAGE_ID_BYTES = 8;

const newMessageId = (): string => randomBytes(MESSAGE_ID_BYTES).toString("hex");

interface FailureIds {
  readonly messageId?: string;
  readonly instanceId?: string;
  readonly outcome?: string;
}

const fail = (message: string, ids: FailureIds = {}): Effect.Effect<never, TalkToolFailed> =>
  Effect.fail(new TalkToolFailed({ message, ...ids }));

const causeText = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : String(cause);

/** A transport call; a rejection becomes a failure of the call. */
const transportCall = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, TalkToolFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new TalkToolFailed({ message: `talk: ${what} failed: ${causeText(cause)}` }),
  });

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

const requireMessage = (
  action: TalkAction,
  message: string | undefined,
): Effect.Effect<string, TalkToolFailed> =>
  message === undefined || message.trim() === ""
    ? fail(`talk: the action ${action} needs message.`)
    : Effect.succeed(message);

const isOwn = (self: TalkSelf, peer: Target): boolean =>
  self.registration !== undefined &&
  self.registration.instanceId === peer.instanceId &&
  self.registration.sessionId === peer.sessionId;

/**
 * The registration whose pending asks this session sees (E6): its own, while
 * the session id still equals the registered one. A successor session sees
 * none of them.
 */
const askReceiver = (self: TalkSelf): Target | undefined =>
  self.registration?.sessionId === self.sessionId ? self.registration : undefined;

const listPeers = (
  transport: PeerTransport,
): Effect.Effect<ReadonlyArray<ListedPeer>, TalkToolFailed> =>
  transportCall("the listing", () => transport.list()).pipe(
    Effect.flatMap((answer) =>
      answer._tag === "Listed"
        ? Effect.succeed(answer.peers)
        : fail(`talk: the registry could not be listed: ${answer.reason}`),
    ),
  );

/**
 * Probes each peer in one batch under the dial limit of the transport (E8).
 * The own registration is probed too: a captured registration can have ended
 * since the tool read it.
 */
const probeAll = (
  context: ToolContext,
  peers: ReadonlyArray<ListedPeer>,
): Effect.Effect<ReadonlyArray<Candidate<ListedPeer>>, TalkToolFailed> =>
  transportCall("the probes", () =>
    context.transport.probeAll(
      peers.map(({ instanceId, sessionId }) => ({ instanceId, sessionId })),
    ),
  ).pipe(
    Effect.flatMap((results) =>
      results.length === peers.length
        ? Effect.succeed(
            peers.flatMap((peer, index): ReadonlyArray<Candidate<ListedPeer>> => {
              const probe = results[index];
              return probe === undefined ? [] : [{ peer, probe }];
            }),
          )
        : fail(`talk: the probes gave ${results.length} results for ${peers.length} sessions.`),
    ),
  );

const peerLine = (self: TalkSelf, { peer, probe }: Candidate<ListedPeer>): string => {
  const own = isOwn(self, peer) ? " (this session)" : "";
  const unresolved = probeState(probe) === "unresolved" ? `; unresolved: ${probe}` : "";
  return (
    `- ${literal(peer.name)} [${peer.instanceId.slice(0, INSTANCE_DISPLAY_LENGTH)}]${own}: ` +
    `session ${literal(peer.sessionId.slice(0, SHORT_ID_LENGTH))}, folder ${literal(peer.cwd)}, ` +
    `instance ${peer.instanceId}${unresolved}`
  );
};

interface Resolved {
  readonly target: Target;
  readonly name: string | undefined;
}

const NO_TARGET = "talk: the action needs a target.";

/** The target of `send`, `ask`, and `cancel` (E8). Nothing is sent before it resolves. */
const resolveTarget = Effect.fnUntraced(function* (
  context: ToolContext,
  selector: Selector,
): Effect.fn.Return<Resolved, TalkToolFailed> {
  switch (selector._tag) {
    case "None":
      return yield* fail(NO_TARGET);
    case "Instance": {
      const { instanceId } = selector;
      const answer = yield* transportCall("the listing", () => context.transport.list());
      const listing = answer._tag === "Listed" ? answer.peers : [];
      const kept = yield* transportCall("the instance lookup", () =>
        context.transport.known(instanceId),
      );
      const resolution = resolveInstance(instanceId, listing, kept === undefined ? [] : [kept]);
      if (resolution._tag === "NotFound")
        // A listing that failed established no absence.
        return yield* answer._tag === "ListFailed"
          ? fail(
              `talk: the registry could not be listed (${answer.reason}), and this process kept no entry of the instance ${instanceId}. Nothing was sent.`,
              { instanceId },
            )
          : fail(
              `talk: this process never saw the instance ${instanceId} (not-found). Run the action list.`,
              { instanceId, outcome: "not-found" },
            );
      return {
        target: resolution.target,
        name: listing.find((peer) => peer.instanceId === instanceId)?.name,
      };
    }
    case "To": {
      const { to } = selector;
      const match = matchTo(yield* listPeers(context.transport), to);
      if (match._tag === "NoMatch")
        return yield* fail(
          `talk: no listed session matches ${literal(to)} (not-found). Run the action list.`,
          { outcome: "not-found" },
        );
      if (match._tag === "AmbiguousPrefix")
        return yield* fail(
          `talk: ${literal(to)} starts more than one session id. Nothing was sent. Candidates:\n${describePeers(match.peers)}`,
        );
      const candidates = yield* probeAll(context, match.peers);
      const decision = decideTo(candidates);
      switch (decision._tag) {
        case "Target":
          return {
            target: { instanceId: decision.peer.instanceId, sessionId: decision.peer.sessionId },
            name: decision.peer.name,
          };
        case "NotFound":
          return yield* fail(`talk: no listed session matches ${literal(to)} (not-found).`, {
            outcome: "not-found",
          });
        case "NotLive":
          return yield* fail(
            `talk: ${literal(to)} is not live (not-live). Candidates:\n${describeCandidates(candidates)}`,
            { outcome: "not-live" },
          );
        case "Ambiguous":
          return yield* fail(
            `talk: ${literal(to)} does not name exactly one live session. Nothing was sent. ` +
              `Use instance with one full instance id:\n${describeCandidates(candidates)}`,
          );
      }
    }
  }
});

const sender = (self: TalkSelf): DeliverBody["from"] => ({
  name: self.name,
  cwd: self.cwd,
  sessionId: self.sessionId,
});

const idLines = (messageId: string, target: Resolved): string =>
  `Message id: ${messageId}\nInstance: ${target.target.instanceId}` +
  (target.name === undefined ? "" : ` (${literal(target.name)})`);

/**
 * Once a request went out, its target can hold the message, so every failure
 * names the message id and the instance id, and `cancel` stays possible (E5).
 */
const afterDispatch = <A>(
  effect: Effect.Effect<A, TalkToolFailed | TalkBodyInvalid>,
  messageId: string,
  target: Resolved,
): Effect.Effect<A, TalkToolFailed> =>
  Effect.mapError(effect, (error) =>
    error._tag === "TalkToolFailed" && error.messageId !== undefined
      ? error
      : new TalkToolFailed({
          message: `${error._tag === "TalkToolFailed" ? error.message : `talk: ${error.message}`}\n${idLines(messageId, target)}`,
          messageId,
          instanceId: target.target.instanceId,
          ...(error._tag === "TalkToolFailed" && error.outcome !== undefined
            ? { outcome: error.outcome }
            : {}),
        }),
  );

/** The headline of each outcome of a `deliver` or `reply` request (E5). */
const OUTCOME_TEXT: Record<DeliverResult["outcome"] | "not-found", string> = {
  delivered: "Delivered: the message is in the session.",
  queued:
    "Queued: the session is busy or changes its session, so talk holds the message and sends it when it can. cancel can withdraw it.",
  submitted:
    "Submitted: talk handed the message to omp, and its append is not confirmed. This does not prove that omp still holds it, and talk can no longer withdraw it.",
  busy: "Busy: the session takes no message now: it runs one task and exits, or the queue that talk holds for it is full. Nothing was delivered.",
  "not-live": "Not live: the session ended or moved. Nothing was delivered.",
  "no-reply-route":
    "No reply route: the receiver cannot reach the reply address of this session, so it refused the ask.",
  "not-found": "Not found: no waiting ask matches this reply, so the receiver dropped it.",
};

/**
 * `delivered` of a reply also covers a reply that completed the waiting ask
 * without a transcript append (E6), so it claims no append.
 */
const REPLY_DELIVERED = "Delivered: the reply reached the asker.";

const requestFailed = (
  what: string,
  answer: Extract<RequestAnswer, { _tag: "Failed" }>,
  messageId: string,
  target: Resolved,
): Effect.Effect<never, TalkToolFailed> =>
  fail(
    `talk: ${what} failed: ${answer.outcome} (${answer.reason}).\n${idLines(messageId, target)}`,
    { messageId, instanceId: target.target.instanceId, outcome: answer.outcome },
  );

/** A request after its body went out; every failure names the ids (E5). */
const dispatched = <R>(
  what: string,
  run: () => Promise<RequestAnswer>,
  decode: (json: Schema.Json) => Effect.Effect<R, TalkBodyInvalid>,
  messageId: string,
  target: Resolved,
): Effect.Effect<R, TalkToolFailed> =>
  afterDispatch(
    transportCall(what, run).pipe(
      Effect.flatMap((answer): Effect.Effect<R, TalkToolFailed | TalkBodyInvalid> =>
        answer._tag === "Failed"
          ? requestFailed(what, answer, messageId, target)
          : decode(answer.body),
      ),
    ),
    messageId,
    target,
  );

const runSend = Effect.fnUntraced(function* (
  context: ToolContext,
  params: TalkParams,
  selector: Selector,
) {
  const text = yield* requireMessage("send", params.message);
  const target = yield* resolveTarget(context, selector);
  const messageId = newMessageId();
  const json = yield* encodeDeliverBody({
    messageId,
    from: sender(context.self),
    text,
    attachments: params.attachments ?? [],
    sentAt: context.clock.now(),
    noWake: params.noWake ?? false,
  });
  const { outcome } = yield* dispatched(
    "the send",
    () => context.transport.request(target.target, DELIVER_KIND, json),
    decodeDeliverResult,
    messageId,
    target,
  );
  const report = `${OUTCOME_TEXT[outcome]}\n${idLines(messageId, target)}`;
  const ids = { messageId, instanceId: target.target.instanceId, outcome };
  if (!acceptsDelivery(outcome)) return yield* fail(`talk: ${report}`, ids);
  return { ok: true, text: report, details: { action: "send", ...ids } } satisfies TalkToolOutcome;
});

const NO_REPLY_ADDRESS =
  "talk: no reply address: neither this session nor a main session that it descends from has a live talk registration. Nothing was sent.";

const sameRoute = (left: typeof AskRoute.Type, right: typeof AskRoute.Type): boolean =>
  left.origin === right.origin &&
  left.replyTo.instanceId === right.replyTo.instanceId &&
  left.replyTo.sessionId === right.replyTo.sessionId;

const decodeDeliverResultNow = Schema.decodeUnknownResult(Schema.toCodecJson(DeliverResult));

/** The ask request as a promise, for the ask store; a transport failure rejects. */
const deliverAsk =
  (context: ToolContext, target: Target, json: Schema.Json, route: typeof AskRoute.Type) =>
  async (offered: typeof AskRoute.Type): Promise<DeliverResult> => {
    // The body carries the route that the tool read before it encoded the body.
    if (!sameRoute(offered, route))
      throw new Error("the reply address changed while the ask started; ask again");
    const answer = await context.transport.request(target, DELIVER_KIND, json);
    if (answer._tag === "Failed")
      throw new TalkAskRequestFailed({ outcome: answer.outcome, reason: answer.reason });
    const decoded = decodeDeliverResultNow(answer.body);
    if (Result.isFailure(decoded))
      throw new Error(`not a valid deliver result: ${decoded.failure.message}`);
    return decoded.success;
  };

/** A rejected ask: the failed request keeps its transport outcome. */
const askFailed = (cause: unknown): TalkToolFailed =>
  cause instanceof TalkAskRequestFailed
    ? new TalkToolFailed({
        message: `talk: the ask failed: ${cause.outcome} (${cause.reason}).`,
        outcome: cause.outcome,
      })
    : new TalkToolFailed({ message: `talk: the ask failed: ${causeText(cause)}` });

const replyText = (reply: ReplyBody): string =>
  [
    `**Reply from ${literal(reply.from.name)}:**\n\n${reply.text}`,
    ...reply.attachments.map((attachment) => formatAttachment(attachment, reply.sentAt)),
  ].join("\n\n");

const askOutcome = (
  outcome: AskOutcome,
  askId: string,
  target: Resolved,
): Effect.Effect<TalkToolOutcome, TalkToolFailed> => {
  const ids = { messageId: askId, instanceId: target.target.instanceId };
  const lines = idLines(askId, target);
  switch (outcome._tag) {
    case "NoReplyAddress":
      return fail(NO_REPLY_ADDRESS);
    case "WaiterBusy":
      return fail("talk: this session already waits for a reply. Nothing was sent.");
    case "Refused":
      return fail(`talk: ${OUTCOME_TEXT[outcome.result.outcome]}\n${lines}`, {
        ...ids,
        outcome: outcome.result.outcome,
      });
    case "Replied":
      return Effect.succeed({
        ok: true,
        text: `${replyText(outcome.reply)}\n\n${lines}`,
        details: { action: "ask", ...ids, outcome: "replied" },
      });
    case "TimedOut":
      return fail(`talk: no reply came before the ask timed out.\n${lines}`, {
        ...ids,
        outcome: "timeout",
      });
    case "Aborted":
      return fail(`talk: the ask was aborted.\n${lines}`, { ...ids, outcome: "aborted" });
  }
};

const runAsk = Effect.fnUntraced(function* (
  context: ToolContext,
  params: TalkParams,
  selector: Selector,
) {
  const text = yield* requireMessage("ask", params.message);
  // E6: without a live reply address the ask fails at once, before any discovery, and sends nothing.
  const route = context.asks.replyAddress(context.self.agent);
  if (route === undefined) return yield* fail(NO_REPLY_ADDRESS);
  const target = yield* resolveTarget(context, selector);
  const askId = newMessageId();
  const json = yield* encodeDeliverBody({
    messageId: askId,
    from: sender(context.self),
    text,
    attachments: params.attachments ?? [],
    sentAt: context.clock.now(),
    noWake: params.noWake ?? false,
    ask: route,
  });
  // The store reads the reply address again at dispatch, against its binding's current registration.
  const outcome = yield* afterDispatch(
    Effect.tryPromise({
      try: () =>
        context.asks.ask({
          agent: context.self.agent,
          askId,
          target: target.target,
          timeoutMs: context.askTimeoutMs,
          signal: context.signal,
          deliver: deliverAsk(context, target.target, json, route),
        }),
      catch: askFailed,
    }),
    askId,
    target,
  );
  return yield* askOutcome(outcome, askId, target);
});

const askLine = (ask: PendingAsk): string =>
  `- ${ask.askId} from ${literal(ask.from.name)} (session ${literal(ask.from.sessionId.slice(0, SHORT_ID_LENGTH))}), ` +
  `${Math.floor(ask.ageMs / 1_000)} s ago: ${literal(ask.preview)}`;

const runReply = Effect.fnUntraced(function* (context: ToolContext, params: TalkParams) {
  const text = yield* requireMessage("reply", params.message);
  const replyTo = present(params.replyTo);
  const selection = context.self.pending.select(askReceiver(context.self), replyTo);
  switch (selection._tag) {
    case "NotFound":
      return yield* fail(
        `talk: no pending ask has the id ${literal(replyTo ?? "")}. Run the action pending.`,
      );
    case "None":
      return yield* fail("talk: no ask waits for a reply from this session.");
    case "Ambiguous":
      return yield* fail(
        `talk: more than one ask waits; set replyTo to one ask id:\n${selection.asks.map(askLine).join("\n")}`,
      );
    case "Found":
      break;
  }
  const { ask } = selection;
  const messageId = newMessageId();
  const target: Resolved = { target: ask.route.replyTo, name: ask.from.name };
  const json = yield* encodeReplyBody({
    messageId,
    from: sender(context.self),
    text,
    attachments: params.attachments ?? [],
    sentAt: context.clock.now(),
    noWake: params.noWake ?? false,
    replier: ask.receivedBy,
    askId: ask.askId,
    origin: ask.route.origin,
  });
  const { outcome } = yield* dispatched(
    "the reply",
    () => context.transport.request(ask.route.replyTo, REPLY_KIND, json),
    decodeReplyResult,
    messageId,
    target,
  );
  const headline = outcome === "delivered" ? REPLY_DELIVERED : OUTCOME_TEXT[outcome];
  const report = `${headline}\nAsk id: ${ask.askId}\n${idLines(messageId, target)}`;
  const ids = { messageId, instanceId: ask.route.replyTo.instanceId, outcome };
  if (outcome === "busy" || outcome === "not-live" || outcome === "not-found")
    return yield* fail(`talk: ${report}`, ids);
  context.self.pending.remove(ask.askId);
  return { ok: true, text: report, details: { action: "reply", ...ids } } satisfies TalkToolOutcome;
});

const CANCEL_TEXT: Record<string, string> = {
  cancelled: "Cancelled: the message was still queued, and talk removed it.",
  submitted: "Not cancelled: talk handed the message to omp, and its append is not confirmed yet.",
  delivered: "Not cancelled: the message is already in the session.",
  "not-live": "Not cancelled: the registration ended (not-live).",
  unknown: "Not cancelled: the outcome of the message is unknown.",
  "not-found": "Not cancelled: the receiver has no message with this id from this session.",
};

const isMessageId = Schema.is(MessageId);

const runCancel = Effect.fnUntraced(function* (
  context: ToolContext,
  params: TalkParams,
  selector: Selector,
) {
  const messageId = present(params.messageId) ?? "";
  if (!isMessageId(messageId))
    return yield* fail(
      "talk: messageId takes the message id (16 lowercase hex digits) of a send or ask result.",
    );
  const target = yield* resolveTarget(context, selector);
  const json = yield* encodeCancelBody({ messageId, senderSessionId: context.self.sessionId });
  const { outcome } = yield* dispatched(
    "the cancel",
    () => context.transport.request(target.target, CANCEL_KIND, json),
    decodeCancelResult,
    messageId,
    target,
  );
  return {
    ok: true,
    text: `${CANCEL_TEXT[outcome] ?? outcome}\n${idLines(messageId, target)}`,
    details: { action: "cancel", messageId, instanceId: target.target.instanceId, outcome },
  } satisfies TalkToolOutcome;
});

const runList = Effect.fnUntraced(function* (context: ToolContext) {
  const candidates = yield* probeAll(context, yield* listPeers(context.transport));
  // E8: `list` omits registrations proven ended and marks unresolved ones.
  const shown = candidates.filter((candidate) => probeState(candidate.probe) !== "ended");
  const text =
    shown.length === 0
      ? "No live talk sessions."
      : `Talk sessions (${shown.length}); use the full instance id as instance:\n` +
        shown.map((candidate) => peerLine(context.self, candidate)).join("\n");
  return { ok: true, text, details: { action: "list" } } satisfies TalkToolOutcome;
});

const runPending = (context: ToolContext): TalkToolOutcome => {
  const asks = context.self.pending.list(askReceiver(context.self));
  return {
    ok: true,
    text:
      asks.length === 0
        ? "No ask waits for a reply from this session."
        : `Asks that wait for a reply (${asks.length}):\n${asks.map(askLine).join("\n")}`,
    details: { action: "pending" },
  };
};

const runStatus = Effect.fnUntraced(function* (context: ToolContext) {
  const { self } = context;
  const head = `This session: ${oneLine(self.name)} (session ${self.sessionId.slice(0, SHORT_ID_LENGTH)}), folder ${oneLine(self.cwd)}`;
  const registration =
    self.registration === undefined
      ? self.agent.main
        ? "Registration: none at the moment; talk registers this session again when it can."
        : "Registration: none; a subagent session is no talk target."
      : `Registration: instance ${self.registration.instanceId}`;
  // E8: the live peer count counts the other registrations that answered.
  const peers = yield* listPeers(context.transport).pipe(
    Effect.flatMap((listed) =>
      probeAll(
        context,
        listed.filter((peer) => !isOwn(self, peer)),
      ),
    ),
    Effect.map(
      (candidates) =>
        `Live peers: ${candidates.filter((candidate) => probeState(candidate.probe) === "answered").length}`,
    ),
    Effect.catchTag("TalkToolFailed", (error) =>
      Effect.succeed(`Live peers: unknown (${error.message})`),
    ),
  );
  const asks = self.pending.list(askReceiver(self));
  const pending =
    asks.length === 0
      ? "Pending asks: none"
      : `Pending asks (${asks.length}):\n${asks.map(askLine).join("\n")}`;
  return {
    ok: true,
    text: [head, registration, peers, `Queued messages: ${self.queuedCount}`, pending].join("\n"),
    details: { action: "status" },
  } satisfies TalkToolOutcome;
});

const decodeParams = Schema.decodeUnknownEffect(TalkParams);

const runAction = (
  context: ToolContext,
  params: TalkParams,
): Effect.Effect<TalkToolOutcome, Error> =>
  Effect.fromResult(selectorFor(params.action, params)).pipe(
    Effect.flatMap((selector): Effect.Effect<TalkToolOutcome, Error> => {
      switch (params.action) {
        case "list":
          return runList(context);
        case "send":
          return runSend(context, params, selector);
        case "ask":
          return runAsk(context, params, selector);
        case "reply":
          return runReply(context, params);
        case "pending":
          return Effect.succeed(runPending(context));
        case "status":
          return runStatus(context);
        case "cancel":
          return runCancel(context, params, selector);
      }
    }),
  );

const failedOutcome = (action: TalkAction | undefined, error: Error): TalkToolOutcome => {
  const details: TalkToolDetails =
    error instanceof TalkToolFailed
      ? {
          action,
          messageId: error.messageId,
          instanceId: error.instanceId,
          outcome: error.outcome,
        }
      : { action };
  return { ok: false, text: error.message, details };
};

/**
 * One call of the `talk` tool. Every failure becomes an outcome with
 * `ok: false` and a text that names the reason; nothing is sent after an
 * argument error.
 */
export const runTalkTool = (context: ToolContext, input: unknown): Effect.Effect<TalkToolOutcome> =>
  decodeParams(input).pipe(
    Effect.mapError(
      (error) =>
        new TalkToolFailed({ message: `talk: the arguments are not valid: ${error.message}` }),
    ),
    Effect.flatMap((params) =>
      runAction(context, params).pipe(
        Effect.catch((error) => Effect.succeed(failedOutcome(params.action, error))),
      ),
    ),
    Effect.catch((error) => Effect.succeed(failedOutcome(undefined, error))),
  );
