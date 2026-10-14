'use strict';
/**
 * `aidev workflow` — the development command.
 *
 * What these suites pin down:
 *
 *   - a definition is YAML only; the validator enforces the mandatory valves
 *     (time ceiling, bounded retries, a USD budget, shell-free commands, a
 *     writable on every agent step and no protected path in it) and rejects
 *     any key the runner would ignore
 *   - what an agent can use (skills, tools, MCP servers) is its frontmatter
 *   - "approved" means identical to origin/<tracking_branch>: a workflow that
 *     was never merged, or was edited since, is refused by `run`; `submit`
 *     puts it on a branch of its own, and a merge makes it approved
 *   - `run` executes the steps in order through the configured tool with the
 *     agent definition and its skills inlined, starts the tool with only the
 *     agent's tools and MCP servers, hands each agent step the reports of the
 *     earlier ones, bounds the `until` loop, stops on a repeated failure and
 *     on the cost budget, records the run, and hands AIDEV_WORKFLOW and
 *     AIDEV_WORKFLOW_STEP to the tool so the write guard can apply the step's
 *     writable
 *   - a pull-request step commits only what the steps may write, on its own
 *     branch, and pushes it (the PR itself needs Azure DevOps and is
 *     reported, not made)
 *
 * The tool binary is a stub reached through AIDEV_CLAUDE_BIN; nothing here
 * starts a real AI tool, and nothing here talks to a network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, ok, eq, throws } = require('./harness');
const { makeRepo, write, git } = require('./fixtures');
const { aidev, lastJson } = require('./completion.test');
const wfMod = require('../cli/lib/workflow');

const KIT_ROOT = path.resolve(__dirname, '..');

/** A tool stub outside the repository (a workflow with a pull-request step needs a clean tree). */
function stubDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-wf-stub-'));
}

function writeToolStub(dir) {
  const p = path.join(dir, 'fake-tool.js');
  fs.writeFileSync(p, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(argv, null, 2));
const mcpAt = argv.indexOf('--mcp-config');
if (mcpAt >= 0 && process.env.STUB_MCP_OUT) fs.writeFileSync(process.env.STUB_MCP_OUT, fs.readFileSync(argv[mcpAt + 1]));
const agentsAt = argv.indexOf('--agents');
if (agentsAt >= 0 && process.env.STUB_AGENTS_OUT) fs.writeFileSync(process.env.STUB_AGENTS_OUT, fs.readFileSync(argv[agentsAt + 1]));
// STUB_SPANS_OUT: one line per start (step, target, start and end time); STUB_SLEEP_MS keeps each start busy that long.
const startedAt = Date.now();
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ AIDEV_WORKFLOW: process.env.AIDEV_WORKFLOW || null, AIDEV_WORKFLOW_STEP: process.env.AIDEV_WORKFLOW_STEP || null, ...(process.env.AIDEV_WORKFLOW_TRIAL ? { AIDEV_WORKFLOW_TRIAL: process.env.AIDEV_WORKFLOW_TRIAL } : {}) }));
if (process.env.STUB_STEPS_OUT) fs.appendFileSync(process.env.STUB_STEPS_OUT, (process.env.AIDEV_WORKFLOW_STEP || '') + '\\n');
// An until agent (step "<id>:until") answers the next verdict from STUB_VERDICTS (a JSON list).
let answer = process.env.STUB_ANSWER || 'stub answer';
const step = process.env.AIDEV_WORKFLOW_STEP || '';
// An editing agent (aidev modify): write STUB_WRITE_TEXT to STUB_WRITE_FILE, relative to the repository.
if (process.env.STUB_WRITE_FILE) fs.writeFileSync(process.env.STUB_WRITE_FILE, process.env.STUB_WRITE_TEXT || '');
if (step.endsWith(':until') && process.env.STUB_VERDICTS && fs.existsSync(process.env.STUB_VERDICTS)) {
  const queue = JSON.parse(fs.readFileSync(process.env.STUB_VERDICTS, 'utf8'));
  const v = queue.shift();
  fs.writeFileSync(process.env.STUB_VERDICTS, JSON.stringify(queue));
  if (v) answer = 'review ' + queue.length + ': ' + (v === 'FAIL' ? 'test for empty input is missing' : 'good') + '\\nVERDICT: ' + v;
}
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  // A for_each agent: write <STUB_ITEM_DIR>/<target>.txt for the target its prompt names.
  const target = /## Your target: (\\S+)/.exec(stdin);
  if (process.env.STUB_ITEM_DIR && target) {
    const f = require('path').join(process.env.STUB_ITEM_DIR, target[1] + '.txt');
    fs.mkdirSync(require('path').dirname(f), { recursive: true });
    fs.writeFileSync(f, 'test for ' + target[1] + '\\n');
    if (process.env.STUB_ITEM_TOUCH) fs.appendFileSync(process.env.STUB_ITEM_TOUCH, target[1] + '\\n');
  }
  if (process.env.STUB_PROMPT_OUT) fs.appendFileSync(process.env.STUB_PROMPT_OUT, stdin + '\\n=====\\n');
  if (process.env.STUB_MODE === 'fail') { process.stderr.write('stub: refused\\n'); process.exit(2); }
  // STUB_SLEEP_FOR ("left:900,right:100") overrides STUB_SLEEP_MS for the named steps.
  const own = new Map(String(process.env.STUB_SLEEP_FOR || '').split(',').filter(Boolean).map((x) => x.split(':')));
  const busy = Number(own.has(step) ? own.get(step) : process.env.STUB_SLEEP_MS || 0);
  if (busy) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, busy);
  if (process.env.STUB_SPANS_OUT) {
    fs.appendFileSync(process.env.STUB_SPANS_OUT, JSON.stringify({ step, item: process.env.AIDEV_WORKFLOW_ITEM || null, start: startedAt, end: Date.now() }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: process.cwd() + '/stub-read.md' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu0', message: { content: [
    { type: 'tool_use', id: 'tu2', name: 'Glob', input: { pattern: 'stub/**' } }] } }) + '\\n');
  // STUB_COST prices this start; the estimate reviewer answers STUB_REVIEW_ANSWER.
  const cost = Number(process.env.STUB_COST || 0.0123);
  const review = /# Review the cost estimates/.test(stdin) && process.env.STUB_REVIEW_ANSWER;
  // STUB_DENIALS: paths the tool reports as refused writes; STUB_PUSH_OUT: try a git push and write how it went.
  const denials = String(process.env.STUB_DENIALS || '').split(',').filter(Boolean).map((p) => ({ tool_name: 'Write', tool_input: { file_path: p } }));
  if (process.env.STUB_PUSH_OUT) {
    const r = require('child_process').spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/evil'], { encoding: 'utf8' });
    fs.writeFileSync(process.env.STUB_PUSH_OUT, String(r.status) + ' ' + String(r.stderr || ''));
  }
  process.stdout.write(JSON.stringify({ type: 'result', result: review || answer, is_error: false, total_cost_usd: cost, session_id: 's', permission_denials: denials,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 },
    modelUsage: { 'claude-haiku-5-5': { costUSD: 0.0001 }, 'claude-sonnet-5-5': { costUSD: cost } } }) + '\\n');
});
`, 'utf8');
  return p;
}

const GOOD = {
  name: 'wf', objective: 'do the thing',
  steps: [{ id: 'a', agent: 'issue-to-pr', writable: ['src/**'], prompt: 'go' }], limits: { max_usd: 1 },
};
const withStep = (patch) => ({ ...GOOD, steps: [{ ...GOOD.steps[0], ...patch }] });

/** An agent step without its own writable gets `writable: [<writable>]` after its agent line. */
function yamlOf(name, { writable = 'src/**', steps, extra = [], cost = 1, minutes = 5 } = {}) {
  const lines = [];
  steps.forEach((l, i) => {
    lines.push(l);
    if (!/^ {4}agent: /.test(l)) return;
    let j = i + 1;
    let has = false;
    for (; j < steps.length && !/^ {2}- /.test(steps[j]); j++) if (/^ {4}writable:/.test(steps[j])) has = true;
    if (!has) lines.push(`    writable: [${writable}]`);
  });
  return [
    `name: ${name}`, 'description: "test workflow"', 'objective: |', '  Make the thing work.',
    ...extra, 'steps:', ...lines,
    'limits:', `  max_usd: ${cost}`, ...(minutes == null ? [] : [`  max_minutes: ${minutes}`]), '',
  ].join('\n');
}

/** Put the workflow (and anything else staged) on origin/main, the way a merged PR would. */
function approve(fx, message = 'add workflow') {
  git(['add', '-A'], fx.root);
  git(['commit', '-q', '-m', message], fx.root);
  git(['push', '-q', 'origin', 'main'], fx.root);
}

function run() {
  // -------------------------------------------------------------- schema
  suite('workflow: definition schema');

  test('a valid definition normalises steps, agents, writable and limits', () => {
    const d = wfMod.validateDefinition({ ...GOOD, tool: 'claude', model: '' }, 'wf');
    eq(d.agents, ['issue-to-pr'], 'the agents are the ones the steps name');
    eq([d.tool, d.model], ['claude', null]);
    eq(d.steps[0], { id: 'a', kind: 'agent', description: '', agent: 'issue-to-pr', prompt: 'go', writable: ['src/**'], unchanged: [], for_each: null, until: null, max_retries: 0, timeout_ms: null });
    const each = wfMod.validateDefinition(withStep({
      prompt: 'test {item}', unchanged: ['tests/**'], for_each: { from: 'targets.txt', max_items: 5 }, until: { command: 'npx playwright test {item}' },
    }), 'wf').steps[0];
    eq([each.unchanged, each.for_each], [['tests/**'], { from: 'targets.txt', max_items: 5, on_failure: 'stop', parallel: 1 }]);
    const one = wfMod.forItem(each, 'e2e/login.spec.ts');
    eq([one.prompt, one.until.commands[0].argv], ['test e2e/login.spec.ts', ['npx', 'playwright', 'test', 'e2e/login.spec.ts']], '{item} is the target, one argv entry');
    eq(wfMod.parseItems('# screens\n\n- login\n* orders/list\nlogin\n  @scope/pkg  \n', each.for_each), ['login', 'orders/list', '@scope/pkg'],
      'one target per line; comments, blanks, list marks and repeats dropped');
    eq(d.limits, { max_usd: 1, max_minutes: null }, 'no time limit unless the workflow sets one');
    eq(wfMod.validateDefinition({ ...GOOD, limits: { max_usd: 3, max_minutes: 600 } }, 'wf').limits, { max_usd: 3, max_minutes: 600 }, 'a time limit has no ceiling');
    const u = wfMod.validateDefinition({ ...GOOD, steps: [
      { agent: 'x', writable: [], prompt: 'p', description: 'look first' },
      { agent: 'x', writable: ['src/**'], prompt: 'p', until: { command: 'npm test' } },
      { command: 'npm run gen', writable: ['gen/**'] },
      { pull_request: { title: 't' } },
    ] }, 'wf');
    eq(u.steps.map((s) => s.id), ['step-1', 'step-2', 'step-3', 'step-4'], 'ids default from position');
    eq(u.steps[0].description, 'look first');
    eq(u.steps[1].until, { commands: [{ text: 'npm test', argv: ['npm', 'test'] }], cwd: null, env: {}, timeout_ms: null, agent: null, prompt: null, max_retries: 3 });
    const many = wfMod.validateDefinition(withStep({ until: {
      command: ['npm ci', 'npx playwright test'], cwd: 'e2e/', env: { CI: 1, BASE_URL: 'http://localhost:3000' }, timeout_minutes: 10,
    } }), 'wf').steps[0].until;
    eq(many.commands.map((c) => c.text), ['npm ci', 'npx playwright test'], 'a list of commands runs in order');
    eq([many.cwd, many.env, many.timeout_ms], ['e2e', { CI: '1', BASE_URL: 'http://localhost:3000' }, 600000]);
    const cmd = wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm ci', cwd: 'web', env: { CI: true } }] }, 'wf').steps[0];
    eq([cmd.cwd, cmd.env, cmd.timeout_ms], ['web', { CI: 'true' }, null]);
    eq(u.steps[1].max_retries, 3, 'an until step retries 3 times by default');
    const r = wfMod.validateDefinition(withStep({ until: { command: 'npm test', agent: 'reviewer', prompt: 'check it' } }), 'wf');
    eq(r.steps[0].until.agent, 'reviewer');
    eq(r.agents, ['issue-to-pr', 'reviewer'], 'an until agent is one of the workflow\'s agents (resolved, approved, launched)');
    eq(u.steps[2].command.argv, ['npm', 'run', 'gen']);
    eq(u.steps[3], { id: 'step-4', kind: 'pull-request', description: '', title: 't' });
    eq(u.writable, ['src/**', 'gen/**'], 'the pull-request step commits what any step may write');
  });

  test('the mandatory valves cannot be omitted or raised', () => {
    throws(() => wfMod.validateDefinition({ ...GOOD, objective: '' }, 'wf'), /objective is required/);
    throws(() => wfMod.validateDefinition(withStep({ writable: undefined }), 'wf'), /writable is required for an agent step/);
    throws(() => wfMod.validateDefinition(withStep({ writable: ['.aidev/policy.yaml'] }), 'wf'), /protected path/);
    throws(() => wfMod.validateDefinition(withStep({ writable: ['.claude/**'] }), 'wf'), /protected path/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { max_minutes: 30 } }, 'wf'), /limits\.max_usd is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: undefined }, 'wf'), /limits is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, cost: { max_usd: 1 } }, 'wf'), /the budget is limits\.max_usd now/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { max_usd: 1, max_tokens: 5 } }, 'wf'), /limits: unknown key max_tokens/);
    throws(() => wfMod.validateDefinition(withStep({ timeout_ms: 60000 }), 'wf'), /timeout_ms is timeout_minutes now/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', timeout_ms: 1 } }), 'wf'), /timeout_ms is timeout_minutes now/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', max_retries: 11 } }), 'wf'), /above the hard ceiling of 10/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test' }, max_retries: 2 }), 'wf'), /max_retries is written inside until now/);
    eq(wfMod.validateDefinition(withStep({ until: { command: 'npm test', max_retries: 0 } }), 'wf').steps[0].max_retries, 0, 'until.max_retries: 0 checks without retrying');
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test | tee log' } }), 'wf'), /without a shell/);
    throws(() => wfMod.validateDefinition(withStep({ until: 'npm test' }), 'wf'), /until must be a mapping/);
    throws(() => wfMod.validateDefinition(withStep({ until: {} }), 'wf'), /until needs a command, an agent, or both/);
    throws(() => wfMod.validateDefinition(withStep({ until: { agent: 'reviewer' } }), 'wf'), /until\.prompt is required/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', prompt: 'x' } }), 'wf'), /until\.prompt needs until\.agent/);
    throws(() => wfMod.validateDefinition(withStep({ until: { agent: '../x', prompt: 'x' } }), 'wf'), /until\.agent/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', retries: 2 } }), 'wf'), /until: unknown key retries/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'echo "hi" > out' }] }, 'wf'), /without a shell/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: ['npm ci', 'npm test | tee log'] } }), 'wf'), /without a shell/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: [] } }), 'wf'), /must not be an empty list/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', cwd: '../other' } }), 'wf'), /until\.cwd is a directory inside the repository/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', cwd: 'C:/tmp' }] }, 'wf'), /cwd is a directory inside the repository/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', env: { AIDEV_WORKFLOW: 'x' } } }), 'wf'), /cannot set AIDEV_\* variables/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', env: { 'A B': 'x' } } }), 'wf'), /not an environment variable name/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test', env: ['CI=1'] } }), 'wf'), /must be a mapping/);
    throws(() => wfMod.validateDefinition(withStep({ until: { agent: 'reviewer', prompt: 'x', cwd: 'e2e' } }), 'wf'), /until\.cwd needs until\.command/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', timeout_minutes: 241 }] }, 'wf'), /above the ceiling of 240 minutes/);
    eq(wfMod.validateDefinition(withStep({ timeout_minutes: 0.5 }), 'wf').steps[0].timeout_ms, 30000, 'minutes, kept as milliseconds');
    const FE = { from: 'targets.txt', max_items: 5 };
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: 'targets.txt' } }), 'wf'), /for_each\.max_items is required/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: 'targets.txt', max_items: 10001 } }), 'wf'), /above the hard ceiling of 10000/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: 'targets.txt', max_items: 5, on_failure: 'skip' } }), 'wf'), /on_failure is stop or continue/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: '../targets.txt', max_items: 5 } }), 'wf'), /name of a file in the run's notes directory/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { ...FE, parallel: 2 } }), 'wf'), /for_each\.parallel needs every writable path to name the target as \{item\}/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { ...FE, parallel: 17 } }), 'wf'), /above the hard ceiling of 16/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do it', for_each: FE }), 'wf'), /prompt must name its target as \{item\}/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test {item}' } }), 'wf'), /\{item\} needs for_each/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test {item}' }] }, 'wf'), /belongs to an agent step with for_each/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', unchanged: ['tests/**'] }] }, 'wf'), /unchanged does not belong to a command step/);
    throws(() => wfMod.validateDefinition(withStep({ unchanged: ['../x'] }), 'wf'), /repo-relative/);
    eq(wfMod.validateDefinition(withStep({ unchanged: ['tests/**'] }), 'wf').steps[0].max_retries, 0, 'without an until a step is not retried');
    for (const bad of ['--config=evil.js', 'a b', '../up', 'x/../y', 'semi;colon', '$HOME']) {
      throws(() => wfMod.parseItems(`ok\n${bad}\n`, FE), /line 2: .* is not a target/);
    }
    throws(() => wfMod.parseItems('a\nb\nc\nd\ne\nf\n', FE), /lists 6 targets, above for_each\.max_items \(5\)/);
    throws(() => wfMod.validateDefinition(withStep({ command: 'npm test' }), 'wf'), /exactly one of agent, command, pull_request or parallel/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'pull-request' }] }, 'wf'), /pull_request: \{ title: \.\.\. \} now/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ pull_request: null, title: 'x' }] }, 'wf'), /title of a pull request is written inside it/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ pull_request: 'yes' }] }, 'wf'), /pull_request is a mapping/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ pull_request: { body: 'x' } }] }, 'wf'), /pull_request: unknown key body/);
    eq(wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'pr', pull_request: null }] }, 'wf').steps[0], { id: 'pr', kind: 'pull-request', description: '', title: null }, 'pull_request: with nothing after it');
    eq(wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'pr', pull_request: { title: 'T' } }] }, 'wf').steps[0].title, 'T');
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'a', agent: 'x', writable: [], prompt: 'p' }, { id: 'a', command: 'npm test' }] }, 'wf'), /duplicate step id/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ pull_request: {} }, { pull_request: {} }] }, 'wf'), /at most one pull-request/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [] }, 'wf'), /steps must be a non-empty list/);
    throws(() => wfMod.validateDefinition({ ...GOOD, tool: 'cursor' }, 'wf'), /not a supported tool/);
    throws(() => wfMod.validateDefinition({ ...GOOD, model: '-p' }, 'wf'), /model/);
    throws(() => wfMod.validateDefinition(withStep({ agent: '../x' }), 'wf'), /agent/);
  });

  test('a key the runner would ignore is refused, and the removed ones say where they went', () => {
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: { writable: ['src/**'] } }, 'wf'), /scope is not a workflow key; writable is written on each step/);
    throws(() => wfMod.validateDefinition({ ...GOOD, skills: ['x'] }, 'wf'), /skills is not a workflow key; skills belong to an agent; assign it to the agent in the top-level agents:/);
    throws(() => wfMod.validateDefinition({ ...GOOD, retries: 3 }, 'wf'), /unknown key retries/);
    throws(() => wfMod.validateDefinition(withStep({ mcp: ['x'] }), 'wf'), /steps\[0\]: a step does not carry MCP servers; assign it to the agent in the top-level agents:/);
    throws(() => wfMod.validateDefinition(withStep({ skills: ['x'] }), 'wf'), /a step does not carry skills/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ pull_request: {}, writable: ['src/**'] }] }, 'wf'), /writable does not belong to a pull-request step/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { minutes: 5 } }, 'wf'), /limits: unknown key minutes/);
  });

  test('an agent\'s frontmatter says what it can use: skills, tools and MCP servers', () => {
    eq(wfMod.agentCapabilities({}), { skills: [], tools: null, mcp: [], subagents: [] }, 'nothing listed: no skills, the default tools, no MCP, any subagent');
    eq(wfMod.agentCapabilities({ skills: '[a, b]', tools: 'Read, Grep', mcp: '[tickets]', subagents: '[explorer]' }),
      { skills: ['a', 'b'], tools: ['Read', 'Grep'], mcp: ['tickets'], subagents: ['explorer'] });
    eq(wfMod.agentCapabilities({ tools: '[]', mcp: '' }).tools, null, 'an empty tools list means the default set');
    throws(() => wfMod.agentCapabilities({ tools: 'Read, rm -rf' }), /not a tool name/);
    throws(() => wfMod.agentCapabilities({ mcp: '[a__b]' }), /not an MCP server name/);
    throws(() => wfMod.agentCapabilities({ skills: '[../x]' }), /name/);
    const access = { tools: ['Read', 'Task'], mcp: ['tickets'] };
    eq(['Read', 'Agent', 'Task', 'Bash', 'mcp__tickets__get', 'mcp__billing__charge', 'mcp__odd']
      .map((t) => wfMod.toolGranted(access, t)), [true, true, true, false, true, false, false], 'Task and Agent are one grant');
    eq(wfMod.toolGranted({ tools: null, mcp: [] }, 'Bash'), true, 'no tools listed: the default set');
  });

  test('a workflow\'s agents: assigns skills, MCP servers and tools to the agents its steps name', () => {
    const def = wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { skills: ['a', 'a'], mcp: 'tickets', tools: ['Read', 'Edit'] } } }, 'wf');
    eq(def.grants, { 'issue-to-pr': { skills: ['a'], mcp: ['tickets'], tools: ['Read', 'Edit'], subagents: [] } }, 'one name is a list of one; duplicates dropped');
    eq(wfMod.validateDefinition(GOOD, 'wf').grants, {}, 'no agents: assigns nothing');
    eq(wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': null } }, 'wf').grants['issue-to-pr'], { skills: [], mcp: [], tools: null, subagents: [] });
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: ['x'] }, 'wf'), /agents is a mapping of agent name/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { other: { skills: ['a'] } } }, 'wf'), /agents\.other: no step names agent other/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { model: 'x' } } }, 'wf'), /agents\.issue-to-pr: unknown key model/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { mcp: ['a__b'] } } }, 'wf'), /mcp: "a__b" is not an MCP server name/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { tools: ['rm -rf'] } } }, 'wf'), /tools: "rm -rf" is not a tool name/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { tools: [] } } }, 'wf'), /tools must name at least one tool/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { skills: ['../x'] } } }, 'wf'), /agents\.issue-to-pr: skills/);
    // An until agent is an agent the steps name, too.
    const judged = withStep({ until: { agent: 'reviewer', prompt: 'check' } });
    eq(Object.keys(wfMod.validateDefinition({ ...judged, agents: { reviewer: { mcp: ['tickets'] } } }, 'wf').grants), ['reviewer']);
    // skills and mcp are added to the frontmatter's; tools replaces its list.
    const own = { skills: ['s1'], tools: null, mcp: ['m1'] };
    eq(wfMod.mergeCapabilities(own, { skills: ['s1', 's2'], mcp: ['m2'], tools: null, subagents: ['x'] }), { skills: ['s1', 's2'], tools: null, mcp: ['m1', 'm2'], subagents: ['x'] });
    eq(wfMod.mergeCapabilities({ ...own, tools: ['Read', 'Bash'] }, { skills: [], mcp: [], tools: ['Read'], subagents: [] }).tools, ['Read']);
    eq(wfMod.mergeCapabilities(own, undefined), { ...own, subagents: [] });
  });

  test('a parallel group runs agent steps at once; their writable paths may not meet', () => {
    const A = { id: 'api', agent: 'api-writer', writable: ['api/**'], prompt: 'p' };
    const W = { id: 'web', agent: 'web-writer', writable: ['web/**'], unchanged: ['api/openapi.yaml'], prompt: 'p' };
    const d = wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'build', description: 'both sides', parallel: [A, { ...W, unchanged: [] }] }, { command: 'npm test' }] }, 'wf');
    eq(d.steps.map((s) => [s.id, s.group || null]), [['api', 'build'], ['web', 'build'], ['step-2', null]], 'members are steps of their own, marked with the group');
    eq(d.groups, [{ id: 'build', description: 'both sides', members: ['api', 'web'] }]);
    eq(d.agents, ['api-writer', 'web-writer']);
    eq(d.writable, ['api/**', 'web/**']);
    const group = (members) => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'g', parallel: members }] }, 'wf');
    throws(() => group([A, { ...W, writable: ['api/v2/**'] }]), /steps api and web run at the same time but may write the same paths \(api\/\*\* and api\/v2\/\*\*\)/);
    throws(() => group([{ ...A, writable: ['api/**', 'shared/a.ts'] }, W]), /web must leave unchanged|may write api\/\*\*, which step web must leave unchanged/);
    eq(group([{ ...A, writable: ['shared/a.ts'] }, { ...W, writable: ['shared/b.ts'], unchanged: [] }]).steps.length, 2, 'two different files of one directory');
    throws(() => group([A]), /at least two agent steps/);
    throws(() => group([A, { id: 'lint', command: 'npm run lint' }]), /parallel\[1\]: a parallel group holds agent steps only/);
    throws(() => group([A, { id: 'inner', parallel: [W, W] }]), /holds agent steps only/);
    throws(() => group(Array.from({ length: 17 }, (_, k) => ({ ...A, id: `a${k}`, writable: [`d${k}/**`] }))), /above the ceiling of 16/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'api', parallel: [A, { ...W, unchanged: [] }] }] }, 'wf'), /duplicate step id api/);
    eq(group([{ ...A, id: undefined }, { ...W, id: undefined, unchanged: [] }]).steps.map((s) => s.id), ['g-1', 'g-2'], 'members without an id are named after the group');
    // The overlap test errs towards "they might".
    eq([['src/**', 'src/a.ts'], ['src/a.ts', 'src/b.ts'], ['api/**', 'web/**'], ['a/*.ts', 'a/b/**'], ['e2e/{item}.ts', 'e2e/x.ts'], ['a/b.ts', 'a/b.ts']]
      .map(([x, y]) => wfMod.mayOverlap(x, y)), [true, false, false, true, true, true]);
  });

  test('for_each.parallel runs targets at once; each one writes only paths named after it', () => {
    const FE = { from: 'targets.txt', max_items: 50, parallel: 4 };
    const d = wfMod.validateDefinition(withStep({ prompt: 'test {item}', writable: ['e2e/tests/{item}.spec.ts'], for_each: FE }), 'wf');
    eq(d.steps[0].for_each.parallel, 4);
    eq(d.writable, ['e2e/tests/**'], 'the pull request takes the directory every target writes in');
    eq(wfMod.forItem(d.steps[0], 'login/form').writable, ['e2e/tests/login/form.spec.ts']);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'test {item}', writable: ['e2e/tests/{item}.spec.ts', 'e2e/index.ts'], for_each: FE }), 'wf'),
      /for_each\.parallel needs every writable path to name the target/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'test {item}', writable: ['{item}/x.ts'], for_each: FE }), 'wf'), /must start with a fixed directory before \{item\}/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'go', writable: ['e2e/{item}.ts'] }), 'wf'), /\{item\} needs for_each/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'test {item}', writable: ['e2e/{item}.ts'], unchanged: ['cfg/{item}'], for_each: FE }), 'wf'), /unchanged cannot name \{item\}/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', writable: ['out/{item}'] }] }, 'wf'), /belongs to an agent step with for_each/);
    // The guard: {item} is the target the runner named, and nothing without one.
    const deps = { agents: { 'issue-to-pr': { capabilities: { skills: [], tools: null, mcp: [], subagents: [] } } } };
    eq(wfMod.stepAccess(d, deps, 'a', { item: 'login' }).writable, ['e2e/tests/login.spec.ts']);
    eq(wfMod.stepAccess(d, deps, 'a').writable, [], 'no target: none of its paths');
    eq(wfMod.stepAccess(d, deps, 'a', { item: '../x' }).writable, [], 'not a target');
  });

  test('inputs, provide and never_commit: what a run is given, what it finds in its worktree, what it never commits', () => {
    const IN = { spec: { description: 'the spec', path: true }, browser: { default: 'chromium', pattern: '[a-z]+' }, notes: {} };
    const d = wfMod.validateDefinition({
      ...GOOD, objective: 'from {inputs.spec}', inputs: IN, provide: ['docs/spec/**'], never_commit: ['e2e/test-results/**'],
      steps: [
        { id: 'a', agent: 'issue-to-pr', writable: ['e2e/**'], prompt: 'read {inputs.spec} for {inputs.notes}', until: { command: 'npx t --project {inputs.browser}', env: { B: '{inputs.browser}' } } },
        { id: 'c', command: 'node x {inputs.spec}' },
      ],
    }, 'wf');
    eq(Object.keys(d.inputs), ['spec', 'browser', 'notes']);
    eq([d.inputs.spec.path, d.inputs.spec.inCommand, d.inputs.browser.default, d.inputs.browser.inCommand, d.inputs.notes.inCommand], [true, true, 'chromium', true, false]);
    eq([d.provide, d.never_commit], [['docs/spec/**'], ['e2e/test-results/**']]);
    eq(wfMod.neverCommitted(d).slice(-1), ['e2e/test-results/**'], 'the kit\'s own list first, the workflow\'s after');
    ok(wfMod.NEVER_COMMITTED.includes('**/node_modules/**'));
    eq(wfMod.pathspecs(['e2e/**'], ['**/node_modules/**']), [':(glob)e2e/**', ':(exclude,glob)**/node_modules/**']);
    // The values: given, checked, defaults filled in, written where the definition named them.
    const v = wfMod.collectInputs(d, ['spec=docs/spec/login.txt', 'notes=be brief']);
    eq(v, { spec: 'docs/spec/login.txt', notes: 'be brief', browser: 'chromium' });
    const live = wfMod.withInputs(d, v);
    eq([live.objective, live.steps[0].prompt], ['from docs/spec/login.txt', 'read docs/spec/login.txt for be brief']);
    eq(live.steps[0].until.commands[0].argv, ['npx', 't', '--project', 'chromium'], 'a value is one argv entry');
    eq([live.steps[0].until.env.B, live.steps[1].command.text], ['chromium', 'node x docs/spec/login.txt']);
    eq(d.steps[0].prompt, 'read {inputs.spec} for {inputs.notes}', 'the definition itself is untouched');
    throws(() => wfMod.collectInputs(d, ['notes=x']), /needs --input for: spec \(the spec\)/);
    throws(() => wfMod.collectInputs(d, ['spec=a', 'zzz=1']), /declares no input "zzz"/);
    throws(() => wfMod.collectInputs(d, ['spec=a', 'spec=b']), /given twice/);
    throws(() => wfMod.collectInputs(d, ['spec=a', 'browser=Fire']), /does not match its pattern/);
    throws(() => wfMod.collectInputs(d, ['spec=../etc/x']), /a path inside the repository/);
    throws(() => wfMod.collectInputs(d, ['spec=docs/spec.xlsx']), /export docs\/spec\.xlsx to Markdown/);
    throws(() => wfMod.collectInputs(d, ['spec=a', 'notes={item}']), /cannot contain \{ or \}/);
    throws(() => wfMod.collectInputs(d, ['spec=a b']), /one plain token/, 'a value that reaches a command is one token');
    eq(wfMod.collectInputs(d, [], '--input', { allowMissing: true }), { browser: 'chromium' });
    // The declarations.
    throws(() => wfMod.validateDefinition({ ...GOOD, objective: 'x {inputs.zzz}' }, 'wf'), /names \{inputs\.zzz\}, which inputs: does not declare/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: {} }, steps: [{ id: 'c', command: 'node x {inputs.v}' }] }, 'wf'), /reaches a command .*needs a pattern/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: {} }, steps: [{ id: 'c', command: 'node x', env: { V: '{inputs.v}' } }] }, 'wf'), /reaches a command/, 'an env value is as much a command as an argument');
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { pattern: '[a-z]+' } }, steps: [{ id: 'c', command: '{inputs.v} test' }] }, 'wf'), /the executable of a command .* is fixed/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: {} }, steps: [{ ...GOOD.steps[0], writable: ['{inputs.v}/**'] }] }, 'wf'), /writable cannot name an input/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: {} }, description: 'd {inputs.v}' }, 'wf'), /description cannot name an input/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { Bad: {} } }, 'wf'), /is not an input name/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { required: true } } }, 'wf'), /inputs\.v: unknown key required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { pattern: '(' } } }, 'wf'), /not a regular expression/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { default: 'A1', pattern: '[a-z]+' } } }, 'wf'), /inputs\.v\.default: input v: "A1" does not match/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { path: true, file: true } } }, 'wf'), /exclude each other/);
    throws(() => wfMod.validateDefinition({ ...GOOD, inputs: { v: { file: true, default: 'x' } } }, 'wf'), /a file input has no default/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['**/*.txt'] }, 'wf'), /must start with a fixed directory/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['.aidev/cache/**'] }, 'wf'), /never copied into a run/);
    throws(() => wfMod.validateDefinition({ ...GOOD, ignore: ['x/**'] }, 'wf'), /unknown key ignore/);
    throws(() => wfMod.validateDefinition({ ...GOOD, never_commit: ['src/**'] }, 'wf'), /never_commit src\/\*\* covers what step a may write/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['config/.env'] }, 'wf'), /credentials never go into a run/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['certs/*.pem'] }, 'wf'), /credentials never go into a run/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['.claude/settings.local.json'] }, 'wf'), /never copied into a run/);
    throws(() => wfMod.validateDefinition({ ...GOOD, provide: ['.github/agents/*.md'] }, 'wf'), /never copied into a run/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'c', command: 'npm run deploy', env: { GIT_CONFIG_COUNT: '0' } }] }, 'wf'), /cannot set GIT_CONFIG\* variables/);
    // Residue is an untracked file under the never-committed globs; an edit to a tracked file is the run's work wherever it is.
    const st = [{ xy: '??', path: 'e2e/node_modules/x.js' }, { xy: ' M', path: 'vendor/node_modules/r.js' }, { xy: '??', path: 'e2e/a.ts' }];
    eq(wfMod.withoutResidue(st, wfMod.NEVER_COMMITTED).map((e) => e.path), ['vendor/node_modules/r.js', 'e2e/a.ts']);
    eq(wfMod.residueOf(st, wfMod.NEVER_COMMITTED).map((e) => e.path), ['e2e/node_modules/x.js']);
    // A file input: the value is a file on this machine; the run gets a copy under its runs/<id>/inputs/.
    const f = wfMod.validateDefinition({ ...GOOD, inputs: { spec: { file: true } }, steps: [{ id: 'c', command: 'node x {inputs.spec}' }] }, 'wf');
    const specFile = path.join(os.tmpdir(), `aidev-spec-${process.pid}.txt`);
    fs.writeFileSync(specFile, 'spec');
    try {
      const given = wfMod.collectInputs(f, [`spec=${specFile}`]);
      const placed = wfMod.placeFileInputs(f, given, { name: 'wf', runId: '2026-01-01T00-00-00-000Z' });
      eq(placed.values.spec, '.aidev/workflows/wf/runs/2026-01-01T00-00-00-000Z/inputs/spec.txt');
      eq(placed.files, [{ name: 'spec', from: specFile, to: placed.values.spec }]);
      eq(wfMod.collectInputs(f, placed.values, 'recorded', { placed: true }).spec, placed.values.spec, 'a recorded copy is checked as a repository path');
      throws(() => wfMod.collectInputs(f, [`spec=${specFile}.xlsx`]), /export .* to Markdown/);
      throws(() => wfMod.collectInputs(f, ['spec=/no/such/file.txt']), /is not a file on this machine/);
    } finally { fs.rmSync(specFile, { force: true }); }
    // --input is a flag that may be repeated.
    const { parseArgs } = require('../cli/lib/args');
    eq(parseArgs(['--input', 'a=1', '--input=b=2', 'x'], { input: 'list' }), { flags: { input: ['a=1', 'b=2'] }, positionals: ['x'] });
  });

  test('subagents: an agent names the ones it may start, and the guard holds each to its own grants', () => {
    const def = wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { subagents: ['scout'] }, scout: { mcp: ['tickets'] } } }, 'wf');
    eq(def.grants.scout.mcp, ['tickets'], 'a subagent named in agents: can be given things too');
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: { 'issue-to-pr': { subagents: ['issue-to-pr'] } } }, 'wf'), /cannot be its own subagent/);
    throws(() => wfMod.validateDefinition(withStep({ subagents: ['x'] }), 'wf'), /a step does not carry subagents/);
    const deps = { agents: { 'issue-to-pr': {
      capabilities: { skills: [], tools: ['Read', 'Grep', 'Agent'], mcp: ['tickets'], subagents: ['scout'] },
      subagentDefs: { scout: { capabilities: { skills: [], tools: ['Read'], mcp: [], subagents: [] } } },
    } } };
    const main = wfMod.stepAccess(def, deps, 'a');
    eq([wfMod.subagentGranted(main, 'scout'), wfMod.subagentGranted(main, 'general-purpose'), wfMod.subagentGranted(main, undefined)], [true, false, false]);
    eq(wfMod.toolGranted(main, 'mcp__tickets__get'), true);
    const scout = wfMod.stepAccess(def, deps, 'a', { subagent: 'scout' });
    eq(['Read', 'Grep', 'mcp__tickets__get', 'Agent'].map((t) => wfMod.toolGranted(scout, t)), [true, false, false, false], 'the subagent has its own, smaller grant');
    eq(scout.writable, ['src/**'], 'and writes where its step may');
    const other = wfMod.stepAccess(def, deps, 'a', { subagent: 'general-purpose' });
    ok(/not one agent issue-to-pr may start/.test(other.refused), other.refused);
    eq(wfMod.toolGranted(other, 'Read'), false, 'a subagent the agent may not start may call nothing');
    // An agent that names no subagents: any, sharing its grants (as before).
    const open = { agents: { 'issue-to-pr': { capabilities: { skills: [], tools: null, mcp: [], subagents: [] }, subagentDefs: {} } } };
    const free = wfMod.stepAccess(wfMod.validateDefinition(GOOD, 'wf'), open, 'a', { subagent: 'Explore' });
    eq([wfMod.subagentGranted(free, 'Explore'), wfMod.toolGranted(free, 'Bash'), !!free.refused], [true, true, false]);
  });

  test('an until agent writes nothing and uses its own grants; its verdict is the last VERDICT line', () => {
    const def = wfMod.validateDefinition(withStep({ until: { agent: 'reviewer', prompt: 'check' } }), 'wf');
    const deps = { agents: {
      'issue-to-pr': { capabilities: { skills: [], tools: ['Read', 'Edit'], mcp: [] } },
      reviewer: { capabilities: { skills: [], tools: ['Read', 'Grep'], mcp: ['tickets'] } },
    } };
    const own = wfMod.stepAccess(def, deps, 'a');
    eq([own.agent, own.writable, own.tools], ['issue-to-pr', ['src/**'], ['Read', 'Edit']]);
    const judge = wfMod.stepAccess(def, deps, wfMod.untilStepId('a'));
    eq([judge.agent, judge.writable, judge.tools, judge.mcp], ['reviewer', [], ['Read', 'Grep'], ['tickets']]);
    eq(wfMod.stepAccess(wfMod.validateDefinition(GOOD, 'wf'), deps, 'a:until'), null, 'a step without an until agent has no :until');
    eq(wfMod.parseVerdict('looks fine\nVERDICT: PASS'), 'PASS');
    eq(wfMod.parseVerdict('VERDICT: PASS\nno, wait\n  verdict: fail  \n'), 'FAIL', 'the last one counts');
    eq(wfMod.parseVerdict('I would say VERDICT: PASS here'), null, 'only a line of its own');
    eq(wfMod.parseVerdict(''), null);
  });

  test('the kit ships machinery agents only; a development agent is neither bundled nor resolved', () => {
    const kit = wfMod.resolveAgent(os.tmpdir(), KIT_ROOT, 'workflow-creator');
    eq(kit && kit.source, 'kit');
    eq(wfMod.resolveAgent(os.tmpdir(), KIT_ROOT, 'issue-to-pr'), null, 'implementation agents are the package\'s own');
    throws(() => wfMod.resolveDependencies(os.tmpdir(), KIT_ROOT, wfMod.validateDefinition(GOOD, 'wf')), /neither in \.aidev\/agents\/ nor bundled/);
  });

  // -------------------------------------------------- new / list / approval
  suite('workflow: new, list and approval by origin/main');

  {
    const fx = makeRepo({ hosting: 'generic' });
    try {
      test('create scaffolds a workflow, an agent and a skill; the workflow points at the agent', () => {
        const r = aidev(fx.root, ['create', 'workflow', 'scaffold', '--json']);
        eq(r.code, 0, r.out);
        ok(fs.existsSync(path.join(fx.root, '.aidev', 'workflows', 'scaffold', 'workflow.yaml')));
        const a = aidev(fx.root, ['create', 'agent', 'my-agent', '--json']);
        eq(a.code, 0, a.out);
        const agentText = fs.readFileSync(path.join(fx.root, '.aidev', 'agents', 'my-agent.md'), 'utf8');
        ok(/^---\nname: my-agent\n/.test(agentText), agentText.slice(0, 60));
        const s = aidev(fx.root, ['create', 'skill', 'my-skill', '--json']);
        eq(s.code, 0, s.out);
        ok(fs.existsSync(path.join(fx.root, '.aidev', 'skills', 'my-skill', 'SKILL.md')));
        eq(aidev(fx.root, ['create', 'agent', 'my-agent']).code, 1, 'refuses to overwrite without --force');
        ok(/not available for skills/.test(aidev(fx.root, ['create', 'skill', 'x', '--describe', 'y']).out), 'skills are written by people');
        const def = wfMod.loadDefinition(fx.root, 'scaffold');
        eq(def.agents, ['my-agent'], 'the template references the agent a team creates next');
        eq(wfMod.resolveDependencies(fx.root, KIT_ROOT, def).agents['my-agent'].source, 'pkg');
      });

      test('list reports each workflow against origin/main, and agents / skills with their source', () => {
        const r = aidev(fx.root, ['list', 'workflows', '--json']);
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.ref, 'origin/main');
        eq(j.workflows.find((w) => w.name === 'scaffold').status, 'not on origin/main', 'the scaffold validates as written');
        const agents = lastJson(aidev(fx.root, ['list', 'agents', '--json']).out).agents;
        eq(agents.find((x) => x.name === 'my-agent').source, 'pkg');
        eq(agents.find((x) => x.name === 'workflow-creator').source, 'kit');
        ok(!agents.some((x) => x.name === 'issue-to-pr'), 'no development agent is bundled');
        const skills = lastJson(aidev(fx.root, ['list', 'skills', '--json']).out).skills;
        eq(skills.find((x) => x.name === 'my-skill').source, 'pkg');
        eq(skills.find((x) => x.name === 'test-and-verify').source, 'kit');
      });

      test('run refuses a workflow that is not on origin/main, and one edited since', () => {
        const r = aidev(fx.root, ['run', 'workflow', 'scaffold', '--json']);
        eq(r.code, 1);
        ok(/not approved/.test(r.out) && /not on origin\/main yet/.test(r.out), r.out);
        approve(fx);
        const dry = aidev(fx.root, ['run', 'workflow', 'scaffold', '--dry-run']);
        eq(dry.code, 0, dry.out);
        ok(/approved\s+yes \(matches origin\/main/.test(dry.out), dry.out);
        fs.appendFileSync(path.join(fx.root, '.aidev', 'workflows', 'scaffold', 'workflow.yaml'), '# edited\n');
        const changed = aidev(fx.root, ['run', 'workflow', 'scaffold', '--json']);
        eq(changed.code, 1);
        ok(/differs from origin\/main/.test(changed.out), changed.out);
        eq(lastJson(aidev(fx.root, ['list', 'workflows', '--json']).out).workflows.find((w) => w.name === 'scaffold').status, 'changed since origin/main');
        git(['checkout', '-q', '--', '.aidev/workflows/scaffold/workflow.yaml'], fx.root);
      });

      test('remove refuses an agent a workflow still references, and deletes an unreferenced one', () => {
        const r = aidev(fx.root, ['remove', 'agent', 'my-agent']);
        eq(r.code, 1);
        ok(/referenced by workflow\(s\) scaffold/.test(r.out), r.out);
        eq(aidev(fx.root, ['remove', 'skill', 'my-skill', '--json']).code, 0);
        ok(!fs.existsSync(path.join(fx.root, '.aidev', 'skills', 'my-skill')), 'skill removed');
        ok(/no such skill/.test(aidev(fx.root, ['remove', 'skill', 'my-skill']).out));
      });

      test('a PKG-local agent referenced by the workflow is part of what must match origin/main', () => {
        write(path.join(fx.root, '.aidev', 'workflows', 'local', 'workflow.yaml'),
          yamlOf('local', { steps: ['  - id: a', '    agent: my-agent', '    prompt: hi'] }));
        write(path.join(fx.root, '.aidev', 'agents', 'my-agent.md'), '---\nname: my-agent\ndescription: local\n---\n\nBe local.\n');
        approve(fx, 'add local workflow');
        eq(lastJson(aidev(fx.root, ['list', 'workflows', '--json']).out).workflows.find((w) => w.name === 'local').status, 'approved');
        fs.appendFileSync(path.join(fx.root, '.aidev', 'agents', 'my-agent.md'), 'Be different.\n');
        const r = aidev(fx.root, ['run', 'workflow', 'local', '--json']);
        eq(r.code, 1);
        ok(/\.aidev\/agents\/my-agent\.md differs from origin\/main/.test(r.out), r.out);
        git(['checkout', '-q', '--', '.aidev/agents/my-agent.md'], fx.root);
        const unknown = aidev(fx.root, ['create', 'workflow', 'ghost', '--force']);
        eq(unknown.code, 0, unknown.out);
        write(path.join(fx.root, '.aidev', 'workflows', 'ghost', 'workflow.yaml'),
          yamlOf('ghost', { steps: ['  - id: a', '    agent: nobody', '    prompt: hi'] }));
        ok(/neither in \.aidev\/agents\/ nor bundled/.test(aidev(fx.root, ['run', 'workflow', 'ghost']).out));
        eq(aidev(fx.root, ['remove', 'workflow', 'ghost', '--json']).code, 0);
        ok(!fs.existsSync(path.join(fx.root, '.aidev', 'workflows', 'ghost')), 'workflow removed');
      });

      test('submit puts the workflow on its own branch and pushes it; a merge approves it', () => {
        write(path.join(fx.root, '.aidev', 'workflows', 'sub', 'workflow.yaml'),
          yamlOf('sub', { steps: ['  - id: a', '    agent: my-agent', '    prompt: hi'] }));
        const dry = aidev(fx.root, ['submit', 'workflow', 'sub', '--dry-run']);
        eq(dry.code, 0, dry.out);
        ok(/aidev\/workflow-sub/.test(dry.out) && /missing/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['submit', 'workflow', 'sub', '--json']);
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.branch, j.committed, j.pushed, j.pr.attempted], ['aidev/workflow-sub', true, true, false]);
        ok(/open the pull request by hand/.test(r.out), r.out);
        ok(git(['ls-remote', '--heads', 'origin', 'aidev/workflow-sub'], fx.root).includes('aidev/workflow-sub'), 'pushed');
        eq(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.root), 'aidev/workflow-sub', 'the submitter is left on the branch');
        // The reviewer merges through the hosting service; here the author clone plays that role.
        git(['fetch', '-q', 'origin'], fx.pkgOrigin);
        git(['merge', '-q', '--ff-only', 'origin/aidev/workflow-sub'], fx.pkgOrigin);
        git(['push', '-q', 'origin', 'main'], fx.pkgOrigin);
        eq(lastJson(aidev(fx.root, ['list', 'workflows', '--json']).out).workflows.find((w) => w.name === 'sub').status, 'not on origin/main', 'until fetched');
        git(['fetch', '-q', 'origin'], fx.root);
        eq(lastJson(aidev(fx.root, ['list', 'workflows', '--json']).out).workflows.find((w) => w.name === 'sub').status, 'approved');
        const already = aidev(fx.root, ['submit', 'workflow', 'sub']);
        ok(/already matches origin\/main/.test(already.out), already.out);
        git(['checkout', '-q', 'main'], fx.root);
        git(['merge', '-q', '--ff-only', 'origin/main'], fx.root);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------------------------------ run
  suite('workflow: run');

  {
    // The estimate reviewer is tested on its own; here it would add starts to every count.
    const fx = makeRepo({ hosting: 'generic', configExtra: ['estimates:', '  review: off'] });
    const tmp = stubDir();
    const stub = writeToolStub(tmp);
    const argvOut = path.join(tmp, 'argv.json');
    const promptOut = path.join(tmp, 'prompt.txt');
    const envOut = path.join(tmp, 'env.json');
    const env = (extra = {}) => ({ AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut, STUB_ENV_OUT: envOut, ...extra });
    const reset = () => { for (const f of [argvOut, promptOut, envOut]) fs.rmSync(f, { force: true }); };
    const define = (name, opts) => {
      write(path.join(fx.root, '.aidev', 'workflows', name, 'workflow.yaml'), yamlOf(name, opts));
      approve(fx, `workflow ${name}`);
    };
    // Runs work in a worktree of their own, on aidev/<name> unless --dated.
    const runtreeMod = require('../cli/lib/runtree');
    const wtOf = (branch) => { const w = runtreeMod.listWorktrees(fx.root).find((x) => x.branch === branch); return w ? w.path : null; };
    const runsDirOf = (name, branch = `aidev/${name}`) => path.join(wtOf(branch), '.aidev', 'workflows', name, 'runs');
    const runsOf = (name, branch) => fs.readdirSync(runsDirOf(name, branch)).sort();
    // The package's own development agent: the kit ships none.
    write(path.join(fx.root, '.aidev', 'agents', 'coder.md'), '---\nname: coder\ndescription: writes code for tests\n---\n\nYou are the coder.\n');
    try {
      test('the steps run in order through the configured tool with the agent definition inlined', () => {
        define('plain', { steps: [
          '  - id: think', '    agent: coder', '    writable: []', '    prompt: think first',
          '  - id: check', '    command: node --version',
          '  - id: act', '    agent: coder', '    prompt: now act', '    until:', '      command: node --version',
        ] });
        reset();
        const r = aidev(fx.root, ['run', 'workflow', 'plain', '--task', 'add a login link', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.done, j.agentRuns, j.costUsd, j.task], [true, 2, 0.0246, 'add a login link']);
        eq(j.steps.map((s) => [s.id, s.ok, s.attempts]), [['think', true, 1], ['check', true, 1], ['act', true, 1]]);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        ok(!a.includes('--agent'), 'the definition is inlined, so no --agent flag: ' + a.join(' '));
        ok(a.includes('--strict-mcp-config') && a.includes('--mcp-config'), 'an agent that names no MCP server gets none: ' + a.join(' '));
        ok(!a.includes('--tools') && !a.includes('--allowedTools'), 'no tools listed: the tool\'s default set');
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        eq(prompts.length, 2);
        ok(/# Agent: coder/.test(prompts[0]) && /You are the coder\./.test(prompts[0]), 'the PKG agent definition is inlined');
        ok(/## Objective\n\nMake the thing work\./.test(prompts[0]), prompts[0].slice(0, 400));
        ok(/## Task for this run[\s\S]*add a login link/.test(prompts[0]), 'the task is handed over as data');
        ok(/## Step think \(1\/3\)\n\nthink first/.test(prompts[0]));
        ok(/Write only under: \(nothing — this step writes no files\)/.test(prompts[0]), 'the step\'s own writable is stated');
        ok(!/## Reports from the earlier steps/.test(prompts[0]), 'the first step has nothing to build on');
        ok(/Do not run git commit or git push\. The workflow commits this step's changes on its own branch/.test(prompts[0]), 'the kit commits, not the agent');
        ok(/## Step act \(3\/3\)/.test(prompts[1]) && /node --version` must exit 0/.test(prompts[1]));
        ok(/Write only under: src\/\*\*/.test(prompts[1]), prompts[1]);
        ok(/## Reports from the earlier steps[\s\S]*### Step think \(agent coder\)\n\nstub answer/.test(prompts[1]),
          'the next agent step sees the report of the one before');
        eq(JSON.parse(fs.readFileSync(envOut, 'utf8')), { AIDEV_WORKFLOW: 'plain', AIDEV_WORKFLOW_STEP: 'act' },
          'the write guard learns the workflow and the step from the environment');
        const record = JSON.parse(fs.readFileSync(path.join(runsDirOf('plain'), runsOf('plain')[0], 'run.json'), 'utf8'));
        eq([record.name, record.done, record.approvedRef, record.branch], ['plain', true, 'origin/main', 'aidev/plain']);
        eq([j.worktree, record.worktree], [wtOf('aidev/plain'), wtOf('aidev/plain')], 'the run worked in the worktree of its branch');
        ok(!j.worktree.startsWith(fx.root), 'outside the checkout');
        eq(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.root), 'main', 'the checkout was not touched');
        ok(/^sha256:/.test(record.hash));
        eq(record.calls.map((c) => [c.step, c.role, c.agent, c.attempt, c.ok, c.costUsd]), [['think', 'agent', 'coder', 1, true, 0.0123], ['act', 'agent', 'coder', 1, true, 0.0123]],
          'every agent start is recorded with what it cost, for the next estimate');
      });

      test('estimate prices a run from the definition and from the recorded runs; dry-run shows the range', () => {
        const r = aidev(fx.root, ['estimate', 'workflow', 'plain', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.history.starts >= 2, true, 'the run above was recorded');
        eq(j.steps.map((s) => [s.id, s.kind, s.starts]), [['think', 'agent', [1, 1]], ['check', 'command', [0, 0]], ['act', 'agent', [1, 4]]],
          'act: one start when the check passes first time, four when all three retries are used');
        ok(/history of this step \(1\)/.test(j.steps[0].basis), j.steps[0].basis);
        eq(j.steps[0].perStart.agent, [0.0062, 0.0246], 'one sample: the observed cost, widened (x0.5, x2)');
        eq([j.optimistic, j.pessimistic], [0.01, 0.12], 'think 0.0062 + act 0.0062 .. think 0.0246 + 4 x act 0.0246');
        eq(runsOf('plain').length, 1, 'estimate starts no run');
        const dry = aidev(fx.root, ['run', 'workflow', 'plain', '--dry-run'], { env: env() });
        ok(/cost\s+\$0\.01 – \$0\.12 \(optimistic – pessimistic/.test(dry.out), dry.out);
      });

      test('estimate --ai asks the read-only cost-estimator, and its sizes and targets narrow the range', () => {
        reset();
        const answer = 'Sized it.\n```json\n{"steps":[{"id":"act","size":"L","attempts":{"high":2},"why":"two files"}],"notes":"small task"}\n```';
        const r = aidev(fx.root, ['estimate', 'workflow', 'plain', '--ai', '--task', 'one link', '--json'], { env: env({ STUB_ANSWER: answer }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.ai, j.estimator.ok, j.estimator.answer.notes], [true, true, 'small task']);
        const act = j.steps.find((s) => s.id === 'act');
        eq([act.starts, act.why], [[1, 2], 'two files'], 'the estimator expects two attempts at worst');
        ok(/history of this step/.test(act.basis), 'recorded costs still price one start; the size is the fallback');
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        eq(a.slice(a.indexOf('--tools') + 1), ['Read', 'Glob', 'Grep'], 'the estimator reads and writes nothing');
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(/# Agent: cost-estimator/.test(prompt) && /## Task for this run[\s\S]*one link/.test(prompt), prompt.slice(0, 300));
        ok(/## What earlier runs recorded\n\n- think: agent 1 start\(s\)/.test(prompt), 'the estimator sees the history');
        const bad = aidev(fx.root, ['estimate', 'workflow', 'plain', '--ai', '--json'], { env: env({ STUB_ANSWER: 'no idea' }) });
        eq(bad.code, 0, 'an unusable answer falls back to the definition');
        eq([lastJson(bad.out).estimator.ok, lastJson(bad.out).estimator.reason], [false, 'its answer had no JSON block to read']);
        eq(lastJson(bad.out).ai, true, 'the judgment of the answer before is kept for this definition');
        const kept = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'estimates', 'judgments', 'plain.json'), 'utf8'));
        eq(kept.steps.find((s) => s.id === 'act').size, 'L', 'the estimator sizes are kept (not its attempts or targets)');
        fs.rmSync(path.join(fx.root, '.aidev', 'estimates'), { recursive: true, force: true });
      });

      test('an until command that keeps failing with the same output stops the step early', () => {
        define('loop', { steps: [
          '  - id: fix', '    agent: coder', '    prompt: fix it', '    until:', '      command: node -e process.exit(3)', '      max_retries: 5',
        ] });
        reset();
        const r = aidev(fx.root, ['run', 'workflow', 'loop', '--json'], { env: env() });
        eq(r.code, 1, r.out);
        const j = lastJson(r.out);
        eq(j.done, false);
        ok(/same failure repeated/.test(j.stopReason), j.stopReason);
        eq(j.agentRuns, 2, 'two identical failures, not six');
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/## Previous attempt 1 of 6 failed/.test(prompts[1]) && /exited 3/.test(prompts[1]), 'the second attempt sees the failure');
      });

      test('an until agent checks the work after the command passes; FAIL sends its report back to the step', () => {
        write(path.join(fx.root, '.aidev', 'agents', 'reviewer.md'),
          '---\nname: reviewer\ndescription: reviews tests\ntools: Read, Grep\n---\n\nYou review tests.\n');
        define('reviewed', { steps: [
          '  - id: write', '    agent: coder', '    prompt: write the tests',
          '    until:', '      command: node --version', '      agent: reviewer', '      prompt: Check that the tests cover the edge cases.',
          '      max_retries: 3',
        ] });
        const stepsOut = path.join(tmp, 'steps.txt');
        const verdicts = path.join(tmp, 'verdicts.json');
        reset();
        fs.rmSync(stepsOut, { force: true });
        fs.writeFileSync(verdicts, JSON.stringify(['FAIL', 'PASS']));
        const dry = aidev(fx.root, ['run', 'workflow', 'reviewed', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/repeats until node --version exits 0 and agent reviewer answers PASS \(max 3 retries\)/.test(dry.out), dry.out);
        ok(/checked by agent reviewer \(writes nothing; skills: \(none\); tools: Read, Grep; mcp: \(none\)\): Check that the tests/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'reviewed', '--json'], { env: env({ STUB_STEPS_OUT: stepsOut, STUB_VERDICTS: verdicts }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.done, j.agentRuns], [true, 4], 'coder, reviewer (FAIL), coder, reviewer (PASS)');
        eq([j.steps[0].ok, j.steps[0].attempts], [true, 2]);
        ok(/VERDICT: PASS/.test(j.steps[0].review), JSON.stringify(j.steps[0]));
        eq(fs.readFileSync(stepsOut, 'utf8').trim().split('\n'), ['write', 'write:until', 'write', 'write:until'],
          'the reviewer runs as <step>:until, which the guard gives nothing to write');
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        eq(prompts.length, 4);
        ok(/`node --version` must exit 0, and the reviewer agent must pass the work against this check: Check that the tests cover/.test(prompts[0]),
          'the step\'s agent knows both checks up front');
        ok(/# Agent: reviewer/.test(prompts[1]) && /You review tests\./.test(prompts[1]), 'the reviewer runs with its own definition');
        ok(/### What it reported[\s\S]*stub answer/.test(prompts[1]), 'the reviewer sees what the step\'s agent reported');
        ok(/`node --version` has already exited 0/.test(prompts[1]));
        ok(/## Your check\n\nCheck that the tests cover the edge cases\./.test(prompts[1]));
        ok(/`VERDICT: PASS` or `VERDICT: FAIL`/.test(prompts[1]));
        ok(/## Previous attempt 1 of 4 failed[\s\S]*reviewer agent checked the work and did not pass it[\s\S]*test for empty input is missing/.test(prompts[2]),
          'the step\'s next attempt gets the reviewer\'s report');
      });

      test('the until agent is not started while the command fails, and a missing verdict counts as FAIL', () => {
        define('gated', { steps: [
          '  - id: write', '    agent: coder', '    prompt: write',
          '    until:', '      command: node -e process.exit(3)', '      agent: reviewer', '      prompt: check',
        ] });
        const stepsOut = path.join(tmp, 'steps.txt');
        reset();
        fs.rmSync(stepsOut, { force: true });
        const g = aidev(fx.root, ['run', 'workflow', 'gated', '--json'], { env: env({ STUB_STEPS_OUT: stepsOut }) });
        eq(g.code, 1, g.out);
        eq(fs.readFileSync(stepsOut, 'utf8').trim().split('\n'), ['write', 'write'], 'no reviewer run');
        ok(/same failure repeated \(node -e process\.exit\(3\) exited 3/.test(lastJson(g.out).stopReason), lastJson(g.out).stopReason);

        define('silent', { steps: [
          '  - id: write', '    agent: coder', '    prompt: write',
          '    until:', '      agent: reviewer', '      prompt: check',
        ] });
        reset();
        const s = aidev(fx.root, ['run', 'workflow', 'silent', '--json'], { env: env() });
        eq(s.code, 1, s.out);
        const j = lastJson(s.out);
        eq(j.agentRuns, 4, 'the reviewer gave no verdict twice with the same report');
        ok(/same failure repeated \(reviewer answered no verdict/.test(j.stopReason), j.stopReason);
      });

      test('the cost budget stops the workflow before another agent starts', () => {
        define('budget', { cost: 0.02, steps: [
          '  - id: one', '    agent: coder', '    prompt: a',
          '  - id: two', '    agent: coder', '    prompt: b',
          '  - id: three', '    agent: coder', '    prompt: c',
        ] });
        const r = aidev(fx.root, ['run', 'workflow', 'budget', '--json'], { env: env() });
        eq(r.code, 1, r.out);
        const j = lastJson(r.out);
        ok(/cost limit of \$0\.02 reached/.test(j.stopReason), j.stopReason);
        eq(j.agentRuns, 2, 'two runs fit under $0.02, the third was refused');
      });

      test('a failing agent, a failing command step and a tool outside tools.default each stop the run', () => {
        define('cmd', { steps: ['  - id: c', '    command: node -e process.exit(7)'] });
        const c = aidev(fx.root, ['run', 'workflow', 'cmd', '--json'], { env: env() });
        eq(c.code, 1);
        ok(/exited 7/.test(lastJson(c.out).stopReason), c.out);
        define('tool', { extra: ['tool: copilot'], steps: ['  - id: a', '    agent: coder', '    prompt: hi'] });
        reset();
        const t = aidev(fx.root, ['run', 'workflow', 'tool', '--json'], { env: env() });
        eq(t.code, 1);
        ok(/not listed in tools\.default/.test(t.out), t.out);
        ok(!fs.existsSync(argvOut), 'nothing was started');
        const f = aidev(fx.root, ['run', 'workflow', 'plain', '--json'], { env: env({ STUB_MODE: 'fail' }) });
        eq(f.code, 1);
        ok(/step think: stub: refused/.test(lastJson(f.out).stopReason), f.out);
      });

      test('a command step reaches a .cmd shim on PATH whose directory has a space (npm on Windows)', () => {
        if (process.platform !== 'win32') return;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev shim dir '));
        try {
          const seen = path.join(dir, 'seen.txt');
          // Beside the shim sits an extensionless file, as `npm` sits beside `npm.cmd`.
          fs.writeFileSync(path.join(dir, 'faketool'), '#!/bin/sh\nexit 1\n');
          fs.writeFileSync(path.join(dir, 'faketool.cmd'), ['@echo off', `echo %*> "${seen}"`, ''].join('\r\n'));
          const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
          define('shim', { steps: ['  - id: c', '    command: faketool run --workspace=packages/backend'] });
          const r = aidev(fx.root, ['run', 'workflow', 'shim', '--json'],
            { env: env({ [pathKey]: `${dir};${process.env[pathKey]}` }) });
          eq(r.code, 0, r.out);
          ok(/run/.test(fs.readFileSync(seen, 'utf8')) && /--workspace=packages\/backend/.test(fs.readFileSync(seen, 'utf8')),
            `the shim did not receive its arguments: ${fs.readFileSync(seen, 'utf8')}`);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      test('a human-mode run shows each tool call as it streams in, subagent calls indented', () => {
        define('watched', { steps: ['  - id: a', '    agent: coder', '    prompt: hi'] });
        reset();
        const r = aidev(fx.root, ['run', 'workflow', 'watched'], { env: env() });
        eq(r.code, 0, r.out);
        ok(/^ {5}\d:\d\d  Read stub-read\.md$/m.test(r.out), `no progress line for the Read call:\n${r.out}`);
        ok(/^ {5}\d:\d\d    Glob stub\/\*\*$/m.test(r.out), `the subagent call is not indented:\n${r.out}`);
        const j = aidev(fx.root, ['run', 'workflow', 'watched', '--json'], { env: env() });
        ok(!/Read stub-read/.test(j.out), '--json prints no progress lines');
      });

      test('a run works in its own worktree on aidev/<name>, commits a checkpoint per step, and the pull-request step pushes the branch', () => {
        write(path.join(fx.root, 'tools', 'touch.js'),
          "require('fs').mkdirSync('src/gen', { recursive: true }); require('fs').writeFileSync('src/gen/out.txt', (process.env.OUT || 'made') + '\\n'); require('fs').writeFileSync('notes.txt', 'outside\\n');\n");
        define('pr', { steps: [
          '  - id: make', '    command: node tools/touch.js', '    writable: [src/**]',
          '  - id: pr', '    pull_request:', '      title: "aidev: generated"',
        ] });
        // The person's own uncommitted work is none of the run's business.
        write(path.join(fx.root, 'dirty.txt'), 'x\n');
        const r = aidev(fx.root, ['run', 'workflow', 'pr', '--task', 'make it', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.branch, 'aidev/pr', 'one branch per workflow');
        const wt = j.worktree;
        eq(wt, wtOf('aidev/pr'));
        eq([git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.root), fs.existsSync(path.join(fx.root, 'dirty.txt')), fs.existsSync(path.join(fx.root, 'src', 'gen', 'out.txt'))],
          ['main', true, false], 'the checkout stays as it was');
        eq(j.pr.ok, false, 'generic hosting: the PR is not created');
        ok(/by hand/.test(j.pr.reason), j.pr.reason);
        const make = j.steps.find((s) => s.id === 'make');
        const pr = j.steps.find((s) => s.id === 'pr');
        ok(make.checkpoint && pr.ok && pr.pushed && pr.sha, JSON.stringify(j.steps));
        eq(git(['log', '-1', '--format=%s', make.checkpoint], wt), 'aidev(pr): make', 'the step\'s checkpoint');
        ok(git(['log', '-1', '--format=%B', make.checkpoint], wt).includes(`Aidev-Run: ${j.runId}`), 'it names the run');
        eq(git(['show', '--name-only', '--format=', make.checkpoint], wt), 'src/gen/out.txt', 'only what the step may write');
        ok(git(['status', '--porcelain'], wt).includes('notes.txt'), 'a file outside the scope is left uncommitted');
        ok(git(['log', '-1', '--format=%B'], wt).includes('aidev: generated') && git(['log', '-1', '--format=%B'], wt).includes('task:'), 'the last commit carries the run record');
        ok(git(['ls-remote', '--heads', 'origin', 'aidev/pr'], fx.root).includes('aidev/pr'), 'pushed to origin');
        ok(fs.existsSync(path.join(runsDirOf('pr'), j.runId, 'run.json')), 'the record is in the worktree');

        // The next run works on the same branch and worktree, on top of the last.
        const again = aidev(fx.root, ['run', 'workflow', 'pr', '--json'], { env: env({ OUT: 'made again' }) });
        eq(again.code, 0, again.out);
        const j2 = lastJson(again.out);
        eq([j2.branch, j2.worktree], ['aidev/pr', wt]);
        ok(git(['merge-base', '--is-ancestor', make.checkpoint, 'HEAD'], wt) === '' , 'the first run\'s checkpoint is still on the branch');
        eq(fs.readFileSync(path.join(wt, 'src', 'gen', 'out.txt'), 'utf8'), 'made again\n');
        eq(runsOf('pr').length, 2);
        // A step's work left uncommitted in the worktree stops a new run: it is a stopped run's, to resume or to throw away.
        write(path.join(wt, 'src', 'gen', 'out.txt'), 'half done\n');
        const dirty = aidev(fx.root, ['run', 'workflow', 'pr', '--json'], { env: env() });
        eq(dirty.code, 1, dirty.out);
        ok(/has uncommitted changes, left by a run that stopped[\s\S]*--resume last/.test(dirty.out), dirty.out);
        git(['checkout', '--', 'src/gen/out.txt'], wt);
        // --dated: a branch and a worktree of its own.
        const dated = aidev(fx.root, ['run', 'workflow', 'pr', '--dated', '--json'], { env: env() });
        eq(dated.code, 0, dated.out);
        const jd = lastJson(dated.out);
        ok(/^aidev\/pr-\d{12}$/.test(jd.branch) && jd.worktree !== wt && jd.worktree === wtOf(jd.branch), JSON.stringify([jd.branch, jd.worktree]));
        fs.rmSync(path.join(fx.root, 'dirty.txt'), { force: true });
        // Nothing inside the scope changes on a run whose steps write nothing: no commit, no branch pushed.
        define('quiet', { steps: ['  - id: noop', '    command: node --version', '  - id: pr', '    pull_request: {}'] });
        const none = aidev(fx.root, ['run', 'workflow', 'quiet', '--json'], { env: env() });
        eq(none.code, 0, none.out);
        const q = lastJson(none.out);
        eq([q.done, q.pr, q.steps[1].skipped], [true, null, true]);
        ok(!git(['ls-remote', '--heads', 'origin', q.branch], fx.root).includes(q.branch), 'no push without a commit');
      });

      test('the workflow\'s branch follows the base: moved when merged, merged when ahead; one run per worktree at a time; a removed worktree is made again', () => {
        const wt = wtOf('aidev/pr');
        const run = (extra = {}) => aidev(fx.root, ['run', 'workflow', 'pr', '--json'], { env: env(extra) });
        // A run already going in the worktree keeps the next one out; a lock whose process is gone does not.
        const lockFile = runtreeMod.lockPath(wt);
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, runId: 'other' }));
        const busy = run();
        eq(busy.code, 1, busy.out);
        ok(/another run \(other, process \d+\) is working in/.test(busy.out), busy.out);
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999999, runId: 'gone' }));
        eq(run({ OUT: 'after a stale lock' }).code, 0);
        ok(!fs.existsSync(lockFile), 'the lock is let go when the run ends');
        // The branch's work was merged: the next run starts from the base again.
        git(['merge', '-q', '--no-edit', 'aidev/pr'], fx.root);
        write(path.join(fx.root, 'later.txt'), 'later\n');
        git(['add', 'later.txt'], fx.root);
        git(['commit', '-q', '-m', 'later work on main'], fx.root);
        const moved = lastJson(run({ OUT: 'after the merge' }).out);
        eq([moved.ok, moved.worktreeSync], [true, 'moved']);
        ok(fs.existsSync(path.join(wt, 'later.txt')), 'the worktree is at the base');
        // The branch has work the base does not, and the base moved on: the base is merged in.
        write(path.join(fx.root, 'later2.txt'), 'later\n');
        git(['add', 'later2.txt'], fx.root);
        git(['commit', '-q', '-m', 'more work on main'], fx.root);
        const merged = lastJson(run({ OUT: 'after a merge of main' }).out);
        eq([merged.ok, merged.worktreeSync], [true, 'merged']);
        ok(fs.existsSync(path.join(wt, 'later2.txt')) && git(['log', '--format=%s'], wt).includes(moved.steps[0].checkpoint ? 'aidev(pr): make' : 'aidev(pr)'), 'both lines of work are on the branch');
        // A worktree removed by hand is made again from the branch.
        git(['worktree', 'remove', '--force', wt], fx.root);
        const again = lastJson(run({ OUT: 'in a new worktree' }).out);
        eq([again.ok, again.worktree, again.worktreeSync], [true, wt, 'current']);
        ok(git(['log', '--format=%s'], wt).includes('aidev(pr): make'), 'with the branch\'s checkpoints');
      });

      test('a step\'s tool is started with only its agent\'s skills, tools and MCP servers', () => {
        const mcpOut = path.join(tmp, 'mcp.json');
        fs.rmSync(mcpOut, { force: true });
        write(path.join(fx.root, '.mcp.json'), JSON.stringify({ mcpServers: {
          tickets: { command: 'node', args: ['tickets.js'] },
          billing: { command: 'node', args: ['billing.js'] },
        } }, null, 2));
        write(path.join(fx.root, '.aidev', 'agents', 'limited.md'),
          '---\nname: limited\ndescription: reads tickets\nskills: [test-and-verify]\ntools: Read, Grep\nmcp: [tickets]\n---\n\nYou read tickets.\n');
        define('granted', { steps: ['  - id: look', '    agent: limited', '    writable: []', '    prompt: read the ticket'] });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'granted', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/1\. look: agent limited\n\s+- writes: nothing\n\s+- skills: test-and-verify; tools: Read, Grep; mcp: tickets/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'granted', '--json'], { env: env({ STUB_MCP_OUT: mcpOut }) });
        eq(r.code, 0, r.out);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        const at = a.indexOf('--mcp-config');
        ok(at >= 0 && a[at + 2] === '--strict-mcp-config', a.join(' '));
        eq(a.slice(a.indexOf('--allowedTools'), a.indexOf('--allowedTools') + 2), ['--allowedTools', 'mcp__tickets'], 'the granted server is pre-approved');
        eq(a.slice(a.indexOf('--tools')), ['--tools', 'Read', 'Grep'], 'only the listed built-in tools, last');
        eq(Object.keys(JSON.parse(fs.readFileSync(mcpOut, 'utf8')).mcpServers), ['tickets'], 'billing is not handed over');
        ok(!fs.existsSync(a[at + 1]), 'the MCP file is removed after the step');
        ok(!a[at + 1].startsWith(fx.root), 'the MCP file never lands in the repository');
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(/## Skill: test-and-verify/.test(prompt), 'the agent\'s skill is inlined');

        // An agent naming a server the PKG does not register is refused before anything starts.
        write(path.join(fx.root, '.aidev', 'agents', 'lost.md'), '---\nname: lost\ndescription: x\nmcp: [nowhere]\n---\n\nLost.\n');
        define('lost', { steps: ['  - id: a', '    agent: lost', '    prompt: hi'] });
        reset();
        const lostDry = aidev(fx.root, ['run', 'workflow', 'lost', '--dry-run'], { env: env() });
        eq(lostDry.code, 1, lostDry.out);
        ok(/MCP server nowhere, which \.mcp\.json does not register/.test(lostDry.out), lostDry.out);
        const lost = aidev(fx.root, ['run', 'workflow', 'lost', '--json'], { env: env() });
        eq(lost.code, 1);
        ok(/does not register/.test(lost.out), lost.out);
        ok(!fs.existsSync(argvOut), 'nothing was started');
      });

      test('what a workflow\'s agents: assigns reaches the tool, the prompt and the guard, on top of the frontmatter', () => {
        const mcpOut = path.join(tmp, 'mcp.json');
        fs.rmSync(mcpOut, { force: true });
        // `limited` (above) has skills: [test-and-verify], tools: Read, Grep, mcp: [tickets] of its own.
        define('assigned', {
          extra: ['agents:', '  limited:', '    skills: [code-review]', '    mcp: [billing]', '    tools: [Read, Edit]'],
          steps: ['  - id: look', '    agent: limited', '    writable: []', '    prompt: read the ticket'],
        });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'assigned', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/skills: test-and-verify, code-review; tools: Read, Edit; mcp: tickets, billing/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'assigned', '--json'], { env: env({ STUB_MCP_OUT: mcpOut }) });
        eq(r.code, 0, r.out);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        eq(a.slice(a.indexOf('--allowedTools'), a.indexOf('--allowedTools') + 2), ['--allowedTools', 'mcp__tickets,mcp__billing']);
        eq(a.slice(a.indexOf('--tools')), ['--tools', 'Read', 'Edit'], 'the workflow\'s tools replace the frontmatter\'s');
        eq(Object.keys(JSON.parse(fs.readFileSync(mcpOut, 'utf8')).mcpServers), ['tickets', 'billing']);
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(/## Skill: test-and-verify/.test(prompt) && /## Skill: code-review/.test(prompt), 'both skills are inlined');
        const def = wfMod.loadDefinition(fx.root, 'assigned');
        const deps = wfMod.resolveDependencies(fx.root, KIT_ROOT, def);
        const access = wfMod.stepAccess(def, deps, 'look');
        eq([wfMod.toolGranted(access, 'mcp__billing__charge'), wfMod.toolGranted(access, 'Edit'), wfMod.toolGranted(access, 'Grep')], [true, true, false],
          'the guard grants what the workflow assigns, and only the workflow\'s tools');
        eq(deps.agents.limited.ownCapabilities.mcp, ['tickets'], 'the frontmatter alone is kept apart');

        // A skill assigned by the workflow that exists nowhere is named against the workflow.
        define('assigned-lost', {
          extra: ['agents:', '  limited:', '    skills: [no-such-skill]'],
          steps: ['  - id: look', '    agent: limited', '    writable: []', '    prompt: read'],
        });
        const lostDry = aidev(fx.root, ['run', 'workflow', 'assigned-lost', '--dry-run'], { env: env() });
        eq(lostDry.code, 1, lostDry.out);
        ok(/assigned-lost\/workflow\.yaml: agents\.limited: skill no-such-skill is neither/.test(lostDry.out), lostDry.out);
      });

      test('a tool that cannot be limited is never started with limits, and submit shows each step\'s grants', () => {
        const agentMod = require('../cli/lib/agent');
        throws(() => agentMod.buildArgv({ tool: 'copilot', promptArg: 'P', capabilities: { tools: ['Read'], mcp: [], mcpConfigFile: 'x' } }),
          /cannot be limited to an agent's tools and MCP servers/);
        const def = wfMod.loadDefinition(fx.root, 'granted');
        const text = require('../cli/commands/workflow').submitDescription(def, wfMod.resolveDependencies(fx.root, KIT_ROOT, def), []);
        ok(/1\. `look`: agent `limited`\n {3}- writes: nothing\n {3}- skills: `test-and-verify`; tools: `Read`, `Grep`; mcp: `tickets`/.test(text), text);
      });

      test('until commands run in order, in cwd and with env; the whole output is kept in the run\'s logs', () => {
        // Fails the first time it is run, passes the second: what a fixed test suite looks like to the runner.
        write(path.join(fx.root, 'e2e', 'check.js'),
          "const fs = require('fs'); console.log('CI=' + process.env.CI + ' cwd=' + require('path').basename(process.cwd()));\n"
          + "if (fs.existsSync('seen.flag')) process.exit(0); fs.writeFileSync('seen.flag', ''); console.log('1 test failed'); process.exit(5);\n");
        define('cmds', { steps: [
          '  - id: fix', '    agent: coder', '    prompt: fix it',
          '    until:', '      command:', '        - node --version', '        - node check.js', '      cwd: e2e', '      env:', '        CI: 1',
        ] });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'cmds', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/repeats until node --version exits 0 and node check\.js exits 0 \(max 3 retries\) \(in e2e; env: CI=1\)/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'cmds', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        fs.rmSync(path.join(j.worktree, 'e2e', 'seen.flag'), { force: true });
        eq([j.done, j.steps[0].attempts], [true, 2]);
        const logRel = `.aidev/workflows/cmds/runs/${j.runId}/logs/fix.1.2.log`;
        eq(j.steps[0].log, logRel, 'the record names the log of the failed check');
        const logText = fs.readFileSync(path.join(j.worktree, logRel), 'utf8');
        ok(/^\$ node check\.js {3}\(in e2e\)\n/.test(logText) && /CI=1 cwd=e2e/.test(logText) && /1 test failed/.test(logText), logText);
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/`node --version` must exit 0 \(run in e2e\/\), and `node check\.js` must exit 0 \(run in e2e\/\)/.test(prompts[0]), prompts[0]);
        ok(/`node check\.js` exited 5\. Its output \(tail\):[\s\S]*CI=1 cwd=e2e[\s\S]*The whole output is in \.aidev\/workflows\/cmds\/runs\/[^ ]+\/logs\/fix\.1\.2\.log/.test(prompts[1]), prompts[1]);
      });

      test('a stopped run is resumed from the step it stopped at, with the reports and notes of the steps before', () => {
        write(path.join(fx.root, 'tools', 'gate.js'), "process.exit(require('fs').existsSync('gate.flag') ? 0 : 4);\n");
        define('long', { steps: [
          '  - id: plan', '    agent: coder', '    writable: []', '    prompt: plan it',
          '  - id: act', '    agent: coder', '    prompt: do it', '    until:', '      command: node tools/gate.js',
        ] });
        const stepsOut = path.join(tmp, 'steps.txt');
        reset();
        const first = aidev(fx.root, ['run', 'workflow', 'long', '--task', 'upgrade to 5', '--json'], { env: env() });
        eq(first.code, 1, first.out);
        const j1 = lastJson(first.out);
        ok(/same failure repeated/.test(j1.stopReason), j1.stopReason);
        eq([j1.done, j1.agentRuns, j1.steps.map((s) => s.ok)], [false, 3, [true, false]]);
        const runDir = path.join(j1.worktree, '.aidev', 'workflows', 'long', 'runs', j1.runId);
        eq(fs.readFileSync(path.join(runDir, 'reports', 'plan.md'), 'utf8').trim(), 'stub answer', 'each finished step\'s whole report is kept');
        ok(/step act: "node tools\/gate\.js" exited 4/.test(fs.readFileSync(path.join(runDir, 'log.txt'), 'utf8')), 'the log is written as the run goes');
        const before = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/## Notes of this run\n\nDirectory: \.aidev\/workflows\/long\/runs\/[^/]+\/notes\/ \(empty so far\)/.test(before[0]), before[0]);
        ok(/\(and the notes directory above\)/.test(before[0]), 'a step may write the notes even when it writes no PKG file');

        ok(/do not pass --task/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', 'last', '--task', 'x'], { env: env() }).out));
        ok(/takes a run id/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', '../x'], { env: env() }).out));
        // What the plan step would have left for the next one, and the fix that lets the check pass.
        write(path.join(runDir, 'notes', 'targets.md'), '- src/a.ts\n');
        write(path.join(j1.worktree, 'gate.flag'), '');
        // What the stopped step had written and not finished is put back on resume.
        write(path.join(j1.worktree, 'src', 'half-done.ts'), 'x\n');
        reset();
        fs.rmSync(stepsOut, { force: true });
        const dry = aidev(fx.root, ['run', 'workflow', 'long', '--resume', 'last', '--dry-run'], { env: env() });
        ok(/resume\s+run \S+, from step act/.test(dry.out), dry.out);
        const second = aidev(fx.root, ['run', 'workflow', 'long', '--resume', j1.runId, '--json'], { env: env({ STUB_STEPS_OUT: stepsOut }) });
        fs.rmSync(path.join(j1.worktree, 'gate.flag'), { force: true });
        eq(second.code, 0, second.out);
        const j2 = lastJson(second.out);
        eq(j2.worktree, j1.worktree, 'resumed in the run\'s worktree');
        ok(!fs.existsSync(path.join(j1.worktree, 'src', 'half-done.ts')), 'from the last checkpoint');
        eq([j2.runId, j2.done, j2.task, j2.agentRuns, j2.resumes.length], [j1.runId, true, 'upgrade to 5', 4, 1], 'one run, with the totals of both starts');
        eq(j2.steps.map((s) => [s.id, s.ok]), [['plan', true], ['act', true]]);
        eq(fs.readFileSync(stepsOut, 'utf8').trim().split('\n'), ['act'], 'the finished step is not run again');
        const after = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/### Step plan \(agent coder\)\n\nstub answer/.test(after[0]), 'the skipped step\'s report still reaches the next step');
        ok(/notes\/ \(files: targets\.md\)/.test(after[0]), after[0]);
        ok(/## Task for this run[\s\S]*upgrade to 5/.test(after[0]), 'the task is the one the run started with');
        ok(/## This run was resumed\n\nAn earlier start of this run stopped at this step: step act: the same failure repeated/.test(after[0]), after[0]);
        ok(/nothing to resume/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', 'last'], { env: env() }).out));

        // A workflow edited since the run started is a different workflow: no resume.
        const stopped = lastJson(aidev(fx.root, ['run', 'workflow', 'long', '--json'], { env: env() }).out);
        eq(stopped.done, false);
        fs.appendFileSync(path.join(fx.root, '.aidev', 'workflows', 'long', 'workflow.yaml'), '# edited\n');
        ok(/has changed since run/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', stopped.runId], { env: env() }).out));
        git(['checkout', '-q', '--', '.aidev/workflows/long/workflow.yaml'], fx.root);
      });

      test('an until agent is shown what changed, and the pull request text carries the steps\' reports', () => {
        write(path.join(fx.root, 'src', 'touched.txt'), 'before\n');
        write(path.join(fx.root, 'tools', 'edit.js'), "require('fs').appendFileSync('src/touched.txt', 'changed\\n');\n");
        define('judged', { steps: [
          '  - id: write', '    agent: coder', '    prompt: write it',
          '    until:', '      command: node tools/edit.js', '      agent: reviewer', '      prompt: check the change',
          '  - id: pr', '    pull_request:',
        ] });
        const verdicts = path.join(tmp, 'verdicts.json');
        fs.writeFileSync(verdicts, JSON.stringify(['PASS']));
        reset();
        const r = aidev(fx.root, ['run', 'workflow', 'judged', '--json'], { env: env({ STUB_VERDICTS: verdicts }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/What changed in the files git already tracks:[\s\S]*src\/touched\.txt \| 1 \+/.test(prompts[1]), prompts[1]);
        const diffRel = `.aidev/workflows/judged/runs/${j.runId}/diffs/write.1.diff`;
        ok(prompts[1].includes(`The diff itself is in ${diffRel}`), prompts[1]);
        ok(/^\+changed$/m.test(fs.readFileSync(path.join(j.worktree, diffRel), 'utf8')), 'the diff is written for the until agent to read');
        eq(j.pr.description, `.aidev/workflows/judged/runs/${j.runId}/pull-request.md`, 'generic hosting: the text is kept for a pull request opened by hand');
        const committed = git(['show', '--name-only', '--format=', 'HEAD'], j.worktree).split('\n').filter(Boolean);
        ok(committed.includes(`.aidev/estimates/records/judged-${j.runId}.json`), `the estimate record goes with the pull request: ${committed.join(', ')}`);
        ok(!git(['status', '--porcelain', '--', '.aidev/estimates'], j.worktree).trim(), 'the record does not change after the push');
        eq(git(['show', '--name-only', '--format=', j.steps[0].checkpoint], j.worktree), 'src/touched.txt', 'the step\'s own checkpoint');
        const text = fs.readFileSync(path.join(j.worktree, j.pr.description), 'utf8');
        ok(text.includes(`checkpoint \`${j.steps[0].checkpoint.slice(0, 12)}\``), 'the pull request text names each step\'s checkpoint');
        ok(/## Reports\n\n### write \(agent coder\)\n\nstub answer\n\n### write \(until\) \(agent reviewer\)\n\n[\s\S]*VERDICT: PASS/.test(text), text);
        git(['checkout', '-q', 'main'], fx.root);

        const { prDescription } = require('../cli/commands/workflow');
        const long = prDescription({
          title: 't', name: 'judged', hash: 'sha256:x', runId: j.runId, baseSha: 'b', approval: { ref: 'origin/main', refSha: 'a' },
          agentRuns: 2, spentUsd: 0.5, task: '', results: [{ id: 'write', ok: true, attempts: 1 }],
          reports: [{ id: 'plan', agent: 'coder', report: 'p'.repeat(9000) }, { id: 'write', agent: 'coder', report: 'w'.repeat(9000) }], max: 4000,
        });
        ok(long.length <= 4000 && /### plan/.test(long) && /### write/.test(long) && /does not merge\.$/.test(long), `${long.length} characters`);
      });

      test('a step that changes a path it must leave unchanged fails, and is told which', () => {
        write(path.join(fx.root, 'src', 'locked.txt'), 'expected\n');
        // What "make the check pass by weakening it" looks like: the step's own check edits the protected file.
        write(path.join(fx.root, 'tools', 'weaken.js'), "require('fs').writeFileSync('src/locked.txt', 'weakened\\n');\n");
        define('guarded', { steps: [
          '  - id: fix', '    agent: coder', '    unchanged: [src/locked.txt]', '    prompt: fix it',
          '    until:', '      command: node tools/weaken.js',
        ] });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'guarded', '--dry-run'], { env: env() });
        ok(/- must leave unchanged: src\/locked\.txt/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'guarded', '--json'], { env: env() });
        eq(r.code, 1, r.out);
        const j = lastJson(r.out);
        git(['checkout', '-q', '--', 'src/locked.txt'], j.worktree);
        ok(/same failure repeated \(1 path\(s\) that must stay unchanged were changed/.test(j.stopReason), j.stopReason);
        eq(j.agentRuns, 2);
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/- Leave unchanged: src\/locked\.txt\. The workflow compares them/.test(prompts[0]), prompts[0]);
        ok(/must leave these paths as they were when it started \(src\/locked\.txt\), and they differ now:\n\n```\nsrc\/locked\.txt\n```/.test(prompts[1]), prompts[1]);

        // A path that already differed from HEAD when the step started is held to that state, not to HEAD.
        write(path.join(fx.root, 'tools', 'prechange.js'), "require('fs').writeFileSync('src/locked.txt', 'changed by an earlier step\\n');\n");
        define('kept', { steps: [
          '  - id: before', '    command: node tools/prechange.js',
          '  - id: fix', '    agent: coder', '    unchanged: [src/locked.txt]', '    prompt: fix it',
          '    until:', '      command: node --version',
        ] });
        const kept = aidev(fx.root, ['run', 'workflow', 'kept', '--json'], { env: env() });
        eq(kept.code, 0, kept.out);
        eq(fs.readFileSync(path.join(lastJson(kept.out).worktree, 'src', 'locked.txt'), 'utf8'), 'changed by an earlier step\n');
      });

      test('a for_each step starts its agent once per target and resumes at the target that stopped', () => {
        // Stands in for the planning step: writes the list into the notes of the run that is going.
        write(path.join(fx.root, 'tools', 'targets.js'), [
          "const fs = require('fs'); const path = require('path');",
          "const runs = path.join('.aidev', 'workflows', 'each', 'runs');",
          "const dir = path.join(runs, fs.readdirSync(runs).sort().pop(), 'notes');",
          "fs.writeFileSync(path.join(dir, 'targets.txt'), '# screens\\nlogin\\norders/list\\nsettings\\n');", '',
        ].join('\n'));
        write(path.join(fx.root, 'tools', 'screen.js'),
          "const t = process.argv[2]; console.log('checking ' + t); process.exit(t === 'orders/list' && !require('fs').existsSync('orders.flag') ? 6 : 0);\n");
        define('each', { steps: [
          '  - id: plan', '    command: node tools/targets.js',
          '  - id: write', '    agent: coder', '    prompt: Write the IT test for the screen {item}.',
          '    for_each:', '      from: targets.txt', '      max_items: 5',
          '    until:', '      command: node tools/screen.js {item}', '      max_retries: 1',
          '  - id: sum', '    agent: coder', '    writable: []', '    prompt: summarise',
        ] });
        const stepsOut = path.join(tmp, 'steps.txt');
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'each', '--dry-run'], { env: env() });
        ok(/- once per target listed in the run's notes file targets\.txt \(at most 5\)/.test(dry.out), dry.out);
        const first = aidev(fx.root, ['run', 'workflow', 'each', '--json'], { env: env() });
        eq(first.code, 1, first.out);
        const j1 = lastJson(first.out);
        ok(/^step write: target orders\/list: the same failure repeated \(node tools\/screen\.js orders\/list exited 6/.test(j1.stopReason), j1.stopReason);
        const w1 = j1.steps.find((s) => s.id === 'write');
        eq(w1.items.map((x) => [x.item, x.ok, x.attempts]), [['login', true, 1], ['orders/list', false, 2]], 'the third target was not started');
        eq(w1.log, undefined);
        ok(/logs\/write\.t2\.2\.1\.log$/.test(w1.items[1].log), `the log of the target's last failed check: ${JSON.stringify(w1.items[1])}`);
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/Write the IT test for the screen login\.\n\n## Your target: login \(1 of 3\)/.test(prompts[0]), prompts[0]);
        ok(/`node tools\/screen\.js login` must exit 0/.test(prompts[0]), 'the target is in the check the agent is told about');
        ok(!/### Step write/.test(prompts[1]), 'one target does not get the report of another');

        write(path.join(j1.worktree, 'orders.flag'), '');
        reset();
        fs.rmSync(stepsOut, { force: true });
        const second = aidev(fx.root, ['run', 'workflow', 'each', '--resume', 'last', '--json'], { env: env({ STUB_STEPS_OUT: stepsOut }) });
        fs.rmSync(path.join(j1.worktree, 'orders.flag'), { force: true });
        eq(second.code, 0, second.out);
        const j2 = lastJson(second.out);
        const w2 = j2.steps.find((s) => s.id === 'write');
        eq(w2.items.map((x) => [x.item, x.ok]), [['login', true], ['orders/list', true], ['settings', true]]);
        eq(fs.readFileSync(stepsOut, 'utf8').trim().split('\n'), ['write', 'write', 'sum'], 'login was finished by the first start and is not done again');
        const after = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/## Your target: orders\/list \(2 of 3\)/.test(after[0]) && /## This run was resumed/.test(after[0]), after[0]);
        ok(/## Your target: settings \(3 of 3\)/.test(after[1]) && !/## This run was resumed/.test(after[1]), after[1]);
        ok(/### Step write \(agent coder\)\n\n3 target\(s\) from [^\n]+targets\.txt: 3 done\.\n\n- login: done[^\n]*\n {2}stub answer\n- orders\/list: done/.test(after[2]),
          'the next step gets one report for the whole step: ' + after[2]);

        // A list the kit cannot take as written stops the step before any agent starts.
        write(path.join(fx.root, 'tools', 'targets.js'), [
          "const fs = require('fs'); const path = require('path');",
          "const runs = path.join('.aidev', 'workflows', 'each', 'runs');",
          "fs.writeFileSync(path.join(runs, fs.readdirSync(runs).sort().pop(), 'notes', 'targets.txt'), 'login\\n--config=evil.js\\n');", '',
        ].join('\n'));
        approve(fx, 'a bad list');
        reset();
        const bad = aidev(fx.root, ['run', 'workflow', 'each', '--json'], { env: env() });
        eq(bad.code, 1, bad.out);
        ok(/step write: targets\.txt line 2: "--config=evil\.js" is not a target/.test(lastJson(bad.out).stopReason), lastJson(bad.out).stopReason);
        ok(!fs.existsSync(promptOut), 'no agent was started');
      });

      test('on_failure: continue undoes a target that fails and goes on; --log keeps the whole run and a summary', () => {
        // node tools/list.js <workflow> <a,b,c>: the planning step, writing the targets into the run's notes.
        write(path.join(fx.root, 'tools', 'list.js'), [
          "const fs = require('fs'); const path = require('path');",
          "const runs = path.join('.aidev', 'workflows', process.argv[2], 'runs');",
          "fs.writeFileSync(path.join(runs, fs.readdirSync(runs).sort().pop(), 'notes', 'targets.txt'), process.argv[3].split(',').join('\\n') + '\\n');", '',
        ].join('\n'));
        write(path.join(fx.root, 'tools', 'check.js'), "console.log('checking ' + process.argv[2]); process.exit(process.argv[2] === 'bad' ? 3 : 0);\n");
        const steps = (list) => [
          '  - id: plan', `    command: node tools/list.js ${list}`,
          '  - id: write', '    agent: coder', '    prompt: Write the test for {item}.',
          '    for_each:', '      from: targets.txt', '      max_items: 5', '      on_failure: continue',
          '    until:', '      command: node tools/check.js {item}', '      max_retries: 1',
        ];
        define('skip', { steps: steps('skip login,bad,settings'), minutes: null });
        reset();
        const logFile = path.join(tmp, 'logs', 'skip.log');
        const r = aidev(fx.root, ['run', 'workflow', 'skip', '--json', '--log', logFile], { env: env({ STUB_ITEM_DIR: 'src/out' }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        const w = j.steps.find((s) => s.id === 'write');
        eq(w.items.map((x) => [x.item, x.ok, !!x.failed]), [['login', true, false], ['bad', false, true], ['settings', true, false]]);
        eq([w.ok, w.failed], [true, 1]);
        ok(/the same failure repeated/.test(w.items[1].reason), w.items[1].reason);
        const out = (f) => path.join(j.worktree, 'src', 'out', f);
        ok(fs.existsSync(out('login.txt')) && fs.existsSync(out('settings.txt')), 'the targets that passed keep their work');
        eq(w.items.map((x) => !!x.checkpoint), [true, false, true], 'each target that passed is a checkpoint of its own');
        eq(git(['show', '--name-only', '--format=%s', w.items[2].checkpoint], j.worktree), 'aidev(skip): write [settings]\n\nsrc/out/settings.txt');
        ok(!fs.existsSync(out('bad.txt')), 'the target that failed was undone');
        const text = fs.readFileSync(logFile, 'utf8');
        ok(/^# aidev run workflow skip\n/.test(text) && /limits: +no time limit, \$1/.test(text), text.slice(0, 400));
        ok(/\n {2}write \[login\] #1 +\d:\d\d {2}Read stub-read\.md\n/.test(text), 'every tool call of every agent');
        ok(/----- final report of agent coder \(step write, target login, attempt 1\) -----\nstub answer\n----- end -----/.test(text), 'each final report');
        ok(/----- output of "node tools\/check\.js bad" -----[\s\S]*?checking bad/.test(text), 'each command\'s output');
        ok(/target bad failed \(.*\); 1 changed file\(s\) undone, going on/.test(text), text);
        ok(/# Summary\n\nresult: +finished[\s\S]*targets: 2 done, 1 failed and undone, 0 not finished\n {4}failed bad: /.test(text), text.slice(-800));

        define('skipall', { steps: steps('skipall bad'), minutes: null });
        const all = aidev(fx.root, ['run', 'workflow', 'skipall', '--json'], { env: env({ STUB_ITEM_DIR: 'src/out' }) });
        eq(all.code, 1, all.out);
        ok(/every target failed \(the first: bad:/.test(lastJson(all.out).stopReason), lastJson(all.out).stopReason);
      });

      // Spans of the agent starts a run made: [{ step, item, start, end }].
      const spansOf = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      // The most starts that were running at one moment.
      const widest = (spans) => Math.max(...spans.map((a) => spans.filter((b) => b.start < a.end && a.start < b.end).length));

      test('for_each.parallel runs its targets at once, each under its own writable; a failed one is undone alone', () => {
        const spans = path.join(tmp, 'spans.txt');
        fs.rmSync(spans, { force: true });
        define('wide', { minutes: null, steps: [
          '  - id: plan', '    command: node tools/list.js wide a,b,bad,d,e',
          '  - id: write', '    agent: coder', '    prompt: Write the test for {item}.', '    writable: [src/out/{item}.txt]',
          '    for_each:', '      from: targets.txt', '      max_items: 10', '      on_failure: continue', '      parallel: 3',
          '    until:', '      command: node tools/check.js {item}', '      max_retries: 0',
        ] });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'wide', '--dry-run'], { env: env() });
        ok(/at most 10, 3 at a time/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'wide', '--json'], { env: env({ STUB_ITEM_DIR: 'src/out', STUB_SPANS_OUT: spans, STUB_SLEEP_MS: '400', STUB_ENV_OUT: '' }) });
        eq(r.code, 0, r.out);
        const w = lastJson(r.out).steps.find((x) => x.id === 'write');
        eq(w.items.map((x) => [x.item, x.ok, !!x.failed]), [['a', true, false], ['b', true, false], ['bad', false, true], ['d', true, false], ['e', true, false]],
          'the record keeps the list\'s order');
        const starts = spansOf(spans);
        eq(starts.map((x) => x.item).sort(), ['a', 'b', 'bad', 'd', 'e'], 'each start knows its target (AIDEV_WORKFLOW_ITEM)');
        eq(widest(starts), 3, 'three at a time, never more');
        const out = (f) => path.join(lastJson(r.out).worktree, 'src', 'out', f);
        ok(['a', 'b', 'd', 'e'].every((x) => fs.existsSync(out(`${x}.txt`))), 'the targets that passed keep their work');
        ok(!fs.existsSync(out('bad.txt')), 'the failed target was undone, and only it');
        // The guard gives a target its own path, and no other target's.
        const policyMod = require('../cli/lib/policy');
        const at = (item, rel) => policyMod.decide(fx.root, rel, { workflow: 'wide', step: 'write', item, installRoot: KIT_ROOT }).decision;
        eq([at('a', 'src/out/a.txt'), at('a', 'src/out/b.txt'), at(null, 'src/out/a.txt')], ['allow', 'deny', 'deny']);
        eq(w.items.filter((x) => x.checkpoint).length, 4, 'targets running at once each commit their own checkpoint');
        eq(git(['log', '--format=%s', '-4'], lastJson(r.out).worktree).split('\n').sort(), ['aidev(wide): write [a]', 'aidev(wide): write [b]', 'aidev(wide): write [d]', 'aidev(wide): write [e]']);
      });

      test('the steps of a parallel group start together, and the run goes on when all have ended', () => {
        const spans = path.join(tmp, 'spans.txt');
        fs.rmSync(spans, { force: true });
        define('group', { minutes: null, steps: [
          '  - id: both', '    parallel:',
          '      - id: left', '        agent: coder', '        writable: [src/left/**]', '        prompt: the left side',
          '      - id: right', '        agent: coder', '        writable: [src/right/**]', '        prompt: the right side',
          '  - id: after', '    agent: coder', '    writable: []', '    prompt: look at both',
        ] });
        reset();
        const dry = aidev(fx.root, ['run', 'workflow', 'group', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/runs at the same time as right \(parallel group both\)/.test(dry.out), dry.out);
        // left takes longer, so right finishes first.
        const r = aidev(fx.root, ['run', 'workflow', 'group', '--json'], { env: env({ STUB_SPANS_OUT: spans, STUB_SLEEP_MS: '300', STUB_SLEEP_FOR: 'left:900' }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.steps.map((x) => [x.id, x.ok]), [['left', true], ['right', true], ['after', true]]);
        const starts = spansOf(spans);
        const by = (id) => starts.find((x) => x.step === id);
        ok(by('left').start < by('right').end && by('right').start < by('left').end, 'left and right overlapped');
        ok(by('after').start >= Math.max(by('left').end, by('right').end), 'after started once both had ended');
        const last = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean).pop();
        ok(by('right').end < by('left').end, 'right finished first');
        ok(/## Reports from the earlier steps[\s\S]*left[\s\S]*right/.test(last), 'the step after the group reads both reports, in the order of the definition');
        // A group step that stops lets the other finish, and the run stops after the group.
        fs.rmSync(spans, { force: true });
        const bad = aidev(fx.root, ['run', 'workflow', 'group', '--json'], { env: env({ STUB_SPANS_OUT: spans, STUB_MODE: 'fail' }) });
        eq(bad.code, 1, bad.out);
        const b = lastJson(bad.out);
        ok(/^step (left|right): /.test(b.stopReason), b.stopReason);
        eq(b.steps.map((x) => x.id), ['left', 'right'], 'after never started');
      });

      test('subagents an agent may start reach the tool as --agents, and the guard refuses any other', () => {
        const agentsOut = path.join(tmp, 'agents.json');
        fs.rmSync(agentsOut, { force: true });
        write(path.join(fx.root, '.aidev', 'agents', 'lead.md'), '---\nname: lead\ndescription: leads\ntools: Read, Grep, Agent\nmcp: [tickets]\n---\n\nYou lead.\n');
        write(path.join(fx.root, '.aidev', 'agents', 'scout.md'), '---\nname: scout\ndescription: looks around\nskills: [code-review]\ntools: Read\n---\n\nYou scout.\n');
        define('subs', {
          extra: ['agents:', '  lead:', '    subagents: [scout]'],
          steps: ['  - id: look', '    agent: lead', '    writable: []', '    prompt: find out'],
        });
        reset();
        // The PKG's hook must see Agent calls; this fixture's settings.json predates that.
        const settingsFile = path.join(fx.root, '.claude', 'settings.json');
        const settings = fs.readFileSync(settingsFile, 'utf8');
        const stale = aidev(fx.root, ['run', 'workflow', 'subs', '--dry-run'], { env: env() });
        eq(stale.code, 1, stale.out);
        ok(/agent lead names subagents, but \.claude\/settings\.json does not send Agent calls/.test(stale.out), stale.out);
        write(settingsFile, settings.replace('"Write|Edit|MultiEdit|Bash"', '"Write|Edit|MultiEdit|Bash|Agent|Task"'));
        const dry = aidev(fx.root, ['run', 'workflow', 'subs', '--dry-run'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/subagents: scout/.test(dry.out) && /may start subagent scout \(skills: code-review; tools: Read; mcp: \(none\)\)/.test(dry.out), dry.out);
        const r = aidev(fx.root, ['run', 'workflow', 'subs', '--json'], { env: env({ STUB_AGENTS_OUT: agentsOut }) });
        eq(r.code, 0, r.out);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        ok(a.indexOf('--agents') >= 0 && a.indexOf('--agents') < a.indexOf('--tools'), a.join(' '));
        ok(!a[a.indexOf('--agents') + 1].startsWith(fx.root) && !fs.existsSync(a[a.indexOf('--agents') + 1]), 'outside the repository, removed after');
        const spec = JSON.parse(fs.readFileSync(agentsOut, 'utf8'));
        eq(Object.keys(spec), ['scout']);
        eq([spec.scout.description, spec.scout.model, spec.scout.disallowedTools], ['looks around', 'inherit', ['Grep', 'Agent', 'mcp__tickets']],
          'what the parent has and the subagent does not is taken away');
        ok(/You scout\.[\s\S]*## Skill: code-review/.test(spec.scout.prompt), 'its body and skills');
        ok(/## Subagents\n\nYou may start these subagents[^\n]*\n- scout: looks around/.test(fs.readFileSync(promptOut, 'utf8')), 'the agent is told which');
        // The hook, as Claude Code calls it: an Agent call names its subagent; a subagent's own calls name it (agent_id, agent_type).
        const hook = (input) => {
          const f = path.join(tmp, 'hook-input.json');
          fs.writeFileSync(f, JSON.stringify(input));
          return aidev(fx.root, ['hook', 'guard-write', '--input', f], { env: { AIDEV_WORKFLOW: 'subs', AIDEV_WORKFLOW_STEP: 'look' } });
        };
        const denied = (res) => /"permissionDecision": ?"deny"/.test(res.out);
        ok(denied(hook({ tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'x' } })), 'a subagent it does not name');
        const okAgent = hook({ tool_name: 'Agent', tool_input: { subagent_type: 'scout', prompt: 'x' } });
        eq([okAgent.code, denied(okAgent)], [0, false], okAgent.out);
        ok(denied(hook({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'x1', agent_type: 'scout' })), 'Bash is not among the scout\'s tools');
        ok(denied(hook({ tool_name: 'mcp__tickets__get', tool_input: {}, agent_id: 'x1', agent_type: 'scout' })), 'nor the tickets server');
        ok(!denied(hook({ tool_name: 'mcp__tickets__get', tool_input: {} })), 'which its parent may use');
        ok(denied(hook({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts', content: '' }, agent_id: 'x2', agent_type: 'Explore' })), 'a subagent it may not start may do nothing');
        // A subagent may not have what its parent lacks.
        write(path.join(fx.root, '.aidev', 'agents', 'digger.md'), '---\nname: digger\ndescription: digs\ntools: Read, Bash\n---\n\nYou dig.\n');
        define('subs-wide', {
          extra: ['agents:', '  lead:', '    subagents: [digger]'],
          steps: ['  - id: look', '    agent: lead', '    writable: []', '    prompt: find out'],
        });
        const wide = aidev(fx.root, ['run', 'workflow', 'subs-wide', '--dry-run'], { env: env() });
        eq(wide.code, 1, wide.out);
        ok(/subagent digger may use Bash, which its parent lead may not/.test(wide.out), wide.out);
        const rm = aidev(fx.root, ['remove', 'agent', 'scout']);
        eq(rm.code, 1, rm.out);
        ok(/subs/.test(rm.out) && fs.existsSync(path.join(fx.root, '.aidev', 'agents', 'scout.md')), 'a subagent a workflow uses is not removed: ' + rm.out);
        write(settingsFile, settings);
      });

      test('what a toolchain leaves behind inside writable is never committed, is said so, and does not block the next run', () => {
        write(path.join(fx.root, 'tools', 'residue.js'), [
          "const fs = require('fs');",
          "for (const d of ['e2e/node_modules/pkg', 'e2e/tests', 'e2e/test-results']) fs.mkdirSync(d, { recursive: true });",
          "fs.writeFileSync('e2e/node_modules/pkg/index.js', 'x'); fs.writeFileSync('e2e/tests/a.spec.ts', 'spec'); fs.writeFileSync('e2e/test-results/r.txt', 'r');", '',
        ].join('\n'));
        // This PKG has no .gitignore: node_modules would be an ordinary untracked directory.
        define('residue', { extra: ['never_commit: [e2e/test-results/**]'], steps: [
          '  - id: make', '    command: node tools/residue.js', '    writable: [e2e/**]',
          '  - id: pr', '    pull_request: {}',
        ] });
        const r = aidev(fx.root, ['run', 'workflow', 'residue', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(git(['show', '--name-only', '--format=', j.steps[0].checkpoint], j.worktree), 'e2e/tests/a.spec.ts', 'the test, not node_modules nor the test results');
        eq([j.leftOut, j.steps[1].leftOut], [{ '**/node_modules/**': 1, 'e2e/test-results/**': 1 }, { '**/node_modules/**': 1, 'e2e/test-results/**': 1 }]);
        ok(/left out as never committed \(\*\*\/node_modules\/\*\*; e\.g\. e2e\/node_modules\/pkg\/index\.js\)/.test(fs.readFileSync(path.join(runsDirOf('residue'), j.runId, 'log.txt'), 'utf8')));
        ok(/## Left out[\s\S]*`\*\*\/node_modules\/\*\*`: 1 file\(s\)/.test(fs.readFileSync(path.join(j.worktree, j.pr.description), 'utf8')), 'the pull request text says so');
        ok(fs.existsSync(path.join(j.worktree, 'e2e/node_modules/pkg/index.js')), 'the residue stays in the worktree');
        const again = aidev(fx.root, ['run', 'workflow', 'residue', '--json'], { env: env() });
        eq(again.code, 0, `the residue in the worktree is not a stopped run's work: ${again.out}`);
        // A file git tracks under such a path is not residue: an edit to it is committed like any other.
        write(path.join(fx.root, 'e2e', 'node_modules', 'vendored.js'), 'v1\n');
        write(path.join(fx.root, 'tools', 'vendored.js'), "require('fs').writeFileSync('e2e/node_modules/vendored.js', 'v2\\n');\n");
        define('vendored', { steps: ['  - id: edit', '    command: node tools/vendored.js', '    writable: [e2e/**]'] });
        const v = lastJson(aidev(fx.root, ['run', 'workflow', 'vendored', '--json'], { env: env() }).out);
        eq(git(['show', '--name-only', '--format=', v.steps[0].checkpoint], v.worktree), 'e2e/node_modules/vendored.js', 'tracked, so committed');
      });

      test('inputs are declared, given with --input, checked before anything starts, and reach the prompts and commands', () => {
        write(path.join(fx.root, 'tools', 'browser.js'), "process.exit(process.argv[2] === 'firefox' ? 0 : 9);\n");
        define('inputs', { extra: [
          'inputs:', '  spec:', '    description: the spec to work from', '    path: true',
          '  browser:', '    default: chromium', '    pattern: "[a-z]+"',
        ], steps: [
          '  - id: write', '    agent: coder', '    prompt: Read {inputs.spec}; test on {inputs.browser}.',
          '    until:', '      command: node tools/browser.js {inputs.browser}', '      max_retries: 0',
        ] });
        reset();
        write(path.join(fx.root, 'draft.txt'), 'not committed\n');
        const none = aidev(fx.root, ['run', 'workflow', 'inputs', '--dry-run'], { env: env() });
        eq(none.code, 1, none.out);
        ok(/needs --input for: spec \(the spec to work from\)/.test(none.out), none.out);
        const bad = (args) => aidev(fx.root, ['run', 'workflow', 'inputs', '--dry-run', ...args], { env: env() }).out;
        ok(/declares no input "nope"/.test(bad(['--input', 'spec=docs/readme.md', '--input', 'nope=1'])));
        ok(/does not match its pattern/.test(bad(['--input', 'spec=docs/readme.md', '--input', 'browser=Fire'])));
        ok(/draft\.txt is not committed; a run starts from HEAD/.test(bad(['--input', 'spec=draft.txt'])), 'a path input must reach the worktree');
        git(['add', 'draft.txt'], fx.root);
        ok(/draft\.txt is not committed; a run starts from HEAD/.test(bad(['--input', 'spec=draft.txt'])), 'staged is not committed');
        git(['rm', '-q', '--cached', 'draft.txt'], fx.root);
        fs.rmSync(path.join(fx.root, 'draft.txt'), { force: true });
        const dry = aidev(fx.root, ['run', 'workflow', 'inputs', '--dry-run', '--input', 'spec=docs/readme.md', '--input', 'browser=firefox'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/inputs\s+spec=docs\/readme\.md\nbrowser=firefox/.test(dry.out), dry.out);
        ok(/repeats until node tools\/browser\.js firefox exits 0/.test(dry.out), 'the dry run shows the command as it will run');
        ok(/## Inputs \(--input name=value\)[\s\S]*- spec: the spec to work from \(required; a path in the repository\)[\s\S]*- browser \(default chromium; pattern \[a-z\]\+; reaches a command\)/.test(dry.out), dry.out);
        ok(!fs.existsSync(promptOut), 'nothing started');
        const r = aidev(fx.root, ['run', 'workflow', 'inputs', '--input', 'spec=docs/readme.md', '--input', 'browser=firefox', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.inputs, { spec: 'docs/readme.md', browser: 'firefox' });
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(/## Inputs for this run[\s\S]*- spec: docs\/readme\.md\n- browser: firefox/.test(prompt), prompt.slice(0, 1500));
        ok(/## Step write \(1\/1\)\n\nRead docs\/readme\.md; test on firefox\./.test(prompt), 'the values are written where the definition named them');
        ok(/`node tools\/browser\.js firefox` must exit 0/.test(prompt));
        ok(/do not pass --input/.test(aidev(fx.root, ['run', 'workflow', 'inputs', '--resume', 'last', '--input', 'browser=x'], { env: env() }).out));
        const est = aidev(fx.root, ['estimate', 'workflow', 'inputs', '--input', 'browser=firefox', '--json'], { env: env() });
        eq(lastJson(est.out).inputs, { browser: 'firefox' }, 'estimate takes the inputs; a missing one is no reason not to estimate');
        const dflt = aidev(fx.root, ['run', 'workflow', 'inputs', '--input', 'spec=docs/readme.md', '--json'], { env: env() });
        eq(dflt.code, 1);
        ok(/node tools\/browser\.js chromium exited 9/.test(lastJson(dflt.out).stopReason), 'the default applies: ' + lastJson(dflt.out).stopReason);
      });

      test('a file input is copied into the run; provide brings ignored files from the checkout, never a secret', () => {
        const specFile = path.join(tmp, 'login.txt');
        fs.writeFileSync(specFile, 'LOGIN SPEC\n');
        write(path.join(fx.root, '.gitignore'), 'docs/spec/\nconfig/secrets/local.key\n');
        write(path.join(fx.root, 'docs', 'spec', 'orders.txt'), 'ORDERS\n');
        write(path.join(fx.root, 'docs', 'spec', '.env'), 'TOKEN=x\n');
        write(path.join(fx.root, 'config', 'secrets', 'local.key'), 'SECRET\n');
        write(path.join(fx.root, 'tools', 'cat.js'), "process.stdout.write(require('fs').readFileSync(process.argv[2], 'utf8')); process.exit(require('fs').existsSync('config/secrets/local.key') ? 7 : 0);\n");
        define('files', { extra: ['inputs:', '  spec:', '    file: true', 'provide: [docs/spec/**, config/secrets/**]'], steps: [
          '  - id: check', '    command: node tools/cat.js {inputs.spec}',
          '  - id: check2', '    command: node tools/cat.js docs/spec/orders.txt',
        ] });
        ok(/export .*\.xlsx to Markdown/.test(aidev(fx.root, ['run', 'workflow', 'files', '--input', `spec=${path.join(tmp, 'x.xlsx')}`], { env: env() }).out));
        ok(/is not a file on this machine/.test(aidev(fx.root, ['run', 'workflow', 'files', '--input', 'spec=/no/such.txt'], { env: env() }).out));
        const r = aidev(fx.root, ['run', 'workflow', 'files', '--input', `spec=${specFile}`, '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        ok(/^\.aidev\/workflows\/files\/runs\/[^/]+\/inputs\/spec\.txt$/.test(j.inputs.spec), j.inputs.spec);
        eq(fs.readFileSync(path.join(j.worktree, j.inputs.spec), 'utf8'), 'LOGIN SPEC\n', 'the copy is in the run directory');
        eq(fs.readFileSync(path.join(j.worktree, 'docs/spec/orders.txt'), 'utf8'), 'ORDERS\n', 'provided from the checkout');
        ok(!fs.existsSync(path.join(j.worktree, 'config/secrets/local.key')) && !fs.existsSync(path.join(j.worktree, 'docs/spec/.env')), 'a secret is never provided, by path or by name');
        const logText = fs.readFileSync(path.join(runsDirOf('files'), j.runId, 'log.txt'), 'utf8');
        ok(/provide: 1 path\(s\) copied from the checkout: docs\/spec\/orders\.txt/.test(logText) && /provide: config\/secrets\/local\.key not copied \(a secret path/.test(logText) && /docs\/spec\/\.env not copied \(a credential file/.test(logText), logText);
        ok(!git(['status', '--porcelain', '--', 'docs/spec'], j.worktree).trim(), 'what was provided stays ignored, uncommitted');
        define('files-none', { extra: ['provide: [fixtures/**]'], steps: ['  - id: c', '    command: node --version'] });
        const dry = aidev(fx.root, ['run', 'workflow', 'files-none', '--dry-run'], { env: env() });
        eq(dry.code, 1, dry.out);
        ok(/provide: fixtures\/\*\* matches no file that git ignores/.test(dry.out), dry.out);
        // A file ignored only by a rule the repository does not carry would land in the worktree as new: refused.
        write(path.join(fx.root, 'fixtures', 'data.json'), '{}\n');
        fs.appendFileSync(path.join(fx.root, '.gitignore'), 'fixtures/\n');
        const uncommitted = aidev(fx.root, ['run', 'workflow', 'files-none', '--json'], { env: env() });
        eq(uncommitted.code, 1, uncommitted.out);
        ok(/fixtures\/data\.json is ignored in .* by a rule the repository does not carry; commit the \.gitignore/.test(uncommitted.out), uncommitted.out);
        git(['checkout', '-q', '--', '.gitignore'], fx.root);
        fs.rmSync(path.join(fx.root, 'fixtures'), { recursive: true, force: true });
      });

      test('a trial runs the definition as it is here, approved or not, on aidev/<name>.trial, and pushes nothing', () => {
        const pushOut = path.join(tmp, 'push.txt');
        const trialRel = '.aidev/workflows/trial/workflow.yaml';
        const before = lastJson(aidev(fx.root, ['estimate', 'workflow', 'plain', '--json'], { env: env() }).out).history.starts;
        write(path.join(fx.root, ...trialRel.split('/')), yamlOf('trial', { steps: [
          '  - id: write', '    agent: coder', '    prompt: write it',
          '  - id: pr', '    pull_request: {}',
        ] }));
        reset();
        fs.rmSync(pushOut, { force: true });
        const refused = aidev(fx.root, ['run', 'workflow', 'trial', '--json'], { env: env() });
        eq(refused.code, 1);
        ok(/not approved/.test(refused.out) && /--trial/.test(refused.out), refused.out);
        const dry = aidev(fx.root, ['run', 'workflow', 'trial', '--dry-run', '--trial', '--max-usd', '0.5'], { env: env() });
        eq(dry.code, 0, dry.out);
        ok(/approved\s+not required: --trial runs the definition as it is in this checkout \(NO/.test(dry.out), dry.out);
        ok(/branch\s+aidev\/trial\.trial/.test(dry.out) && /limits\s+5 min, \$0\.5 \(limits\.max_usd is \$1\)/.test(dry.out), dry.out);
        ok(/dry run: the definition validates and would run as a trial/.test(dry.out));
        const r = aidev(fx.root, ['run', 'workflow', 'trial', '--trial', '--json'], { env: env({ STUB_PUSH_OUT: pushOut, STUB_DENIALS: 'src/x.ts', STUB_WRITE_FILE: 'outside.txt', STUB_WRITE_TEXT: 'past the guard' }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.trial, j.branch, j.approvedRef, j.approvedSha, j.done, j.pr.ok, j.pr.trial, j.steps[1].pushed], [true, 'aidev/trial.trial', null, null, true, false, true, false]);
        ok(/^sha256:/.test(j.trialHash));
        const wt = j.worktree;
        eq(wt, wtOf('aidev/trial.trial'));
        eq(git(['log', '--format=%s', `${j.baseSha}..HEAD`], wt).split('\n'), ['aidev: test workflow', 'aidev(trial): trial definition']);
        const body = git(['log', '-1', '--format=%B'], wt);
        ok(body.includes('approved: none (a trial run of the definition sha256:') && body.includes('trial run: not pushed'), body);
        eq(fs.readFileSync(path.join(wt, trialRel), 'utf8'), fs.readFileSync(path.join(fx.root, ...trialRel.split('/')), 'utf8'), 'the worktree holds the definition as it is in the checkout');
        ok(!git(['ls-remote', '--heads', 'origin'], fx.root).includes('aidev/trial'), 'nothing pushed');
        const pushed = fs.readFileSync(pushOut, 'utf8');
        ok(/^[1-9]\d* /.test(pushed) && /aidev: this is a trial run|aidev-no-push/.test(pushed), `a push from inside a trial is refused by git itself: ${pushed}`);
        eq([j.steps[0].denied, j.outside], [['Write src/x.ts'], ['outside.txt']], 'what the tool was refused, and what landed outside writable');
        ok(/was refused 1 call\(s\): Write src\/x\.ts/.test(r.out) && /changed outside what the steps may write/.test(r.out), r.out);
        ok(/\| approved on \| none \(a trial run of the definition sha256:/.test(fs.readFileSync(path.join(wt, j.pr.description), 'utf8')));
        const e = JSON.parse(fs.readFileSync(envOut, 'utf8'));
        eq([e.AIDEV_WORKFLOW, e.AIDEV_WORKFLOW_STEP, typeof e.AIDEV_WORKFLOW_TRIAL], ['trial', 'write', 'string'], 'the agent carries the trial token');
        ok(!fs.existsSync(wfMod.trialFile(wt)), 'the trial record is gone when the run ends');
        ok(!r.out.includes(e.AIDEV_WORKFLOW_TRIAL), 'the token is in no record or output');
        eq(lastJson(aidev(fx.root, ['estimate', 'workflow', 'plain', '--json'], { env: env() }).out).history.starts, before, 'the estimate learns nothing from a trial');
        // The guard: the trial record grants the step's writable, and nothing else does.
        const policyMod = require('../cli/lib/policy');
        const rec = wfMod.startTrial(wt, { name: 'trial', hash: j.trialHash, runId: j.runId });
        const at = (rel, o) => policyMod.decide(wt, rel, { workflow: 'trial', step: 'write', installRoot: KIT_ROOT, ...o });
        eq([at('src/x.ts', { trial: rec.token }).rule, at('docs/x.md', { trial: rec.token }).rule, at('src/x.ts', { trial: 'nope' }).rule, at('src/x.ts', {}).rule],
          ['workflow-trial-writable', 'read-only', 'read-only', 'read-only']);
        ok(/a trial run of the definition sha256:/.test(at('src/x.ts', { trial: rec.token }).reason), 'never called approved');
        eq(policyMod.decideToolUse(wt, 'Bash', { workflow: 'trial', step: 'write', trial: rec.token, installRoot: KIT_ROOT }), null, 'tool calls stand on the same record');
        ok(/not approved/.test(policyMod.decideToolUse(wt, 'Bash', { workflow: 'trial', step: 'write', installRoot: KIT_ROOT }).reason));
        const hook = (input, extra = {}) => {
          const f = path.join(tmp, 'hook-input.json');
          fs.writeFileSync(f, JSON.stringify(input));
          return aidev(wt, ['hook', 'guard-write', '--input', f], { env: { AIDEV_WORKFLOW: 'trial', AIDEV_WORKFLOW_STEP: 'write', ...extra } }).out;
        };
        ok(/"permissionDecision": ?"allow"/.test(hook({ tool_name: 'Write', tool_input: { file_path: 'src/y.ts', content: '' } }, { AIDEV_WORKFLOW_TRIAL: rec.token })), 'the hook, with the token');
        ok(/"permissionDecision": ?"deny"/.test(hook({ tool_name: 'Write', tool_input: { file_path: 'src/y.ts', content: '' } })), 'the hook, without it');
        ok(/nothing is pushed and no pull request is opened/.test(hook({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' } }, { AIDEV_WORKFLOW_TRIAL: rec.token })), 'a push from Bash is refused in a trial');
        ok(/nothing is pushed and no pull request is opened/.test(hook({ tool_name: 'Bash', tool_input: { command: 'cd x && git -C . push' } }, { AIDEV_WORKFLOW_TRIAL: rec.token })));
        ok(/"permissionDecision": ?"allow"/.test(hook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, { AIDEV_WORKFLOW_TRIAL: rec.token })));
        ok(/"permissionDecision": ?"allow"/.test(hook({ tool_name: 'Bash', tool_input: { command: 'git stash push -m wip' } }, { AIDEV_WORKFLOW_TRIAL: rec.token })), 'only the push subcommand is a push');
        fs.appendFileSync(path.join(wt, trialRel), '# widened\n');
        ok(/changed since the trial started/.test(at('src/x.ts', { trial: rec.token }).reason), 'an edit mid-run revokes the grant');
        git(['checkout', '-q', '--', trialRel], wt);
        rec.release();
        // A trial that is still running keeps the next one out before anything is moved.
        write(path.join(wt, 'src', 'half.ts'), 'left by the agent\n');
        const lockFile = runtreeMod.lockPath(wt);
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, runId: 'other' }));
        const busy = aidev(fx.root, ['run', 'workflow', 'trial', '--trial', '--json'], { env: env() });
        eq(busy.code, 1, busy.out);
        ok(/another run \(other, process \d+\) is working in/.test(busy.out) && fs.existsSync(path.join(wt, 'src', 'half.ts')), 'refused, and nothing was reset');
        fs.rmSync(lockFile, { force: true });
        // Trial after trial: the branch goes back to the base, the definition as it is now goes on it, what the last trial left is gone.
        fs.appendFileSync(path.join(fx.root, ...trialRel.split('/')), '# v2\n');
        const again = aidev(fx.root, ['run', 'workflow', 'trial', '--trial', '--json'], { env: env() });
        eq(again.code, 0, again.out);
        const j2 = lastJson(again.out);
        eq([j2.worktree, j2.worktreeSync, fs.existsSync(path.join(wt, 'src', 'half.ts')), fs.existsSync(path.join(wt, 'outside.txt'))], [wt, 'reset', false, false], 'the worktree was reset to the base, and what the last trial left is gone');
        eq(git(['log', '--format=%s', `${j2.baseSha}..HEAD`], wt).split('\n'), ['aidev: test workflow', 'aidev(trial): trial definition'], 'not on top of the first trial');
        ok(fs.readFileSync(path.join(wt, trialRel), 'utf8').endsWith('# v2\n'));
        ok(/no recorded run that was not a trial/.test(aidev(fx.root, ['run', 'workflow', 'trial', '--resume', 'last'], { env: env() }).out));
        ok(/nothing to resume/.test(aidev(fx.root, ['run', 'workflow', 'trial', '--resume', 'last', '--trial'], { env: env() }).out));
        ok(/was a trial run; resume it with --trial/.test(aidev(fx.root, ['run', 'workflow', 'trial', '--resume', j2.runId], { env: env() }).out));
        // The first trial's record is still there, unfinished as far as it knows, but its branch was moved: no resume onto a tree without its checkpoints.
        const stale = path.join(runsDirOf('trial', 'aidev/trial.trial'), j.runId, 'run.json');
        const staleRec = JSON.parse(fs.readFileSync(stale, 'utf8'));
        fs.writeFileSync(stale, JSON.stringify({ ...staleRec, hash: j2.hash, trialHash: j2.trialHash, done: false, steps: [{ id: 'write', kind: 'agent', ok: true, attempts: 1, checkpoint: j.steps[1].sha }, { ...staleRec.steps[1], ok: false }] }));
        ok(/checkpoints of run .* are no longer on aidev\/trial\.trial/.test(aidev(fx.root, ['run', 'workflow', 'trial', '--resume', j.runId, '--trial'], { env: env() }).out), 'a resume onto a branch that lost its checkpoints is refused');
        ok(/\(a trial run\)/.test(lastJson(aidev(fx.root, ['modify', 'workflow', 'trial', '--from-run', 'last', '--dry-run', '--json'], { env: env() }).out).fromRun ? 'x (a trial run)' : ''), '--from-run sees a trial');
        // The person's own checkout is never a run's worktree, whatever branch it has checked out.
        git(['worktree', 'remove', '--force', wt], fx.root);
        git(['checkout', '-q', '-f', 'aidev/trial.trial'], fx.root);
        write(path.join(fx.root, 'src', 'mine.ts'), 'my uncommitted work\n');
        const mine = aidev(fx.root, ['run', 'workflow', 'trial', '--trial', '--json'], { env: env() });
        eq(mine.code, 1, mine.out);
        ok(/aidev\/trial\.trial is checked out in .*; check out another branch there, or run with --dated/.test(mine.out), mine.out);
        ok(fs.existsSync(path.join(fx.root, 'src', 'mine.ts')), 'the checkout was not touched');
        fs.rmSync(path.join(fx.root, 'src', 'mine.ts'), { force: true });
        git(['checkout', '-q', 'main'], fx.root);
        write(path.join(fx.root, ...trialRel.split('/')), yamlOf('trial', { steps: ['  - id: p', '    command: git push origin main'] }));
        const pushy = aidev(fx.root, ['run', 'workflow', 'trial', '--dry-run', '--trial'], { env: env() });
        eq(pushy.code, 1);
        ok(/"git push origin main" pushes; a trial run pushes nothing/.test(pushy.out), pushy.out);
        fs.rmSync(path.join(fx.root, '.aidev', 'workflows', 'trial'), { recursive: true, force: true });
      });
    } finally { fx.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  // ------------------------------------------------------------- estimate
  suite('workflow: estimate');

  const estimateMod = require('../cli/lib/estimate');
  const EMPTY = { calls: [], runs: [] };
  const eachDef = wfMod.validateDefinition({
    ...GOOD, limits: { max_usd: 100, max_minutes: null },
    steps: [
      { id: 'plan', agent: 'planner', writable: [], prompt: 'list them' },
      { id: 'write', agent: 'writer', writable: ['e2e/**'], prompt: 'test {item}', for_each: { from: 't.txt', max_items: 10 },
        until: { command: 'npx playwright test {item}', agent: 'reviewer', prompt: 'covers it', max_retries: 2 } },
      { pull_request: {} },
    ],
  }, 'wf');

  test('without history: one start per attempt (two with a checker), times the targets, priced by size', () => {
    const e = estimateMod.estimateDefinition(eachDef, { history: EMPTY });
    const [plan, write, pr] = e.steps;
    eq([plan.starts, plan.usd, plan.basis], [[1, 1], [0.3, 1], 'size M']);
    eq([write.starts, write.items.low, write.items.high, write.items.basis], [[2, 60], 1, 10, 'max_items'], '1 target x 1 attempt x 2 .. 10 x 3 x 2');
    eq(write.perStart, { agent: [0.3, 1], checker: [0.05, 0.3] }, 'the checker defaults to size S');
    eq(write.usd, [0.35, 39], '0.3 + 0.05 .. 10 x 3 x (1 + 0.3)');
    eq(pr.starts, [0, 0]);
    eq([e.optimistic, e.pessimistic, e.cap], [0.65, 40, 101]);
  });

  test('the pessimistic figure stops where the runner stops: the budget plus one start', () => {
    const small = { ...eachDef, limits: { max_usd: 5, max_minutes: null } };
    const e = estimateMod.estimateDefinition(small, { history: EMPTY });
    eq([e.pessimistic, e.uncapped, e.cap], [6, 40, 6]);
    eq(estimateMod.estimateDefinition(small, { history: EMPTY, reportsCost: false }).pessimistic, 40, 'no cost reported, no budget stop');
    ok(estimateMod.estimateDefinition({ ...eachDef, limits: { max_usd: 0.5, max_minutes: null } }, { history: EMPTY }).overBudget, 'optimistic 0.65 reaches a $0.5 budget');
  });

  test('history prices a start: the step first, then the agent anywhere; the estimator sizes and counts the rest', () => {
    const history = {
      calls: [
        { workflow: 'wf', step: 'plan', role: 'agent', agent: 'planner', costUsd: 0.2 },
        { workflow: 'wf', step: 'plan', role: 'agent', agent: 'planner', costUsd: 0.4 },
        { workflow: 'wf', step: 'plan', role: 'agent', agent: 'planner', costUsd: 0.3 },
        { workflow: 'other', step: 'x', role: 'agent', agent: 'writer', costUsd: 1 },
      ],
      runs: [{ workflow: 'wf', steps: [{ id: 'write', items: [{}, {}, {}] }] }, { workflow: 'wf', steps: [{ id: 'write', items: [{}, {}, {}, {}, {}] }] }],
    };
    const e = estimateMod.estimateDefinition(eachDef, { history });
    eq([e.steps[0].perStart.agent, e.steps[0].basis], [[0.2, 0.4], 'history of this step (3)'], 'three samples: the observed range as is');
    eq(e.steps[1].perStart.agent, [0.5, 2], 'one sample of the agent elsewhere, widened');
    eq([e.steps[1].items.low, e.steps[1].items.high, e.steps[1].items.basis], [3, 5, 'earlier runs (2)']);
    const ai = estimateMod.parseAiAnswer('ok\n```json\n{"steps":[{"id":"write","size":"xl","checkSize":"M","attempts":{"high":9},"items":{"low":2,"high":40},"why":"w"}]}\n```');
    const f = estimateMod.estimateDefinition(eachDef, { history: EMPTY, ai });
    eq([f.steps[1].items.low, f.steps[1].items.high, f.steps[1].starts], [2, 10, [4, 60]], 'targets and attempts are clamped to what the definition allows');
    eq(f.steps[1].perStart, { agent: [3, 8], checker: [0.3, 1] }, 'sizes are read case-insensitively');
    eq(estimateMod.parseAiAnswer('no json here'), null);
    eq(estimateMod.parseAiAnswer('{"steps":[{"id":"a","size":"S"}]}').steps[0].size, 'S', 'a bare object is read too');
  });

  // ------------------------------------------------------ estimate learning
  suite('workflow: estimate learning');

  test('a cost converts between models; unknown models convert 1:1', () => {
    eq(estimateMod.modelFactor('sonnet', 'opus'), 2, 'Opus 5.5 is twice Sonnet 5.5');
    eq(estimateMod.modelFactor('claude-sonnet-5-5', 'claude-haiku-5-5'), 0.05);
    eq(estimateMod.modelFactor('claude-sonnet-4-6', 'claude-sonnet-5-5'), 2 / 3);
    eq(estimateMod.modelFactor('mystery', 'opus'), 1);
    eq(estimateMod.modelFactor(null, 'opus'), 1);
    const history = { calls: [1, 2, 3].map(() => ({ workflow: 'wf', step: 'plan', role: 'agent', agent: 'planner', model: 'sonnet', costUsd: 0.2 })), runs: [] };
    const onOpus = estimateMod.estimateDefinition(eachDef, { history, models: { planner: 'opus' } });
    eq(onOpus.steps[0].perStart.agent, [0.4, 0.4], 'Sonnet history priced for an Opus run');
    eq(estimateMod.estimateDefinition(eachDef, { history: EMPTY, models: { planner: 'haiku' } }).steps[0].perStart.agent, [0.015, 0.05], 'size M on Haiku');
  });

  const recordOf = (runId, steps) => ({
    schemaVersion: 1, workflow: 'wf', runId, startedAt: runId, done: true,
    estimate: { steps: steps.map((x) => ({ id: x.id, agent: 'planner', size: x.size || 'M', usd: x.usd, basis: 'size M' })) },
    steps: steps.map((x) => ({ id: x.id, kind: 'agent', ok: true, attempts: 1, starts: 1, costUsd: x.actual })),
    calls: steps.map((x) => ({ step: x.id, role: 'agent', agent: 'planner', model: 'sonnet', costUsd: x.actual })),
  });
  const historyOf = (records) => {
    const calls = records.flatMap((r) => r.calls.map((c) => ({ ...c, workflow: r.workflow, runId: r.runId })));
    return { calls, runs: [], records };
  };

  test('calibration: the ranges widen until 80% of past steps fall inside; sizes are priced from this package', () => {
    const records = [0.5, 0.6, 0.9, 1.4, 2.5].map((actual, i) => recordOf(`r${i}`, [{ id: `s${i}`, usd: [0.3, 1], actual }]));
    const cal = estimateMod.calibrate(historyOf(records));
    eq([cal.pairs, cal.inside, cal.misses.length], [5, 3, 2]);
    eq(cal.widen, 1.5, '1.4 is inside 1 x 1.5; 2.5 stays out, and 4 of 5 is enough');
    eq(cal.sizes.M.n, 5, 'five starts estimated at size M');
    eq(cal.sizes.M.range, [0.5, 2.5], 'fewer than 10 samples: their whole range');
    const est = estimateMod.estimateDefinition(eachDef, { history: { ...historyOf(records), calls: [] }, calibration: cal });
    eq(est.steps[0].perStart.agent, [0.3333, 3.75], 'size M learned here (0.5–2.5), widened x1.5');
    ok(/size M in this package \(5\)/.test(est.steps[0].basis), est.steps[0].basis);
    eq(estimateMod.calibrate(historyOf(records.slice(0, 4))).widen, 1, 'below five pairs nothing is widened');
  });

  test('priors from the review: an agent prior first, then a kind prior; a review is due after three misses', () => {
    const priors = { priors: [
      { agent: 'planner', role: 'agent', perStart: [0.1, 0.2] },
      { kind: 'write-tests', role: 'agent', perStart: [1, 2] },
    ] };
    const ai = { steps: [{ id: 'write', kind: 'write-tests' }] };
    const e = estimateMod.estimateDefinition(eachDef, { history: EMPTY, priors, ai, models: { writer: 'opus' } });
    eq([e.steps[0].perStart.agent, e.steps[0].basis], [[0.1, 0.2], 'review of agent planner; checker: size S'.split(';')[0]]);
    eq([e.steps[1].perStart.agent, e.steps[1].basis.split(';')[0]], [[2, 4], 'review of write-tests work'], 'a kind prior on Opus');
    const misses = [0.5, 5, 6, 7].map((actual, i) => recordOf(`m${i}`, [{ id: 'plan', usd: [0.3, 1], actual }]));
    eq(estimateMod.reviewDue(historyOf(misses.slice(0, 3)), { priors: [] }).due, false, 'two misses');
    const due = estimateMod.reviewDue(historyOf(misses), { priors: [] });
    eq([due.due, due.misses.length], [true, 3]);
    eq(estimateMod.reviewDue(historyOf(misses), { priors: [], reviewedThrough: misses.map((r) => `wf/${r.runId}`) }).due, false, 'reviewed runs do not count again');
    ok(/m1 step plan: agent planner; size M; model sonnet; estimated \$0\.3–\$1 \(size M\); actual \$5 in 1 start\(s\), 1 attempt\(s\) — ABOVE/.test(estimateMod.reviewLines(misses).join('\n')), estimateMod.reviewLines(misses)[1]);
  });

  test('the review answer is checked and kept on the reference model', () => {
    const r = estimateMod.parseReview('Looked.\n```json\n' + JSON.stringify({ priors: [
      { agent: 'planner', role: 'agent', model: 'opus', perStart: [1, 2], why: 'dear' },
      { kind: 'fix', role: 'until', perStart: [0.1, 0.3] },
      { kind: 'nonsense', perStart: [1, 2] },
      { agent: 'x', perStart: [3, 1] },
      { agent: 'Bad Name', perStart: [1, 2] },
    ], notes: '- planner is dear' }) + '\n```');
    eq(r.priors, [
      { agent: 'planner', role: 'agent', perStart: [0.5, 1], why: 'dear' },
      { kind: 'fix', role: 'until', perStart: [0.1, 0.3], why: '' },
    ], 'Opus prices are halved to Sonnet; unknown kinds, upside-down ranges and bad names are dropped');
    eq(r.notes, '- planner is dear');
    eq(estimateMod.parseReview('no json'), null);
  });

  test('a run record keeps the estimate, the agent steps and every start, and nothing of the prompts', () => {
    const rec = estimateMod.buildRecord({
      name: 'wf', runId: 'r1', hash: 'sha256:x', startedAt: 't', done: true, costUsd: 0.3,
      estimate: { steps: [{ id: 'plan', usd: [0.3, 1] }] },
      steps: [{ id: 'plan', kind: 'agent', ok: true, attempts: 2, report: 'secret report' }, { id: 'pr', kind: 'pull-request', ok: true },
        { id: 'w', kind: 'agent', ok: true, attempts: 3, items: [{ item: 'a', ok: true }, { item: 'b', failed: true }] }],
      calls: [{ step: 'plan', role: 'agent', agent: 'planner', attempt: 1, tool: 'claude', model: 'sonnet', actualModel: 'claude-sonnet-5-5', ok: true, costUsd: 0.1, durationMs: 5, tokens: { input: 1 } },
        { step: 'plan', role: 'agent', agent: 'planner', attempt: 2, tool: 'claude', model: 'sonnet', ok: true, costUsd: 0.2, durationMs: 5 }],
    }, { kitVersion: '9.9.9' });
    eq(rec.steps, [{ id: 'plan', kind: 'agent', ok: true, attempts: 2, starts: 2, costUsd: 0.3 }, { id: 'w', kind: 'agent', ok: true, attempts: 3, starts: 0, costUsd: null, items: 2, failed: 1 }]);
    eq([rec.kitVersion, rec.calls[0].actualModel, rec.calls[0].tokens], ['9.9.9', 'claude-sonnet-5-5', { input: 1 }]);
    ok(!JSON.stringify(rec).includes('secret report'), 'reports are not copied');
    const pairs = estimateMod.estimatePairs([{ ...rec, workflow: 'wf' }]);
    eq(pairs.map((x) => [x.step, x.lo, x.hi, x.actual]), [['plan', 0.3, 1, 0.3]]);
  });

  {
    // The learning loop end to end: runs write records, the third miss starts the reviewer.
    const fx = makeRepo({ hosting: 'generic' });
    const tmp = stubDir();
    const stub = writeToolStub(tmp);
    const promptOut = path.join(tmp, 'prompt.txt');
    const argvOut = path.join(tmp, 'argv.json');
    const env = (extra = {}) => ({ AIDEV_CLAUDE_BIN: stub, STUB_PROMPT_OUT: promptOut, STUB_ARGV_OUT: argvOut, ...extra });
    write(path.join(fx.root, '.aidev', 'agents', 'coder.md'), '---\nname: coder\ndescription: writes code for tests\n---\n\nYou are the coder.\n');
    write(path.join(fx.root, '.aidev', 'workflows', 'learn', 'workflow.yaml'), yamlOf('learn', { cost: 500, steps: ['  - id: work', '    agent: coder', '    prompt: do it'] }));
    approve(fx, 'workflow learn');
    // A run writes its record in its worktree (aidev/learn).
    const learnTree = () => require('../cli/lib/runtree').listWorktrees(fx.root).find((x) => x.branch === 'aidev/learn').path;
    const recordsDir = () => path.join(learnTree(), '.aidev', 'estimates', 'records');
    const answer = 'Done.\n```json\n' + JSON.stringify({ priors: [{ agent: 'coder', role: 'agent', model: 'sonnet', perStart: [2, 60], why: 'swings widely' }], notes: '- coder costs swing widely' }) + '\n```';
    try {
      test('every run writes a record of its estimate and its cost; the third run outside its range starts the reviewer', () => {
        const costs = [5, 0.5, 50];
        const outs = costs.map((c) => {
          fs.rmSync(promptOut, { force: true });
          const r = aidev(fx.root, ['run', 'workflow', 'learn', '--json'], { env: env({ STUB_COST: String(c), STUB_REVIEW_ANSWER: answer }) });
          eq(r.code, 0, r.out);
          return lastJson(r.out);
        });
        const files = fs.readdirSync(recordsDir()).sort();
        eq(files.length, 3, files.join(', '));
        const first = JSON.parse(fs.readFileSync(path.join(recordsDir(), files[0]), 'utf8'));
        eq([first.workflow, first.done, first.steps[0].costUsd, first.estimate.steps[0].usd], ['learn', true, 5, [0.3, 1]], 'estimated by size M, cost 5');
        eq([first.calls[0].actualModel, first.calls[0].tokens.cacheRead], ['claude-sonnet-5-5', 300], 'the tool reported model and tokens are kept');
        eq(outs[1].estimate.steps[0].usd, [2.5, 10], 'the second run is estimated from the first');
        eq([outs[0].estimateReview, outs[1].estimateReview], [null, null], 'one and two misses: no review yet');
        eq([outs[2].estimateReview.ok, outs[2].estimateReview.priors], [true, 1], 'the third miss starts the reviewer');
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        eq(a.slice(a.indexOf('--tools') + 1), ['Read', 'Glob', 'Grep'], 'the reviewer reads and writes nothing itself');
        const prompt = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean).pop();
        ok(/# Agent: estimate-reviewer/.test(prompt) && /step work: agent coder; size M; model claude-sonnet-5-5; estimated \$0\.3–\$1 \(size M\); actual \$5/.test(prompt), prompt.slice(0, 1200));
        const priors = JSON.parse(fs.readFileSync(path.join(learnTree(), '.aidev', 'estimates', 'priors.json'), 'utf8'));
        eq([priors.priors, priors.reviewedThrough.length], [[{ agent: 'coder', role: 'agent', perStart: [2, 60], why: 'swings widely' }], 3]);
        ok(/coder costs swing widely/.test(fs.readFileSync(path.join(learnTree(), '.aidev', 'estimates', 'notes.md'), 'utf8')));
      });

      test('estimate shows the calibration and the priors; --review runs the reviewer on demand; review: off turns it off', () => {
        const r = aidev(fx.root, ['estimate', 'workflow', 'learn', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.history.records, j.priors, j.calibration.pairs], [3, 1, 3]);
        const none = aidev(fx.root, ['estimate', 'workflow', 'learn', '--review', '--json'], { env: env({ STUB_REVIEW_ANSWER: answer }) });
        eq([lastJson(none.out).review.ok, lastJson(none.out).review.reason], [false, 'there is no new record to review']);
        write(path.join(fx.root, 'aidev.yaml'), fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8') + 'estimates:\n  review: off\n');
        for (const c of [70, 0.001, 900]) {
          const run = aidev(fx.root, ['run', 'workflow', 'learn', '--json'], { env: env({ STUB_COST: String(c), STUB_REVIEW_ANSWER: answer }) });
          eq(lastJson(run.out).estimateReview, null, 'estimates.review: off');
        }
        const now = aidev(fx.root, ['estimate', 'workflow', 'learn', '--review', '--json'], { env: env({ STUB_REVIEW_ANSWER: answer }) });
        eq(lastJson(now.out).review.ok, true, '--review reviews the new records even when the automatic review is off');
      });
    } finally {
      fx.cleanup();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------- modify
  suite('workflow: modify');

  {
    const fx = makeRepo({ hosting: 'generic' });
    const tmp = stubDir();
    const stub = writeToolStub(tmp);
    const promptOut = path.join(tmp, 'prompt.txt');
    const wfRel = '.aidev/workflows/fix/workflow.yaml';
    const original = yamlOf('fix', { steps: ['  - id: work', '    agent: coder', '    prompt: do it'] });
    const env = (extra = {}) => ({ AIDEV_CLAUDE_BIN: stub, STUB_PROMPT_OUT: promptOut, ...extra });
    write(path.join(fx.root, '.aidev', 'agents', 'coder.md'), '---\nname: coder\ndescription: writes code\n---\n\nYou are the coder.\n');
    write(path.join(fx.root, ...wfRel.split('/')), original);
    write(path.join(fx.root, '.aidev', 'workflows', 'other', 'workflow.yaml'), yamlOf('other', { steps: ['  - id: x', '    agent: coder', '    prompt: other work'] }));
    approve(fx, 'two workflows sharing coder');
    try {
      test('modify needs an existing workflow and --describe; --dry-run starts nothing', () => {
        ok(/no such workflow: nope/.test(aidev(fx.root, ['modify', 'workflow', 'nope', '--describe', 'x']).out));
        ok(/needs --describe/.test(aidev(fx.root, ['modify', 'workflow', 'fix']).out));
        const dry = aidev(fx.root, ['modify', 'workflow', 'fix', '--describe', 'add a review', '--dry-run', '--json'], { env: env() });
        eq(dry.code, 0, dry.out);
        eq(lastJson(dry.out).shared, { coder: ['other'] }, 'coder is shared with the other workflow');
        ok(!fs.existsSync(promptOut), 'no agent was started');
      });

      test('the workflow-creator edits in place from the current YAML; the change is validated and the old file kept', () => {
        const edited = original.replace('prompt: do it', 'prompt: do it carefully');
        const r = aidev(fx.root, ['modify', 'workflow', 'fix', '--describe', 'be careful', '--json'], { env: env({ STUB_WRITE_FILE: wfRel, STUB_WRITE_TEXT: edited }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.ok, j.changed, j.added, j.problem], [true, [wfRel], [], null]);
        eq(fs.readFileSync(path.join(fx.root, ...j.backup.split('/'), ...wfRel.split('/')), 'utf8'), original, 'the previous file is kept under .aidev/cache/modify/');
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(/# Agent: workflow-creator/.test(prompt) && /# Modify the workflow "fix"/.test(prompt), prompt.slice(0, 200));
        ok(/## What the team wants changed\n\nbe careful/.test(prompt));
        ok(prompt.includes('## The current workflow.yaml\n\n```yaml\n' + original.trimEnd()), 'the agent starts from the current definition');
        ok(/shared with other workflows[\s\S]*- coder \(\.aidev\/agents\/coder\.md\): also used by other/.test(prompt), 'it is told not to edit the shared agent');
        eq(lastJson(aidev(fx.root, ['list', 'workflows', '--json']).out).workflows.find((w) => w.name === 'fix').status, 'changed since origin/main',
          'a modified workflow needs a new review');
      });

      test('a result that does not validate, an edited shared agent, or no change at all is reported', () => {
        fs.rmSync(promptOut, { force: true });
        const broken = aidev(fx.root, ['modify', 'workflow', 'fix', '--describe', 'x', '--json'], { env: env({ STUB_WRITE_FILE: wfRel, STUB_WRITE_TEXT: 'name: fix\nsteps: []\n' }) });
        eq(broken.code, 1, broken.out);
        ok(/objective is required/.test(lastJson(broken.out).problem), broken.out);
        write(path.join(fx.root, ...wfRel.split('/')), original);
        const shared = aidev(fx.root, ['modify', 'workflow', 'fix', '--describe', 'x', '--json'],
          { env: env({ STUB_WRITE_FILE: '.aidev/agents/coder.md', STUB_WRITE_TEXT: '---\nname: coder\ndescription: changed\n---\n' }) });
        eq(lastJson(shared.out).editedShared, ['coder'], shared.out);
        const none = aidev(fx.root, ['modify', 'workflow', 'fix', '--describe', 'x'], { env: env() });
        eq(none.code, 1, none.out);
        ok(/the agent changed nothing/.test(none.out), none.out);
      });

      test('modify --from-run hands the agent why the run failed, and submit puts the why and the what in the pull request', () => {
        // A run that fails on one error again and again.
        write(path.join(fx.root, 'tools', 'fail.js'), "console.log('TypeError: cannot read properties of undefined (reading \\'id\\')'); process.exit(1);\n");
        const flakyRel = '.aidev/workflows/flaky/workflow.yaml';
        const flaky = yamlOf('flaky', { steps: ['  - id: build', '    agent: coder', '    prompt: build it', '    until:', '      command: node tools/fail.js', '      max_retries: 2'] });
        write(path.join(fx.root, ...flakyRel.split('/')), flaky);
        approve(fx, 'workflow flaky');
        const run = aidev(fx.root, ['run', 'workflow', 'flaky', '--json'], { env: env() });
        eq(run.code, 1, run.out);
        const failed = lastJson(run.out);
        ok(/same failure repeated/.test(failed.stopReason), failed.stopReason);
        ok(/aidev modify workflow flaky --from-run /.test(run.out), 'the run says how to have it fixed');

        ok(/--from-run takes a run id/.test(aidev(fx.root, ['modify', 'workflow', 'flaky', '--from-run', '../x']).out));
        ok(/no run 2020-01-01T00-00-00-000Z of workflow flaky/.test(aidev(fx.root, ['modify', 'workflow', 'flaky', '--from-run', '2020-01-01T00-00-00-000Z']).out));
        const dry = aidev(fx.root, ['modify', 'workflow', 'flaky', '--from-run', 'last', '--dry-run', '--json'], { env: env() });
        eq([lastJson(dry.out).fromRun.runId, lastJson(dry.out).fromRun.repeated, lastJson(dry.out).fromRun.step], [failed.runId, true, 'build']);

        fs.rmSync(promptOut, { force: true });
        const fixed = flaky.replace('prompt: build it', 'prompt: build it; the records have no id until they are saved, so save first');
        const answer = 'CAUSE: the agent read an id the records do not have before they are saved.\n\n- step build: the prompt says to save first.';
        const m = aidev(fx.root, ['modify', 'workflow', 'flaky', '--from-run', failed.runId, '--json'],
          { env: env({ STUB_WRITE_FILE: flakyRel, STUB_WRITE_TEXT: fixed, STUB_ANSWER: answer }) });
        eq(m.code, 0, m.out);
        const mj = lastJson(m.out);
        eq([mj.fromRun.runId, mj.cause], [failed.runId, 'the agent read an id the records do not have before they are saved.']);
        const prompt = fs.readFileSync(promptOut, 'utf8');
        ok(prompt.includes(`## What the team wants changed\n\nFix what made run ${failed.runId} fail`), 'without --describe the task is the fix');
        ok(prompt.includes(`## The run to learn from: ${failed.runId}`) && /same error again and again/.test(prompt), 'it is told what to look for');
        ok(/run \S+: stopped — step build: the same failure repeated/.test(prompt), 'the stop reason');
        ok(/last check log \([^)]*logs\/build\.\d+\.1\.log, end\):\n```\n\$ node tools\/fail\.js[\s\S]*TypeError: cannot read properties of undefined/.test(prompt), 'the failing check\'s own output');
        ok(/Start your final message with one line: CAUSE:/.test(prompt));
        const note = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'cache', 'modify', 'flaky.json'), 'utf8'));
        eq([note.fromRun.runId, note.fromRun.repeated, note.changed], [failed.runId, true, [flakyRel]]);

        // submit: the pull request says why the workflow changed, from which run, and what changed.
        const sub = aidev(fx.root, ['submit', 'workflow', 'flaky', '--no-push', '--json'], { env: env() });
        eq(sub.code, 0, sub.out);
        const sj = lastJson(sub.out);
        eq(sj.description, '.aidev/cache/submit/flaky.md');
        const body = fs.readFileSync(path.join(fx.root, ...sj.description.split('/')), 'utf8');
        ok(/## Why this change\n\nAsked of `aidev modify`: Fix what made run/.test(body), body);
        ok(body.includes(`It fixes what stopped run \`${failed.runId}\`: step build: the same failure repeated`), body);
        ok(/The agent met the same failure again and again/.test(body) && /```text\n[\s\S]*TypeError: cannot read properties/.test(body), 'the failure as recorded');
        ok(/\*\*Cause, as the workflow-creator agent found it:\*\* the agent read an id/.test(body), 'the cause');
        ok(/## What changed against the approved workflow\n\n- step `build` changed: `prompt`/.test(body), 'what changed, step by step');
        ok(/## Estimate\n\n\$[\d.]+ – \$[\d.]+ before → \$[\d.]+ – \$[\d.]+ now/.test(body), 'the estimate before and after');
        ok(/- `\.aidev\/workflows\/flaky\/workflow\.yaml` \(changed\)/.test(body), 'which files changed');
        git(['checkout', '-q', 'main'], fx.root);

        // A step-level account of a change, without a modify note.
        const { definitionChanges } = require('../cli/commands/workflow');
        const a = wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'x', command: 'npm test' }, { id: 'a', agent: 'issue-to-pr', writable: ['src/**'], prompt: 'go' }] }, 'wf');
        const b = wfMod.validateDefinition({ ...GOOD, limits: { max_usd: 3 }, steps: [{ id: 'a', agent: 'issue-to-pr', writable: ['lib/**'], prompt: 'go', until: { command: 'npm test', max_retries: 1 } }, { id: 'y', command: 'npm run lint' }] }, 'wf');
        eq(definitionChanges(a, b), ['- step `a` changed: `writable`, `until`, `until.max_retries`', '- step `y` added (command)', '- step `x` removed', '- limits changed', '  limits: $1, no time limit → $3, no time limit']);
      });
    } finally { fx.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  suite('workflow: 2.0.0 definitions converted by scripts/convert-workflow-v2.ps1');
  {
    // PowerShell is not everywhere the suite runs; without it this suite says so and checks nothing.
    const { spawnSync } = require('child_process');
    const pwsh = ['pwsh', 'powershell'].find((b) => {
      try { return spawnSync(b, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0; } catch { return false; }
    });
    if (!pwsh) {
      console.log('  --  skipped: no pwsh or powershell on PATH');
    } else {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-convert-'));
      const script = path.join(KIT_ROOT, 'scripts', 'convert-workflow-v2.ps1');
      const convert = (...args) => spawnSync(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8' });
      const V2 = [
        '# kept as it is', 'name: e2e', 'objective: |', '  Add tests.', '', 'steps:',
        '  - id: write', '    agent: coder', '    writable: [src/**]', '    prompt: go',
        '    max_retries: 2   # short', '    timeout_ms: 90000', '    until:', '      command: npm test', '      agent: reviewer',
        '      prompt: |', '        covered?', '',
        '  - id: quick', '    agent: coder', '    writable: []', '    prompt: go', '    until: { command: npm test }', '    max_retries: 1',
        '  - kind: pull-request', '    id: pr', '    title: "test: add"', '',
        'cost:', '  max_usd: 10   # budget', '',
      ].join('\n');
      try {
        test('the 2.0.0 keys are rewritten in place, comments and the rest kept, and the result validates', () => {
          const file = path.join(tmp, 'e2e', 'workflow.yaml');
          write(file, V2);
          const r = convert('-Path', file);
          eq(r.status, 0, r.stdout + r.stderr);
          const text = fs.readFileSync(file, 'utf8');
          ok(text.startsWith('# kept as it is\nname: e2e\n'), text);
          ok(text.includes('    timeout_minutes: 1.5\n'), text);
          ok(text.includes('        covered?\n      max_retries: 2   # short\n'), text);
          ok(text.includes('    until: { command: npm test, max_retries: 1 }\n'), text);
          ok(text.includes('  - pull_request:\n      title: "test: add"\n    id: pr\n'), text);
          ok(text.endsWith('limits:\n  max_usd: 10   # budget\n  max_minutes: 60\n'), text);
          const def = wfMod.parseDefinitionText(text, 'e2e');
          eq([def.steps[0].timeout_ms, def.steps[0].max_retries, def.steps[1].max_retries, def.steps[2].title, def.limits],
            [90000, 2, 1, 'test: add', { max_usd: 10, max_minutes: 60 }]);
          const again = convert('-Path', file);
          eq(again.status, 0);
          ok(/already in the current format/.test(again.stdout), again.stdout);
          eq(fs.readFileSync(file, 'utf8'), text, 'a second run changes nothing');
        });

        test('-WhatIf writes nothing, and a result that does not validate is not written', () => {
          const file = path.join(tmp, 'dry', 'workflow.yaml');
          write(file, V2.replace('name: e2e', 'name: dry'));
          const r = convert('-Path', file, '-WhatIf', '-NoTimeLimit');
          eq(r.status, 0, r.stdout + r.stderr);
          eq(fs.readFileSync(file, 'utf8'), V2.replace('name: e2e', 'name: dry'));
          ok(!/max_minutes/.test(r.stdout), '-NoTimeLimit adds no time limit');
          const bad = path.join(tmp, 'bad', 'workflow.yaml');
          const badText = 'name: bad\nobjective: x\ncost: { max_usd: 2 }\nsteps:\n  - id: a\n    agent: coder\n    prompt: go\n';
          write(bad, badText);
          const b = convert('-Path', bad);
          eq(b.status, 1, b.stdout);
          ok(/writable is required for an agent step/.test(b.stdout), b.stdout);
          eq(fs.readFileSync(bad, 'utf8'), badText);
        });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
