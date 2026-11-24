// The omp transcript fixtures of tests/fixtures/omp/ are real transcripts of the omp releases that SoT/toolchain.json
// pins, redacted with scripts/redact.mjs. The tests read them with the transcript readers of score.mjs, so an omp
// release that moves a record or a field that score.mjs reads fails here, and a raised omp `verified` pin fails until
// the fixtures are captured again with that release:
// - ProbeC1LowR1Full.jsonl and ProbeC1LowR1Manager1.jsonl: the reviewer and the manager of a probe run (`prepare.mjs
//   probe`) with agents of `prepare.mjs agents` (frontmatter model and effort, tier overrides), omp 19.1.1;
// - CodeReview213R9.jsonl: a code-reviewer task agent with reads of skill:// URIs, of local paths with a column cut,
//   and a middle cut of a long read, omp 19.1.1;
// - PinRaise/PinRaise.NestedFixtureScout.jsonl: a nested dispatch with a failed tool call and `model_usage` side
//   calls, omp 19.1.1;
// - FailProbeFlex.jsonl: the probe reviewer of the configuration low-flex (`review-bench-candidate-code-low-flex`,
//   model gpt-6.1-terra, effort low, tier override flex) whose pinned requests failed (`stopReason: "error"`, no
//   served tier): the codex API refused the tier, omp wrote a retry-fallback model_change to gpt-6.2-sol, whose
//   request failed too, and then a second one to claude-opus-5-5, which served the reply, omp 19.1.1;
// - main-session.jsonl: the first 60 records of a main session with several user messages and `model_usage` side
//   calls, omp 19.1.1.
// The synthetic test 'a failed request without a served tier stays out of the model and tier checks and keeps its
// time' adds the case that the failed-request fixture does not show: a message that stopped on an error with a
// served tier.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { belowFloor } from '../../../../cli/src/engine-native/toolchain.ts';
import { RUNTIME_VERSION_PATH } from '../scripts/omp.mjs';
import * as prepare from '../scripts/prepare.mjs';
import {
  checkTranscriptShape,
  dispatchName,
  fixerReplies,
  parseTranscript,
  pickTranscript,
  scoreRuns,
  transcriptFacts,
  transcriptsCommand,
  transcriptSession,
} from '../scripts/score.mjs';
import {
  CODE_KNOWN,
  judgedArm,
  put,
  readJson,
  REPO_ROOT,
  scratch,
  transcriptEntry,
  VERIFIED_OMP,
} from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'omp');
// The fake home folder of scripts/redact.mjs, and the checkout and the plugin root of the captures under it.
const HOME = '/fixture-home';
const CHECKOUT = `${HOME}/projects/docks-kit`;
// The plugin root of the probe agents: `prepare.mjs agents` ran in a second checkout of the repository.
const PROBE_PLUGIN = `${HOME}/checkouts/pins/SoT/.omp/plugin`;
const TERRA = 'openai-codex/gpt-6.1-terra';
const SOL = 'openai-codex/gpt-6.1-sol';
const SOL62 = 'openai-codex/gpt-6.2-sol';
const LUNA = 'openai-codex/gpt-6-luna';
const OPUS = 'anthropic/claude-opus-5-5';

// Each fixture file, relative to FIXTURES.
const fixtureFiles = () =>
  fs
    .readdirSync(FIXTURES, { recursive: true })
    .filter((file) => file.endsWith('.jsonl'))
    .sort();
const fixtureText = (file) => fs.readFileSync(path.join(FIXTURES, file), 'utf8');
const records = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
// The sum of `usage.totalTokens` of the assistant messages of `model`, as omp counts them.
const totalTokens = (text, model) =>
  records(text)
    .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
    .filter((entry) => `${entry.message.provider}/${entry.message.model}` === model)
    .reduce((sum, entry) => sum + entry.message.usage.totalTokens, 0);
// The runtime versions of the records of a transcript.
const runtimeVersions = (text) => [
  ...new Set(
    records(text)
      .map((entry) => RUNTIME_VERSION_PATH.reduce((value, key) => value?.[key], entry))
      .filter((version) => typeof version === 'string'),
  ),
];
// The text of the last assistant message with text: the reply of a task agent of omp 19 (task.structured false).
const lastReply = (text) =>
  records(text)
    .filter((entry) => entry.type === 'message' && entry.message.role === 'assistant')
    .map((entry) => entry.message.content.filter((part) => part.type === 'text').map((part) => part.text))
    .filter((texts) => texts.length)
    .at(-1);

test('the fixture folder holds the six redacted omp transcripts and no private path', () => {
  assert.deepEqual(fixtureFiles(), [
    'CodeReview213R9.jsonl',
    'FailProbeFlex.jsonl',
    'PinRaise/PinRaise.NestedFixtureScout.jsonl',
    'ProbeC1LowR1Full.jsonl',
    'ProbeC1LowR1Manager1.jsonl',
    'main-session.jsonl',
  ]);
  for (const file of fixtureFiles()) {
    const text = fixtureText(file);
    assert.doesNotMatch(text, /\/home\/|\/Users\//, `${file} names a home folder that redact.mjs did not move`);
    for (const entry of records(text)) {
      assert.equal(typeof entry.type, 'string', `${file} has a record without a type`);
      if (entry.type === 'credential_pin') assert.equal(entry.hash, 'redacted', `${file} keeps a credential hash`);
    }
  }
});

test('each fixture was written by an omp release that is not below the omp verified pin of SoT/toolchain.json', () => {
  const toolchain = path.join(REPO_ROOT, 'SoT', 'toolchain.json');
  const { verified } = JSON.parse(fs.readFileSync(toolchain, 'utf8')).tools.omp;
  assert.equal(typeof verified, 'string', `${toolchain} has no omp verified pin`);
  for (const file of fixtureFiles()) {
    const versions = runtimeVersions(fixtureText(file));
    assert.equal(versions.length, 1, `fixture ${file} names the omp versions ${versions.join(', ')}, not one`);
    const [version] = versions;
    assert.ok(
      !belowFloor(version, verified),
      `fixture ${file} was written by omp ${version}, below the omp verified pin ${verified} of SoT/toolchain.json: capture it again with omp ${verified} and scripts/redact.mjs`,
    );
  }
});

test('every fixture passes the transcript shape check of score.mjs transcripts', () => {
  for (const file of fixtureFiles()) checkTranscriptShape(fixtureText(file), file);
});

test('the shape check names a renamed thinking level field and a retyped usage field of a fixture', () => {
  const text = fixtureText('ProbeC1LowR1Full.jsonl');
  const renamed = text.replace('"thinkingLevel":', '"thinkingLevelName":');
  assert.notEqual(renamed, text);
  assert.throws(
    () => checkTranscriptShape(renamed, 'renamed.jsonl'),
    /^Error: renamed\.jsonl does not have the transcript shape of scripts\/omp\.mjs: thinking_level_change\.thinkingLevel is missing\./,
  );
  const retyped = text.replace('"usage":{"input":7209,"output":45,', '"usage":{"input":7209,"output":"45",');
  assert.notEqual(retyped, text);
  assert.throws(
    () => checkTranscriptShape(retyped, 'retyped.jsonl'),
    /: assistant\.message\.usage\.output is of type string, not number\./,
  );
  // Records of two omp versions in one transcript stop the check too.
  const mixed = text.replace('"runtime":{"version":"19.1.1"}', '"runtime":{"version":"19.1.2"}');
  assert.throws(() => checkTranscriptShape(mixed, 'mixed.jsonl'), /its records name more than one omp version/);
});

test('the shape check names a missing and a retyped runtime.version of the records that score.mjs reads', () => {
  const text = fixtureText('ProbeC1LowR1Full.jsonl');
  const rewrite = (change) =>
    records(text)
      .map((entry) => JSON.stringify(change(entry)))
      .join('\n');
  const withoutRuntime = rewrite(({ runtime: _runtime, ...entry }) => entry);
  assert.throws(
    () => checkTranscriptShape(withoutRuntime, 'unversioned.jsonl'),
    /: model_change\.runtime\.version is missing; thinking_level_change\.runtime\.version is missing; assistant\.runtime\.version is missing; toolResult\.runtime\.version is missing\./,
  );
  const retyped = rewrite((entry) => (entry.runtime ? { ...entry, runtime: { version: 19 } } : entry));
  assert.throws(
    () => checkTranscriptShape(retyped, 'retyped.jsonl'),
    /: model_change\.runtime\.version is of type number, not string; thinking_level_change\.runtime\.version is of type number, not string; assistant\.runtime\.version is of type number, not string; toolResult\.runtime\.version is of type number, not string\./,
  );
});

test('the probe reviewer fixture gives the pinned model, effort, and tier, the tokens of omp, and the reply text', () => {
  const file = 'ProbeC1LowR1Full.jsonl';
  const text = fixtureText(file);
  const timing = parseTranscript(text, file, TERRA);
  assert.deepEqual(timing, { seconds: 3.7, tokens: 17956 });
  assert.equal(timing.tokens, totalTokens(text, TERRA));
  const pinned = { model: TERRA, effort: 'low', servedTier: 'default' };
  assert.deepEqual(transcriptFacts(text, file), {
    requestedTier: 'default',
    messages: [pinned, pinned],
    sideCalls: [],
    ompVersion: '19.1.1',
    toolCalls: [{ name: 'read', path: `${PROBE_PLUGIN}/skills/code-reviewer/SKILL.md` }],
  });
  assert.deepEqual(transcriptSession(text, file), {
    cwd: CHECKOUT,
    pluginRoots: [PROBE_PLUGIN],
    agentFiles: [],
    skillRoots: [],
  });
  // omp 19 gives a task agent without an output schema no yield tool: the reply is the text of its last message.
  // This reviewer answered the probe task with a blocked review block, not `ready`; the probe checks only the model,
  // the effort, and the tier.
  const reply =
    '### Code review round unspecified\n\nCode-review: blocked\n\nMissing review inputs: round mode, issue number, plan export, diff paths, and base-instructions folder.\n\n## Standards\n\nNone.\n\n## Spec\n\nNone.';
  assert.deepEqual(lastReply(text), [reply]);
  assert.ok(!text.includes('"name":"yield"'));
  assert.deepEqual(fixerReplies(text, file), {});
  const repaired = text.replace(
    `"text":${JSON.stringify(reply)}`,
    '"text":"- `code-7/C1-low/run-1/round-1/full#1`: repaired"',
  );
  assert.notEqual(repaired, text);
  assert.deepEqual(fixerReplies(repaired, file), { 'code-7/C1-low/run-1/round-1/full#1': 'repaired' });
});

test('the probe manager fixture gives the manager setting and its reply text', () => {
  const file = 'ProbeC1LowR1Manager1.jsonl';
  const text = fixtureText(file);
  assert.deepEqual(parseTranscript(text, file, SOL), { seconds: 5.1, tokens: 5342 });
  assert.equal(parseTranscript(text, file, SOL).tokens, totalTokens(text, SOL));
  assert.deepEqual(transcriptFacts(text, file), {
    requestedTier: 'priority',
    messages: [{ model: SOL, effort: 'high', servedTier: 'priority' }],
    sideCalls: [],
    ompVersion: '19.1.1',
  });
  assert.deepEqual(lastReply(text), ['ready']);
  assert.deepEqual(transcriptSession(text, file), { cwd: CHECKOUT, pluginRoots: [], agentFiles: [], skillRoots: [] });
});

test('the failed-request fixture keeps both failed requests out of the model and tier checks and shows the fallbacks', () => {
  const file = 'FailProbeFlex.jsonl';
  const text = fixtureText(file);
  checkTranscriptShape(text, file);
  // The codex API refused the tier flex of the agent. omp then wrote a retry-fallback model_change to another model,
  // with its own thinking level, and the request of that model stopped on the same error with no served tier. A
  // second fallback to an Anthropic model served the reply. The facts show the fallbacks in the models of the
  // messages, and the requested tier of the family of the last model: the session asks for an OpenAI tier only.
  const config = { name: 'low-flex', model: TERRA, effort: 'low', tier: 'flex' };
  assert.deepEqual(transcriptFacts(text, file), {
    requestedTier: null,
    messages: [
      { model: TERRA, effort: 'high', servedTier: null, failed: true },
      { model: SOL62, effort: 'high', servedTier: null, failed: true },
      { model: OPUS, effort: 'high', servedTier: null },
    ],
    sideCalls: [],
    ompVersion: '19.1.1',
  });
  assert.deepEqual(
    records(text)
      .filter((entry) => entry.type === 'model_change' && entry.role === 'fallback')
      .map((entry) => entry.model),
    [SOL62, OPUS],
  );
  // The time of the failed requests is real wall time, also of the fallback model; no message of the configured
  // model has tokens.
  assert.deepEqual(parseTranscript(text, file, TERRA), { seconds: 0.6, tokens: 0 });
  // Neither failed request counts as a message of another model or of another served tier: only the served message
  // of the second fallback model makes the run invalid, by its model and its effort.
  const fixture = judgedArm(CODE_KNOWN.slice(0, 1), [[]], [transcriptEntry(text, TERRA)]);
  for (const meta of Object.values(fixture.metas)) meta.config = config;
  assert.deepEqual(
    scoreRuns(fixture).runs.map((run) => run.invalid),
    [['correctness: model anthropic/claude-opus-5-5, not openai-codex/gpt-6.1-terra', 'correctness: effort high, not low']],
  );
});

test('the code-reviewer fixture records its reads, the column cut, and a middle cut with head and tail ranges', () => {
  const file = 'CodeReview213R9.jsonl';
  const text = fixtureText(file);
  assert.deepEqual(parseTranscript(text, file, SOL62), { seconds: 55.9, tokens: 354375 });
  assert.equal(parseTranscript(text, file, SOL62).tokens, totalTokens(text, SOL62));
  const facts = transcriptFacts(text, file);
  assert.equal(facts.requestedTier, 'priority');
  assert.deepEqual(
    [...new Set(facts.messages.map((message) => JSON.stringify(message)))],
    [JSON.stringify({ model: SOL62, effort: 'high', servedTier: 'priority' })],
  );
  assert.equal(facts.toolCalls.length, 40);
  const paths = facts.toolCalls.map((call) => call.path);
  for (const uri of ['skill://code-reviewer/SKILL.md', 'skill://unslop']) assert.ok(paths.includes(uri), uri);
  assert.ok(paths.includes(`${CHECKOUT}/.git/docks-review/code-review-213-round-9-delta.diff`));
  const details = records(text)
    .filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult')
    .map((entry) => entry.message.details);
  // A read with a line longer than the column limit records the limit (score.mjs resultLines).
  assert.ok(details.some((detail) => Number.isInteger(detail?.meta?.limits?.columnTruncated?.maxColumn)));
  // A middle cut of omp 19 shows its head and tail ranges, while its line numbers cover the whole file. So the read
  // coverage takes the ranges (score.mjs resultLines).
  const middle = details.find((detail) => detail?.meta?.truncation?.headRange);
  assert.deepEqual(
    [middle.meta.truncation.headRange, middle.meta.truncation.tailRange],
    [
      { start: 1, end: 355 },
      { start: 988, end: 1352 },
    ],
  );
  const numbers = middle.displayContent.lineNumbers;
  assert.deepEqual([numbers.length, numbers[0], numbers.at(-1)], [1351, 1, 1351]);
  // A read of a file by an end cut gives its shown range.
  assert.ok(details.some((detail) => Number.isInteger(detail?.meta?.truncation?.shownRange?.start)));
});

test('the nested dispatch fixture is picked by its child name and keeps its side calls out of the tokens', () => {
  const files = fixtureFiles().map((file) => path.join(FIXTURES, file));
  const nested = path.join(FIXTURES, 'PinRaise', 'PinRaise.NestedFixtureScout.jsonl');
  assert.equal(
    pickTranscript(files, 'NestedFixtureScout', () => true),
    nested,
  );
  const text = fs.readFileSync(nested, 'utf8');
  const file = path.basename(nested);
  assert.deepEqual(parseTranscript(text, file, LUNA), { seconds: 14.7, tokens: 25868 });
  assert.equal(parseTranscript(text, file, LUNA).tokens, totalTokens(text, LUNA));
  const facts = transcriptFacts(text, file);
  assert.equal(facts.requestedTier, 'priority');
  assert.deepEqual(
    [...new Set(facts.messages.map((message) => JSON.stringify(message)))],
    [JSON.stringify({ model: LUNA, effort: 'medium', servedTier: 'priority' })],
  );
  assert.equal(facts.ompVersion, '19.1.1');
  assert.ok(facts.sideCalls.every((call) => call.model === 'openrouter/typesafe/jev-1.14'));
  assert.deepEqual(
    facts.sideCalls.map((call) => call.purpose),
    ['find', 'find', 'find', 'find'],
  );
  // The side calls do not count: the tokens above are the sum of the assistant messages only.
  assert.equal(
    facts.sideCalls.reduce((sum, call) => sum + call.tokens, 0),
    14819,
  );
  // A call that omp did not run has an error result: the read of a file that does not exist.
  assert.deepEqual(
    facts.toolCalls.filter((call) => call.error).map((call) => call.path),
    [`${HOME}/checkouts/pins/cli/src/engine-native/no-such-file.ts`],
  );
  assert.equal(transcriptSession(text, file).cwd, CHECKOUT);
});

test('the main-session fixture marks more than one task as revived and lists its model_usage side calls', () => {
  const file = 'main-session.jsonl';
  const text = fixtureText(file);
  assert.deepEqual(parseTranscript(text, file, OPUS), { seconds: 411.5, tokens: 652565 });
  assert.equal(parseTranscript(text, file, OPUS).tokens, totalTokens(text, OPUS));
  const facts = transcriptFacts(text, file);
  assert.equal(facts.revived, true);
  assert.equal(facts.requestedTier, null);
  assert.deepEqual(
    facts.sideCalls.map((call) => [call.model, call.purpose]),
    [
      [LUNA, 'skill-description'],
      [OPUS, 'title-fork'],
      ['openrouter/typesafe/jev-1.14', 'auto-graph'],
      [OPUS, 'composer-prediction'],
    ],
  );
  assert.deepEqual(
    facts.sideCalls.map((call) => call.tokens),
    [199, 26141, 2401, 38946],
  );
});

test('transcripts reads the probe fixtures into the probe workspace with the configuration of the probe', () => {
  const root = scratch();
  const ws = path.join(root, 'ws');
  const project = path.join(root, 'project');
  const sessions = path.join(root, 'sessions');
  const config = { name: 'low', model: TERRA, effort: 'low', tier: 'default' };
  const manager = { model: SOL, effort: 'high', tier: 'priority' };
  put(project, '.omp/agents/review-bench-configs.json', { configs: [config], manager });
  // The probe runs the omp version check first; this runner answers it as the omp that wrote the fixtures.
  const run = (args) => {
    assert.deepEqual(args, ['--version']);
    return { status: 0, stdout: `omp/${VERIFIED_OMP}\n`, stderr: '' };
  };
  prepare.prepareProbe({ out: ws, project }, REPO_ROOT, { run });
  // The captures ran in the probe workspace <home>/.cache/docks-kit/scratch/pinraise-EjcLjA/bench-probe/probe: the
  // fixtures name it under the fake home folder, so the test moves it to this workspace.
  const captured = `${HOME}/.cache/docks-kit/scratch/pinraise-EjcLjA/bench-probe/probe`;
  for (const name of ['ProbeC1LowR1Full', 'ProbeC1LowR1Manager1']) {
    put(sessions, `${name}.jsonl`, fixtureText(`${name}.jsonl`).replaceAll(captured, ws));
  }
  const runDir = path.join(ws, 'probe', 'C1-low', 'run-1');
  assert.equal(dispatchName('probe', 'C1-low', 'run-1', 'full'), 'ProbeC1LowR1Full');
  assert.deepEqual(transcriptsCommand(ws, sessions).sort(), ['ProbeC1LowR1Full', 'ProbeC1LowR1Manager1']);
  const meta = readJson(path.join(runDir, 'meta.json'));
  const reviewer = meta.reviewers.full;
  assert.deepEqual([reviewer.seconds, reviewer.tokens, reviewer.ompVersion], [3.7, 17956, '19.1.1']);
  // The transcript shows the configuration of the probe at every message.
  assert.equal(reviewer.requestedTier, config.tier);
  for (const message of reviewer.messages) {
    assert.deepEqual(message, { model: config.model, effort: config.effort, servedTier: config.tier });
  }
  assert.equal(reviewer.revived, undefined);
  // The reviewer read the skill of its own plugin root only.
  assert.deepEqual(reviewer.readScope, { outside: [] });
  const managerEntry = meta.manager.agents['manager-1'];
  assert.deepEqual([managerEntry.requestedTier, managerEntry.ompVersion], [manager.tier, '19.1.1']);
  assert.deepEqual(managerEntry.messages, [{ model: manager.model, effort: manager.effort, servedTier: manager.tier }]);
});
