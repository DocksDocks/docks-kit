## What

`docks-kit omp` starts one omp session in which every model role resolves to a free model, then exits leaving nothing changed on disk. The deployed `~/.omp/agent/config.yml` and `models.yml` are never read or written, so the next plain `omp` run uses the paid configuration again.

```
docks-kit omp                      # interactive session on the remembered free model
docks-kit omp -p "reply with OK"   # one prompt, arguments forward verbatim
docks-kit omp --pick               # choose a free model and remember it
docks-kit omp --model <selector>   # set the free model directly
```

## Design notes

**The overlay is rendered in code, not shipped as `SoT/.omp/free.yml`.** The approved plan called for an SoT file. The model then became a per-machine variable, so a static SoT file would have sat in the sync deployment table while never deploying anywhere. `sotPayload.ts` is untouched.

**Thinking levels come from the ladder of the chosen model, never from a fixed list.** Free ladders are not uniform. Of the 26 zero-cost models in the catalog, 15 publish `minimal,low,medium,high,xhigh`, three publish no `medium`, two publish no ladder at all, and three more publish `max`. A fixed `xhigh` would have produced an unresolvable selector on 11 of them. A model without a ladder renders a bare selector and omits `defaultThinkingLevel` and `task.maxEffort`. Levels are computed once when the model is set and persisted, so a plain launch never spawns `omp models --json`.

**Persistence lives in `~/.docks-kit/state.json` under `ompSession`,** beside `harnesses`. Both writers merge over the stored record, so neither key can drop the other. `version: 1` is unchanged.

**Any undeclared flag opens the passthrough tail.** omp owns far more flags than the kit can track, and omp reports its own unknown flags. `argv.ts` injects `--` so a bare `-p` reaches omp instead of being rejected as an unknown kit flag.

**Every fallback chain is emptied,** so a retry can never reach a paid model.

**Each model gets its own overlay file** under `~/.cache/docks-kit/`, at mode 0600. omp can re-read the overlay during a live session, so a second launcher on another model must not rewrite it. The name sanitizes the selector for the file system and appends a digest of the exact selector, because sanitizing alone folds `a/b` and `a-b` onto one name.

The first commit is a no-behavior-change refactor: `spawnUpdate` moves to `exec.ts` as `spawnHost`. It encodes the Windows rule that a `.cmd` shim only runs under `cmd.exe /d /v:off /s /c` with verbatim arguments, which the launcher needs in order to forward quoted arguments on Windows.

## Verification

Full gate green: `check:generated`, `typecheck`, `test:unit` (587 passed), `golden:dryrun` (39), `golden:mutation` (63), `test:runtime:posix`, `smoke:package`, `smoke:native`.

Live on Linux with an opencode-zen login: `./docks-kit omp -p "Reply with exactly: OK"` returns `OK`; `~/.omp/agent/config.yml` and `models.yml` are md5-identical before and after. All 26 free models were swept for selector legality, and three were launched live to confirm they reach the provider.

## Known limits

- The picker lists catalog-advertised free models that an account may not be entitled to call; detecting that needs a live request per model.
- Overlay files accumulate in `~/.cache/docks-kit/`, one per model ever selected, about 1 KB each, with no cleanup pass.

