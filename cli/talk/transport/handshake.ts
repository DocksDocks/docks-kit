/**
 * Handshake and request messages of the talk transport (#249 E8, #248 D2 Frames), and the HMAC proofs of the mutual
 * challenge-response. Flow: `hello` → `challenge` → `proof` → `ready` (or `ended` for a registration that ended).
 * After `ready`, the client sends `request` frames and the listener answers each with a `response` frame.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { Effect, Schema } from "effect";

/** The protocol version that `hello` carries. A listener rejects any other version. */
export const PROTOCOL_VERSION = 1;

/** The byte count of each random nonce. */
export const NONCE_BYTES = 32;

/** A random 32-byte nonce as 64 lowercase hex characters. */
export const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TalkNonce"),
);
export type Nonce = typeof Nonce.Type;

/** An HMAC-SHA-256 digest as 64 lowercase hex characters. */
export const Hmac = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(
  Schema.brand("TalkHmac"),
);
export type Hmac = typeof Hmac.Type;

/** The instance id of a registration: 16 lowercase hex characters (#249 E5 Names). */
export const InstanceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/));

/** The session id of a registration: any non-empty string. Entries and `hello` use it. */
export const SessionId = Schema.NonEmptyString;

/** The id of a request; the response carries the same id. */
export const RequestId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Client → listener: the target registration and the client nonce. */
export const Hello = Schema.Struct({
  type: Schema.Literal("hello"),
  version: Schema.Literal(PROTOCOL_VERSION),
  instanceId: InstanceId,
  sessionId: SessionId,
  nonce: Nonce,
});
export type Hello = typeof Hello.Type;

/** Listener → client: the listener nonce and the listener proof. */
export const Challenge = Schema.Struct({
  type: Schema.Literal("challenge"),
  nonce: Nonce,
  hmac: Hmac,
});
export type Challenge = typeof Challenge.Type;

/** Client → listener: the client proof. The client sends it only after the listener proof checked out. */
export const Proof = Schema.Struct({
  type: Schema.Literal("proof"),
  hmac: Hmac,
});
export type Proof = typeof Proof.Type;

/** Listener → client: the handshake is complete, and requests can follow. */
export const Ready = Schema.Struct({ type: Schema.Literal("ready") });
export type Ready = typeof Ready.Type;

/** Listener → client, in place of `ready`: the registration that this listener served has ended. */
export const Ended = Schema.Struct({ type: Schema.Literal("ended") });
export type Ended = typeof Ended.Type;

/** The last handshake message: `ready` or `ended`. */
export const HandshakeEnd = Schema.Union([Ready, Ended]);
export type HandshakeEnd = typeof HandshakeEnd.Type;

/** Client → listener after `ready`. */
export const RequestFrame = Schema.Struct({
  type: Schema.Literal("request"),
  id: RequestId,
  kind: Schema.NonEmptyString,
  body: Schema.Json,
});
export type RequestFrame = typeof RequestFrame.Type;

/** Listener → client: the result of the request with the same id. */
export const ResponseFrame = Schema.Struct({
  type: Schema.Literal("response"),
  id: RequestId,
  result: Schema.Json,
});
export type ResponseFrame = typeof ResponseFrame.Type;

/** A frame that is not the message that the handshake or the connection expects. The connection closes. */
export class MessageError extends Schema.TaggedError<
  MessageError,
  { readonly brand: unique symbol }
>()("MessageError", {
  expected: Schema.String,
  message: Schema.String,
}) {}

const decoderFor = <S extends Schema.Decoder<unknown>>(schema: S, expected: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return (frame: unknown): Effect.Effect<S["Type"], MessageError> =>
    decode(frame).pipe(
      Effect.mapError(
        (issue) =>
          new MessageError({
            expected,
            message: `Frame is not a valid ${expected} message: ${issue.message}`,
          }),
      ),
    );
};

export const decodeHello = decoderFor(Hello, "hello");
export const decodeChallenge = decoderFor(Challenge, "challenge");
export const decodeProof = decoderFor(Proof, "proof");
export const decodeHandshakeEnd = decoderFor(HandshakeEnd, "ready or ended");
export const decodeRequest = decoderFor(RequestFrame, "request");
export const decodeResponse = decoderFor(ResponseFrame, "response");

/** Make a fresh random nonce. */
export const makeNonce: Effect.Effect<Nonce> = Effect.sync(() =>
  Nonce.make(randomBytes(NONCE_BYTES).toString("hex")),
);

/** The side that computes a proof. The role is part of the HMAC input, so one side cannot replay the other's proof. */
export type ProofRole = "listener" | "client";

/** The HMAC input of one proof. Both sides use the same nonces and ids; only the role differs. */
export interface ProofFields {
  readonly role: ProofRole;
  readonly clientNonce: Nonce;
  readonly listenerNonce: Nonce;
  readonly instanceId: string;
  readonly sessionId: string;
}

// The HMAC input starts with this label, so a digest of this protocol cannot match another use of the secret.
const PROOF_LABEL = `docks-kit-talk/${PROTOCOL_VERSION}`;

// HMAC-SHA-256 keyed by the registration secret. Each field is a 4-byte big-endian length, then the bytes, so no
// two field lists give the same input.
const proofDigest = (secret: Uint8Array, fields: ProofFields): Buffer => {
  const mac = createHmac("sha256", secret);
  const length = Buffer.alloc(4);
  for (const field of [
    Buffer.from(PROOF_LABEL, "utf8"),
    Buffer.from(fields.role, "utf8"),
    Buffer.from(fields.clientNonce, "hex"),
    Buffer.from(fields.listenerNonce, "hex"),
    Buffer.from(fields.instanceId, "utf8"),
    Buffer.from(fields.sessionId, "utf8"),
  ]) {
    length.writeUInt32BE(field.byteLength);
    mac.update(length);
    mac.update(field);
  }
  return mac.digest();
};

/** Compute the proof of one side. */
export const computeHmac = (secret: Uint8Array, fields: ProofFields): Hmac =>
  Hmac.make(proofDigest(secret, fields).toString("hex"));

/** Check a received proof in constant time. */
export const verifyHmac = (secret: Uint8Array, fields: ProofFields, hmac: Hmac): boolean => {
  const expected = proofDigest(secret, fields);
  const received = Buffer.from(hmac, "hex");
  return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
};
