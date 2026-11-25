## Plan run: #157 Keep delegated edits inside the plan worktree

Pull request: https://github.com/DocksDocks/docks/pull/159. Checks: all 5 passed. Reviewed head: `4c668b14`.

### What changed
- A new practice, `Delegated work`, for every run: each subagent gets the absolute worktree path and starts each shell command in it; before the plan worktree exists, the session checkout is the working folder (`plugins/plan-lifecycle/skills/productivity/plan-manager/references/practices.md`).
- When the plan works in a separate worktree, the run lists the session checkout before a dispatch group and again after each agent returns, compares the two files, undoes nothing there, redoes each stray change in the worktree, and reports each changed path under Kept resources. Recover after compaction and Teardown compare the stored listings again.
- A shipped script, `checkout-state.sh`, prints one line per tracked and untracked path with its raw state on disk (blob id and executable bit, link target, submodule lines, `missing`, `special`), so a dirty checkout or a clean filter hides no change (`plugins/plan-lifecycle/skills/productivity/plan-manager/scripts/checkout-state.sh`).
- `plan-manager/SKILL.md` phases 4 to 6 and `yolo/SKILL.md` Implement and Review loops name the practice; the CI targeting test expects the second shell script of `plan-lifecycle`.

### Decisions and corrections
- Request correction (plan review round 1, extended in rounds 3 to 6): the Goal asked for an empty `git status` and an undo with the edit tool. The worktree exists because the checkout is dirty, and no record proves who wrote the current bytes of a file that the user may edit too, so the run compares listings and undoes nothing.

### Delegated decisions
- Where the rule lives: a practices section with pointers. Rejected: a sentence in Work during a round (read too late), a contract rule (no helper can check it). Reversibility: one section. Record: Research D1.
- How a stray edit is found: the per-path listing script. Rejected: an empty status (fails on a dirty checkout), an inline command (misses filtered changes), one aggregate fingerprint (names no path), file watching (not portable). Reversibility: one script. Record: Research D2.
- How a stray edit is prevented: absolute paths and `cd <worktree> &&`. Rejected: `git -C` (moves no redirect). Record: Research D3.
- What the run does with a stray edit: undo nothing, redo in the worktree, report. Rejected: undo by hunk or by `HEAD` blob (can remove user work). Reversibility: text. Record: Research D4.
- Recovery after compaction: compare the stored listings, keep them until Teardown. Rejected: a group record of agent ids (not available before return). Record: Research D5.
- A patch release. Record: Research D6.
- The first stall of plan review at round 10: switch to delta rounds and extend by 10. Rejected: asking (an untried approach had evidence), more full rounds (the stalled path). Record: `Redesigned` entry of the round 10 comment.
- The Goal correction above. Record: Research, request correction.

### Reviews
Plan review passed in round 11 (rounds 1 to 10 full, round 11 delta after the first stall). Code review passed in round 3 (round 1 panel, round 2 panel after a merge of `main`, round 3 delta).
Open findings: none.

### Verification
- `node --test scripts/tests/plan-cli/checkout-state.test.mjs`: 14 of 14.
- `bun scripts/ci.mjs --plugin plan-lifecycle`: exit 0 on the reviewed head.
- A5 scratch run of the practice: the listing diff named only the stray path; the user's dirty file and the worktree edit did not appear.
- `verify` skill on the reviewed head: V1 `claude plugin validate --strict` passed for both plugins and the marketplace (`ICON_MISSING` warnings only); V2 `node scripts/tests/plan-cli.mjs` 194 of 194, with `checkout-state.test.mjs`; V5 the `plan-lifecycle` self-test passed. V3 and V4 do not apply: no hook changed.

### Limits and failures
- The listing does not cover ignored files; the path report of each subagent covers them.
- During this session, a fix subagent of plan #155 edited the main checkout through a relative path and undid it with `git restore`. The main checkout was clean before that dispatch and after it, so no work was lost; it is the failure that this practice now catches and forbids.

### Kept resources
- After `Merge now`: none.
- After `Leave pull request open`: the linked worktree and the branch `157-keep-delegated-edits-inside-the-plan-worktree`.

### After merge
- Step `release`: one `plan-lifecycle` release for #153 and #157 (0.22.0 to 0.23.0), with its own question.

## Checklist
- [x] `bun scripts/ci.mjs` passes - the selected-plugin gate `bun scripts/ci.mjs --plugin plan-lifecycle` passed on the reviewed head, and CI ran `scripts/ci.mjs` and passed
- [x] Tested locally with the `verify` skill (`.agents/skills/verify`) - V1, V2, and V5 passed on the reviewed head; V3 and V4 do not apply
- [x] Code review passed - round 3, delta, `Code-review: pass` with no open finding

Closes #157

