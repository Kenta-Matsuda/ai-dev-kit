'use strict';
/**
 * The Wiki follow-up hooks and the per-tool hook adapters.
 *
 *   - after-bash notices a new HEAD, does the structural update on a clean
 *     tree, and hands the interactive tool a plan for its subagents
 *   - session-stop refuses to stop while the Wiki is behind a clean HEAD,
 *     once; the tool's loop guard (or the kit's, for Kiro) lets the second
 *     stop through
 *   - the subagents' reports are folded and committed by
 *     `aidev knowledge update --no-agent`
 *   - every tool adapter shapes the same decision in the form its tool reads
 *
 * Run: node test/wiki-hooks.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, git, write } = require('./fixtures');
const inventory = require('../cli/lib/inventory');
const toolsMod = require('../cli/lib/tools');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');
const K = '.aidev/knowledge';
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-wh-home-'));

function aidev(root, args, { input = '{}', env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AIDEV_HOME: HOME, AIDEV_NO_UPDATE_CHECK: '1', NO_COLOR: '1', ...env },
    });
    return { code: 0, out, stdout: out, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}`, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function hook(root, name, payload, { tool = null, env = {} } = {}) {
  const args = ['hook', name, ...(tool ? ['--tool', tool] : [])];
  return aidev(root, args, { input: JSON.stringify(payload), env });
}

function lastJson(text) {
  const matches = String(text).match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try { return JSON.parse(matches[i]); } catch { /* keep looking */ }
  }
  return null;
}

/** A feature branch with one committed PKG change the Wiki has not seen. */
function branchWithChange(fx, rel = 'src/api/feature.ts') {
  git(['checkout', '-q', '-b', 'feature/x'], fx.root);
  write(path.join(fx.root, rel), 'export const feature = 1;\n');
  git(['add', '-A'], fx.root);
  git(['commit', '-q', '-m', 'feature work'], fx.root);
  return git(['rev-parse', 'HEAD'], fx.root);
}

function planPath(root) { return path.join(root, ...K.split('/'), '.cache', 'plan.json'); }

/** Pretend the subagents did their work: a page and a report per target. */
function reportAll(root) {
  const plan = JSON.parse(fs.readFileSync(planPath(root), 'utf8'));
  for (const target of plan.generationTargets) {
    const page = `${K}/pages/${target.replace(/\//g, '__')}.md`;
    write(path.join(root, ...page.split('/')), `# ${target}\n`);
    write(path.join(root, ...plan.reportDir.split('/'), inventory.doneFileName(target)),
      JSON.stringify({ target, targetSha: plan.targetSha, pages: [page] }));
  }
  return plan;
}

function run() {
  suite('wiki hooks: after-bash');

  test('an unchanged HEAD is a no-op and the first call only records HEAD', () => {
    const fx = makeRepo();
    try {
      const r1 = hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'ls' } });
      eq(r1.code, 0, r1.out);
      const r2 = hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'ls' } });
      const j = lastJson(r2.out);
      eq(j.changed, false, r2.out);
      ok(!j.hookSpecificOutput, 'no context when nothing happened');
    } finally { fx.cleanup(); }
  });

  test('a commit that puts the Wiki behind a clean HEAD writes the plan and instructs the session', () => {
    const fx = makeRepo();
    try {
      hook(fx.root, 'session-start', {});
      const head = branchWithChange(fx);
      const r = hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.followUp, 'plan', r.out);
      const ctx = j.hookSpecificOutput.additionalContext;
      ok(/behind|HEAD is/.test(ctx), `explains the state: ${ctx}`);
      ok(/knowledge-builder/.test(ctx) && /Agent tool/.test(ctx), `names the subagent the Claude way: ${ctx}`);
      ok(/aidev knowledge update --no-agent/.test(ctx), `names the finishing command: ${ctx}`);
      ok(fs.existsSync(planPath(fx.root)), 'plan.json written');
      const plan = JSON.parse(fs.readFileSync(planPath(fx.root), 'utf8'));
      eq(plan.targetSha, head, 'the plan names HEAD');
      eq(plan.generationTargets, ['src/api/feature.ts'], 'only the changed file is queued');
      eq(plan.batches.length, 1);
      // The structure is already at HEAD, but nothing was committed: prose is owed.
      const m = JSON.parse(fs.readFileSync(path.join(fx.root, ...K.split('/'), 'manifest.json'), 'utf8'));
      eq(m.knowledgeSha, head);
      eq(m.checkpoint.pendingPaths, ['src/api/feature.ts']);
      eq(git(['rev-parse', 'HEAD'], fx.root), head, 'no commit yet');
    } finally { fx.cleanup(); }
  });

  test('uncommitted generation targets postpone the update and are named', () => {
    const fx = makeRepo();
    try {
      hook(fx.root, 'session-start', {});
      branchWithChange(fx);
      write(path.join(fx.root, 'src', 'api', 'routing.ts'), 'export const routes = [1];\n');
      const r = hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'git commit' } });
      const j = lastJson(r.out);
      eq(j.followUp, 'dirty', r.out);
      ok(/src\/api\/routing\.ts/.test(j.hookSpecificOutput.additionalContext), 'names the dirty file');
      ok(!fs.existsSync(planPath(fx.root)), 'no plan while the tree is dirty');
    } finally { fx.cleanup(); }
  });

  test('a rename needs no prose: the hook commits the structural update itself', () => {
    const fx = makeRepo();
    try {
      hook(fx.root, 'session-start', {});
      git(['checkout', '-q', '-b', 'feature/rename'], fx.root);
      git(['mv', 'src/api/auth.ts', 'src/api/authentication.ts'], fx.root);
      git(['commit', '-q', '-m', 'rename'], fx.root);
      const head = git(['rev-parse', 'HEAD'], fx.root);
      const r = hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'git commit' } });
      const j = lastJson(r.out);
      eq(j.followUp, 'committed', r.out);
      ok(/committed as/.test(j.hookSpecificOutput.additionalContext), j.hookSpecificOutput.additionalContext);
      eq(git(['rev-parse', 'HEAD~1'], fx.root), head, 'one Wiki commit on top');
      ok(/aidev: update Wiki for/.test(git(['log', '-1', '--format=%s'], fx.root)));
      // The Wiki commit moved HEAD again; the next call sees it and stays quiet.
      const again = lastJson(hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'ls' } }).out);
      eq(again.changed, true);
      eq(again.wikiBehind, false);
    } finally { fx.cleanup(); }
  });

  test('after the subagents report, update --no-agent folds the reports and commits', () => {
    const fx = makeRepo();
    try {
      hook(fx.root, 'session-start', {});
      const head = branchWithChange(fx);
      hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'git commit' } });
      reportAll(fx.root);
      const r = aidev(fx.root, ['knowledge', 'update', '--no-agent', '--json']);
      eq(r.code, 0, r.out);
      const j = lastJson(r.out);
      eq(j.remaining, 0);
      eq(j.committed, true, 'the Wiki was committed');
      eq(git(['rev-parse', 'HEAD~1'], fx.root), head, 'the Wiki commit sits on the source commit');
      const files = git(['show', '--name-only', '--format=', 'HEAD'], fx.root).split('\n').filter(Boolean);
      ok(files.every((f) => f.startsWith(`${K}/`) || f === '.aidev/.gitignore'), `only the Wiki is committed: ${files.join(', ')}`);
      ok(!fs.existsSync(planPath(fx.root)), 'the plan is removed once nothing is owed');
      const st = lastJson(aidev(fx.root, ['status', '--no-remote', '--json']).out).state;
      eq(st.severity, 'ok', st.message);
      // Stopping is fine now.
      const stop = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }).out);
      ok(!stop.decision, `no block once the Wiki is at HEAD: ${JSON.stringify(stop)}`);
    } finally { fx.cleanup(); }
  });

  suite('wiki hooks: session-stop');

  test('the session cannot stop while the Wiki is behind a clean HEAD, but only once', () => {
    const fx = makeRepo();
    try {
      branchWithChange(fx);
      const first = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }).out);
      eq(first.decision, 'block', JSON.stringify(first));
      ok(/knowledge-builder/.test(first.reason), 'says what to do');
      ok(fs.existsSync(planPath(fx.root)), 'the plan is written for the session');
      const second = lastJson(hook(fx.root, 'session-stop', { session_id: 's1', stop_hook_active: true }).out);
      ok(!second.decision, `the loop guard lets the second stop through: ${JSON.stringify(second)}`);
      ok(/already asked once/.test(second.wiki || ''), 'with a warning');
    } finally { fx.cleanup(); }
  });

  test('a dirty tree never blocks the stop', () => {
    const fx = makeRepo();
    try {
      branchWithChange(fx);
      write(path.join(fx.root, 'src', 'api', 'routing.ts'), 'export const routes = [1];\n');
      const r = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }).out);
      ok(!r.decision, JSON.stringify(r));
      ok(/not committed/.test(r.wiki || ''), 'explains');
    } finally { fx.cleanup(); }
  });

  test('Kiro has no loop flag, so the kit counts the refusal itself', () => {
    const fx = makeRepo();
    try {
      branchWithChange(fx);
      const first = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }, { tool: 'kiro' }).out);
      eq(first.decision, 'block', JSON.stringify(first));
      ok(/subagent tool/.test(first.reason), `phrased for Kiro: ${first.reason}`);
      const second = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }, { tool: 'kiro' }).out);
      ok(!second.decision, `second stop passes: ${JSON.stringify(second)}`);
      const third = lastJson(hook(fx.root, 'session-stop', { session_id: 's1' }, { tool: 'kiro' }).out);
      eq(third.decision, 'block', 'the guard resets after letting one stop through');
    } finally { fx.cleanup(); }
  });

  suite('wiki hooks: tool adapters');

  test('every tool has an adapter and it names the config file the kit ships', () => {
    for (const id of toolsMod.TOOL_IDS) {
      const a = toolsMod.hookAdapter(id);
      eq(a.id, id);
      for (const f of a.configFiles) {
        ok(fs.existsSync(path.join(__dirname, '..', 'templates', id, ...f.split('/'))), `${id}: ${f} is not shipped`);
      }
      ok(/knowledge-builder/.test(a.subagentHint('knowledge-builder')), `${id}: hint names the agent`);
    }
    let threw = false;
    try { toolsMod.hookAdapter('cursor'); } catch { threw = true; }
    ok(threw, 'unknown tool is refused');
  });

  test('guard-write shapes its decision per tool', () => {
    const fx = makeRepo();
    try {
      const payload = { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts') } };
      const claude = JSON.parse(hook(fx.root, 'guard-write', payload).stdout);
      eq(claude.hookSpecificOutput.permissionDecision, 'deny');
      const codex = JSON.parse(hook(fx.root, 'guard-write', payload, { tool: 'codex' }).stdout);
      eq(codex.hookSpecificOutput.permissionDecision, 'deny');
      const copilot = hook(fx.root, 'guard-write', { toolName: 'Write', toolArgs: payload.tool_input }, { tool: 'copilot' });
      eq(JSON.parse(copilot.stdout).permissionDecision, 'deny', copilot.stdout);
      eq(copilot.code, 0, 'copilot reads the JSON, exit stays 0');
      const kiro = hook(fx.root, 'guard-write', payload, { tool: 'kiro' });
      eq(kiro.code, 2, 'kiro also signals the denial through the exit status');
      eq(JSON.parse(kiro.stdout).hookSpecificOutput.permissionDecision, 'deny');
      const allowed = hook(fx.root, 'guard-write', { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'aidev.yaml') } }, { tool: 'kiro' });
      eq(allowed.code, 0, 'an allowed write exits 0 for kiro too');
    } finally { fx.cleanup(); }
  });

  test('context injection follows each tool: Claude/Codex wrap it, Copilot is flat, Kiro prints text at spawn only', () => {
    const fx = makeRepo();
    try {
      hook(fx.root, 'session-start', {});
      branchWithChange(fx);
      const call = (tool) => hook(fx.root, 'after-bash', { tool_name: 'Bash', tool_input: { command: 'git commit' } }, { tool });
      // Each call must see a "new" HEAD: reset the remembered one between tools.
      const forget = () => { try { fs.unlinkSync(path.join(fx.root, '.aidev', 'cache', 'last-head.json')); } catch { /* ignore */ } };
      const claude = lastJson(call('claude').out);
      ok(claude.hookSpecificOutput && claude.hookSpecificOutput.hookEventName === 'PostToolUse', JSON.stringify(claude));
      forget();
      const codex = lastJson(call('codex').out);
      ok(codex.hookSpecificOutput && /knowledge-builder/.test(codex.hookSpecificOutput.additionalContext), JSON.stringify(codex));
      ok(/spawn/.test(codex.hookSpecificOutput.additionalContext), 'phrased for Codex');
      forget();
      const copilot = lastJson(call('copilot').out);
      ok(typeof copilot.additionalContext === 'string' && /custom agent/.test(copilot.additionalContext), JSON.stringify(copilot));
      ok(!copilot.hookSpecificOutput, 'copilot reads a flat additionalContext');
      forget();
      const kiro = lastJson(call('kiro').out);
      ok(!kiro.hookSpecificOutput && !kiro.additionalContext, `kiro discards postToolUse stdout, so nothing is injected: ${JSON.stringify(kiro)}`);
      eq(kiro.followUp, 'plan', 'the plan is still written for the Stop hook to point at');

      const spawn = hook(fx.root, 'session-start', {}, { tool: 'kiro' });
      ok(/\[ai-dev-kit\] head=/.test(spawn.stdout) && !/hookSpecificOutput/.test(spawn.stdout), `kiro gets plain text: ${spawn.stdout}`);
      const cp = JSON.parse(hook(fx.root, 'session-start', {}, { tool: 'copilot' }).stdout);
      ok(/\[ai-dev-kit\] head=/.test(cp.additionalContext), 'copilot gets additionalContext');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  run();
  process.exit(require('./harness').summary() ? 0 : 1);
}
