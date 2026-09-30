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
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ AIDEV_WORKFLOW: process.env.AIDEV_WORKFLOW || null, AIDEV_WORKFLOW_STEP: process.env.AIDEV_WORKFLOW_STEP || null }));
if (process.env.STUB_STEPS_OUT) fs.appendFileSync(process.env.STUB_STEPS_OUT, (process.env.AIDEV_WORKFLOW_STEP || '') + '\\n');
// An until agent (step "<id>:until") answers the next verdict from STUB_VERDICTS (a JSON list).
let answer = 'stub answer';
const step = process.env.AIDEV_WORKFLOW_STEP || '';
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
  if (process.env.STUB_PROMPT_OUT) fs.appendFileSync(process.env.STUB_PROMPT_OUT, stdin + '\\n=====\\n');
  if (process.env.STUB_MODE === 'fail') { process.stderr.write('stub: refused\\n'); process.exit(2); }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { content: [
    { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: process.cwd() + '/stub-read.md' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tu0', message: { content: [
    { type: 'tool_use', id: 'tu2', name: 'Glob', input: { pattern: 'stub/**' } }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', result: answer, is_error: false, total_cost_usd: 0.0123, session_id: 's' }) + '\\n');
});
`, 'utf8');
  return p;
}

const GOOD = {
  name: 'wf', objective: 'do the thing',
  steps: [{ id: 'a', agent: 'issue-to-pr', writable: ['src/**'], prompt: 'go' }], cost: { max_usd: 1 },
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
    'limits:', `  max_minutes: ${minutes}`, 'cost:', `  max_usd: ${cost}`, '',
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

  test('a valid definition normalises steps, agents, writable, limits and cost', () => {
    const d = wfMod.validateDefinition({ ...GOOD, tool: 'claude', model: '' }, 'wf');
    eq(d.agents, ['issue-to-pr'], 'the agents are the ones the steps name');
    eq([d.tool, d.model], ['claude', null]);
    eq(d.steps[0], { id: 'a', kind: 'agent', description: '', agent: 'issue-to-pr', prompt: 'go', writable: ['src/**'], unchanged: [], for_each: null, until: null, max_retries: 0, timeout_ms: null });
    const each = wfMod.validateDefinition(withStep({
      prompt: 'test {item}', unchanged: ['tests/**'], for_each: { from: 'targets.txt', max_items: 5 }, until: { command: 'npx playwright test {item}' },
    }), 'wf').steps[0];
    eq([each.unchanged, each.for_each], [['tests/**'], { from: 'targets.txt', max_items: 5 }]);
    const one = wfMod.forItem(each, 'e2e/login.spec.ts');
    eq([one.prompt, one.until.commands[0].argv], ['test e2e/login.spec.ts', ['npx', 'playwright', 'test', 'e2e/login.spec.ts']], '{item} is the target, one argv entry');
    eq(wfMod.parseItems('# screens\n\n- login\n* orders/list\nlogin\n  @scope/pkg  \n', each.for_each), ['login', 'orders/list', '@scope/pkg'],
      'one target per line; comments, blanks, list marks and repeats dropped');
    eq(d.limits, { max_minutes: 60 });
    eq(d.cost, { max_usd: 1 });
    const u = wfMod.validateDefinition({ ...GOOD, steps: [
      { agent: 'x', writable: [], prompt: 'p', description: 'look first' },
      { agent: 'x', writable: ['src/**'], prompt: 'p', until: { command: 'npm test' } },
      { command: 'npm run gen', writable: ['gen/**'] },
      { kind: 'pull-request', title: 't' },
    ] }, 'wf');
    eq(u.steps.map((s) => s.id), ['step-1', 'step-2', 'step-3', 'step-4'], 'ids default from position');
    eq(u.steps[0].description, 'look first');
    eq(u.steps[1].until, { commands: [{ text: 'npm test', argv: ['npm', 'test'] }], cwd: null, env: {}, timeout_ms: null, agent: null, prompt: null });
    const many = wfMod.validateDefinition(withStep({ until: {
      command: ['npm ci', 'npx playwright test'], cwd: 'e2e/', env: { CI: 1, BASE_URL: 'http://localhost:3000' }, timeout_ms: 600000,
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
    throws(() => wfMod.validateDefinition({ ...GOOD, cost: {} }, 'wf'), /cost\.max_usd is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { max_minutes: 61 } }, 'wf'), /above the hard ceiling of 60/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test' }, max_retries: 11 }), 'wf'), /above the hard ceiling of 10/);
    throws(() => wfMod.validateDefinition(withStep({ max_retries: 2 }), 'wf'), /needs an until/);
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
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', timeout_ms: 3600001 }] }, 'wf'), /above the hard ceiling of 3600000/);
    const FE = { from: 'targets.txt', max_items: 5 };
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: 'targets.txt' } }), 'wf'), /for_each\.max_items is required/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: 'targets.txt', max_items: 101 } }), 'wf'), /above the hard ceiling of 100/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { from: '../targets.txt', max_items: 5 } }), 'wf'), /name of a file in the run's notes directory/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do {item}', for_each: { ...FE, parallel: 2 } }), 'wf'), /for_each: unknown key parallel/);
    throws(() => wfMod.validateDefinition(withStep({ prompt: 'do it', for_each: FE }), 'wf'), /prompt must name its target as \{item\}/);
    throws(() => wfMod.validateDefinition(withStep({ until: { command: 'npm test {item}' } }), 'wf'), /\{item\} needs for_each/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test {item}' }] }, 'wf'), /belongs to an agent step with for_each/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'npm test', unchanged: ['tests/**'] }] }, 'wf'), /unchanged does not belong to a command step/);
    throws(() => wfMod.validateDefinition(withStep({ unchanged: ['../x'] }), 'wf'), /repo-relative/);
    eq(wfMod.validateDefinition(withStep({ unchanged: ['tests/**'], max_retries: 2 }), 'wf').steps[0].max_retries, 2, 'unchanged alone is a check worth retrying for');
    for (const bad of ['--config=evil.js', 'a b', '../up', 'x/../y', 'semi;colon', '$HOME']) {
      throws(() => wfMod.parseItems(`ok\n${bad}\n`, FE), /line 2: .* is not a target/);
    }
    throws(() => wfMod.parseItems('a\nb\nc\nd\ne\nf\n', FE), /lists 6 targets, above for_each\.max_items \(5\)/);
    throws(() => wfMod.validateDefinition(withStep({ command: 'npm test' }), 'wf'), /exactly one of agent, command or kind/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'shell' }] }, 'wf'), /kind must be "pull-request"/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'a', agent: 'x', writable: [], prompt: 'p' }, { id: 'a', command: 'npm test' }] }, 'wf'), /duplicate step id/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'pull-request' }, { kind: 'pull-request' }] }, 'wf'), /at most one pull-request/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [] }, 'wf'), /steps must be a non-empty list/);
    throws(() => wfMod.validateDefinition({ ...GOOD, tool: 'cursor' }, 'wf'), /not a supported tool/);
    throws(() => wfMod.validateDefinition({ ...GOOD, model: '-p' }, 'wf'), /model/);
    throws(() => wfMod.validateDefinition(withStep({ agent: '../x' }), 'wf'), /agent/);
  });

  test('a key the runner would ignore is refused, and the removed ones say where they went', () => {
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: { writable: ['src/**'] } }, 'wf'), /scope is not a workflow key; writable is written on each step/);
    throws(() => wfMod.validateDefinition({ ...GOOD, skills: ['x'] }, 'wf'), /skills is not a workflow key; an agent lists its skills in its own frontmatter/);
    throws(() => wfMod.validateDefinition({ ...GOOD, agents: ['x'] }, 'wf'), /agents is not a workflow key/);
    throws(() => wfMod.validateDefinition({ ...GOOD, retries: 3 }, 'wf'), /unknown key retries/);
    throws(() => wfMod.validateDefinition(withStep({ mcp: ['x'] }), 'wf'), /mcp does not belong to an agent step/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'pull-request', writable: ['src/**'] }] }, 'wf'), /writable does not belong to a pull-request step/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { minutes: 5 } }, 'wf'), /limits: unknown key minutes/);
  });

  test('an agent\'s frontmatter says what it can use: skills, tools and MCP servers', () => {
    eq(wfMod.agentCapabilities({}), { skills: [], tools: null, mcp: [] }, 'nothing listed: no skills, the default tools, no MCP');
    eq(wfMod.agentCapabilities({ skills: '[a, b]', tools: 'Read, Grep', mcp: '[tickets]' }),
      { skills: ['a', 'b'], tools: ['Read', 'Grep'], mcp: ['tickets'] });
    eq(wfMod.agentCapabilities({ tools: '[]', mcp: '' }).tools, null, 'an empty tools list means the default set');
    throws(() => wfMod.agentCapabilities({ tools: 'Read, rm -rf' }), /not a tool name/);
    throws(() => wfMod.agentCapabilities({ mcp: '[a__b]' }), /not an MCP server name/);
    throws(() => wfMod.agentCapabilities({ skills: '[../x]' }), /name/);
    const access = { tools: ['Read', 'Task'], mcp: ['tickets'] };
    eq(['Read', 'Agent', 'Task', 'Bash', 'mcp__tickets__get', 'mcp__billing__charge', 'mcp__odd']
      .map((t) => wfMod.toolGranted(access, t)), [true, true, true, false, true, false, false], 'Task and Agent are one grant');
    eq(wfMod.toolGranted({ tools: null, mcp: [] }, 'Bash'), true, 'no tools listed: the default set');
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
    const fx = makeRepo({ hosting: 'generic' });
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
    const runsOf = (name) => fs.readdirSync(path.join(fx.root, '.aidev', 'workflows', name, 'runs'));
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
        ok(/Do not commit\. Leave the changes/.test(prompts[0]), 'no pull-request step: the tree is left for the person');
        ok(/## Step act \(3\/3\)/.test(prompts[1]) && /node --version` must exit 0/.test(prompts[1]));
        ok(/Write only under: src\/\*\*/.test(prompts[1]), prompts[1]);
        ok(/## Reports from the earlier steps[\s\S]*### Step think \(agent coder\)\n\nstub answer/.test(prompts[1]),
          'the next agent step sees the report of the one before');
        eq(JSON.parse(fs.readFileSync(envOut, 'utf8')), { AIDEV_WORKFLOW: 'plain', AIDEV_WORKFLOW_STEP: 'act' },
          'the write guard learns the workflow and the step from the environment');
        const record = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'workflows', 'plain', 'runs', runsOf('plain')[0], 'run.json'), 'utf8'));
        eq([record.name, record.done, record.approvedRef, record.branch], ['plain', true, 'origin/main', null]);
        ok(/^sha256:/.test(record.hash));
      });

      test('an until command that keeps failing with the same output stops the step early', () => {
        define('loop', { steps: [
          '  - id: fix', '    agent: coder', '    prompt: fix it', '    until:', '      command: node -e process.exit(3)', '    max_retries: 5',
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
          '    max_retries: 3',
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

      test('a pull-request step needs a clean tree, commits only the scope on its own branch and pushes it', () => {
        write(path.join(fx.root, 'tools', 'touch.js'),
          "require('fs').mkdirSync('src/gen', { recursive: true }); require('fs').writeFileSync('src/gen/out.txt', 'made\\n'); require('fs').writeFileSync('notes.txt', 'outside\\n');\n");
        define('pr', { steps: [
          '  - id: make', '    command: node tools/touch.js', '    writable: [src/**]',
          '  - id: pr', '    kind: pull-request', '    title: "aidev: generated"',
        ] });
        write(path.join(fx.root, 'dirty.txt'), 'x\n');
        const dirty = aidev(fx.root, ['run', 'workflow', 'pr', '--json'], { env: env() });
        eq(dirty.code, 1);
        ok(/uncommitted changes/.test(dirty.out), dirty.out);
        fs.rmSync(path.join(fx.root, 'dirty.txt'));
        const r = aidev(fx.root, ['run', 'workflow', 'pr', '--task', 'make it', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        ok(/^aidev\/pr-\d{12}$/.test(j.branch), j.branch);
        eq(j.pr.ok, false, 'generic hosting: the PR is not created');
        ok(/by hand/.test(j.pr.reason), j.pr.reason);
        const pr = j.steps.find((s) => s.id === 'pr');
        ok(pr.ok && pr.pushed && pr.sha, JSON.stringify(pr));
        eq(git(['rev-parse', '--abbrev-ref', 'HEAD'], fx.root), j.branch, 'the run stays on its branch');
        eq(git(['show', '--stat', '--format=', 'HEAD'], fx.root).includes('src/gen/out.txt'), true, 'the scope was committed');
        ok(!git(['show', '--stat', '--format=', 'HEAD'], fx.root).includes('notes.txt'), 'a file outside the scope is not committed');
        ok(git(['log', '-1', '--format=%B'], fx.root).includes('aidev: generated') && git(['log', '-1', '--format=%B'], fx.root).includes('task:'), 'the commit carries the run record');
        ok(git(['ls-remote', '--heads', 'origin', j.branch], fx.root).includes(j.branch), 'pushed to origin');
        fs.rmSync(path.join(fx.root, 'notes.txt'), { force: true });
        git(['checkout', '-q', 'main'], fx.root);
        // Nothing inside the scope changes on a run whose steps write nothing: no commit, no branch pushed.
        define('quiet', { steps: ['  - id: noop', '    command: node --version', '  - id: pr', '    kind: pull-request'] });
        const none = aidev(fx.root, ['run', 'workflow', 'quiet', '--json'], { env: env() });
        eq(none.code, 0, none.out);
        const q = lastJson(none.out);
        eq([q.done, q.pr, q.steps[1].skipped], [true, null, true]);
        ok(!git(['ls-remote', '--heads', 'origin', q.branch], fx.root).includes(q.branch), 'no push without a commit');
        git(['checkout', '-q', 'main'], fx.root);
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
        fs.rmSync(path.join(fx.root, 'e2e', 'seen.flag'), { force: true });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.done, j.steps[0].attempts], [true, 2]);
        const logRel = `.aidev/workflows/cmds/runs/${j.runId}/logs/fix.1.2.log`;
        eq(j.steps[0].log, logRel, 'the record names the log of the failed check');
        const logText = fs.readFileSync(path.join(fx.root, logRel), 'utf8');
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
        const runDir = path.join(fx.root, '.aidev', 'workflows', 'long', 'runs', j1.runId);
        eq(fs.readFileSync(path.join(runDir, 'reports', 'plan.md'), 'utf8').trim(), 'stub answer', 'each finished step\'s whole report is kept');
        ok(/step act: "node tools\/gate\.js" exited 4/.test(fs.readFileSync(path.join(runDir, 'log.txt'), 'utf8')), 'the log is written as the run goes');
        const before = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/## Notes of this run\n\nDirectory: \.aidev\/workflows\/long\/runs\/[^/]+\/notes\/ \(empty so far\)/.test(before[0]), before[0]);
        ok(/\(and the notes directory above\)/.test(before[0]), 'a step may write the notes even when it writes no PKG file');

        ok(/do not pass --task/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', 'last', '--task', 'x'], { env: env() }).out));
        ok(/takes a run id/.test(aidev(fx.root, ['run', 'workflow', 'long', '--resume', '../x'], { env: env() }).out));
        // What the plan step would have left for the next one, and the fix that lets the check pass.
        write(path.join(runDir, 'notes', 'targets.md'), '- src/a.ts\n');
        write(path.join(fx.root, 'gate.flag'), '');
        reset();
        fs.rmSync(stepsOut, { force: true });
        const dry = aidev(fx.root, ['run', 'workflow', 'long', '--resume', 'last', '--dry-run'], { env: env() });
        ok(/resume\s+run \S+, from step act/.test(dry.out), dry.out);
        const second = aidev(fx.root, ['run', 'workflow', 'long', '--resume', j1.runId, '--json'], { env: env({ STUB_STEPS_OUT: stepsOut }) });
        fs.rmSync(path.join(fx.root, 'gate.flag'), { force: true });
        eq(second.code, 0, second.out);
        const j2 = lastJson(second.out);
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
          '  - id: pr', '    kind: pull-request',
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
        ok(/^\+changed$/m.test(fs.readFileSync(path.join(fx.root, diffRel), 'utf8')), 'the diff is written for the until agent to read');
        eq(j.pr.description, `.aidev/workflows/judged/runs/${j.runId}/pull-request.md`, 'generic hosting: the text is kept for a pull request opened by hand');
        const text = fs.readFileSync(path.join(fx.root, j.pr.description), 'utf8');
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
        git(['checkout', '-q', '--', 'src/locked.txt'], fx.root);
        eq(r.code, 1, r.out);
        const j = lastJson(r.out);
        ok(/same failure repeated \(1 path\(s\) that must stay unchanged were changed/.test(j.stopReason), j.stopReason);
        eq(j.agentRuns, 2);
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/- Leave unchanged: src\/locked\.txt\. The workflow compares them/.test(prompts[0]), prompts[0]);
        ok(/must leave these paths as they were when it started \(src\/locked\.txt\), and they differ now:\n\n```\nsrc\/locked\.txt\n```/.test(prompts[1]), prompts[1]);

        // A path that already differed from HEAD when the step started is held to that state, not to HEAD.
        define('kept', { steps: [
          '  - id: fix', '    agent: coder', '    unchanged: [src/locked.txt]', '    prompt: fix it',
          '    until:', '      command: node --version',
        ] });
        fs.writeFileSync(path.join(fx.root, 'src', 'locked.txt'), 'changed by an earlier step\n');
        const kept = aidev(fx.root, ['run', 'workflow', 'kept', '--json'], { env: env() });
        git(['checkout', '-q', '--', 'src/locked.txt'], fx.root);
        eq(kept.code, 0, kept.out);
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
          '    until:', '      command: node tools/screen.js {item}', '    max_retries: 1',
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

        write(path.join(fx.root, 'orders.flag'), '');
        reset();
        fs.rmSync(stepsOut, { force: true });
        const second = aidev(fx.root, ['run', 'workflow', 'each', '--resume', 'last', '--json'], { env: env({ STUB_STEPS_OUT: stepsOut }) });
        fs.rmSync(path.join(fx.root, 'orders.flag'), { force: true });
        eq(second.code, 0, second.out);
        const j2 = lastJson(second.out);
        const w2 = j2.steps.find((s) => s.id === 'write');
        eq(w2.items.map((x) => [x.item, x.ok]), [['login', true], ['orders/list', true], ['settings', true]]);
        eq(fs.readFileSync(stepsOut, 'utf8').trim().split('\n'), ['write', 'write', 'sum'], 'login was finished by the first start and is not done again');
        const after = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        ok(/## Your target: orders\/list \(2 of 3\)/.test(after[0]) && /## This run was resumed/.test(after[0]), after[0]);
        ok(/## Your target: settings \(3 of 3\)/.test(after[1]) && !/## This run was resumed/.test(after[1]), after[1]);
        ok(/### Step write \(agent coder\)\n\n3 target\(s\) from [^\n]+targets\.txt:\n\n- login: done[^\n]*\n {2}stub answer\n- orders\/list: done/.test(after[2]),
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
    } finally { fx.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
