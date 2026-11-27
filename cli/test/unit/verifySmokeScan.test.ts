import { describe, expect, it, vi } from "vitest";

import {
  decodeAttribution,
  decodeFinal,
  sessionRegistryChecks,
} from "../../../.agents/skills/verify/scripts/smokeScan.ts";

/** A valid instance id: 16 lowercase hex digits. */
const INSTANCE_ID = "0123456789abcdef";

describe("decodeAttribution", () => {
  it("accepts a passed attribution reply with a valid instance id", () => {
    expect(
      decodeAttribution({
        kind: "attribution",
        status: "done",
        problem: "",
        instanceId: INSTANCE_ID,
      }),
    ).toEqual({ problem: "", instanceId: INSTANCE_ID });
  });

  it("accepts a failed attribution reply and a reply without a valid entry", () => {
    expect(
      decodeAttribution({ kind: "attribution", status: "done", problem: "leak", instanceId: null }),
    ).toEqual({ problem: "leak", instanceId: undefined });
    expect(decodeAttribution({ kind: "attribution", status: "none" })).toBe("none");
  });

  it("rejects an otherwise valid reply of the final kind or without a kind", () => {
    const reply = { status: "done", problem: "", instanceId: INSTANCE_ID };
    expect(decodeAttribution({ ...reply, kind: "final" })).toBeUndefined();
    expect(decodeAttribution(reply)).toBeUndefined();
    expect(decodeAttribution({ kind: "final", status: "none" })).toBeUndefined();
  });

  it("rejects a passed attribution without a valid instance id", () => {
    const reply = { kind: "attribution", status: "done", problem: "" };
    expect(decodeAttribution(reply)).toBeUndefined();
    expect(decodeAttribution({ ...reply, instanceId: "not-an-id" })).toBeUndefined();
  });
});

describe("decodeFinal", () => {
  it("accepts a final reply", () => {
    expect(decodeFinal({ kind: "final", status: "done", problem: "" })).toBe("");
    expect(decodeFinal({ kind: "final", status: "done", problem: "leak" })).toBe("leak");
  });

  it("rejects an otherwise valid reply of the attribution kind or without a kind", () => {
    expect(decodeFinal({ kind: "attribution", status: "done", problem: "" })).toBeUndefined();
    expect(decodeFinal({ status: "done", problem: "" })).toBeUndefined();
  });
});

describe("sessionRegistryChecks", () => {
  /** A fake scan that gives the next problem of `problems` on each call. */
  const fakeScan = (...problems: string[]) => {
    const queue = [...problems];
    return vi.fn(() => Promise.resolve(queue.shift() ?? ""));
  };

  it("runs a fresh scan at the timeout after the final scan ended, and reports its leak", async () => {
    const scanFinal = fakeScan("", "leak");
    const checks = sessionRegistryChecks({ attribution: Promise.resolve(""), scanFinal });
    expect(await checks.finalAnswer()).toBe("");
    expect(await checks.timeout()).toBe("leak");
    expect(scanFinal).toHaveBeenCalledTimes(2);
    expect(await checks.problem()).toBe("leak");
  });

  it("reuses a final scan that did not end at the timeout", async () => {
    const pending = Promise.withResolvers<string>();
    const scanFinal = vi.fn(() => pending.promise);
    const checks = sessionRegistryChecks({ attribution: Promise.resolve(""), scanFinal });
    const final = checks.finalAnswer();
    const atTimeout = checks.timeout();
    expect(atTimeout).toBe(final);
    expect(scanFinal).toHaveBeenCalledTimes(1);
    pending.resolve("leak");
    expect(await checks.problem()).toBe("leak");
  });

  it("starts the final scan at the timeout when no final answer came", async () => {
    const scanFinal = fakeScan("leak");
    const checks = sessionRegistryChecks({ attribution: Promise.resolve(""), scanFinal });
    expect(await checks.timeout()).toBe("leak");
    expect(scanFinal).toHaveBeenCalledTimes(1);
    expect(await checks.problem()).toBe("leak");
  });

  it("keeps the problems of the attribution and of both scans, without exact duplicates", async () => {
    const distinct = sessionRegistryChecks({
      attribution: Promise.resolve("attribution"),
      scanFinal: fakeScan("first", "second"),
    });
    await distinct.finalAnswer();
    await distinct.timeout();
    expect(await distinct.problem()).toBe("attribution; first; second");

    const repeated = sessionRegistryChecks({
      attribution: Promise.resolve(""),
      scanFinal: fakeScan("leak", "leak"),
    });
    await repeated.finalAnswer();
    await repeated.timeout();
    expect(await repeated.problem()).toBe("leak");
  });
});
