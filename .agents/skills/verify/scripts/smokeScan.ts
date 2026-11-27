/**
 * The pure parts of the registry checks of `omp-smoke.ts`: the decoders of the replies of the scan child, and the
 * check state of one print session, with its final-answer hook and its command-timeout hook. The module uses no
 * Bun API and has no side effect at import, so unit tests can load it (`cli/test/unit/verifySmokeScan.test.ts`).
 */
import { Schema } from "effect";

import { InstanceId } from "../../../../cli/talk/transport/handshake.ts";

/** A reply of the scan child: one JSON object. */
export type ScanReply = Readonly<Record<string, unknown>>;

/** The result of one attribution: the problem, or an empty text, and the instance id of the valid private entry. */
export interface Attribution {
  readonly problem: string;
  readonly instanceId: string | undefined;
}

const isInstanceId = Schema.is(InstanceId);

/**
 * The attribution of a reply of the scan child, `"none"` when no poll found a valid entry, or undefined for a reply
 * of another shape or of another kind. A passed check must name a valid instance id.
 */
export function decodeAttribution(reply: ScanReply): Attribution | "none" | undefined {
  if (reply["kind"] !== "attribution") return undefined;
  if (reply["status"] === "none") return "none";
  const problem = reply["problem"];
  const instanceId = reply["instanceId"];
  if (reply["status"] !== "done" || typeof problem !== "string") return undefined;
  if (problem !== "") return { problem, instanceId: undefined };
  return typeof instanceId === "string" && isInstanceId(instanceId)
    ? { problem, instanceId }
    : undefined;
}

/** The problem of a final-scan reply of the scan child, or undefined for a reply of another shape or kind. */
export function decodeFinal(reply: ScanReply): string | undefined {
  const problem = reply["problem"];
  return reply["kind"] === "final" && reply["status"] === "done" && typeof problem === "string"
    ? problem
    : undefined;
}

/** The registry checks of one print session of the load mode or the `hooks` mode. */
export interface SessionRegistryChecks {
  /** The attribution of the session; the fake model holds each answer until it ends. */
  readonly attribution: Promise<string>;
  /** The final-answer hook: starts the final scan of the default folder once, and gives it. */
  readonly finalAnswer: () => Promise<string>;
  /**
   * The command-timeout hook, while the session is still live. When the final scan did not end yet, it gives that
   * scan (and starts it when none started). When the final scan ended, it starts a fresh scan, because the session
   * can have written an entry since.
   */
  readonly timeout: () => Promise<string>;
  /** The problems of the attribution and of each scan, without exact duplicates, or an empty text. */
  readonly problem: () => Promise<string>;
}

/**
 * The check state of one print session. `scanFinal` runs one bounded scan of the default folder for the session
 * and gives its problem, or an empty text.
 */
export function sessionRegistryChecks(options: {
  readonly attribution: Promise<string>;
  readonly scanFinal: () => Promise<string>;
}): SessionRegistryChecks {
  let final: Promise<string> | undefined;
  let finalEnded = false;
  let timeoutScan: Promise<string> | undefined;
  const finalAnswer = (): Promise<string> => {
    if (final === undefined) {
      final = options.scanFinal();
      void final.then(() => {
        finalEnded = true;
      });
    }
    return final;
  };
  return {
    attribution: options.attribution,
    finalAnswer,
    timeout: () => {
      if (!finalEnded) return finalAnswer();
      timeoutScan = options.scanFinal();
      return timeoutScan;
    },
    problem: async () => {
      const problems = [await options.attribution, await (final ?? ""), await (timeoutScan ?? "")];
      return [...new Set(problems.filter(Boolean))].join("; ");
    },
  };
}
