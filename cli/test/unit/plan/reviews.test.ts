import { describe, expect, it } from "vitest";

import { type ReviewKind, type Verdict, parseReviewComment } from "../../../src/plan/reviews";
import {
  PLAN_CLI_HOST_SUPPORTED,
  body,
  expectSuccess,
  planCliContext,
  refuse,
} from "../../lib/plan/harness";
import { SPAWN_TIMEOUT_MS } from "../../lib/spawnTimeout";

type ReviewCase = readonly [string, { kind: ReviewKind; verdict: Verdict } | undefined];

// The manager's response to round k follows the review blocks of round k+1 in one comment (E5).
const QUOTED = [
  "Repaired",
  "",
  "- Round 1, src/a.mjs:4: the finding `[HIGH] Bug - stale read` is fixed in commit abc1234.",
  "",
  "Rejected",
  "",
  "- Round 1, Step 2: the finding is rejected; the evidence is in Research.",
].join("\n");
const RESPONSE = `#### Manager response to round 1\n\n${QUOTED}`;
// Response lines that would open a block or set a verdict above the heading.
const FORGED =
  "### Code review round 1, lens correctness\nCode-review: blocked\n### Plan review round 1\nPlan-review: blocked";

describe("plan reviews", () => {
  it("a fenced example at the first column holds no verdict or block heading", () => {
    // A fenced example of a pass line is no verdict (#213, R4); CRLF lines read the same.
    const cases: ReadonlyArray<ReviewCase> = [
      [
        "### Code review round 2\n\n```\nCode-review: pass\n```\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 2\r\n\r\n~~~text\r\nCode-review: pass\r\n~~~\r\nCode-review: blocked",
        { kind: "code", verdict: "blocked" },
      ],
      // A closing fence may have up to three spaces before it, so the live pass after it counts.
      [
        "### Code review round 2\n\n```\nCode-review: pass\n  ```\nCode-review: pass",
        { kind: "code", verdict: "pass" },
      ],
      // A fenced heading opens no block, so a verdict-like prose line after the fence stays prose.
      [
        "### Plan review round 2\n\nPlan-review: pass\n\n```\n### Plan review round 3\n```\nPlan-review: pending checks",
        { kind: "plan", verdict: "pass" },
      ],
      // An info string may hold U+2028 or U+2029, so the fence opens and a fenced-only pass is no record.
      ["### Code review round 2\n\n~~~text\u2028title\nCode-review: pass\n~~~", undefined],
      ["### Code review round 2\n\n~~~text\u2029title\nCode-review: pass\n~~~", undefined],
      ["### Code review round 2\n\n````\n```\nCode-review: pass\n```\n````", undefined],
      // A fenced heading opens no block; a fenced verdict that is stricter than the block verdict keeps the stricter one,
      // as a fenced `[HIGH]` does.
      [
        "### Plan review round 2\n\nPlan-review: pass\n\n```\n### Plan review round 3\nPlan-review: blocked\n```",
        { kind: "plan", verdict: "blocked" },
      ],
      [
        "### Plan review round 2\n\nPlan-review: repair\n\n```\n### Plan review round 3\nPlan-review: pass\n```",
        { kind: "plan", verdict: "repair" },
      ],
      // Raw HTML and a first-column fence in one comment make the fence pairing uncertain, so the comment reads blocked,
      // also when every verdict line says pass.
      [
        "### Code review round 2, lens correctness\n\nCode-review: pass\n\n<pre>\n~~~\n</pre>\n\n~~~\n#### Manager response to round 1\n~~~\n\n### Code review round 2, lens text\n\nCode-review: pass",
        { kind: "code", verdict: "blocked" },
      ],
      [
        "### Plan review round 2\n\nPlan-review: pass\n\n<!-- note -->\n```\nPlan-review: pass\n```",
        { kind: "plan", verdict: "blocked" },
      ],
      // Raw HTML without a fence, or a fence without raw HTML, reads as before.
      [
        "### Code review round 2\n\nCode-review: pass\n\n<details>\n<summary>Notes</summary>\nNone.\n</details>",
        { kind: "code", verdict: "pass" },
      ],
      [
        "### Code review round 2\n\nCode-review: pass\n\nSee a <b>bold</b> word.\n\n```\nexample\n```",
        { kind: "code", verdict: "pass" },
      ],
      // Raw HTML and a fence in the manager response do not change the verdict.
      [
        "### Code review round 2\n\nCode-review: pass\n\n#### Manager response to round 1\n\n<!-- note -->\n```\nexample\n```",
        { kind: "code", verdict: "pass" },
      ],
      // A bare carriage return ends a line, and an info string may hold U+2028 or U+2029.
      [
        "### Code review round 2\r\r```\rCode-review: pass\r```\rCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 2\n\n~~~text\u2028title\nCode-review: pass\n~~~\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 2\n\n~~~text\u2029title\nCode-review: pass\n~~~\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      // A response heading inside an HTML comment makes the cut uncertain, so the comment reads blocked.
      [
        "### Code review round 2, lens correctness\n\nCode-review: pass\n\n<!--\n#### Manager response to round 1\n-->\n\n### Code review round 2, lens text\n\nCode-review: fixes-required\n\n#### Manager response to round 1\n\nRepaired: none.",
        { kind: "code", verdict: "blocked" },
      ],
      // A lens heading whose title holds U+2028 still opens its block.
      [
        "### Code review round 2, lens correctness\n\nCode-review: pass\n\n### Code review round 2, lens\u2028text\n\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      // A fenced response heading and a quote fence left open at the end of its quote hide no later panel block.
      [
        "### Code review round 2\n\nCode-review: pass\n\n```\n#### Manager response to round 1\n```\n### Code review round 2, lens text\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
      // A fence inside a quote is text, so it cannot stay open past its quote and hide a later panel block.
      [
        "### Code review round 2\n\nCode-review: pass\n> ```\n> example\n### Code review round 2, lens text\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
    ];
    for (const [text, expected] of cases)
      expect(parseReviewComment(text), text).toStrictEqual(expected);
  });

  it("a fence closes only at a fence line of its own character, and an indented or inline fence is no fence", () => {
    // Top-level GFM fences (#213, R4).
    const cases: ReadonlyArray<ReviewCase> = [
      // Inside an unquoted fence, a quote marker or a list marker before the backticks does not close it, so a
      // fenced-only pass is no record.
      ["### Code review round 2\n\n```\n> ```\nCode-review: pass\n```", undefined],
      ["### Code review round 2\n\n```\n- ```\nCode-review: pass\n```", undefined],
      // A fence line indented four spaces is code text: it neither opens nor closes a fence.
      [
        "### Code review round 2\n\n    ```\nCode-review: pass\n    ```",
        { kind: "code", verdict: "pass" },
      ],
      ["### Code review round 2\n\n```\n    ```\nCode-review: pass\n```", undefined],
      // A backtick in the info string makes the line inline code, not a fence.
      ["### Code review round 2\n\n```x```\nCode-review: pass", { kind: "code", verdict: "pass" }],
      // Raw HTML with inline code that starts with three backticks, and no fence, reads as written.
      [
        "### Code review round 2\n\nCode-review: pass\n\n<b>note</b>\n```x``` is inline code.",
        { kind: "code", verdict: "pass" },
      ],
      // A lens block quotes an example inside a markdown fence; the next lens block still counts.
      [
        "### Code review round 2, lens correctness\n\nCode-review: pass\n\n```markdown\n> ```\n> Code-review: pass\n> ```\n```\n\n### Code review round 2, lens security\n\nCode-review: blocked",
        { kind: "code", verdict: "blocked" },
      ],
    ];
    for (const [text, expected] of cases)
      expect(parseReviewComment(text), text).toStrictEqual(expected);
  });

  it("review parsing accepts flexible prose, and a severe finding turns a code pass into fixes-required", () => {
    // Review prose is flexible. Severity still prevents an unsafe code pass.
    const reviewCases: ReadonlyArray<ReviewCase> = [
      ["## Plan review (round 2)\n\nplan-review: pass", { kind: "plan", verdict: "pass" }],
      [
        "### Plan review — round 2\n\nplan review: changes\nParser — records are lost.",
        { kind: "plan", verdict: "repair" },
      ],
      [
        "# Code review\n\ncode-review: approved\nHIGH: The parser loses data.",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 1 - 2026-09-09\nCode-review: pass\n- [low] src/api.mjs:3 - the high-level API name is unclear; critical path is fine - rename",
        { kind: "code", verdict: "pass" },
      ],
      [
        "### Code review round 1 - 2026-09-09\nCode-review: pass\n- [HIGH] src/api.mjs:3 - data loss - fix",
        { kind: "code", verdict: "fixes-required" },
      ],
      // Marks inside a word of a heading or a severity still read as Markdown there.
      [
        "### C*ode* review round 1\n\nCode-review: pass\n\nH*IGH*: data loss.",
        { kind: "code", verdict: "fixes-required" },
      ],
      ["**### Code review round 1**\n\n**Code-review: pass**", { kind: "code", verdict: "pass" }],
      ["### Code review round 2\n\n**Code-review:** `pass`.", { kind: "code", verdict: "pass" }],
      [
        "## **Plan review** round 1\n\n- Plan-review: _repair_",
        { kind: "plan", verdict: "repair" },
      ],
      [
        "### Code review round 3\nCode-review: pass\n- **[HIGH]** src/example.mjs:1 - data loss - fix",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 3\nCode-review: pass\n1. Bug [critical] src/example.mjs:1 - data loss - fix",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 3\nCode-review: pass\n> Severity: High",
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        "### Code review round 3\nCode-review: pass\n\n```\n- [HIGH] src/example.mjs:1 - data loss - fix\n```",
        { kind: "code", verdict: "fixes-required" },
      ],
    ];
    for (const [text, expected] of reviewCases)
      expect(parseReviewComment(text)).toStrictEqual(expected);
  });

  it("a review comment with several blocks yields the most severe verdict of its kind (#98)", () => {
    // A code-review round posts every lens block in one comment (#98), so no block may hide another's verdict.
    const lens = (name: string, verdict: string, finding = "None."): string =>
      `### Code review round 1, lens ${name}\n\nCode-review: ${verdict}\n\n## Standards\n\n${finding}\n\n## Spec\n\nNone.`;
    const comment = (...blocks: ReadonlyArray<string>): string => blocks.join("\n\n");
    const cases: ReadonlyArray<ReviewCase> = [
      [
        comment(
          lens("correctness", "pass"),
          lens("spec-and-tests", "pass"),
          lens("text-and-safety", "blocked"),
        ),
        { kind: "code", verdict: "blocked" },
      ],
      [
        comment(
          lens("correctness", "pass", "- [MEDIUM] Bug - src/a.mjs:4 - stale read - re-read"),
          lens("spec-and-tests", "pass"),
        ),
        { kind: "code", verdict: "pass" },
      ],
      [
        "### Plan review round 2\n\nPlan-review: pass\n\nNone.\n\n### Plan review round 2\n\nPlan-review: repair\n\n- goal_fit - Step 1 - gap - fix",
        { kind: "plan", verdict: "repair" },
      ],
      // A verdict line of the other kind is prose inside the block and does not count.
      [
        "### Code review round 2, delta\n\nPlan-review: blocked\nCode-review: pass\n\nNone.",
        { kind: "code", verdict: "pass" },
      ],
      // An unknown verdict word in any block reads as blocked, so the comment cannot keep an older pass.
      [
        comment(lens("correctness", "pass"), lens("spec-and-tests", "maybe")),
        { kind: "code", verdict: "blocked" },
      ],
      // Heading markers need a space or a tab after them, as in GFM, so U+2028 there opens no block.
      [
        "### Code review round 2\n\nCode-review: pass\n\n###\u2028Code review round 3\nCode review: pending checks",
        { kind: "code", verdict: "pass" },
      ],
      // The whole verdict word counts: a word outside the table, in any script, reads as blocked.
      [
        comment(lens("correctness", "pass"), lens("spec-and-tests", "pass2")),
        { kind: "code", verdict: "blocked" },
      ],
      [
        comment(lens("correctness", "pass"), lens("spec-and-tests", "pass.2")),
        { kind: "code", verdict: "blocked" },
      ],
      // A fenced word outside the table reads as blocked too, also when it is the only verdict line.
      [
        "### Code review round 2\n\nCode-review: pass\n\n```\nCode-review: pass2\n```",
        { kind: "code", verdict: "blocked" },
      ],
      [
        "### Code review round 2\n\n```\nCode-review: pass2\n```",
        { kind: "code", verdict: "blocked" },
      ],
      // A mark inside a word is no Markdown, so `pa_ss` is no `pass`, live or fenced.
      [
        comment(lens("correctness", "pass"), lens("spec-and-tests", "pa_ss")),
        { kind: "code", verdict: "blocked" },
      ],
      [
        "### Code review round 2\n\n```\nCode-review: pa_ss\n```",
        { kind: "code", verdict: "blocked" },
      ],
      // A code span gives its content literally, and a lone mark is no word.
      [
        "### Code review round 2\n\nCode-review: pass\n\n### Code review round 2, lens text\n\nCode-review: `pass_`",
        { kind: "code", verdict: "blocked" },
      ],
      [
        "### Code review round 2\n\n```\nCode-review: `pass_`\n```",
        { kind: "code", verdict: "blocked" },
      ],
      [
        "### Code review round 2\n\nCode-review: pass\n\n### Code review round 2, lens text\n\nCode-review: _",
        { kind: "code", verdict: "blocked" },
      ],
      // Only fixed shapes give a verdict word; a mark that encloses nothing or a suffix after a span reads as blocked.
      ...[
        "Code-review:_pass",
        "Code-review: `pass`2",
        "* Code-review: pass*",
        "**Code-review:** pass**",
        "Code-review:_pass (formerly Code-review: pass)",
        "Code-review:_ pass",
        "** Code-review: pass**",
        "* * Code-review: pass*",
        "Code-review: _`pass_`",
      ].map((line): ReviewCase => [
        `### Code review round 2\n\nCode-review: pass\n\n### Code review round 2, lens text\n\n${line}`,
        { kind: "code", verdict: "blocked" },
      ]),
      [
        comment(lens("correctness", "pass"), lens("spec-and-tests", "échec")),
        { kind: "code", verdict: "blocked" },
      ],
      // A heading under a list item that splits off the first block leaves the later verdict in force.
      [
        "### Code review round 2\n\n- note\n  ### Code review round 1\n\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
    ];
    for (const [text, expected] of cases)
      expect(parseReviewComment(text), text.split("\n")[0]).toStrictEqual(expected);
  });

  it("only the first verdict line of each review block counts, so prose cannot hide or forge a verdict (#98)", () => {
    // A block starts at the comment's first line or at a later Markdown heading that names the same review kind.
    const cases: ReadonlyArray<ReviewCase> = [
      // A prose line that looks like a verdict must not make the comment unreadable and revive an older pass.
      [
        "### Code review round 2, delta\n\nCode-review: fixes-required\n\n- [HIGH] Bug - src/a.mjs:4 - stale read - re-read\n- Code review: missing test for the retry path",
        { kind: "code", verdict: "fixes-required" },
      ],
      // A delta block that quotes the previous round's verdict keeps its own verdict.
      [
        "### Code review round 2, delta\n\nCode-review: pass\n\nRound 1 returned:\n> Code-review: fixes-required\nThe finding is fixed.",
        { kind: "code", verdict: "pass" },
      ],
      // A list item that starts with the review kind is prose, not a new block.
      [
        "### Plan review round 3\n\nPlan-review: pass\n\n- plan review notes for the next round\n\nNone.",
        { kind: "plan", verdict: "pass" },
      ],
      // A quoted heading of an earlier round is prose, so its quoted verdict cannot open a block that wins.
      [
        "### Code review round 2, delta\n\nCode-review: pass\n\n## Previous findings\n\n> ### Code review round 1\n> Code-review: fixes-required\n\n## Standards\n\nNone.",
        { kind: "code", verdict: "pass" },
      ],
      // A list item that holds a heading is prose too, also with a `*` marker, which is not emphasis here.
      [
        "### Plan review round 3\n\nPlan-review: pass\n\nNone.\n\n- ### Plan review round 2\n- Plan-review: repair",
        { kind: "plan", verdict: "pass" },
      ],
      [
        "### Code review round 2, delta\n\nCode-review: pass\n\n## Previous findings\n\n* ### Code review round 1\n* Code-review: fixes-required",
        { kind: "code", verdict: "pass" },
      ],
      // An emphasized heading title still starts a block.
      [
        "### Code review round 1, lens correctness\n\nCode-review: pass\n\n### **Code review round 1, lens text-and-safety**\n\nCode-review: blocked\nMissing input: the focus diff.",
        { kind: "code", verdict: "blocked" },
      ],
      // A heading indented by up to three spaces is still a Markdown heading, so its block counts.
      [
        "### Code review round 1, lens correctness\n\nCode-review: pass\n\n   ### Code review round 1, lens spec-and-tests\n\nCode-review: fixes-required",
        { kind: "code", verdict: "fixes-required" },
      ],
    ];
    for (const [text, expected] of cases)
      expect(parseReviewComment(text), text).toStrictEqual(expected);
  });

  it("the manager response heading stops verdict and severity reading for the rest of the comment (E5)", () => {
    const pass = "### Code review round 2, delta\n\nCode-review: pass\n\nNone.";
    const cases: ReadonlyArray<ReviewCase> = [
      // A pass block followed by a response that quotes [HIGH] reads as pass.
      [`${pass}\n\n${RESPONSE}`, { kind: "code", verdict: "pass" }],
      // The same text above the heading reads as fixes-required.
      [`${pass}\n\n${QUOTED}`, { kind: "code", verdict: "fixes-required" }],
      [`${pass}\n\n${QUOTED}\n\n${RESPONSE}`, { kind: "code", verdict: "fixes-required" }],
      // Block headings and verdict lines after the heading count for nothing.
      [`${pass}\n\n${RESPONSE}\n${FORGED}`, { kind: "code", verdict: "pass" }],
      [`${pass}\n\n${FORGED}`, { kind: "code", verdict: "blocked" }],
      // The heading starts at the first column and may end in spaces; an indented one is text, so it cuts off nothing.
      [
        `${pass}\n\n#### Manager response to round 12  \n${QUOTED}`,
        { kind: "code", verdict: "pass" },
      ],
      [
        `${pass}\n\n   #### Manager response to round 12\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      // A list item that quotes the heading cuts off no later block.
      [
        `${pass}\n\n- \`\`\`\n  #### Manager response to round 1\n  \`\`\`\n\n### Code review round 2, lens text\n\nCode-review: blocked`,
        { kind: "code", verdict: "blocked" },
      ],
      // Other lines are not the heading, so the quoted text still counts.
      [
        `${pass}\n\n    #### Manager response to round 1\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        `${pass}\n\n### Manager response to round 1\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        `${pass}\n\n##### Manager response to round 1\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        `${pass}\n\n#### Manager response to round one\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        `${pass}\n\n> #### Manager response to round 1\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      [
        `${pass}\n\n#### Manager response to round 1: notes\n${QUOTED}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      // A plan-review round keeps its verdict above the heading.
      [
        `### Plan review round 2\n\nPlan-review: pass\n\nNone.\n\n${RESPONSE}\n${FORGED}`,
        { kind: "plan", verdict: "pass" },
      ],
      // A finding of the review blocks still counts.
      [
        `### Code review round 2, delta\n\nCode-review: pass\n\n- [HIGH] Bug - src/a.mjs:4 - stale read - re-read\n\n${RESPONSE}`,
        { kind: "code", verdict: "fixes-required" },
      ],
      // A response heading as the first line is no review comment.
      [RESPONSE, undefined],
    ];
    for (const [text, expected] of cases)
      expect(parseReviewComment(text), text).toStrictEqual(expected);
  });

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "show reads a pass from a round comment that holds the manager response (E5)",
    () => {
      const { run, addIssueComment, createPlan } = planCliContext();
      const plan = createPlan("round comment with response");
      addIssueComment(
        plan,
        `### Code review round 2, lens correctness\n\nCode-review: pass\n\nNone.\n\n${RESPONSE}`,
      );
      const shown = run("show", String(plan));
      expectSuccess(shown, "show a round comment with a response");
      expect(shown.stdout).toMatch(/^reviews: plan=none code=pass$/m);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "show reads the most severe verdict of a lens comment (#98)",
    () => {
      const { run, addIssueComment, createPlan } = planCliContext();
      const plan = createPlan("lens comment");
      addIssueComment(
        plan,
        [
          "### Code review round 1, lens correctness\n\nCode-review: pass\n\nNone.",
          "### Code review round 1, lens spec-and-tests\n\nCode-review: pass\n\nNone.",
          "### Code review round 1, lens text-and-safety\n\nCode-review: blocked\n\nThe focus diff was unreadable.",
        ].join("\n\n"),
      );
      const shown = run("show", String(plan));
      expectSuccess(shown, "show a lens comment");
      expect(shown.stdout).toMatch(/^reviews: plan=none code=blocked$/m);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "show reports only trusted reviews, and an older timestamp cannot override a newer verdict",
    () => {
      const { run, updateIssue, addIssueComment, createPlan } = planCliContext();
      const reviews = createPlan("trusted reviews");
      addIssueComment(reviews, "## Plan review (round 2)\n\nplan-review: pass");
      addIssueComment(reviews, "## Plan review\n\nplan-review: blocked", "foreign-agent");
      addIssueComment(reviews, "## Code review\n\ncode-review: pass\nHIGH: Data loss.");
      let shown = run("show", String(reviews));
      expectSuccess(shown, "trusted review show");
      expect(shown.stdout).toMatch(/^reviews: plan=pass code=fixes-required$/m);
      addIssueComment(reviews, "## Plan review\n\nplan-review: repair");
      updateIssue(reviews, (entry) => {
        const latest = entry.comments?.at(-1);
        if (latest === undefined) throw new Error(`plan #${reviews} has no comment`);
        latest.createdAt = "2020-01-01T00:00:00Z";
      });
      shown = run("show", String(reviews));
      expectSuccess(shown, "timestamp review show");
      expect(shown.stdout).toMatch(/^reviews: plan=pass code=fixes-required$/m);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "show reads reviews beyond the first comment page and fails closed when a comment page fails",
    () => {
      const { run, updateState, addIssueComment, createPlan } = planCliContext();
      const pagedReviews = createPlan("reviews beyond first page");
      // One kind's verdict sits only on the first comment page and the other kind's only on the second (#213, R16).
      addIssueComment(pagedReviews, "## Plan review\n\nplan-review: pass");
      updateState((state) => {
        const entry = state.issues.find((candidate) => candidate.number === pagedReviews);
        if (entry?.comments === undefined) throw new Error(`plan #${pagedReviews} has no comments`);
        state.nextComment ??= 1;
        for (let index = 0; index < 99; index += 1) {
          const id = state.nextComment++;
          entry.comments.push({
            id,
            body: "Routine discussion.",
            author: "foreign-agent",
            createdAt: new Date(Date.parse("2026-08-20T20:00:00Z") + id * 1000).toISOString(),
          });
        }
      });
      addIssueComment(pagedReviews, "## Code review\n\ncode-review: repair", "plan-agent");
      addIssueComment(pagedReviews, "## Code review\n\ncode-review: pass", "foreign-agent");
      const pagedShow = run("show", String(pagedReviews));
      expectSuccess(pagedShow, "show all review pages");
      expect(pagedShow.stdout, "late trusted review wins").toMatch(
        /^reviews: plan=pass code=fixes-required$/m,
      );
      updateState((state) => {
        state.graphqlError = { on: "page", errors: [{ message: "comment page unavailable" }] };
      });
      const brokenReviewPage = run("show", String(pagedReviews));
      expect(brokenReviewPage.status, "a failed review page cannot produce a verdict").toBe(1);
      expect(brokenReviewPage.stderr).toMatch(/graphql/i);
      expect(brokenReviewPage.stdout).toBe("");
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "show reads a review record written in bold Markdown",
    () => {
      const { run, addIssueComment, createPlan } = planCliContext();
      const boldReview = createPlan("bold review record");
      addIssueComment(boldReview, "**### Code review round 1**\n\n**Code-review: pass**");
      const boldShow = run("show", String(boldReview));
      expectSuccess(boldShow, "show bold review record");
      expect(boldShow.stdout).toMatch(/^reviews: plan=none code=pass$/m);
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "status planned or ongoing requires research that replaces the placeholder (#78)",
    () => {
      const { run, issue, createPlan } = planCliContext();
      // A drafted plan enters planned or ongoing only after research replaces the placeholder (#78).
      const unresearched = createPlan(
        "unresearched plan",
        body().replace("The parser loses mixed-case records.", "_Not researched yet._"),
      );
      refuse(
        run("status", String(unresearched), "planned"),
        "status planned requires a filled Research section",
      );
      refuse(
        run("status", String(unresearched), "ongoing"),
        "status ongoing requires a filled Research section",
      );
      expect(issue(unresearched).labels, "a refused status keeps the phase label").toStrictEqual([
        "plan",
        "plan:drafting",
      ]);
      expectSuccess(
        run("status", String(unresearched), "blocked", "--reason", "Waiting for research"),
        "an unresearched plan can still block",
      );
      const emptyResearch = createPlan(
        "empty research",
        body().replace("The parser loses mixed-case records.", ""),
      );
      refuse(
        run("status", String(emptyResearch), "planned"),
        "status planned requires a filled Research section",
      );
      const quotedPlaceholder = createPlan(
        "research quotes the placeholder",
        body().replace(
          "The parser loses mixed-case records.",
          "A new plan holds `_Not researched yet._` until research is published.",
        ),
      );
      const quotedStatus = run("status", String(quotedPlaceholder), "planned");
      expectSuccess(quotedStatus, "research prose may quote the placeholder");
      expect(quotedStatus.stdout, "quoted placeholder is not unfilled research").not.toMatch(
        /Research is not filled/,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "a plan-review pass covers evidence edits, and a Research edit after it advises a new round (#78)",
    () => {
      const { addIssueComment, createPlan, edit } = planCliContext();
      // A plan-review pass covers the body that the reviewer read (#78).
      const reviewed = createPlan("reviewed plan");
      addIssueComment(reviewed, "### Plan review round 1\n\nPlan-review: pass\n\nNone.");
      const resultsEdit = edit(reviewed, (text) => text.replace("Not run.", "Smoke passed."));
      expectSuccess(resultsEdit, "edit verification results after a plan pass");
      expect(resultsEdit.stdout, "evidence edits need no new round").not.toMatch(
        /plan review passed before this edit/,
      );
      const researchEdit = edit(reviewed, (text) =>
        text.replace(
          "The parser loses mixed-case records.",
          "The parser loses mixed-case records.\n\nDecision: keep the old date format.",
        ),
      );
      expectSuccess(researchEdit, "edit research after a plan pass");
      expect(researchEdit.stdout).toMatch(
        /^advice: plan review passed before this edit; changed sections: Research; review all such edits in one plan-review round before code that depends on them or the next code-review round$/m,
      );
    },
    SPAWN_TIMEOUT_MS,
  );

  it.skipIf(!PLAN_CLI_HOST_SUPPORTED)(
    "a plan-review pass covers the Mode line and the delegation line that a yolo run sets (#111)",
    () => {
      const { addIssueComment, createPlan, edit } = planCliContext();
      // A yolo run that adopts a passed plan adds the delegation line and sets the Mode; neither changes reviewed work (#111).
      const delegation = "Yolo: the user delegated every decision except the merge to the agent.";
      const goals: ReadonlyArray<readonly [string, string, boolean, string?]> = [
        [
          "a yolo run adopts the plan",
          `Fix the parser.\n\n${delegation}\n\nmode: plan-and-implement`,
          false,
        ],
        [
          "an indented delegation line in the goal paragraph",
          `Fix the parser.\n   ${delegation}  \n\n   Mode: plan-and-implement`,
          false,
        ],
        [
          "a delegation line between two goal paragraphs",
          `Fix the parser.\n\n${delegation}\n\nKeep the flags.\n\nMode: plan-and-implement`,
          false,
          "Fix the parser.\n\nKeep the flags.",
        ],
        [
          "a delegation line before an unchanged goal",
          `${delegation}\n\nFix the parser.\n\nMode: plan-and-implement`,
          false,
        ],
        // Blank lines and indentation inside an example are reviewed work, also in a yolo Goal.
        [
          "a blank line removed inside a fenced example of a yolo goal",
          `Fix the parser.\n\n\`\`\`text\na\n\nb\n\`\`\`\n\n${delegation}\n\nMode: plan-and-implement`,
          true,
          `Fix the parser.\n\n\`\`\`text\na\n\n\nb\n\`\`\`\n\n${delegation}`,
        ],
        [
          "the indentation of a leading code example changed in a yolo goal",
          `        run --fast\n\nFix the parser.\n\n${delegation}\n\nMode: plan-and-implement`,
          true,
          `    run --fast\n\nFix the parser.\n\n${delegation}`,
        ],
        [
          "a Mode change without the delegation line",
          "Fix the parser.\n\nMode: plan-and-implement",
          true,
        ],
        [
          "a delegation line in a code span",
          `Fix the parser.\n\n\`${delegation}\`\n\nMode: plan-and-implement`,
          true,
        ],
        [
          "a goal change beside the delegation line",
          `Fix the parser and the printer.\n\n${delegation}\n\nMode: plan-and-implement`,
          true,
        ],
        // Example text is reviewed work: only a live delegation line outside fenced or indented code is exempt.
        [
          "a delegation line added only inside an existing fenced example",
          `Fix the parser.\n\n\`\`\`text\nexample output\n${delegation}\n\`\`\`\n\n${delegation}\n\nMode: plan-and-implement`,
          true,
          "Fix the parser.\n\n```text\nexample output\n```",
        ],
        [
          "a delegation line removed from a fenced example beside the live line",
          `Fix the parser.\n\n\`\`\`text\nexample output\n\`\`\`\n\n${delegation}\n\nMode: plan-and-implement`,
          true,
          `Fix the parser.\n\n\`\`\`text\nexample output\n${delegation}\n\`\`\`\n\n${delegation}`,
        ],
        [
          "a delegation line only in an indented example",
          `Fix the parser.\n\n    ${delegation}\n\nMode: plan-and-implement`,
          true,
        ],
      ];
      for (const [name, goal, advises, reviewedGoal = "Fix the parser."] of goals) {
        const reviewedBody = body()
          .replace("Mode: plan-and-implement", "Mode: plan-only")
          .replace("Fix the parser.\n\nMode: plan-only", `${reviewedGoal}\n\nMode: plan-only`);
        const reviewed = createPlan(name, reviewedBody);
        addIssueComment(reviewed, "### Plan review round 1\n\nPlan-review: pass\n\nNone.");
        const goalEdit = edit(reviewed, (text) =>
          text.replace(`${reviewedGoal}\n\nMode: plan-only`, goal),
        );
        expectSuccess(goalEdit, `edit goal: ${name}`);
        if (advises)
          expect(goalEdit.stdout, name).toMatch(
            /^advice: plan review passed before this edit; changed sections: Goal; /m,
          );
        else expect(goalEdit.stdout, name).not.toMatch(/plan review passed before this edit/);
      }
    },
    SPAWN_TIMEOUT_MS,
  );
});
