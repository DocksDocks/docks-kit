import { randomBytes } from "node:crypto";

import { Effect, Exit } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { encodeFrame, makeFrameDecoder } from "../../../talk/transport/frame";
import {
  type MessageError,
  type ProofFields,
  PROTOCOL_VERSION,
  computeHmac,
  decodeChallenge,
  decodeHandshakeEnd,
  decodeHello,
  decodeProof,
  decodeRequest,
  decodeResponse,
  makeNonce,
  verifyHmac,
} from "../../../talk/transport/handshake";

// Handshake messages and proofs of #249 E8 (#248 D2 Frames).
const NUM_RUNS = 200;
const PROPERTY_TIMEOUT_MS = 60_000;

const secret = randomBytes(32);
const clientNonce = Effect.runSync(makeNonce);
const listenerNonce = Effect.runSync(makeNonce);
const fields: ProofFields = {
  role: "listener",
  clientNonce,
  listenerNonce,
  instanceId: "0123456789abcdef",
  sessionId: "session-1",
};

const failure = (exit: Exit.Exit<unknown, MessageError>): MessageError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const reason = exit.cause.reasons.find((item) => item._tag === "Fail");
  if (reason === undefined) throw new Error("expected a typed failure");
  return reason.error;
};

describe("makeNonce", () => {
  it("returns 32 random bytes as lowercase hex", () => {
    const first = Effect.runSync(makeNonce);
    const second = Effect.runSync(makeNonce);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
  });
});

describe("computeHmac and verifyHmac", () => {
  it("verifies the listener and the client proof with the right secret", () => {
    for (const role of ["listener", "client"] as const) {
      const proof = { ...fields, role };
      expect(computeHmac(secret, proof)).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyHmac(secret, proof, computeHmac(secret, proof))).toBe(true);
    }
  });

  it("fails with a wrong secret", () => {
    const hmac = computeHmac(secret, fields);
    expect(verifyHmac(randomBytes(32), fields, hmac)).toBe(false);
  });

  it("fails with the wrong role", () => {
    const listenerHmac = computeHmac(secret, fields);
    expect(verifyHmac(secret, { ...fields, role: "client" }, listenerHmac)).toBe(false);
  });

  it("fails with swapped nonces", () => {
    const hmac = computeHmac(secret, fields);
    const swapped = { ...fields, clientNonce: listenerNonce, listenerNonce: clientNonce };
    expect(verifyHmac(secret, swapped, hmac)).toBe(false);
  });

  it("fails with another instance id or session id", () => {
    const hmac = computeHmac(secret, fields);
    expect(verifyHmac(secret, { ...fields, instanceId: "fedcba9876543210" }, hmac)).toBe(false);
    expect(verifyHmac(secret, { ...fields, sessionId: "session-2" }, hmac)).toBe(false);
  });

  it("fails with another nonce", () => {
    const hmac = computeHmac(secret, fields);
    const other = Effect.runSync(makeNonce);
    expect(verifyHmac(secret, { ...fields, clientNonce: other }, hmac)).toBe(false);
    expect(verifyHmac(secret, { ...fields, listenerNonce: other }, hmac)).toBe(false);
  });

  it(
    "keeps the field boundaries unambiguous",
    () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          fc.string({ minLength: 1 }),
          (instanceA, sessionA, instanceB, sessionB) => {
            fc.pre(instanceA !== instanceB || sessionA !== sessionB);
            const first = { ...fields, instanceId: instanceA, sessionId: sessionA };
            const second = { ...fields, instanceId: instanceB, sessionId: sessionB };
            expect(computeHmac(secret, first)).not.toBe(computeHmac(secret, second));
          },
        ),
        { numRuns: NUM_RUNS },
      );
      // The same concatenation with another split.
      const joinedA = computeHmac(secret, { ...fields, instanceId: "ab", sessionId: "c" });
      const joinedB = computeHmac(secret, { ...fields, instanceId: "a", sessionId: "bc" });
      expect(joinedA).not.toBe(joinedB);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe("decode helpers", () => {
  const hello = {
    type: "hello",
    version: PROTOCOL_VERSION,
    instanceId: "0123456789abcdef",
    sessionId: "session-1",
    nonce: clientNonce,
  };

  it("decodes each message", () => {
    expect(Effect.runSync(decodeHello(hello))).toEqual(hello);
    const challenge = {
      type: "challenge",
      nonce: listenerNonce,
      hmac: computeHmac(secret, fields),
    };
    expect(Effect.runSync(decodeChallenge(challenge))).toEqual(challenge);
    const proof = { type: "proof", hmac: computeHmac(secret, { ...fields, role: "client" }) };
    expect(Effect.runSync(decodeProof(proof))).toEqual(proof);
    expect(Effect.runSync(decodeHandshakeEnd({ type: "ready" }))).toEqual({ type: "ready" });
    expect(Effect.runSync(decodeHandshakeEnd({ type: "ended" }))).toEqual({ type: "ended" });
    const request = { type: "request", id: 7, kind: "ping", body: null };
    expect(Effect.runSync(decodeRequest(request))).toEqual(request);
    const response = { type: "response", id: 7, result: { ok: true } };
    expect(Effect.runSync(decodeResponse(response))).toEqual(response);
  });

  it("decodes a message that went through the frame codec", () => {
    const decoder = makeFrameDecoder();
    const frames = Effect.runSync(
      Effect.flatMap(encodeFrame(hello), (bytes) => decoder.push(bytes)),
    );
    expect(frames).toHaveLength(1);
    expect(Effect.runSync(decodeHello(frames[0]))).toEqual(hello);
  });

  it("rejects an unknown or malformed hello", () => {
    const rejected: ReadonlyArray<unknown> = [
      null,
      "hello",
      [],
      { ...hello, type: "greeting" },
      { ...hello, type: "challenge" },
      { ...hello, version: PROTOCOL_VERSION + 1 },
      { ...hello, nonce: "A".repeat(64) },
      { ...hello, nonce: clientNonce.slice(2) },
      { ...hello, instanceId: "" },
      { ...hello, instanceId: "0123456789ABCDEF" },
      { ...hello, instanceId: "0123456789abcde" },
      { ...hello, sessionId: 1 },
      { type: "hello", version: PROTOCOL_VERSION, instanceId: "a", nonce: clientNonce },
    ];
    for (const frame of rejected) {
      const error = failure(Effect.runSyncExit(decodeHello(frame)));
      expect(error._tag).toBe("MessageError");
      expect(error.expected).toBe("hello");
    }
  });

  it("rejects a malformed challenge or proof", () => {
    const hmac = computeHmac(secret, fields);
    expect(
      failure(Effect.runSyncExit(decodeChallenge({ type: "challenge", nonce: listenerNonce })))
        .expected,
    ).toBe("challenge");
    expect(
      failure(Effect.runSyncExit(decodeChallenge({ type: "proof", nonce: listenerNonce, hmac })))
        .expected,
    ).toBe("challenge");
    expect(
      failure(Effect.runSyncExit(decodeProof({ type: "proof", hmac: hmac.slice(1) }))).expected,
    ).toBe("proof");
    expect(failure(Effect.runSyncExit(decodeProof({ type: "proof" }))).expected).toBe("proof");
  });

  it("accepts only ready or ended after the proof", () => {
    for (const frame of [{ type: "hello" }, { type: "proof" }, { type: "done" }, {}]) {
      expect(failure(Effect.runSyncExit(decodeHandshakeEnd(frame))).expected).toBe(
        "ready or ended",
      );
    }
  });

  it("rejects a malformed request or response", () => {
    const rejectedRequests: ReadonlyArray<unknown> = [
      { type: "request", id: 1, kind: "ping" },
      { type: "request", id: -1, kind: "ping", body: null },
      { type: "request", id: 1.5, kind: "ping", body: null },
      { type: "request", id: "1", kind: "ping", body: null },
      { type: "request", id: 1, kind: "", body: null },
      { type: "response", id: 1, result: null },
    ];
    for (const frame of rejectedRequests) {
      expect(failure(Effect.runSyncExit(decodeRequest(frame))).expected).toBe("request");
    }
    const rejectedResponses: ReadonlyArray<unknown> = [
      { type: "response", id: 1 },
      { type: "response", result: null },
      { type: "request", id: 1, kind: "ping", body: null },
    ];
    for (const frame of rejectedResponses) {
      expect(failure(Effect.runSyncExit(decodeResponse(frame))).expected).toBe("response");
    }
  });
});
