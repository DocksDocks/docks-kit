# Python guardrails

## Contents

- [Detect](#detect)
- [Recommended config](#recommended-config)
- [Rules that catch raw values](#rules-that-catch-raw-values)
- [Constant map](#constant-map)
- [Verify](#verify)
- [Sources](#sources)

## Detect

- Find the Ruff config files in the repository: `.ruff.toml`, `ruff.toml`, and `pyproject.toml` with a `[tool.ruff]` table.
- Find the project's Ruff command, such as its CI step, a script, or a pre-commit hook.
- Read the project's Ruff command and take the first case that matches. A `--config` value that names an existing file is a file; otherwise, a value that contains `=` is an inline override.
  1. **`--isolated`, a `--config` file outside the repository, or an inline `--config` override:** report what controls the settings, change no file, and ask the user how to continue.
  2. **A `--config` file inside the repository:** edit that file. Use the standalone schema (`[lint]`) unless the file is `pyproject.toml`.
  3. **No `--config`:** Ruff uses config discovery. Each file gets the closest config file up the directory tree, and Ruff does not merge parent files. In one directory, `.ruff.toml` takes precedence over `ruff.toml`, and `ruff.toml` takes precedence over `pyproject.toml`.
     - Exactly one Ruff config file in the repository applies to the whole lint scope: edit that file.
     - No Ruff config file applies: create the project config. Add `[tool.ruff.lint]` to `pyproject.toml`, or create `ruff.toml` when the project has no `pyproject.toml`.
     - More than one config applies, or a config in a parent folder outside the repository may apply: report the configs that you found and ask the user which to edit. Do not edit a guessed config.
- Report every entry in those configs and in the Ruff command that can turn `PLR2004` off: `ignore`, `extend-ignore`, `per-file-ignores`, and `extend-per-file-ignores` entries for `PLR2004` or its prefixes, such as `PLR` and `PL`, and a command `--select` that replaces the rule selection. Ask the user before you remove any of them. Do not claim a per-file rule state.
- Ask before installing Ruff if the project does not have it.

## Recommended config

Merge these entries into the project file that Detect found; do not replace its settings. Ruff reads `pyproject.toml` with `tool.ruff` tables and every other config file, including a custom file name given to `--config`, without that prefix. Use `[tool.ruff.lint]` and `[tool.ruff.lint.pylint]` only in `pyproject.toml`; use `[lint]` and `[lint.pylint]` in every other config file. Keep existing rule selections and add missing prefixes to `extend-select`. If `extend-select` exists, append missing prefixes to its list. Keep any stricter settings. Do not add `PLR2004` to `per-file-ignores` for test files. Ask the user before you remove an existing test exception for it.

```toml
# pyproject.toml
[tool.ruff.lint]
extend-select = ["E", "F", "B", "UP", "SIM", "PL", "RUF", "ERA", "T20", "ANN"]

[tool.ruff.lint.pylint]
allow-magic-value-types = []
```

```toml
# ruff.toml, .ruff.toml, or another file given to --config
[lint]
extend-select = ["E", "F", "B", "UP", "SIM", "PL", "RUF", "ERA", "T20", "ANN"]

[lint.pylint]
allow-magic-value-types = []
```

`select` replaces the default rule set; `extend-select` adds to it. Keep an existing `select` list instead of replacing it. Ruff resolves rule selection by specificity, and command-line flags win over config files, so do not infer from one entry that `PLR2004` is on or off for a file. Do not name one entry as the cause, and do not remove any entry without approval. This setup changes Ruff only: do not install a type checker or change its settings. Report each new prefix and setting to the user.

## Rules that catch raw values

| Rule | Catches | Limits |
| --- | --- | --- |
| `PLR2004` | Unnamed constants in comparisons. By default it checks numbers only; with `allow-magic-value-types = []`, it also checks `str` and `bytes` values, such as `state == "ready"`. | Comparisons only; it does not find repeated values in assignments, calls, paths, keys, or units. |

Ruff exempts common comparison values such as `0`, `1`, and `""`. The `allow-magic-value-types = []` setting removes type-based exemptions, including the default string and bytes exemptions; it does not remove the rule's common-value exemptions. Use `SKILL.md` § **Find scattered values** for values beyond comparison checks. Keep `PLR2004` on in tests: a test compares with a named `Final` expected value, not an inline number.

## Constant map

Define module-level `typing.Final` constants in one owning module per domain. Derive related values from the owning constants. Include units in names, such as `MAX_PAYLOAD_BYTES`. Use `enum.StrEnum` or `enum.IntEnum` for closed string or integer sets when the project's Python version supports them. Import constants and enum members from their owning module instead of copying values.

```python
# BAD — repeated size and state literals drift across consumers.
def accept_upload(payload_bytes: int, state: str) -> bool:
    return payload_bytes <= 8388608 and state == "ready"

# In another module:
def queued_upload(payload_bytes: int, state: str) -> bool:
    return payload_bytes <= 8388608 and state == "ready"

# GOOD — upload_limits.py owns domain values and derives the size limit.
from enum import StrEnum
from typing import Final

KIB_BYTES: Final = 1024
MIB_BYTES: Final = 1024 * KIB_BYTES
MAX_PAYLOAD_BYTES: Final = 8 * MIB_BYTES

class UploadState(StrEnum):
    READY = "ready"

# GOOD — consumers import one mapped source instead of copying literals.
from upload_limits import MAX_PAYLOAD_BYTES, UploadState

def accept_upload(payload_bytes: int, state: str) -> bool:
    return payload_bytes <= MAX_PAYLOAD_BYTES and state == UploadState.READY
```

A `StrEnum` member is equal to its string value, so callers can still pass `"ready"`. For tests, pass `MAX_PAYLOAD_BYTES` as an input. When the test checks the constant's value, compare it with a named expected value, such as `EXPECTED_MAX_PAYLOAD_BYTES: Final = 8_388_608`.

## Verify

Follow the verify rule in `../SKILL.md`: run the project's Ruff command unchanged, or `ruff check .` when the project has no Ruff command. That run is the only run. Report its findings and the config changes, and do not claim that `PLR2004` is on for files that the run did not report.

## Sources

- Ruff configuration and file discovery: <https://docs.astral.sh/ruff/configuration/#config-file-discovery>
- Ruff `extend-per-file-ignores` and the deprecated `extend-ignore`: <https://docs.astral.sh/ruff/settings/#lint_extend-per-file-ignores>
- Ruff command-line settings and `--config` inline overrides: <https://docs.astral.sh/ruff/configuration/#command-line-interface>
- Ruff `--isolated` and `--config` in the full command-line interface: <https://docs.astral.sh/ruff/configuration/#full-command-line-interface>
- Ruff `select` and selector specificity: <https://docs.astral.sh/ruff/settings/#lint_select>
- Ruff rule families `E`, `F`, `B`, `UP`, `SIM`, `PL`, `RUF`, `ERA`, `T20`, `ANN`: <https://docs.astral.sh/ruff/rules/>
- Ruff rule `PLR2004` and its exemptions: <https://docs.astral.sh/ruff/rules/magic-value-comparison/>
- Ruff `extend-select`, per-file ignores, and `allow-magic-value-types`: <https://docs.astral.sh/ruff/settings/>
- Ruff lint command: <https://docs.astral.sh/ruff/linter/>
- Python `Final`: <https://docs.python.org/3/library/typing.html#typing.Final>
- Python `StrEnum` and `IntEnum`: <https://docs.python.org/3/library/enum.html#enum.StrEnum>
