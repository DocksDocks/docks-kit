## Plan run: #216 Fix the review-benchmark script and skill-guard defects that the 2026-11-23 review benchmark found

Reviewed head: `2db40623` (code) and `4e83f5e3` (plan). The branch head adds merges of `main` (#215 and the dependency upgrade #224).

### What changed
- **Report-section guard** (`cli/src/skills/kitGate.ts`, new `markdownHeadings.ts`): counts real headings with Bun's CommonMark parser (`Bun.markdown`). A stale Report section, or one hidden in an unclosed fence or comment, fails. A heading that holds raw inline HTML fails closed. Under Node the parser runs in a Bun child; a missing Bun or bad child output fails the check.
- **review-benchmark `prepare.mjs`:**
  - Variant copies and agents get commit-pinned names.
  - A copy folder inside another copy, or through a symbolic link, is refused.
  - A variant must name an existing regular `plan-reviewer/SKILL.md` file as a whole path.
  - Agents are rendered before any copy changes.
  - `loop --fixer-patch` drops the old fixer facts, and a net-zero patch stops.
- **review-benchmark `score.mjs`:**
  - A transcript must name the prompt's agent.
  - Only `repaired` counts as a repair.
  - A held-out case needs its key file.
  - Quoted paths parse whole.
  - The read scope checks every existing path interpretation and fails closed.
  - Doubtful extras get their own count.
  - Each transcript is decoded once.
- No version bump: the changed checks run only in `bun run check`.

### Decisions and corrections
Each redesign under the Stall rule is recorded in the plan's Research:
- R56: the CommonMark parser, then inline HTML fails closed;
- R52: symbolic-link copy folders fail closed;
- R67: every interpretation must be in scope, the scoring-time limit, and no further probe sharing.

### Reviews
Plan review passed in round 23. Code review passed in round 9.
Open findings: the `Unreached:` LOW findings and the recorded R67 limits are in #225.

### Verification
- a1: `bunx vitest run --project unit cli/test/unit/plugin/skills.test.ts`: 72 passed, also on the merged skill tree of #215.
- a2: `bunx vitest run --project review-benchmark`: 17 files, 311 tests passed.
- a3: `bun run check` on `4e83f5e3`. Every check except the unit tests passes. The unit tests fail only on the baseline `dependencyPins.test.ts` assertion and on 30000 ms timeouts under machine load, and each timed-out file passes alone. An earlier run on `eb518b0d` with low load had no timeout. On `7e96a137`: a1, a2, `lint:effect`, typecheck, and `check:generated` pass.
- a4: `./docks-kit sync --dry-run` exits 0.
- a5: `bun run smoke:package` exits 0.
- a6: `bun run check:generated` exits 0.

## Checklist
- [ ] Required checks pass on the reviewed head
- [x] Tested locally: a1 to a6 of #216
- [x] Code review passed (round 9 delta)

Closes #216

