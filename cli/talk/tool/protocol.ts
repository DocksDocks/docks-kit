/**
 * The request kinds of the talk tool and their bodies and results (#250 E4
 * to E6), plus the message limit of E9. Each body and result crosses the
 * transport as JSON; every encode and decode checks it with a Schema.
 */
import { Effect, Schema } from "effect";

import { MAX_FRAME_BYTES } from "../transport/frame";
import { InstanceId, SessionId } from "../transport/handshake";
import { Attachment } from "./attachments";

/** A message to a session: a send or an ask (E4, E5). */
export const DELIVER_KIND = "deliver";
/** The answer to an ask (E6). */
export const REPLY_KIND = "reply";
/** Withdraws a queued message or reads the outcome of a message (E5). */
export const CANCEL_KIND = "cancel";

/** A whole message as UTF-8 JSON: half the frame cap (E9). */
export const MAX_MESSAGE_BYTES = MAX_FRAME_BYTES / 2;

/** The random id of one message; the id of an ask is also its ask id. */
export const MessageId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/));

/** Where an ask started: in a main session or in a subagent session (E6). */
export const Origin = Schema.Literals(["main", "sub"]);
export type Origin = typeof Origin.Type;

/** One registration: an instance id and its session id, never the secret. */
export const RegistrationPair = Schema.Struct({ instanceId: InstanceId, sessionId: SessionId });

/** The sending session, for the From line (E9) and for `cancel` (E5). */
export const Sender = Schema.Struct({
  name: Schema.NonEmptyString,
  cwd: Schema.String,
  sessionId: SessionId,
});

/** Epoch milliseconds, inside the range of a JavaScript date. */
const SentAt = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(8_640_000_000_000_000),
);

/** The ask part of a deliver body: the origin flag and the reply address (E6). */
export const AskRoute = Schema.Struct({ origin: Origin, replyTo: RegistrationPair });

const messageFields = {
  messageId: MessageId,
  from: Sender,
  text: Schema.String,
  attachments: Schema.Array(Attachment),
  sentAt: SentAt,
  noWake: Schema.Boolean,
};

/** The body of a `deliver` request. With `ask`, the message is an ask whose ask id is `messageId`. */
export const DeliverBody = Schema.Struct({ ...messageFields, ask: Schema.optionalKey(AskRoute) });
export type DeliverBody = typeof DeliverBody.Type;

/**
 * The body of a `reply` request. `replier` is the registration that received
 * the ask, so a waiter can match the expected sender; `origin` repeats the
 * flag of the ask.
 */
export const ReplyBody = Schema.Struct({
  ...messageFields,
  replier: RegistrationPair,
  askId: MessageId,
  origin: Origin,
});
export type ReplyBody = typeof ReplyBody.Type;

/** The body of a `cancel` request: the message and the session that sent it. */
export const CancelBody = Schema.Struct({ messageId: MessageId, senderSessionId: SessionId });
export type CancelBody = typeof CancelBody.Type;

/** The outcome of a `deliver` request (E4, E5, E6). `no-reply-route` answers only an ask. */
export const DeliverOutcome = Schema.Literals([
  "delivered",
  "queued",
  "submitted",
  "busy",
  "not-live",
  "no-reply-route",
]);
export type DeliverOutcome = typeof DeliverOutcome.Type;

/**
 * The outcome of a `reply` request (E6): `delivered` also when the reply
 * completed a waiter; `not-found` for a reply with the flag `sub` that
 * matches no waiter.
 */
export const ReplyOutcome = Schema.Literals([
  "delivered",
  "queued",
  "submitted",
  "busy",
  "not-live",
  "not-found",
]);
export type ReplyOutcome = typeof ReplyOutcome.Type;

/** The outcome of a `cancel` request (E5): `cancelled` for a queued message, else its current outcome. */
export const CancelOutcome = Schema.Literals([
  "cancelled",
  "submitted",
  "delivered",
  "not-live",
  "unknown",
  "not-found",
]);
export type CancelOutcome = typeof CancelOutcome.Type;

/** Each result names the message and the full instance id of the registration that received the request. */
const resultOf = <O extends Schema.Top>(outcome: O) =>
  Schema.Struct({ outcome, messageId: MessageId, instanceId: InstanceId });

export const DeliverResult = resultOf(DeliverOutcome);
export type DeliverResult = typeof DeliverResult.Type;
export const ReplyResult = resultOf(ReplyOutcome);
export type ReplyResult = typeof ReplyResult.Type;
export const CancelResult = resultOf(CancelOutcome);
export type CancelResult = typeof CancelResult.Type;

/** A body or result does not match its Schema. */
export class TalkBodyInvalid extends Schema.TaggedError<
  TalkBodyInvalid,
  { readonly brand: unique symbol }
>()("TalkBodyInvalid", {
  expected: Schema.String,
  message: Schema.String,
}) {}

/** A message is above `MAX_MESSAGE_BYTES` of UTF-8 JSON (E9). */
export class TalkMessageTooLarge extends Schema.TaggedError<
  TalkMessageTooLarge,
  { readonly brand: unique symbol }
>()("TalkMessageTooLarge", {
  bytes: Schema.Int,
  limit: Schema.Int,
}) {
  override get message(): string {
    return `The message is ${this.bytes} bytes of UTF-8 JSON, above the limit of ${this.limit} bytes.`;
  }
}

const utf8Encoder = new TextEncoder();

/** The size of a value as UTF-8 JSON, as the frame sends it. */
export const messageBytes = (value: unknown): number =>
  utf8Encoder.encode(JSON.stringify(value)).byteLength;

const checkSize = (json: unknown): Effect.Effect<void, TalkMessageTooLarge> => {
  const bytes = messageBytes(json);
  return bytes > MAX_MESSAGE_BYTES
    ? Effect.fail(new TalkMessageTooLarge({ bytes, limit: MAX_MESSAGE_BYTES }))
    : Effect.void;
};

/** The JSON form of one body or result, checked by its Schema both ways. */
interface JsonCodec<A, E> {
  readonly encode: (value: A) => Effect.Effect<Schema.Json, E>;
  readonly decode: (json: unknown) => Effect.Effect<A, E>;
}

const codecFor = <S extends Schema.ConstraintCodec<unknown, unknown>>(
  schema: S,
  expected: string,
): JsonCodec<S["Type"], TalkBodyInvalid> => {
  const codec = Schema.toCodecJson(schema);
  const encodeJson = Schema.encodeEffect(codec);
  const decodeJson = Schema.decodeUnknownEffect(codec);
  const toInvalid = (issue: Schema.SchemaError): TalkBodyInvalid =>
    new TalkBodyInvalid({ expected, message: `Not a valid ${expected}: ${issue.message}` });
  return {
    encode: (value) => encodeJson(value).pipe(Effect.mapError(toInvalid)),
    decode: (json) => decodeJson(json).pipe(Effect.mapError(toInvalid)),
  };
};

/** Adds the size check of E9: a message above the limit fails at the sender, and the receiver refuses it too. */
const limited = <A>(
  codec: JsonCodec<A, TalkBodyInvalid>,
): JsonCodec<A, TalkBodyInvalid | TalkMessageTooLarge> => ({
  encode: (value) => codec.encode(value).pipe(Effect.tap(checkSize)),
  decode: (json) => checkSize(json).pipe(Effect.andThen(() => codec.decode(json))),
});

const deliverBody = limited(codecFor(DeliverBody, "deliver body"));
const replyBody = limited(codecFor(ReplyBody, "reply body"));
const cancelBody = codecFor(CancelBody, "cancel body");
const deliverResult = codecFor(DeliverResult, "deliver result");
const replyResult = codecFor(ReplyResult, "reply result");
const cancelResult = codecFor(CancelResult, "cancel result");

export const encodeDeliverBody = deliverBody.encode;
export const decodeDeliverBody = deliverBody.decode;
export const encodeReplyBody = replyBody.encode;
export const decodeReplyBody = replyBody.decode;
export const encodeCancelBody = cancelBody.encode;
export const decodeCancelBody = cancelBody.decode;
export const encodeDeliverResult = deliverResult.encode;
export const decodeDeliverResult = deliverResult.decode;
export const encodeReplyResult = replyResult.encode;
export const decodeReplyResult = replyResult.decode;
export const encodeCancelResult = cancelResult.encode;
export const decodeCancelResult = cancelResult.decode;
