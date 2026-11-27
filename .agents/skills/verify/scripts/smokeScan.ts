/**
 * The pure decisions of the registry scans of `omp-smoke.ts`: the decoders of the replies of the scan child, and
 * the choice that the command timeout of a print session makes about its final scan. The module uses no Bun API
 * and has no side effect at import, so unit tests can load it (`cli/test/unit/verifySmokeScan.test.ts`).
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

/**
 * What the command timeout of a live print session does about its final scan: `"reuse"` the final scan when it
 * did not end yet (it starts the final scan when none started), or start a `"fresh"` scan when the final scan
 * ended, because the session can have written an entry since.
 */
export function timeoutScanChoice(finalScanEnded: boolean): "reuse" | "fresh" {
  return finalScanEnded ? "fresh" : "reuse";
}
