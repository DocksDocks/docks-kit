## Plan run: #154 Keep a durable private copy of the unpublished held-out benchmark keys

Pull request: https://github.com/DocksDocks/docks/pull/160. Checks: all 5 passed. Reviewed head: `ba1340df`.

### What changed
- A new script, `keys.mjs` (`.agents/skills/review-benchmark/scripts/keys.mjs`):
  - `backup` writes a reproducible tar of the keys folder with a `MANIFEST.sha256` of every file, checks the tar against the manifest, and encrypts it with `gpg --no-options --no-encrypt-to --recipient-file` to one public key whose fingerprint the vault `README.md` names. It writes only `*.tar.gpg` into the root of the vault clone.
  - `restore` decrypts into a new mode-0700 folder, verifies every file against the manifest, and refuses a folder inside a git checkout, also when git cannot inspect the folder.
  - `check` compares the source snapshot and the frozen record with the hashes of `cases/escape-draw.md`.
- `SKILL.md` Cases has a `Key backup` part: when to make a copy, commit and push of each copy with the user's answer, restore and check, key custody, and what to do after a lost key.

### Decisions and corrections
- Plan review round 3: the committed-key design of round 2 was removed. An agent that can replace the recipient file can read the plaintext keys folder next to it, so a key in reviewed history protects nothing more and needs a second landing.

### Delegated decisions
- How the copy is protected: GnuPG public-key encryption to one dedicated key. Rejected: a plain private repository (readable by every agent with the `gh` login), a passphrase (a secret at each backup), age (needs an install). Reversibility: a new key pair and a new copy. Record: Research D1.
- Where the copy lives: a new private repository, one commit per copy. Rejected: a release asset of this public repository (mixes with plugin releases), a second local disk (dies with the machine). Record: Research D2.
- The tooling: `keys.mjs` with tests. Rejected: a procedure in prose only. Record: Research D3.
- Where the public key lives: the state folder, checked against the vault `README.md`. Rejected: a committed key read from merged history (no added protection, a second landing). Record: Research D4.
- Who makes the key pair, and when: after the merge, with your answer; a restore with the imported export before the scratch key rings go away. Record: Research D5.

### Reviews
Plan review passed in round 4. Code review passed in round 5 (round 1 panel, rounds 2 and 3 delta, round 4 panel after a merge of `main`, round 5 delta).
Open findings: none.

### Verification
- `bun test scripts/tests/unit/review-benchmark.test.mjs`: 213 of 213, with the key-backup cases, including a link or hard-link member, a `MANIFEST.sha256` link, and a hard-linked pair.
- `bun scripts/ci.mjs`: exit 0 on the reviewed head, after the merge of `origin/main`.
- `verify` skill (on `4124d33a`; the later commits change only `keys.mjs`, its tests, and `SKILL.md` text, which no verify check reads): V1 `claude plugin validate --strict` passed for both plugins and the marketplace (`ICON_MISSING` warnings only); V2 to V5 do not apply, because the change reaches no plugin, hook, or plan helper.

### Limits and failures
- Step 4, the restore from a fresh clone of the vault, runs only after the merge, with your answer.

### Kept resources
- After `Merge now`: none from this branch. Steps 3 and 4 create a private vault repository and a public key file in the state folder, which stay by design.
- After `Leave pull request open`: the linked worktree and the branch `154-keep-a-durable-private-copy-of-the-unpublished-held-out-benchmark-keys`.

### After merge
- Step `vault_setup` (publish): create the private repository, make the key pair, write the vault `README.md`, and push the first copy, with its own question.
- Step `restore_test` (probe): restore from a fresh clone with the imported secret-key export, run `check` and `corpus`, and remove the scratch key rings after you confirm the off-machine storage of the secret key.

## Checklist
- [x] `bun scripts/ci.mjs` passes - exit 0 on the reviewed head, and CI ran `scripts/ci.mjs` and passed
- [x] Tested locally with the `verify` skill (`.agents/skills/verify`) - V1 passed on the reviewed head; V2 to V5 do not apply
- [x] Code review passed - round 5, delta, `Code-review: pass` with no open finding

Closes #154

