import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { blindId, findingsCommand, main } from '../scripts/score.mjs';
import { gridFixture, oneKnownCases, put, readJson, readText, scratch, tableAfter, writeFixture } from './helpers.mjs';

// Plan #229 step 3: the scoring of the bundled arms.
//
// - pairs: a finding of `security-reviewer` keeps every location, so each location file is a candidate file of a judge
//   pair. `pairs <ws> --cases <cases>/bundled` reads the case file in that folder.
// - report: beside the interval of the escaped defects per 50 known, the decision table gives the escaped defects per
//   50 known of the column and of the reference column on the cases that both ran.

const location = (file, start, end) => ({ path: file, start_line: start, ...(end ? { end_line: end } : {}) });
const securityFinding = (title, locations) => ({
  rule_id: 'cmd-injection',
  title,
  summary: 'The branch name goes into a shell string.',
  severity: 'high',
  confidence: 'high',
  category: 'injection',
  locations,
  cwe: ['CWE-78'],
  evidence: [{ label: 'sink', explanation: 'execSync gets the joined string.' }],
});

test('pairs pairs a security finding with a known defect on its second location file', () => {
  const root = scratch();
  const ws = path.join(root, 'ws');
  const cases = path.join(root, 'cases', 'bundled');
  const id = 'bundled-sec-01';
  put(ws, `${id}/case.json`, { id, kind: 'code', split: 'dev' });
  put(ws, `${id}/V1-low/run-1/prompts/security-reviewer.txt`, 'agent: review-bench-bundled-security-low\n\nReview.\n');
  const reply = {
    coverage_summary: 'Read the changed files.',
    findings: [
      // The source comes first and the sink second; the known defect sits at the sink.
      securityFinding('Shell command takes the branch name', [
        location('src/input.mjs', 3),
        location('src/exec.mjs', 20, 22),
      ]),
      securityFinding('Log line shows the token', [location('src/log.mjs', 7)]),
    ],
  };
  put(ws, `${id}/V1-low/run-1/blocks/security-reviewer.md`, reply);
  const known = {
    id: 'SEC1',
    locator: 'src/exec.mjs:21',
    category: 'code',
    source: 'seeded',
    security: true,
    summary: 'The seed joins the branch name into a shell command.',
    fix: `${id}.SEC1.fix.patch`,
  };
  put(cases, `${id}.json`, { id, kind: 'code', split: 'dev', known: [known] });
  findingsCommand(ws);
  assert.equal(main(['pairs', ws, '--cases', cases]), 'pairs.json: 1 candidate pairs in 1 cases');
  const [entry] = readJson(path.join(ws, 'pairs.json')).cases;
  assert.deepEqual(entry.known, [known]);
  const [run] = entry.runs;
  const first = blindId(`${id}/V1-low/run-1/security-reviewer#1`);
  assert.deepEqual(run.pairs, [{ finding: first, known: 'SEC1' }]);
  assert.deepEqual(
    run.findings.find((finding) => finding.finding === first),
    {
      finding: first,
      severity: 'HIGH',
      category: 'injection',
      locator: 'src/input.mjs:3; src/exec.mjs:20-22',
      text: 'Shell command takes the branch name: The branch name goes into a shell string. Evidence: sink: execSync gets the joined string.',
    },
  );
});

test('report gives the escaped defects per 50 known of each column on the cases that it shares with the reference', () => {
  const ws = path.join(scratch(), 'ws');
  // R1-xhigh-fast runs code-1 (finds D1) and code-2 (escapes D1); R1-low runs code-2 (finds D1) and code-3 (escapes
  // D1). Both columns escape 25 per 50 known over all their runs, but on code-2, the one shared case, R1-low escapes 0
  // and R1-xhigh-fast escapes 50.
  const single = (config, caseId, found) => ({
    case: caseId,
    config,
    arm: 'R1',
    run: 1,
    single: true,
    rounds: [[60, 600, null, 0, found ? ['D1'] : []]],
  });
  const runs = [
    single('xhigh-fast', 'code-1', true),
    single('xhigh-fast', 'code-2', false),
    single('low', 'code-2', true),
    single('low', 'code-3', false),
  ];
  writeFixture(ws, gridFixture(oneKnownCases(3), runs));
  main(['report', ws, '--arms', 'R1-low,R1-xhigh-fast', '--reference', 'R1-xhigh-fast']);
  const decision = tableAfter(readText(path.join(ws, 'report.md')), '### Decision: dev');
  assert.ok(decision.includes('| Escaped per 50 known | 25.00 | 25.00 |'));
  const interval = decision.findIndex((row) => row.startsWith('| Escaped per 50 known difference from R1-xhigh-fast, 90%'));
  assert.equal(decision[interval], '| Escaped per 50 known difference from R1-xhigh-fast, 90% interval | [-50.00, -50.00] | - |');
  assert.equal(
    decision[interval + 1],
    '| Escaped per 50 known on the cases shared with R1-xhigh-fast (this column / R1-xhigh-fast) | 0.00 / 50.00 | - |',
  );
});
