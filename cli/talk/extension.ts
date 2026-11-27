/**
 * The omp extension factory of `talk` (#250 E3, E7, E10 to E12).
 *
 * omp binds the factory once for each session of a module evaluation: the
 * main session and each subagent session. One process can evaluate the module
 * several times (F16), so the transport runtime, the registration dispatch,
 * the ask waiters, and the agent map live in one process singleton under
 * `globalThis[Symbol.for("docks-kit.talk")]` as a plain facade (E12). Each
 * binding of a main session owns at most one registration (E7).
 *
 * This is the only file of `cli/talk/` that runs effects (`cli/AGENTS.md`).
 */
import { randomBytes } from "node:crypto";
import { isMainThread } from "node:worker_threads";

import { Effect, ManagedRuntime, Option, Predicate, Result, Schema } from "effect";

import { version as packageVersion } from "../../package.json" with { type: "json" };
import { type AgentRef, type AskStore, type LiveRegistration, makeAskStore } from "./tool/asks";
import { type TalkDelivery, makeDelivery, talkRequestHandlers } from "./tool/delivery";
import {
  type SendOptions,
  type SessionMode,
  type TalkClock,
  type TalkHost,
  type TalkMessage,
  type TransitionKind,
  systemClock,
} from "./tool/host";
import { type ProbeResult, sessionName } from "./tool/targets";
import {
  type ListAnswer,
  type PeerTransport,
  type RequestAnswer,
  TALK_TOOL_DESCRIPTION,
  TALK_TOOL_LABEL,
  TALK_TOOL_NAME,
  TYPE_BUILDER_MEMBERS,
  type TalkSelf,
  type TypeBuilder,
  runTalkTool,
  talkParameters,
} from "./tool/tool";
import type { AdmissionCheck, RegistrationInput, RegistrationUpdate } from "./transport/listener";
import type { RequestHandler, Target } from "./transport/request";
import { TalkTransport, type TalkTransportOptions } from "./transport/transport";

/** The version of the singleton facade and of the request bodies. A change needs a new number. */
export const TALK_PROTOCOL_VERSION = 1;
/** The docks-kit version that built this module. */
export const TALK_PACKAGE_VERSION: string = packageVersion;
/** The process singleton of E12. */
export const TALK_SINGLETON_KEY = Symbol.for("docks-kit.talk");
/** Set once the version notice of E12 was written, so the process shows it once. */
const VERSION_NOTICE_KEY = Symbol.for("docks-kit.talk.version-notice");

/** The hidden marker tool of E3: a fixed name and definition. */
export const MARKER_TOOL_NAME = "talk_active";
const MARKER_TOOL_LABEL = "Talk marker";
const MARKER_TOOL_DESCRIPTION =
  "Internal marker of the talk extension. It does nothing; do not call it.";
const MARKER_ANSWER = "talk_active is internal to the talk extension. It does nothing.";

/** The period of the repair timer of each binding (E7). */
export const REPAIR_INTERVAL_MS = 1_000;
/** The period of the process sweep (E7, E12). */
export const SWEEP_INTERVAL_MS = 1_000;
/** The omp version that the capability notice names (E11). */
export const OMP_VERSION_NEEDED = "19.2.0";

/**
 * omp shows `<source:name>` as the source path of a tool row whose extension
 * runner does not resolve it, for example a suspended extension (F18).
 */
const PLACEHOLDER_PATH = /^<[^>]*>$/u;

// ── Transport facade (E12) ──

export type RegisterAnswer =
  | { readonly _tag: "Registered"; readonly registration: Target }
  | { readonly _tag: "RegisterFailed"; readonly reason: string };

/**
 * The transport of the process as plain functions that return promises,
 * without Effect service tags, which differ per module evaluation (E12).
 */
export interface TransportFacade extends PeerTransport {
  readonly register: (input: RegistrationInput) => Promise<RegisterAnswer>;
  /** True when the registration was published again with the new name and folder. */
  readonly update: (registration: Target, input: RegistrationUpdate) => Promise<boolean>;
  readonly withdraw: (registration: Target) => Promise<void>;
  /** The `retain` of E6: true when the route of the pair is kept. */
  readonly retain: (pair: Target) => Promise<boolean>;
}

/** What the process singleton gives the transport that it builds. */
export interface TransportHooks {
  readonly admit: AdmissionCheck;
  readonly handlers: ReadonlyArray<readonly [kind: string, handler: RequestHandler]>;
}

export interface TalkTransportRuntime {
  readonly facade: TransportFacade;
  /** Ends the runtime. The extension never calls it: the runtime stays until the process exits (E12). */
  readonly dispose: () => Promise<void>;
}

/**
 * The transport of E12: one `ManagedRuntime` of `TalkTransport.layer` with
 * the admission hook, and the request handlers that it installs before the
 * first call.
 */
export const makeTalkTransport = (
  hooks: TransportHooks,
  options: Omit<TalkTransportOptions, "admit"> = {},
): TalkTransportRuntime => {
  const runtime = ManagedRuntime.make(TalkTransport.layer({ ...options, admit: hooks.admit }));
  const install = TalkTransport.use((transport) =>
    Effect.forEach(hooks.handlers, ([kind, handler]) => transport.handle(kind, handler), {
      discard: true,
    }),
  );
  let installed: Promise<void> | undefined;
  const run = async <A>(effect: Effect.Effect<A, never, TalkTransport>): Promise<A> => {
    installed ??= runtime.runPromise(install).catch((error: unknown) => {
      installed = undefined;
      throw error;
    });
    await installed;
    return runtime.runPromise(effect);
  };
  const facade: TransportFacade = {
    register: (input) =>
      run(
        TalkTransport.use((transport) => transport.register(input)).pipe(
          Effect.map((registration): RegisterAnswer => ({
            _tag: "Registered",
            registration: {
              instanceId: registration.instanceId,
              sessionId: registration.sessionId,
            },
          })),
          Effect.catch((error) =>
            Effect.succeed<RegisterAnswer>({ _tag: "RegisterFailed", reason: error.reason }),
          ),
        ),
      ),
    update: (registration, input) =>
      run(
        TalkTransport.use((transport) => transport.update(registration, input)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      ),
    withdraw: (registration) =>
      run(TalkTransport.use((transport) => transport.withdraw(registration))),
    retain: (pair) =>
      run(
        TalkTransport.use((transport) => transport.retain(pair)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
      ),
    known: (instanceId) =>
      run(
        TalkTransport.use((transport) => transport.known(instanceId)).pipe(
          Effect.map(Option.getOrUndefined),
        ),
      ),
    list: () =>
      run(
        TalkTransport.use((transport) => transport.list).pipe(
          Effect.map((listing): ListAnswer => ({
            _tag: "Listed",
            peers: listing.peers.map(({ instanceId, sessionId, name, cwd }) => ({
              instanceId,
              sessionId,
              name,
              cwd,
            })),
          })),
          Effect.catch((error) =>
            Effect.succeed<ListAnswer>({ _tag: "ListFailed", reason: error.reason }),
          ),
        ),
      ),
    probeAll: (targets) =>
      run(
        TalkTransport.use((transport) => transport.probeAll(targets)).pipe(
          Effect.map((results) =>
            results.map((result): ProbeResult =>
              Result.isSuccess(result) ? "ok" : result.failure.outcome,
            ),
          ),
        ),
      ),
    request: (target, kind, body) =>
      run(
        TalkTransport.use((transport) => transport.request(target, kind, body)).pipe(
          Effect.map((answer): RequestAnswer => ({ _tag: "Answered", body: answer })),
          Effect.catch((error) =>
            Effect.succeed<RequestAnswer>({
              _tag: "Failed",
              outcome: error.outcome,
              reason: error.reason,
            }),
          ),
        ),
      ),
  };
  return { facade, dispose: () => runtime.dispose() };
};

// ── Process singleton (E12) ──

/** A registration and the binding that owns it (E7). */
interface RegistrationOwner {
  readonly registration: Target;
  readonly receiver: TalkDelivery;
  /** The activity check of E3; a throw counts as inactive. */
  readonly isActive: () => boolean;
  /** The admission rule of E7, in the tick of the request. */
  readonly admit: () => boolean;
  /** The process ended the registration: a refused admission or the sweep. */
  readonly ended: () => void;
}

/**
 * A registration that a binding starts and that the listener can see before
 * it is claimed (T2): the binding chose its instance id, so the record names
 * the exact pair before the entry is published.
 */
interface StartingRegistration {
  readonly registration: Target;
  readonly isActive: () => boolean;
}

interface RegistrationDispatch {
  readonly claim: (owner: RegistrationOwner) => void;
  readonly release: (registration: Target) => void;
  /** Marks a registration as starting; the returned function ends the mark. */
  readonly starting: (registration: StartingRegistration) => () => void;
}

/** The plain facade under `TALK_SINGLETON_KEY`, shared by each module evaluation of the same versions. */
export interface TalkProcess {
  readonly protocolVersion: number;
  readonly packageVersion: string;
  readonly transport: TransportFacade;
  readonly asks: AskStore;
  readonly registrations: RegistrationDispatch;
}

/** A check that throws counts as false (E3, E7). */
const holds = (check: () => boolean): boolean => {
  try {
    return check();
  } catch {
    return false;
  }
};

const causeText = (cause: unknown): string =>
  Predicate.isError(cause) ? cause.message : String(cause);

interface ProcessOptions {
  readonly makeTransport: (hooks: TransportHooks) => TransportFacade;
  readonly clock: TalkClock;
  readonly report: (error: unknown) => void;
}

const createProcess = ({ makeTransport, clock, report }: ProcessOptions): TalkProcess => {
  const owners = new Map<string, RegistrationOwner>();
  const starting = new Set<StartingRegistration>();
  const asks = makeAskStore(clock);

  const ownerOf = (registration: Target): RegistrationOwner | undefined => {
    const owner = owners.get(registration.instanceId);
    return owner?.registration.sessionId === registration.sessionId ? owner : undefined;
  };

  const end = (owner: RegistrationOwner): void => {
    if (owners.get(owner.registration.instanceId) === owner)
      owners.delete(owner.registration.instanceId);
    owner.ended();
  };

  /** E7: the listener asks this hook in the tick that it admits a request, `ping` included. */
  const admit: AdmissionCheck = (registration) => {
    const owner = ownerOf(registration);
    // An unowned pair is admitted only while its own binding starts it.
    if (owner === undefined)
      return [...starting].some(
        (pending) => sameTarget(pending.registration, registration) && holds(pending.isActive),
      );
    if (holds(owner.admit)) return true;
    end(owner);
    return false;
  };

  const transport = makeTransport({
    admit,
    handlers: talkRequestHandlers({
      receiverFor: (registration) => ownerOf(registration)?.receiver,
      asks,
    }),
  });

  // E7, E12: the sweep withdraws each registration whose binding fails its
  // activity check, also when that binding no longer runs. A throw from a raw
  // timer ends the omp session, so the callback catches every error.
  const sweep = setInterval(() => {
    try {
      for (const owner of [...owners.values()]) {
        if (holds(owner.isActive)) continue;
        end(owner);
        transport.withdraw(owner.registration).catch(report);
      }
    } catch (error) {
      report(error);
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  return {
    protocolVersion: TALK_PROTOCOL_VERSION,
    packageVersion: TALK_PACKAGE_VERSION,
    transport,
    asks,
    registrations: {
      claim: (owner) => {
        owners.set(owner.registration.instanceId, owner);
      },
      release: (registration) => {
        if (ownerOf(registration) !== undefined) owners.delete(registration.instanceId);
      },
      starting: (registration) => {
        starting.add(registration);
        return () => {
          starting.delete(registration);
        };
      },
    },
  };
};

/** Another evaluation stores a facade of its own versions; only equal versions share it (E12). */
const sameVersions = (value: unknown): value is TalkProcess =>
  Predicate.hasProperty(value, "protocolVersion") &&
  value.protocolVersion === TALK_PROTOCOL_VERSION &&
  Predicate.hasProperty(value, "packageVersion") &&
  value.packageVersion === TALK_PACKAGE_VERSION;

/** The process singleton; undefined when another version holds it. */
const processSingleton = (options: ProcessOptions): TalkProcess | undefined => {
  const existing: unknown = Reflect.get(globalThis, TALK_SINGLETON_KEY);
  if (existing === undefined) {
    const created = createProcess(options);
    Reflect.set(globalThis, TALK_SINGLETON_KEY, created);
    return created;
  }
  return sameVersions(existing) ? existing : undefined;
};

// ── omp API access (E11) ──

type Method = (...args: ReadonlyArray<unknown>) => unknown;

/** A method of an omp object, bound to it; undefined when the member is no function. */
const method = (owner: unknown, key: string): Method | undefined => {
  if (!Predicate.hasProperty(owner, key)) return undefined;
  const found = owner[key];
  return Predicate.isFunction(found)
    ? (...args: ReadonlyArray<unknown>): unknown => Reflect.apply(found, owner, args)
    : undefined;
};

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** The parts of `pi` that talk uses, after the capability probe. */
interface PiApi {
  readonly registerTool: (definition: object) => void;
  readonly sendMessage: (message: TalkMessage, options: SendOptions) => void;
  readonly on: (event: string, handler: EventHandler) => void;
  readonly getAllTools: () => unknown;
  readonly getSessionName: () => string | undefined;
  readonly Type: TypeBuilder;
}

type ApiProbe =
  | { readonly _tag: "Ready"; readonly api: PiApi }
  | {
      readonly _tag: "Missing";
      readonly missing: ReadonlyArray<string>;
      readonly on: PiApi["on"] | undefined;
    };

/**
 * E11: checks by type each `pi` member that talk calls. The plan names
 * `pi.typebox.Type.Object`; the probe also checks the other builders that the
 * tool parameters call, so a missing one gives the notice instead of a throw.
 */
const probeApi = (pi: unknown): ApiProbe => {
  const registerTool = method(pi, "registerTool");
  const sendMessage = method(pi, "sendMessage");
  const on = method(pi, "on");
  const getAllTools = method(pi, "getAllTools");
  const getSessionName = method(pi, "getSessionName");
  const typebox = Predicate.hasProperty(pi, "typebox") ? pi.typebox : undefined;
  const type = Predicate.hasProperty(typebox, "Type") ? typebox.Type : undefined;
  const builders = new Map(TYPE_BUILDER_MEMBERS.map((name) => [name, method(type, name)]));
  const onHandler =
    on === undefined
      ? undefined
      : (event: string, handler: EventHandler): void => {
          on(event, handler);
        };
  const missing = [
    ...(registerTool === undefined ? ["pi.registerTool"] : []),
    ...(sendMessage === undefined ? ["pi.sendMessage"] : []),
    ...(on === undefined ? ["pi.on"] : []),
    ...(getAllTools === undefined ? ["pi.getAllTools"] : []),
    ...(getSessionName === undefined ? ["pi.getSessionName"] : []),
    ...TYPE_BUILDER_MEMBERS.filter((name) => builders.get(name) === undefined).map(
      (name) => `pi.typebox.Type.${name}`,
    ),
  ];
  const build = (name: (typeof TYPE_BUILDER_MEMBERS)[number]): Method => {
    const builder = builders.get(name);
    if (builder === undefined) throw new Error(`talk: pi.typebox.Type.${name} is missing.`);
    return builder;
  };
  if (
    missing.length > 0 ||
    registerTool === undefined ||
    sendMessage === undefined ||
    onHandler === undefined ||
    getAllTools === undefined ||
    getSessionName === undefined
  )
    return { _tag: "Missing", missing, on: onHandler };
  const Type: TypeBuilder = {
    Object: build("Object"),
    String: build("String"),
    Boolean: build("Boolean"),
    Literal: build("Literal"),
    Union: build("Union"),
    Array: build("Array"),
    Optional: build("Optional"),
  };
  return {
    _tag: "Ready",
    api: {
      registerTool: (definition) => {
        registerTool(definition);
      },
      sendMessage: (message, options) => {
        sendMessage(message, options);
      },
      on: onHandler,
      getAllTools: () => getAllTools(),
      getSessionName: () => {
        const name = getSessionName();
        return Predicate.isString(name) ? name : undefined;
      },
      Type,
    },
  };
};

const capabilityNotice = (missing: ReadonlyArray<string>): string =>
  `talk: this omp has no ${missing.join(", ")}. talk needs omp ${OMP_VERSION_NEEDED} or later, so the talk tool is off.`;

const VERSION_NOTICE =
  "talk: another version of talk runs in this omp process, so this one is off until omp restarts.";

/** `ctx.ui.notify` in a session with a UI, else standard error (E11). */
const notifyUser = (ctx: unknown, text: string, writeError: (text: string) => void): void => {
  const notify = method(Predicate.hasProperty(ctx, "ui") ? ctx.ui : undefined, "notify");
  if (Predicate.hasProperty(ctx, "hasUI") && ctx.hasUI === true && notify !== undefined)
    notify(text, "warning");
  else writeError(`${text}\n`);
};

const AgentIdentity = Schema.Struct({
  kind: Schema.Literals(["main", "sub"]),
  id: Schema.String,
  parentId: Schema.optional(Schema.String),
});
type AgentIdentity = typeof AgentIdentity.Type;
const isAgentIdentity = Schema.is(AgentIdentity);
const isSessionMode = Schema.is(Schema.Literals(["tui", "rpc", "print", "json"]));

/** The `ctx` members that talk reads; each handler names the ones that it uses (E11). */
interface SessionContext {
  readonly sessionId: () => string;
  readonly sessionFile: () => string | undefined;
  readonly entries: () => ReadonlyArray<unknown>;
  readonly cwd: () => string;
  readonly isIdle: () => boolean;
  readonly hasPendingMessages: () => boolean;
  readonly mode: () => SessionMode;
  readonly agent: () => AgentIdentity;
  readonly setInterval: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
}
type ContextMember = keyof SessionContext;

const MEMBER_NAMES: Record<ContextMember, string> = {
  sessionId: "ctx.sessionManager.getSessionId",
  sessionFile: "ctx.sessionManager.getSessionFile",
  entries: "ctx.sessionManager.getEntries",
  cwd: "ctx.sessionManager.getCwd",
  isIdle: "ctx.isIdle",
  hasPendingMessages: "ctx.hasPendingMessages",
  mode: "ctx.mode",
  agent: "ctx.agent",
  setInterval: "ctx.setInterval",
  clearTimer: "ctx.clearTimer",
};

const contextError = (members: ReadonlyArray<ContextMember>): Error =>
  new Error(
    `talk: this omp gives no valid ${members.map((member) => MEMBER_NAMES[member]).join(", ")}. talk needs omp ${OMP_VERSION_NEEDED} or later.`,
  );

/**
 * Reads `ctx` and fails with a clear error when one of `needs` is missing
 * (E11). Each accessor checks its value again when it runs.
 */
const readContext = (ctx: unknown, needs: ReadonlyArray<ContextMember>): SessionContext => {
  const manager = Predicate.hasProperty(ctx, "sessionManager") ? ctx.sessionManager : undefined;
  const methods = {
    sessionId: method(manager, "getSessionId"),
    sessionFile: method(manager, "getSessionFile"),
    entries: method(manager, "getEntries"),
    cwd: method(manager, "getCwd"),
    isIdle: method(ctx, "isIdle"),
    hasPendingMessages: method(ctx, "hasPendingMessages"),
    setInterval: method(ctx, "setInterval"),
    clearTimer: method(ctx, "clearTimer"),
  };
  /** omp 19.2.1 also has a live read-only view of the entries beside the copy of `getEntries()`. */
  const entriesView = method(manager, "getEntriesView");
  const readMode = (): unknown => (Predicate.hasProperty(ctx, "mode") ? ctx.mode : undefined);
  const readAgent = (): unknown => (Predicate.hasProperty(ctx, "agent") ? ctx.agent : undefined);
  const present: Record<ContextMember, boolean> = {
    sessionId: methods.sessionId !== undefined,
    sessionFile: methods.sessionFile !== undefined,
    entries: methods.entries !== undefined,
    cwd: methods.cwd !== undefined,
    isIdle: methods.isIdle !== undefined,
    hasPendingMessages: methods.hasPendingMessages !== undefined,
    setInterval: methods.setInterval !== undefined,
    clearTimer: methods.clearTimer !== undefined,
    mode: isSessionMode(readMode()),
    agent: isAgentIdentity(readAgent()),
  };
  const missing = needs.filter((member) => !present[member]);
  if (missing.length > 0) throw contextError(missing);
  const call = (member: keyof typeof methods, ...args: ReadonlyArray<unknown>): unknown => {
    const found = methods[member];
    if (found === undefined) throw contextError([member]);
    return found(...args);
  };
  const text = (member: "sessionId" | "cwd"): string => {
    const value = call(member);
    if (!Predicate.isString(value)) throw contextError([member]);
    return value;
  };
  /** A value that is no boolean fails the call instead of a guess (E5). */
  const flag = (member: "isIdle" | "hasPendingMessages"): boolean => {
    const value = call(member);
    if (!Predicate.isBoolean(value)) throw contextError([member]);
    return value;
  };
  return {
    sessionId: () => text("sessionId"),
    cwd: () => text("cwd"),
    sessionFile: () => {
      const file = call("sessionFile");
      return Predicate.isString(file) ? file : undefined;
    },
    // omp's live view where it exists: `getEntries()` copies every entry on each call (E4).
    entries: () => {
      const entries = entriesView === undefined ? call("entries") : entriesView();
      if (!Array.isArray(entries)) throw contextError(["entries"]);
      return entries;
    },
    isIdle: () => flag("isIdle"),
    hasPendingMessages: () => flag("hasPendingMessages"),
    mode: () => {
      const mode = readMode();
      if (!isSessionMode(mode)) throw contextError(["mode"]);
      return mode;
    },
    agent: () => {
      const agent = readAgent();
      if (!isAgentIdentity(agent)) throw contextError(["agent"]);
      return agent;
    },
    setInterval: (callback, delayMs) => call("setInterval", callback, delayMs),
    clearTimer: (timer) => {
      call("clearTimer", timer);
    },
  };
};

/** What a main binding reads at `session_start` and from its timer. */
const MAIN_NEEDS: ReadonlyArray<ContextMember> = [
  "agent",
  "sessionId",
  "sessionFile",
  "entries",
  "cwd",
  "isIdle",
  "hasPendingMessages",
  "mode",
  "setInterval",
  "clearTimer",
];
const TOOL_NEEDS: ReadonlyArray<ContextMember> = ["agent", "sessionId", "cwd"];

/**
 * E6: the ask store keys agents. omp gives every main session the same agent
 * id, so a main session uses a key of its own binding. A subagent id is scoped
 * to the module evaluation, whose main session is its ancestor (F16).
 */
const agentRef = (scope: string, bindingKey: string, identity: AgentIdentity): AgentRef =>
  identity.kind === "main"
    ? { id: bindingKey, parentId: undefined, main: true }
    : {
        id: `${scope}/${identity.id}`,
        parentId: identity.parentId === undefined ? undefined : `${scope}/${identity.parentId}`,
        main: false,
      };

const stringField = (event: unknown, key: string): string | undefined =>
  Predicate.hasProperty(event, key) && Predicate.isString(event[key]) ? event[key] : undefined;

const sameTarget = (left: Target | undefined, right: Target): boolean =>
  left !== undefined && left.instanceId === right.instanceId && left.sessionId === right.sessionId;

interface BindingEnv {
  readonly scope: string;
  readonly clock: TalkClock;
  readonly writeError: (text: string) => void;
}

// ── One factory binding (E3, E7, E10) ──

const bindSession = (api: PiApi, talk: TalkProcess, env: BindingEnv): void => {
  // E3: the marker's own parameters object identifies this binding's row.
  const markerParameters = api.Type.Object({});
  api.registerTool({
    name: MARKER_TOOL_NAME,
    label: MARKER_TOOL_LABEL,
    description: MARKER_TOOL_DESCRIPTION,
    parameters: markerParameters,
    hidden: true,
    execute: async () => ({ content: [{ type: "text", text: MARKER_ANSWER }] }),
  });

  let rawContext: unknown;
  let session: SessionContext | undefined;
  let identity: AgentIdentity | undefined;
  /** The ask store key of this binding's main session (E6). */
  const bindingKey = `${env.scope}#${randomBytes(8).toString("hex")}`;
  let markerPath: string | undefined;
  let timer: unknown;
  let closed = false;
  let registering = false;
  let updating = false;
  let published: RegistrationUpdate | undefined;
  let lastWarning: string | undefined;

  /** One notice per distinct text, so a failure that the timer meets each second shows once. */
  const warn = (text: string): void => {
    if (text === lastWarning) return;
    lastWarning = text;
    notifyUser(rawContext, text, env.writeError);
  };
  const report = (error: unknown): void => {
    warn(`talk: ${causeText(error)}`);
  };

  const ownRow = (row: unknown): boolean =>
    Predicate.hasProperty(row, "name") &&
    row.name === MARKER_TOOL_NAME &&
    Predicate.hasProperty(row, "parameters") &&
    row.parameters === markerParameters;
  const rowPath = (row: unknown): string | undefined =>
    Predicate.hasProperty(row, "sourceInfo") &&
    Predicate.hasProperty(row.sourceInfo, "path") &&
    Predicate.isString(row.sourceInfo.path)
      ? row.sourceInfo.path
      : undefined;
  const toolRows = (): ReadonlyArray<unknown> => {
    const rows = api.getAllTools();
    return Array.isArray(rows) ? rows : [];
  };

  /**
   * E3: `getAllTools()` throws while omp loads the factory, so the path is
   * read from `session_start` on; a placeholder path leaves it unread until
   * the timer finds a real one.
   */
  const readMarkerPath = (): void => {
    if (markerPath !== undefined) return;
    try {
      const path = rowPath(toolRows().find(ownRow));
      if (path !== undefined && path !== "" && !PLACEHOLDER_PATH.test(path)) markerPath = path;
    } catch {
      // A failed read leaves the path unread; the timer reads it again.
    }
  };

  /** E3: the row of this binding's marker, with its own parameters object and its source path. */
  const isActive = (): boolean =>
    markerPath !== undefined &&
    toolRows().some((row) => ownRow(row) && rowPath(row) === markerPath);
  const active = (): boolean => holds(isActive);

  const requireSession = (): SessionContext => {
    if (session === undefined) throw new Error("talk: the session has not started yet.");
    return session;
  };

  const later = (task: () => Promise<void>): void => {
    env.clock.schedule(0, () => {
      task().catch(report);
    });
  };

  const host: TalkHost = {
    isActive,
    sessionId: () => requireSession().sessionId(),
    sessionFile: () => requireSession().sessionFile(),
    entries: () => requireSession().entries(),
    isIdle: () => requireSession().isIdle(),
    hasPendingMessages: () => requireSession().hasPendingMessages(),
    mode: () => requireSession().mode(),
    sendMessage: (message, options) => {
      api.sendMessage(message, options);
    },
    unseenSessionChange: (registration) => {
      replaceRegistration(registration);
    },
  };
  const delivery = makeDelivery({
    host,
    clock: env.clock,
    retain: (pair) => talk.transport.retain(pair),
  });

  const currentName = (sessionId: string): string => sessionName(api.getSessionName(), sessionId);

  /** The keys under which the ask store finds this binding's registration: its own, and its subagents' ancestor. */
  const replyKeys = (): ReadonlyArray<string> =>
    identity === undefined ? [] : [bindingKey, `${env.scope}/${identity.id}`];

  /** Ends this binding's hold on a registration: its queue reads `not-live` and its pending asks end (E5, E6). */
  const drop = (registration: Target): void => {
    if (!sameTarget(delivery.registration, registration)) return;
    delivery.detach();
    published = undefined;
    for (const key of replyKeys()) talk.asks.clearRegistration(key, registration);
  };

  /**
   * E6: a reply address stays valid while it is this binding's registration,
   * the extension is active, and the session id equals the registered one or
   * a transition is pending, as admission requires.
   */
  const replyRoute = (registration: Target): LiveRegistration => ({
    registration,
    isCurrent: () =>
      sameTarget(delivery.registration, registration) &&
      isActive() &&
      (requireSession().sessionId() === registration.sessionId || !delivery.gateOpen),
  });

  const withdraw = async (registration: Target): Promise<void> => {
    drop(registration);
    talk.registrations.release(registration);
    await talk.transport.withdraw(registration);
  };

  /**
   * E7: registers the current session id while the extension is active, the
   * binding has no registration, and the gate is open.
   */
  const ensureRegistered = async (): Promise<void> => {
    const context = session;
    if (closed || registering || identity?.kind !== "main" || context === undefined) return;
    if (delivery.registration !== undefined) return;
    readMarkerPath();
    if (!active() || !delivery.gateOpen) return;
    const sessionId = context.sessionId();
    // T2: the binding chooses the instance id, so admission knows the exact pair before publication.
    const pair: Target = { instanceId: randomBytes(8).toString("hex"), sessionId };
    const input = {
      sessionId,
      instanceId: pair.instanceId,
      name: currentName(sessionId),
      cwd: context.cwd(),
    };
    registering = true;
    const done = talk.registrations.starting({ registration: pair, isActive: active });
    let answer: RegisterAnswer;
    try {
      answer = await talk.transport.register(input);
    } finally {
      done();
      registering = false;
    }
    if (answer._tag === "RegisterFailed") {
      warn(`talk: this session could not register: ${answer.reason}`);
      return;
    }
    const { registration } = answer;
    if (closed || delivery.registration !== undefined || !active()) {
      await talk.transport.withdraw(registration);
      return;
    }
    delivery.attach(registration);
    published = { name: input.name, cwd: input.cwd };
    for (const key of replyKeys()) talk.asks.setRegistration(key, replyRoute(registration));
    talk.registrations.claim({
      registration,
      receiver: delivery,
      isActive,
      admit: () => admitRequest(registration),
      ended: () => {
        drop(registration);
      },
    });
    lastWarning = undefined;
    // The session can change while the registration starts.
    repair();
  };

  /** E7: withdraws a registration whose session id changed unseen, and registers the current id. */
  const replaceRegistration = (registration: Target): void => {
    if (!sameTarget(delivery.registration, registration)) return;
    withdraw(registration).catch(report);
    later(ensureRegistered);
  };

  /**
   * E7 admission, in the tick of the request: the extension is active, and
   * the session id equals the registered one or a transition is pending. A
   * refusal ends the registration; an unseen id change registers anew.
   */
  const admitRequest = (registration: Target): boolean => {
    if (!isActive()) return false;
    if (requireSession().sessionId() === registration.sessionId || !delivery.gateOpen) return true;
    later(ensureRegistered);
    return false;
  };

  /** The repair timer of E7: activity, the session id, and the name and folder. */
  const repair = (): void => {
    const context = session;
    if (closed || context === undefined || identity?.kind !== "main") return;
    readMarkerPath();
    const registration = delivery.registration;
    if (!active()) {
      if (registration !== undefined) withdraw(registration).catch(report);
      return;
    }
    if (registration === undefined) {
      ensureRegistered().catch(report);
      return;
    }
    const sessionId = context.sessionId();
    if (sessionId !== registration.sessionId) {
      // While a transition is pending, a differing id keeps the registration (E7).
      if (delivery.gateOpen) replaceRegistration(registration);
      return;
    }
    const wanted: RegistrationUpdate = { name: currentName(sessionId), cwd: context.cwd() };
    if (updating || published === undefined) return;
    if (published.name === wanted.name && published.cwd === wanted.cwd) return;
    updating = true;
    talk.transport
      .update(registration, wanted)
      .then((updated) => {
        if (updated && sameTarget(delivery.registration, registration)) published = wanted;
      })
      .catch(report)
      .finally(() => {
        updating = false;
      });
  };

  api.on("session_start", async (_event, ctx) => {
    rawContext = ctx;
    identity = readContext(ctx, ["agent"]).agent();
    talk.asks.noteAgent(agentRef(env.scope, bindingKey, identity));
    // A subagent session is no target (#248 D2): it has no registration and no timer.
    if (identity.kind !== "main") return;
    session = readContext(ctx, MAIN_NEEDS);
    readMarkerPath();
    timer ??= session.setInterval(repair, REPAIR_INTERVAL_MS);
    await ensureRegistered();
  });

  const before =
    (kind: TransitionKind): EventHandler =>
    async (event) => {
      // A subagent session has no registration, so it holds nothing.
      if (session === undefined || identity?.kind !== "main") return undefined;
      // E2: the hold never cancels the transition.
      await delivery.beforeTransition({ kind, reason: stringField(event, "reason") });
      return undefined;
    };

  const after =
    (kind: TransitionKind): EventHandler =>
    async (event) => {
      if (session === undefined || identity?.kind !== "main") return undefined;
      delivery.afterTransition({
        kind,
        reason: stringField(event, "reason"),
        previousSessionFile: stringField(event, "previousSessionFile"),
      });
      // E7: a tree move keeps the session id; a switch or branch that changes it
      // withdraws the old registration and registers the new id from a fresh task.
      if (kind === "tree") return undefined;
      const registration = delivery.registration;
      if (registration !== undefined) {
        if (session.sessionId() === registration.sessionId) return undefined;
        withdraw(registration).catch(report);
      }
      later(ensureRegistered);
      return undefined;
    };

  api.on("session_before_switch", before("switch"));
  api.on("session_before_branch", before("branch"));
  api.on("session_before_tree", before("tree"));
  api.on("session_switch", after("switch"));
  api.on("session_branch", after("branch"));
  api.on("session_tree", after("tree"));

  api.on("session_shutdown", async () => {
    closed = true;
    if (timer !== undefined) session?.clearTimer(timer);
    timer = undefined;
    // C13: the agent map keeps this binding's entry only while a live subagent names it.
    if (identity !== undefined) talk.asks.forgetAgent(agentRef(env.scope, bindingKey, identity).id);
    const registration = delivery.registration;
    // Only this binding's registration ends; the listener stays until the process exits (E12).
    if (registration !== undefined) await withdraw(registration);
    return undefined;
  });

  api.registerTool({
    name: TALK_TOOL_NAME,
    label: TALK_TOOL_LABEL,
    description: TALK_TOOL_DESCRIPTION,
    parameters: talkParameters(api.Type),
    execute: async (
      _toolCallId: unknown,
      params: unknown,
      signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) => {
      const context = readContext(ctx, TOOL_NEEDS);
      const sessionId = context.sessionId();
      const self: TalkSelf = {
        agent: agentRef(env.scope, bindingKey, context.agent()),
        sessionId,
        name: currentName(sessionId),
        cwd: context.cwd(),
        registration: delivery.registration,
        pending: delivery.pending,
        queuedCount: delivery.queuedCount,
      };
      const outcome = await Effect.runPromise(
        runTalkTool(
          {
            transport: talk.transport,
            asks: talk.asks,
            self,
            clock: env.clock,
            signal: signal instanceof AbortSignal ? signal : undefined,
          },
          params,
        ),
      );
      if (!outcome.ok) throw new Error(outcome.text);
      return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
    },
  });
};

// ── Factory ──

export interface TalkExtensionOptions {
  /** Builds the transport of a new process singleton. Default: `makeTalkTransport`. */
  readonly makeTransport?: ((hooks: TransportHooks) => TransportFacade) | undefined;
  /** Default: `isMainThread` of `node:worker_threads`. */
  readonly isMainThread?: boolean | undefined;
  /** Default: standard error. */
  readonly writeError?: ((text: string) => void) | undefined;
  /** Default: the system clock. */
  readonly clock?: TalkClock | undefined;
}

/**
 * The factory of one module evaluation. omp calls it for each session that
 * the evaluation serves.
 */
export const makeTalkExtension = (options: TalkExtensionOptions = {}): ((pi: unknown) => void) => {
  const scope = randomBytes(8).toString("hex");
  const writeError =
    options.writeError ??
    ((text: string): void => {
      process.stderr.write(text);
    });
  const report = (error: unknown): void => {
    writeError(`talk: ${causeText(error)}\n`);
  };
  const clock = options.clock ?? systemClock(report);
  const makeTransport =
    options.makeTransport ?? ((hooks: TransportHooks) => makeTalkTransport(hooks).facade);

  return (pi) => {
    // E12: a worker thread has its own globalThis, so a binding there registers nothing.
    if (!(options.isMainThread ?? isMainThread)) return;
    const probe = probeApi(pi);
    if (probe._tag === "Missing") {
      const notice = capabilityNotice(probe.missing);
      if (probe.on === undefined) {
        writeError(`${notice}\n`);
        return;
      }
      probe.on("session_start", async (_event, ctx) => {
        notifyUser(ctx, notice, writeError);
        return undefined;
      });
      return;
    }
    const talk = processSingleton({ makeTransport, clock, report });
    if (talk === undefined) {
      if (Reflect.get(globalThis, VERSION_NOTICE_KEY) !== true) {
        Reflect.set(globalThis, VERSION_NOTICE_KEY, true);
        writeError(`${VERSION_NOTICE}\n`);
      }
      return;
    }
    bindSession(probe.api, talk, { scope, clock, writeError });
  };
};

/** The factory that omp loads from `talk.js`. */
const talkExtension = makeTalkExtension();
export default talkExtension;
