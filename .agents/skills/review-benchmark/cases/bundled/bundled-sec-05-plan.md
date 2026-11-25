## Plan run: #212 Ship a bundled JavaScript build of the docks-kit CLI in the npm package

Pull request: https://github.com/DocksDocks/public/pull/218. Checks: 10 of 10 passed. Reviewed head: `bc6bbb21`.

Parent: #198, step `cli_bundle` (child 9 of 10). No release from this repository: 0.26.0 ships from DocksDocks/docks-kit with #213.

### What changed
- The npm package runs `cli/dist/docks-kit.js`, a bundle built by `bun build cli/src/main.ts --target=bun --minify-whitespace --minify-syntax --sourcemap=external` (`cli/scripts/build-bundle.ts`, `bun run build:bundle`, run by `prepack`). Identifiers stay, so stack traces keep their names. The bundle ends with `//# debugId=<hex>` and has no `sourceMappingURL` line.
- Start time of an installed `--version`, median of 10: bundle 60.9 ms, TypeScript source 165.0 ms on Linux (about 2.7 times faster); 96.0 against 238.2 ms on the macOS CI runner. The gate compares the time above Bun's own start (`bun -e 0`), so an equal runner delay cancels.
- `package.json`: `bin` points at the bundle, `files` ships it without the map, `cli/src` still ships (the checkout launchers and an installed 0.25.0 that updates use it).
- `docks-kit update` chains the sync through the new bundle for a package update and through the source for a checkout update, also when the checkout holds a stale bundle.
- A build output under `cli/src` fails the build, a unit test, and the package smoke; `.gitignore` lists such files.
- `smoke:package` checks the bin target, three commands from an unrelated folder, the tarball contents, and the start time; it runs on Linux and macOS. The Windows checks job installs the packed package globally and runs `docks-kit.exe`.
- Release: `cli/scripts/release-build.sh` builds the bundle, the binaries, and the tarball, adds the map to `SHA256SUMS`, matches the debug ids, and checks the exact release files. `cli/scripts/tarball-proof.sh` holds the former inline tarball proof and adds a byte comparison of the packed bundle with one built from the tag by the tag's own build script. The workflow proves these scripts against the tag before the build and uploads `docks-kit.js.map` as a release asset.
- AGENTS.md, README, `cli/docs/install.md`, two test comments, and the 0.26.0 changelog entry describe the bundle and the map.

### Decisions and corrections
- Plan review round 1 rejection: the version stays 0.26.0, the unreleased bump over the published 0.25.0.

### Delegated decisions
- The owner's minify and source-map decision; `--outdir` with `--entry-naming` (never `--outfile`, which wrote next to the entry).
- The update chain chooses by update kind, not by a file test.
- The release build and proof live in scripts that the workflow calls and that a local rehearsal can run.

### Reviews
Plan review: round 1 found 6 findings (5 repaired, 1 rejected with evidence), round 2 found 4, round 3 found 2; all repaired; round 4 passed.

Code review: round 1 passed with 3 MEDIUM findings (the package update assumed the new layout; a load-sensitive start-time gate; helper-only update tests), all repaired; round 2 was blocked on one base-instructions input and answered one finding with a plan change (the net start-time rule, delta plan review round 5 passed); round 3 passed; CI then found a Windows path-separator mismatch in the new update tests, repaired; round 4 passed with no finding.

Open findings: none.

### Verification
- `bun run check`: exit 0 at `2ca053da` (`4362 passed | 11 skipped`, both golden suites OK).
- `bun run smoke:native`: exit 0 (`version: 0.26.0`). `bun run smoke:package`: exit 0 (bundle 61.0 ms, source 167.3 ms).
- B3 release rehearsal at `2ca053da` with a local tag that was never pushed and is deleted: `release-build.sh 0.26.0` exit 0 with matching debug ids and the exact release files; `tarball-proof.sh` exit 0 (102 files, the bundle rebuilt from the tag); `sha256sum -c` 5 lines OK, the map's included; a changed bundle byte and an extra `cli/src/x.ts` each fail the proof.
- CI of `bc6bbb21`: 10 of 10 jobs pass. Windows: `docks-kit.exe --version: 0.26.0` and `docks-kit.exe sync --dry-run: exit 0` after a global install of the packed package; macOS runs the package smoke; the lint job runs actionlint on the changed workflows.

### Kept resources
- After `Merge now`: none. I remove the worktree, the branch, and the scratch folder.
- After `Leave pull request open`: the branch and its worktree.

### After merge
Archive #212 with the pull request, and set the parent step `cli_bundle` to done. No release.

## Checklist
- [x] `bun run check` passes
- [x] Code review passed

Closes #212

