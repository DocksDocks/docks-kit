import { describe, expect, it } from "vitest";

import { PLAN_CLI_HOST_SUPPORTED, planCliContext, refuse } from "../../lib/plan/harness";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

// GitHub marks a pull request merged when its head commit reaches the base branch another way (an indirect merge). The
// landing proof is a merge commit that the pull request's own merge made (#213, R1).
describe.skipIf(!PLAN_CLI_HOST_SUPPORTED)("plan archive landing proof", () => {
  it.each([
    [
      "its head commit pushed straight to main",
      (pr: number) => ({ oid: `head${pr}`, associatedPullRequests: [pr] }),
    ],
    [
      "a merge commit of another pull request",
      () => ({ oid: "merge999", associatedPullRequests: [999] }),
    ],
    ["no merge commit", () => null],
  ])(
    "archive refuses a pull request merged indirectly through %s and writes nothing",
    (_label, mergeCommit) => {
      const { run, issue, updateState, landedPlan, writes } = planCliContext();
      const { number, pr } = landedPlan("indirect merge");
      updateState((state) => {
        const entry = state.prs.find((candidate) => candidate.number === pr);
        if (entry) entry.mergeCommit = mergeCommit(pr);
        // The pull request whose merge commit brought the head commit in.
        state.prs.push({
          number: 999,
          state: "MERGED",
          mergedAt: "2026-08-20T19:00:00Z",
          baseRefName: "main",
          repository: "DocksDocks/fixture",
        });
      });
      refuse(
        run("archive", String(number), "--pr", String(pr)),
        `pull request #${pr} did not land by its own merge: its merge commit is missing, is its head commit, or belongs to another pull request`,
      );
      expect(issue(number).state).toBe("OPEN");
      expect(issue(number).labels).toStrictEqual(["plan", "plan:ongoing"]);
      expect(writes()).toStrictEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
