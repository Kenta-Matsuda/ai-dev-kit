'use strict';
/**
 * Coverage for the behaviours completed after the first implementation pass.
 *
 * Each suite here pins down something that previously either did nothing or
 * actively failed:
 *
 *   - `aidev task advance` with no id (the form the nightly pipeline runs)
 *   - `aidev task resume` moving a task rather than only describing it
 *   - the permission weakening check that gates --approve
 *   - orphaned Wiki page removal (README scenario 7)
 *   - session-start surfacing merged-but-unsynced tasks
 *   - the self-evolution journal written at session-stop
 *
 * Run: node test/completion.test.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo } = require('./fixtures');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');
const inventory = require('../cli/lib/inventory');
const permissionMod = require('../cli/commands/permission');
const agentMod = require('../cli/lib/agent');

/** Run the real CLI the way a pipeline or hook does. */
function aidev(root, args, { input = undefined, env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [BIN, ...args], {
      cwd: root, encoding: 'utf8', input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function writeTask(root, rec) {
  const p = path.join(root, '.aidev', 'tasks', `${rec.taskId}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify({
    schemaVersion: 1, history: [], updatedAt: new Date().toISOString(), ...rec,
  }, null, 2)}\n`, 'utf8');
  return p;
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

/**
 * A stand-in for the Claude Code binary.
 *
 * The suite must never spawn the real `claude`: it costs money, needs a network
 * and would take minutes. The stub records the argv it was handed so the tests
 * can assert on how the CLI invokes an agent, and `STUB_MODE` selects the
 * outcome. `AIDEV_CLAUDE_BIN` is the documented seam for exactly this.
 */
function writeClaudeStub(root) {
  const p = path.join(root, 'fake-claude.js');
  fs.writeFileSync(p, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
if (process.env.STUB_ARGV_OUT) {
  fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(argv, null, 2));
}
const mode = process.env.STUB_MODE || 'ok';
if (mode === 'fail') {
  process.stderr.write('stub: the agent could not continue\\n');
  process.stdout.write(JSON.stringify({ result: 'boom', is_error: true }) + '\\n');
  process.exit(1);
}
if (mode === 'hang') { setTimeout(() => {}, 600000); return; }
if (mode === 'drain') {
  // Behave like a real run: clear the checkpoint the CLI queued.
  const mp = 'knowledge/manifest.json';
  try {
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.checkpoint = Object.assign({}, m.checkpoint, { pendingPaths: [] });
    fs.writeFileSync(mp, JSON.stringify(m, null, 2) + '\\n');
  } catch (e) { /* leave it be */ }
}
process.stdout.write(JSON.stringify({
  result: 'wrote the pages', is_error: false, total_cost_usd: 0.0123,
  session_id: 'stub-session',
}) + '\\n');
`, 'utf8');
  return p;
}

function run() {
  // ------------------------------------------------------- task advance (bulk)
  suite('task: advance with no id');

  {
    const fx = makeRepo();
    try {
      test('the pipeline form runs instead of erroring on a missing id', () => {
        // azure-pipelines-sync.yml ships `aidev task advance` with no argument.
        const r = aidev(fx.root, ['task', 'advance']);
        eq(r.code, 0, `expected exit 0, got ${r.code}: ${r.out}`);
        ok(!/usage: aidev task advance/.test(r.out), 'still demands a task id');
      });

      test('it reports that there is nothing to do rather than failing', () => {
        const r = aidev(fx.root, ['task', 'advance', '--json']);
        const j = lastJson(r.out);
        ok(j, `no JSON in output: ${r.out}`);
        eq(j.advanced, 0, 'nothing should have advanced');
        eq(j.failed, 0, 'nothing should have failed');
      });

      test('terminal tasks are skipped, not advanced', () => {
        writeTask(fx.root, { taskId: 'wi-1', workItemId: 1, state: 'DONE' });
        const r = aidev(fx.root, ['task', 'advance', '--json']);
        const j = lastJson(r.out);
        ok(j, 'no JSON emitted');
        eq(j.advanced, 0, 'a DONE task must not advance');
      });

      test('an observable transition is taken for every eligible task', () => {
        // PKG_PR_MERGED → SYNCHRONIZING needs no API call, so it is the one
        // transition a hermetic test can drive end to end.
        writeTask(fx.root, { taskId: 'wi-2', workItemId: 2, state: 'PKG_PR_MERGED' });
        writeTask(fx.root, { taskId: 'wi-3', workItemId: 3, state: 'PKG_PR_MERGED' });
        const r = aidev(fx.root, ['task', 'advance', '--json']);
        const j = lastJson(r.out);
        ok(j, 'no JSON emitted');
        eq(j.advanced, 2, `expected both tasks to advance: ${r.out}`);
        for (const id of ['wi-2', 'wi-3']) {
          const rec = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'tasks', `${id}.json`), 'utf8'));
          eq(rec.state, 'SYNCHRONIZING', `${id} was not persisted`);
        }
      });

      test('--json emits exactly one parseable document', () => {
        const r = aidev(fx.root, ['task', 'advance', '--json']);
        const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
        eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}`);
      });

      test('--state is rejected in bulk mode rather than applied to everything', () => {
        const r = aidev(fx.root, ['task', 'advance', '--state', 'BLOCKED']);
        ok(r.code !== 0, 'bulk --state must not silently succeed');
        ok(/requires a task id/.test(r.out), `unexpected message: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------------------------- task resume
  suite('task: resume advances the task');

  {
    const fx = makeRepo();
    try {
      test('resume moves a merged task forward instead of only advising', () => {
        writeTask(fx.root, { taskId: 'wi-10', workItemId: 10, state: 'PKG_PR_MERGED' });
        const r = aidev(fx.root, ['task', 'resume', 'wi-10', '--json']);
        eq(r.code, 0, `exit ${r.code}: ${r.out}`);
        const rec = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'tasks', 'wi-10.json'), 'utf8'));
        ok(rec.state !== 'PKG_PR_MERGED', 'resume left the task where it was');
      });

      test('resume still reports what the human has to do next', () => {
        writeTask(fx.root, { taskId: 'wi-11', workItemId: 11, state: 'IMPLEMENTING' });
        const r = aidev(fx.root, ['task', 'resume', 'wi-11', '--json']);
        const j = lastJson(r.out);
        ok(j && typeof j.guidance === 'string' && j.guidance.length > 0, 'no guidance returned');
      });

      test('a terminal task is not moved', () => {
        writeTask(fx.root, { taskId: 'wi-12', workItemId: 12, state: 'DONE' });
        aidev(fx.root, ['task', 'resume', 'wi-12', '--json']);
        const rec = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'tasks', 'wi-12.json'), 'utf8'));
        eq(rec.state, 'DONE', 'a DONE task must stay DONE');
      });

      test('resume does not loop forever on a state it cannot observe', () => {
        writeTask(fx.root, { taskId: 'wi-13', workItemId: 13, state: 'BLOCKED', note: 'needs a human' });
        const r = aidev(fx.root, ['task', 'resume', 'wi-13', '--json']);
        eq(r.code, 0, `exit ${r.code}: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------------- permission: weakening
  suite('permission: weakening detection');

  test('removing a protected path is detected', () => {
    const current = { protected: ['.claude/**', 'CLAUDE.md'], read_only: ['src/**'], writable_during_sync: [], writable: [] };
    const candidate = { protected: ['.claude/**'], read_only: ['src/**'], writable_during_sync: [], writable: [] };
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
    const current = { protected: [], read_only: [], writable_during_sync: ['knowledge/**'], writable: [] };
    const candidate = { protected: [], read_only: [], writable_during_sync: ['knowledge/**'], writable: ['knowledge/**'] };
    const r = permissionMod.detectWeakening(current, candidate);
    ok(r.weakening, 'escalation to unconditional write must be caught');
  });

  test('the first policy ever placed is not judged against nothing', () => {
    const candidate = { protected: ['.claude/**'], read_only: ['src/**'], writable_during_sync: [], writable: [] };
    ok(!permissionMod.detectWeakening(null, candidate).weakening, 'initial placement must not be blocked');
  });

  {
    const fx = makeRepo({ withPolicy: true });
    try {
      test('--approve refuses to place a weakening candidate without --force', () => {
        // The fixture policy protects the secrets path; a config with no
        // secrets_paths derives a candidate that drops it.
        const cfg = path.join(fx.root, 'aidev.yaml');
        fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8')
          .replace('secrets_paths:\n  - "src/config/secrets/**"\n', 'secrets_paths: []\n'), 'utf8');

        const r = aidev(fx.root, ['permission', 'reconfigure', '--approve']);
        eq(r.code, 3, `expected exit 3 (permission), got ${r.code}: ${r.out}`);
        const policy = fs.readFileSync(path.join(fx.root, '.aidev', 'policy.yaml'), 'utf8');
        ok(/secrets/.test(policy), 'the protection was dropped despite the refusal');
      });

      test('--force places it and says what was given up', () => {
        const r = aidev(fx.root, ['permission', 'reconfigure', '--approve', '--force']);
        eq(r.code, 0, `expected exit 0, got ${r.code}: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------- knowledge: orphaned page removal
  suite('knowledge: orphaned pages (scenario 7)');

  test('a page belonging only to a deleted file is orphaned', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { 'knowledge/src/a.md': 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, []), ['knowledge/src/a.md']);
  });

  test('a page still referenced by a surviving file is kept', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { 'knowledge/src/shared.md': 'sha256:x' } }];
    const surviving = [{ path: 'src/b.ts', selfHashes: { 'knowledge/src/shared.md': 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, surviving), [], 'a shared page must not be deleted');
  });

  test('index.md is never treated as orphaned', () => {
    const removed = [{ path: 'src/a.ts', selfHashes: { 'knowledge/src/index.md': 'sha256:x' } }];
    eq(inventory.orphanedPages(removed, []), [], 'directory indexes survive their files');
  });

  {
    const fx = makeRepo();
    try {
      const page = path.join(fx.root, 'knowledge', 'src', 'gone.md');
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.writeFileSync(page, '# gone\n', 'utf8');
      fs.writeFileSync(path.join(fx.root, 'knowledge', 'src', 'index.md'), '# dir\n', 'utf8');

      test('the page is deleted and its parent index reported stale', () => {
        const r = inventory.removeOrphanedPages(fx.root, ['knowledge/src/gone.md']);
        eq(r.deleted, ['knowledge/src/gone.md']);
        ok(!fs.existsSync(page), 'the file is still on disk');
        ok(r.staleIndexes.includes('knowledge/src/index.md'), 'the parent index was not flagged');
      });

      test('a path escaping knowledge/ is refused, not deleted', () => {
        const outside = path.join(fx.root, 'CLAUDE.md');
        const r = inventory.removeOrphanedPages(fx.root, ['../CLAUDE.md', 'CLAUDE.md']);
        eq(r.deleted, [], 'nothing outside knowledge/ may be deleted');
        ok(fs.existsSync(outside), 'a kit-owned file was deleted');
      });

      test('deleting an already-absent page is not an error', () => {
        const r = inventory.removeOrphanedPages(fx.root, ['knowledge/src/never-existed.md']);
        eq(r.deleted, []);
        ok(r.skipped.some((s) => /absent/.test(s.reason)), 'the skip reason is not recorded');
      });
    } finally { fx.cleanup(); }
  }

  // --------------------------------------------------- hooks: session-start
  suite('hooks: session-start surfaces unsynced work');

  {
    const fx = makeRepo();
    try {
      test('a merged-but-unsynced task is presented', () => {
        writeTask(fx.root, { taskId: 'wi-77', workItemId: 77, state: 'PKG_PR_MERGED' });
        const r = aidev(fx.root, ['hook', 'session-start'], { input: '{}' });
        eq(r.code, 0, `hook exited ${r.code}: ${r.out}`);
        ok(/wi-77/.test(r.out), `the task was not surfaced: ${r.out}`);
      });

      test('a task waiting on a human merge is reported separately', () => {
        writeTask(fx.root, { taskId: 'wi-78', workItemId: 78, state: 'PKG_PR_OPEN', pkgPullRequestId: 5 });
        const r = aidev(fx.root, ['hook', 'session-start'], { input: '{}' });
        ok(/waiting on a human merge/.test(r.out), `not reported: ${r.out}`);
      });

      test('the hook still emits one JSON document', () => {
        const r = aidev(fx.root, ['hook', 'session-start'], { input: '{}' });
        const j = lastJson(r.out);
        ok(j && j.hookSpecificOutput, `malformed hook output: ${r.out}`);
      });

      test('a corrupt task cache cannot break the session', () => {
        const p = path.join(fx.root, '.aidev', 'tasks', 'broken.json');
        fs.writeFileSync(p, '{ not json', 'utf8');
        const r = aidev(fx.root, ['hook', 'session-start'], { input: '{}' });
        eq(r.code, 0, `a bad cache file broke SessionStart: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ---------------------------------------------------- hooks: session-stop
  suite('hooks: session-stop self-evolution journal');

  {
    const fx = makeRepo();
    try {
      const journal = path.join(fx.root, '.aidev', 'cache', 'evolution-journal.json');

      test('a clean session records no observation', () => {
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: '{}' });
        eq(r.code, 0, `exit ${r.code}: ${r.out}`);
        const j = lastJson(r.out);
        ok(j && j.evolution && j.evolution.enabled, 'self-evolution should be enabled by default');
        ok(!j.evolution.recorded, 'a healthy session is not a signal');
      });

      test('an expired work lease is recorded as a signal', () => {
        const leaseDir = path.join(fx.root, '.aidev', 'leases');
        fs.mkdirSync(leaseDir, { recursive: true });
        fs.writeFileSync(path.join(leaseDir, 'wi-9.json'), `${JSON.stringify({
          taskId: 'wi-9', branch: 'ai/wi-9', paths: ['src/**'],
          acquiredAt: new Date(Date.now() - 86400000).toISOString(), ttlMinutes: 1,
        })}\n`, 'utf8');

        const r = aidev(fx.root, ['hook', 'session-stop'], { input: '{}' });
        eq(r.code, 0, `exit ${r.code}: ${r.out}`);
        ok(fs.existsSync(journal), 'no journal was written');
        const doc = JSON.parse(fs.readFileSync(journal, 'utf8'));
        ok(doc.observations.length > 0, 'the signal was not recorded');
      });

      test('the journal never stores prompts, responses or diffs', () => {
        const raw = fs.readFileSync(journal, 'utf8');
        const doc = JSON.parse(raw);
        for (const o of doc.observations) {
          eq(Object.keys(o).sort(), ['at', 'signals'], 'unexpected fields in an observation');
        }
      });

      test('disabling self_evolution stops the recording', () => {
        const cfg = path.join(fx.root, 'aidev.yaml');
        fs.appendFileSync(cfg, 'self_evolution:\n  enabled: false\n', 'utf8');
        const r = aidev(fx.root, ['hook', 'session-stop'], { input: '{}' });
        const j = lastJson(r.out);
        ok(j && j.evolution && j.evolution.enabled === false, `not disabled: ${r.out}`);
      });
    } finally { fx.cleanup(); }
  }

  // ------------------------------------------------- agent invocation (unit)
  suite('agent: argv and prompt construction');

  test('the prompt is positional and precedes every variadic flag', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', prompt: 'DO IT' });
    // --tools/--allowedTools/--disallowedTools are variadic in the Claude CLI,
    // so a prompt placed after one of them would be eaten as its value.
    eq(argv[0], '-p');
    eq(argv[1], 'DO IT');
    const firstVariadic = argv.findIndex((a) => /^--(tools|allowedTools|disallowedTools)$/.test(a));
    ok(firstVariadic === -1 || firstVariadic > 1, 'a variadic flag precedes the prompt');
  });

  test('the run is non-interactive, machine-readable and cannot hang on a prompt', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', prompt: 'x' });
    const pair = (name) => argv[argv.indexOf(name) + 1];
    ok(argv.includes('-p'), 'not one-shot');
    eq(pair('--agent'), 'knowledge-builder');
    eq(pair('--output-format'), 'json');
    eq(pair('--permission-mode'), 'dontAsk');
  });

  test('bypassPermissions is never passed — it would disable the kit guard', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', prompt: 'x' });
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

  test('the prompt names the target SHA and forbids writing outside knowledge/', () => {
    const p = agentMod.buildPrompt({ targetSha: 'abc123', paths: ['src/a.ts'] });
    ok(p.includes('abc123'), 'no target SHA');
    ok(/knowledge\/\*\*/.test(p), 'the write restriction is not stated');
    ok(p.includes('src/a.ts'), 'the queued path is missing');
  });

  test('an oversized task list spills to a gitignored file instead of argv', () => {
    const fx = makeRepo();
    try {
      const many = Array.from({ length: 4000 }, (_, i) => `src/src/generated/file-${i}.ts`);
      const { prompt, taskFile } = agentMod.prepareTask(fx.root, { targetSha: 'deadbeef', paths: many });
      ok(taskFile, 'a huge list was inlined into argv');
      ok(taskFile.startsWith('knowledge/.cache/'), `task file outside the cache: ${taskFile}`);
      ok(Buffer.byteLength(prompt, 'utf8') <= agentMod.MAX_INLINE_PROMPT_BYTES,
        'the prompt is still oversized after spilling');
      ok(fs.existsSync(path.join(fx.root, taskFile)), 'the task file was not written');
    } finally { fx.cleanup(); }
  });

  test('--agent is boolean, so it cannot swallow the next flag as a name', () => {
    // As a string flag, `--agent --refresh` would parse the agent name as
    // "--refresh"; the name override lives on its own flag instead.
    const { parseArgs } = require('../cli/lib/args');
    const knowledgeFlags = require('../cli/commands/knowledge').FLAGS;
    const { flags } = parseArgs(['--agent', '--refresh'], knowledgeFlags);
    eq(flags.agent, true);
    eq(flags.refresh, true);
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
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', prompt: 'x' });
    ok(!argv.includes('--model'), '--model was passed with no model configured');
  });

  test('the configured model reaches argv as the value of --model', () => {
    const argv = agentMod.buildArgv({ agent: 'knowledge-builder', prompt: 'x', model: 'opus' });
    eq(argv[argv.indexOf('--model') + 1], 'opus');
    // The prompt stays positional and first no matter what is inserted after it.
    eq(argv[0], '-p');
    eq(argv[1], 'x');
  });

  test('model.agent in aidev.yaml is the default and --agent-model overrides it', () => {
    const config = { model: { agent: 'sonnet' }, knowledge: { agent_timeout_ms: 60000 } };
    eq(agentMod.resolveOptions({ agent: true }, config).model, 'sonnet');
    eq(agentMod.resolveOptions({ agent: true, 'agent-model': 'opus' }, config).model, 'opus');
    // Empty is the opt-out: this one run hands Claude Code no --model at all.
    eq(agentMod.resolveOptions({ agent: true, 'agent-model': '' }, config).model, null);
    // No config at all must not invent a model.
    eq(agentMod.resolveOptions({ agent: true }, null).model, null);
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
        root: fx.root,
        stub: writeClaudeStub(fx.root),
        argvOut: path.join(fx.root, 'argv.json'),
      });
    } finally { fx.cleanup(); }
  };

  test('without --agent nothing is spawned at all', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(!fs.existsSync(argvOut), 'the agent ran without being asked');
    eq(lastJson(r.out).agent.ran, false);
  }));

  test('--dry-run --agent reports the intent but spawns nothing', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--dry-run', '--agent'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(!fs.existsSync(argvOut), 'a dry run spawned the agent');
  }));

  test('--agent spawns it with the documented argv', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    eq(r.code, 0, r.out);
    ok(fs.existsSync(argvOut), `the agent never ran: ${r.out}`);
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    eq(argv[0], '-p');
    eq(argv[argv.indexOf('--agent') + 1], 'knowledge-builder');
    eq(argv[argv.indexOf('--output-format') + 1], 'json');
    eq(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
  }));

  test('--agent-name overrides which agent is started', () => withRepo(({ root, stub, argvOut }) => {
    aidev(root, ['knowledge', 'build', '--agent-name', 'custom-builder'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(fs.existsSync(argvOut), 'the named agent never ran');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    eq(argv[argv.indexOf('--agent') + 1], 'custom-builder');
  }));

  test('--agent-model reaches the spawned process as --model', () => withRepo(({ root, stub, argvOut }) => {
    aidev(root, ['knowledge', 'build', '--agent', '--agent-model', 'claude-opus-4-8'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(fs.existsSync(argvOut), 'the run never started an agent');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    eq(argv[argv.indexOf('--model') + 1], 'claude-opus-4-8');
  }));

  test('a rejected model never reaches a subprocess', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent', '--agent-model', '--dangerously-skip-permissions'],
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
    const r = aidev(root, ['knowledge', 'build', '--agent'],
      { env: { AIDEV_CLAUDE_BIN: path.join(root, 'no-such-claude') } });
    // The structured write already succeeded, so this must not fail the run.
    eq(r.code, 0, `a missing binary failed the build: ${r.out}`);
    ok(fs.existsSync(path.join(root, 'knowledge', 'manifest.json')), 'the manifest was lost');
  }));

  test('an agent failure exits non-zero but keeps the checkpoint', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'fail' } });
    eq(r.code, 1, `expected exit 1: ${r.out}`);
    const m = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', 'manifest.json'), 'utf8'));
    ok(m.checkpoint.pendingPaths.length > 0, 'a failed agent discarded the work queue');
  }));

  test('--json stays exactly one document and carries the agent result', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
    eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}: ${r.out}`);
    const j = JSON.parse(docs[0]);
    eq(j.agent.ran, true);
    eq(j.agent.ok, true);
    eq(j.agent.agent, 'knowledge-builder');
  }));

  test('the agent owns the checkpoint; the CLI reports what it drained', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'drain' } });
    eq(r.code, 0, r.out);
    eq(lastJson(r.out).remaining, 0, 'the drained checkpoint was not re-read');
  }));

  test('--scope keeps out-of-scope paths out of the agent prompt', () => withRepo(({ root, stub, argvOut }) => {
    aidev(root, ['knowledge', 'build', '--agent', '--scope', 'src/docs'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
    ok(fs.existsSync(argvOut), 'the scoped run never started an agent');
    const argv = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
    const prompt = argv[argv.indexOf('-p') + 1];
    ok(!/src\/src\/api/.test(prompt), `deferred paths leaked into a scoped run:\n${prompt}`);
  }));

  test('a hung agent is killed at the deadline rather than hanging the CLI', () => withRepo(({ root, stub, argvOut }) => {
    const r = aidev(root, ['knowledge', 'build', '--agent', '--agent-timeout', '10000', '--json'],
      { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'hang' } });
    // Exits on its own rather than blocking until the harness gives up.
    eq(r.code, 1, `a hung agent did not fail the run: ${r.out}`);
    const j = lastJson(r.out);
    eq(j.agent.timedOut, true);
    ok(fs.existsSync(path.join(root, 'knowledge', 'manifest.json')), 'the manifest was lost');
  }));

  // ------------------------------------------------- agent invocation in sync
  suite('agent: sync integration');

  {
    const { advancePkg } = require('./fixtures');

    const withAdvancedRepo = (fn) => {
      const fx = makeRepo();
      try {
        advancePkg(fx); // give sync a real SHA to follow
        return fn({
          root: fx.root,
          stub: writeClaudeStub(fx.root),
          argvOut: path.join(fx.root, 'argv.json'),
        });
      } finally { fx.cleanup(); }
    };

    test('sync without --agent leaves prose to a later run', () => withAdvancedRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['sync', '--no-pr', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(!fs.existsSync(argvOut), 'sync spawned an agent nobody asked for');
    }));

    test('sync --agent runs the builder after releasing the lease', () => withAdvancedRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['sync', '--no-pr', '--agent', '--json'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut } });
      eq(r.code, 0, r.out);
      ok(fs.existsSync(argvOut), `sync never started the agent: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.agent.ran, true);
      eq(j.agent.ok, true);
      // Holding the lease across a multi-minute agent would block every other
      // sync; it must be gone by the time the command returns either way.
      ok(!fs.existsSync(path.join(root, '.aidev', 'sync.lock')), 'the sync lease outlived the run');
    }));

    test('a failed agent does not unwind a completed sync', () => withAdvancedRepo(({ root, stub, argvOut }) => {
      const r = aidev(root, ['sync', '--no-pr', '--agent'],
        { env: { AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_MODE: 'fail' } });
      eq(r.code, 1, `expected exit 1: ${r.out}`);
      // src/ stays bumped and the Wiki stays consistent: only prose is owed.
      const m = JSON.parse(fs.readFileSync(path.join(root, 'knowledge', 'manifest.json'), 'utf8'));
      ok(m.knowledgeSha, 'the manifest was rolled back by an agent failure');
      ok(!fs.existsSync(path.join(root, '.aidev', 'sync.lock')), 'the lease was stranded');
    }));
  }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
