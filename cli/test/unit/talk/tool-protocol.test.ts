import { Effect, Exit, type Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type CancelBody,
  type CancelResult,
  type DeliverBody,
  type DeliverResult,
  MAX_MESSAGE_BYTES,
  type ReplyBody,
  type ReplyResult,
  type TalkBodyInvalid,
  TalkMessageTooLarge,
  acceptsDelivery,
  decodeCancelBody,
  decodeCancelResult,
  decodeDeliverBody,
  decodeDeliverResult,
  decodeReplyBody,
  decodeReplyResult,
  encodeCancelBody,
  encodeCancelResult,
  encodeDeliverBody,
  encodeDeliverResult,
  encodeReplyBody,
  encodeReplyResult,
  messageBytes,
} from "../../../talk/tool/protocol";
import { MAX_FRAME_BYTES } from "../../../talk/transport/frame";

// Request bodies and results of #250 E4 to E6, and the message limit of E9.
const RECEIVER = "0123456789abcdef";
const ASKER = "fedcba9876543210";
const MESSAGE_ID = "a1b2c3d4e5f60718";
const ASK_ID = "1122334455667788";
const SENT_AT = Date.UTC(2026, 10, 26, 12, 30, 0);

const send: DeliverBody = {
  messageId: MESSAGE_ID,
  from: { name: "alice", cwd: "/home/alice/project", sessionId: "0193a1b2-c3d4-7e5f" },
  text: "Please check the build.",
  attachments: [
    { type: "file", name: "/home/alice/project/README.md", content: "# Title\n" },
    { type: "snippet", name: "fix", content: "const a = 1;", language: "ts" },
    { type: "snippet", name: "plain", content: "no language" },
    { type: "context", name: "notes", content: "The test failed twice." },
  ],
  sentAt: SENT_AT,
  noWake: false,
};

const ask: DeliverBody = {
  ...send,
  ask: { origin: "sub", replyTo: { instanceId: ASKER, sessionId: "0193ffff-0000-7000" } },
};

const reply: ReplyBody = {
  messageId: MESSAGE_ID,
  from: { name: "bob", cwd: "/home/bob/other", sessionId: "0193b000-1111-7222" },
  replier: { instanceId: RECEIVER, sessionId: "0193b000-1111-7222" },
  askId: ASK_ID,
  origin: "main",
  text: "Done.",
  attachments: [],
  sentAt: SENT_AT,
  noWake: true,
};

const cancel: CancelBody = { messageId: MESSAGE_ID, senderSessionId: "0193a1b2-c3d4-7e5f" };

/** Sends the value through JSON text, as a frame does. */
const overTheWire = (json: Schema.Json): unknown => JSON.parse(JSON.stringify(json));

const run = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect);

const failure = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const reason = exit.cause.reasons.find((item) => item._tag === "Fail");
  if (reason === undefined) throw new Error("expected a typed failure");
  return reason.error;
};

const invalid = (effect: Effect.Effect<unknown, TalkBodyInvalid | TalkMessageTooLarge>) =>
  failure(Effect.runSyncExit(effect));

describe("deliver body", () => {
  it("round-trips a send and an ask with every attachment kind", () => {
    for (const body of [send, ask]) {
      expect(run(decodeDeliverBody(overTheWire(run(encodeDeliverBody(body)))))).toEqual(body);
    }
  });

  it("keeps the origin flag and the reply address of an ask", () => {
    const decoded = run(decodeDeliverBody(overTheWire(run(encodeDeliverBody(ask)))));
    expect(decoded.ask).toEqual({
      origin: "sub",
      replyTo: { instanceId: ASKER, sessionId: "0193ffff-0000-7000" },
    });
    const plain = run(decodeDeliverBody(overTheWire(run(encodeDeliverBody(send)))));
    expect(plain.ask).toBeUndefined();
  });

  it.each([
    [
      "a message id that is not 16 lowercase hex digits",
      { ...send, messageId: "A1B2C3D4E5F60718" },
    ],
    ["a short message id", { ...send, messageId: "a1b2" }],
    ["an origin flag other than main or sub", { ...ask, ask: { ...ask.ask, origin: "parent" } }],
    [
      "a reply address with a partial instance id",
      { ...ask, ask: { origin: "main", replyTo: { instanceId: "fedc", sessionId: "s" } } },
    ],
    [
      "an unknown attachment kind",
      { ...send, attachments: [{ type: "image", name: "a", content: "b" }] },
    ],
    [
      "an attachment without a name",
      { ...send, attachments: [{ type: "file", name: "", content: "b" }] },
    ],
    [
      "a snippet language that could close its fence",
      { ...send, attachments: [{ type: "snippet", name: "a", content: "b", language: "ts```" }] },
    ],
    ["a missing sender", { ...send, from: undefined }],
    ["a sender without a name", { ...send, from: { ...send.from, name: "" } }],
    ["a negative send time", { ...send, sentAt: -1 }],
    ["a send time that is not an integer", { ...send, sentAt: 1.5 }],
    ["a missing noWake flag", { ...send, noWake: undefined }],
    ["text that is not a string", { ...send, text: 42 }],
  ])("rejects %s", (_label, body) => {
    const error = invalid(decodeDeliverBody(overTheWire(body as Schema.Json)));
    expect(error._tag).toBe("TalkBodyInvalid");
    expect(error).toMatchObject({ expected: "deliver body" });
  });

  it("rejects an invalid body at the sender before it leaves", () => {
    const error = invalid(encodeDeliverBody({ ...send, messageId: "nope" }));
    expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "deliver body" });
  });
});

describe("reply body", () => {
  it("round-trips a reply with each origin flag", () => {
    for (const origin of ["main", "sub"] as const) {
      const body = { ...reply, origin };
      expect(run(decodeReplyBody(overTheWire(run(encodeReplyBody(body)))))).toEqual(body);
    }
  });

  it.each([
    ["a missing ask id", { ...reply, askId: undefined }],
    ["an ask id that is not a message id", { ...reply, askId: "ask-1" }],
    ["a missing origin flag", { ...reply, origin: undefined }],
    ["an origin flag other than main or sub", { ...reply, origin: "both" }],
    ["a replier without an instance id", { ...reply, replier: { sessionId: "s" } }],
  ])("rejects %s", (_label, body) => {
    const error = invalid(decodeReplyBody(overTheWire(body as Schema.Json)));
    expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "reply body" });
  });
});

describe("cancel body", () => {
  it("round-trips a cancel", () => {
    expect(run(decodeCancelBody(overTheWire(run(encodeCancelBody(cancel)))))).toEqual(cancel);
  });

  it.each([
    ["a missing message id", { senderSessionId: "s" }],
    ["a missing sender session id", { messageId: MESSAGE_ID }],
    ["an empty sender session id", { messageId: MESSAGE_ID, senderSessionId: "" }],
  ])("rejects %s", (_label, body) => {
    const error = invalid(decodeCancelBody(body));
    expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "cancel body" });
  });
});

describe("results", () => {
  const deliverOutcomes = [
    "delivered",
    "queued",
    "submitted",
    "busy",
    "not-live",
    "no-reply-route",
  ] as const;
  const replyOutcomes = [
    "delivered",
    "queued",
    "submitted",
    "busy",
    "not-live",
    "not-found",
  ] as const;
  const cancelOutcomes = [
    "cancelled",
    "submitted",
    "delivered",
    "not-live",
    "unknown",
    "not-found",
  ] as const;

  it("round-trips each deliver outcome with the message id and the receiving instance id", () => {
    for (const outcome of deliverOutcomes) {
      const result: DeliverResult = { outcome, messageId: MESSAGE_ID, instanceId: RECEIVER };
      expect(run(decodeDeliverResult(overTheWire(run(encodeDeliverResult(result)))))).toEqual(
        result,
      );
    }
  });

  it("counts delivered, queued, and submitted as accepted, for send and ask alike (T15)", () => {
    expect(deliverOutcomes.filter(acceptsDelivery)).toEqual(["delivered", "queued", "submitted"]);
  });

  it("round-trips each reply outcome", () => {
    for (const outcome of replyOutcomes) {
      const result: ReplyResult = { outcome, messageId: MESSAGE_ID, instanceId: RECEIVER };
      expect(run(decodeReplyResult(overTheWire(run(encodeReplyResult(result)))))).toEqual(result);
    }
  });

  it("round-trips each cancel outcome", () => {
    for (const outcome of cancelOutcomes) {
      const result: CancelResult = { outcome, messageId: MESSAGE_ID, instanceId: RECEIVER };
      expect(run(decodeCancelResult(overTheWire(run(encodeCancelResult(result)))))).toEqual(result);
    }
  });

  it.each(["cancelled", "unknown", "not-found", "ok"])(
    "rejects the deliver outcome %s",
    (outcome) => {
      const error = invalid(
        decodeDeliverResult({ outcome, messageId: MESSAGE_ID, instanceId: RECEIVER }),
      );
      expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "deliver result" });
    },
  );

  it.each(["cancelled", "no-reply-route", "unknown"])("rejects the reply outcome %s", (outcome) => {
    const error = invalid(
      decodeReplyResult({ outcome, messageId: MESSAGE_ID, instanceId: RECEIVER }),
    );
    expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "reply result" });
  });

  it.each(["queued", "busy", "no-reply-route"])("rejects the cancel outcome %s", (outcome) => {
    const error = invalid(
      decodeCancelResult({ outcome, messageId: MESSAGE_ID, instanceId: RECEIVER }),
    );
    expect(error).toMatchObject({ _tag: "TalkBodyInvalid", expected: "cancel result" });
  });

  it("rejects a result that names a partial instance id or no message id", () => {
    expect(
      invalid(
        decodeDeliverResult({ outcome: "delivered", messageId: MESSAGE_ID, instanceId: "0123" }),
      ),
    ).toMatchObject({ _tag: "TalkBodyInvalid" });
    expect(
      invalid(decodeCancelResult({ outcome: "cancelled", instanceId: RECEIVER })),
    ).toMatchObject({ _tag: "TalkBodyInvalid" });
  });
});

describe("message limit", () => {
  /** A send whose UTF-8 JSON is exactly `bytes` long, padded with one-byte characters. */
  const sendOfSize = (bytes: number): DeliverBody => {
    const empty = { ...send, text: "" };
    return { ...empty, text: "a".repeat(bytes - messageBytes(empty)) };
  };

  it("is 512 KiB, half the frame cap", () => {
    expect(MAX_MESSAGE_BYTES).toBe(512 * 1024);
    expect(MAX_MESSAGE_BYTES * 2).toBe(MAX_FRAME_BYTES);
  });

  it("sends a message of exactly 512 KiB", () => {
    const body = sendOfSize(MAX_MESSAGE_BYTES);
    expect(messageBytes(body)).toBe(MAX_MESSAGE_BYTES);
    expect(run(decodeDeliverBody(overTheWire(run(encodeDeliverBody(body)))))).toEqual(body);
  });

  it("fails one byte above the limit at the sender, with the size and the limit", () => {
    const error = invalid(encodeDeliverBody(sendOfSize(MAX_MESSAGE_BYTES + 1)));
    expect(error).toBeInstanceOf(TalkMessageTooLarge);
    expect(error).toMatchObject({ bytes: MAX_MESSAGE_BYTES + 1, limit: MAX_MESSAGE_BYTES });
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 300 000 two-byte characters: below the limit in characters, above it in bytes.
    const body = { ...send, text: "é".repeat(300_000) };
    expect(body.text.length).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(invalid(encodeDeliverBody(body))).toBeInstanceOf(TalkMessageTooLarge);
  });

  it("counts the attachments in the whole message", () => {
    const body: DeliverBody = {
      ...send,
      text: "short",
      attachments: [{ type: "file", name: "big", content: "x".repeat(MAX_MESSAGE_BYTES) }],
    };
    expect(invalid(encodeDeliverBody(body))).toBeInstanceOf(TalkMessageTooLarge);
  });

  it("applies the limit to a reply", () => {
    const body: ReplyBody = { ...reply, text: "r".repeat(MAX_MESSAGE_BYTES) };
    expect(invalid(encodeReplyBody(body))).toBeInstanceOf(TalkMessageTooLarge);
  });

  it("refuses an oversized message at the receiver too", () => {
    const body = sendOfSize(MAX_MESSAGE_BYTES + 1);
    expect(invalid(decodeDeliverBody(overTheWire(body)))).toBeInstanceOf(TalkMessageTooLarge);
    const replyBody = { ...reply, text: "r".repeat(MAX_MESSAGE_BYTES) };
    expect(invalid(decodeReplyBody(overTheWire(replyBody)))).toBeInstanceOf(TalkMessageTooLarge);
  });
});
