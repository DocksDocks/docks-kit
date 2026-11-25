import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  buildPairs,
  dispatchName,
  findingsCommand,
  parseBlock,
  scoreRuns,
  structuredReply,
  transcriptEntries,
  transcriptsCommand,
} from '../scripts/score.mjs';
import {
  assistantLine,
  CONFIGS,
  isoAt,
  jsonl,
  LIVE,
  MODEL,
  put,
  readJson,
  readText,
  scratch,
  sessionRecord,
  taskMessage,
  VERIFIED_OMP,
} from './helpers.mjs';

// Plan #229 step 2: the structured replies of the bundled agents `reviewer` and `security-reviewer`.
//
// - parseBlock(text, family, reviewer): for the reviewer `reviewer` or `security-reviewer`, `text` is the JSON object
//   that `transcripts` wrote. A finding gets the severity of its priority (0 to 3: CRITICAL, HIGH, MEDIUM, LOW) or of
//   its severity (`informational` gives LOW), and every location. The verdict is `fixes-required` for a finding or for
//   `overall_correctness: incorrect`, `pass` otherwise, and `unreadable` for an object that does not fit the schema.
// - structuredReply(entries, reviewer) and transcriptsCommand: a run whose meta.json has `bundledOmp` gets its block
//   from the accepted `yield` calls of its transcript, folded in call order; a problem gives `replyError`.

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
  const verdictOf = (reply) => parseBlock(JSON.stringify(reply), 'code', 'reviewer').verdict;
  assert.equal(verdictOf({ ...REVIEWER_REPLY, findings: [] }), 'fixes-required');
  assert.equal(verdictOf({ ...REVIEWER_REPLY, overall_correctness: 'correct', findings: [] }), 'pass');
  // A finding makes the verdict `fixes-required` also when the agent calls the change correct.
  assert.equal(verdictOf({ ...REVIEWER_REPLY, overall_correctness: 'correct' }), 'fixes-required');
  // A reply without explanation and confidence, and a text that is no JSON, are unreadable.
  assert.equal(verdictOf({ overall_correctness: 'incorrect', findings: [REVIEWER_FINDING] }), 'unreadable');
  assert.equal(parseBlock('Verdict: incorrect', 'code', 'reviewer').verdict, 'unreadable');
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
  // Without coverage_summary the reply does not fit the schema.
  assert.equal(parseBlock(JSON.stringify({ findings: [SECURITY_FINDING] }), 'code', 'security-reviewer').verdict, 'unreadable');
});

// The calls of a bundled transcript, each [id, arguments, isError]: one assistant message per call, and a tool result
// for each call with an `isError` value.
function bundledTranscript(caseDir, agent, calls, { version = VERIFIED_OMP, stopReason = 'stop' } = {}) {
  const runtime = { runtime: { version } };
  const lines = [
    sessionRecord({ cwd: LIVE }),
    { type: 'model_change', timestamp: isoAt(0), model: MODEL, ...runtime },
    { type: 'thinking_level_change', timestamp: isoAt(0), thinkingLevel: 'low', ...runtime },
    { type: 'session_init', timestamp: isoAt(0), agent, systemPrompt: ['Find bugs.'], ...runtime },
    { type: 'message', timestamp: isoAt(0), message: taskMessage(caseDir), ...runtime },
  ];
  for (const [index, [id, args, isError]] of calls.entries()) {
    const call = assistantLine(index + 1, 'openai-codex', 'gpt-6.1-sol', 'default', { input: 10, output: 5 });
    call.message.content = [{ type: 'toolCall', id, name: 'yield', arguments: args }];
    call.message.stopReason = 'toolUse';
    lines.push({ ...call, ...runtime });
    const result = { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'ok' }], isError };
    lines.push({ type: 'message', timestamp: isoAt(index + 1), message: result, ...runtime });
  }
  const last = assistantLine(calls.length + 1, 'openai-codex', 'gpt-6.1-sol', 'default', { input: 10, output: 5 });
  last.message.content = [{ type: 'text', text: 'Done.' }];
  last.message.stopReason = stopReason;
  lines.push({ ...last, ...runtime });
  return jsonl(lines);
}

const VERDICT_CALLS = [
  ['c3', { type: ['overall_correctness'], data: 'incorrect' }, false],
  ['c4', { type: ['explanation'], data: 'The release path frees a foreign lock.' }, false],
  ['c5', { type: ['confidence'], data: 0.8 }, false],
];
const FINDING_CALL = ['c1', { type: ['findings'], data: REVIEWER_FINDING }, false];
// omp rejected this call (an error result), so its finding is not part of the reply.
const REJECTED_CALL = ['c2', { type: ['findings'], data: { title: 'Rejected', priority: 'high' } }, true];

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
    put(ws, `${id}/full.diff`, 'diff --git a/src/lock.mjs b/src/lock.mjs\n--- a/src/lock.mjs\n+++ b/src/lock.mjs\n@@ -1 +1 @@\n-a\n+b\n');
    put(ws, `${id}/R1-low/run-1/prompts/reviewer.txt`, `agent: ${agent}\n\nFull diff: ${caseDir}/full.diff\n`);
    put(ws, `${id}/R1-low/run-1/meta.json`, { config: CONFIGS.low, bundledOmp: VERIFIED_OMP });
    fs.mkdirSync(path.join(ws, id, 'R1-low', 'run-1', 'blocks'), { recursive: true });
    const name = dispatchName(id, 'R1-low', 'run-1', 'reviewer');
    put(sessions, `${name}.jsonl`, bundledTranscript(caseDir, agent, calls, options));
  }
  return { ws, sessions };
}

test('transcripts folds the accepted yield calls of a bundled run into its block', () => {
  const { ws, sessions } = bundledWorkspace([
    { id: 'bundled-bug-01', calls: [FINDING_CALL, REJECTED_CALL, ...VERDICT_CALLS] },
  ]);
  transcriptsCommand(ws, sessions);
  const run = path.join(ws, 'bundled-bug-01', 'R1-low', 'run-1');
  // The finding and the three verdict sections, without the rejected call, in the order of the calls.
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
  const { blocks, findings } = findingsCommand(ws);
  assert.deepEqual(
    blocks.map((block) => [block.reviewer, block.verdict, block.findings]),
    [['reviewer', 'fixes-required', 1]],
  );
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.severity, finding.locator]),
    [['bundled-bug-01/R1-low/run-1/reviewer#1', 'HIGH', 'src/lock.mjs:12-14']],
  );
});

test('structuredReply keeps the last scalar section, a terminal result, and an abort', () => {
  const entries = (calls) => transcriptEntries(bundledTranscript('/work/ws/c', 'a', calls));
  // A repeated verdict section replaces the earlier one; findings stay a list.
  const repeated = structuredReply(
    entries([...VERDICT_CALLS, ['c6', { type: ['overall_correctness'], data: 'correct' }, false]]),
    'reviewer',
  );
  assert.equal(repeated.problem, null);
  assert.equal(repeated.data.overall_correctness, 'correct');
  // A terminal call with data is the whole reply.
  const whole = { coverage_summary: 'Read src/.', findings: [SECURITY_FINDING] };
  const terminal = structuredReply(entries([['t1', { data: whole }, false]]), 'security-reviewer');
  assert.deepEqual(terminal, { data: whole, problem: null });
  // A last call with an error aborts the task.
  const aborted = structuredReply(entries([FINDING_CALL, ['e1', { error: 'cannot read the diff' }, false]]), 'reviewer');
  assert.deepEqual(aborted, {
    data: { aborted: true, error: 'cannot read the diff' },
    problem: 'reviewer aborted its task: cannot read the diff',
  });
  // A placeholder error next to data is no error.
  const placeholder = structuredReply(
    entries([['p1', { data: whole, error: 'n/a' }, false]]),
    'security-reviewer',
  );
  assert.equal(placeholder.problem, null);
  // An aborted run is not valid, also when its sections fit the schema.
  const stopped = structuredReply(
    transcriptEntries(bundledTranscript('/work/ws/c', 'a', VERDICT_CALLS, { stopReason: 'aborted' })),
    'reviewer',
  );
  assert.equal(stopped.problem, 'the run of reviewer was aborted');
});

test('transcripts marks invalid a bundled run without a verdict, with a partial verdict, or of another omp', () => {
  const { ws, sessions } = bundledWorkspace([
    { id: 'bundled-bug-02', calls: [FINDING_CALL] },
    { id: 'bundled-bug-03', calls: [FINDING_CALL, VERDICT_CALLS[0]] },
    { id: 'bundled-bug-04', calls: [FINDING_CALL, ...VERDICT_CALLS], options: { version: '19.0.0' } },
    { id: 'bundled-bug-05', calls: [FINDING_CALL, ...VERDICT_CALLS] },
  ]);
  const runDir = (id) => path.join(ws, id, 'R1-low', 'run-1');
  // An earlier block of the run of another omp goes away.
  put(runDir('bundled-bug-04'), 'blocks/reviewer.md', JSON.stringify(REVIEWER_REPLY));
  transcriptsCommand(ws, sessions);
  const replyError = (id) => readJson(path.join(runDir(id), 'meta.json')).reviewers.reviewer.replyError;
  assert.equal(
    replyError('bundled-bug-02'),
    'the result fails the output schema of reviewer: no overall_correctness, no explanation, no confidence',
  );
  assert.equal(replyError('bundled-bug-03'), 'the result fails the output schema of reviewer: no explanation, no confidence');
  assert.equal(replyError('bundled-bug-04'), `the transcript shows omp 19.0.0, not omp ${VERIFIED_OMP} of the vendored agents`);
  assert.equal(fs.existsSync(path.join(runDir('bundled-bug-04'), 'blocks', 'reviewer.md')), false);
  assert.equal(replyError('bundled-bug-05'), undefined);
  // The block of each run with a partial reply holds what the agent yielded.
  assert.deepEqual(readJson(path.join(runDir('bundled-bug-03'), 'blocks', 'reviewer.md')), {
    findings: [REVIEWER_FINDING],
    overall_correctness: 'incorrect',
  });
  const doc = findingsCommand(ws);
  assert.deepEqual(
    doc.blocks.map((block) => [block.case, block.verdict]),
    [
      ['bundled-bug-02', 'unreadable'],
      ['bundled-bug-03', 'unreadable'],
      ['bundled-bug-04', 'missing'],
      ['bundled-bug-05', 'fixes-required'],
    ],
  );
  const ids = doc.blocks.map((block) => block.case);
  const known = [{ id: 'K1', locator: 'src/unrelated.mjs:1' }];
  const pairs = buildPairs(doc, Object.fromEntries(ids.map((id) => [id, { kind: 'code', split: 'dev', known }])));
  const metas = Object.fromEntries(ids.map((id) => [`${id}/R1-low/run-1`, readJson(path.join(runDir(id), 'meta.json'))]));
  const ratings = doc.findings.map((finding) => ({ finding: finding.blind, rating: 'valid', reason: 'Read it.' }));
  const { runs } = scoreRuns({ findings: doc, pairs, judgments: { matches: [], adjudications: ratings }, metas });
  const invalid = Object.fromEntries(runs.map((run) => [run.case, run.invalid]));
  assert.deepEqual(invalid['bundled-bug-02'], [
    'reviewer: no review (unreadable)',
    `reviewer: ${replyError('bundled-bug-02')}`,
  ]);
  assert.deepEqual(invalid['bundled-bug-03'], [
    'reviewer: no review (unreadable)',
    `reviewer: ${replyError('bundled-bug-03')}`,
  ]);
  assert.deepEqual(invalid['bundled-bug-04'], ['reviewer: no review (missing)', `reviewer: ${replyError('bundled-bug-04')}`]);
  assert.deepEqual(invalid['bundled-bug-05'], []);
  assert.ok(readText(path.join(runDir('bundled-bug-05'), 'blocks', 'reviewer.md')).endsWith('}\n'));
});
