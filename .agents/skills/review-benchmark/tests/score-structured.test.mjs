import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { BUN_RUNTIME } from '../../../../cli/test/lib/cliEntry.ts';
import {
  buildPairs,
  dispatchName,
  parseBlock,
  readScope,
  scoreRuns,
  structuredReply,
  transcriptEntries,
} from '../scripts/score.mjs';
import {
  assistantLine,
  CONFIGS,
  copyScripts,
  isoAt,
  jsonl,
  LIVE,
  LIVE_PLUGIN,
  MODEL,
  put,
  readJson,
  readText,
  reads,
  SCRIPTS_DIR,
  scratch,
  sessionRecord,
  taskMessage,
  VERIFIED_OMP,
} from './helpers.mjs';

// Plan #229 step 2: the structured replies of the bundled agents `reviewer` and `security-reviewer`.
//
// - parseBlock(text, family, reviewer): for the reviewer `reviewer` or `security-reviewer`, `text` is the JSON object
//   that `transcripts` wrote. The object must fit the whole output schema of the vendored agent. A finding gets the
//   severity of its priority (0 to 3: CRITICAL, HIGH, MEDIUM, LOW) or of its severity (`informational` gives LOW), and
//   every location. The verdict is `fixes-required` for a finding or for `overall_correctness: incorrect`, `pass`
//   otherwise, and `unreadable`, with no finding, for an object that does not fit the schema.
// - structuredReply(entries, reviewer) and `score.mjs transcripts`: a run whose meta.json has `bundledOmp` gets its
//   block from what omp accepted from each `yield` call, the `details` of the tool result, folded in call order; a
//   problem gives `replyError` and the block `{ unreadable, reply }`, which `score.mjs findings` reads as unreadable.
// - The R1 and V1 reviewers get the read scope of their prompt: the snapshot and the full diff only.

const REVIEWER_FINDING = {
  title: 'Check the lock owner before release',
  body: 'release() frees a lock that another caller holds, so two writers run at once.',
  priority: 1,
  confidence: 0.9,
  file_path: 'src/lock.mjs',
  line_start: 12,
  line_end: 14,
};
const REVIEWER_REPLY = {
  overall_correctness: 'incorrect',
  explanation: 'The release path frees a foreign lock.',
  confidence: 0.8,
  findings: [REVIEWER_FINDING, { ...REVIEWER_FINDING, priority: 0, file_path: 'src/other.mjs', line_end: 12 }],
};
const SECURITY_FINDING = {
  rule_id: 'cmd-injection',
  title: 'Shell command takes the branch name',
  summary: 'The branch name goes into a shell string.',
  severity: 'informational',
  confidence: 'high',
  category: 'injection',
  locations: [
    { path: 'src/input.mjs', start_line: 3, role: 'source' },
    { path: 'src/exec.mjs', start_line: 20, end_line: 22, role: 'sink' },
  ],
  cwe: ['CWE-78'],
  evidence: [{ label: 'sink', explanation: 'execSync gets the joined string.' }],
};

test('parseBlock converts the reply of reviewer into findings and a verdict', () => {
  const { verdict, findings } = parseBlock(JSON.stringify(REVIEWER_REPLY), 'code', 'reviewer');
  assert.equal(verdict, 'fixes-required');
  assert.deepEqual(findings, [
    {
      type: 'code',
      severity: 'HIGH',
      category: '',
      locator: 'src/lock.mjs:12-14',
      files: [{ file: 'src/lock.mjs', start: 12, end: 14 }],
      text: `${REVIEWER_FINDING.title}: ${REVIEWER_FINDING.body}`,
    },
    {
      type: 'code',
      severity: 'CRITICAL',
      category: '',
      locator: 'src/other.mjs:12',
      files: [{ file: 'src/other.mjs', start: 12, end: 12 }],
      text: `${REVIEWER_FINDING.title}: ${REVIEWER_FINDING.body}`,
    },
  ]);
  // Priority 2 and 3 give MEDIUM and LOW.
  const low = { ...REVIEWER_REPLY, findings: [2, 3].map((priority) => ({ ...REVIEWER_FINDING, priority })) };
  const severities = parseBlock(JSON.stringify(low), 'code', 'reviewer').findings.map((item) => item.severity);
  assert.deepEqual(severities, ['MEDIUM', 'LOW']);
  // `incorrect` without a finding still needs fixes; `correct` without a finding passes.
  const parsed = (reply) => parseBlock(JSON.stringify(reply), 'code', 'reviewer');
  const verdictOf = (reply) => parsed(reply).verdict;
  assert.equal(verdictOf({ ...REVIEWER_REPLY, findings: [] }), 'fixes-required');
  assert.equal(verdictOf({ ...REVIEWER_REPLY, overall_correctness: 'correct', findings: [] }), 'pass');
  // A finding makes the verdict `fixes-required` also when the agent calls the change correct.
  assert.equal(verdictOf({ ...REVIEWER_REPLY, overall_correctness: 'correct' }), 'fixes-required');
  // A reply without explanation and confidence, and a text that is no JSON, are unreadable and give no finding.
  assert.deepEqual(parsed({ overall_correctness: 'incorrect', findings: [REVIEWER_FINDING] }), {
    verdict: 'unreadable',
    findings: [],
  });
  assert.deepEqual(parseBlock('Verdict: incorrect', 'code', 'reviewer'), { verdict: 'unreadable', findings: [] });
  // The whole output schema counts: a finding without a required field, a field of the wrong type, and a key that the
  // schema does not have make the reply unreadable.
  const { body: _body, ...bodiless } = REVIEWER_FINDING;
  for (const finding of [bodiless, { ...REVIEWER_FINDING, line_start: '12' }, { ...REVIEWER_FINDING, note: 'x' }]) {
    assert.deepEqual(parsed({ ...REVIEWER_REPLY, findings: [finding] }), { verdict: 'unreadable', findings: [] });
  }
  assert.equal(verdictOf({ ...REVIEWER_REPLY, overall_correctness: 'maybe' }), 'unreadable');
});

test('parseBlock converts the reply of security-reviewer and keeps every location', () => {
  const reply = { coverage_summary: 'Read src/.', findings: [SECURITY_FINDING], reviewed_paths: ['src'] };
  const { verdict, findings } = parseBlock(JSON.stringify(reply), 'code', 'security-reviewer');
  assert.equal(verdict, 'fixes-required');
  assert.deepEqual(findings, [
    {
      type: 'code',
      severity: 'LOW',
      category: 'injection',
      locator: 'src/input.mjs:3; src/exec.mjs:20-22',
      files: [
        { file: 'src/input.mjs', start: 3, end: 3 },
        { file: 'src/exec.mjs', start: 20, end: 22 },
      ],
      text: `${SECURITY_FINDING.title}: ${SECURITY_FINDING.summary} Evidence: sink: execSync gets the joined string.`,
    },
  ]);
  const severity = (value) =>
    parseBlock(JSON.stringify({ ...reply, findings: [{ ...SECURITY_FINDING, severity: value }] }), 'code', 'security-reviewer')
      .findings[0].severity;
  assert.deepEqual(['critical', 'high', 'medium', 'low'].map(severity), ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(parseBlock(JSON.stringify({ coverage_summary: 'Read src/.', findings: [] }), 'code', 'security-reviewer').verdict, 'pass');
  // Without coverage_summary, and with a location without its line, the reply does not fit the schema.
  const unreadable = { verdict: 'unreadable', findings: [] };
  assert.deepEqual(parseBlock(JSON.stringify({ findings: [SECURITY_FINDING] }), 'code', 'security-reviewer'), unreadable);
  const lineless = { ...SECURITY_FINDING, locations: [{ path: 'src/exec.mjs' }] };
  assert.deepEqual(parseBlock(JSON.stringify({ ...reply, findings: [lineless] }), 'code', 'security-reviewer'), unreadable);
});

// A call of the yield tool as omp 19.1.1 records it (packages/coding-agent/src/tools/yield.ts): the assistant tool call
// with the raw arguments of the agent, and its tool result. The result of an accepted call has `details` with what omp
// accepted: `data` after omp normalized it, `status` (`success` or `aborted`), `error`, `type`, and `schemaOverridden`,
// without the fields that are undefined. The result of a refused call is an error with empty details.
const section = (id, type, data, args = { type, data }) => ({ id, args, details: { data, status: 'success', type } });
const refused = (id, args, text = 'Output does not match schema') => ({ id, args, refused: text });
// The verdict sections of a reply of `reviewer`.
const VERDICT_CALLS = [
  section('c3', ['overall_correctness'], 'incorrect'),
  section('c4', ['explanation'], 'The release path frees a foreign lock.'),
  section('c5', ['confidence'], 0.8),
];
const FINDING_CALL = section('c1', ['findings'], REVIEWER_FINDING);
// omp refused this call (an error result), so its finding is not part of the reply.
const REFUSED_CALL = refused('c2', { type: ['findings'], data: { title: 'Refused', priority: 'high' } });
// The message of omp when it aborts a child after empty yield calls (yield.ts MAX_EMPTY_RESULT_RETRIES).
const EMPTY_ABORT =
  'yield result stayed empty after 4 consecutive attempt(s); aborting child instead of retrying forever. Submit success as {"data":<your output>} or failure as {"error":"message"}.';

// A transcript of the agent `agent` for the case folder `caseDir`: the read calls of `readPaths` with their results,
// then one assistant message per yield call of `calls` with its tool result, and a last assistant message.
function bundledTranscript(caseDir, agent, calls, { version = VERIFIED_OMP, stopReason = 'stop', readPaths = [] } = {}) {
  const runtime = { runtime: { version } };
  const lines = [
    sessionRecord({ cwd: LIVE }),
    { type: 'model_change', timestamp: isoAt(0), model: MODEL, ...runtime },
    { type: 'thinking_level_change', timestamp: isoAt(0), thinkingLevel: 'low', ...runtime },
    { type: 'session_init', timestamp: isoAt(0), agent, systemPrompt: ['Find bugs.'], ...runtime },
    { type: 'message', timestamp: isoAt(0), message: taskMessage(caseDir), ...runtime },
  ];
  const assistant = (second, content, reason) => {
    const line = assistantLine(second, 'openai-codex', 'gpt-6.1-sol', 'default', { input: 10, output: 5 });
    line.message.content = content;
    line.message.stopReason = reason;
    return { ...line, ...runtime };
  };
  const result = (second, toolCallId, toolName, text, details, isError) => ({
    type: 'message',
    timestamp: isoAt(second),
    message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], details, isError },
    ...runtime,
  });
  if (readPaths.length) {
    const ids = readPaths.map((_, index) => `r${index + 1}`);
    lines.push(assistant(1, readPaths.map((target, index) => ({ type: 'toolCall', id: ids[index], name: 'read', arguments: { path: target } })), 'toolUse'));
    for (const id of ids) lines.push(result(1, id, 'read', 'text', {}, false));
  }
  for (const [index, call] of calls.entries()) {
    lines.push(assistant(index + 2, [{ type: 'toolCall', id: call.id, name: 'yield', arguments: call.args }], 'toolUse'));
    if (call.refused !== undefined) {
      lines.push(result(index + 2, call.id, 'yield', call.refused, {}, true));
    } else {
      const text = call.details.status === 'aborted' ? `Task aborted: ${call.details.error}` : 'Result submitted.';
      lines.push(result(index + 2, call.id, 'yield', text, call.details, false));
    }
  }
  lines.push(assistant(calls.length + 2, [{ type: 'text', text: 'Done.' }], stopReason));
  return jsonl(lines);
}

// A workspace with one R1 run per entry of `runs` ({ id, calls, options }) of the reviewer `reviewer`, with its prompt,
// a meta.json with the vendored omp version, and its transcript in the session folder.
function bundledWorkspace(runs) {
  const root = scratch();
  const ws = path.join(root, 'ws');
  const sessions = path.join(root, 'sessions');
  const agent = 'review-bench-bundled-reviewer-low';
  for (const { id, calls, options } of runs) {
    const caseDir = path.join(ws, id);
    put(ws, `${id}/case.json`, { id, kind: 'code', split: 'dev' });
    put(ws, `${id}/plan.md`, '# The plan of the pull request\n');
    put(ws, `${id}/snapshot/src/lock.mjs`, 'export const lock = 1;\n');
    put(ws, `${id}/full.diff`, 'diff --git a/src/lock.mjs b/src/lock.mjs\n--- a/src/lock.mjs\n+++ b/src/lock.mjs\n@@ -1 +1 @@\n-a\n+b\n');
    put(ws, `${id}/R1-low/run-1/prompts/reviewer.txt`, `agent: ${agent}\n\nFull diff: ${caseDir}/full.diff\n`);
    put(ws, `${id}/R1-low/run-1/meta.json`, { config: CONFIGS.low, bundledOmp: VERIFIED_OMP });
    fs.mkdirSync(path.join(ws, id, 'R1-low', 'run-1', 'blocks'), { recursive: true });
    const name = dispatchName(id, 'R1-low', 'run-1', 'reviewer');
    put(sessions, `${name}.jsonl`, bundledTranscript(caseDir, agent, calls, options));
  }
  return { ws, sessions };
}

// Runs a command of the score.mjs command line (`script`, by default the score.mjs of this checkout) on Bun and gives
// the child process.
const scoreChild = (args, script = path.join(SCRIPTS_DIR, 'score.mjs')) =>
  spawnSync(BUN_RUNTIME, [script, ...args], { encoding: 'utf8' });
// Runs a command of the score.mjs command line on Bun and gives its output.
function scoreCli(...args) {
  const child = scoreChild(args);
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim();
}

test('transcripts folds what omp accepted from each yield call of a bundled run into its block', () => {
  const { ws, sessions } = bundledWorkspace([
    {
      id: 'bundled-bug-01',
      calls: [
        // The agent sent the finding as a JSON text; omp decoded it and recorded the object in `details.data`.
        section('c1', ['findings'], REVIEWER_FINDING, { type: ['findings'], data: JSON.stringify(REVIEWER_FINDING) }),
        REFUSED_CALL,
        // A filler `error` next to `data` is no error for omp: the details have no error and the status success.
        section('c6', ['overall_correctness'], 'incorrect', { type: ['overall_correctness'], data: 'incorrect', error: 'n/a' }),
        ...VERDICT_CALLS.slice(1),
      ],
    },
  ]);
  assert.equal(scoreCli('transcripts', ws, '--omp-sessions', sessions), 'meta.json: 1 reviewers updated');
  const run = path.join(ws, 'bundled-bug-01', 'R1-low', 'run-1');
  // The finding and the three verdict sections, without the refused call, in the order of the calls.
  assert.deepEqual(readJson(path.join(run, 'blocks', 'reviewer.md')), {
    findings: [REVIEWER_FINDING],
    overall_correctness: 'incorrect',
    explanation: 'The release path frees a foreign lock.',
    confidence: 0.8,
  });
  const entry = readJson(path.join(run, 'meta.json')).reviewers.reviewer;
  assert.equal(entry.replyError, undefined);
  assert.equal(entry.ompVersion, VERIFIED_OMP);
  // `findings` reads the block as a structured reply.
  assert.equal(scoreCli('findings', ws), 'findings.json: 1 findings in 1 blocks (0 missing, 0 unreadable)');
  const { blocks, findings } = readJson(path.join(ws, 'findings.json'));
  assert.deepEqual(
    blocks.map((block) => [block.reviewer, block.verdict, block.findings]),
    [['reviewer', 'fixes-required', 1]],
  );
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.severity, finding.locator]),
    [['bundled-bug-01/R1-low/run-1/reviewer#1', 'HIGH', 'src/lock.mjs:12-14']],
  );
});

test('structuredReply keeps the last scalar section, a terminal result, and an abort that omp recorded', () => {
  const entries = (calls, options) => transcriptEntries(bundledTranscript('/work/ws/c', 'a', calls, options));
  // A repeated verdict section replaces the earlier one; findings stay a list.
  const repeated = structuredReply(
    entries([...VERDICT_CALLS, section('c6', ['overall_correctness'], 'correct')]),
    'reviewer',
  );
  assert.equal(repeated.problem, null);
  assert.equal(repeated.data.overall_correctness, 'correct');
  // A terminal call with data is the whole reply.
  const whole = { coverage_summary: 'Read src/.', findings: [SECURITY_FINDING] };
  const terminal = structuredReply(entries([{ id: 't1', args: { data: whole }, details: { data: whole, status: 'success' } }]), 'security-reviewer');
  assert.deepEqual(terminal, { data: whole, problem: null });
  // A last call that the agent ended with an error aborts the task.
  const error = 'cannot read the diff';
  const aborted = structuredReply(
    entries([FINDING_CALL, { id: 'e1', args: { error }, details: { status: 'aborted', error } }]),
    'reviewer',
  );
  assert.deepEqual(aborted, { data: { aborted: true, error }, problem: `reviewer aborted its task: ${error}` });
  // omp aborts a child after empty yield calls, also after valid sections. The arguments of the last call hold no
  // error: only the details of its result show the abort.
  const empty = (id) => refused(id, {}, 'yield must contain either `data` or `error`.');
  const emptied = structuredReply(
    entries([
      FINDING_CALL,
      ...VERDICT_CALLS,
      empty('x1'),
      empty('x2'),
      empty('x3'),
      { id: 'x4', args: {}, details: { status: 'aborted', error: EMPTY_ABORT } },
    ]),
    'reviewer',
  );
  assert.deepEqual(emptied, { data: { aborted: true, error: EMPTY_ABORT }, problem: `reviewer aborted its task: ${EMPTY_ABORT}` });
  // An aborted run is not valid, also when its sections fit the schema.
  const stopped = structuredReply(entries(VERDICT_CALLS, { stopReason: 'aborted' }), 'reviewer');
  assert.equal(stopped.problem, 'the run of reviewer was aborted');
  // A call without a tool result adds nothing.
  const unanswered = transcriptEntries(bundledTranscript('/work/ws/c', 'a', VERDICT_CALLS)).filter(
    (entry) => entry.message?.toolCallId !== 'c5',
  );
  assert.equal(
    structuredReply(unanswered, 'reviewer').problem,
    'the result fails the output schema of reviewer: no confidence',
  );
});

test('transcripts marks invalid a bundled run with an unreadable reply, and findings gives its block no finding', () => {
  const { body: _body, ...bodiless } = REVIEWER_FINDING;
  const { ws, sessions } = bundledWorkspace([
    { id: 'bundled-bug-02', calls: [FINDING_CALL] },
    { id: 'bundled-bug-03', calls: [FINDING_CALL, VERDICT_CALLS[0]] },
    { id: 'bundled-bug-04', calls: [FINDING_CALL, ...VERDICT_CALLS], options: { version: '19.0.0' } },
    { id: 'bundled-bug-05', calls: [FINDING_CALL, ...VERDICT_CALLS] },
    // omp accepted a finding without its body after its schema retries.
    {
      id: 'bundled-bug-06',
      calls: [
        { id: 'c1', args: { type: ['findings'], data: bodiless }, details: { data: bodiless, status: 'success', type: ['findings'], schemaOverridden: true } },
        ...VERDICT_CALLS,
      ],
    },
    // The run stopped after valid sections.
    { id: 'bundled-bug-07', calls: [FINDING_CALL, ...VERDICT_CALLS], options: { stopReason: 'aborted' } },
    // omp aborted the child after valid sections.
    {
      id: 'bundled-bug-08',
      calls: [FINDING_CALL, ...VERDICT_CALLS, { id: 'x4', args: {}, details: { status: 'aborted', error: EMPTY_ABORT } }],
    },
  ]);
  const runDir = (id) => path.join(ws, id, 'R1-low', 'run-1');
  // An earlier block of the run of another omp goes away.
  put(runDir('bundled-bug-04'), 'blocks/reviewer.md', JSON.stringify(REVIEWER_REPLY));
  assert.equal(scoreCli('transcripts', ws, '--omp-sessions', sessions), 'meta.json: 7 reviewers updated');
  const replyError = (id) => readJson(path.join(runDir(id), 'meta.json')).reviewers.reviewer.replyError;
  const expected = {
    'bundled-bug-02': 'the result fails the output schema of reviewer: no overall_correctness, no explanation, no confidence',
    'bundled-bug-03': 'the result fails the output schema of reviewer: no explanation, no confidence',
    'bundled-bug-04': `the transcript shows omp 19.0.0, not omp ${VERIFIED_OMP} of the vendored agents`,
    'bundled-bug-05': undefined,
    'bundled-bug-06': 'the result fails the output schema of reviewer: no findings[0].body',
    'bundled-bug-07': 'the run of reviewer was aborted',
    'bundled-bug-08': `reviewer aborted its task: ${EMPTY_ABORT}`,
  };
  for (const [id, reason] of Object.entries(expected)) assert.equal(replyError(id), reason, id);
  assert.equal(fs.existsSync(path.join(runDir('bundled-bug-04'), 'blocks', 'reviewer.md')), false);
  // The block of each run with a problem keeps the reason and what the agent yielded, for a diagnosis.
  const block = (id) => readJson(path.join(runDir(id), 'blocks', 'reviewer.md'));
  assert.deepEqual(block('bundled-bug-03'), {
    unreadable: expected['bundled-bug-03'],
    reply: { findings: [REVIEWER_FINDING], overall_correctness: 'incorrect' },
  });
  const verdict = { overall_correctness: 'incorrect', explanation: 'The release path frees a foreign lock.', confidence: 0.8 };
  assert.deepEqual(block('bundled-bug-07'), { unreadable: expected['bundled-bug-07'], reply: { findings: [REVIEWER_FINDING], ...verdict } });
  assert.deepEqual(block('bundled-bug-08'), {
    unreadable: expected['bundled-bug-08'],
    reply: { aborted: true, error: EMPTY_ABORT },
  });
  assert.equal(scoreCli('findings', ws), 'findings.json: 1 findings in 7 blocks (1 missing, 5 unreadable)');
  const doc = readJson(path.join(ws, 'findings.json'));
  assert.deepEqual(
    doc.blocks.map((item) => [item.case, item.verdict, item.findings]),
    [
      ['bundled-bug-02', 'unreadable', 0],
      ['bundled-bug-03', 'unreadable', 0],
      ['bundled-bug-04', 'missing', 0],
      ['bundled-bug-05', 'fixes-required', 1],
      ['bundled-bug-06', 'unreadable', 0],
      ['bundled-bug-07', 'unreadable', 0],
      ['bundled-bug-08', 'unreadable', 0],
    ],
  );
  // Only the valid run gives a finding to the judge, also though each unreadable reply holds a finding in the file of
  // the known defect.
  const ids = doc.blocks.map((item) => item.case);
  const known = [{ id: 'K1', locator: 'src/lock.mjs:12' }];
  const pairs = buildPairs(doc, Object.fromEntries(ids.map((id) => [id, { kind: 'code', split: 'dev', known }])));
  assert.deepEqual(
    pairs.cases.flatMap((entry) => entry.runs.flatMap((run) => run.pairs.map((pair) => [entry.case, pair.known]))),
    [['bundled-bug-05', 'K1']],
  );
  const metas = Object.fromEntries(ids.map((id) => [`${id}/R1-low/run-1`, readJson(path.join(runDir(id), 'meta.json'))]));
  const ratings = doc.findings.map((finding) => ({ finding: finding.blind, rating: 'valid', reason: 'Read it.' }));
  const matches = pairs.cases.flatMap((entry) => entry.runs.flatMap((run) => run.pairs.map((pair) => ({ ...pair, verdict: 'no' }))));
  const { runs } = scoreRuns({ findings: doc, pairs, judgments: { matches, adjudications: ratings }, metas });
  const invalid = Object.fromEntries(runs.map((run) => [run.case, run.invalid]));
  for (const id of ['bundled-bug-02', 'bundled-bug-03', 'bundled-bug-06', 'bundled-bug-07', 'bundled-bug-08']) {
    assert.deepEqual(invalid[id], ['reviewer: no review (unreadable)', `reviewer: ${expected[id]}`], id);
  }
  assert.deepEqual(invalid['bundled-bug-04'], ['reviewer: no review (missing)', `reviewer: ${expected['bundled-bug-04']}`]);
  assert.deepEqual(invalid['bundled-bug-05'], []);
  assert.ok(readText(path.join(runDir('bundled-bug-05'), 'blocks', 'reviewer.md')).endsWith('}\n'));
});

test('transcripts gives a bundled reviewer the read scope of its prompt: the snapshot and the full diff only', () => {
  const id = 'bundled-bug-09';
  const { ws, sessions } = bundledWorkspace([{ id, calls: [FINDING_CALL, ...VERDICT_CALLS] }]);
  const caseDir = path.join(ws, id);
  const allowed = [`${caseDir}/snapshot/src/lock.mjs`, `${caseDir}/full.diff`, 'local://1.log'];
  // The prompt names neither the plan, the prompt folder, nor a copy of the plan contract, and it forbids every skill
  // read.
  put(caseDir, 'R1-low/run-1/plan-contract.md', '# Plan contract\n');
  const outside = [
    `${caseDir}/plan.md`,
    `${caseDir}/R1-low/run-1/prompts/reviewer.txt`,
    `${caseDir}/R1-low/run-1/plan-contract.md`,
    'skill://unslop',
    '/home/user/.omp/plugins/node_modules/docks-kit-omp/skills/unslop/SKILL.md',
  ];
  const transcript = bundledTranscript(caseDir, 'review-bench-bundled-reviewer-low', [FINDING_CALL, ...VERDICT_CALLS], {
    readPaths: [...allowed, ...outside],
  });
  put(sessions, `${dispatchName(id, 'R1-low', 'run-1', 'reviewer')}.jsonl`, transcript);
  scoreCli('transcripts', ws, '--omp-sessions', sessions);
  const entry = readJson(path.join(caseDir, 'R1-low', 'run-1', 'meta.json')).reviewers.reviewer;
  assert.deepEqual(entry.readScope, { outside });
  // A reviewer of a kit arm in the same run folder keeps its scope: the plan, its prompts, the contract copy of its run,
  // and an unmeasured skill are inputs or optional instructions.
  const kitScope = readScope(reads(...allowed, ...outside.slice(0, 4)), {
    runDir: path.join(caseDir, 'R1-low', 'run-1'),
    cwd: LIVE,
    pluginRoots: [LIVE_PLUGIN],
  });
  assert.deepEqual(kitScope, { outside: [] });
});

test('transcripts and findings refuse a bundled run prepared for the vendored agents of another omp release', () => {
  const { ws, sessions } = bundledWorkspace([
    { id: 'bundled-bug-10', calls: [FINDING_CALL, ...VERDICT_CALLS] },
    { id: 'bundled-bug-11', calls: [FINDING_CALL, ...VERDICT_CALLS] },
  ]);
  const run = (id) => path.join(ws, id, 'R1-low', 'run-1');
  // After a raise of the omp pin, this workspace keeps the release that `case` recorded for its runs.
  put(run('bundled-bug-11'), 'meta.json', { config: CONFIGS.low, bundledOmp: '19.0.0' });
  put(run('bundled-bug-11'), 'blocks/reviewer.md', JSON.stringify(REVIEWER_REPLY));
  const before = readText(path.join(run('bundled-bug-10'), 'meta.json'));
  const refusal = (command) =>
    `${command}: 1 bundled runs were prepared for the vendored agents of another omp release than omp ${VERIFIED_OMP} of this score.mjs, whose output schemas can differ: bundled-bug-11/R1-low/run-1 (omp 19.0.0); score them with the score.mjs of their omp release`;
  const transcripts = scoreChild(['transcripts', ws, '--omp-sessions', sessions]);
  assert.equal(transcripts.status, 1, transcripts.stderr);
  assert.equal(transcripts.stderr.trim(), refusal('transcripts'));
  assert.equal(readText(path.join(run('bundled-bug-10'), 'meta.json')), before, 'transcripts wrote a meta.json');
  const findings = scoreChild(['findings', ws]);
  assert.equal(findings.status, 1, findings.stderr);
  assert.equal(findings.stderr.trim(), refusal('findings'));
  assert.equal(fs.existsSync(path.join(ws, 'findings.json')), false);
});

test('transcripts and findings refuse a bundled run without a meta.json or without its recorded omp release', () => {
  const { ws, sessions } = bundledWorkspace([
    { id: 'bundled-bug-13', calls: [FINDING_CALL, ...VERDICT_CALLS] },
    { id: 'bundled-bug-14', calls: [FINDING_CALL, ...VERDICT_CALLS] },
    { id: 'bundled-bug-15', calls: [FINDING_CALL, ...VERDICT_CALLS] },
  ]);
  const run = (id) => path.join(ws, id, 'R1-low', 'run-1');
  // One run lost its meta.json, and one has a meta.json without `bundledOmp`; both hold a block that fits the schema.
  fs.rmSync(path.join(run('bundled-bug-13'), 'meta.json'));
  put(run('bundled-bug-14'), 'meta.json', { config: CONFIGS.low });
  for (const id of ['bundled-bug-13', 'bundled-bug-14']) put(run(id), 'blocks/reviewer.md', JSON.stringify(REVIEWER_REPLY));
  const before = readText(path.join(run('bundled-bug-15'), 'meta.json'));
  const refusal = (command) =>
    `${command}: 2 bundled runs have no record of the omp release of their vendored agents (\`bundledOmp\` in meta.json): bundled-bug-13/R1-low/run-1, bundled-bug-14/R1-low/run-1; restore their meta.json from a trusted copy, or prepare and dispatch new runs into a fresh workspace with prepare.mjs case, which records omp ${VERIFIED_OMP}`;
  const transcripts = scoreChild(['transcripts', ws, '--omp-sessions', sessions]);
  assert.equal(transcripts.status, 1, transcripts.stderr);
  assert.equal(transcripts.stderr.trim(), refusal('transcripts'));
  assert.equal(readText(path.join(run('bundled-bug-15'), 'meta.json')), before, 'transcripts wrote a meta.json');
  const findings = scoreChild(['findings', ws]);
  assert.equal(findings.status, 1, findings.stderr);
  assert.equal(findings.stderr.trim(), refusal('findings'));
  assert.equal(fs.existsSync(path.join(ws, 'findings.json')), false);
});

test('findings and transcripts refuse a vendored output schema of a form that the scorer does not check', () => {
  // Copies of the scripts whose vendored reviewer has a schema that the scorer cannot check: a JSON Schema root, where
  // `required` is no JTD keyword, so the copy would not check the required fields; and a nested `type` that is a list,
  // not a text, so the copy would not check the type of that field.
  const schemas = [
    {
      output: 'output:\n  type: object\n  properties:\n    overall_correctness:\n      type: string\n  required: [overall_correctness]\n',
      problem: 'output has the keywords required',
    },
    {
      output: 'output:\n  properties:\n    findings:\n      elements:\n        properties:\n          priority:\n            type: [uint8]\n',
      problem: 'output.properties.findings.elements.properties.priority.type ["uint8"] has no check',
    },
  ];
  for (const { output, problem } of schemas) {
    const repo = path.join(scratch(), 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', repo]);
    const script = path.join(path.dirname(copyScripts(repo)), 'score.mjs');
    const agent = path.join(repo, '.agents/skills/review-benchmark/bundled/omp-19.1.1/reviewer.md');
    put(path.dirname(agent), 'reviewer.md', `---\nname: reviewer\n${output}---\nReview.\n`);
    const { ws, sessions } = bundledWorkspace([{ id: 'bundled-bug-12', calls: VERDICT_CALLS }]);
    put(path.join(ws, 'bundled-bug-12', 'R1-low', 'run-1'), 'blocks/reviewer.md', '{}');
    const message = `${agent}: score.mjs cannot check this output schema: ${problem}; extend schemaFormProblems and schemaProblems in score.mjs for the new schema form`;
    for (const args of [
      ['findings', ws],
      ['transcripts', ws, '--omp-sessions', sessions],
    ]) {
      const child = scoreChild(args, script);
      assert.equal(child.status, 1, child.stderr);
      assert.equal(child.stderr.trim(), message);
    }
    assert.equal(fs.existsSync(path.join(ws, 'findings.json')), false);
  }
});
