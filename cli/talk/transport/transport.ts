/**
 * The talk transport as one service (#248 D1, D2, D16; #249 E7, E8; #250
 * Step 2): the process listener (`listener.ts`), the client (`client.ts`),
 * and the registry of this system (`registry.ts`).
 */
import { Context, Effect, Layer } from "effect";

import { type Client, type PeerListing, type TalkListError, makeClient } from "./client";
import { resolveRegistryFolder } from "./folder";
import {
  type AdmissionCheck,
  type ListenerStatus,
  type Registration,
  type RegistrationInput,
  type RegistrationUpdate,
  type TalkRegisterError,
  type TalkUpdateError,
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
  /**
   * The admission hook (#250 E7), asked in the tick that the listener admits a
   * request for a registration, `ping` included. A refusal answers `not-live`
   * and withdraws the registration. Default: every request is admitted.
   */
  readonly admit?: AdmissionCheck | undefined;
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
    /**
     * Registers a session under a new random instance id; the first registration opens the
     * listener of the process.
     */
    readonly register: (input: RegistrationInput) => Effect.Effect<Registration, TalkRegisterError>;
    /** Publishes a live registration again with a new name and folder, under the same identity. */
    readonly update: (
      registration: Target,
      input: RegistrationUpdate,
    ) => Effect.Effect<void, TalkUpdateError>;
    /** Ends a registration; its ids and secret stay known until the process ends. */
    readonly withdraw: (registration: Target) => Effect.Effect<void>;
    /** Sets the handler of a request kind for every registration of the process. */
    readonly handle: (kind: string, handler: RequestHandler) => Effect.Effect<void>;
    /** Lists the registrations in the folder, prunes dead ones, and keeps the listed entries. */
    readonly list: Effect.Effect<PeerListing, TalkListError>;
    readonly request: Client["request"];
    readonly probe: (target: Target) => Effect.Effect<void, TalkRequestFailed>;
    /** Reads the entry of the pair now and keeps it like a listed entry; `not-found` without one. */
    readonly retain: Client["retain"];
    /** The pair of an entry that this process kept, by its full instance id. */
    readonly known: Client["known"];
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
    admit: options.admit,
  });
  const client = yield* makeClient({
    requestTimeoutMs: options.requestTimeoutMs ?? TRANSPORT_DEFAULTS.requestTimeoutMs,
    probeTimeoutMs: options.probeTimeoutMs ?? TRANSPORT_DEFAULTS.probeTimeoutMs,
  });
  return TalkTransport.of({
    folder: registry.folder,
    register: listener.register,
    update: listener.update,
    withdraw: listener.withdraw,
    handle: listener.handle,
    list: client.list,
    request: client.request,
    probe: client.probe,
    retain: client.retain,
    known: client.known,
    status: Effect.map(listener.status, (status) => ({ ...status, folder: registry.folder })),
  });
});
