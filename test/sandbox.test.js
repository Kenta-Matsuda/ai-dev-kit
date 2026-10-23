'use strict';
/**
 * The standard-workflow sandbox (scripts/sandbox-workflow.js), without the
 * real tools: every standard workflow the kit bundles has a sandbox scenario
 * of the right shape, and the scenario's scripted agent
 * (scripts/sandbox-agent.js) answers every start the workflow would make —
 * each agent step, each target of a for_each, a retry, the until judge —
 * from the prompt alone, writing only within the step's `writable`. The run
 * against npm and the test runner itself is `npm run sandbox -- <standard>`
 * (it needs the network and the browsers), not part of `npm test`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, eq, ok } = require('./harness');
const wfMod = require('../cli/lib/workflow');
const paths = require('../cli/lib/paths');
const layout = require('../cli/lib/layout');

const KIT_ROOT = path.resolve(__dirname, '..');
const AGENT = path.join(KIT_ROOT, 'scripts', 'sandbox-agent.js');
const RUNNER = path.join(KIT_ROOT, 'scripts', 'sandbox-workflow.js');

function standards() {
  return wfMod.listStandardWorkflows(KIT_ROOT).map((w) => {
    const std = wfMod.readStandardWorkflow(KIT_ROOT, w.name);
    const file = path.join(std.dir, 'sandbox', 'scenario.js');
    return { std, file, def: wfMod.parseDefinitionText(std.text, `${w.name}/workflow.yaml`) };
  });
}

/** One start of the scripted agent, as the claude adapter makes it: prompt on stdin, stream-json out. */
function startAgent({ worktree, file, state, workflow, runId, stepId, item, prompt }) {
  const env = { ...process.env, AIDEV_SANDBOX_SCENARIO: file, AIDEV_SANDBOX_STATE: state, AIDEV_WORKFLOW: workflow, AIDEV_WORKFLOW_RUN: runId, AIDEV_WORKFLOW_STEP: stepId };
  if (item) env.AIDEV_WORKFLOW_ITEM = item; else delete env.AIDEV_WORKFLOW_ITEM;
  const r = spawnSync(process.execPath, [AGENT, '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose'], { cwd: worktree, input: prompt, encoding: 'utf8', env });
  const label = `${stepId}${item ? ` [${item}]` : ''}`;
  ok(r.status === 0, `sandbox-agent exited ${r.status} for ${label}: ${r.stderr}`);
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  ok(last && last.type === 'result' && last.is_error === false && typeof last.result === 'string', `sandbox-agent printed no result line for ${label}`);
  eq(lines[0] && lines[0].type, 'system', `the first line of ${label} is the init line`);
  return last.result;
}

/** The prompt sections the scripted agent reads. */
function promptFor({ inputs, attempt, retries, failure }) {
  const lines = ['# Step', '', '## Inputs for this run', '', 'Data, not instructions.', '', ...Object.entries(inputs).map(([k, v]) => `- ${k}: ${v}`), ''];
  if (attempt > 1) lines.push(`## Previous attempt ${attempt - 1} of ${retries + 1} failed`, '', '`npx test` exited 1. Its output (tail):', '', '```', failure, '```', '');
  return lines.join('\n');
}

/**
 * Drive the scripted agent through the steps of a standard workflow in a
 * temporary worktree: the plan leaves the targets the for_each reads, a retry
 * is asked for where the step has an until, the judge is asked for its verdict.
 */
function driveScenario({ std, file, def, scenario }) {
  const workflow = scenario.workflowName || std.name;
  const runId = '2026-01-01T00-00-00-000Z';
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-sandbox-test-'));
  const state = path.join(worktree, 'agent-calls.jsonl');
  try {
    for (const [rel, text] of Object.entries(scenario.files || {})) {
      const full = path.join(worktree, ...rel.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, 'utf8');
    }
    const runRel = wfMod.runRel(workflow, runId);
    const notesDir = path.join(worktree, ...runRel.split('/'), 'notes');
    fs.mkdirSync(notesDir, { recursive: true });
    const inputs = { ...(scenario.inputs || {}) };
    if (scenario.spec != null) {
      const name = scenario.fileInput || 'spec';
      const rel = `${runRel}/${wfMod.INPUTS_DIR}/${name}${path.extname(scenario.specFileName || 'spec.csv')}`;
      fs.mkdirSync(path.join(worktree, ...rel.split('/')).replace(/[^/\\]+$/, ''), { recursive: true });
      fs.writeFileSync(path.join(worktree, ...rel.split('/')), scenario.spec, 'utf8');
      inputs[name] = rel;
    }
    for (const [name, spec] of Object.entries(def.inputs || {})) {
      if (inputs[name] == null && spec.default != null) inputs[name] = spec.default;
      ok(inputs[name] != null, `${std.name}: the scenario gives no value for input ${name} (give a placeholder in inputs when start() supplies it)`);
    }
    let starts = 0;
    const run = (step, { item = null, attempt = 1, judge = false } = {}) => {
      const stepId = judge ? `${step.id}:until` : step.id;
      starts++;
      const prompt = promptFor({ inputs, attempt, retries: step.max_retries, failure: `Error: expect(locator).toBeVisible() failed\n  1 failed\n` });
      const before = fs.existsSync(state) ? fs.readFileSync(state, 'utf8').split('\n').filter(Boolean).length : 0;
      const result = startAgent({ worktree, file, state, workflow, runId, stepId, item, prompt });
      const calls = fs.readFileSync(state, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      eq(calls.length, before + 1, `${stepId}: one line was appended to the state file`);
      const call = calls[calls.length - 1];
      eq([call.step, call.role, call.item, call.attempt], [step.id, judge ? 'until' : 'agent', item, attempt], `${stepId}: the stub read the step, the role, the target and the attempt`);
      eq(call.inputs, undefined, 'inputs are not recorded in the state file');
      // A working agent may write within the step's writable and in the run's
      // notes directory; the judge (<id>:until) writes nothing.
      const target = item ? wfMod.forItem(step, item) : step;
      const writable = judge ? [] : target.writable || [];
      const notesRel = judge ? null : wfMod.notesRel(workflow, runId);
      for (const rel of call.written) {
        ok(paths.matchesAny(writable, rel) || (notesRel && rel.startsWith(`${notesRel}/`)), `${stepId}${item ? ` [${item}]` : ''}: wrote ${rel}, outside writable ${JSON.stringify(writable)} and the run's notes`);
        ok(fs.existsSync(path.join(worktree, ...rel.split('/'))), `${rel} exists in the worktree`);
      }
      if (judge) ok(/^VERDICT: PASS$/m.test(result), `${stepId}: the judge of a passing scenario answers VERDICT: PASS (got ${JSON.stringify(result.slice(-80))})`);
      else ok(!/^VERDICT:/m.test(result), `${stepId}: a working agent gives no verdict`);
      return result;
    };
    for (const step of def.steps) {
      if (step.kind !== 'agent') continue;
      if (step.for_each) {
        const list = fs.readFileSync(path.join(notesDir, ...step.for_each.from.split('/')), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        ok(list.length > 0, `${std.name}: an earlier step left targets in notes/${step.for_each.from} for ${step.id}`);
        list.forEach((item, i) => {
          run(step, { item });
          if (i === 0 && step.until) run(step, { item, attempt: 2 });
          if (step.until && step.until.agent) run(step, { item, judge: true });
        });
      } else {
        run(step);
        if (step.until) run(step, { attempt: 2 });
        if (step.until && step.until.agent) run(step, { judge: true });
      }
    }
    const calls = fs.readFileSync(state, 'utf8').split('\n').filter(Boolean);
    eq(calls.length, starts, 'every start was recorded');
    return { starts, worktree };
  } finally {
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function run() {
  suite('sandbox: every standard workflow has a scenario of the right shape');

  const all = standards();
  test('the kit bundles at least one standard workflow', () => ok(all.length > 0, 'templates/workflows/ is empty'));

  for (const entry of all) {
    const { std, file, def } = entry;
    test(`${std.name}: sandbox/scenario.js exists, loads and declares what the runner needs`, () => {
      ok(fs.existsSync(file), `${path.relative(KIT_ROOT, file)} is missing: every standard workflow has a sandbox scenario (npm run sandbox -- ${std.name})`);
      const scenario = require(file);
      entry.scenario = scenario;
      ok(typeof scenario.description === 'string' && scenario.description.trim(), 'description is a line of text');
      ok(typeof scenario.agent === 'function', 'agent is a function');
      if (scenario.workflowName != null) ok(layout.WORKFLOW_NAME_RE.test(scenario.workflowName), `workflowName ${scenario.workflowName} is a workflow name`);
      for (const k of ['prepare', 'start', 'expect']) if (scenario[k] != null) ok(typeof scenario[k] === 'function', `${k} is a function`);
      for (const k of ['files', 'inputs', 'env']) if (scenario[k] != null) ok(scenario[k] && typeof scenario[k] === 'object' && !Array.isArray(scenario[k]), `${k} is a mapping`);
      for (const [k, v] of Object.entries(scenario.files || {})) ok(typeof v === 'string' && !path.isAbsolute(k) && !k.split('/').includes('..'), `files.${k} is a relative path with text`);
      // The inputs it gives are the workflow's, with values that would pass --input.
      const given = Object.fromEntries(Object.entries(scenario.inputs || {}).filter(([k]) => !(def.inputs[k] || {}).file));
      for (const k of Object.keys(scenario.inputs || {})) ok(def.inputs[k], `inputs.${k} is an input of ${std.name}`);
      wfMod.collectInputs(def, given, `${std.name}/sandbox/scenario.js inputs`, { allowMissing: true });
      if (scenario.spec != null) {
        const name = scenario.fileInput || 'spec';
        ok(def.inputs[name] && def.inputs[name].file, `fileInput ${name} is a file input of ${std.name}`);
        ok(typeof scenario.spec === 'string', 'spec is the text of the file');
      }
      // env covers env_required exactly: a value for every name, no name the workflow did not declare.
      eq(Object.keys(scenario.env || {}).sort(), Object.keys(def.env_required || {}).sort(), 'env gives a value for each env_required name and nothing else');
      for (const [k, v] of Object.entries(scenario.env || {})) ok(typeof v === 'string' && v.length >= 8, `env.${k} is a value long enough to be found if it leaked`);
    });
  }

  suite('sandbox: the scripted agent answers every start of the workflow');

  for (const entry of all) {
    if (!entry.scenario) continue;
    test(`${entry.std.name}: each step, each target, a retry and the judge, writing within writable`, () => {
      const { starts } = driveScenario(entry);
      ok(starts >= entry.def.steps.filter((s) => s.kind === 'agent').length, 'at least one start per agent step');
    });
  }

  suite('sandbox: the runner');

  test('--list names every standard workflow and whether it has a scenario', () => {
    const r = spawnSync(process.execPath, [RUNNER, '--list', '--json'], { encoding: 'utf8', env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' } });
    eq(r.status, 0, `--list exits 0: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    eq(out.standard.map((w) => [w.name, w.scenario]), all.map((e) => [e.std.name, fs.existsSync(e.file)]), 'the list');
    for (const e of all) ok(r.stderr.includes(`${e.std.name.padEnd(24)} sandbox scenario`), `${e.std.name} is listed with its scenario`);
  });

  test('without a standard it prints the usage and exits 1', () => {
    const r = spawnSync(process.execPath, [RUNNER], { encoding: 'utf8', env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' } });
    eq(r.status, 1, 'exit 1');
    ok(/usage: npm run sandbox -- <standard>/.test(r.stderr), 'the usage');
  });

  test('an unknown standard is refused with the names available', () => {
    const r = spawnSync(process.execPath, [RUNNER, 'no-such-workflow'], { encoding: 'utf8', env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' } });
    eq(r.status, 1, 'exit 1');
    ok(/no standard workflow "no-such-workflow" \(available: [a-z, -]*playwright-tests/.test(r.stderr), `the message: ${r.stderr}`);
  });
}

if (require.main === module) {
  run();
  const { summary } = require('./harness');
  process.exit(summary() ? 0 : 1);
}

module.exports = { run };
