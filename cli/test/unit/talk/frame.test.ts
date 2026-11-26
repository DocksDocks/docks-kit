import { Effect, Exit, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type FrameError,
  MAX_FRAME_BYTES,
  encodeFrame,
  makeFrameDecoder,
} from "../../../talk/transport/frame";

// Frame codec of #249 E8: a 4-byte big-endian length, then UTF-8 JSON, with a 1 MiB cap.
const NUM_RUNS = 500;
const PROPERTY_TIMEOUT_MS = 60_000;

const encode = (value: Parameters<typeof encodeFrame>[0]): Uint8Array =>
  Effect.runSync(encodeFrame(value));

const header = (length: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length);
  return bytes;
};

const rawFrame = (body: Uint8Array): Uint8Array => {
  const bytes = new Uint8Array(4 + body.byteLength);
  bytes.set(header(body.byteLength));
  bytes.set(body, 4);
  return bytes;
};

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const failure = (exit: Exit.Exit<unknown, FrameError>): FrameError => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  if (error === undefined) throw new Error("expected a typed failure");
  return error.error;
};

describe("encodeFrame", () => {
  it("writes the UTF-8 byte length as a big-endian 32-bit prefix", () => {
    const bytes = encode("h\u00e9");
    // JSON `"hé"` is 5 bytes in UTF-8.
    expect([...bytes]).toEqual([0, 0, 0, 5, 0x22, 0x68, 0xc3, 0xa9, 0x22]);
  });

  it("accepts a body of exactly the cap", () => {
    // Two quotes plus the string make MAX_FRAME_BYTES bytes of JSON.
    const value = "a".repeat(MAX_FRAME_BYTES - 2);
    const bytes = encode(value);
    expect(bytes.byteLength).toBe(4 + MAX_FRAME_BYTES);
    const decoder = makeFrameDecoder();
    expect(Effect.runSync(decoder.push(bytes))).toEqual([value]);
  });

  it("rejects a body above the cap", () => {
    const error = failure(Effect.runSyncExit(encodeFrame("a".repeat(MAX_FRAME_BYTES - 1))));
    expect(error._tag).toBe("FrameError");
    expect(error.reason).toBe("oversize");
  });
});

describe("makeFrameDecoder", () => {
  it(
    "returns the encoded values over random chunk boundaries",
    () => {
      fc.assert(
        fc.property(
          fc.array(fc.jsonValue().map(Schema.decodeUnknownSync(Schema.Json)), { maxLength: 8 }),
          fc.array(fc.nat(), { maxLength: 16 }),
          (values, cuts) => {
            const stream = concat(values.map((value) => encode(value)));
            const points = [
              ...new Set(
                cuts.map((cut) => (stream.byteLength === 0 ? 0 : cut % stream.byteLength)),
              ),
            ].sort((a, b) => a - b);
            const bounds = [0, ...points, stream.byteLength];
            const decoder = makeFrameDecoder();
            const decoded: Array<unknown> = [];
            for (let index = 1; index < bounds.length; index += 1) {
              const chunk = stream.subarray(bounds[index - 1], bounds[index]);
              decoded.push(...Effect.runSync(decoder.push(chunk)));
            }
            expect(decoded).toEqual(values.map((value) => JSON.parse(JSON.stringify(value))));
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("returns several frames from one chunk in order", () => {
    const decoder = makeFrameDecoder();
    const chunk = concat([encode(1), encode({ a: [true, null] }), encode("x")]);
    expect(Effect.runSync(decoder.push(chunk))).toEqual([1, { a: [true, null] }, "x"]);
  });

  it("keeps a partial frame until the rest arrives", () => {
    const decoder = makeFrameDecoder();
    const bytes = encode({ k: "v" });
    expect(Effect.runSync(decoder.push(bytes.subarray(0, 2)))).toEqual([]);
    expect(Effect.runSync(decoder.push(bytes.subarray(2, 7)))).toEqual([]);
    expect(Effect.runSync(decoder.push(bytes.subarray(7)))).toEqual([{ k: "v" }]);
  });

  it("rejects a declared length above the cap from the header alone", () => {
    const decoder = makeFrameDecoder();
    const error = failure(Effect.runSyncExit(decoder.push(header(MAX_FRAME_BYTES + 1))));
    expect(error.reason).toBe("oversize");
  });

  it("rejects an oversize header that arrives in two chunks", () => {
    const decoder = makeFrameDecoder();
    const bytes = header(0xffff_ffff);
    expect(Effect.runSync(decoder.push(bytes.subarray(0, 2)))).toEqual([]);
    expect(failure(Effect.runSyncExit(decoder.push(bytes.subarray(2)))).reason).toBe("oversize");
  });

  it("waits for the body of a declared length at the cap", () => {
    const decoder = makeFrameDecoder();
    expect(Effect.runSync(decoder.push(header(MAX_FRAME_BYTES)))).toEqual([]);
  });

  it("rejects malformed JSON", () => {
    const decoder = makeFrameDecoder();
    const error = failure(
      Effect.runSyncExit(decoder.push(rawFrame(new TextEncoder().encode("{bad")))),
    );
    expect(error.reason).toBe("json");
  });

  it("rejects an empty body", () => {
    const decoder = makeFrameDecoder();
    expect(failure(Effect.runSyncExit(decoder.push(header(0)))).reason).toBe("json");
  });

  it("rejects invalid UTF-8", () => {
    const decoder = makeFrameDecoder();
    const error = failure(
      Effect.runSyncExit(decoder.push(rawFrame(Uint8Array.of(0x22, 0xff, 0x22)))),
    );
    expect(error.reason).toBe("utf8");
  });

  it("stays failed after an error", () => {
    const decoder = makeFrameDecoder();
    failure(Effect.runSyncExit(decoder.push(rawFrame(new TextEncoder().encode("{bad")))));
    expect(failure(Effect.runSyncExit(decoder.push(encode(1)))).reason).toBe("json");
  });
});
