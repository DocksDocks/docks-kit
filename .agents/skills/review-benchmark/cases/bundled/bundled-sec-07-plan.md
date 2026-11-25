## What's in here

Three plans on one exploration branch, two of them executed:

### session-relay Rust port — steps 1–6 of 8 (plan: `docs/plans/active/session-relay-rust-port.md`)
- **Crate** at `plugins/session-relay/rust/`: full behavioral port of the five Node store-touchers into one multi-call `relay` binary (`bus`/`hook`/CLI), kernel `flock` replacing the mkdir-mutex, pinned toolchain 1.85.0, min-size release profile. 10 cargo tests incl. an 8×10 cross-process lock race and a black-box MCP lifecycle smoke.
- **CI**: tag glob broadened to `*--v*`; guarded Rust provisioning in the validate job; new `build-binaries.yml` (workflow_dispatch only, 2 runners → 4 arches).
- **Author tooling**: registry-driven `rust` capability — `ci.mjs` gates fmt/clippy + a `--locked` musl host-leg build + committed-checksum verify; `release.mjs` refuses to tag without all 4 committed binaries.
- **Tests/docs on the binary**: `selftest.mjs` rewritten black-box (39 checks, every store touch through the binary), new read-only `relay peek`, SKILL.md paths flipped to `<plugin>/bin/relay`.
- **NOT yet flipped**: consumer manifests still point at the Node files — that is step 7, which needs `build-binaries.yml` dispatched from `main` (workflow_dispatch only lists default-branch workflows). Binaries land in a follow-up PR; the Node payload is deleted there too (step 8).

### knowledge-format lint & citations — executed + review passed (plan being shipped on this branch)
Karpathy LLM-Wiki Lint checks folded into context-tree audit + skill-maintenance drift tables; OKF/Karpathy cited as convergent prior art. No vendoring.

### okf-knowledge-bundle — parked stub plan (`status: planned`), untouched until picked up.

## Verification
- `node scripts/ci.mjs` green locally (2 plugins + repo-wide, incl. the new Rust leg: fmt/clippy clean, musl host build, 39-check selftest).
- `cargo test` 10/10; `cargo clippy --all-targets -- -D warnings` clean.
- `release.mjs --dry-run --plugin session-relay` correctly REFUSES to tag while binaries are uncommitted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01UyDDEDsq6yGeJKzNAwW3ZQ
