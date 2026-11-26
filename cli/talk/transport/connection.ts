/**
 * One framed connection of the talk transport over a `node:net` socket
 * (#249 E8 Frames). Reads give one decoded frame value at a time, in order;
 * a frame above 1 MiB fails the read, and the caller closes the connection.
 */
import type { Socket } from "node:net";

import { Cause, Effect, Queue, Schema } from "effect";

import { type FrameError, encodeFrame, makeFrameDecoder } from "./frame";

// A connection that ends gracefully gets this long to flush its last frame before it is destroyed.
const FINISH_GRACE_MS = 1_000;

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
}

/** Wraps a connected socket. */
export const makeConnection = Effect.fnUntraced(function* (socket: Socket) {
  const chunks = yield* Queue.unbounded<Uint8Array, TalkConnectionClosed>();
  const decoder = makeFrameDecoder();
  const ready: Array<unknown> = [];
  const closed = (reason: string): void => {
    Queue.failCauseUnsafe(chunks, Cause.fail(new TalkConnectionClosed({ reason })));
  };
  socket.on("data", (chunk: Uint8Array) => {
    Queue.offerUnsafe(chunks, chunk);
  });
  socket.on("error", (error) => closed(error.message));
  socket.on("end", () => closed("the peer ended the connection"));
  socket.on("close", () => closed("the connection closed"));

  const read = Effect.gen(function* () {
    while (ready.length === 0) {
      const chunk = yield* Queue.take(chunks);
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
  };
  return connection;
});
