import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { BUN_RUNTIME } from '../../../../cli/test/lib/cliEntry.ts';
import { PROJECT_CONFIG } from '../scripts/omp.mjs';
import * as prepare from '../scripts/prepare.mjs';
import { bundledSchema } from '../scripts/score.mjs';
import {
  agentsOnBun,
  CONFIGS,
  copyScripts,
  fakeOmp,
  filePatch,
  frontmatter,
  gitIn,
  isolateGit,
  MODEL,
  neutralScratch,
  projectConfig,
  promptFileParts,
  put,
  readJson,
  readText,
  SKILL_DIR,
  tierOverrides,
} from './helpers.mjs';

// Plan #229 step 3: the bundled arms.
//
// - prepareAgents({ bundled: true, model, efforts, tiers?, project }): renders `review-bench-bundled-reviewer-<config>`
//   and `review-bench-bundled-security-<config>` from bundled/omp-19.1.1/ with `structured: true`, without `bash`,
//   `lsp`, and `spawns`, and with the pinned model and effort. It needs a `--project` of its own and refuses to
//   replace the setup of another `agents` run there. It stops when `omp --version` is not 19.1.1, and it takes no
//   option of the other `agents` runs.
// - `prepare.mjs case` with the arms R1 (`reviewer`, the full diff) and V1 (`security-reviewer`, the changed files as
//   scope, from the Git listing of the full diff) on a case of a `cases/bundled/` folder. It checks the seed rule on
//   the changes that Git applies, and V1 needs a security seed. Each run records the vendored omp version as
//   `bundledOmp` in its meta.json.

const VENDORED = path.join(SKILL_DIR, 'bundled', 'omp-19.1.1');
const AGENT_FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

// The vendored file `name` and the rendered agent `file`: the top-level frontmatter lines and the body of each.
function agentParts(text) {
  const [whole, lines] = AGENT_FRONTMATTER.exec(text);
  return { lines: lines.split('\n'), body: text.slice(whole.length) };
}

test('agents --bundled renders both bundled agents per configuration in structured mode without bash, lsp, and spawns', () => {
  const root = neutralScratch();
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const { lines } = agentsOnBun({ bundled: true, model: MODEL, efforts: 'low,high', project }, root);
  const agentDir = path.join(project, '.omp', 'agents');
  assert.deepEqual(fs.readdirSync(agentDir).sort(), [
    'review-bench-bundled-reviewer-high.md',
    'review-bench-bundled-reviewer-low.md',
    'review-bench-bundled-security-high.md',
    'review-bench-bundled-security-low.md',
    'review-bench-configs.json',
  ]);
  // Without --tiers, each configuration has the tier null, so no tier override goes to the project config.
  assert.deepEqual(readJson(path.join(agentDir, 'review-bench-configs.json')), {
    configs: [
      { name: 'low', model: MODEL, effort: 'low', tier: null },
      { name: 'high', model: MODEL, effort: 'high', tier: null },
    ],
    bundled: { ompVersion: '19.1.1' },
    ompVersion: '19.1.1',
  });
  assert.equal(projectConfig(project), null);
  assert.ok(lines.includes(`wrote 4 bundled agent files of omp 19.1.1 to ${agentDir} for low, high`));
  const tools = { reviewer: 'read, find, grep, glob, web_search, ast_grep', security: 'read, find, grep, glob, ast_grep' };
  const files = { reviewer: 'reviewer.md', security: 'security-reviewer.md' };
  for (const effort of ['low', 'high']) {
    for (const role of ['reviewer', 'security']) {
      const name = `review-bench-bundled-${role}-${effort}`;
      const file = path.join(agentDir, `${name}.md`);
      const fields = frontmatter(file);
      assert.equal(fields.name, name);
      assert.equal(fields.model, MODEL);
      assert.equal(fields['thinking-level'], effort);
      assert.equal(fields.structured, 'true');
      assert.equal(fields.tools, tools[role]);
      assert.equal(fields.spawns, undefined);
      // Every other line of the vendored file stays: the description, the output schema, and the body.
      const rendered = agentParts(readText(file));
      const vendored = agentParts(readText(path.join(VENDORED, files[role])));
      assert.equal(rendered.body, vendored.body);
      const changed = /^(?:name|model|thinking-level|structured|tools|spawns):/;
      assert.deepEqual(
        rendered.lines.filter((line) => !changed.test(line)),
        vendored.lines.filter((line) => !changed.test(line)),
      );
    }
  }
  // With --tiers, each agent gets the tier override of its configuration. The run replaces the earlier bundled setup.
  agentsOnBun({ bundled: true, model: MODEL, efforts: 'high', tiers: 'priority', project }, root);
  assert.deepEqual(tierOverrides(project), {
    'review-bench-bundled-reviewer-high-fast': 'priority',
    'review-bench-bundled-security-high-fast': 'priority',
  });
});

test('agents --bundled refuses another omp version and the options of the other agents runs', () => {
  const root = neutralScratch();
  const project = path.join(root, 'project');
  const configsFile = path.join(project, '.omp', 'agents', 'review-bench-configs.json');
  put(project, '.omp/agents/review-bench-configs.json', { configs: [CONFIGS.low], bundled: { ompVersion: '19.1.1' } });
  const before = readText(configsFile);
  const options = { bundled: true, model: MODEL, efforts: 'high', project };
  assert.throws(() => agentsOnBun(options, root, fakeOmp({ version: '19.1.2' })), {
    message: `omp 19.1.2 is installed, but ${VENDORED} holds the bundled agents of omp 19.1.1; run agents --bundled with omp 19.1.1, or vendor the agents of omp 19.1.2 as SOURCE.md in that folder tells`,
  });
  assert.throws(() => agentsOnBun(options, root, fakeOmp({ version: '19.1.0' })), /^Error: omp 19\.1\.0 is installed/);
  // The refused runs change no file.
  assert.equal(readText(configsFile), before);
  assert.deepEqual(fs.readdirSync(path.dirname(configsFile)), ['review-bench-configs.json']);
  for (const [option, value] of [
    ['baseline-ref', 'HEAD'],
    ['out', path.join(root, 'ws')],
    ['baseline-dir', path.join(root, 'baseline')],
  ]) {
    assert.throws(() => agentsOnBun({ ...options, [option]: value }, root), {
      message: `agents --bundled takes only --model, --efforts, --tiers, and --project; leave out --${option}`,
    });
  }
});

test('agents --bundled needs its own --project and does not replace the setup of another agents run', () => {
  const root = neutralScratch();
  const options = { bundled: true, model: MODEL, efforts: 'high' };
  // Without --project, the project would be the repository, whose kit setup the run would replace.
  put(root, '.omp/agents/review-bench-candidate-code-low.md', '---\nname: review-bench-candidate-code-low\n---\n');
  assert.throws(() => agentsOnBun(options, root), {
    message:
      'agents --bundled needs --project <dir>, a folder of its own: its list of configurations holds only the bundled configurations',
  });
  assert.deepEqual(fs.readdirSync(path.join(root, '.omp', 'agents')), ['review-bench-candidate-code-low.md']);
  // A project with the list of configurations, an agent file, or a tier override of another agents run.
  const setups = {
    configs: (project) => put(project, '.omp/agents/review-bench-configs.json', { configs: [CONFIGS.low] }),
    agent: (project) => put(project, '.omp/agents/review-bench-baseline-code-low.md', '---\nname: x\n---\n'),
    tier: (project) => put(project, PROJECT_CONFIG, 'task:\n  agentServiceTierOverrides:\n    review-bench-candidate-code-low-fast: priority\n'),
  };
  const found = {
    configs: (project) => path.join(project, '.omp', 'agents', 'review-bench-configs.json'),
    agent: (project) => path.join(project, '.omp', 'agents', 'review-bench-baseline-code-low.md'),
    tier: (project) =>
      `the tier overrides review-bench-candidate-code-low-fast in ${path.join(project, PROJECT_CONFIG)}`,
  };
  for (const [kind, write] of Object.entries(setups)) {
    const project = path.join(root, `project-${kind}`);
    write(project);
    const files = fs.readdirSync(project, { recursive: true }).sort();
    assert.throws(() => agentsOnBun({ ...options, project }, root), {
      message: `agents --bundled would replace the setup of another agents run in ${project}: ${found[kind](project)}; give agents --bundled a --project of its own, or remove that setup with prepare.mjs clean --project ${project}`,
    });
    assert.deepEqual(fs.readdirSync(project, { recursive: true }).sort(), files, `${kind}: the refused run changed a file`);
  }
});

test('score.mjs reads the output schema of each vendored agent from its frontmatter', () => {
  // Bun parses the YAML frontmatter of each vendored agent and prints its output schema.
  const code = `const text = await Bun.file(process.argv[1]).text(); console.log(JSON.stringify(Bun.YAML.parse(/^---\\n([\\s\\S]*?)\\n---\\n/.exec(text)[1]).output));`;
  for (const [reviewer, file] of [
    ['reviewer', 'reviewer.md'],
    ['security-reviewer', 'security-reviewer.md'],
  ]) {
    const child = spawnSync(BUN_RUNTIME, ['-e', code, path.join(VENDORED, file)], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(bundledSchema(reviewer), JSON.parse(child.stdout));
  }
});

// A git repository whose head commit, a pull request on the base commit, adds src/handler.mjs, docs/benchmark.md, and
// docs/naïve.md (a path that Git quotes) and changes README.md, with a copy of the scripts; a project with the
// configurations of `agents --bundled`; `writeCase(id, { security, seed, fix, folder })`, which writes a case of
// `<root>/cases/<folder>/` (default `bundled`) with the seed patch `seed` and the fix patch `fix`; and
// `runCase(casePath, arms, out)`, which runs `prepare.mjs case` of the copy on Bun.
const HANDLER = [
  'export function switchCommand(name) {',
  "  if (!/^[\\w.-]+$/.test(name)) throw new Error('bad name');",
  "  return ['git', 'switch', name];",
  '}',
  '',
].join('\n');
const SEEDED = HANDLER.replace("  return ['git', 'switch', name];", '  return `git switch ${name}`;');
const QUOTED = 'docs/naïve.md';
function bundledRepo() {
  isolateGit();
  const root = neutralScratch();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  put(repo, 'README.md', '# Demo\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  const base = gitIn(repo, 'rev-parse', 'HEAD').trim();
  put(repo, 'README.md', '# Demo\n\nRun switchCommand.\n');
  put(repo, 'src/handler.mjs', HANDLER);
  // A changed file whose name holds a word that a prompt must not hold: the V1 scope lists it anyway.
  put(repo, 'docs/benchmark.md', '# Timing\n');
  put(repo, QUOTED, '# Names\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'head');
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim();
  // case reads the repository of the checkout that holds the script, so the scripts go into the case repository.
  const script = copyScripts(repo);
  const project = path.join(root, 'project');
  put(project, '.omp/agents/review-bench-configs.json', { configs: [CONFIGS.low], bundled: { ompVersion: '19.1.1' } });
  const writeCase = (id, { security = true, seed, fix, folder = 'bundled' }) => {
    const dir = path.join(root, 'cases', folder);
    const known = {
      id: 'S1',
      locator: 'src/handler.mjs:3',
      category: 'code',
      source: 'seeded',
      security,
      summary: 'The seed joins the name into a shell string; the pull request adds the file, so the behavior is new.',
      fix: `${id}.S1.fix.patch`,
    };
    const caseData = { id, kind: 'code', split: 'dev', issue: 7, round: 1, base, head, patch: `${id}.patch` };
    put(dir, `${id}.json`, { ...caseData, plan: `${id}-plan.md`, known: [known] });
    put(dir, `${id}-plan.md`, '# Add switchCommand\n');
    put(dir, `${id}.patch`, seed);
    put(dir, `${id}.S1.fix.patch`, fix);
    return path.join(dir, `${id}.json`);
  };
  const runCase = (casePath, arms, out) =>
    spawnSync(
      BUN_RUNTIME,
      [script, 'case', '--case', casePath, '--arms', arms, '--runs', '1', '--out', out, '--project', project],
      { encoding: 'utf8' },
    );
  const seed = filePatch(repo, 'src/handler.mjs', HANDLER, SEEDED);
  const fix = filePatch(repo, 'src/handler.mjs', SEEDED, HANDLER);
  return { root, repo, project, writeCase, runCase, seed, fix };
}

test('case writes the R1 and V1 prompts of a bundled case with the read-scope rules and the diff or the scope', () => {
  const { root, writeCase, runCase, seed, fix } = bundledRepo();
  const ws = path.join(root, 'ws');
  const casePath = writeCase('bundled-sec-01', { seed, fix });
  const result = runCase(casePath, 'R1,V1', ws);
  assert.equal(result.status, 0, result.stderr);
  const caseDir = path.join(ws, 'bundled-sec-01');
  const rules = [
    'Rules:',
    '- The snapshot root holds the repository files of the change, without Git history. Take repository evidence only from files under the snapshot root and the files that this message names. You may read official documentation on the web, but no page of the DocksDocks/docks-kit repository, formerly DocksDocks/docks, or of the DocksDocks/public repository.',
    '- The working directory is not the snapshot, so give every Read, Grep, and Glob call an absolute path under the snapshot root or the absolute path of a file that this message names.',
    '- Do not load or read skills, also not through `skill://` URIs.',
    '- Do not fetch GitHub issues or pull requests.',
    '- Run no commands.',
    '- Make no edits.',
    '- Write each file path as a path relative to the snapshot root.',
  ];
  const inputs = [`Repository snapshot root: ${caseDir}/snapshot`, `Full diff: ${caseDir}/full.diff`];
  const reviewer = promptFileParts(path.join(caseDir, 'R1-low', 'run-1', 'prompts', 'reviewer.txt'));
  assert.equal(reviewer.agent, 'agent: review-bench-bundled-reviewer-low');
  assert.equal(
    reviewer.body,
    [
      'Review the change in the diff file. Report concrete correctness findings.',
      '',
      ...inputs,
      '',
      ...rules,
      '',
    ].join('\n'),
  );
  const security = promptFileParts(path.join(caseDir, 'V1-low', 'run-1', 'prompts', 'security-reviewer.txt'));
  assert.equal(security.agent, 'agent: review-bench-bundled-security-low');
  // The scope comes from the Git listing of the full diff, so it also holds the path that the diff text quotes.
  assert.ok(readText(path.join(caseDir, 'full.diff')).includes('diff --git "a/docs/na\\303\\257ve.md"'));
  assert.equal(
    security.body,
    [
      'Review these files for vulnerabilities that the change introduces.',
      '',
      ...inputs,
      'Files, relative to the snapshot root:',
      '- README.md',
      '- docs/benchmark.md',
      `- ${QUOTED}`,
      '- src/handler.mjs',
      '',
      ...rules,
      '',
    ].join('\n'),
  );
  for (const arm of ['R1-low', 'V1-low']) {
    assert.deepEqual(readJson(path.join(caseDir, arm, 'run-1', 'meta.json')), {
      config: CONFIGS.low,
      bundledOmp: '19.1.1',
    });
  }
  // The full diff runs from the base to the head with the seed, so the seeded line is an added line of it.
  assert.ok(readText(path.join(caseDir, 'full.diff')).includes('+  return `git switch ${name}`;\n'));
});

test('case refuses V1 without a security seed and a bundled case that breaks the seed rule', () => {
  const { root, repo, writeCase, runCase, seed, fix } = bundledRepo();
  const refuses = (id, spec, arms, message) => {
    const ws = path.join(root, `ws-${id}`);
    const result = runCase(writeCase(id, spec), arms, ws);
    assert.equal(result.status, 1, result.stderr);
    const error = result.stderr.trim();
    const shown = 'prepare.mjs: ';
    assert.ok(error.startsWith(shown), error);
    if (typeof message === 'string') assert.equal(error.slice(shown.length), message);
    else assert.match(error.slice(shown.length), message);
    assert.equal(fs.existsSync(path.join(ws, id)), false, `${id} left a case folder`);
  };
  refuses(
    'bundled-bug-01',
    { security: false, seed, fix },
    'R1,V1',
    'V1 needs a case with a security seed, and the seeded defect S1 of bundled case bundled-bug-01 has security false; leave V1 out of --arms',
  );
  // A seed in README.md, which the base holds.
  const readme = '# Demo\n\nRun switchCommand.\n';
  const readmeSeed = filePatch(repo, 'README.md', readme, `${readme}Names are trusted.\n`);
  const readmeFix = filePatch(repo, 'README.md', `${readme}Names are trusted.\n`, readme);
  refuses(
    'bundled-bug-02',
    { seed: readmeSeed, fix: readmeFix },
    'R1',
    /^bundled case bundled-bug-02: the seed patch bundled-bug-02\.patch edits README\.md, which the base [0-9a-f]{40} holds; seed only a file that the pull request adds$/,
  );
  // A seed that only deletes the check.
  const unchecked = HANDLER.replace("  if (!/^[\\w.-]+$/.test(name)) throw new Error('bad name');\n", '');
  refuses(
    'bundled-bug-03',
    { seed: filePatch(repo, 'src/handler.mjs', HANDLER, unchecked), fix: filePatch(repo, 'src/handler.mjs', unchecked, HANDLER) },
    'R1',
    /^bundled case bundled-bug-03: the seed patch bundled-bug-03\.patch breaks the seed rule: its hunk @@ .* @@.* adds no line; each hunk of a seed adds at least one line$/,
  );
  // A fix patch that applies after the seed but does not give the head.
  const other = HANDLER.replace("'bad name'", "'bad branch name'");
  refuses(
    'bundled-bug-04',
    { seed, fix: filePatch(repo, 'src/handler.mjs', SEEDED, other) },
    'R1',
    'bundled case bundled-bug-04: the fix patch bundled-bug-04.S1.fix.patch is not the exact reverse of the seed patch bundled-bug-04.patch: the seed patch and then the fix patch do not give the head',
  );
  // A metadata-only seed: it has no `---` or `+++` header and no hunk, but Git applies the mode change.
  const mode = (from, to) => `diff --git a/src/handler.mjs b/src/handler.mjs\nold mode ${from}\nnew mode ${to}\n`;
  refuses(
    'bundled-bug-05',
    { seed: mode('100644', '100755'), fix: mode('100755', '100644') },
    'R1',
    'bundled case bundled-bug-05: the seed patch bundled-bug-05.patch breaks the seed rule: it changes the mode of src/handler.mjs; a seed only changes lines of a file',
  );
  // A seed in a file whose path Git quotes passes the rule.
  const quotedSeed = filePatch(repo, QUOTED, '# Names\n', '# Names\n\nTrust every name.\n');
  const quotedFix = filePatch(repo, QUOTED, '# Names\n\nTrust every name.\n', '# Names\n');
  assert.ok(quotedSeed.startsWith('diff --git "a/docs/na\\303\\257ve.md"'), quotedSeed);
  const quoted = runCase(writeCase('bundled-bug-06', { seed: quotedSeed, fix: quotedFix }), 'R1', path.join(root, 'ws-06'));
  assert.equal(quoted.status, 0, quoted.stderr);
  // A bundled arm needs a case of a cases/bundled/ folder.
  const devCase = writeCase('code-9', { seed, fix, folder: 'dev' });
  const dev = runCase(devCase, 'R1', path.join(root, 'ws-dev'));
  assert.equal(dev.status, 1, dev.stderr);
  assert.equal(
    dev.stderr.trim(),
    `prepare.mjs: the bundled arms R1 run only on the cases of a cases/bundled folder, and ${devCase} is not in one`,
  );
});

test('case refuses a bundled arm without the configurations of agents --bundled, and another arm with them', () => {
  const { root, repo, project, writeCase, seed, fix } = bundledRepo();
  const casePath = writeCase('bundled-sec-02', { seed, fix });
  const configsFile = path.join(project, '.omp', 'agents', 'review-bench-configs.json');
  assert.throws(() => prepare.prepareCase({ case: casePath, arms: 'C1', runs: '1', out: path.join(root, 'a'), project }, repo), {
    message: `${configsFile} holds the configurations of agents --bundled, whose project has only the bundled agents; use the arms R1, V1, or the --project of another agents run for C1`,
  });
  put(project, '.omp/agents/review-bench-configs.json', { configs: [CONFIGS.low] });
  assert.throws(() => prepare.prepareCase({ case: casePath, arms: 'V1', runs: '1', out: path.join(root, 'b'), project }, repo), {
    message: `arm V1 runs a bundled agent, and ${configsFile} holds no bundled configurations; run prepare.mjs agents --bundled with a --project of its own, and give case that --project`,
  });
});

test('case refuses a bundled case whose seed edits a file that the snapshot and the diffs leave out', () => {
  isolateGit();
  const root = neutralScratch();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  put(repo, 'README.md', '# Demo\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  const base = gitIn(repo, 'rev-parse', 'HEAD').trim();
  // The pull request adds a file to the benchmark skill folder, which case hides without show_benchmark.
  const tool = '.agents/skills/review-benchmark/scripts/tool.mjs';
  put(repo, tool, HANDLER);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'head');
  const head = gitIn(repo, 'rev-parse', 'HEAD').trim();
  const seed = filePatch(repo, tool, HANDLER, SEEDED);
  const fix = filePatch(repo, tool, SEEDED, HANDLER);
  // case hides the skill folder of the checkout that holds the script, so the scripts go into the case repository.
  const script = copyScripts(repo);
  const project = path.join(root, 'project');
  put(project, '.omp/agents/review-bench-configs.json', { configs: [CONFIGS.low], bundled: { ompVersion: '19.1.1' } });
  const id = 'bundled-sec-09';
  const dir = path.join(root, 'cases', 'bundled');
  const known = {
    id: 'S1',
    locator: `${tool}:3`,
    category: 'code',
    source: 'seeded',
    security: true,
    summary: 'The seed joins the name into a shell string; the pull request adds the file, so the behavior is new.',
    fix: `${id}.S1.fix.patch`,
  };
  const caseData = { id, kind: 'code', split: 'dev', issue: 9, round: 1, base, head, patch: `${id}.patch` };
  put(dir, `${id}.json`, { ...caseData, plan: `${id}-plan.md`, known: [known] });
  put(dir, `${id}-plan.md`, '# Add the tool\n');
  put(dir, `${id}.patch`, seed);
  put(dir, `${id}.S1.fix.patch`, fix);
  const run = (out) =>
    spawnSync(
      BUN_RUNTIME,
      [script, 'case', '--case', path.join(dir, `${id}.json`), '--arms', 'R1', '--runs', '1', '--out', out, '--project', project],
      { encoding: 'utf8' },
    );
  const hidden = run(path.join(root, 'ws-hidden'));
  assert.equal(hidden.status, 1, hidden.stderr);
  assert.equal(
    hidden.stderr.trim(),
    `prepare.mjs: bundled case ${id}: the seed patch ${id}.patch edits ${tool}, which the snapshot and the diffs of the case leave out; a seed in the benchmark skill folder needs "show_benchmark": true, and its cases/ folder stays hidden`,
  );
  assert.equal(fs.existsSync(path.join(root, 'ws-hidden', id)), false);
  // With show_benchmark, the diffs show the skill folder, and the seeded line is an added line of the full diff.
  put(dir, `${id}.json`, { ...caseData, show_benchmark: true, plan: `${id}-plan.md`, known: [known] });
  const shown = run(path.join(root, 'ws-shown'));
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(readText(path.join(root, 'ws-shown', id, 'full.diff')).includes('+  return `git switch ${name}`;\n'));
});
