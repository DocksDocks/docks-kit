import { describe, expect, it } from "vitest";

import {
  PLAN_CLI_HOST_SUPPORTED,
  expectSuccess,
  planCliContext,
  refuse,
} from "../../lib/plan/harness";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

const CHANGED = "plan issue changed remotely; re-read and retry";

// The pre-write read compares what governs a write with the snapshot, and the stored state of the write must show the
// claim and exactly the expected phase labels (#213, R2, R6, R8, R11, R12, R13, R15).
describe.skipIf(!PLAN_CLI_HOST_SUPPORTED)("plan write postconditions", () => {
  it(
    "status refuses a close, a phase label, or a co-owner that appears after the snapshot",
    () => {
      const { run, issue, createPlan, schedule } = planCliContext();
      // Each change lands after the snapshot read and before the pre-write read.
      const closed = createPlan("closed meanwhile");
      schedule(closed, { afterReads: 1, state: "CLOSED", stateReason: "COMPLETED" });
      refuse(run("status", String(closed), "planned"), CHANGED);
      expect(issue(closed).labels).toStrictEqual(["plan", "plan:drafting"]);

      const relabelled = createPlan("phase label meanwhile");
      schedule(relabelled, { afterReads: 1, labels: ["plan", "plan:drafting", "plan:blocked"] });
      refuse(run("status", String(relabelled), "planned"), CHANGED);
      expect(issue(relabelled).labels).toStrictEqual(["plan", "plan:drafting", "plan:blocked"]);

      const shared = createPlan("co-owner meanwhile");
      schedule(shared, { afterReads: 1, assignees: ["plan-agent", "other-agent"] });
      refuse(run("status", String(shared), "planned"), `plan #${shared} is owned by other-agent`);
      expect(issue(shared).labels).toStrictEqual(["plan", "plan:drafting"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "a write and new --parent refuse an open plan without the base plan label",
    () => {
      const { run, issue, updateIssue, createPlan, schedule } = planCliContext();
      const unlisted = createPlan("no base label");
      updateIssue(unlisted, (entry) => {
        entry.labels = ["plan:drafting"];
      });
      refuse(
        run("status", String(unlisted), "planned"),
        `plan #${unlisted} lacks the plan label; add it with \`gh issue edit ${unlisted} --add-label plan\``,
      );
      expect(issue(unlisted).labels).toStrictEqual(["plan:drafting"]);
      refuse(
        run("new", "--title", "child", "--goal", "Child work", "--parent", String(unlisted)),
        `parent #${unlisted} is not an open plan`,
      );

      // The base label that goes after the snapshot stops the write too.
      const dropped = createPlan("base label goes meanwhile");
      schedule(dropped, { afterReads: 1, labels: ["plan:drafting"] });
      refuse(run("status", String(dropped), "planned"), CHANGED);
      expect(issue(dropped).labels).toStrictEqual(["plan:drafting"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "status refuses when the stored labels after the write are not the expected phase labels",
    () => {
      const { run, issue, updateState, createPlan } = planCliContext();
      // The label fields answer without a change, so the removed phase label stays.
      const kept = createPlan("labels kept");
      updateState((state) => {
        state.mutationKeepsLabelsOnce = true;
      });
      const result = run("status", String(kept), "planned");
      refuse(result, "plan issue labels differ after edit");
      expect(result.stdout).not.toContain("status:");
      expectSuccess(run("status", String(kept), "planned"), "status retry");
      expect(issue(kept).labels).toStrictEqual(["plan", "plan:planned"]);

      // A phase label that someone adds between the pre-write read and the write survives the write.
      const raced = createPlan("phase label in the write window");
      updateState((state) => {
        state.beforeMutationOnce = {
          issue: raced,
          labels: ["plan", "plan:drafting", "plan:blocked"],
        };
      });
      const racedResult = run("status", String(raced), "planned");
      refuse(racedResult, "plan issue labels differ after edit");
      expect(racedResult.stdout).not.toContain("status:");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "status refuses a body change made while it creates a missing phase label",
    () => {
      const { run, issue, updateState, createPlan } = planCliContext();
      const plan = createPlan("label created meanwhile");
      const remote = `${issue(plan).body}\nRemote line.\n`;
      updateState((state) => {
        delete state.labels["plan:planned"];
        state.afterLabelCreateOnce = { issue: plan, body: remote };
      });
      refuse(run("status", String(plan), "planned"), CHANGED);
      expect(issue(plan).body).toBe(remote);
      expect(issue(plan).labels).toStrictEqual(["plan", "plan:drafting"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "retire leaves the plan open when its claim or its label removal did not land",
    () => {
      const { run, issue, updateIssue, updateState, createPlan } = planCliContext();
      const unclaimed = createPlan("claim dropped");
      updateIssue(unclaimed, (entry) => {
        entry.assignees = [];
      });
      updateState((state) => {
        state.mutationDropsAssigneesOnce = true;
      });
      refuse(
        run("retire", String(unclaimed), "--reason", "No longer needed"),
        "plan issue claim did not land; re-read and retry",
      );
      expect(issue(unclaimed).state).toBe("OPEN");
      expect(issue(unclaimed).assignees ?? []).toStrictEqual([]);

      const labelled = createPlan("label kept");
      updateState((state) => {
        state.mutationKeepsLabelsOnce = true;
      });
      refuse(
        run("retire", String(labelled), "--reason", "No longer needed"),
        "plan issue labels differ after edit",
      );
      expect(issue(labelled).state).toBe("OPEN");
      expect(issue(labelled).labels).toStrictEqual(["plan", "plan:drafting"]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "retire reads the plan before the close even when it removes and claims nothing",
    () => {
      const { run, issue, updateIssue, createPlan, schedule } = planCliContext();
      const plan = createPlan("nothing to remove");
      updateIssue(plan, (entry) => {
        entry.labels = ["plan"];
      });
      schedule(plan, { afterReads: 1, labels: ["plan", "plan:ongoing"] });
      refuse(run("retire", String(plan), "--reason", "No longer needed"), CHANGED);
      expect(issue(plan).state).toBe("OPEN");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "new creates a plan when the viewer and the plan labels answer without node ids",
    () => {
      const { run, updateState, issue } = planCliContext();
      // `new` writes with label names and `@me`, so it needs no node id (#213, R20).
      updateState((state) => {
        state.nodeIdsMissing = true;
      });
      const created = run("new", "--title", "name-only plan", "--goal", "Preserve plan records");
      expectSuccess(created, "new without node ids");
      const number = Number(/^plan created: #(\d+) /m.exec(created.stdout)?.[1]);
      expect(issue(number).labels).toStrictEqual(["plan", "plan:drafting"]);
    },
    SPAWN_TIMEOUT_MS,
  );
});
