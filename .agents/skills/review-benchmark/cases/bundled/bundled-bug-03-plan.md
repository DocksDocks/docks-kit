## ⚠ Two things to read before merging

**1. Use "Create a merge commit". NOT squash, and NOT rebase.** All three are enabled on this repo, and two of the three destroy evidence permanently. The archived plan record binds `execution_parent: 8531065` and `implementation_commit: 6bfe1ca`, plus a 647-line `diff_sha256` over that commit. A squash replaces all five SHAs with one; a rebase replays them onto a new base and rewrites all five. Either way, from a fresh clone of `main` both commit identities are unreachable and the bound diff can never be re-derived. Only a merge commit keeps `a3462e2` and `6bfe1ca` reachable from `main`.

**2. CI is red on a pre-existing session-relay failure, not on this work.** This branch touches **zero** files under `plugins/session-relay/`. Measured:

| Check | Result |
|---|---|
| validation shard (core) | pass |
| CI plugin-targeting contracts | pass |
| validation shard (relay) | **fail** |
| validate (aggregate) | fail — only reports the shard |

`session-relay release contract failed (release-evidence-contract.mjs)` failed byte-identically on the `session-relay--v0.14.0` tag run on 2026-07-26, before any of this work. The second relay failure is a Rust supervisor-socket panic (`lifecycle_supervisor.rs:259`, "stat lifecycle supervisor socket: No such file or directory") which passes a full local `node scripts/ci.mjs`.

Why it surfaces here: the `docks--v0.14.x` tag runs are `--plugin docks` targeted and skip relay entirely, so **this PR is the first full-lane run since relay broke.** A job re-run will not clear it — the release-contract failure is deterministic. Relay is a separate plugin with its own gate; fixing it is deliberately out of scope for this PR.

---

Closes the four defects the predecessor run's completion review reproduced in the crash-safe review dispatch driver. This branch also publishes the driver for the first time: `origin/main` contains no `dispatch-review.mjs` and no `plan-dispatch-probes.mjs`, so no consumer ever received the defective version.

## The four repairs

| | Defect | Repair |
|---|---|---|
| C1 | The reviewer route was parsed *after* the reserve | Route and private raw-stdout target are proven before the reserve — below the dry-run exit, above the reserve. Route resolution requires a regular file, rejects empty commands, and resolves relative commands and `PATH` entries against `--repo`, because `spawn` chdirs there before the OS resolves the command. |
| C2 | Reviewer stdout was never persisted | The complete byte stream is written to the preflighted target before interpretation; the normalized verdict stays a separate artifact. |
| C3 | Invalid-input replies were *reconstructed* | The returned object is validated verbatim, so a wrong-schema, no-schema or extra-key reply refunds instead of settling terminally. |
| C4 | The drift guard compared HEAD only | The affected-path manifest is re-derived and `source_sha256` compared as well; both drift branches now exit non-zero, since no verdict was captured. |

## Verification

- 11 dispatch probes registered in the orchestration suite; `plan-orchestration` 141/141.
- Full `node scripts/ci.mjs` green locally — 3 plugins plus repo-wide, with the worktree verified byte-identical to the checkpoint for all three owned paths.
- Every acceptance row falsified against a mutated copy of the driver. Where a row prescribes a specific mutation, that prescribed mutation was run and the assertion it broke recorded; a mutant counts as proof only when the failure names the expected assertion.
- Every `Observed` cell is bound to a string the probe actually emitted, re-checked at write time. That check rejected a fabricated quote of the gate's own summary line, which carries an ANSI reset mid-sentence so the joined sentence is never emitted.
- Two mutation-idiom traps documented in the probe header: a mutant outside the driver's own directory dies at `ERR_MODULE_NOT_FOUND`, and a repository-relative `--driver=` resolves against the probe's scratch `cwd`. Both exit non-zero for the wrong reason and look exactly like a caught defect.

## Review

Draft review passed 1/2. Completion review passed 1/2 with zero findings — after four rehearsals against a scratch plan outside `docs/plans/` that spent no live permit and surfaced eight findings, three of them real code defects the passing probe suite did not catch.

Plan record archived at `docs/plans/finished/2026-07-30-plan-dispatch-driver.md`. Three checkpoints — start, implementation, archive — the sensitive-risk ceiling; the implementation checkpoint was amended in place rather than adding a fourth commit.

## Not in scope

No version bump and no release tag. All three manifests remain `0.14.4` and `docks--v0.14.4` is already tagged at `05d7503`, so merging this does not deliver to consumers. That is a separate release decision. Nor does it touch session-relay, per the note above.


