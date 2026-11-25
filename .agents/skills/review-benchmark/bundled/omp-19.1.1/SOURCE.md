# Source of the vendored bundled agents

These files are byte-for-byte copies from Oh My Pi (omp), tag `v19.1.1`. omp compiles the two agent files into its binary as the bundled agents `reviewer` and `security-reviewer`.

| File | Source |
|---|---|
| `reviewer.md` | <https://github.com/can1357/oh-my-pi/blob/v19.1.1/packages/coding-agent/src/prompts/agents/reviewer.md> |
| `security-reviewer.md` | <https://github.com/can1357/oh-my-pi/blob/v19.1.1/packages/coding-agent/src/prompts/agents/security-reviewer.md> |
| `LICENSE` | <https://github.com/can1357/oh-my-pi/blob/v19.1.1/LICENSE> |

omp is distributed under the MIT License. `LICENSE` holds its copyright and permission notices.

`prepare.mjs agents --bundled` renders the benchmark agents from these copies, and it stops when `omp --version` is not `19.1.1`. `score.mjs` reads the output schema of each agent from these copies. After a raise of the omp `verified` pin in `SoT/toolchain.json`, follow the refresh procedure under "Vendored copies" in the "Bundled agents" section of `../../SKILL.md`: it adds the folder `omp-<version>/` and changes `BUNDLED_OMP_VERSION` in `scripts/score.mjs`.
