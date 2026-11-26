import { describe, expect, it } from "vitest";

import {
  PLAN_CLI_HOST_SUPPORTED,
  type LandedPlan,
  type LandedPlanOptions,
  type PlanCliContext,
  type PlanResult,
  body,
  expectSuccess,
  planCliContext,
  refuse,
} from "../../lib/plan/harness";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

// Every archive skips its waits, so a pause for an open plan returns at once and gets recorded.
function archive({ runSkippingWaits }: PlanCliContext, plan: LandedPlan): PlanResult {
  return runSkippingWaits("archive", String(plan.number), "--pr", String(plan.pr));
}

type Landing = readonly [
  kind: string,
  land: (name: string, options?: LandedPlanOptions) => LandedPlan,
  state: string,
];

// A landed plan that GitHub left open, which an archive closes after its waits, and one that GitHub closed.
function landings({ landedPlan, closedPlan }: PlanCliContext): ReadonlyArray<Landing> {
  return [
    ["open", landedPlan, "OPEN"],
    ["closed", closedPlan, "CLOSED"],
  ];
}

// A refused archive leaves the plan as it found it, with `plan:ongoing`, and neither writes nor waits.
function assertUntouched(
  { issue, writes, waits }: PlanCliContext,
  plan: LandedPlan,
  state: string,
  label?: string,
): void {
  const { state: stored, labels } = issue(plan.number);
  expect({ state: stored, labels }, label).toStrictEqual({
    state,
    labels: ["plan", "plan:ongoing"],
  });
  expect(writes(), label).toStrictEqual([]);
  expect(waits(), label).toStrictEqual([]);
}

type RefusalCase = {
  readonly name: string;
  readonly options?: LandedPlanOptions;
  readonly prepare?: (context: PlanCliContext, plan: LandedPlan) => void;
  readonly refusal: (plan: LandedPlan) => string;
};

const REFUSALS: ReadonlyArray<RefusalCase> = [
  {
    name: "no closing keyword",
    options: { prBody: "Refs #ISSUE" },
    refusal: (plan) =>
      `pull request #${plan.pr} has no closing keyword for plan #${plan.number} in its description; ask the owner before you add \`Closes #${plan.number}\` to the merged pull request, then run archive again`,
  },
  {
    name: "a merge into another branch",
    options: { base: "release" },
    refusal: (plan) =>
      `pull request #${plan.pr} merged into release; archive requires a merge into DocksDocks/fixture:main`,
  },
  {
    name: "a non-terminal step",
    options: { status: "in-flight" },
    refusal: () => "archive refused: non-terminal step fix_parser",
  },
  {
    // A merged closing pull request does not replace review approval.
    name: "a review that asks for repair",
    prepare: (context, plan) =>
      context.addIssueComment(plan.number, "## Code review\n\ncode-review: repair\nFix data loss."),
    refusal: () => "archive requires Code-review: pass",
  },
  {
    name: "another owner",
    prepare: (context, plan) =>
      context.updateIssue(plan.number, (entry) => {
        entry.assignees = ["other-agent"];
      }),
    refusal: (plan) => `plan #${plan.number} is owned by other-agent`,
  },
];

describe.skipIf(!PLAN_CLI_HOST_SUPPORTED)("plan archive, retire, and list", () => {
  // One case per refusal and landing keeps the spawns of each case near one plan (see spawnTimeout.ts).
  it.each(REFUSALS.flatMap((refusal) => ["open", "closed"].map((kind) => ({ ...refusal, kind }))))(
    "archive refuses an open or closed plan without landing proof, finished work, a review pass, or ownership: $name, $kind plan",
    ({ name, options, prepare, refusal, kind }) => {
      const context = planCliContext();
      const landing = landings(context).find(([candidate]) => candidate === kind);
      if (landing === undefined) throw new Error(`no landing of kind ${kind}`);
      const [, land, state] = landing;
      const label = `${name}, ${kind} plan`;
      const plan = land(label, options);
      prepare?.(context, plan);
      refuse(archive(context, plan), refusal(plan));
      assertUntouched(context, plan, state, label);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses a broken Steps table that parses to zero rows",
    () => {
      const context = planCliContext();
      // A broken Steps table parses to zero rows; that never counts as complete work.
      const plan = context.closedPlan("broken steps table");
      context.updateIssue(plan.number, (entry) => {
        entry.body = entry.body.replace(
          "| # | Id | Task | Files | Depends | Effect | Status | Done when |\n",
          "",
        );
      });
      refuse(archive(context, plan), "archive refused: no Steps rows parsed");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses an open or closed plan whose Steps table holds a malformed row beside a done row",
    () => {
      const context = planCliContext();
      // The nine-cell row is work that the done row does not finish.
      const malformed = "| 2 | broken | Unescaped a | b | src | - | local | planned | Lost |";
      for (const [kind, land, state] of landings(context)) {
        const plan = land(`malformed row, ${kind} plan`);
        context.updateIssue(plan.number, (entry) => {
          entry.body = entry.body.replace(
            "| Records round-trip |\n",
            `| Records round-trip |\n${malformed}\n`,
          );
        });
        refuse(
          archive(context, plan),
          "Steps row 2 has 9 cells; expected 8. Escape a literal pipe as \\| so the row is preserved.",
        );
        assertUntouched(context, plan, state, `${kind} plan`);
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses a pull request number that exists only in another repository",
    () => {
      const context = planCliContext();
      const plan = context.landedPlan("pull request of another repository");
      context.updateState((state) => {
        const pullRequest = state.prs.find((entry) => entry.number === plan.pr);
        if (pullRequest === undefined) throw new Error(`no pull request #${plan.pr}`);
        pullRequest.repository = "Another/repo";
      });
      refuse(
        archive(context, plan),
        `gh api graphql failed: gh: Could not resolve to a PullRequest with the number of ${plan.pr}.`,
      );
      assertUntouched(context, plan, "OPEN");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses an open plan that is not ongoing and writes nothing",
    () => {
      const context = planCliContext();
      const plan = context.landedPlan("blocked plan");
      context.updateIssue(plan.number, (entry) => {
        entry.labels = ["plan", "plan:blocked"];
      });
      refuse(archive(context, plan), "archive requires ongoing or finished status, found blocked");
      expect(context.writes()).toStrictEqual([]);
      expect(context.waits()).toStrictEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses a retired plan and writes nothing",
    () => {
      const context = planCliContext();
      const plan = context.closedPlan("retired plan");
      context.updateIssue(plan.number, (entry) => {
        entry.stateReason = "NOT_PLANNED";
      });
      refuse(archive(context, plan), "archive requires ongoing or finished status, found retired");
      expect(context.writes()).toStrictEqual([]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "archive refuses a plan that GitHub left closed with reason REOPENED and writes nothing",
    () => {
      const context = planCliContext();
      const plan = context.closedPlan("stuck plan");
      context.updateIssue(plan.number, (entry) => {
        entry.stateReason = "REOPENED";
      });
      refuse(
        archive(context, plan),
        `GitHub left plan #${plan.number} closed with reason REOPENED and refuses every state change; ask GitHub Support to repair it`,
      );
      assertUntouched(context, plan, "CLOSED");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "show and archive read a comment page after the first one",
    () => {
      const context = planCliContext();
      const plan = context.closedPlan("later comment page");
      // The trusted pass is on the first page; 100 more comments push a later trusted verdict to the second page
      // (#213, R23).
      context.updateState((state) => {
        const entry = state.issues.find((candidate) => candidate.number === plan.number);
        if (entry === undefined) throw new Error(`no issue #${plan.number}`);
        entry.comments ??= [];
        state.nextComment ??= 1;
        for (let i = 0; i < 100; i += 1) {
          const id = state.nextComment++;
          entry.comments.push({
            id,
            body: `Evidence round ${i}\n${"x".repeat(1000)}`,
            author: "plan-agent",
            createdAt: new Date(Date.parse("2026-08-20T20:00:00Z") + id * 1000).toISOString(),
          });
        }
      });
      context.addIssueComment(
        plan.number,
        "### Code review round 3\n\ncode-review: fixes-required",
      );
      const shown = context.run("show", String(plan.number));
      expectSuccess(shown, "show a later comment page");
      expect(shown.stdout).toMatch(/^reviews: plan=none code=fixes-required$/m);
      refuse(archive(context, plan), "archive requires Code-review: pass");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "show advises on a plan closed with unfinished work, and step needs a reopen before it writes",
    () => {
      const { run, updateIssue, closedPlan } = planCliContext();
      const partialMerge = closedPlan("closed by a partial merge", { status: "in-flight" });
      const partialShow = run("show", String(partialMerge.number));
      expectSuccess(partialShow, "show early closure");
      // A v5 plan takes no reopen after a partial merge, and new --parent refuses a closed parent.
      expect(partialShow.stdout.split(/\r?\n/)).toContain(
        `advice: plan is closed as completed while step fix_parser is in-flight; closed by ${partialMerge.closer.url}; run step ${partialMerge.number} fix_parser done if the merged work finished it; otherwise open a new plan with new for the remaining work`,
      );
      expect(partialShow.stdout).not.toContain("reopen the issue");
      // A v4 plan that a pull request closed reopens through the helper, never by hand.
      const legacy = closedPlan("v4 closed by a partial merge", { status: "in-flight" });
      updateIssue(legacy.number, (entry) => {
        entry.body = body("in-flight", 4);
      });
      const legacyShow = run("show", String(legacy.number));
      expectSuccess(legacyShow, "show v4 early closure");
      expect(legacyShow.stdout.split(/\r?\n/)).toContain(
        `advice: plan is closed as completed while step fix_parser is in-flight; closed by ${legacy.closer.url}; run step ${legacy.number} fix_parser done if the merged work finished it; otherwise run reopen ${legacy.number} --pr ${legacy.pr}`,
      );
      refuse(
        run("step", String(partialMerge.number), "fix_parser", "in-flight"),
        `plan #${partialMerge.number} is finished; reopen it before moving step fix_parser to in-flight`,
      );
      updateIssue(partialMerge.number, (entry) => {
        entry.state = "OPEN";
        entry.stateReason = "REOPENED";
      });
      expectSuccess(
        run("step", String(partialMerge.number), "fix_parser", "done"),
        "finish step after reopen",
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "show advises a hand reopen for a close by an unknown closer and reopen --pr for a close by a commit",
    () => {
      const { run, updateIssue, updateState, closedPlan } = planCliContext();
      const advice = (number: number): Array<string> => {
        const shown = run("show", String(number));
        expectSuccess(shown, `show #${number}`);
        return shown.stdout.split("\n").filter((line) => line.startsWith("advice: plan is closed"));
      };
      // A v4 plan that someone closed by hand: no pull request can reopen it.
      const byHand = closedPlan("v4 closed by hand", { status: "in-flight" });
      updateIssue(byHand.number, (entry) => {
        entry.body = body("in-flight", 4);
        entry.timelineItems = [{ __typename: "ClosedEvent", closer: null }];
      });
      expect(advice(byHand.number)).toStrictEqual([
        `advice: plan is closed as completed while step fix_parser is in-flight; closed by an unknown closer; run step ${byHand.number} fix_parser done if the merged work finished it; otherwise reopen the plan by hand only if that close was a mistake`,
      ]);
      // A v3 plan that a commit closed: `reopen --pr` finds and checks the merged pull request of that commit itself.
      const byCommit = closedPlan("v3 closed by a commit", { status: "in-flight" });
      const oid = "c0ffee0000000000000000000000000000000003";
      updateState((state) => {
        state.commits = [{ oid, associatedPullRequests: [{ number: byCommit.pr }] }];
      });
      updateIssue(byCommit.number, (entry) => {
        entry.body = body("in-flight", 3);
        entry.timelineItems = [
          { __typename: "ClosedEvent", closer: { __typename: "Commit", oid } },
        ];
      });
      expect(advice(byCommit.number)).toStrictEqual([
        `advice: plan is closed as completed while step fix_parser is in-flight; closed by commit ${oid}; run step ${byCommit.number} fix_parser done if the merged work finished it; otherwise run reopen ${byCommit.number} --pr <pr> when a merged pull request <pr> holds commit ${oid.slice(0, 7)} and closes this plan, or open a new plan with new for the remaining work`,
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "retire repairs labels before it closes the issue, and list filters open and closed plans",
    () => {
      const { run, updateState, issue, updateIssue, createPlan } = planCliContext();
      // Retire repairs labels before closing; list retains its filtered open/closed view.
      const listed = createPlan("listed drafting plan");
      const unlisted = createPlan("issue without plan label");
      updateIssue(unlisted, (entry) => {
        entry.labels = ["other"];
      });
      const retiring = createPlan("retired plan");
      updateIssue(retiring, (entry) => {
        entry.assignees = [];
      });
      updateState((state) => {
        state.labelRemovalErrorOnce = "label removal unavailable";
      });
      refuse(
        run("retire", String(retiring), "--reason", "No longer needed"),
        "gh api graphql failed: label removal unavailable",
      );
      expect(issue(retiring).state, "a failed label repair cannot close the issue").toBe("OPEN");
      expect(issue(retiring).labels).toStrictEqual(["plan", "plan:drafting"]);
      const retired = run("retire", String(retiring), "--reason", "No longer needed");
      expectSuccess(retired, "retire an unassigned plan");
      expect(retired.stdout.trim()).toBe(`plan #${retiring} retired`);
      expect(issue(retiring).state).toBe("CLOSED");
      expect(issue(retiring).stateReason).toBe("NOT_PLANNED");
      expect(issue(retiring).labels).toStrictEqual(["plan"]);
      expect(issue(retiring).assignees, "retire claims the plan in the label edit").toStrictEqual([
        "plan-agent",
      ]);
      const draftingList = run("list", "--status", "drafting");
      expectSuccess(draftingList, "list drafting plans");
      expect(draftingList.stdout).toMatch(
        new RegExp(`^drafting\\t#${listed}\\tlisted drafting plan$`, "m"),
      );
      expect(draftingList.stdout).not.toMatch(/issue without plan label/);
      expect(draftingList.stdout).not.toMatch(new RegExp(`\\t#${retiring}\\t`));
      const retiredList = run("list", "--status", "retired");
      expectSuccess(retiredList, "list retired plans");
      expect(retiredList.stdout.trim()).toBe(`retired\t#${retiring}\tretired plan`);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list keeps the newest 500 plans, reads five pages of each kind, and advises that more plans may exist",
    () => {
      const { run, updateState, loadState } = planCliContext();
      // 501 open plans with distinct creation times; the list reads newest first and keeps 500 (#213, R21).
      updateState((state) => {
        for (let i = 0; i < 501; i += 1) {
          const number = state.nextIssue++;
          const createdAt = new Date(Date.parse("2026-08-20T20:00:00Z") + i * 1000).toISOString();
          state.issues.push({
            number,
            title: `bulk plan ${i}`,
            body: body(),
            state: "OPEN",
            stateReason: null,
            labels: ["plan", "plan:drafting"],
            assignees: ["plan-agent"],
            url: `https://github.com/DocksDocks/fixture/issues/${number}`,
            createdAt,
            updatedAt: createdAt,
            comments: [],
            events: [],
          });
        }
        state.calls = [];
      });
      const limitedList = run("list");
      expectSuccess(limitedList, "list limit advice");
      const lines = limitedList.stdout.trim().split("\n");
      expect(lines.at(-1)).toBe("advice: list stopped at 500 plans; more plans may exist");
      const rows = lines.slice(0, -1);
      expect(rows).toHaveLength(500);
      expect(rows[0], "the oldest plan is the one left out").toBe("drafting\t#2\tbulk plan 1");
      expect(rows.at(-1)).toBe("drafting\t#501\tbulk plan 500");
      const queries = loadState().calls.map((argv) => argv.join(" "));
      expect(queries.filter((query) => query.includes("hasIssuesEnabled"))).toHaveLength(5);
      expect(queries.filter((query) => query.includes("number body"))).toHaveLength(5);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list names an open plan without a contract marker unreadable",
    () => {
      const { run, updateIssue, createPlan } = planCliContext();
      // `show` refuses a body without a marker, so `list` does not offer it as planned (#213, R5).
      const unmarked = createPlan("unmarked plan");
      updateIssue(unmarked, (entry) => {
        entry.body = "No marker here.";
        entry.labels = ["plan", "plan:planned"];
      });
      const marked = createPlan("marked plan");
      const listed = run("list");
      expectSuccess(listed, "list with an unmarked plan");
      expect(listed.stdout.trim().split("\n")).toStrictEqual([
        `unreadable\t#${unmarked}\tunmarked plan`,
        `drafting\t#${marked}\tmarked plan`,
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list refuses a repository with issues turned off",
    () => {
      const { run, updateState, createPlan } = planCliContext();
      // gh issue list refused a repository with issues turned off; the GraphQL list does too (#213, R19).
      createPlan("plan before issues were turned off");
      updateState((state) => {
        state.repo.hasIssuesEnabled = false;
      });
      refuse(run("list"), "issues are disabled in DocksDocks/fixture");
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list prints open plans first, then closed plans, each in ascending number order",
    () => {
      const { run, updateIssue, createPlan, closedPlan } = planCliContext();
      // Interleave creation so number order differs from the open/closed grouping.
      const finished = closedPlan("finished plan");
      const drafting = createPlan("drafting plan");
      const retired = createPlan("retired plan");
      updateIssue(retired, (entry) => {
        entry.state = "CLOSED";
        entry.stateReason = "NOT_PLANNED";
        entry.labels = ["plan"];
      });
      const ongoing = createPlan("ongoing plan");
      updateIssue(ongoing, (entry) => {
        entry.labels = ["plan", "plan:ongoing"];
      });
      const listed = run("list");
      expectSuccess(listed, "list mixed open and closed plans");
      expect(listed.stdout.trim().split("\n")).toStrictEqual([
        `drafting\t#${drafting}\tdrafting plan`,
        `ongoing\t#${ongoing}\tongoing plan`,
        `finished\t#${finished.number}\tfinished plan`,
        `retired\t#${retired}\tretired plan`,
      ]);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "list refuses when an open plan that it keeps is missing from the body pages",
    () => {
      const { run, updateState, createPlan } = planCliContext();
      // The plan closes right after the first list request, so the request for open bodies does not return it.
      const plan = createPlan("closed while list reads");
      updateState((state) => {
        state.afterListOnce = { issue: plan, state: "CLOSED", stateReason: "NOT_PLANNED" };
      });
      const listed = run("list");
      refuse(listed, "the plan list changed while list read it; run list again");
      expect(listed.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS,
  );
});
