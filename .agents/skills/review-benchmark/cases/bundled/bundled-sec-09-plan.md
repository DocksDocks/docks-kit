## Plan run: #172 Ship docks and plan-lifecycle as native omp packages

Pull request: https://github.com/DocksDocks/docks/pull/177. Checks: 5 of 5 passed. Reviewed head: `19c2f0227edf3ccfe0b4832db61770e8ec750cd4`.

### What changed
- Each skill moved from `plugins/<plugin>/skills/<category>/<name>/` to `plugins/<plugin>/skills/<name>/`, because omp finds plugin skills only one level below `skills/` (`plugins/*/skills/`).
- Each plugin has a `package.json` with an `omp` block, and the repository has one catalog at `.omp-plugin/marketplace.json`. The IDs `docks@docks` and `plan-lifecycle@docks` did not change.
- The Claude and Codex manifests and catalogs, `.codex/agents`, and the `codex-plugin-mirror` skill are gone.
- The reviewer agents load their skill with `autoload-skills` and name files as `skill://<skill>/<path>`; shipped helpers run as `node skill://<skill>/scripts/<file>` (`plugins/plan-lifecycle/`).
- The gate checks the native catalog, packages, flat skill layout, and agent rules itself instead of `claude plugin validate` (`scripts/ci.mjs`).
- The release bumps `package.json` and the catalog, then creates the tag with `git tag -a` and pushes it with `git push` (`scripts/lib/plugin-release.mjs`). A failed tag push deletes the local tag. Tag CI fails when the tag version differs from `package.json` or the catalog (`scripts/ci-target.mjs release-tag`). CI and the dev dependencies no longer install the Claude CLI.
- Verify V1 installs both plugins into an isolated omp state with a fake local model and checks the versions, 33 skills, and both agents (`.agents/skills/verify/scripts/omp-smoke.mjs`).

### Decisions and corrections
- Flat skill folders: the user's decision, after an isolated omp 19.0.0 run found 0 skills for the nested layout without the Claude manifest (Research, Decisions).
- `skill-guard.mjs` and `report-skill-issue` change in this child: the user's decisions after plan review round 1 (Research, Decisions).
- The `.claude/skills/verify` and `.claude/skills/review-benchmark` links stay until child #174, which replaces the link check.
- review-benchmark keeps readers for the old category paths and the old agent form, so it can run benchmark refs from before this change (code review round 1).

### Delegated decisions
- none

### Reviews
Plan review passed in round 7. Code review passed in round 2.
Open findings: two findings of the passing round 2 stay open. MEDIUM: a saved scaffold spec that relied on the old categorized `destination` default now copies to the flat path (`plugins/docks/skills/scaffold/references/spec-schema.md`); child #175 owns the scaffold text. LOW: `omp-smoke.mjs` reports only the warning count, not the warning text.

### Verification
- `bun scripts/ci.mjs`: exit 0 on `19c2f022`.
- Verify V1 (`omp-smoke.mjs`): `docks@docks 0.25.1`, `plan-lifecycle@docks 0.24.1`, `skills: 33`, `agents: code-reviewer,plan-reviewer`, `warnings: 0`, exit 0.
- Verify V2 to V6: each showed its expected result on `19c2f022`.
- Acceptance A3 and A4: no leftover packaging path; 33 flat skills and none nested.
- Acceptance A5: only the past-layout readers, the hook lines (child #173), and the gate's leftover list match.
- Acceptance A6: the dry run shows `git tag -a docks--v0.25.2` and no `claude` command.
- Tag check: `docks--v0.25.1` passes; `docks--v0.26.0` fails with exit 2.
- Each new refusal of the repairs failed its test under a one-line mutant.

### Limits and failures
- The test suites create their fixtures under `os.tmpdir()`; the gate runs here set `TMPDIR` to a docks-kit scratch folder.
- A7 (the user's install) runs only after the merge and the release.

### Kept resources
- After `Merge now`: none in this repository. The `.claude/skills` links stay for child #174.
- After `Leave pull request open`: the linked branch and the open pull request.

### After merge
- Release docks and plan-lifecycle with the new flow; each release needs its own question. The flat layout reaches users only with a version bump.
- Upgrade the user's install and check 33 skills (step `upgrade_check`); it needs its own question.
- Send the docks-kit session the new catalog path and helper paths (step `notify_docks_kit`); it needs its own question.
- Children #173 to #176 of #171 land later.

## Checklist
- [x] `bun scripts/ci.mjs` passes
- [x] Tested locally with the `verify` skill (`.agents/skills/verify`) (A1, A2, A3, A4, A5, A6)
- [x] Code review passed

Closes #172

