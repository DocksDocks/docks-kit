/// <reference types="bun" />

// A talk peer for the spawned-Bun transport test (#249 E9). It imports the
// built bundle (argv[2]), runs the transport, and answers JSON lines on stdin:
// `{ "id": n, "op": "...", ... }` -> `{ "id": n, "ok": true, "value": ... }` or
// `{ "id": n, "ok": false, "tag": ..., "outcome": ..., "reason": ... }`.
// It prints `{ "ready": true, ... }` once the transport runs. Request kinds:
// `echo` answers its body, and `wait` never answers (for withdrawal tests).
// Environment: `TALK_PEER_REPAIR_MS` sets the repair interval (default 1000).

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { Effect, ManagedRuntime, Predicate, type Schema } from "effect";

import type * as Talk from "../../../talk/index";

const bundle = process.argv[2];
if (bundle === undefined) throw new Error("usage: bun peer.ts <talk.js>");
// The bundle path comes from argv, so a static import cannot name it.
const talk = (await import(pathToFileURL(bundle).href)) as typeof Talk;

const repairIntervalMs = Number(process.env["TALK_PEER_REPAIR_MS"] ?? "1000");
const runtime = ManagedRuntime.make(talk.TalkTransport.layer({ repairIntervalMs }));
const { TalkTransport } = talk;

const print = (line: unknown): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

interface Command {
  readonly id: number;
  readonly op: string;
  readonly sessionId?: string;
  readonly name?: string;
  readonly target?: Talk.Target;
  readonly kind?: string;
  readonly body?: Schema.Json;
  readonly timeoutMs?: number;
}

const run = <A, E>(effect: Effect.Effect<A, E, Talk.TalkTransport>): Promise<A> =>
  runtime.runPromise(effect);

const target = (command: Command): Talk.Target => {
  if (command.target === undefined) throw new Error(`${command.op} needs a target`);
  return command.target;
};

async function perform(command: Command): Promise<unknown> {
  switch (command.op) {
    case "register":
      return run(
        TalkTransport.use((transport) =>
          transport.register({
            sessionId: command.sessionId ?? "",
            name: command.name ?? "peer",
            cwd: process.cwd(),
          }),
        ),
      );
    case "withdraw":
      return run(TalkTransport.use((transport) => transport.withdraw(command.sessionId ?? "")));
    case "list":
      return run(TalkTransport.use((transport) => transport.list));
    case "request":
      return run(
        TalkTransport.use((transport) =>
          transport.request(target(command), command.kind ?? "echo", command.body ?? null, command.timeoutMs),
        ),
      );
    case "probe":
      return run(TalkTransport.use((transport) => transport.probe(target(command))));
    case "status":
      return run(TalkTransport.use((transport) => transport.status));
    case "exit":
      await runtime.dispose();
      print({ id: command.id, ok: true, value: null });
      process.exit(0);
      break;
    default:
      throw new Error(`unknown op ${command.op}`);
  }
}

const field = (error: unknown, name: string): unknown =>
  Predicate.hasProperty(error, name) ? error[name] : undefined;

await run(
  TalkTransport.use((transport) =>
    Effect.andThen(
      transport.handle("echo", (body, context) =>
        Effect.succeed({ echo: body, by: context.registration.sessionId }),
      ),
      transport.handle("wait", () => Effect.never),
    ),
  ),
);
const status = await run(TalkTransport.use((transport) => transport.status));
print({ ready: true, pid: process.pid, instanceId: status.instanceId, folder: status.folder });

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const command = JSON.parse(line) as Command;
  perform(command).then(
    (value) => print({ id: command.id, ok: true, value: value ?? null }),
    (error: unknown) =>
      print({
        id: command.id,
        ok: false,
        tag: field(error, "_tag"),
        outcome: field(error, "outcome"),
        reason: field(error, "reason") ?? String(error),
      }),
  );
}
await runtime.dispose();
