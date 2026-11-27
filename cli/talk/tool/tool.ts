/**
 * The `talk` tool (#250 E10, #260): its parameters, its eight actions, and
 * the text of each result. Each action is an Effect that
 * `cli/talk/extension.ts` runs; this module runs no effect. The transport
 * reaches it as plain functions that return promises (E12).
 */
import { randomBytes } from "node:crypto";

import { Effect, Predicate, Result, Schema } from "effect";

import type { AgentRef, AskOutcome, AskStore, PendingAsk, PendingAsks } from "./asks";
import { Attachment, formatAttachment, literal, oneLine } from "./attachments";
import { TRUST_LINE } from "./format";
import type { TalkClock } from "./host";
import {
  type AskRoute,
  CANCEL_KIND,
  DELIVER_KIND,
  type DeliverBody,
  type DeliverKind,
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
import {
  type RequestOutcome,
  type RequestTrace,
  type ResponseResult,
  type Target,
  newRequestTrace,
} from "../transport/request";

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
  "handover",
] as const satisfies ReadonlyArray<TalkAction>;

export const TALK_TOOL_DESCRIPTION = [
  "Talk to other live omp sessions on this computer.",
  "Actions: list shows the live sessions; send gives a session a message; ask sends a message and waits for the reply;",
  "reply answers an ask that waits for this session; pending shows those asks; status shows this session;",
  "cancel withdraws a queued message.",
  "handover starts a handover of this session's work that the user reviews and confirms; use it only when the user asks for a handover.",
  "send, ask, and handover need exactly one of to (a session name, a session id, or a session id prefix of at least 4 characters)",
  "and instance (a full instance id from list or from an earlier result).",
  "cancel needs to or instance, and messageId: the id of the message to check or withdraw, from a send, ask, or handover result.",
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
    to: text(
      "send, ask, cancel, handover: a session name, a session id, or a unique session id prefix",
    ),
    instance: text("send, ask, cancel, handover: a full instance id (16 hex digits)"),
    message: text("send, ask, reply: the text; handover: an optional note above the summary"),
    attachments: Type.Optional(Type.Array(attachment)),
    replyTo: text("reply: the id of the ask to answer"),
    messageId: text(
      "cancel: the id of the message to check or withdraw, from a send, ask, or handover result",
    ),
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
 * of the transport runtime. A `signal` interrupts the call when it aborts,
 * so a `/talk` flow that ends stops its transport work (#251 G3); of the
 * tool actions, only the checks of `handover` give the signal of the call
 * (#260 H5).
 */
export interface PeerTransport {
  readonly list: (signal?: AbortSignal) => Promise<ListAnswer>;
  /**
   * Pings each target under the dial limit, in one batch that shares one
   * socket snapshot. The results come in the order of the targets.
   * `hostError` gets the reason of each probe that failed in this process,
   * such as a registry lookup that failed its trust check; its result reads
   * `unreachable` (#260 H4).
   */
  readonly probeAll: (
    targets: ReadonlyArray<Target>,
    signal?: AbortSignal,
    hostError?: (target: Target, reason: string) => void,
  ) => Promise<ReadonlyArray<ProbeResult>>;
  /**
   * `beforeBody` runs right before the body goes out, after the mutual proof;
   * false keeps the body back, and the call rejects as an interrupted call.
   * `trace` gets the body write and the answer as they happen (#260 H5).
   */
  readonly request: (
    target: Target,
    kind: string,
    body: Schema.Json,
    signal?: AbortSignal,
    beforeBody?: () => boolean,
    trace?: RequestTrace,
  ) => Promise<RequestAnswer>;
  /** The pair of an entry that this process kept, by its full instance id. */
  readonly known: (instanceId: string, signal?: AbortSignal) => Promise<Target | undefined>;
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
  /** The tool `signal`; an abort ends a waiting ask, the checks of a handover, and its flow. */
  readonly signal: AbortSignal | undefined;
  /** Default: the ask timeout of `asks.ts`. */
  readonly askTimeoutMs?: number | undefined;
  /** Gets the rows of each `listSessions` call, such as the `/talk` completion snapshot (#251 G2). */
  readonly snapshot?: ListingSnapshot | undefined;
  /** The flow of the `handover` action; undefined where the session gives none (#260 H2). */
  readonly handover?: HandoverFlow | undefined;
}

/**
 * Starts one listing and returns the function that publishes its rows. A
 * call starts before the registry read, so the owner can drop the rows of a
 * listing that a later one overtook.
 */
export type ListingSnapshot = () => (rows: ReadonlyArray<SessionRow>) => void;

/** What `send`, `ask`, `reply`, `cancel`, and `handover` report besides the text. */
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
  /**
   * The raw error of the host when a listing, a lookup, or a probe failed
   * (#260 H4). The message holds it too; `handover` keeps it out of its result.
   */
  diagnostic: Schema.optionalKey(Schema.String),
  /** `to` matched sessions that a choice of one can resolve: several session ids, or two that answered (#260 H3). */
  ambiguous: Schema.optionalKey(Schema.Literal(true)),
  /**
   * The rows of the sessions of `to` when fewer than two of them answered
   * their probe (#260 H3). The shared text keeps its wording; `handover`
   * tells the user to check those sessions instead.
   */
  unanswered: Schema.optionalKey(Schema.String),
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
  readonly diagnostic?: string;
  readonly ambiguous?: true;
}

const fail = (message: string, ids: FailureIds = {}): Effect.Effect<never, TalkToolFailed> =>
  Effect.fail(new TalkToolFailed({ message, ...ids }));

const causeText = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : String(cause);

/** A transport call; a rejection becomes a failure of the call, with the host error as its diagnostic. */
const transportCall = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, TalkToolFailed> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const diagnostic = `${what} failed: ${causeText(cause)}`;
      return new TalkToolFailed({ message: `talk: ${diagnostic}`, diagnostic });
    },
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
  signal?: AbortSignal,
): Effect.Effect<ReadonlyArray<ListedPeer>, TalkToolFailed> =>
  transportCall("the listing", () => transport.list(signal)).pipe(
    Effect.flatMap((answer) => {
      if (answer._tag === "Listed") return Effect.succeed(answer.peers);
      const diagnostic = `the registry could not be listed: ${answer.reason}`;
      return fail(`talk: ${diagnostic}`, { diagnostic });
    }),
  );

/**
 * Probes each peer in one batch under the dial limit of the transport (E8).
 * The own registration is probed too: a captured registration can have ended
 * since the tool read it. `hostErrors` gets the reason of each probe that
 * failed in this process, not at the peer (#260 H4).
 */
const probeAll = (
  context: ToolContext,
  peers: ReadonlyArray<ListedPeer>,
  signal?: AbortSignal,
  hostErrors?: Array<string>,
): Effect.Effect<ReadonlyArray<Candidate<ListedPeer>>, TalkToolFailed> =>
  transportCall("the probes", () =>
    context.transport.probeAll(
      peers.map(({ instanceId, sessionId }) => ({ instanceId, sessionId })),
      signal,
      (_target, reason) => {
        hostErrors?.push(reason);
      },
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

const peerLine = (row: SessionRow): string => {
  const own = row.own ? " (this session)" : "";
  const unresolved = probeState(row.probe) === "unresolved" ? `; unresolved: ${row.probe}` : "";
  return (
    `- ${literal(row.name)} [${row.instanceId.slice(0, INSTANCE_DISPLAY_LENGTH)}]${own}: ` +
    `session ${literal(row.sessionId.slice(0, SHORT_ID_LENGTH))}, folder ${literal(row.cwd)}, ` +
    `instance ${row.instanceId}${unresolved}`
  );
};

/**
 * One row of the session listing (E8, #251 G3): a registration that its
 * probe did not prove ended. The `list` action and the `/talk` list view
 * read the same rows.
 */
export interface SessionRow extends ListedPeer {
  /** The registration of the calling binding. */
  readonly own: boolean;
  /** `ok`, or a failure that proves no end (`unresolved`). */
  readonly probe: ProbeResult;
}

/**
 * The listing as rows, not prose: every listed registration that its probe
 * did not prove ended. Only these probed rows reach `context.snapshot`.
 */
export const listSessions = Effect.fnUntraced(function* (
  context: ToolContext,
): Effect.fn.Return<ReadonlyArray<SessionRow>, TalkToolFailed> {
  const publish = context.snapshot?.();
  const candidates = yield* probeAll(context, yield* listPeers(context.transport));
  const rows = candidates
    .filter((candidate) => probeState(candidate.probe) !== "ended")
    .map(({ peer, probe }) => ({
      instanceId: peer.instanceId,
      sessionId: peer.sessionId,
      name: peer.name,
      cwd: peer.cwd,
      own: isOwn(context.self, peer),
      probe,
    }));
  publish?.(rows);
  return rows;
});

/** The exact registration pair that a selector resolved to, with the metadata that the listing gave. */
export interface ResolvedTarget {
  readonly target: Target;
  readonly name: string | undefined;
  readonly cwd?: string | undefined;
}

const NO_TARGET = "talk: the action needs a target.";

/**
 * The failure of a call that knows one instance id: the exact selector id,
 * or the one session that `to` matched (#260 H4). The text stays as it is.
 */
const knowing =
  (instanceId: string | undefined) =>
  (error: TalkToolFailed): TalkToolFailed =>
    instanceId === undefined || error.instanceId !== undefined
      ? error
      : new TalkToolFailed({
          message: error.message,
          instanceId,
          ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
          ...(error.diagnostic === undefined ? {} : { diagnostic: error.diagnostic }),
        });

/**
 * The target resolver of `send`, `ask`, `cancel`, `handover`, and `/talk
 * <target>` (E8, #251 G2). Nothing is sent before it resolves. `signal`
 * reaches the listing, the lookup, and the probes (#260 H5).
 */
export const resolveTarget = Effect.fnUntraced(function* (
  context: ToolContext,
  selector: Selector,
  signal?: AbortSignal,
): Effect.fn.Return<ResolvedTarget, TalkToolFailed> {
  switch (selector._tag) {
    case "None":
      return yield* fail(NO_TARGET);
    case "Instance": {
      const { instanceId } = selector;
      const answer = yield* transportCall("the listing", () => context.transport.list(signal)).pipe(
        Effect.mapError(knowing(instanceId)),
      );
      const listing = answer._tag === "Listed" ? answer.peers : [];
      const kept = yield* transportCall("the instance lookup", () =>
        context.transport.known(instanceId, signal),
      ).pipe(Effect.mapError(knowing(instanceId)));
      const resolution = resolveInstance(instanceId, listing, kept === undefined ? [] : [kept]);
      if (resolution._tag === "NotFound")
        // A listing that failed established no absence.
        return yield* answer._tag === "ListFailed"
          ? fail(
              `talk: the registry could not be listed (${answer.reason}), and this process kept no entry of the instance ${instanceId}. Nothing was sent.`,
              { instanceId, diagnostic: `the registry could not be listed: ${answer.reason}` },
            )
          : fail(
              `talk: this process never saw the instance ${instanceId} (not-found). Run the action list.`,
              { instanceId, outcome: "not-found" },
            );
      const listed = listing.find((peer) => peer.instanceId === instanceId);
      return { target: resolution.target, name: listed?.name, cwd: listed?.cwd };
    }
    case "To": {
      const { to } = selector;
      const match = matchTo(yield* listPeers(context.transport, signal), to);
      if (match._tag === "NoMatch")
        return yield* fail(
          `talk: no listed session matches ${literal(to)} (not-found). Run the action list.`,
          { outcome: "not-found" },
        );
      if (match._tag === "AmbiguousPrefix")
        return yield* fail(
          `talk: ${literal(to)} starts more than one session id. Nothing was sent. Candidates:\n${describePeers(match.peers)}`,
          { ambiguous: true },
        );
      const hostErrors: Array<string> = [];
      const sole = match.peers.length === 1 ? match.peers[0]?.instanceId : undefined;
      const candidates = yield* probeAll(context, match.peers, signal, hostErrors).pipe(
        Effect.mapError(knowing(sole)),
      );
      // #260 H4: a probe that failed in this process, not at the peer, keeps its reason for the caller.
      const host = hostErrors.length === 0 ? {} : { diagnostic: hostErrors.join("; ") };
      const decision = decideTo(candidates);
      switch (decision._tag) {
        case "Target":
          return {
            target: { instanceId: decision.peer.instanceId, sessionId: decision.peer.sessionId },
            name: decision.peer.name,
            cwd: decision.peer.cwd,
          };
        case "NotFound":
          return yield* fail(`talk: no listed session matches ${literal(to)} (not-found).`, {
            outcome: "not-found",
          });
        case "NotLive":
          return yield* fail(
            `talk: ${literal(to)} is not live (not-live). Candidates:\n${describeCandidates(candidates)}`,
            { outcome: "not-live", ...(sole === undefined ? {} : { instanceId: sole }) },
          );
        case "Ambiguous": {
          const rows = describeCandidates(candidates);
          const answered = candidates.filter(({ probe }) => probeState(probe) === "answered");
          const unended = candidates.filter(({ probe }) => probeState(probe) !== "ended");
          const [only] = unended;
          // #260 H3: fewer than two answers leave no choice that resolves the refusal; one session keeps its ids.
          const classified =
            answered.length >= 2
              ? { ambiguous: true as const }
              : unended.length === 1 && only !== undefined
                ? { unanswered: rows, instanceId: only.peer.instanceId, outcome: only.probe }
                : { unanswered: rows };
          return yield* fail(
            `talk: ${literal(to)} does not name exactly one live session. Nothing was sent. ` +
              `Use instance with one full instance id:\n${rows}`,
            { ...classified, ...host },
          );
        }
      }
    }
  }
});

const sender = (self: TalkSelf): DeliverBody["from"] => ({
  name: self.name,
  cwd: self.cwd,
  sessionId: self.sessionId,
});

const idLines = (messageId: string, target: ResolvedTarget): string =>
  `Message id: ${messageId}\nInstance: ${target.target.instanceId}` +
  (target.name === undefined ? "" : ` (${literal(target.name)})`);

/**
 * Once a request went out, its target can hold the message, so every failure
 * names the message id and the instance id, and `cancel` stays possible (E5).
 */
const afterDispatch = <A>(
  effect: Effect.Effect<A, TalkToolFailed | TalkBodyInvalid>,
  messageId: string,
  target: ResolvedTarget,
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
  target: ResolvedTarget,
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
  target: ResolvedTarget,
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

/** The text and the options of one message, after its target resolved. */
export interface SendInput {
  readonly text: string;
  readonly attachments: NonNullable<TalkParams["attachments"]>;
  readonly noWake: boolean;
  /** `handover` only from the `/talk` handover flow (#251 G6); the tool sends `message`. */
  readonly kind: DeliverKind;
  /** Set: the send fixes its ids there before the request, and the transport records the body write and the answer (#260 H5). */
  readonly record?: DispatchRecord | undefined;
}

/**
 * The send to one resolved pair (E5): the `send` action and the `/talk`
 * views call it, so both give the same results, ids, and errors. A plain
 * message leaves `kind` out, so its body is the body of #250.
 */
export const sendTo = Effect.fnUntraced(function* (
  context: ToolContext,
  target: ResolvedTarget,
  input: SendInput,
) {
  const messageId = newMessageId();
  const json = yield* encodeDeliverBody({
    messageId,
    from: sender(context.self),
    text: input.text,
    attachments: input.attachments,
    sentAt: context.clock.now(),
    noWake: input.noWake,
    ...(input.kind === "message" ? {} : { kind: input.kind }),
  });
  if (input.record !== undefined) input.record.sent = { messageId, target };
  const { outcome } = yield* dispatched(
    "the send",
    () =>
      context.transport.request(
        target.target,
        DELIVER_KIND,
        json,
        undefined,
        undefined,
        input.record?.trace,
      ),
    decodeDeliverResult,
    messageId,
    target,
  );
  const report = `${OUTCOME_TEXT[outcome]}\n${idLines(messageId, target)}`;
  const ids = { messageId, instanceId: target.target.instanceId, outcome };
  if (!acceptsDelivery(outcome)) return yield* fail(`talk: ${report}`, ids);
  return { ok: true, text: report, details: { action: "send", ...ids } } satisfies TalkToolOutcome;
});

/**
 * #251 G3: a send to one exact registration pair. The pair resolves through
 * the `instance` path of E8, never by name, so a pair that ended reads
 * `not-live` and a session that took over its name receives nothing.
 */
export const sendToPair = Effect.fnUntraced(function* (
  context: ToolContext,
  pair: Target,
  input: SendInput,
) {
  const resolved = yield* resolveTarget(context, {
    _tag: "Instance",
    instanceId: pair.instanceId,
  });
  if (resolved.target.sessionId !== pair.sessionId)
    return yield* fail(
      `talk: the instance ${pair.instanceId} no longer serves the session ${literal(pair.sessionId)} (not-live). Nothing was sent.`,
      { instanceId: pair.instanceId, outcome: "not-live" },
    );
  return yield* sendTo(context, resolved, input);
});

const runSend = Effect.fnUntraced(function* (
  context: ToolContext,
  params: TalkParams,
  selector: Selector,
) {
  const text = yield* requireMessage("send", params.message);
  const target = yield* resolveTarget(context, selector);
  return yield* sendTo(context, target, {
    text,
    attachments: params.attachments ?? [],
    noWake: params.noWake ?? false,
    kind: "message",
  });
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

/** The reply as the result of a waiting ask: the head line, the trust line, the text, and the attachments. */
const replyText = (reply: ReplyBody): string =>
  [
    `**Reply from ${literal(reply.from.name)}:**\n${TRUST_LINE}\n\n${reply.text}`,
    ...reply.attachments.map((attachment) => formatAttachment(attachment, reply.sentAt)),
  ].join("\n\n");

const askOutcome = (
  outcome: AskOutcome,
  askId: string,
  target: ResolvedTarget,
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

/** The rows of a nonempty set of asks. Their previews are peer text, so the trust line comes first. */
const askRows = (asks: ReadonlyArray<PendingAsk>): string =>
  `${TRUST_LINE}\n${asks.map(askLine).join("\n")}`;

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
        `talk: more than one ask waits; set replyTo to one ask id:\n${askRows(selection.asks)}`,
      );
    case "Found":
      break;
  }
  const { ask } = selection;
  const messageId = newMessageId();
  const target: ResolvedTarget = { target: ask.route.replyTo, name: ask.from.name };
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
      "talk: messageId takes the id (16 lowercase hex digits) of the message to check or withdraw, from a send, ask, or handover result.",
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
  // E8: `list` omits registrations proven ended and marks unresolved ones.
  const rows = yield* listSessions(context);
  const text =
    rows.length === 0
      ? "No live talk sessions."
      : `Talk sessions (${rows.length}); use the full instance id as instance:\n` +
        rows.map(peerLine).join("\n");
  return { ok: true, text, details: { action: "list" } } satisfies TalkToolOutcome;
});

const runPending = (context: ToolContext): TalkToolOutcome => {
  const asks = context.self.pending.list(askReceiver(context.self));
  return {
    ok: true,
    text:
      asks.length === 0
        ? "No ask waits for a reply from this session."
        : `Asks that wait for a reply (${asks.length}):\n${askRows(asks)}`,
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
    asks.length === 0 ? "Pending asks: none" : `Pending asks (${asks.length}):\n${askRows(asks)}`;
  return {
    ok: true,
    text: [head, registration, peers, `Queued messages: ${self.queuedCount}`, pending].join("\n"),
    details: { action: "status" },
  } satisfies TalkToolOutcome;
});

// ── handover (#260 H1 to H5) ──

/**
 * One send of a `/talk` flow, outside the promise of the send (#260 H5).
 * The end of a flow interrupts that promise and its sending view drops the
 * result, so the flow returns this record instead.
 */
export interface DispatchRecord {
  /** The message id and the target, fixed before the request goes out. */
  sent: { readonly messageId: string; readonly target: ResolvedTarget } | undefined;
  readonly trace: RequestTrace;
}

export const newDispatchRecord = (): DispatchRecord => ({
  sent: undefined,
  trace: newRequestTrace(),
});

/** How a `/talk` flow ended (#260 H2, H4). */
export type FlowEnd =
  /** Nothing was sent: a view was cancelled, or the flow ended before a send. */
  | { readonly _tag: "Cancelled" }
  /** Nothing was sent: an error ended the flow, and its notice names the error. */
  | { readonly _tag: "Failed" }
  /** Nothing was sent: the side turn gave no draft. */
  | { readonly _tag: "SideTurnFailed" }
  /** A send started; `settled` is true when its result came before the flow ended. */
  | { readonly _tag: "Dispatched"; readonly record: DispatchRecord; readonly settled: boolean }
  /** Nothing was sent: right before the send, the destination was this binding's own registration (#260 H3). */
  | { readonly _tag: "OwnTarget" };

/** What the `handover` action needs from the binding of its session (#260 H2, H3). */
export interface HandoverFlow {
  /** The text of the first refusal of H3 that holds now, else undefined. */
  readonly refusal: () => string | undefined;
  /**
   * Whether `pair` is this binding's registration: at the start of the
   * call, now, or the one that it publishes and has not attached yet (H3).
   * It compares the exact pair, never the session id alone.
   */
  readonly isOwn: (pair: Target) => boolean;
  /**
   * Checks the refusals and the own registration again and, in the same
   * tick, runs the `/talk` handover flow for one exact target, so no flow
   * opens in between. It gives the refusal or the end of the flow, and it
   * never rejects.
   */
  readonly start: (
    target: ResolvedTarget,
    note: string | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<HandoverEnd>;
  /** Shows the raw error of a failed listing, lookup, or probe in a local notice; the result never holds it (H4). */
  readonly hostError: (diagnostic: string) => void;
}

/** How the `handover` action ended: a refusal of H3 when it started its flow, or the end of that flow. */
export type HandoverEnd = FlowEnd | { readonly _tag: "Refused"; readonly text: string };

export const HANDOVER_CANCELLED = "talk: the handover was cancelled. Nothing was sent.";
/** The side-turn failure of the tool result: the host error goes only to the notice of the flow (H4). */
export const HANDOVER_SIDE_TURN_FAILED = "talk: the handover side turn failed. Nothing was sent.";
export const HANDOVER_WRITE_FAILED =
  "talk: the handover send failed: the socket did not take the text (failed). Nothing was delivered.";
export const HANDOVER_UNKNOWN =
  "talk: the outcome of the handover is unknown: the text may have gone out, and no usable answer settled the outcome (unknown). The session can hold it; cancel with these ids withdraws it while it is queued.";
export const HANDOVER_OWN_TARGET =
  "talk: the target is this session. Nothing was sent. Name another session as to or instance.";
/** The result of a failed listing, lookup, or probe: fixed, without a path or a host error (H4). */
export const HANDOVER_REGISTRY_FAILED =
  "talk: the handover did not start: talk could not read the session registry to check the target. Nothing was sent. The talk notice in this session shows the error to the user. Ask the user to check it before a new handover.";
/** H3: what the agent can do when `to` matched more than one session. */
const HANDOVER_CHOOSE_ONE =
  "Name one session with instance, using its full instance id from list, or ask the user which session takes the handover.";
/** H3: what the agent can do when every session that `to` matched ended. */
const HANDOVER_PICK_LIVE = "Run the action list and name a live session.";
const HANDOVER_FAILED =
  "talk: an error ended the handover before the send. Nothing was sent. The talk notice in the session names the error.";
const HANDOVER_NOT_SENT =
  "talk: the handover send failed before the text went out (failed). Nothing was sent. The talk notice in the session names the reason.";
const NO_HANDOVER_FLOW = "talk: this session cannot start a handover. Nothing was sent.";
const HANDOVER_NO_ATTACHMENTS = "talk: the action handover takes no attachments. Nothing was sent.";
const HANDOVER_ALWAYS_WAKES =
  "talk: the action handover always asks the target for a turn, so it takes no noWake: true. Nothing was sent.";
const UNKNOWN_KIND_TEXT =
  "Unknown kind: the session has no handler for this message. Nothing was delivered.";

/** The outcome of the response frame of a handover; undefined for an `ok` body that is no deliver result. */
const answerOutcome = (
  answer: ResponseResult,
): DeliverResult["outcome"] | "unknown-kind" | undefined => {
  switch (answer.status) {
    case "ok": {
      const decoded = decodeDeliverResultNow(answer.body);
      return Result.isSuccess(decoded) ? decoded.success.outcome : undefined;
    }
    case "not-live":
      return "not-live";
    case "unknown-kind":
      return "unknown-kind";
  }
};

/**
 * H4: the result follows the dispatch state of the body, not what ended the
 * flow. An answer gives its outcome; a body that may have gone out without
 * an answer gives `unknown`; a failed write gives `failed`; no write gives
 * `failed` after a result of the send, else `cancelled`.
 */
const dispatchResult = (
  { sent, trace }: DispatchRecord,
  settled: boolean,
): Effect.Effect<TalkToolOutcome, TalkToolFailed> => {
  const ids =
    sent === undefined
      ? {}
      : { messageId: sent.messageId, instanceId: sent.target.target.instanceId };
  const lines = sent === undefined ? "" : `\n${idLines(sent.messageId, sent.target)}`;
  const answered = trace.answer === undefined ? undefined : answerOutcome(trace.answer);
  if (answered === "unknown-kind")
    return fail(`talk: Handover: ${UNKNOWN_KIND_TEXT}${lines}`, { ...ids, outcome: answered });
  if (answered !== undefined) {
    const report = `Handover: ${OUTCOME_TEXT[answered]}${lines}`;
    return acceptsDelivery(answered)
      ? Effect.succeed({
          ok: true,
          text: report,
          details: { action: "handover", ...ids, outcome: answered },
        })
      : fail(`talk: ${report}`, { ...ids, outcome: answered });
  }
  switch (trace.write) {
    case "pending":
    case "done":
      return fail(`${HANDOVER_UNKNOWN}${lines}`, { ...ids, outcome: "unknown" });
    case "failed":
      return fail(`${HANDOVER_WRITE_FAILED}${lines}`, { ...ids, outcome: "failed" });
    case "none":
      return settled
        ? fail(HANDOVER_NOT_SENT, { outcome: "failed" })
        : fail(HANDOVER_CANCELLED, { outcome: "cancelled" });
  }
};

const handoverResult = (end: HandoverEnd): Effect.Effect<TalkToolOutcome, TalkToolFailed> => {
  switch (end._tag) {
    case "Refused":
      return fail(end.text);
    case "Cancelled":
      return fail(HANDOVER_CANCELLED, { outcome: "cancelled" });
    case "Failed":
      return fail(HANDOVER_FAILED, { outcome: "failed" });
    case "SideTurnFailed":
      return fail(HANDOVER_SIDE_TURN_FAILED, { outcome: "failed" });
    case "Dispatched":
      return dispatchResult(end.record, end.settled);
    case "OwnTarget":
      return fail(HANDOVER_OWN_TARGET, { outcome: "cancelled" });
  }
};

/** Fails with the refusal of H3 that holds now; a check that throws fails with its error. */
const refuseHandover = (flow: HandoverFlow): Effect.Effect<void, TalkToolFailed> =>
  Effect.try({
    try: flow.refusal,
    catch: (cause) => new TalkToolFailed({ message: `talk: ${causeText(cause)}` }),
  }).pipe(Effect.flatMap((refusal) => (refusal === undefined ? Effect.void : fail(refusal))));

/**
 * H3: the recovery of the `handover` action for a `to` that named no one
 * target. Sessions that did not answer get a request to check them and to
 * list again, with the instance id and the probe result of a single one; a
 * choice between sessions gets the instance advice; ended sessions get a
 * request for a live one. Every other refusal of the resolver, and a
 * failure of this process with its diagnostic, keeps its text. The shared
 * resolver keeps its texts for `send`, `ask`, `cancel`, and `/talk`.
 */
const withRecovery =
  (selector: Selector) =>
  (error: TalkToolFailed): TalkToolFailed => {
    if (error.diagnostic !== undefined) return error;
    const { unanswered, instanceId, outcome } = error;
    if (unanswered !== undefined && selector._tag === "To") {
      const to = literal(selector.to);
      return instanceId === undefined || outcome === undefined
        ? new TalkToolFailed({
            message: `talk: ${to} names sessions that did not answer a probe. Nothing was sent. Check the listed sessions, then run the action list again:\n${unanswered}`,
          })
        : new TalkToolFailed({
            message: `talk: ${to} did not answer a probe (${outcome}). Nothing was sent. Check that session, then run the action list again:\n${unanswered}`,
            instanceId,
            outcome,
          });
    }
    if (error.ambiguous === true)
      return new TalkToolFailed({ message: `${error.message}\n${HANDOVER_CHOOSE_ONE}` });
    if (outcome === "not-live")
      return new TalkToolFailed({
        message: `${error.message}\n${HANDOVER_PICK_LIVE}`,
        outcome: "not-live",
        ...(instanceId === undefined ? {} : { instanceId }),
      });
    return error;
  };

/**
 * A check before the side turn failed (H4, H5): after an abort of the call,
 * the action reports `cancelled`; a failed listing, lookup, or probe shows
 * its host error in a local notice and gives a fixed text with the instance
 * id that the action knows; every other refusal keeps its text.
 */
const preflightFailed = (
  flow: HandoverFlow,
  signal: AbortSignal | undefined,
  error: TalkToolFailed,
): Effect.Effect<never, TalkToolFailed> => {
  if (signal?.aborted === true) return fail(HANDOVER_CANCELLED, { outcome: "cancelled" });
  const { diagnostic, instanceId } = error;
  if (diagnostic === undefined) return Effect.fail(error);
  return Effect.andThen(
    Effect.sync(() => {
      flow.hostError(diagnostic);
    }),
    fail(HANDOVER_REGISTRY_FAILED, {
      ...(instanceId === undefined ? {} : { instanceId }),
      outcome: "failed",
    }),
  );
};

/**
 * The one exact target of a handover, checked before the side turn with the
 * signal of the call: not this binding's registration (at the start of the
 * call, now, or the one that it publishes), and for an exact instance, a
 * probe that answers (H3). A probe that failed in this process is a host
 * failure, not a refusal of the peer (H4).
 */
const handoverTarget = Effect.fnUntraced(function* (
  context: ToolContext,
  flow: HandoverFlow,
  selector: Selector,
  signal: AbortSignal | undefined,
) {
  const target = yield* resolveTarget(context, selector, signal).pipe(
    Effect.mapError(withRecovery(selector)),
  );
  const { instanceId } = target.target;
  if (flow.isOwn(target.target)) return yield* fail(HANDOVER_OWN_TARGET, { instanceId });
  // An exact instance resolves without a probe (E8), so the action probes it before the side turn.
  if (selector._tag === "Instance") {
    const hostErrors: Array<string> = [];
    const [probe] = yield* transportCall("the probe", () =>
      context.transport.probeAll([target.target], signal, (_pair, reason) => {
        hostErrors.push(reason);
      }),
    ).pipe(Effect.mapError(knowing(instanceId)));
    if (probe !== "ok")
      return yield* fail(
        `talk: the instance ${instanceId} did not answer a probe (${probe ?? "no result"}). Nothing was sent. Check that session, then run the action list again.`,
        {
          instanceId,
          ...(probe === undefined ? {} : { outcome: probe }),
          ...(hostErrors.length === 0 ? {} : { diagnostic: hostErrors.join("; ") }),
        },
      );
  }
  return target;
});

/**
 * H1 to H3: the action refuses before the side turn when the session cannot
 * run the review, then starts the `/talk` handover flow for the one exact
 * target and reports how its send went (H4). The summary never reaches the
 * result.
 */
const runHandover = Effect.fnUntraced(function* (
  context: ToolContext,
  params: TalkParams,
  selector: Selector,
) {
  // H1: a handover carries no attachment, so even an empty list is an argument error.
  if (params.attachments !== undefined) return yield* fail(HANDOVER_NO_ATTACHMENTS);
  if (params.noWake === true) return yield* fail(HANDOVER_ALWAYS_WAKES);
  const flow = context.handover;
  if (flow === undefined) return yield* fail(NO_HANDOVER_FLOW);
  yield* refuseHandover(flow);
  const { signal } = context;
  const target = yield* handoverTarget(context, flow, selector, signal).pipe(
    Effect.catch((error) => preflightFailed(flow, signal, error)),
  );
  if (signal?.aborted === true) return yield* fail(HANDOVER_CANCELLED, { outcome: "cancelled" });
  // `start` checks the refusals again: a `/talk` flow can open while the target resolves, and the action never ends it.
  const end = yield* Effect.tryPromise({
    try: () => flow.start(target, params.message, signal),
    catch: () => new TalkToolFailed({ message: HANDOVER_FAILED, outcome: "failed" }),
  });
  return yield* handoverResult(end);
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
        case "handover":
          return runHandover(context, params, selector);
      }
    }),
  );

/**
 * The details of a failed call: only the ids that it knows. A failed
 * `handover` always names an outcome: `failed` when no more specific one
 * holds, such as a refusal before the side turn (#260 H4).
 */
const failedOutcome = (action: TalkAction | undefined, error: Error): TalkToolOutcome => {
  const known = error instanceof TalkToolFailed ? error : undefined;
  const outcome = known?.outcome ?? (action === "handover" ? "failed" : undefined);
  const details: TalkToolDetails = {
    action,
    ...(known?.messageId === undefined ? {} : { messageId: known.messageId }),
    ...(known?.instanceId === undefined ? {} : { instanceId: known.instanceId }),
    ...(outcome === undefined ? {} : { outcome }),
  };
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
