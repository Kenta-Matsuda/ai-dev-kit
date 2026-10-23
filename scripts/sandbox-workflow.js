#!/usr/bin/env node
'use strict';
/**
 * `npm run sandbox -- <standard>` — run one of the kit's standard workflows
 * (templates/workflows/<standard>/) end to end in a throwaway package, with
 * a scripted agent in place of the AI tool, and check the result.
 *
 * What it proves and what it does not. The agents are scripted by the
 * standard workflow's scenario (sandbox/scenario.js next to it): for every
 * start, the scenario says which files to write and what to report, so the
 * run is deterministic and costs nothing. Everything else is real: a git
 * package set up as `aidev init` leaves it, `aidev create workflow --from`,
 * the YAML as shipped, the worktree, `npm ci`, the test runner the `until`
 * commands start, the notes, the retries, the checkpoints, the pull-request
 * step of a trial run. So a green sandbox means the standard workflow's
 * mechanics work against the real tools; it says nothing about how well a
 * real agent would do the work, and the hooks are not exercised (a scripted
 * agent calls none).
 *
 * The scenario module exports:
 *   description   one line
 *   workflowName  the name the copy gets in the package (default: the standard's)
 *   files         { rel: text } the package's own files (the app, its config)
 *   prepare       ({ pkgRoot }) => [{ command, args }] run in the package
 *                 before it is committed (installing the test runner)
 *   spec          the text of the file input, or null
 *   fileInput     the input that takes it (default 'spec')
 *   inputs        { name: value } the other inputs (one that start() supplies
 *                 holds a placeholder here, for the offline check of
 *                 test/sandbox.test.js)
 *   env           { NAME: value } the environment of the run (what
 *                 env_required asks for); their values must appear nowhere
 *   start         async ({ pkgRoot, base }) => { inputs?, env?, stop() } —
 *                 services the run needs (the application under test)
 *   agent         (ctx) => { files?, notes?, report?, verdict? } — the
 *                 scripted agent (scripts/sandbox-agent.js calls it)
 *   expect        ({ record, worktree, runDir, log, calls, git }) => void —
 *                 throws on anything wrong beyond the checks every sandbox
 *                 makes (the run finished, every step passed, nothing was
 *                 pushed, no secret was recorded)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { parseArgs } = require('../cli/lib/args');
const wfMod = require('../cli/lib/workflow');
const fixtures = require('../test/fixtures');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'cli', 'bin', 'aidev.js');
const AGENT = path.join(__dirname, 'sandbox-agent.js');

const FLAGS = { keep: 'boolean', json: 'boolean', list: 'boolean' };

const say = (message) => process.stderr.write(`sandbox: ${message}\n`);

function scenarioFile(std) { return path.join(std.dir, 'sandbox', 'scenario.js'); }

function usage() {
  process.stderr.write([
    'usage: npm run sandbox -- <standard> [--keep] [--json]',
    '       npm run sandbox -- --list',
    '',
    '  --keep   leave the package, the worktree and the run record in place (their paths are printed)',
    '  --json   print the result as JSON on stdout',
    '  --list   the standard workflows and whether each has a sandbox scenario',
    '',
  ].join('\n'));
}

/** Run the CLI in the package; stderr streams through, stdout is kept (for --json). */
function aidev(args, { cwd, env, stream = true }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; if (stream) process.stderr.write(c); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJson(text) {
  const matches = String(text).match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) { try { return JSON.parse(matches[i]); } catch { /* keep looking */ } }
  return null;
}

function runPrepare(pkgRoot, steps) {
  for (const s of steps) {
    say(`prepare: ${s.command} ${s.args.join(' ')}`);
    // Its output goes to stderr: with --json, stdout holds the result only.
    const r = spawnSync(s.command, s.args, { cwd: pkgRoot, stdio: ['ignore', 2, 2], shell: process.platform === 'win32', env: { ...process.env, ...(s.env || {}) } });
    if (r.status !== 0) throw new Error(`prepare: ${s.command} ${s.args.join(' ')} exited ${r.status}`);
  }
}

function commitAll(root, message) {
  fixtures.git(['add', '-A'], root);
  if (fixtures.git(['status', '--porcelain'], root)) {
    fixtures.git(['commit', '-q', '-m', message], root);
    fixtures.git(['push', '-q', 'origin', 'main'], root);
  }
}

/** The checks every sandbox run makes, before the scenario's own. */
function commonChecks({ def, record, worktree, runDir, base, secrets, calls }) {
  const problems = [];
  if (!record) { problems.push('the run printed no JSON record'); return problems; }
  if (!record.done) problems.push(`the run did not finish: ${record.stopReason || '(no reason recorded)'}`);
  for (const s of record.steps || []) {
    if (!s.ok) problems.push(`step ${s.id} did not pass${s.items ? ` (${s.items.filter((x) => !x.ok).map((x) => x.item).join(', ')} failed)` : ''}`);
  }
  const ids = (record.steps || []).map((s) => s.id);
  for (const s of def.steps) if (!ids.includes(s.id)) problems.push(`step ${s.id} was never run`);
  const pr = (record.steps || []).find((s) => s.kind === 'pull-request');
  if (pr && pr.pushed) problems.push('a trial run pushed');
  if (record.trial !== true) problems.push('the run was not recorded as a trial');
  // No secret anywhere: the record, the logs, the prompts, the commits.
  const texts = {
    'run.json': path.join(runDir, 'run.json'),
    'log.txt': path.join(runDir, 'log.txt'),
    'pull-request.md': path.join(runDir, 'pull-request.md'),
    '--log file': path.join(base, 'run.log'),
  };
  const commits = fixtures.git(['log', '-p', `${record.baseSha}..HEAD`], worktree);
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) continue;
    for (const [label, file] of Object.entries(texts)) {
      let text = null;
      try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
      if (text != null && text.includes(value)) problems.push(`the value of ${name} is in ${label}`);
    }
    if (calls.some((c) => c.prompt.includes(value))) problems.push(`the value of ${name} reached an agent's prompt`);
    if (commits.includes(value)) problems.push(`the value of ${name} was committed`);
  }
  return problems;
}

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2), FLAGS);
  const standards = wfMod.listStandardWorkflows(ROOT).map((w) => ({ ...w, scenario: fs.existsSync(scenarioFile(wfMod.readStandardWorkflow(ROOT, w.name))) }));
  if (flags.list || !positionals[0]) {
    if (!flags.list) usage();
    for (const w of standards) process.stderr.write(`  ${w.name.padEnd(24)} ${w.scenario ? 'sandbox scenario' : '(no sandbox scenario)'}  ${w.description}\n`);
    if (flags.json) process.stdout.write(`${JSON.stringify({ standard: standards }, null, 2)}\n`);
    return flags.list ? 0 : 1;
  }
  const name = positionals[0];
  const std = wfMod.readStandardWorkflow(ROOT, name);
  if (!std) throw new Error(`the kit bundles no standard workflow "${name}" (available: ${standards.map((w) => w.name).join(', ') || 'none'})`);
  const file = scenarioFile(std);
  if (!fs.existsSync(file)) throw new Error(`${name} has no sandbox scenario (${path.relative(ROOT, file)})`);
  const scenario = require(file);
  const def = wfMod.parseDefinitionText(std.text, `${name}/workflow.yaml`);
  const wfName = scenario.workflowName || name;
  const started = Date.now();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), `aidev-sandbox-${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  say(`${name}: ${scenario.description || std.description}`);
  say(`sandbox directory: ${base}`);

  // 1. A package as `aidev init` leaves it, with the scenario's own files.
  const fx = fixtures.makeRepo({ hosting: 'generic', pkgFiles: scenario.files || {} });
  let result = { ok: false };
  let services = null;
  try {
    say(`package: ${fx.root}`);
    if (typeof scenario.prepare === 'function') runPrepare(fx.root, await scenario.prepare({ pkgRoot: fx.root, base }));
    commitAll(fx.root, 'sandbox: the application and its dependencies');

    // 2. The standard workflow, copied in as a package would.
    const env = {
      ...process.env, AIDEV_HOME: home, AIDEV_NO_UPDATE_CHECK: '1',
      AIDEV_CLAUDE_BIN: AGENT, AIDEV_SANDBOX_SCENARIO: file, AIDEV_SANDBOX_STATE: path.join(base, 'agent-calls.jsonl'),
    };
    const created = await aidev(['create', 'workflow', wfName, '--from', name], { cwd: fx.root, env });
    if (created.code !== 0) throw new Error(`aidev create workflow --from failed (exit ${created.code})`);
    commitAll(fx.root, `sandbox: workflow ${wfName}`);

    // 3. The inputs, the environment and the services of the run.
    const inputs = { ...(scenario.inputs || {}) };
    if (scenario.spec != null) {
      const specPath = path.join(base, 'inputs', scenario.specFileName || 'spec.csv');
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, scenario.spec, 'utf8');
      inputs[scenario.fileInput || 'spec'] = specPath;
    }
    services = typeof scenario.start === 'function' ? await scenario.start({ pkgRoot: fx.root, base }) : null;
    Object.assign(inputs, (services && services.inputs) || {});
    const runEnv = { ...env, ...(scenario.env || {}), ...((services && services.env) || {}) };
    const secrets = Object.fromEntries(Object.keys(def.env_required || {}).map((k) => [k, runEnv[k]]));
    const args = ['run', 'workflow', wfName, '--trial', '--json', '--log', path.join(base, 'run.log'), ...Object.entries(inputs).flatMap(([k, v]) => ['--input', `${k}=${v}`])];

    // 4. The pre-launch checks first, then the run.
    const dry = await aidev([...args, '--dry-run'], { cwd: fx.root, env: runEnv });
    if (dry.code !== 0) throw new Error(`the dry run was refused (exit ${dry.code}); see above`);
    say('dry run passed; starting the trial run');
    const run = await aidev(args, { cwd: fx.root, env: runEnv });
    const record = lastJson(run.stdout);
    if (services && typeof services.stop === 'function') { await services.stop(); services = null; }
    if (!record) throw new Error(`the run printed no record (exit ${run.code})`);
    const worktree = record.worktree;
    const runDir = path.isAbsolute(record.runDir || '') ? record.runDir : path.join(worktree, record.runDir || path.join('.aidev', 'workflows', wfName, 'runs', record.runId));
    let calls = [];
    try { calls = fs.readFileSync(path.join(base, 'agent-calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { calls = []; }

    // 5. The checks: the kit's, then the scenario's.
    const problems = commonChecks({ def, record, worktree, runDir, base, secrets, calls });
    if (typeof scenario.expect === 'function') {
      try {
        await scenario.expect({ record, worktree, runDir, log: fs.readFileSync(path.join(runDir, 'log.txt'), 'utf8'), calls, inputs, git: (a) => fixtures.git(a, worktree) });
      } catch (e) { problems.push(`scenario: ${e.message}`); }
    }
    const steps = (record.steps || []).map((s) => ({ id: s.id, ok: !!s.ok, attempts: s.attempts, items: s.items ? s.items.map((x) => ({ item: x.item, ok: !!x.ok, attempts: x.attempts })) : undefined }));
    result = { ok: problems.length === 0, standard: name, workflow: wfName, runId: record.runId, done: !!record.done, stopReason: record.stopReason || null, agentRuns: record.agentRuns, steps, problems, worktree, runDir, base, package: fx.root, seconds: Math.round((Date.now() - started) / 1000) };
    process.stderr.write('\n');
    say(`${name}: ${result.ok ? 'PASSED' : 'FAILED'} in ${result.seconds}s (${record.agentRuns} scripted agent start(s))`);
    for (const s of steps) say(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.id}${s.items ? `: ${s.items.map((x) => `${x.item}${x.ok ? '' : ' (failed)'}${x.attempts > 1 ? ` x${x.attempts}` : ''}`).join(', ')}` : s.attempts > 1 ? ` x${s.attempts}` : ''}`);
    for (const p of problems) say(`  problem: ${p}`);
  } finally {
    if (services && typeof services.stop === 'function') { try { await services.stop(); } catch { /* best effort */ } }
    if (flags.keep || !result.ok) {
      say(`kept for inspection: package ${fx.root}; sandbox ${base}${result.worktree ? `; worktree ${result.worktree}` : ''}`);
    } else {
      fx.cleanup();
      try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  if (flags.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  process.stderr.write(`sandbox: ${e && e.message ? e.message : e}\n`);
  if (process.env.AIDEV_DEBUG && e && e.stack) process.stderr.write(`${e.stack}\n`);
  process.exitCode = 1;
});
