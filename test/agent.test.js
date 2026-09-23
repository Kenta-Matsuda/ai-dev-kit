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
 *   - a tool listed in tools.default gets its derived configuration files,
 *     which are drift-checked and pruned again when the tool is removed
 *
 * Every tool binary is a stub reached through AIDEV_<TOOL>_BIN; nothing here
 * starts a real AI tool.
 */

const fs = require('fs');
const os = require('os');
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

const KIT_ROOT = path.resolve(__dirname, '..');

/**
 * A stand-in for any tool binary. It records its argv, captures the prompt
 * (stdin, or the file the argv points at) and answers the way STUB_MODE says:
 * `json` like Claude Code's --output-format stream-json, `text` like a plain CLI,
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
      ['-p', '--input-format', 'text', '--agent', 'kb', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose',
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

  test('claude reads the result record from the stream, and refuses output without one', () => {
    const claude = toolsMod.getTool('claude');
    const line = (o) => JSON.stringify(o);
    const stream = [
      line({ type: 'system', subtype: 'init' }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.5, session_id: 'sid', permission_denials: [{}] }),
    ].join('\n');
    const good = claude.parse({ stdout: `${stream}\n`, stderr: '', exitCode: 0 });
    eq([good.ok, good.result, good.costUsd, good.sessionId, good.permissionDenials], [true, 'done', 0.5, 'sid', 1]);
    const failed = claude.parse({ stdout: line({ type: 'result', is_error: true, result: 'refused', total_cost_usd: 0.1 }), stderr: '', exitCode: 0 });
    eq([failed.ok, failed.reason, failed.costUsd], [false, 'refused', 0.1]);
    const none = claude.parse({ stdout: line({ type: 'system', subtype: 'init' }), stderr: '', exitCode: 0 });
    eq(none.ok, false);
    ok(/did not return the requested JSON result/.test(none.reason), none.reason);
    const single = claude.parse({ stdout: line({ result: 'one object', is_error: false, total_cost_usd: 1 }), stderr: '', exitCode: 0 });
    eq([single.ok, single.result], [true, 'one object'], 'a lone result object (--output-format json) still parses');
    const crashed = claude.parse({ stdout: stream, stderr: 'boom', exitCode: 1 });
    eq([crashed.ok, crashed.reason], [false, 'done'], 'a non-zero exit is a failure even with a result record');
  });

  test('claude progress events: tool calls, messages and failed tools, nested inside a subagent', () => {
    const progress = toolsMod.getTool('claude').progress;
    const line = (o) => JSON.stringify(o);
    eq(progress('not json'), []);
    eq(progress(line({ type: 'system', subtype: 'init' })), []);
    eq(progress(line({ type: 'assistant', parent_tool_use_id: null, message: { content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } },
      { type: 'text', text: '  ' },
      { type: 'text', text: 'plan' }] } })),
    [{ kind: 'tool', id: 't1', name: 'Read', input: { file_path: 'a.md' }, nested: false }, { kind: 'text', text: 'plan', nested: false }]);
    eq(progress(line({ type: 'user', parent_tool_use_id: 't9', message: { content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'fine' },
      { type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'denied' }] }] } })),
    [{ kind: 'error', toolUseId: 't2', text: 'denied', nested: true }]);
  });

  test('the progress reporter prints one clocked line per event, subagents indented, quiet lines only when idle', () => {
    const ui = require('../cli/lib/ui');
    const lines = [];
    const original = ui.dim;
    ui.dim = (s) => lines.push(s);
    try {
      const root = path.join(os.tmpdir(), 'pkg');
      const report = agentMod.progressReporter({ repoRoot: root, status: () => '2/5 done' });
      report({ elapsedMs: 4000, event: { kind: 'tool', id: 't1', name: 'Read', input: { file_path: path.join(root, 'src', 'a.ts') } } });
      report({ elapsedMs: 65000, event: { kind: 'tool', id: 't2', name: 'Agent', input: { subagent_type: 'agents-creator', description: 'write it' } } });
      report({ elapsedMs: 66000, event: { kind: 'tool', id: 't3', name: 'Glob', input: { pattern: '**/*.ts' }, nested: true } });
      report({ elapsedMs: 70000, event: { kind: 'text', text: 'first line\nsecond \x1b[31mline\x1b[0m' } });
      report({ elapsedMs: 80000, event: { kind: 'error', toolUseId: 't1', text: 'no such file' } });
      report({ elapsedMs: 95000, event: null, quietMs: 15000 });
      report({ elapsedMs: 3725000, event: null });
    } finally { ui.dim = original; }
    eq(lines, [
      '     0:04  Read src/a.ts',
      '     1:05  Agent agents-creator: write it',
      '     1:06    Glob **/*.ts',
      '     1:10  “first line second line”',
      '     1:20  ✗ Read: no such file',
      '     1:35  … still running, no output for 15s, 2/5 done',
      `    1:02:05  … ${agentMod.formatDuration(3725000)} elapsed, 2/5 done`,
    ]);
    const long = agentMod.describeToolUse({ name: 'Bash', input: { command: 'x'.repeat(200) } });
    ok(long.length > 92, 'describeToolUse does not truncate; the reporter does');
    eq(agentMod.describeToolUse({ name: 'Custom', input: { n: 1, q: 'why' } }), 'Custom why');
    eq(agentMod.describeToolUse({ name: 'Custom', input: {} }), 'Custom');
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

  // --------------------------------------------------- materialisation
  suite('assets: configuration files for several tools');

  {
    const fx = makeRepo({ configExtra: TOOLS_CONFIG(['claude', 'copilot']) });
    try {
      test('apply places the template tree of a tool added to tools.default and records the tool list', () => {
        // The fixture was set up for claude only; copilot was added to aidev.yaml
        // afterwards, so "aidev sync tools" is what brings its files in.
        const r = aidev(fx.root, ['sync', 'tools', '--json']);
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
