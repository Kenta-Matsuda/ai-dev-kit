'use strict';
/**
 * Coverage for the behaviours completed after the first implementation pass.
 *
 * Each suite here pins down something that previously either did nothing or
 * actively failed:
 *
 *   - the permission weakening check that gates --approve
 *   - orphaned Wiki page removal (README scenario 7)
 *   - the session-start summary and the self-evolution journal at session-stop
 *   - how the knowledge-builder agent is launched, in `knowledge build` and
 *     inside the temporary worktree of `aidev sync`
 *
 * Run: node test/completion.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, advancePkg } = require('./fixtures');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');
const inventory = require('../cli/lib/inventory');
const permissionMod = require('../cli/commands/permission');
const agentMod = require('../cli/lib/agent');

const K = '.aidev/knowledge';

/**
 * A throwaway AIDEV_HOME for every CLI spawn: the registry and update cache
 * must never touch the developer's real per-machine area, and the update check
 * is switched off so no test reaches the network.
 */
const AIDEV_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-test-home-'));
process.on('exit', () => { try { fs.rmSync(AIDEV_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Run the real CLI the way a pipeline or hook does. */
function aidev(root, args, { input = undefined, env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: 'utf8', input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AIDEV_HOME, AIDEV_NO_UPDATE_CHECK: '1', ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** The last JSON document in mixed human/JSON output. */
function lastJson(text) {
  const matches = String(text).match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (let i = matches.length - 1; i >= 0; i--) {
    try { return JSON.parse(matches[i]); } catch { /* keep looking */ }
  }
  return null;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, K, 'manifest.json'), 'utf8'));
}

/**
 * A stand-in for the Claude Code binary.
 *
 * The suite must never spawn the real `claude`: it costs money, needs a network
 * and would take minutes. The stub records the argv it was handed so the tests
 * can assert on how the CLI invokes an agent, and `STUB_MODE` selects the
 * outcome. `AIDEV_CLAUDE_BIN` is the documented seam for exactly this.
 *
 * Every path the stub writes is relative to its cwd: `knowledge build` runs it
 * at the repo root, `aidev sync` inside the temporary worktree. Page
 * paths in its reports are repo-relative (`.aidev/knowledge/...`), which is
 * what the CLI's completion protocol asks for.
 */
function writeClaudeStub(root) {
  const p = path.join(root, 'fake-claude.js');
  fs.writeFileSync(p, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const K = '.aidev/knowledge';
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) {
  fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(argv, null, 2));
}
// Each spawn is one survey or one batch; the counter tells them apart.
let call = 1;
if (process.env.STUB_COUNT_FILE) {
  try { call = Number(fs.readFileSync(process.env.STUB_COUNT_FILE, 'utf8')) + 1; } catch { call = 1; }
  fs.writeFileSync(process.env.STUB_COUNT_FILE, String(call));
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.STUB_PROMPT_OUT) {
    fs.writeFileSync(process.env.STUB_PROMPT_OUT, prompt);
  }
  // Read the plan the way the real agent would: from the task file when the
  // prompt points at one, otherwise from the prompt's own target list.
  let runMode = /^Survey this package/.test(prompt) ? 'survey' : 'generate';
  let targets = [];
  const sha = (/Target PKG commit: (\\S+)/.exec(prompt) || [])[1] || null;
  const planRef = /plan for this run is in: (\\S+)/.exec(prompt);
  if (planRef) {
    const plan = JSON.parse(fs.readFileSync(planRef[1], 'utf8'));
    runMode = plan.mode || runMode;
    targets = plan.generationTargets || [];
  } else {
    const lines = prompt.split('\\n');
    const start = lines.findIndex((l) => /^Generation targets \\(/.test(l));
    for (let i = start + 1; start >= 0 && i < lines.length && lines[i].startsWith('  - '); i++) {
      targets.push(lines[i].slice(4).trim());
    }
  }
  if (process.env.STUB_CALLS_OUT) {
    fs.appendFileSync(process.env.STUB_CALLS_OUT, JSON.stringify({ call, runMode, targets, cwd: process.cwd() }) + '\\n');
  }

  const mode = process.env.STUB_MODE || 'drain';
  const hangAt = Number(process.env.STUB_HANG_AT || 0);
  if (mode === 'fail') {
    process.stderr.write('stub: the agent could not continue\\n');
    process.stdout.write(JSON.stringify({ result: 'boom', is_error: true }) + '\\n');
    process.exit(1);
  }
  if (mode === 'hang' || (hangAt > 0 && call === hangAt)) { setTimeout(() => {}, 600000); return; }

  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, body, 'utf8');
  };
  const report = (target, pages) => {
    write(path.join(K, '.cache', 'done', target.replace(/\\//g, '__') + '.json'),
      JSON.stringify({ target, targetSha: sha, pages }) + '\\n');
  };
  const finish = (target) => {
    const page = K + '/pages/' + path.basename(target) + '.md';
    write(page, '# ' + target + '\\n\\nGenerated by the stub for ' + sha + '.\\n');
    report(target, [page]);
  };

  if (mode === 'missing-checkpoint' || mode === 'target-mismatch') {
    // A run that corrupts the structured state it must not touch.
    const mp = K + '/manifest.json';
    try {
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      if (mode === 'missing-checkpoint') delete m.checkpoint;
      else m.knowledgeSha = 'ffffffffffffffffffffffffffffffffffffffff';
      fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\\n');
    } catch (e) { /* leave it be */ }
  } else if (runMode === 'survey') {
    // Every well-behaved mode surveys; 'no-progress' means no *targets* done.
    write(K + '/index.md', '# index\\n\\nSee overview.md.\\n');
    write(K + '/overview.md', '# overview\\n\\nStub map of the repository.\\n');
    report('__survey__', [K + '/index.md', K + '/overview.md']);
  } else if (mode === 'drain') {
    for (const t of targets) finish(t);
  } else if (mode === 'partial') {
    if (targets.length > 0) finish(targets[0]);
  }
  process.stdout.write(JSON.stringify({
    result: mode === 'no-progress' ? 'need more information' : 'wrote the pages',
    is_error: false, total_cost_usd: 0.0123, session_id: 'stub-session',
  }) + '\\n');
});
`, 'utf8');
  return p;
}

function run() {
  test('the azure_devops alias mirrors hosting for azure-devops and is null otherwise', () => {
    const cfgMod = require('../cli/lib/config');
    const fxA = makeRepo();
    const fxG = makeRepo({ hosting: 'generic' });
    try {
      const a = cfgMod.loadConfig(fxA.root);
      eq(a.azure_devops.organization, 'my-org');
      eq(a.azure_devops.repository, 'my-pkg');
      eq(a.azure_devops.auth_env, 'AZURE_DEVOPS_PAT');
      const g = cfgMod.loadConfig(fxG.root);
      eq(g.azure_devops, null, 'generic hosting must not pretend to be Azure DevOps');
    } finally { fxA.cleanup(); fxG.cleanup(); }
  });

  // ------------------------------------------------- permission: weakening
  suite('permission: weakening detection');

  test('removing a protected path is detected', () => {
    const current = { protected: ['.claude/**', 'CLAUDE.md'], read_only: ['**'], writable_during_sync: [], writable: [] };
    const candidate = { protected: ['.claude/**'], read_only: ['**'], writable_during_sync: [], writable: [] };
    const r = permissionMod.detectWeakening(current, candidate);
    ok(r.weakening, 'dropping CLAUDE.md from protected must count as weakening');
    ok(r.losses.some((l) => l.path === 'CLAUDE.md'), 'the lost path is not named');
  });

  test('adding protection is never weakening', () => {
    const current = { protected: ['.claude/**'], read_only: [], writable_during_sync: [], writable: [] };
    const candidate = { protected: ['.claude/**', 'extra/**'], read_only: [], writable_during_sync: [], writable: [] };
    ok(!permissionMod.detectWeakening(current, candidate).weakening, 'additions must approve cleanly');
  });

  test('a sync-only path becoming freely writable is weakening', () => {
    const current = { protected: [], read_only: [], writable_during_sync: [`${K}/**`], writable: [] };
    const candidate = { protected: [], read_only: [], writable_during_sync: [`${K}/**`], writable: [`${K}/**`] };
    const r = permissionMod.detectWeakening(current, candidate);
    ok(r.weakening, 'escalation to unconditional write must be caught');
  });

  test('the first policy ever placed is not judged against nothing', () => {
    const candidate = { protected: ['.claude/**'], read_only: ['**'], writable_during_sync: [], writable: [] };
    ok(!permissionMod.detectWeakening(null, candidate).weakening, 'initial placement must not be blocked');
  });

  test('the derived candidate starts from the default scopes and promotes secrets', () => {
    const cfgMod = require('../cli/lib/config');
    const c = permissionMod.buildCandidate({ package: { name: 'x' }, secrets_paths: ['config/secrets/**'] });
    ok(c.protected.includes('config/secrets/**'), 'secrets_paths must be protected');
    for (const p of cfgMod.ALWAYS_PROTECTED) ok(c.protected.includes(p), `${p} missing from protected`);
    eq(c.read_only, [...cfgMod.DEFAULT_POLICY_SCOPES.read_only]);
    eq(c.writable, [...cfgMod.DEFAULT_POLICY_SCOPES.writable]);
    eq(c.writable_during_sync, [...cfgMod.DEFAULT_POLICY_SCOPES.writable_during_sync]);
  });

  {
    const fx = makeRepo({ withPolicy: true });
    try {
      test('--approve refuses to place a weakening candidate without --force', () => {
        // The fixture policy protects the secrets path; a config with no
        // secrets_paths derives a candidate that drops it.
        const cfg = path.join(fx.root, 'aidev.yaml');
        const before = fs.readFileSync(cfg, 'utf8');
        const edited = before.replace('secrets_paths:\n  - "config/secrets/**"\n', 'secrets_paths: []\n');
        ok(edited !== before, 'the fixture config no longer carries the secrets path this test edits');
        fs.writeFileSync(cfg, edited, 'utf8');

        const r = aidev(fx.root, ['permission', 'reconfigure', '--approve', '--json']);
        eq(r.code, 3, `expected exit 3 (permission), got ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        ok(j && j.weakening === true, `weakening not reported: ${r.out}`);
        ok(j.losses.some((l) => l.path === 'config/secrets/**'), `the dropped secrets path is not named: ${r.out}`);
        const policy = fs.readFileSync(path.join(fx.root, '.aidev', 'policy.yaml'), 'utf8');
        ok(/config\/secrets/.test(policy), 'the protection was dropped despite the refusal');
      });

      test('--force places it and says what was given up', () => {
        const r = aidev(fx.root, ['permission', 'reconfigure', '--approve', '--force']);
        eq(r.code, 0, `expected exit 0, got ${r.code}: ${r.out}`);
        const policy = fs.readFileSync(path.join(fx.root, '.aidev', 'policy.yaml'), 'utf8');
        ok(!/config\/secrets/.test(policy), 'the forced candidate was not placed');
        ok(policy.includes(`${K}/**`), 'the placed policy does not use the new Wiki location');
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------- knowledge: orphaned page removal
  suite('knowledge: orphaned pages (scenario 7)');

  test('a page belonging only to a deleted file is orphaned', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { [`${K}/src/a.md`]: 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, []), [`${K}/src/a.md`]);
  });

  test('a page still referenced by a surviving file is kept', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { [`${K}/src/shared.md`]: 'sha256:x' } }];
    const surviving = [{ path: 'src/b.ts', selfHashes: { [`${K}/src/shared.md`]: 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, surviving), [], 'a shared page must not be deleted');
  });

  test('index.md is never treated as orphaned', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { [`${K}/src/index.md`]: 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, []), [], 'directory indexes survive their files');
  });

  {
    const fx = makeRepo();
    try {
      const page = path.join(fx.root, K, 'src', 'gone.md');
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.writeFileSync(page, '# gone\n', 'utf8');
      fs.writeFileSync(path.join(fx.root, K, 'src', 'index.md'), '# dir\n', 'utf8');

      test('the page is deleted and its parent index reported stale', () => {
        const r = inventory.removeOrphanedPages(fx.root, [`${K}/src/gone.md`]);
        eq(r.deleted, [`${K}/src/gone.md`]);
        ok(!fs.existsSync(page), 'the file is still on disk');
        ok(r.staleIndexes.includes(`${K}/src/index.md`), 'the parent index was not flagged');
      });

      test('a path escaping .aidev/knowledge/ is refused, not deleted', () => {
        const outside = path.join(fx.root, 'CLAUDE.md');
        const policy = path.join(fx.root, '.aidev', 'policy.yaml');
        const r = inventory.removeOrphanedPages(fx.root, ['../CLAUDE.md', 'CLAUDE.md', '.aidev/policy.yaml', `${K}/../policy.yaml`]);
        eq(r.deleted, [], 'nothing outside .aidev/knowledge/ may be deleted');
        ok(fs.existsSync(outside), 'a kit-owned file was deleted');
        ok(fs.existsSync(policy), 'the policy next to the Wiki was deleted');
        ok(r.skipped.every((s) => /outside/.test(s.reason)), `wrong skip reason: ${JSON.stringify(r.skipped)}`);
      });

      test('deleting an already-absent page is not an error', () => {
        const r = inventory.removeOrphanedPages(fx.root, [`${K}/src/never-existed.md`]);
        eq(r.deleted, []);
        ok(r.skipped.some((s) => /absent/.test(s.reason)), 'the skip reason is not recorded');
      });
    } finally { fx.cleanup(); }
  }

  // --------------------------------------------------- hooks: session-start
  suite('hooks: session-start');

  {
    const fx = makeRepo();
    try {
      test('the hook emits one JSON document with the state summary', () => {
        const r = aidev(fx.root, ['hook', 'session-start'], { input: '{}' });
        eq(r.code, 0, `hook exited ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        ok(j && j.hookSpecificOutput && /\[ai-dev-kit\]/.test(j.hookSpecificOutput.additionalContext), `malformed hook output: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ---------------------------------------------------- hooks: session-stop
  suite('hooks: session-stop asks a kit developer session to reflect');

  /** A Claude Code transcript with n tool calls and the given output tokens. */
  function writeTranscript(root, { toolCalls = 0, outputTokens = 0 } = {}) {
    const p = path.join(root, 'transcript.jsonl');
    const lines = [];
    const t0 = Date.now() - 600000;
    for (let i = 0; i < Math.max(1, toolCalls); i++) {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(t0 + i * 1000).toISOString(), message: {
        role: 'assistant', usage: { input_tokens: 100, output_tokens: i === 0 ? outputTokens : 0 },
        content: i < toolCalls ? [{ type: 'tool_use', name: 'Read', input: {} }] : [{ type: 'text', text: 'done' }],
      } }));
      if (i < toolCalls) lines.push(JSON.stringify({ type: 'user', timestamp: new Date(t0 + i * 1000 + 500).toISOString(), message: {
        role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }));
    }
    fs.writeFileSync(p, `${lines.join('\n')}\n`, 'utf8');
    return p;
  }

  {
    const fx = makeRepo();
    try {
      const dev = { AIDEV_KIT_DEVELOPER: '1' };
      const payload = (extra = {}) => JSON.stringify({ session_id: 'sess-1', transcript_path: writeTranscript(fx.root, extra.metrics || {}), ...extra.input });

      test('on an ordinary machine the hook does nothing', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: payload({ metrics: { toolCalls: 99 } }) });
        eq(r.code, 0, `exit ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        ok(j && j.ok && /not a kit developer/.test(j.skipped), r.out);
        ok(!fs.existsSync(path.join(fx.root, '.aidev', 'cache', 'evolution')), 'nothing written on a user machine');
      });

      test('a small session on a developer machine is let go', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: payload({ metrics: { toolCalls: 3, outputTokens: 500 } }), env: dev });
        const j = lastJson(r.out);
        ok(j && j.ok && j.belowThreshold, r.out);
        eq(j.metrics.toolCalls, 3);
      });

      test('a session that did real work is blocked once with reflection instructions', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: payload({ metrics: { toolCalls: 40, outputTokens: 100 } }), env: dev });
        const j = lastJson(r.out);
        eq(j.decision, 'block', r.out);
        ok(/\.aidev\/cache\/evolution\/sess-1\.md/.test(j.reason), 'names the reflection file');
        ok(/40 tool calls/.test(j.reason), 'carries the facts');
        ok(/Do NOT copy prompts/.test(j.reason), 'forbids copying content');
        eq(j.metrics.toolCalls, 40);
      });

      test('while the block is being answered the hook does not block again', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: payload({ metrics: { toolCalls: 40 }, input: { stop_hook_active: true } }), env: dev });
        const j = lastJson(r.out);
        ok(j && j.ok && !j.decision, r.out);
      });

      test('once the reflection exists the session may stop', () => {
        const file = path.join(fx.root, '.aidev', 'cache', 'evolution', 'sess-1.md');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '# session sess-1\n## 事実\n- x\n', 'utf8');
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: payload({ metrics: { toolCalls: 40 } }), env: dev });
        const j = lastJson(r.out);
        ok(j && j.ok && j.reflected, r.out);
        eq(j.evolveLaunched, false, 'no auto run without --auto');
      });

      test('an unreadable transcript never blocks the session', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: JSON.stringify({ session_id: 'sess-2', transcript_path: path.join(fx.root, 'missing.jsonl') }), env: dev });
        const j = lastJson(r.out);
        ok(j && j.ok && /transcript/.test(j.skipped), r.out);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------------- agent invocation (unit)
  suite('agent: argv and prompt construction');

  test('the prompt stays out of argv so a Windows shell cannot split it', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder' });
    eq(argv[0], '-p');
    ok(!argv.includes('DO IT'), 'natural-language prompt leaked into argv');
    const pair = (name) => argv[argv.indexOf(name) + 1];
    eq(pair('--input-format'), 'text');
  });

  test('the run is non-interactive, machine-readable and permits guarded edits', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder' });
    const pair = (name) => argv[argv.indexOf(name) + 1];
    ok(argv.includes('-p'), 'not one-shot');
    eq(pair('--agent'), 'knowledge-builder');
    eq(pair('--output-format'), 'json');
    eq(pair('--permission-mode'), 'acceptEdits');
    eq(pair('--permission-prompts'), 'none');
    ok(agentMod.versionAtLeast('2.1.278'), 'current Claude Code version was rejected');
    ok(!agentMod.versionAtLeast('2.1.258'), 'unsupported permission protocol was accepted');
  });

  test('bypassPermissions is never passed — it would disable the kit guard', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder' });
    ok(!argv.includes('bypassPermissions'), 'the guard must stay in force');
  });

  test('an agent name that is not a plain name is rejected', () => {
    for (const bad of ['../escape', 'a b', 'x\ny', '-flag', '', 'a;b']) {
      let threw = false;
      try { agentMod.assertAgentName(bad); } catch { threw = true; }
      ok(threw, `accepted a bad agent name: ${JSON.stringify(bad)}`);
    }
    eq(agentMod.assertAgentName('knowledge-builder'), 'knowledge-builder');
  });

  test('the prompt names the target PKG commit and forbids writing outside .aidev/knowledge/', () => {
    const p = agentMod.buildPrompt({ targetSha: 'abc123', paths: ['src/a.ts'] });
    ok(p.includes('Target PKG commit: abc123'), 'no target SHA line');
    ok(p.includes(`Write only inside ${K}/**`), 'the write restriction is not stated');
    ok(p.includes('src/a.ts'), 'the queued path is missing');
    ok(/^Generation targets \(1;/m.test(p), 'the generation targets section is missing');
    ok(/^Repository evidence \(/m.test(p), 'the repository evidence section is missing');
    ok(p.includes(`${inventory.DONE_DIR_REL}/`), 'the completion report location is not stated');
    eq(inventory.DONE_DIR_REL, `${K}/.cache/done`);
  });

  test('an oversized task list spills to a gitignored file instead of argv', () => {
    const fx = makeRepo();
    try {
      const many = Array.from({ length: 4000 }, (_, i) => `src/generated/file-${i}.ts`);
      const { prompt, taskFile } = agentMod.prepareTask(fx.root, { targetSha: 'deadbeef', paths: many });
      ok(taskFile, 'a huge list was inlined into argv');
      ok(taskFile.startsWith(`${K}/.cache/`), `task file outside the cache: ${taskFile}`);
      ok(Buffer.byteLength(prompt, 'utf8') <= agentMod.MAX_INLINE_PROMPT_BYTES,
        'the prompt is still oversized after spilling');
      ok(fs.existsSync(path.join(fx.root, taskFile)), 'the task file was not written');
      // .aidev/.gitignore keeps knowledge/.cache/ out of git.
      const status = require('./fixtures').git(['status', '--porcelain'], fx.root);
      ok(!/knowledge\/\.cache/.test(status), `the plan file is not ignored: ${status}`);
    } finally { fx.cleanup(); }
  });

  test('--agent is not an option: the agent runs by default', () => {
    const { parseArgs } = require('../cli/lib/args');
    const knowledgeFlags = require('../cli/commands/knowledge').FLAGS;
    let threw = false;
    try { parseArgs(['--agent'], knowledgeFlags); } catch (e) { threw = /unknown option: --agent/.test(e.message); }
    ok(threw, '--agent was still accepted');
    eq(parseArgs(['--no-agent', '--full'], knowledgeFlags).flags, { 'no-agent': true, full: true });
  });

  test('a bad --agent-timeout is refused before anything is spawned', () => {
    for (const bad of ['abc', '5', '99999999']) {
      let threw = false;
      try { agentMod.resolveOptions({ 'agent-timeout': bad }, null); } catch { threw = true; }
      ok(threw, `accepted --agent-timeout ${bad}`);
    }
  });

  test('no --model is passed when nothing configured one', () => {
    // Passing a model unconditionally would sit above the developer's own
    // settings.local.json and ANTHROPIC_MODEL, overriding a choice nobody made.
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder' });
    ok(!argv.includes('--model'), '--model was passed with no model configured');
  });

  test('the configured model reaches argv as the value of --model', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', model: 'opus' });
    eq(argv[argv.indexOf('--model') + 1], 'opus');
    eq(argv[0], '-p');
  });

  test('tools.agent_model in aidev.yaml is the default and --agent-model overrides it', () => {
    // The loader exposes tools.agent_model as the model.agent alias the agent
    // launcher reads.
    const config = { model: { agent: 'sonnet' }, knowledge: { agent_timeout_ms: 60000 } };
    eq(agentMod.resolveOptions({ agent: true }, config).model, 'sonnet');
    eq(agentMod.resolveOptions({ agent: true, 'agent-model': 'opus' }, config).model, 'opus');
    // Empty is the opt-out: this one run hands Claude Code no --model at all.
    eq(agentMod.resolveOptions({ agent: true, 'agent-model': '' }, config).model, null);
    // No config at all must not invent a model.
    eq(agentMod.resolveOptions({ agent: true }, null).model, null);
  });

  test('the loaded config carries tools.agent_model through to model.agent', () => {
    const cfgMod = require('../cli/lib/config');
    const fx = makeRepo({ configExtra: ['tools:', '  agent_model: sonnet'] });
    try {
      const config = cfgMod.loadConfig(fx.root);
      eq(config.tools.agent_model, 'sonnet');
      eq(config.model.agent, 'sonnet', 'the model.agent alias is missing');
      eq(agentMod.resolveOptions({ agent: true }, config).model, 'sonnet');
    } finally { fx.cleanup(); }
  });

  test('a bad --agent-model is refused before anything is spawned', () => {
    for (const bad of ['--dangerously-skip-permissions', 'a b', 'x\ny', '-opus']) {
      let threw = false;
      try { agentMod.resolveOptions({ 'agent-model': bad }, null); } catch { threw = true; }
      ok(threw, `accepted --agent-model ${JSON.stringify(bad)}`);
    }
  });

  // --------------------------------------------- agent invocation (end-to-end)
  suite('agent: knowledge build integration');

  // Each case builds its own repo on purpose. The first successful build
  // records the inventory, after which nothing is pending and a later run
  // would not start an agent at all — a shared fixture would silently stop
  // testing the thing these cases exist to test.
  const withRepo = (fn) => {
    const fx = makeRepo();
    try {
      return fn({
        fx,
        root: fx.root,
        stub: writeClaudeStub(fx.root),
        argvOut: path.join(fx.root, 'argv.json'),
        promptOut: path.join(fx.root, 'prompt.txt'),
      });
    } finally { fx.cleanup(); }
  };

  test('--no-agent spawns nothing at all', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--no-agent', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(!fs.existsSync(argvOut), 'the agent ran although --no-agent was given');
    eq(lastJson(r.out).agent.ran, false);
  }));

  const bareRepo = (extra = {}) => require('./fixtures').makeRepo({
    withConfig: false, withWiki: false, withPolicy: false, withLock: false, withAssets: false, ...extra,
  });
  const knowledgeStep = (out) => (lastJson(out).steps || []).find((s) => s.step === 'knowledge');

  test('a first-time init builds the Wiki with the agent', () => {
    const fx = bareRepo();
    try {
      const stub = writeClaudeStub(fx.root);
      const argvOut = path.join(fx.root, 'argv.json');
      const r = aidev(fx.root, ['init', '--yes', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(fs.existsSync(argvOut), `init did not start the knowledge-builder: ${r.out}`);
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'manifest.json')), 'no manifest after init');
      const step = knowledgeStep(r.out);
      eq(step.action, 'built', r.out);
      eq(step.ok, true, r.out);
      eq(step.result.agent.ran, true, 'the embedded build report does not show the agent');
    } finally { fx.cleanup(); }
  });

  test('init --no-wiki leaves the Wiki for a later init', () => {
    const fx = bareRepo();
    try {
      const stub = writeClaudeStub(fx.root);
      const argvOut = path.join(fx.root, 'argv.json');
      const r = aidev(fx.root, ['init', '--yes', '--no-wiki', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(!fs.existsSync(argvOut), 'the agent ran although --no-wiki was given');
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'manifest.json')), 'a manifest was written');
      eq(knowledgeStep(r.out).action, 'pending');
    } finally { fx.cleanup(); }
  });

  test('a member clone without the team Wiki does not build one unasked', () => {
    const fx = bareRepo({ withConfig: true });
    try {
      const stub = writeClaudeStub(fx.root);
      const argvOut = path.join(fx.root, 'argv.json');
      let r = aidev(fx.root, ['init', '--yes', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(!fs.existsSync(argvOut), 'a member init built a Wiki nobody asked for');
      eq(knowledgeStep(r.out).action, 'pending');
      r = aidev(fx.root, ['init', '--yes', '--wiki', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(fs.existsSync(argvOut), '--wiki did not build');
      eq(knowledgeStep(r.out).action, 'built');
    } finally { fx.cleanup(); }
  });

  test('a second init continues an unfinished Wiki', () => {
    const fx = bareRepo();
    try {
      const stub = writeClaudeStub(fx.root);
      let r = aidev(fx.root, ['init', '--yes', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_MODE: 'partial' } });
      ok(r.code !== 0, `a partial build should fail init: ${r.out}`);
      eq(knowledgeStep(r.out).ok, false);
      const argvOut = path.join(fx.root, 'argv.json');
      r = aidev(fx.root, ['init', '--yes', '--json'], { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(fs.existsSync(argvOut), 'the second init did not continue the build');
      eq(knowledgeStep(r.out).action, 'built');
      eq(knowledgeStep(r.out).ok, true, r.out);
    } finally { fx.cleanup(); }
  });

  test('the agent runs by default', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(fs.existsSync(argvOut), `the agent did not run by default: ${r.out}`);
    eq(lastJson(r.out).agent.ran, true);
  }));

  test('--no-agent with --agent-name is rejected', () => withRepo(({ root, stub }) => {
    const r = aidev(root, ['knowledge', 'build', '--no-agent', '--agent-name', 'x', '--json'], { env: { AIDEV_CLAUDE_BIN: stub } });
    eq(r.code, 1, r.out);
    ok(/--no-agent cannot be combined/.test(r.out), r.out);
  }));

  test('the build targets the merge-base with the tracking branch', () => withRepo(({ fx, root }) => {
    const r = aidev(root, ['knowledge', 'build', '--json']);
    eq(r.code, 0, r.out);
    eq(lastJson(r.out).targetSha, fx.setupSha, 'target is not HEAD == origin/main');
    eq(readManifest(root).knowledgeSha, fx.setupSha, 'the manifest does not describe the target');
  }));

  test('--dry-run reports the agent it would run but spawns nothing', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--dry-run'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(!fs.existsSync(argvOut), 'a dry run spawned the agent');
  }));

  test('the build spawns claude with the documented argv and prompt on stdin', () => withRepo(({ fx, root, stub, argvOut, promptOut }) => {
    const r = aidev(root, ['knowledge', 'build'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut } });
    eq(r.code, 0, r.out);
    ok(fs.existsSync(argvOut), `the agent never ran: ${r.out}`);
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    const pair = (name) => argv[argv.indexOf(name) + 1];
    eq(argv[0], '-p');
    eq(pair('--input-format'), 'text');
    eq(pair('--agent'), 'knowledge-builder');
    eq(pair('--output-format'), 'json');
    eq(pair('--permission-mode'), 'acceptEdits');
    eq(pair('--permission-prompts'), 'none');
    ok(!argv.some((arg) => /Generate the LLM Wiki/.test(arg)), 'prompt leaked into argv');
    const prompt = fs.readFileSync(promptOut, 'utf8');
    ok(prompt.includes('Generate the LLM Wiki prose'), 'complete prompt did not arrive on stdin');
    ok(prompt.includes(`Target PKG commit: ${fx.setupSha}`), `the prompt names another commit:\n${prompt}`);
    ok(prompt.includes(`Write only inside ${K}/**`), 'the write restriction is not stated');
  }));

  test('a legacy Windows .cmd launcher preserves stdin and terminates its process tree', () => {
    if (process.platform !== 'win32') return;
    const writeCmd = (root, stub) => {
      const cmd = path.join(root, 'fake-claude.cmd');
      fs.writeFileSync(cmd, [
        '@echo off',
        'if "%~1"=="--version" (',
        '  echo 2.1.278 ^(Claude Code^)',
        '  exit /b 0',
        ')',
        `"${process.execPath}" "${stub}" %*`,
        '',
      ].join('\r\n'), 'utf8');
      return cmd;
    };
    withRepo(({ root, stub, argvOut, promptOut }) => {
      const r = aidev(root, ['knowledge', 'build'], { env: {
        AIDEV_CLAUDE_BIN: writeCmd(root, stub),
        STUB_ARGV_OUT: argvOut,
        STUB_PROMPT_OUT: promptOut,
      } });
      eq(r.code, 0, `legacy .cmd launcher failed: ${r.out}`);
      const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
      eq(argv[argv.indexOf('--agent') + 1], 'knowledge-builder');
      ok(fs.readFileSync(promptOut, 'utf8').includes('Generate the LLM Wiki prose'),
        'legacy .cmd launcher truncated stdin prompt');
    });
    withRepo(({ root, stub, argvOut }) => {
      const started = Date.now();
      const r = aidev(root, ['knowledge', 'build', '--agent-timeout', '10000', '--json'], { env: {
        AIDEV_CLAUDE_BIN: writeCmd(root, stub),
        STUB_ARGV_OUT: argvOut,
        STUB_MODE: 'hang',
      } });
      eq(r.code, 1, `legacy .cmd timeout did not fail: ${r.out}`);
      eq(lastJson(r.out).agent.timedOut, true, 'legacy .cmd timeout was not reported');
      ok(Date.now() - started < 20000, 'Claude grandchild survived after cmd.exe timeout');
    });
  });

  test('--agent-name overrides which agent is started', () => withRepo(({ root, stub, argvOut }) => {
    aidev(root, ['knowledge', 'build', '--agent-name', 'custom-builder'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(fs.existsSync(argvOut), 'the named agent never ran');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    eq(argv[argv.indexOf('--agent') + 1], 'custom-builder');
  }));

  test('--agent-model reaches the spawned process as --model', () => withRepo(({ root, stub, argvOut }) => {
    aidev(root, ['knowledge', 'build', '--agent-model', 'claude-opus-4-8'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(fs.existsSync(argvOut), 'the run never started an agent');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    eq(argv[argv.indexOf('--model') + 1], 'claude-opus-4-8');
  }));

  test('a rejected model never reaches a subprocess', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent-model', '--dangerously-skip-permissions'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(r.code !== 0, `a flag-shaped model was accepted: ${r.out}`);
    ok(!fs.existsSync(argvOut), 'the bad model was still spawned');
  }));

  test('a rejected agent name never reaches a subprocess', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent-name', '../evil'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(r.code !== 0, `a path-traversing agent name was accepted: ${r.out}`);
    ok(!fs.existsSync(argvOut), 'the bad name was still spawned');
  }));

  test('a missing claude is a warning, not a failure', () => withRepo(({ root }) => {
    const r = aidev(root, ['knowledge', 'build'],
      { env: { AIDEV_CLAUDE_BIN: path.join(root, 'no-such-claude') } });
    // The structured write already succeeded, so this must not fail the run.
    eq(r.code, 0, `a missing binary failed the build: ${r.out}`);
    ok(fs.existsSync(path.join(root, K, 'manifest.json')), 'the manifest was lost');
  }));

  test('agent failures preserve the queue and align human, JSON, and exit status', () => {
    withRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['knowledge', 'build'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'fail' } });
      eq(r.code, 1, `expected exit 1: ${r.out}`);
      const m = readManifest(root);
      ok(m.checkpoint.pendingPaths.length > 0, 'a failed agent discarded the work queue');
    });
    withRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['knowledge', 'build'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'no-progress' } });
      eq(r.code, 1, `zero progress was reported as success: ${r.out}`);
      ok(/made no Wiki progress/.test(r.out), `missing no-progress diagnosis: ${r.out}`);
      ok(/need more information/.test(r.out), `Claude's result was hidden: ${r.out}`);
    });
    withRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['knowledge', 'build', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'no-progress' } });
      eq(r.code, 1, `zero-progress JSON run exited ${r.code}: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.ok, false, 'top-level JSON contradicted the failing exit code');
      eq(j.structuredOk, true, 'the completed structured write was not distinguished');
      eq(j.agent.noProgress, true, 'agent no-progress state was lost');
    });
    withRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['knowledge', 'build', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'partial' } });
      eq(r.code, 1, `partial JSON run exited ${r.code}: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.ok, false, 'partial completion was reported as success');
      eq(j.agent.partial, true, 'partial state was not reported');
      eq(j.agent.completed, 1, 'completed target count is wrong');
      ok(j.agent.remaining > 0, 'unfinished targets disappeared');
    });
    withRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['knowledge', 'build', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'missing-checkpoint' } });
      eq(r.code, 1, `missing checkpoint run exited ${r.code}: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.ok, false, 'missing checkpoint was reported as success');
      eq(j.agent.checkpointInvalid, true, 'checkpoint corruption was not exposed');
      eq(j.agent.checkpointRestored, true, 'pre-agent queue was not restored');
      eq(j.agent.completed, 0, 'missing checkpoint invented completed work');
      const restored = readManifest(root);
      ok(restored.checkpoint.pendingPaths.length > 0, 'restored checkpoint lost the unfinished queue');
      // The next (incremental) build picks the restored queue up again.
      const retry = aidev(root, ['knowledge', 'build', '--dry-run', '--json']);
      ok(lastJson(retry.out).pending.length > 0, 'the next build cannot recover the queue');
    });
  });

  test('--json stays exactly one document and carries the agent result', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
    eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}: ${r.out}`);
    const j = JSON.parse(docs[0]);
    eq(j.agent.ran, true);
    eq(j.agent.ok, true);
    eq(j.agent.agent, 'knowledge-builder');
  }));

  test('the CLI folds completion reports into the checkpoint and reports what was drained', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'drain' } });
    eq(r.code, 0, r.out);
    eq(lastJson(r.out).remaining, 0, 'the drained checkpoint was not re-read');
    const doneDir = path.join(root, K, '.cache', 'done');
    ok(!fs.existsSync(doneDir) || fs.readdirSync(doneDir).length === 0, 'consumed reports were left behind');
    const records = inventory.readInventory(root);
    ok(records.length > 0, 'no inventory records were written');
    ok(records.every((rec) => Object.keys(rec.selfHashes || {}).length > 0),
      'a completed target has no page hash recorded');
    ok(records.every((rec) => Object.keys(rec.selfHashes).every((p) => p.startsWith(`${K}/`))),
      `page paths are not repo-relative: ${JSON.stringify(records.map((rec) => rec.selfHashes))}`);
    ok(fs.existsSync(path.join(root, K, 'pages', 'auth.ts.md')), 'the page the stub wrote is not where it reported it');
  }));

  test('--scope narrows generation targets but preserves repository evidence', () => withRepo(({ root, stub, argvOut, promptOut }) => {
    aidev(root, ['knowledge', 'build', '--scope', 'docs'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut } });
    ok(fs.existsSync(argvOut), 'the scoped run never started an agent');
    const prompt = fs.readFileSync(promptOut, 'utf8');
    const generationStart = prompt.indexOf('Generation targets (');
    const evidenceStart = prompt.indexOf('Repository evidence (');
    ok(generationStart >= 0 && evidenceStart > generationStart, `prompt sections missing:\n${prompt}`);
    const generationSection = prompt.slice(generationStart, evidenceStart);
    ok(/docs\/readme\.md/.test(generationSection), `the scoped target is not queued:\n${generationSection}`);
    ok(!/src\/api/.test(generationSection),
      `deferred paths leaked into the generation queue:\n${generationSection}`);
    ok(/src\/api\/auth\.ts/.test(prompt.slice(evidenceStart)),
      `source code disappeared from repository evidence:\n${prompt}`);
    ok(!/config\/secrets/.test(prompt.slice(evidenceStart).split('Secret patterns')[0]),
      'a secret path was offered as evidence');
    ok(prompt.includes('does not limit repository research'),
      'the scoped prompt does not explain that evidence stays repository-wide');
  }));

  test('a hung agent is killed at the deadline rather than hanging the CLI', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent-timeout', '10000', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'hang' } });
    // Exits on its own rather than blocking until the harness gives up.
    eq(r.code, 1, `a hung agent did not fail the run: ${r.out}`);
    const j = lastJson(r.out);
    eq(j.agent.timedOut, true);
    ok(fs.existsSync(path.join(root, K, 'manifest.json')), 'the manifest was lost');
  }));

  // ------------------------------------------------- agent invocation in sync
  suite('agent: sync integration');

  {
    const WORKTREE = path.join('.aidev', 'cache', 'sync-worktree');

    const withAdvancedRepo = (fn) => {
      const fx = makeRepo();
      try {
        const targetSha = advancePkg(fx); // give sync a real commit to follow
        return fn({
          fx,
          root: fx.root,
          targetSha,
          stub: writeClaudeStub(fx.root),
          argvOut: path.join(fx.root, 'argv.json'),
          promptOut: path.join(fx.root, 'prompt.txt'),
          callsOut: path.join(fx.root, 'stub-calls.jsonl'),
        });
      } finally { fx.cleanup(); }
    };

    /** The developer's checkout must come out of a sync exactly as it went in. */
    const assertCheckoutUntouched = (fx) => {
      eq(readManifest(fx.root).knowledgeSha, fx.pkgSha, 'sync rewrote the manifest in the developer checkout');
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'sync.lock')), 'the sync lease outlived the run');
      ok(!fs.existsSync(path.join(fx.root, WORKTREE)), 'the temporary worktree was left behind');
      eq(require('./fixtures').git(['rev-parse', 'HEAD'], fx.root), fx.setupSha, 'sync moved HEAD of the checkout');
    };

    test('sync --no-agent leaves prose to a later run', () => withAdvancedRepo(({ fx, root, stub, argvOut }) => {
      const r = aidev(root, ['sync', '--no-pr', '--no-agent', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(!fs.existsSync(argvOut), 'sync spawned an agent although --no-agent was given');
      const j = lastJson(r.out);
      eq(j.agent.ran, false);
      eq(j.committed, true, 'the structured Wiki was not committed on the sync branch');
      ok(j.pendingPages > 0, 'nothing is owed to the agent although the source moved');
      assertCheckoutUntouched(fx);
    }));

    test('sync runs the builder inside the worktree and commits the result', () => withAdvancedRepo(({ fx, root, targetSha, stub, argvOut, promptOut, callsOut }) => {
      const r = aidev(root, ['sync', '--no-pr', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut, STUB_CALLS_OUT: callsOut } });
      eq(r.code, 0, r.out);
      ok(fs.existsSync(argvOut), `sync never started the agent: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.agent.ran, true);
      eq(j.agent.ok, true);
      eq(j.targetSha, targetSha, 'sync did not follow origin/main to the new commit');
      ok(String(j.branch).startsWith('aidev/wiki-'), `unexpected sync branch: ${j.branch}`);
      eq(j.committed, true, 'the regenerated Wiki was not committed');
      eq(j.pushed, false, '--no-pr must not push');
      eq(j.pendingPages, 0, 'targets remained queued after a drained run');
      // The agent's cwd was the worktree, so its prose landed on the sync branch.
      const calls = fs.readFileSync(callsOut, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      ok(calls.every((c) => path.resolve(c.cwd) === path.resolve(root, WORKTREE)),
        `the agent did not run inside the worktree: ${JSON.stringify(calls.map((c) => c.cwd))}`);
      ok(fs.readFileSync(promptOut, 'utf8').includes(`Target PKG commit: ${targetSha}`), 'the agent was told the wrong commit');
      const { git } = require('./fixtures');
      const committed = JSON.parse(git(['show', `${j.branch}:${K}/manifest.json`], root));
      eq(committed.knowledgeSha, targetSha, 'the committed manifest does not describe the target');
      eq(committed.checkpoint.pendingPaths, [], 'the committed checkpoint still owes prose');
      ok(git(['ls-tree', '--name-only', '-r', j.branch], root).includes(`${K}/pages/new.ts.md`),
        'the page the agent wrote is not on the sync branch');
      // Holding the lease across a multi-minute agent would block every other
      // sync; it, and the worktree, must be gone by the time the command returns.
      assertCheckoutUntouched(fx);
    }));

    test('agent failure or no progress does not unwind sync and JSON reports failure', () => {
      withAdvancedRepo(({ fx, root, stub, argvOut }) => {
        const r = aidev(root, ['sync', '--no-pr'],
          { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'fail' } });
        eq(r.code, 1, `expected exit 1: ${r.out}`);
        // The structured Wiki is still committed: only prose is owed.
        ok(/sync lease released/.test(r.out), `the lease was not released: ${r.out}`);
        assertCheckoutUntouched(fx);
      });
      withAdvancedRepo(({ fx, root, stub, argvOut }) => {
        const r = aidev(root, ['sync', '--no-pr', '--json'],
          { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'no-progress' } });
        eq(r.code, 1, `zero-progress sync exited ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        eq(j.ok, false, 'sync JSON contradicted its failing exit code');
        eq(j.structuredOk, true, 'sync lost its successful structured result');
        eq(j.agent.noProgress, true, 'sync did not report agent no progress');
        eq(j.committed, true, 'the structured result was not committed although it is valid');
        ok(j.pendingPages > 0, 'the unfinished queue disappeared');
        assertCheckoutUntouched(fx);
      });
      withAdvancedRepo(({ fx, root, stub, argvOut }) => {
        const r = aidev(root, ['sync', '--json'],
          { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'missing-checkpoint' } });
        eq(r.code, 1, `missing-checkpoint sync exited ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        eq(j.ok, false, 'checkpoint failure was reported as success');
        eq(j.structuredOk, true, 'a restorable checkpoint was graded as a structured failure');
        eq(j.agent.checkpointRestored, true, 'sync did not restore its pending queue');
        eq(j.pr.blocked, true, 'sync attempted publication after checkpoint failure');
        eq(j.committed, false, 'a corrupted Wiki was committed');
        ok(j.pendingPages > 0, 'sync lost its restored queue');
        assertCheckoutUntouched(fx);
      });
      withAdvancedRepo(({ fx, root, stub, argvOut }) => {
        const r = aidev(root, ['sync', '--json'],
          { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'target-mismatch' } });
        eq(r.code, 1, `target-mismatch sync exited ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        eq(j.ok, false, 'target mismatch was reported as success');
        eq(j.structuredOk, false, 'target mismatch kept structuredOk true');
        eq(j.agent.targetMismatch, true, 'target mismatch was not exposed');
        eq(j.pr.blocked, true, 'sync attempted publication for the wrong target');
        eq(j.committed, false, 'a Wiki describing the wrong commit was committed');
        assertCheckoutUntouched(fx);
      });
    });
  }
}

module.exports = { run, writeClaudeStub, aidev, lastJson, AIDEV_HOME };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
