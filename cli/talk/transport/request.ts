/**
 * Request results of the talk transport (#249 E8). The listener answers each
 * request with one `ResponseResult`; the client turns every failure into one
 * `RequestOutcome`.
 */
import { Effect, Schema } from "effect";

import type { WriteState } from "./connection";
import { MessageError } from "./handshake";

/** The kind that answers liveness; every listener serves it. */
export const PING_KIND = "ping";

/** The `result` of a response frame. */
export const ResponseResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), body: Schema.Json }),
  /** The registration ended while the listener held the request. */
  Schema.Struct({ status: Schema.Literal("not-live") }),
  /** The listener has no handler for the request kind. */
  Schema.Struct({ status: Schema.Literal("unknown-kind") }),
]);
export type ResponseResult = typeof ResponseResult.Type;

const decodeResult = Schema.decodeUnknownEffect(ResponseResult);

export const decodeResponseResult = (value: unknown): Effect.Effect<ResponseResult, MessageError> =>
  decodeResult(value).pipe(
    Effect.mapError(
      (issue) =>
        new MessageError({
          expected: "response result",
          message: `Response result is not valid: ${issue.message}`,
        }),
    ),
  );

/**
 * The failure of a request (E8 Client outcomes), plus `unknown-kind` for a
 * live target without a handler for the kind.
 */
export const RequestOutcome = Schema.Literals([
  "not-live",
  "not-found",
  "auth-failed",
  "timeout",
  "unreachable",
  "unknown-kind",
]);
export type RequestOutcome = typeof RequestOutcome.Type;

/** A request did not get an `ok` result. */
export class TalkRequestFailed extends Schema.TaggedError<
  TalkRequestFailed,
  { readonly brand: unique symbol }
>()("TalkRequestFailed", {
  outcome: RequestOutcome,
  reason: Schema.String,
  /**
   * The lookup of the target's entry in the registry failed in this process
   * (a trust check, I/O, DPAPI), so the peer was never asked (#260 H4).
   */
  lookupFailed: Schema.optionalKey(Schema.Literal(true)),
}) {}

/**
 * What one request did, outside its promise (#260 H5): the end of a flow
 * interrupts the promise, so the caller reads this record instead. The
 * client sets `write` from the socket write of the body: `none` before the
 * write call, then the states of `WriteState`. It sets `answer` when it
 * reads the response frame, a refusal such as `not-live` included.
 */
export interface RequestTrace {
  write: "none" | WriteState;
  answer: ResponseResult | undefined;
}

export const newRequestTrace = (): RequestTrace => ({ write: "none", answer: undefined });

/** One registration: the target of a request. */
export interface Target {
  readonly instanceId: string;
  readonly sessionId: string;
}

/** The registration that received a request. */
export interface RequestContext {
  readonly registration: Target;
  readonly kind: string;
}

/** Answers one request kind. The listener sends the value as the `ok` body. */
export type RequestHandler = (
  body: Schema.Json,
  context: RequestContext,
) => Effect.Effect<Schema.Json>;
