Implements docs/plans/active/statusline-redesign.md (status: in_review).

- Statusline becomes a pure formatter: `SoT/.claude/bin/statusline.mjs` reads the native `rate_limits.{five_hour,seven_day}` fields from statusline JSON stdin — the entire fetch-usage.sh/OAuth/cache apparatus is deleted, not ported.
- `session-start.mjs` + `notify.mjs` replace the jq/shell hooks; settings use exec-form hooks (command+args, absolute bun path) and a POSIX-guarded statusline command (UTF-16LE -EncodedCommand on Windows).
- Readiness-gated cutover in the sync engine (`prepareClaudeSettings`/`commitClaudeSettings`): with Bun unavailable, migration defers and legacy files/settings are preserved untouched.
- `hooks.Stop` removed (settings-key prune, readiness-gated).
- Golden ledger: 15 dry-run / 14 mutation changed, 5 additive (final 22/52); rtk-init-failure and comma-plugin parse-abort canaries byte-identical.
- CI: statusline-runtime-smoke on POSIX/PowerShell/Git Bash + compiled deferred-migration and materialized-settings execution legs.

This PR exists to run the Windows CI legs that close the four "partial" acceptance items; merge lands via the plan ship flow.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DSYAfuyn99UA5mZVm5Zvc1
