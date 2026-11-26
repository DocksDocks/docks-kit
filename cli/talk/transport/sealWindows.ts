/**
 * Windows DPAPI seal of registry entries (#249 E5 Windows, F7). Each entry file
 * holds one blob, sealed for the current user with the entropy
 * `docks-kit-talk/v1`, over the whole entry JSON. One `powershell.exe` start
 * seals or unseals a batch. DPAPI can in rare cases unseal a corrupted blob, so
 * the caller decodes each value and checks its ids.
 */
import { Context, Effect, Layer, Result, Schema } from "effect";

import { runTool, windowsPowerShellPath } from "./folder";

export const DPAPI_ENTROPY = "docks-kit-talk/v1";

/** The batch could not run, or PowerShell printed output that the protocol does not allow. */
export class TalkSealError extends Schema.TaggedError<
  TalkSealError,
  { readonly brand: unique symbol }
>()("TalkSealError", {
  reason: Schema.String,
}) {}

/** One blob of a batch did not unseal to a UTF-8 value. */
export class TalkUnsealRejected extends Schema.TaggedError<
  TalkUnsealRejected,
  { readonly brand: unique symbol }
>()("TalkUnsealRejected", {
  index: Schema.Int,
  reason: Schema.String,
}) {}

type DpapiMethod = "Protect" | "Unprotect";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The batch script. Input: a count line, then one base64 line per item.
 * Output: one line per item, `+<base64>` for a result or `-` for a failed item.
 */
const dpapiScript = (method: DpapiMethod): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    `$entropy = [System.Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    '$lines = [Console]::In.ReadToEnd() -split "`n"',
    "$count = [int]$lines[0]",
    "$out = New-Object System.Text.StringBuilder",
    "for ($i = 1; $i -le $count; $i++) {",
    "  try {",
    "    $data = [Convert]::FromBase64String($lines[$i].Trim())",
    `    $result = [System.Security.Cryptography.ProtectedData]::${method}($data, $entropy, $scope)`,
    "    [void]$out.Append('+').Append([Convert]::ToBase64String($result)).Append(\"`n\")",
    "  } catch {",
    '    [void]$out.Append("-`n")',
    "  }",
    "}",
    "[Console]::Out.Write($out.ToString())",
  ].join("\n");

/** The standard input of a batch: a count line, then one base64 line per item. */
export function encodeDpapiInput(items: ReadonlyArray<Uint8Array>): string {
  const lines = items.map((item) => `${Buffer.from(item).toString("base64")}\n`);
  return `${items.length}\n${lines.join("")}`;
}

/** Reads the output of a batch: one line per item, `undefined` for a failed item. */
export function parseDpapiOutput(
  stdout: string,
  count: number,
): Result.Result<ReadonlyArray<Uint8Array | undefined>, string> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== count) {
    return Result.fail(`DPAPI printed ${lines.length} results for ${count} items`);
  }
  const items: Array<Uint8Array | undefined> = [];
  for (const line of lines) {
    if (line === "-") {
      items.push(undefined);
      continue;
    }
    const encoded = line.slice(1);
    if (!line.startsWith("+") || !BASE64.test(encoded)) {
      return Result.fail(`DPAPI printed a line that is not a result: ${line.slice(0, 40)}`);
    }
    items.push(new Uint8Array(Buffer.from(encoded, "base64")));
  }
  return Result.succeed(items);
}

const runDpapi = Effect.fn("runDpapi")(function* (
  method: DpapiMethod,
  items: ReadonlyArray<Uint8Array>,
) {
  if (items.length === 0) return [];
  if (process.platform !== "win32") {
    return yield* new TalkSealError({ reason: "DPAPI runs on Windows only" });
  }
  const powershell = windowsPowerShellPath(process.env.SystemRoot);
  if (Result.isFailure(powershell)) {
    return yield* new TalkSealError({ reason: powershell.failure.reason });
  }
  const script = Buffer.from(dpapiScript(method), "utf16le").toString("base64");
  const result = yield* runTool(
    powershell.success,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
    encodeDpapiInput(items),
  ).pipe(Effect.mapError((error) => new TalkSealError({ reason: error.reason })));
  if (result.status !== 0) {
    return yield* new TalkSealError({
      reason: `powershell.exe exited with status ${result.status}: ${result.stderr.trim()}`,
    });
  }
  const parsed = parseDpapiOutput(result.stdout, items.length);
  if (Result.isFailure(parsed)) return yield* new TalkSealError({ reason: parsed.failure });
  return parsed.success;
});

/** DPAPI for the current user; tests on other systems give a stand-in. */
export class TalkDpapi extends Context.Service<
  TalkDpapi,
  {
    readonly protect: (
      items: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<ReadonlyArray<Uint8Array>, TalkSealError>;
    /** One value per item; `undefined` for a blob that DPAPI refused. */
    readonly unprotect: (
      items: ReadonlyArray<Uint8Array>,
    ) => Effect.Effect<ReadonlyArray<Uint8Array | undefined>, TalkSealError>;
  }
>()("docks-kit/talk/TalkDpapi") {
  static readonly layer = Layer.succeed(
    TalkDpapi,
    TalkDpapi.of({
      protect: Effect.fn("TalkDpapi.protect")(function* (items: ReadonlyArray<Uint8Array>) {
        const sealed = yield* runDpapi("Protect", items);
        const blobs: Array<Uint8Array> = [];
        for (const [index, blob] of sealed.entries()) {
          if (blob === undefined)
            return yield* new TalkSealError({ reason: `DPAPI could not seal item ${index}` });
          blobs.push(blob);
        }
        return blobs;
      }),
      unprotect: (items) => runDpapi("Unprotect", items),
    }),
  );
}

/** Seals each entry JSON in one batch. */
export const sealEntries = Effect.fn("sealEntries")(function* (entries: ReadonlyArray<string>) {
  const dpapi = yield* TalkDpapi;
  const encoder = new TextEncoder();
  return yield* dpapi.protect(entries.map((entry) => encoder.encode(entry)));
});

/**
 * Unseals the blobs in one batch, then passes each UTF-8 value to `open`, the
 * caller's decode and id check. Each result holds the value of `open`, its
 * error, or `TalkUnsealRejected` for a blob that did not unseal to UTF-8.
 */
export const unsealEntries = Effect.fn("unsealEntries")(function* <A, E>(
  blobs: ReadonlyArray<Uint8Array>,
  open: (plaintext: string, index: number) => Effect.Effect<A, E>,
) {
  const dpapi = yield* TalkDpapi;
  const values = yield* dpapi.unprotect(blobs);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return yield* Effect.forEach(values, (value, index) => {
    const rejected = (reason: string): Effect.Effect<Result.Result<A, E | TalkUnsealRejected>> =>
      Effect.succeed(Result.fail(new TalkUnsealRejected({ index, reason })));
    if (value === undefined) return rejected("DPAPI could not unseal the blob");
    let plaintext: string;
    try {
      plaintext = decoder.decode(value);
    } catch {
      return rejected("the unsealed value is not UTF-8");
    }
    return Effect.result(open(plaintext, index));
  });
});
