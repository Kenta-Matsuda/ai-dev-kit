'use strict';
/**
 * Multi-tool agent launching.
 *
 * What these suites pin down:
 *
 *   - the tool registry, the kit-managed globs and the always-protected list
 *     agree on which files each tool's configuration occupies
 *   - aidev.yaml accepts N tools, and `tools.agents.<name>` overrides the
 *     tool/model per agent with the documented precedence
 *   - `aidev agent run` starts the configured tool with the documented argv:
 *     the prompt on stdin for Claude Code, a prompt file for the others, and
 *     the agent definition inlined for a tool without named agents
 *   - `ctx.agent()` inside a workflow is bounded by the workflow's budget
 *   - a tool listed in tools.default gets its derived configuration files,
 *     which are drift-checked and pruned again when the tool is removed
 *
 * Every tool binary is a stub reached through AIDEV_<TOOL>_BIN; nothing here
 * starts a real AI tool.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, ok, eq, throws } = require('./harness');
const { makeRepo, write } = require('./fixtures');
const { aidev, lastJson } = require('./completion.test');

const toolsMod = require('../cli/lib/tools');
const layout = require('../cli/lib/layout');
const cfgMod = require('../cli/lib/config');
const agentMod = require('../cli/lib/agent');
const assets = require('../cli/lib/assets');
const pathsMod = require('../cli/lib/paths');
const workflowMod = require('../cli/commands/workflow');

const KIT_ROOT = path.resolve(__dirname, '..');

/**
 * A stand-in for any tool binary. It records its argv, captures the prompt
 * (stdin, or the file the argv points at) and answers the way STUB_MODE says:
 * `json` like Claude Code's --output-format json, `text` like a plain CLI,
 * `fail` with a non-zero exit.
 */
function writeToolStub(root, name = 'fake-tool.js') {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(argv, null, 2));
if (process.env.STUB_ENV_OUT) fs.writeFileSync(process.env.STUB_ENV_OUT, JSON.stringify({ AIDEV_AGENT: process.env.AIDEV_AGENT || null }));
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  let prompt = stdin;
  const pointer = argv.map((a) => /in the file (\\S+)\\. Read it/.exec(a)).find(Boolean);
  if (pointer) { try { prompt = fs.readFileSync(pointer[1], 'utf8'); } catch (e) { prompt = 'UNREADABLE ' + e.message; } }
  if (process.env.STUB_PROMPT_OUT) fs.writeFileSync(process.env.STUB_PROMPT_OUT, prompt);
  const mode = process.env.STUB_MODE || 'json';
  if (mode === 'fail') { process.stderr.write('stub: refused\\n'); process.exit(2); }
  if (mode === 'text') { process.stdout.write('stub answer\\n'); process.exit(0); }
  process.stdout.write(JSON.stringify({ result: 'stub answer', is_error: false, total_cost_usd: 0.0123, session_id: 's' }) + '\\n');
});
`, 'utf8');
  return p;
}

const TOOLS_CONFIG = (list, agents = []) => ['tools:', `  default: [${list.join(', ')}]`, ...(agents.length ? ['  agents:', ...agents] : [])];

function run() {
  // ------------------------------------------------------------ registry
  suite('tools: registry and kit-managed paths');

  test('claude is verified; the other adapters are registered but marked unverified', () => {
    eq(toolsMod.TOOL_IDS, ['claude', 'copilot', 'codex', 'kiro']);
    eq(toolsMod.getTool('claude').verified, true);
    for (const id of ['copilot', 'codex', 'kiro']) eq(toolsMod.getTool(id).verified, false, id);
    throws(() => toolsMod.getTool('cursor'), /unsupported tool/);
  });

  test('every tool config glob is kit-managed and always protected', () => {
    for (const id of toolsMod.TOOL_IDS) {
      eq(toolsMod.getTool(id).configGlobs, layout.TOOL_CONFIG_GLOBS[id], `${id} globs`);
      for (const g of toolsMod.getTool(id).configGlobs) {
        ok(layout.KIT_MANAGED_GLOBS.includes(g), `${g} is not kit-managed`);
        ok(cfgMod.ALWAYS_PROTECTED.includes(g), `${g} is not always protected`);
      }
    }
    ok(layout.isKitManaged('.github/agents/x.agent.md'));
    ok(layout.isKitManaged('AGENTS.md'));
    ok(layout.isKitManaged('.kiro/agents/knowledge-builder.json'));
    ok(!layout.isKitManaged('.github/workflows/ci.yml'), 'a team CI file is not kit-managed');
    ok(!layout.isKitManaged('src/AGENTS.md'), 'only the root AGENTS.md is kit-managed');
    ok(pathsMod.matchesAny(cfgMod.ALWAYS_PROTECTED, '.github/copilot-instructions.md'));
  });

  test('every tool ships a template tree with the bundled agents in its own format', () => {
    const agents = toolsMod.listBundledAgents(KIT_ROOT).map((a) => a.name);
    ok(agents.includes('knowledge-builder'), agents.join(','));
    const dests = (id) => assets.listTemplateFiles(KIT_ROOT, { tools: [id] }).map((p) => p.dest);
    const copilot = dests('copilot');
    ok(copilot.includes('.github/copilot-instructions.md'));
    for (const a of agents) ok(copilot.includes(`.github/agents/${a}.agent.md`), a);
    ok(copilot.some((d) => /^\.github\/skills\/[^/]+\/SKILL\.md$/.test(d)), 'copilot skills are shipped');
    eq(dests('codex'), ['.codex/hooks.json', 'AGENTS.md']);
    ok(copilot.includes('.github/hooks/aidev.json'), 'copilot hooks are shipped');
    ok(dests('kiro').includes('.kiro/agents/aidev.json'), 'the kiro main agent (with the hooks) is shipped');
    const kiro = dests('kiro');
    ok(kiro.includes('.kiro/steering/ai-dev-kit.md'));
    const kb = path.join(KIT_ROOT, 'templates', 'kiro', '.kiro', 'agents', 'knowledge-builder.json');
    ok(fs.existsSync(kb), 'kiro agent file');
    const doc = JSON.parse(fs.readFileSync(kb, 'utf8'));
    eq(doc.name, 'knowledge-builder');
    ok(doc.prompt.length > 100, 'the agent body is inlined');
    ok(dests('claude').includes('.claude/agents/knowledge-builder.md'));
    const text = fs.readFileSync(path.join(KIT_ROOT, 'templates', 'copilot', '.github', 'agents', 'knowledge-builder.agent.md'), 'utf8');
    ok(/^---\nname: knowledge-builder\ndescription: "/.test(text), text.slice(0, 80));
  });

  test('argv per tool: identifiers and fixed flags only, prompt on stdin or in a file', () => {
    eq(agentMod.buildArgv({ agent: 'kb', model: 'sonnet' }),
      ['-p', '--input-format', 'text', '--agent', 'kb', '--model', 'sonnet', '--output-format', 'json',
        '--permission-mode', 'acceptEdits', '--permission-prompts', 'none']);
    eq(agentMod.buildArgv({ tool: 'copilot', agent: 'kb', model: null, promptArg: 'P' }),
      ['-p', 'P', '--allow-all-tools', '--agent', 'kb']);
    eq(agentMod.buildArgv({ tool: 'codex', agent: 'kb', model: 'o3', promptArg: 'P' }),
      ['exec', '--sandbox', 'workspace-write', '--model', 'o3', 'P']);
    eq(agentMod.buildArgv({ tool: 'kiro', agent: 'kb', promptArg: 'P' }),
      ['chat', '--no-interactive', '--trust-all-tools', '--agent', 'kb', 'P']);
    eq(toolsMod.getTool('claude').prompt, 'stdin');
    for (const id of ['copilot', 'codex', 'kiro']) eq(toolsMod.getTool(id).prompt, 'file', id);
  });

  test('plain-text tools succeed on exit 0 and report stderr on failure', () => {
    const ok0 = toolsMod.getTool('copilot').parse({ stdout: 'done\n', stderr: '', exitCode: 0 });
    eq(ok0.ok, true); eq(ok0.result, 'done');
    const bad = toolsMod.getTool('copilot').parse({ stdout: '', stderr: 'boom', exitCode: 3 });
    eq(bad.ok, false); eq(bad.reason, 'boom');
  });

  // -------------------------------------------------------------- config
  suite('config: several tools and per-agent overrides');

  const base = { version: 2, package: { name: 'p' } };

  test('tools.default takes one or several supported tools', () => {
    eq(cfgMod.validateConfig({ ...base, tools: { default: ['claude', 'copilot', 'codex', 'kiro'] } }).tools.default,
      ['claude', 'copilot', 'codex', 'kiro']);
    eq(cfgMod.validateConfig({ ...base, tools: { default: ['copilot'] } }).tools.agent, 'copilot', 'agent defaults to the first tool');
    throws(() => cfgMod.validateConfig({ ...base, tools: { default: ['claude', 'cursor'] } }), /unsupported tool "cursor"/);
    throws(() => cfgMod.validateConfig({ ...base, tools: { default: ['claude'], agent: 'copilot' } }), /not listed in tools\.default/);
  });

  test('tools.agents.<name> overrides tool and model with the documented precedence', () => {
    const c = cfgMod.validateConfig({
      ...base,
      tools: { default: ['claude', 'copilot'], agent_model: 'sonnet', agents: { 'knowledge-builder': { tool: 'copilot' }, 'issue-to-pr': { model: '' } } },
    });
    eq(cfgMod.agentSettings(c, 'knowledge-builder'), { tool: 'copilot', model: 'sonnet' }, 'tool overridden, model inherited');
    eq(cfgMod.agentSettings(c, 'issue-to-pr'), { tool: 'claude', model: null }, 'empty model means no model flag');
    eq(cfgMod.agentSettings(c, 'other'), { tool: 'claude', model: 'sonnet' });
    eq(cfgMod.agentSettings(null, 'x'), { tool: 'claude', model: null }, 'no config: kit default');
    throws(() => cfgMod.validateConfig({ ...base, tools: { agents: { kb: { tool: 'codex' } } } }), /tools\.agents\.kb\.tool "codex" is not listed/);
    throws(() => cfgMod.validateConfig({ ...base, tools: { agents: { 'bad name': {} } } }), /invalid agent name/);
    throws(() => cfgMod.validateConfig({ ...base, tools: { agents: { kb: { model: '-p' } } } }), /tools\.agents\.kb\.model/);
    const flags = agentMod.resolveOptions({ 'agent-tool': 'copilot', 'agent-model': 'opus' }, c);
    eq([flags.tool, flags.model], ['copilot', 'opus'], 'flags win over aidev.yaml');
    eq(agentMod.resolveOptions({}, c).tool, 'copilot', 'knowledge-builder follows its override');
    throws(() => agentMod.resolveOptions({ 'agent-tool': 'kiro' }, c), /not listed in tools\.default/);
    throws(() => agentMod.resolveOptions({ 'agent-tool': 'cursor' }, c), /not a supported tool/);
  });

  // ------------------------------------------------------- aidev agent run
  suite('agent: aidev agent list / show / run');

  {
    const fx = makeRepo({
      configExtra: TOOLS_CONFIG(['claude', 'copilot', 'codex'], ['    knowledge-builder: { tool: copilot }']),
    });
    const stub = writeToolStub(fx.root);
    const argvOut = path.join(fx.root, 'argv.json');
    const promptOut = path.join(fx.root, 'prompt.txt');
    const env = (extra = {}) => ({
      AIDEV_CLAUDE_BIN: stub, AIDEV_COPILOT_BIN: stub, AIDEV_CODEX_BIN: stub,
      STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut, ...extra,
    });
    const argv = () => JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    const reset = () => { for (const f of [argvOut, promptOut]) fs.rmSync(f, { force: true }); };
    try {
      test('list shows every bundled agent with its effective tool', () => {
        const r = aidev(fx.root, ['agent', 'list', '--json']);
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.tools.default, ['claude', 'copilot', 'codex']);
        const kb = j.agents.find((a) => a.name === 'knowledge-builder');
        eq(kb.tool, 'copilot');
        eq(j.agents.find((a) => a.name === 'issue-to-pr').tool, 'claude');
      });

      test('show prints the command line for the effective tool', () => {
        const j = lastJson(aidev(fx.root, ['agent', 'show', 'issue-to-pr', '--json']).out);
        eq(j.tool, 'claude');
        ok(j.command.argv.join(' ').includes('--agent issue-to-pr'), JSON.stringify(j.command));
        const k = lastJson(aidev(fx.root, ['agent', 'show', 'knowledge-builder', '--json']).out);
        eq(k.tool, 'copilot');
        eq(k.command.argv[0], '-p');
        eq(k.command.verified, false);
      });

      test('run --dry-run prints the command and spawns nothing', () => {
        reset();
        const r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', '--dry-run', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.dryRun, true); eq(j.tool, 'copilot');
        ok(!fs.existsSync(argvOut), 'the stub was started during a dry run');
      });

      test('run through Claude Code: prompt on stdin, JSON result parsed', () => {
        reset();
        const r = aidev(fx.root, ['agent', 'run', 'issue-to-pr', 'triage', 'item', '42', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.ok, j.tool, j.result, j.costUsd], [true, 'claude', 'stub answer', 0.0123]);
        const a = argv();
        ok(a.includes('--agent') && a[a.indexOf('--agent') + 1] === 'issue-to-pr', a.join(' '));
        ok(a.includes('--model') && a[a.indexOf('--model') + 1] === 'sonnet', 'tools.agent_model reaches argv');
        eq(fs.readFileSync(promptOut, 'utf8'), 'triage item 42', 'the task is the joined arguments, on stdin');
        eq(j.promptFile, null);
      });

      test('the started agent is named to the hook through AIDEV_AGENT', () => {
        reset();
        const envOut = path.join(fx.root, 'env.json');
        const r = aidev(fx.root, ['agent', 'run', 'issue-to-pr', 'x', '--json'], { env: env({ STUB_ENV_OUT: envOut }) });
        eq(r.code, 0, r.out);
        eq(JSON.parse(fs.readFileSync(envOut, 'utf8')).AIDEV_AGENT, 'issue-to-pr');
      });

      test('run through Copilot: prompt file named on argv, plain-text result', () => {
        reset();
        const r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', 'refresh the wiki', '--json'], { env: env({ STUB_MODE: 'text' }) });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.ok, j.tool, j.result], [true, 'copilot', 'stub answer']);
        const a = argv();
        eq(a[0], '-p');
        ok(a.includes('--allow-all-tools') && a.includes('--agent'), a.join(' '));
        ok(j.promptFile && j.promptFile.startsWith('.aidev/cache/agents/copilot-'), j.promptFile);
        const text = fs.readFileSync(promptOut, 'utf8');
        ok(/# Task\n\nrefresh the wiki/.test(text), text);
        ok(!/# Agent:/.test(text), 'a tool with named agents does not get the definition inlined');
      });

      test('run appends the references from aidev.yaml as paths, by topic; missing, secret and non-text entries are not passed', () => {
        reset();
        const yamlPath = path.join(fx.root, 'aidev.yaml');
        const original = fs.readFileSync(yamlPath, 'utf8');
        const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(fx.root, rel)), { recursive: true }); fs.writeFileSync(path.join(fx.root, rel), s); };
        w('docs/testing.md', '# how we test\n');
        w('docs/conventions/a.md', '# a\n');
        w('docs/conventions/sub/b.txt', 'b\n');
        w('docs/conventions/sheet.xlsx', 'not text');
        w('config/secrets/notes.md', 'secret');
        fs.writeFileSync(yamlPath, original + [
          'references:',
          '  testing: [docs/testing.md, docs/missing.md]',
          '  conventions: [docs/conventions, config/secrets/notes.md]',
          '',
        ].join('\n'));
        try {
          const s = lastJson(aidev(fx.root, ['agent', 'show', 'test-writer', '--json']).out);
          eq(s.references.map((e) => [e.topic, e.path, e.status]), [
            ['testing', 'docs/testing.md', 'file'], ['testing', 'docs/missing.md', 'missing'],
            ['conventions', 'docs/conventions', 'dir'], ['conventions', 'config/secrets/notes.md', 'secret'],
          ]);
          const r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', 'refresh the wiki', '--json'], { env: env({ STUB_MODE: 'text' }) });
          eq(r.code, 0, r.out);
          const text = fs.readFileSync(promptOut, 'utf8');
          ok(/# Task\n\nrefresh the wiki\n\n# Reference documents/.test(text), text);
          ok(/## testing\n\n- docs\/testing\.md\n/.test(text), text);
          ok(/## conventions\n\n- docs\/conventions\/a\.md\n- docs\/conventions\/sub\/b\.txt\n/.test(text), text);
          ok(!text.includes('sheet.xlsx'), 'non-text files inside a directory are left out');
          ok(/## Not available\n\n- docs\/missing\.md \(testing\): listed in aidev\.yaml but not in the checkout\n- config\/secrets\/notes\.md \(conventions\): matches secrets_paths/.test(text), text);
          ok(!/secret\n/.test(text), 'the contents of the files are never inlined');
        } finally {
          fs.writeFileSync(yamlPath, original);
          for (const rel of ['docs/testing.md', 'docs/conventions', 'config/secrets/notes.md']) fs.rmSync(path.join(fx.root, rel), { recursive: true, force: true });
        }
      });

      test('an office document under references is a configuration error that names the fix', () => {
        const yamlPath = path.join(fx.root, 'aidev.yaml');
        const original = fs.readFileSync(yamlPath, 'utf8');
        fs.writeFileSync(yamlPath, original + 'references:\n  conventions: [docs/rules.xlsx]\n');
        try {
          const r = aidev(fx.root, ['agent', 'show', 'test-writer']);
          eq(r.code, 1, r.out);
          ok(/docs\/rules\.xlsx.*not a text file.*export it to Markdown/.test(r.out), r.out);
        } finally { fs.writeFileSync(yamlPath, original); }
      });

      test('run through Codex: the agent definition is inlined because Codex has no named agents', () => {
        reset();
        const r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', 'x', '--tool', 'codex', '--model', '', '--json'], { env: env({ STUB_MODE: 'text' }) });
        eq(r.code, 0, r.out);
        const a = argv();
        eq(a.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
        ok(!a.includes('--model'), 'an empty --model passes no model flag');
        const text = fs.readFileSync(promptOut, 'utf8');
        ok(/^# Agent: knowledge-builder/.test(text), text.slice(0, 60));
        ok(/knowledge-builder contract|generation target|完了/i.test(text) || text.length > 500, 'the definition body is present');
      });

      test('a tool outside tools.default, an unknown tool and an unknown agent are refused before spawning', () => {
        reset();
        let r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', 'x', '--tool', 'kiro', '--json'], { env: env() });
        eq(r.code, 1, r.out); ok(/not listed in tools\.default/.test(r.out), r.out);
        r = aidev(fx.root, ['agent', 'run', 'knowledge-builder', 'x', '--tool', 'cursor'], { env: env() });
        eq(r.code, 1); ok(/not a supported tool/.test(r.out), r.out);
        r = aidev(fx.root, ['agent', 'run', 'nope', 'x'], { env: env() });
        eq(r.code, 1); ok(/no such agent: nope/.test(r.out), r.out);
        r = aidev(fx.root, ['agent', 'run', 'issue-to-pr'], { env: env() });
        eq(r.code, 1); ok(/no task given/.test(r.out), r.out);
        ok(!fs.existsSync(argvOut), 'something was spawned');
      });

      test('a failing tool is exit 1 with the reason, in JSON and human output alike', () => {
        reset();
        const r = aidev(fx.root, ['agent', 'run', 'issue-to-pr', 'x', '--json'], { env: env({ STUB_MODE: 'fail' }) });
        eq(r.code, 1);
        const j = lastJson(r.out);
        eq(j.ok, false); ok(/stub: refused/.test(j.reason), j.reason);
        const h = aidev(fx.root, ['agent', 'run', 'issue-to-pr', 'x'], { env: env({ STUB_MODE: 'fail' }) });
        eq(h.code, 1); ok(/failed: stub: refused/.test(h.out), h.out);
      });

      test('--prompt-file reads the task from a file', () => {
        reset();
        const f = path.join(fx.root, 'task.md');
        fs.writeFileSync(f, 'from a file\n');
        const r = aidev(fx.root, ['agent', 'run', 'issue-to-pr', '--prompt-file', f, '--json'], { env: env() });
        eq(r.code, 0, r.out);
        eq(fs.readFileSync(promptOut, 'utf8'), 'from a file\n');
      });
    } finally { fx.cleanup(); }
  }

  // ---------------------------------------------------------- workflows
  suite('workflow: ctx.agent');

  test('the definition validates its agent block like the CLI flags', () => {
    const good = { name: 'wf', cost: { max_usd: 1 }, commands: ['node'], agent: { name: 'knowledge-builder', tool: 'claude', model: '', timeout_ms: 60000 } };
    const d = workflowMod.validateDefinition(good, 'wf');
    eq(d.agent, { name: 'knowledge-builder', tool: 'claude', timeout_ms: 60000, model: null });
    eq(workflowMod.validateDefinition({ ...good, agent: undefined }, 'wf').agent, null);
    throws(() => workflowMod.validateDefinition({ ...good, agent: { tool: 'claude' } }, 'wf'), /agent\.name is required/);
    throws(() => workflowMod.validateDefinition({ ...good, agent: { name: '../x' } }, 'wf'), /agent\.name/);
    throws(() => workflowMod.validateDefinition({ ...good, agent: { name: 'kb', tool: 'cursor' } }, 'wf'), /agent\.tool/);
    throws(() => workflowMod.validateDefinition({ ...good, agent: { name: 'kb', model: '-p' } }, 'wf'), /agent\.model/);
    throws(() => workflowMod.validateDefinition({ ...good, agent: { name: 'kb', timeout_ms: 5 } }, 'wf'), /agent\.timeout_ms/);
  });

  {
    const fx = makeRepo({ configExtra: TOOLS_CONFIG(['claude']) });
    const stub = writeToolStub(fx.root);
    const argvOut = path.join(fx.root, 'argv.json');
    const promptOut = path.join(fx.root, 'prompt.txt');
    const env = (extra = {}) => ({ AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut, ...extra });
    const wfDir = path.join(fx.root, '.aidev', 'workflows', 'ask');
    const defineWorkflow = (yamlExtra, steps) => {
      write(path.join(wfDir, 'workflow.yaml'), [
        'name: ask', 'limits:', '  max_iterations: 3', '  max_minutes: 5',
        'cost:', '  max_usd: 0.02', 'commands:', '  - node', ...yamlExtra, '',
      ].join('\n'));
      write(path.join(wfDir, 'steps.js'), steps);
      const a = aidev(fx.root, ['workflow', 'approve', 'ask']);
      eq(a.code, 0, a.out);
    };
    try {
      test('ctx.agent starts the workflow\'s agent with the configured tool and records the cost', () => {
        defineWorkflow(['agent:', '  name: issue-to-pr', '  model: ""'], `'use strict';
module.exports = async function steps(ctx) {
  const a = await ctx.agent('summarise iteration ' + ctx.iteration);
  ctx.log('agent said: ' + a.result);
  return { done: a.ok, note: a.result + ' via ' + a.tool };
};
`);
        const r = aidev(fx.root, ['workflow', 'run', 'ask', '--json'], { env: env() });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq([j.done, j.note, j.agentRuns, j.costUsd], [true, 'stub answer via claude', 1, 0.0123]);
        const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
        ok(a.includes('--agent') && a[a.indexOf('--agent') + 1] === 'issue-to-pr', a.join(' '));
        ok(!a.includes('--model'), 'model "" in workflow.yaml passes no model flag');
        eq(fs.readFileSync(promptOut, 'utf8'), 'summarise iteration 1');
      });

      test('the cost budget stops the loop before another agent starts', () => {
        defineWorkflow(['agent:', '  name: issue-to-pr'], `'use strict';
module.exports = async function steps(ctx) {
  const a = await ctx.agent('again');
  return { done: false, note: 'spent ' + a.costUsd };
};
`);
        const r = aidev(fx.root, ['workflow', 'run', 'ask', '--json'], { env: env() });
        eq(r.code, 1, r.out);
        const j = lastJson(r.out);
        eq(j.done, false);
        ok(/cost limit of \$0\.02 reached/.test(j.stopReason), j.stopReason);
        eq(j.agentRuns, 2, 'two runs fit under $0.02, the third was refused');
      });

      test('a tool the PKG does not set up is refused inside the workflow', () => {
        defineWorkflow(['agent:', '  name: issue-to-pr', '  tool: copilot'], `'use strict';
module.exports = async function steps(ctx) {
  const a = await ctx.agent('x');
  return { done: a.ok };
};
`);
        fs.rmSync(argvOut, { force: true });
        const r = aidev(fx.root, ['workflow', 'run', 'ask', '--json'], { env: env() });
        eq(r.code, 1, r.out);
        ok(/not listed in tools\.default/.test(r.out), r.out);
        ok(!fs.existsSync(argvOut), 'the stub was started anyway');
      });

      test('run --dry-run reports the agent the workflow would use', () => {
        defineWorkflow(['agent:', '  name: issue-to-pr'], `'use strict';\nmodule.exports = async () => ({ done: true });\n`);
        const r = aidev(fx.root, ['workflow', 'run', 'ask', '--dry-run']);
        eq(r.code, 0, r.out);
        ok(/agent\s+issue-to-pr via claude/.test(r.out), r.out);
      });
    } finally { fx.cleanup(); }
  }

  // --------------------------------------------------- materialisation
  suite('assets: configuration files for several tools');

  {
    const fx = makeRepo({ configExtra: TOOLS_CONFIG(['claude', 'copilot']) });
    try {
      test('apply places the template tree of a tool added to tools.default and records the tool list', () => {
        // The fixture was set up for claude only; copilot was added to aidev.yaml
        // afterwards, so "aidev apply" is what brings its files in.
        const r = aidev(fx.root, ['apply', '--json']);
        eq(r.code, 0, r.out);
        ok(lastJson(r.out).created.includes('.github/copilot-instructions.md'), r.out);
        for (const rel of ['.github/copilot-instructions.md', '.github/agents/knowledge-builder.agent.md']) {
          ok(fs.existsSync(path.join(fx.root, rel)), `${rel} was not written`);
        }
        ok(fs.readdirSync(path.join(fx.root, '.github', 'skills')).length > 0, 'skills were not written');
        const lock = cfgMod.loadLock(fx.root);
        eq(lock.tools, ['claude', 'copilot']);
        ok('.github/copilot-instructions.md' in lock.files, 'copilot files are recorded in the lock');
        const head = fs.readFileSync(path.join(fx.root, '.github', 'copilot-instructions.md'), 'utf8');
        ok(/ai-dev-kit template for GitHub Copilot CLI/.test(head), head.slice(0, 120));
      });

      test('an edit to a copilot file is customisation, not drift; a team file next to it is ignored', () => {
        eq(assets.inspectConfig(fx.root).ok, true, 'clean after init');
        write(path.join(fx.root, '.github', 'agents', 'team.agent.md'), '---\nname: team\n---\n');
        ok(!assets.listStaticFiles(fx.root, { tools: ['claude', 'copilot'] }).includes('.github/agents/team.agent.md'));
        fs.appendFileSync(path.join(fx.root, '.github', 'agents', 'knowledge-builder.agent.md'), '\nedited\n');
        const d = assets.inspectConfig(fx.root);
        eq(d.ok, true);
        ok(d.customised.includes('.github/agents/knowledge-builder.agent.md'), JSON.stringify(d.customised));
        const c = aidev(fx.root, ['check', '--json']);
        eq(c.code, 0, `check must accept a customised file: ${c.out}`);
      });

      test('removing a tool from tools.default prunes its pristine files and keeps the edited one', () => {
        const mat = assets.applyTemplates(fx.root, { tools: ['claude'] });
        ok(mat.pruned.includes('.github/copilot-instructions.md'), JSON.stringify(mat.pruned));
        eq(mat.retired, ['.github/agents/knowledge-builder.agent.md'], 'the edited agent file must survive');
        ok(!fs.existsSync(path.join(fx.root, '.github', 'copilot-instructions.md')));
        ok(fs.existsSync(path.join(fx.root, '.github', 'agents', 'team.agent.md')), 'the team file survives');
        ok(!fs.existsSync(path.join(fx.root, '.github', 'skills')), 'the emptied skills directory is removed');
        ok(fs.existsSync(path.join(fx.root, '.claude', 'settings.json')), 'claude files stay');
      });
    } finally { fx.cleanup(); }
  }

  test('the shipped settings deny Claude from editing every tool\'s configuration', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(KIT_ROOT, 'templates', 'claude', '.claude', 'settings.json'), 'utf8'));
    for (const g of layout.ALL_TOOL_CONFIG_GLOBS) {
      ok(settings.permissions.deny.includes(`Edit(${g})`), `deny list lacks Edit(${g})`);
    }
  });
}

module.exports = { run, writeToolStub };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
