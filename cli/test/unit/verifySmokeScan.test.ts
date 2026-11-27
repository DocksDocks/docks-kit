import { describe, expect, it } from "vitest";

import {
  decodeAttribution,
  decodeFinal,
  timeoutScanChoice,
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

describe("timeoutScanChoice", () => {
  it("starts a fresh scan when the final scan ended", () => {
    expect(timeoutScanChoice(true)).toBe("fresh");
  });

  it("reuses the final scan when it did not end", () => {
    expect(timeoutScanChoice(false)).toBe("reuse");
  });
});
