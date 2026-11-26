/**
 * Frame codec of the talk transport (#249 E8, #248 D2 Frames). A frame is a 4-byte big-endian body length, then the
 * body: one JSON value in UTF-8. The decoder rejects a declared length above `MAX_FRAME_BYTES` as soon as it reads
 * the length, before it buffers the body.
 */
import { Effect, Schema } from "effect";

/** The largest body length that a frame can declare: 1 MiB. */
export const MAX_FRAME_BYTES = 1_048_576;

const HEADER_BYTES = 4;

/** A frame that the codec cannot write or read. The connection that carries it closes. */
export class FrameError extends Schema.TaggedError<FrameError, { readonly brand: unique symbol }>()(
  "FrameError",
  {
    reason: Schema.Literals(["oversize", "utf8", "json"]),
    message: Schema.String,
  },
) {}

const JsonText = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeUnknownEffect(JsonText);
const decodeJson = Schema.decodeUnknownEffect(JsonText);
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const oversize = (length: number): FrameError =>
  new FrameError({
    reason: "oversize",
    message: `Frame length ${length} is above the limit of ${MAX_FRAME_BYTES} bytes.`,
  });

/** Write one JSON value as a frame. Fails when the JSON body is above `MAX_FRAME_BYTES`. */
export const encodeFrame = Effect.fnUntraced(function* (value: Schema.Json) {
  const text = yield* encodeJson(value).pipe(
    Effect.mapError(
      (issue) =>
        new FrameError({ reason: "json", message: `Value is not valid JSON: ${issue.message}` }),
    ),
  );
  const body = utf8Encoder.encode(text);
  if (body.byteLength > MAX_FRAME_BYTES) return yield* oversize(body.byteLength);
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, HEADER_BYTES);
  return frame;
});

const decodeBody = Effect.fnUntraced(function* (body: Uint8Array) {
  const text = yield* Effect.try({
    try: () => utf8Decoder.decode(body),
    catch: () => new FrameError({ reason: "utf8", message: "Frame body is not valid UTF-8." }),
  });
  return yield* decodeJson(text).pipe(
    Effect.mapError(
      (issue) =>
        new FrameError({
          reason: "json",
          message: `Frame body is not valid JSON: ${issue.message}`,
        }),
    ),
  );
});

/** Incremental frame reader for one connection. */
export interface FrameDecoder {
  /**
   * Add the next chunk, at any byte boundary. Gives the values of the frames that the chunk completes, in order.
   * After a failure, each later push fails with the same error.
   */
  readonly push: (chunk: Uint8Array) => Effect.Effect<ReadonlyArray<unknown>, FrameError>;
}

/** Make a frame reader with an empty buffer. */
export const makeFrameDecoder = (): FrameDecoder => {
  const header = new Uint8Array(HEADER_BYTES);
  const headerView = new DataView(header.buffer);
  let headerFill = 0;
  // The body of a frame that spans chunks; a body inside one chunk is read in place.
  let pending: Uint8Array | undefined;
  let pendingFill = 0;
  let failure: FrameError | undefined;

  const read = Effect.fnUntraced(function* (chunk: Uint8Array) {
    const values: Array<unknown> = [];
    const end = chunk.byteLength;
    let offset = 0;
    for (;;) {
      if (pending !== undefined) {
        if (offset === end) break;
        const count = Math.min(pending.byteLength - pendingFill, end - offset);
        pending.set(chunk.subarray(offset, offset + count), pendingFill);
        pendingFill += count;
        offset += count;
        if (pendingFill < pending.byteLength) break;
        const body = pending;
        pending = undefined;
        values.push(yield* decodeBody(body));
        continue;
      }
      if (offset === end) break;
      const count = Math.min(HEADER_BYTES - headerFill, end - offset);
      header.set(chunk.subarray(offset, offset + count), headerFill);
      headerFill += count;
      offset += count;
      if (headerFill < HEADER_BYTES) break;
      headerFill = 0;
      const length = headerView.getUint32(0);
      if (length > MAX_FRAME_BYTES) return yield* oversize(length);
      if (end - offset >= length) {
        values.push(yield* decodeBody(chunk.subarray(offset, offset + length)));
        offset += length;
        continue;
      }
      pending = new Uint8Array(length);
      pendingFill = 0;
    }
    return values;
  });

  return {
    push: (chunk) =>
      Effect.suspend(() =>
        failure === undefined
          ? read(chunk).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  failure = error;
                }),
              ),
            )
          : Effect.fail(failure),
      ),
  };
};
