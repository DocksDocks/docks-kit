## Change
- `docks-kit omp --fast` toggles `tier.openai` in the deployed `~/.omp/agent/config.yml` between `priority` (omp `/fast on` tier) and `none`, prints the change, and exits. Only that key changes.
- `SoT/.omp/config.yml` no longer declares `tier.openai`, so `sync omp` keeps the toggled value.
- No Ultrafast flag: the omp 18.4.9 catalog lists no `serviceTiers` for GPT-6.1 Sol, Astra, or Luna, so omp ignores `ultrafast` for them.
- Version 0.20.3.

## Verification
- `bun run check`: 650 passed, 8 skipped; goldens updated for the help text and SoT config hash.
- A live `omp -p` on `openai-codex/gpt-6.1-sol` sent `service_tier: "priority"`. RPC `get_state` reports `fastModeActive: true`.
- A toggle round-trip in a temporary home leaves the config byte-identical.
