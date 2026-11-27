/**
 * Session names and target selection of the talk tool (#250 E8). Every
 * function here is pure: it works on listing entries, retained registration
 * pairs, and probe results that the caller passes in.
 */
import { Result, Schema } from "effect";

import { InstanceId } from "../transport/handshake";
import type { RequestOutcome, Target } from "../transport/request";
import { literal } from "./attachments";

/** The shortest session id prefix that `to` accepts. */
export const MIN_PREFIX_LENGTH = 4;

/** The number of session id characters in a fallback name. */
const FALLBACK_ID_LENGTH = 8;

/** The trimmed session name, else `session-` and the first 8 characters of the session id. */
export const sessionName = (name: string | undefined, sessionId: string): string => {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" ? `session-${sessionId.slice(0, FALLBACK_ID_LENGTH)}` : trimmed;
};

/** The actions of the `talk` tool (E10). */
export type TalkAction = "list" | "send" | "ask" | "reply" | "pending" | "status" | "cancel";

/** The target fields of one tool call. A missing or blank field counts as unset. */
export interface TargetFields {
  readonly to?: string | undefined;
  readonly instance?: string | undefined;
  readonly messageId?: string | undefined;
}

/** How a call names its target. */
export type Selector =
  | { readonly _tag: "None" }
  | { readonly _tag: "To"; readonly to: string }
  | { readonly _tag: "Instance"; readonly instanceId: string };

export const SelectorFault = Schema.Literals([
  "missing-target",
  "both-targets",
  "unexpected-target",
  "missing-message-id",
  "invalid-instance",
]);
export type SelectorFault = typeof SelectorFault.Type;

const FAULT_TEXT: Record<SelectorFault, string> = {
  "missing-target": "needs exactly one of to and instance",
  "both-targets": "takes only one of to and instance, not both",
  "unexpected-target": "takes neither to nor instance",
  "missing-message-id": "needs messageId",
  "invalid-instance": "takes only a full instance id (16 lowercase hex digits) as instance",
};

/** The target fields of a call do not fit its action. */
export class TalkSelectorError extends Schema.TaggedError<
  TalkSelectorError,
  { readonly brand: unique symbol }
>()("TalkSelectorError", {
  action: Schema.String,
  reason: SelectorFault,
}) {
  override get message(): string {
    return `The action ${this.action} ${FAULT_TEXT[this.reason]}.`;
  }
}

const isInstanceId = Schema.is(InstanceId);

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Checks the target fields against the action: `send` and `ask` need exactly
 * one of `to` and `instance`, `cancel` needs one beside `messageId`, and
 * `reply`, `list`, `pending`, and `status` take neither.
 */
export const selectorFor = (
  action: TalkAction,
  fields: TargetFields,
): Result.Result<Selector, TalkSelectorError> => {
  const fail = (reason: SelectorFault) => Result.fail(new TalkSelectorError({ action, reason }));
  const to = present(fields.to);
  const instance = present(fields.instance);
  switch (action) {
    case "reply":
    case "list":
    case "pending":
    case "status":
      return to === undefined && instance === undefined
        ? Result.succeed({ _tag: "None" })
        : fail("unexpected-target");
    case "cancel":
      if (present(fields.messageId) === undefined) return fail("missing-message-id");
      break;
    case "send":
    case "ask":
      break;
  }
  if (to !== undefined && instance !== undefined) return fail("both-targets");
  if (to !== undefined) return Result.succeed({ _tag: "To", to });
  if (instance === undefined) return fail("missing-target");
  return isInstanceId(instance)
    ? Result.succeed({ _tag: "Instance", instanceId: instance })
    : fail("invalid-instance");
};

/** A listing entry, as far as target selection reads it. */
export interface ListedTarget extends Target {
  readonly name: string;
}

/** What `to` matched in the listing. */
export type ToMatch<P extends ListedTarget> =
  | {
      readonly _tag: "Matched";
      readonly by: "name" | "session-id" | "prefix";
      readonly peers: ReadonlyArray<P>;
    }
  | { readonly _tag: "NoMatch" }
  /** The prefix starts more than one session id; nothing is probed or sent. */
  | { readonly _tag: "AmbiguousPrefix"; readonly peers: ReadonlyArray<P> };

/**
 * Matches `to` against the current listing only, in this order: exact name
 * without regard to case, full session id, then a unique session id prefix of
 * at least 4 characters. A match can hold several registrations, for example
 * two registrations of one session.
 */
export const matchTo = <P extends ListedTarget>(
  listing: ReadonlyArray<P>,
  to: string,
): ToMatch<P> => {
  const wanted = to.toLowerCase();
  const byName = listing.filter((peer) => peer.name.toLowerCase() === wanted);
  if (byName.length > 0) return { _tag: "Matched", by: "name", peers: byName };
  const bySession = listing.filter((peer) => peer.sessionId === to);
  if (bySession.length > 0) return { _tag: "Matched", by: "session-id", peers: bySession };
  if (to.length < MIN_PREFIX_LENGTH) return { _tag: "NoMatch" };
  const byPrefix = listing.filter((peer) => peer.sessionId.startsWith(to));
  if (byPrefix.length === 0) return { _tag: "NoMatch" };
  const sessions = new Set(byPrefix.map((peer) => peer.sessionId));
  return sessions.size === 1
    ? { _tag: "Matched", by: "prefix", peers: byPrefix }
    : { _tag: "AmbiguousPrefix", peers: byPrefix };
};

/** The result of the probe of one match: `ok` or the failure of the transport. */
export type ProbeResult = "ok" | RequestOutcome;

/** What a probe result proves. */
export type ProbeState = "answered" | "ended" | "unresolved";

/**
 * Only `ok` answers and only `not-live` proves an end. Every other failure,
 * `not-found` and `unknown-kind` included, proves neither.
 */
export const probeState = (result: ProbeResult): ProbeState => {
  switch (result) {
    case "ok":
      return "answered";
    case "not-live":
      return "ended";
    case "not-found":
    case "auth-failed":
    case "timeout":
    case "unreachable":
    case "unknown-kind":
      return "unresolved";
  }
};

/** One match of `to` with the result of its probe. */
export interface Candidate<P extends ListedTarget> {
  readonly peer: P;
  readonly probe: ProbeResult;
}

/** The E8 outcome of `to` after the probes. */
export type ToDecision<P extends ListedTarget> =
  | { readonly _tag: "Target"; readonly peer: P }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "NotLive"; readonly candidates: ReadonlyArray<Candidate<P>> }
  /** Nothing is sent; the error lists every candidate with its probe result. */
  | { readonly _tag: "Ambiguous"; readonly candidates: ReadonlyArray<Candidate<P>> };

/**
 * No match reads `not-found`; every match proven ended reads `not-live`;
 * exactly one match that answered, with every other match proven ended,
 * receives the message; every other case is ambiguous.
 */
export const decideTo = <P extends ListedTarget>(
  candidates: ReadonlyArray<Candidate<P>>,
): ToDecision<P> => {
  if (candidates.length === 0) return { _tag: "NotFound" };
  const live = candidates.filter((candidate) => probeState(candidate.probe) !== "ended");
  if (live.length === 0) return { _tag: "NotLive", candidates };
  const [only] = live;
  return live.length === 1 && only !== undefined && probeState(only.probe) === "answered"
    ? { _tag: "Target", peer: only.peer }
    : { _tag: "Ambiguous", candidates };
};

const PROBE_TEXT: Record<ProbeResult, string> = {
  ok: "answered",
  "not-live": "not live",
  "not-found": "not found",
  "auth-failed": "auth-failed",
  timeout: "timeout",
  unreachable: "unreachable",
  "unknown-kind": "unknown-kind",
};

/** The row of one peer: its name and session id as literals, and its full instance id. */
const peerRow = (peer: ListedTarget): string =>
  `- ${literal(peer.name)} (session ${literal(peer.sessionId)}): instance ${peer.instanceId}`;

/** One row per peer, for the peers that an ambiguous prefix matched. */
export const describePeers = (peers: ReadonlyArray<ListedTarget>): string =>
  peers.map(peerRow).join("\n");

/** One row per candidate: the row of its peer and its probe result. */
export const describeCandidates = (candidates: ReadonlyArray<Candidate<ListedTarget>>): string =>
  candidates.map(({ peer, probe }) => `${peerRow(peer)}, ${PROBE_TEXT[probe]}`).join("\n");

/** The E8 outcome of `instance`. The request itself then proves liveness. */
export type InstanceResolution =
  | { readonly _tag: "Target"; readonly target: Target; readonly source: "listing" | "retained" }
  | { readonly _tag: "NotFound" };

/**
 * Finds a full instance id, compared exactly, first in the listing and then
 * among the pairs that the transport retained. A name, a session id, or a
 * prefix never matches.
 */
export const resolveInstance = (
  instanceId: string,
  listing: ReadonlyArray<Target>,
  retained: ReadonlyArray<Target>,
): InstanceResolution => {
  const listed = listing.find((peer) => peer.instanceId === instanceId);
  if (listed !== undefined) {
    return {
      _tag: "Target",
      source: "listing",
      target: { instanceId: listed.instanceId, sessionId: listed.sessionId },
    };
  }
  const kept = retained.find((pair) => pair.instanceId === instanceId);
  return kept === undefined
    ? { _tag: "NotFound" }
    : {
        _tag: "Target",
        source: "retained",
        target: { instanceId: kept.instanceId, sessionId: kept.sessionId },
      };
};
