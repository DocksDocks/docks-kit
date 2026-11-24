# Swift guardrails

## Contents

- [Detect](#detect)
- [Recommended config](#recommended-config)
- [Rules that catch raw values](#rules-that-catch-raw-values)
- [Constant map](#constant-map)
- [Verify](#verify)
- [Sources](#sources)

## Detect

- Find `.swiftlint.yml` before changing lint rules.
- Check `Package.swift` for `SwiftLintBuildToolPlugin` or a SwiftLint package command plugin.
- Check Xcode targets for a SwiftLint build tool plugin or a Run Script phase.
- Find `.swift-format` if the project uses `swift-format`. Treat formatting as layout work, not lint coverage.
- Run `command -v swiftlint` to find a local standalone binary before proposing SwiftLint changes. When it is absent, follow the approval gate in `../SKILL.md` before you install it.

## Recommended config

Merge this `.swiftlint.yml` example into the existing file. Keep existing rules and stricter settings.
Add only missing rules. If the file has `only_rules`, add the missing rule IDs from the example, including `force_cast` and `force_try`, to that list and do not add `opt_in_rules`. SwiftLint rejects `only_rules` together with `opt_in_rules` or `disabled_rules`, and `only_rules` turns off each rule that it does not list. Otherwise, add the missing `opt_in_rules` entries.
Keep `disabled_rules` untouched and report any conflict before changing it.
Keep other config keys, including file scope and analyzer settings. Do not replace the file with this example.

```yaml
opt_in_rules:
  - no_magic_numbers
  - force_unwrapping
  - implicitly_unwrapped_optional
  - fatal_error_message
  - no_empty_block
  - unhandled_throwing_task

no_magic_numbers:
  severity: error
  allowed_numbers: [0.0, 1.0]
force_unwrapping:
  severity: error
  ignored_literal_argument_functions: []
implicitly_unwrapped_optional:
  severity: error
fatal_error_message:
  severity: error
no_empty_block:
  severity: error
unhandled_throwing_task:
  severity: error
force_cast:
  severity: error
force_try:
  severity: error
```

`force_cast` and `force_try` are default rules with error severity.
Keep them enabled at error severity; report any existing override that weakens or disables them.
`no_magic_numbers` permits `0.0`, `1.0`, and `100.0` by default; the example removes `100.0` from that allowance.
SwiftLint always skips test code for this rule: `XCTestCase` and `QuickSpec` subclasses, `@Test` functions, and `@Suite` types.
No setting turns the rule on there, because the rule adds these classes to `test_parent_classes` itself.
When the request includes value mapping, run [Find scattered values](../SKILL.md#find-scattered-values) for Swift tests; it includes test files.
In tests, use production constants for inputs and a named `let` for each expected literal.

## Rules that catch raw values

| Rule | Catches | Limits |
|---|---|---|
| [`no_magic_numbers`](https://realm.github.io/SwiftLint/no_magic_numbers.html) | Raw numeric expressions, such as an array index or limit. | It skips a literal that is the whole initializer of a declaration, default allowed values, and all test code. It reports a literal in an expression or a call argument, such as `8 * mibBytes` or `.seconds(30)`. It does not check repeated strings. |
| [`force_unwrapping`](https://realm.github.io/SwiftLint/force_unwrapping.html) | Forced optional unwraps. | The example removes its default literal-initializer exceptions. It does not find raw values. |
| [`implicitly_unwrapped_optional`](https://realm.github.io/SwiftLint/implicitly_unwrapped_optional.html) | Implicitly unwrapped optional types. | Its default mode excludes outlets; it does not find raw values. |
| [`fatal_error_message`](https://realm.github.io/SwiftLint/fatal_error_message.html) | Missing or empty failure messages. | It does not judge message content or find raw values. |
| [`no_empty_block`](https://realm.github.io/SwiftLint/no_empty_block.html) | Empty code blocks. | A comment counts as content; it does not find raw values. |
| [`unhandled_throwing_task`](https://realm.github.io/SwiftLint/unhandled_throwing_task.html) | Unhandled errors in discarded throwing tasks. | It does not find raw values. |
| [`force_cast`](https://realm.github.io/SwiftLint/force_cast.html) and [`force_try`](https://realm.github.io/SwiftLint/force_try.html) | Forced casts and forced throwing calls. | Both default to error severity; neither finds raw values. |
| No SwiftLint rule here | Repeated strings, paths, keys, and unit mismatches. | Use [Find scattered values](../SKILL.md#find-scattered-values) and review ownership. |

## Constant map

Put constants in the module that owns each policy. Use a caseless `enum` with `static let` values when no instances are needed.
Name units in scalar constants. Derive larger units from smaller ones. Use `Duration` for elapsed time and `Measurement` for physical quantities when their types fit.
Import the owning module at call sites instead of copying values.

```swift
// BAD — repeated numbers and keys hide units and policy ownership.
func upload(_ body: Data) {
    guard body.count <= 8 * 1_024 * 1_024 else { return }
    save(body, key: "upload.limit", timeout: .seconds(30))
}

// GOOD — one owner names units and derives related values.
enum UploadPolicy {
    static let binaryStep = 1_024
    static let kibBytes = binaryStep
    static let mibBytes = binaryStep * kibBytes
    static let maxBodyMib = 8
    static let maxBodyBytes = maxBodyMib * mibBytes
    static let limitKey = "upload.limit"
    static let timeoutSeconds = 30
    static let timeout: Duration = .seconds(timeoutSeconds)
}

func upload(_ body: Data) {
    guard body.count <= UploadPolicy.maxBodyBytes else { return }
    save(body, key: UploadPolicy.limitKey, timeout: UploadPolicy.timeout)
}
```

## Verify

- Run a local standalone `swiftlint` binary directly, `swiftlint lint --strict` from the directory with `.swiftlint.yml`, only when `.swiftlint.yml` and each config that it references have no remote `parent_config` or `child_config` URL. SwiftLint fetches a remote config, so a remote URL sends the run through the approval gate in `../SKILL.md` first. The command plugin (`swift package plugin swiftlint`), a build tool plugin, and an Xcode build always go through the approval gate in `../SKILL.md` first, because SwiftPM can resolve and download the whole dependency graph.
- Check each new rule for violations and report every config change.
- When the request includes value mapping, report unhandled repeated values from [Find scattered values](../SKILL.md#find-scattered-values).
- If SwiftLint is absent, follow the approval gate in `../SKILL.md` before you install it; do not claim the lint check passed.

## Sources

- SwiftLint [configuration, command usage, and plugins](https://github.com/realm/SwiftLint/blob/main/README.md) and [rule directory](https://realm.github.io/SwiftLint/rule-directory.html).
- SwiftLint [remote `parent_config` and `child_config` references](https://github.com/realm/SwiftLint#childparent-configs-remote).
- SwiftLint rules: [no_magic_numbers](https://realm.github.io/SwiftLint/no_magic_numbers.html), [force_unwrapping](https://realm.github.io/SwiftLint/force_unwrapping.html), [implicitly_unwrapped_optional](https://realm.github.io/SwiftLint/implicitly_unwrapped_optional.html).
- SwiftLint rules: [fatal_error_message](https://realm.github.io/SwiftLint/fatal_error_message.html), [no_empty_block](https://realm.github.io/SwiftLint/no_empty_block.html), [unhandled_throwing_task](https://realm.github.io/SwiftLint/unhandled_throwing_task.html).
- SwiftLint rules: [force_cast](https://realm.github.io/SwiftLint/force_cast.html), [force_try](https://realm.github.io/SwiftLint/force_try.html).
- Swift-format [configuration discovery](https://github.com/swiftlang/swift-format/blob/main/README.md#configuring-the-command-line-tool); Swift [Duration](https://developer.apple.com/documentation/swift/duration) and Foundation [Measurement](https://developer.apple.com/documentation/foundation/measurement).
