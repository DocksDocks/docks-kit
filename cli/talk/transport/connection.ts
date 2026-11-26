/**
 * One framed connection of the talk transport over a `node:net` socket
 * (#249 E8 Frames). Reads give one decoded frame value at a time, in order;
 * a frame above 1 MiB fails the read, and the caller closes the connection.
 * Unread input is bounded: the socket pauses while more than
 * `MAX_BUFFERED_BYTES` wait, also before authentication.
 */
import type { Socket } from "node:net";

import { Cause, Effect, Queue, Schema } from "effect";

import {
  FRAME_HEADER_BYTES,
  type FrameError,
  MAX_FRAME_BYTES,
  encodeFrame,
  makeFrameDecoder,
} from "./frame";

// A connection that ends gracefully gets this long to flush its last frame before it is destroyed.
const FINISH_GRACE_MS = 1_000;

/** The most unread input bytes that a connection buffers before it pauses the socket: one maximum frame. */
export const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + FRAME_HEADER_BYTES;

/** The connection closed, or the socket failed. */
export class TalkConnectionClosed extends Schema.TaggedError<
  TalkConnectionClosed,
  { readonly brand: unique symbol }
>()("TalkConnectionClosed", {
  reason: Schema.String,
}) {}

export interface Connection {
  /** The next frame value. */
  readonly read: Effect.Effect<unknown, TalkConnectionClosed | FrameError>;
  readonly write: (value: Schema.Json) => Effect.Effect<void, TalkConnectionClosed | FrameError>;
  /** Ends the connection after the written frames, then destroys it. */
  readonly finish: Effect.Effect<void>;
  /** Destroys the connection at once. */
  readonly close: Effect.Effect<void>;
  /** The unread input bytes that wait in the buffer. */
  readonly bufferedBytes: () => number;
}

/** Wraps a connected socket. */
export const makeConnection = Effect.fnUntraced(function* (socket: Socket) {
  const chunks = yield* Queue.unbounded<Uint8Array, TalkConnectionClosed>();
  const decoder = makeFrameDecoder();
  const ready: Array<unknown> = [];
  let buffered = 0;
  let paused = false;
  const closed = (reason: string): void => {
    Queue.failCauseUnsafe(chunks, Cause.fail(new TalkConnectionClosed({ reason })));
  };
  socket.on("data", (chunk: Uint8Array) => {
    buffered += chunk.byteLength;
    Queue.offerUnsafe(chunks, chunk);
    if (!paused && buffered > MAX_BUFFERED_BYTES) {
      paused = true;
      socket.pause();
    }
  });
  socket.on("error", (error) => closed(error.message));
  socket.on("end", () => closed("the peer ended the connection"));
  socket.on("close", () => closed("the connection closed"));

  const read = Effect.gen(function* () {
    while (ready.length === 0) {
      const chunk = yield* Queue.take(chunks);
      buffered -= chunk.byteLength;
      if (paused && buffered <= MAX_BUFFERED_BYTES) {
        paused = false;
        socket.resume();
      }
      ready.push(...(yield* decoder.push(chunk)));
    }
    return ready.shift();
  });

  const write = Effect.fnUntraced(function* (value: Schema.Json) {
    const frame = yield* encodeFrame(value);
    if (socket.destroyed || !socket.writable) {
      return yield* new TalkConnectionClosed({ reason: "the connection is closed" });
    }
    socket.write(frame);
  });

  const connection: Connection = {
    read,
    write,
    finish: Effect.sync(() => {
      socket.end();
      setTimeout(() => socket.destroy(), FINISH_GRACE_MS).unref();
    }),
    close: Effect.sync(() => {
      socket.destroy();
    }),
    bufferedBytes: () => buffered,
  };
  return connection;
});
