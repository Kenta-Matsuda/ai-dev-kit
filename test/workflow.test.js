'use strict';
/**
 * `aidev workflow` — the development command.
 *
 * What these suites pin down:
 *
 *   - a definition is YAML only; the validator enforces the mandatory valves
 *     (time ceiling, bounded retries, a USD budget, shell-free commands, no
 *     protected path in scope) and rejects anything the runner cannot execute
 *   - "approved" means identical to origin/<tracking_branch>: a workflow that
 *     was never merged, or was edited since, is refused by `run`; `submit`
 *     puts it on a branch of its own, and a merge makes it approved
 *   - `run` executes the steps in order through the configured tool with the
 *     agent definition inlined, bounds the `until` loop, stops on a repeated
 *     failure and on the cost budget, records the run, and hands
 *     AIDEV_WORKFLOW to the tool so the write guard can apply scope.writable
 *   - a pull-request step commits only the scope, on its own branch, and
 *     pushes it (the PR itself needs Azure DevOps and is reported, not made)
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
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ AIDEV_WORKFLOW: process.env.AIDEV_WORKFLOW || null }));
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
  process.stdout.write(JSON.stringify({ type: 'result', result: 'stub answer', is_error: false, total_cost_usd: 0.0123, session_id: 's' }) + '\\n');
});
`, 'utf8');
  return p;
}

const GOOD = {
  name: 'wf', objective: 'do the thing', scope: { writable: ['src/**'] },
  steps: [{ id: 'a', agent: 'issue-to-pr', prompt: 'go' }], cost: { max_usd: 1 },
};

function yamlOf(name, { scope = 'src/**', steps, extra = [], cost = 1, minutes = 5 } = {}) {
  return [
    `name: ${name}`, 'description: "test workflow"', 'objective: |', '  Make the thing work.',
    'scope:', `  writable: [${scope}]`, ...extra, 'steps:', ...steps,
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

  test('a valid definition normalises steps, agents, limits and cost', () => {
    const d = wfMod.validateDefinition({ ...GOOD, agents: ['test-writer'], skills: ['test-and-verify'], tool: 'claude', model: '' }, 'wf');
    eq(d.agents, ['test-writer', 'issue-to-pr'], 'the step agent is added to agents');
    eq(d.skills, ['test-and-verify']);
    eq([d.tool, d.model], ['claude', null]);
    eq(d.steps[0], { id: 'a', kind: 'agent', agent: 'issue-to-pr', prompt: 'go', until: null, max_retries: 0, timeout_ms: null });
    eq(d.limits, { max_minutes: 60 });
    eq(d.cost, { max_usd: 1 });
    const u = wfMod.validateDefinition({ ...GOOD, steps: [{ agent: 'x', prompt: 'p', until: 'npm test' }, { command: 'npm run lint' }, { kind: 'pull-request', title: 't' }] }, 'wf');
    eq(u.steps.map((s) => s.id), ['step-1', 'step-2', 'step-3'], 'ids default from position');
    eq(u.steps[0].until, { text: 'npm test', argv: ['npm', 'test'] });
    eq(u.steps[0].max_retries, 3, 'an until step retries 3 times by default');
    eq(u.steps[1].command.argv, ['npm', 'run', 'lint']);
    eq(u.steps[2], { id: 'step-3', kind: 'pull-request', title: 't' });
  });

  test('the mandatory valves cannot be omitted or raised', () => {
    throws(() => wfMod.validateDefinition({ ...GOOD, objective: '' }, 'wf'), /objective is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: undefined }, 'wf'), /scope is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: {} }, 'wf'), /scope\.writable is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: { writable: ['.aidev/policy.yaml'] } }, 'wf'), /protected path/);
    throws(() => wfMod.validateDefinition({ ...GOOD, scope: { writable: ['.claude/**'] } }, 'wf'), /protected path/);
    throws(() => wfMod.validateDefinition({ ...GOOD, cost: {} }, 'wf'), /cost\.max_usd is required/);
    throws(() => wfMod.validateDefinition({ ...GOOD, limits: { max_minutes: 61 } }, 'wf'), /above the hard ceiling of 60/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ agent: 'x', prompt: 'p', until: 'npm test', max_retries: 11 }] }, 'wf'), /above the hard ceiling of 10/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ agent: 'x', prompt: 'p', max_retries: 2 }] }, 'wf'), /needs an until command/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ agent: 'x', prompt: 'p', until: 'npm test | tee log' }] }, 'wf'), /without a shell/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ command: 'echo "hi" > out' }] }, 'wf'), /without a shell/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ agent: 'x', prompt: 'p', command: 'npm test' }] }, 'wf'), /exactly one of agent, command or kind/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'shell' }] }, 'wf'), /kind must be "pull-request"/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ id: 'a', agent: 'x', prompt: 'p' }, { id: 'a', command: 'npm test' }] }, 'wf'), /duplicate step id/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ kind: 'pull-request' }, { kind: 'pull-request' }] }, 'wf'), /at most one pull-request/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [] }, 'wf'), /steps must be a non-empty list/);
    throws(() => wfMod.validateDefinition({ ...GOOD, tool: 'cursor' }, 'wf'), /not a supported tool/);
    throws(() => wfMod.validateDefinition({ ...GOOD, model: '-p' }, 'wf'), /model/);
    throws(() => wfMod.validateDefinition({ ...GOOD, steps: [{ agent: '../x', prompt: 'p' }] }, 'wf'), /agent/);
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
          '  - id: think', '    agent: coder', '    prompt: think first',
          '  - id: check', '    command: node --version',
          '  - id: act', '    agent: coder', '    prompt: now act', '    until: node --version',
        ] });
        reset();
        const r = aidev(fx.root, ['run', 'workflow', 'plain', '--task', 'add a login link', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.done, j.agentRuns, j.costUsd, j.task], [true, 2, 0.0246, 'add a login link']);
        eq(j.steps.map((s) => [s.id, s.ok, s.attempts]), [['think', true, 1], ['check', true, 1], ['act', true, 1]]);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        ok(!a.includes('--agent'), 'the definition is inlined, so no --agent flag: ' + a.join(' '));
        const prompts = fs.readFileSync(promptOut, 'utf8').split('\n=====\n').filter(Boolean);
        eq(prompts.length, 2);
        ok(/# Agent: coder/.test(prompts[0]) && /You are the coder\./.test(prompts[0]), 'the PKG agent definition is inlined');
        ok(/## Objective\n\nMake the thing work\./.test(prompts[0]), prompts[0].slice(0, 400));
        ok(/## Task for this run[\s\S]*add a login link/.test(prompts[0]), 'the task is handed over as data');
        ok(/## Step think \(1\/3\)\n\nthink first/.test(prompts[0]));
        ok(/Write only under: src\/\*\*/.test(prompts[0]), 'the scope is stated');
        ok(/Do not commit\. Leave the changes/.test(prompts[0]), 'no pull-request step: the tree is left for the person');
        ok(/## Step act \(3\/3\)/.test(prompts[1]) && /node --version` must exit 0/.test(prompts[1]));
        eq(JSON.parse(fs.readFileSync(envOut, 'utf8')), { AIDEV_WORKFLOW: 'plain' }, 'the write guard learns the workflow from the environment');
        const record = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'workflows', 'plain', 'runs', runsOf('plain')[0], 'run.json'), 'utf8'));
        eq([record.name, record.done, record.approvedRef, record.branch], ['plain', true, 'origin/main', null]);
        ok(/^sha256:/.test(record.hash));
      });

      test('an until command that keeps failing with the same output stops the step early', () => {
        define('loop', { steps: [
          '  - id: fix', '    agent: coder', '    prompt: fix it', '    until: node -e process.exit(3)', '    max_retries: 5',
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
          '  - id: make', '    command: node tools/touch.js',
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
