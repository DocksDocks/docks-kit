/**
 * The talk transport as one service (#248 D1, D2, D16; #249 E7, E8): the
 * process listener (`listener.ts`), the client (`client.ts`), and the registry
 * of this system (`registry.ts`).
 */
import { Context, Effect, Layer } from "effect";

import { type Client, type PeerListing, type TalkListError, makeClient } from "./client";
import { resolveRegistryFolder } from "./folder";
import {
  type ListenerStatus,
  type Registration,
  type RegistrationInput,
  type TalkRegisterError,
  makeListener,
} from "./listener";
import { TalkRegistry } from "./registry";
import type { RequestHandler, Target, TalkRequestFailed } from "./request";

/** The settings of the transport; each one has a default. */
export interface TalkTransportOptions {
  /** The registry folder. Default: `DOCKS_KIT_TALK_DIR`, else the folder of the system (E4). */
  readonly folder?: string | undefined;
  /** Default 60 s. */
  readonly repairIntervalMs?: number | undefined;
  /** POSIX entry time refresh. Default 6 hours. */
  readonly refreshIntervalMs?: number | undefined;
  /** Default 5 s. */
  readonly requestTimeoutMs?: number | undefined;
  /** Default 500 ms. */
  readonly probeTimeoutMs?: number | undefined;
  /** Default 1 s from accept. */
  readonly handshakeTimeoutMs?: number | undefined;
  /** Default 32. */
  readonly maxUnauthenticated?: number | undefined;
}

export const TRANSPORT_DEFAULTS = {
  repairIntervalMs: 60_000,
  refreshIntervalMs: 6 * 60 * 60 * 1_000,
  requestTimeoutMs: 5_000,
  probeTimeoutMs: 500,
  handshakeTimeoutMs: 1_000,
  maxUnauthenticated: 32,
} as const;

export interface TransportStatus extends ListenerStatus {
  readonly folder: string;
}

export class TalkTransport extends Context.Service<
  TalkTransport,
  {
    readonly folder: string;
    /** The instance id of this process; each registration of the process has it. */
    readonly instanceId: string;
    /** Registers a session; the first registration opens the listener of the process. */
    readonly register: (input: RegistrationInput) => Effect.Effect<Registration, TalkRegisterError>;
    /** Ends a registration; its id and secret stay known until the process ends. */
    readonly withdraw: (sessionId: string) => Effect.Effect<void>;
    /** Sets the handler of a request kind for every registration of the process. */
    readonly handle: (kind: string, handler: RequestHandler) => Effect.Effect<void>;
    /** Lists the registrations in the folder, prunes dead ones, and keeps the listed entries. */
    readonly list: Effect.Effect<PeerListing, TalkListError>;
    readonly request: Client["request"];
    readonly probe: (target: Target) => Effect.Effect<void, TalkRequestFailed>;
    readonly status: Effect.Effect<TransportStatus>;
  }
>()("docks-kit/talk/TalkTransport") {
  /** The transport with its registry folder and the live system services. */
  static readonly layer = (options: TalkTransportOptions = {}) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const folder = options.folder ?? (yield* resolveRegistryFolder());
        return Layer.effect(TalkTransport, makeTransport(options)).pipe(
          Layer.provide(TalkRegistry.layer(folder)),
        );
      }),
    );
}

const makeTransport = Effect.fnUntraced(function* (options: TalkTransportOptions) {
  const registry = yield* TalkRegistry;
  const listener = yield* makeListener({
    platform: process.platform,
    repairIntervalMs: options.repairIntervalMs ?? TRANSPORT_DEFAULTS.repairIntervalMs,
    refreshIntervalMs: options.refreshIntervalMs ?? TRANSPORT_DEFAULTS.refreshIntervalMs,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? TRANSPORT_DEFAULTS.handshakeTimeoutMs,
    maxUnauthenticated: options.maxUnauthenticated ?? TRANSPORT_DEFAULTS.maxUnauthenticated,
  });
  const client = yield* makeClient({
    requestTimeoutMs: options.requestTimeoutMs ?? TRANSPORT_DEFAULTS.requestTimeoutMs,
    probeTimeoutMs: options.probeTimeoutMs ?? TRANSPORT_DEFAULTS.probeTimeoutMs,
  });
  return TalkTransport.of({
    folder: registry.folder,
    instanceId: listener.instanceId,
    register: listener.register,
    withdraw: listener.withdraw,
    handle: listener.handle,
    list: client.list,
    request: client.request,
    probe: client.probe,
    status: Effect.map(listener.status, (status) => ({ ...status, folder: registry.folder })),
  });
});
