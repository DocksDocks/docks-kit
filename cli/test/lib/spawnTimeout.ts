/**
 * Per-case timeout ceilings for the unit suite.
 *
 * Several suites spawn the public CLI as a child. They launch a prebuilt
 * bundle of `cli/src/main.ts`, or `cli/src/main.ts` itself when
 * `DOCKS_KIT_TEST_CLI_ENTRY` names it; the helper `cliEntry.ts` builds the
 * bundle and picks the entry. A launch takes well under a second warm on a
 * developer machine, so the ceilings exist for runner variance rather than for
 * the work itself.
 *
 * The Windows values are higher because `windows-2025` runner throughput
 * varies by a factor of two to six. Two attempts of the same parity run
 * executed identical bytes and restored the identical Bun cache key, yet the
 * unit suite took 134 seconds on the first attempt and 61 seconds on the
 * second. The slowdown is the machine, not this repository: the checkout step
 * of the same two attempts took 36 seconds and 6 seconds, and it reads no
 * dependency and runs no Bun. On the slow attempt one case crossed the
 * 15000 ms default ceiling and one spawn-heavy case crossed the 30000 ms
 * spawn ceiling, while the fast attempt passed every case. Spawn-based cases
 * absorb that variance first.
 *
 * A loaded developer machine varies as much. During plan #246, a full
 * `bun run test:unit` whose load average rose from 9 to about 18 took
 * 44.9 seconds for a spawn case that ran several scenarios and up to
 * 26 seconds for a spawn case of one fixture, which take 7.4 and 3 seconds at
 * a light load. So the Linux and macOS spawn ceiling is 60000 ms, the ceiling
 * that `vitest.config.ts` gives the review-benchmark project for the same
 * reason.
 *
 * A ceiling is the deadline of a case: a case that runs past it fails. Vitest
 * checks the deadline of a synchronous case only after its body returns, so a
 * larger ceiling can leave the time of that report unchanged or move it later.
 * A ceiling does not stop a child that never exits; a child process needs its
 * own timeout for that. `ompTriggerBackstop.test.ts` derives its deadlines
 * from the spawn ceiling.
 *
 * A ceiling covers one fixture. A case that loops over a list of independent
 * fixtures adds the time of every fixture to one case, so under load such a
 * case crosses its ceiling while each fixture alone stays far below it. So
 * write one case per fixture with `it.each`, each with its own setup, instead
 * of a loop inside one case.
 */

const WINDOWS = process.platform === "win32";

/** Default ceiling for every case in the unit suite. */
export const TEST_TIMEOUT_MS = WINDOWS ? 45_000 : 15_000;

/** Ceiling for a case that spawns the public CLI at least once. */
export const SPAWN_TIMEOUT_MS = WINDOWS ? 90_000 : 60_000;
