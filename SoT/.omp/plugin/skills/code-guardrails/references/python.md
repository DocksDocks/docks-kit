# Python guardrails

## Detect

- Check `pyproject.toml` for `[tool.ruff]` and `[tool.ruff.lint]`.
- Check `ruff.toml` and `.ruff.toml` for `[lint]`.
- Find the file that Ruff uses: run `ruff check --show-settings <file.py>` on one source file and read `Settings path`. In one directory, `.ruff.toml` takes precedence over `ruff.toml`, and `ruff.toml` takes precedence over `pyproject.toml`.
- In that file, search `ignore` and `per-file-ignores` for `PLR2004` or a prefix of it, such as `PL`, `PLR`, or `PLR2`.
- Ask before installing Ruff if the project does not have it.

## Recommended config

Merge these entries into the file that Ruff uses; do not replace its settings. In `ruff.toml` or `.ruff.toml`, drop the `tool.ruff.` prefix: write `[lint]` and `[lint.pylint]`. Keep existing rule selections and add missing prefixes to `extend-select`. If `extend-select` exists, append missing prefixes to its list. Keep any stricter settings. Do not add `PLR2004` to `per-file-ignores` for test files. Ask the user before you remove an existing test exception for it.

```toml
[tool.ruff.lint]
extend-select = ["E", "F", "B", "UP", "SIM", "PL", "RUF", "ERA", "T20", "ANN"]

[tool.ruff.lint.pylint]
allow-magic-value-types = []
```

`select` replaces the default rule set; `extend-select` adds to it. Keep an existing `select` list instead of replacing it. An `ignore` or `per-file-ignores` entry that matches `PLR2004` turns the rule off, even when `extend-select` lists `PL`: Ruff applies the more specific selector, and `ignore` wins over an equally specific selector. Report that entry and ask the user before you remove it; do not report `PLR2004` as on while an entry turns it off. This setup changes Ruff only: do not install a type checker or change its settings. Report each new prefix and setting to the user.

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

Run the project's Ruff command, or `ruff check .`. Run `ruff check --show-settings <file.py>` and confirm that `linter.rules.enabled` lists `magic-value-comparison (PLR2004)`. Review violations, then report the config changes and the remaining findings.

## Sources

- Ruff configuration and file discovery: <https://docs.astral.sh/ruff/configuration/>
- Ruff rule families `E`, `F`, `B`, `UP`, `SIM`, `PL`, `RUF`, `ERA`, `T20`, `ANN`: <https://docs.astral.sh/ruff/rules/>
- Ruff rule `PLR2004` and its exemptions: <https://docs.astral.sh/ruff/rules/magic-value-comparison/>
- Ruff `extend-select`, per-file ignores, and `allow-magic-value-types`: <https://docs.astral.sh/ruff/settings/>
- Ruff lint command: <https://docs.astral.sh/ruff/linter/>
- Python `Final`: <https://docs.python.org/3/library/typing.html#typing.Final>
- Python `StrEnum` and `IntEnum`: <https://docs.python.org/3/library/enum.html#enum.StrEnum>
