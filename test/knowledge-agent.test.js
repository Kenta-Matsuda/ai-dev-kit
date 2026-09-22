'use strict';
/**
 * The batched, resumable Wiki build.
 *
 * What these suites pin down:
 *
 *   - the agent reports finished targets as files; the CLI turns them into
 *     page hashes, inventory records and checkpoint progress
 *   - a build runs one survey plus one agent process per batch, and a run cut
 *     short by its time budget keeps every batch that finished
 *   - re-running `aidev knowledge update` continues rather than starting over
 *   - the PostToolUse quality gate stays out of the way of Wiki writes
 *
 * Run: node test/knowledge-agent.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, write } = require('./fixtures');
const { writeClaudeStub, aidev, lastJson } = require('./completion.test');

const inventory = require('../cli/lib/inventory');
const agentMod = require('../cli/lib/agent');

const K = '.aidev/knowledge';

/**
 * A PKG with enough files to need several batches at --agent-batch-size 2.
 * `mod/**` is covered by the fixture's package.include.
 */
function manyFiles(n) {
  const files = {};
  for (let i = 0; i < n; i++) files[`mod/file-${String(i).padStart(2, '0')}.ts`] = `export const v${i} = ${i};\n`;
  return files;
}

function readManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, K, 'manifest.json'), 'utf8'));
}

function doneDir(root) { return path.join(root, K, '.cache', 'done'); }

function calls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function withRepo(fn, opts = {}) {
  // No Wiki yet: the first update has every target to generate.
  const fx = makeRepo({ withWiki: false, ...opts });
  try {
    const stub = writeClaudeStub(fx.root);
    return fn({
      root: fx.root,
      fx,
      env: (extra = {}) => ({
        AIDEV_CLAUDE_BIN: stub,
        STUB_COUNT_FILE: path.join(fx.root, 'stub-count.txt'),
        STUB_CALLS_OUT: path.join(fx.root, 'stub-calls.jsonl'),
        ...extra,
      }),
      callsFile: path.join(fx.root, 'stub-calls.jsonl'),
    });
  } finally { fx.cleanup(); }
}

function run() {
  // ----------------------------------------------------- completion reports
  suite('knowledge: completion reports');

  test('the report locations are the documented ones under .aidev/knowledge/', () => {
    eq(inventory.CACHE_DIR_REL, `${K}/.cache`);
    eq(inventory.DONE_DIR_REL, `${K}/.cache/done`);
    eq(inventory.OVERVIEW_PAGE, `${K}/overview.md`);
    eq(inventory.INDEX_PAGE, `${K}/index.md`);
    eq(inventory.doneFileName('src/api/auth.ts'), 'src__api__auth.ts.json');
  });

  test('a report records page hashes and clears the target from the checkpoint', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(fx.root, ['knowledge', 'update', '--no-commit']); // queue everything, no agent
      const before = readManifest(fx.root);
      const target = before.checkpoint.pendingPaths[0];
      ok(target, 'nothing was queued');
      ok(!target.startsWith('src/src/'), `targets carry a wrapper prefix: ${target}`);
      write(path.join(fx.root, K, 'pages', 'a.md'), '# a\n');
      write(path.join(fx.root, K, 'pages', 'index.md'), '# idx\n');
      write(path.join(doneDir(fx.root), inventory.doneFileName(target)),
        JSON.stringify({ target, targetSha: before.knowledgeSha, pages: [`${K}/pages/a.md`, `${K}/pages/index.md`] }));

      const res = inventory.applyCompletions(fx.root, { targetSha: before.knowledgeSha });
      eq(res.applied.length, 1, JSON.stringify(res));
      eq(res.rejected.length, 0, JSON.stringify(res.rejected));
      const after = readManifest(fx.root);
      ok(!after.checkpoint.pendingPaths.includes(target), 'the target is still pending');
      eq(after.checkpoint.pendingPaths.length, before.checkpoint.pendingPaths.length - 1);
      const rec = inventory.readInventory(fx.root).find((r) => r.path === target);
      eq(rec.pages.length, 2);
      eq(rec.selfHashes[`${K}/pages/a.md`], inventory.hashPage(fx.root, `${K}/pages/a.md`));
      ok(!fs.existsSync(path.join(doneDir(fx.root), inventory.doneFileName(target))),
        'the consumed report was not removed');
      eq(inventory.detectHandEdits(fx.root, inventory.readInventory(fx.root)).length, 0,
        'freshly recorded pages count as hand-edited');
    } finally { fx.cleanup(); }
  });

  test('a shared page gets one hash everywhere, so status reports no inconsistency', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(fx.root, ['knowledge', 'update', '--no-commit']);
      const m = readManifest(fx.root);
      const [t1, t2] = m.checkpoint.pendingPaths;
      ok(t1 && t2, 'need two targets');
      write(path.join(fx.root, K, 'shared.md'), '# v1\n');
      write(path.join(doneDir(fx.root), inventory.doneFileName(t1)),
        JSON.stringify({ target: t1, pages: [`${K}/shared.md`] }));
      inventory.applyCompletions(fx.root, { targetSha: m.knowledgeSha });
      // The second target rewrites the shared page later.
      write(path.join(fx.root, K, 'shared.md'), '# v2\n');
      write(path.join(doneDir(fx.root), inventory.doneFileName(t2)),
        JSON.stringify({ target: t2, pages: [`${K}/shared.md`] }));
      inventory.applyCompletions(fx.root, { targetSha: m.knowledgeSha });
      const records = inventory.readInventory(fx.root);
      eq(inventory.validateInventoryConsistency(records).length, 0, 'shared page hashes disagree');
      const h = inventory.hashPage(fx.root, `${K}/shared.md`);
      eq(records.find((r) => r.path === t1).selfHashes[`${K}/shared.md`], h);
      eq(records.find((r) => r.path === t2).selfHashes[`${K}/shared.md`], h);
    } finally { fx.cleanup(); }
  });

  test('a report naming a missing page, a structured file, a page outside the Wiki, or a foreign SHA is rejected and the target stays queued', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(fx.root, ['knowledge', 'update', '--no-commit']);
      const m = readManifest(fx.root);
      const [t1, t2, t3] = m.checkpoint.pendingPaths;
      ok(t1 && t2 && t3, 'need three targets');
      const done = (name, doc) => write(path.join(doneDir(fx.root), name), JSON.stringify(doc));
      done(inventory.doneFileName(t1), { target: t1, pages: [`${K}/nope.md`] });
      done(inventory.doneFileName(t2), { target: t2, pages: [`${K}/manifest.json`] });
      write(path.join(fx.root, K, 'ok.md'), '# ok\n');
      done(inventory.doneFileName(t3), { target: t3, targetSha: 'ffffffffffffffffffffffffffffffffffffffff', pages: [`${K}/ok.md`] });
      // A page that exists but lives outside the Wiki (the policy file, PKG
      // source) must not be hashed into the inventory, either.
      done('outside-1.json', { target: t1, pages: ['.aidev/policy.yaml'] });
      done('outside-2.json', { target: t1, pages: ['src/api/auth.ts'] });
      done('outside-3.json', { target: t1, pages: [`${K}/../policy.yaml`] });
      done('garbage.json', '{not json');

      const res = inventory.applyCompletions(fx.root, { targetSha: m.knowledgeSha });
      eq(res.applied.length, 0, JSON.stringify(res.applied));
      eq(res.rejected.length, 7, JSON.stringify(res.rejected));
      ok(res.rejected.filter((r) => /outside .aidev\/knowledge/.test(r.reason)).length >= 3,
        `pages outside the Wiki were not refused as such: ${JSON.stringify(res.rejected)}`);
      const after = readManifest(fx.root);
      for (const t of [t1, t2, t3]) ok(after.checkpoint.pendingPaths.includes(t), `${t} left the queue`);
      eq(fs.readdirSync(doneDir(fx.root)).length, 0, 'rejected reports linger');
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'policy.yaml')), 'the policy file was touched');
    } finally { fx.cleanup(); }
  });

  test('reports are left alone when the manifest describes another SHA', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(fx.root, ['knowledge', 'update', '--no-commit']);
      const m = readManifest(fx.root);
      const t = m.checkpoint.pendingPaths[0];
      write(path.join(fx.root, K, 'p.md'), '# p\n');
      write(path.join(doneDir(fx.root), inventory.doneFileName(t)),
        JSON.stringify({ target: t, pages: [`${K}/p.md`] }));
      const res = inventory.applyCompletions(fx.root, { targetSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      eq(res.manifestInvalid, true);
      eq(fs.readdirSync(doneDir(fx.root)).length, 1, 'the report was consumed');
    } finally { fx.cleanup(); }
  });

  // ------------------------------------------------------------ batching
  suite('knowledge: batched agent runs');

  test('chunk keeps queue order and never exceeds the batch size', () => {
    eq(agentMod.chunk([], 5).length, 0);
    const b = agentMod.chunk(['a', 'b', 'c', 'd', 'e'], 2);
    eq(b.length, 3);
    eq(b[0].join(','), 'a,b');
    eq(b[2].join(','), 'e');
  });

  test('a full update runs one survey then one process per batch, in queue order', () => withRepo(({ root, env, callsFile }) => {
    const r = aidev(root, ['knowledge', 'update', '--no-commit', '--agent-batch-size', '2', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    const seen = calls(callsFile);
    eq(seen[0].runMode, 'survey', 'the first run was not a survey');
    eq(seen[0].targets.length, 0, 'the survey run carried generation targets');
    const batches = seen.slice(1);
    eq(batches.length, 3, `expected 3 batches for 5 targets: ${JSON.stringify(seen)}`);
    ok(batches.every((c) => c.runMode === 'generate' && c.targets.length <= 2), 'a batch exceeded its size');
    const flat = batches.flatMap((c) => c.targets);
    eq(flat.join(','), [...flat].sort().join(','), 'batches are not in queue order');
    ok(flat.every((t) => /^mod\/file-\d\d\.ts$/.test(t)), `unexpected targets: ${flat.join(',')}`);
    const j = lastJson(r.out);
    eq(j.agent.batches.length, 3);
    eq(j.remaining, 0);
    ok(fs.existsSync(path.join(root, K, 'overview.md')), 'the survey page is missing');
    eq(j.agent.survey.ok, true);
  }, { pkgFiles: manyFiles(5) }));

  test('--no-survey skips the survey and an existing overview makes it automatic', () => withRepo(({ root, env, callsFile }) => {
    let r = aidev(root, ['knowledge', 'update', '--no-commit', '--no-survey', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    ok(calls(callsFile).every((c) => c.runMode === 'generate'), 'a survey ran despite --no-survey');
    // An incremental build with an overview present does not re-survey.
    fs.writeFileSync(path.join(root, K, 'overview.md'), '# overview\n');
    fs.unlinkSync(callsFile);
    r = aidev(root, ['knowledge', 'update', '--no-commit', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    eq(calls(callsFile).length, 0, 'nothing changed, yet an agent ran');
  }, { pkgFiles: manyFiles(3) }));

  test('a timeout mid-update keeps finished batches; the next update resumes from the rest', () => withRepo(({ root, env, callsFile }) => {
    // survey = call 1, batch 1 = call 2, batch 2 = call 3 (hangs)
    const r = aidev(root, ['knowledge', 'update', '--no-commit', '--agent-batch-size', '2', '--agent-timeout', '10000', '--json'],
      { env: env({ STUB_HANG_AT: '3' }) });
    eq(r.code, 1, `a timed-out build did not fail: ${r.out}`);
    const j = lastJson(r.out);
    eq(j.agent.timedOut, true);
    eq(j.agent.completed, 2, `batch 1 was not saved: ${JSON.stringify(j.agent)}`);
    eq(j.remaining, 3);
    ok(/Finished targets are saved/.test(r.out) || j.agent.batches.length === 2, 'no resume guidance');

    fs.unlinkSync(callsFile);
    const again = aidev(root, ['knowledge', 'update', '--no-commit', '--agent-batch-size', '2', '--json'], { env: env() });
    eq(again.code, 0, again.out);
    const seen = calls(callsFile);
    ok(seen.every((c) => c.runMode === 'generate'), 'the resumed build surveyed again');
    eq(seen.flatMap((c) => c.targets).length, 3, `resumed build redid finished work: ${JSON.stringify(seen)}`);
    eq(lastJson(again.out).remaining, 0);
  }, { pkgFiles: manyFiles(5) }));

  test('reports written by a run that was killed are recorded by the next build before it queues work', () => withRepo(({ root }) => {
    aidev(root, ['knowledge', 'update', '--no-commit']);
    const m = readManifest(root);
    const t = m.checkpoint.pendingPaths[0];
    write(path.join(root, K, 'late.md'), '# late\n');
    write(path.join(doneDir(root), inventory.doneFileName(t)),
      JSON.stringify({ target: t, targetSha: m.knowledgeSha, pages: [`${K}/late.md`] }));
    const r = aidev(root, ['knowledge', 'update', '--no-commit', '--dry-run', '--json']);
    // dry-run must not consume the report...
    ok(lastJson(r.out).pending.includes(t), 'dry run should still show the target pending');
    ok(fs.existsSync(path.join(doneDir(root), inventory.doneFileName(t))), 'dry run consumed a report');
    // ...but a real build records it and does not queue the target again.
    const real = aidev(root, ['knowledge', 'update', '--no-commit', '--json']);
    eq(lastJson(real.out).structuredOk, true, real.out);
    ok(!lastJson(real.out).pending.includes(t), 'the recorded target was queued again');
    ok(!fs.existsSync(path.join(doneDir(root), inventory.doneFileName(t))), 'the real build left the report behind');
    const rec = inventory.readInventory(root).find((x) => x.path === t);
    ok(rec && rec.selfHashes[`${K}/late.md`], 'the late report was not folded into the inventory');
  }, { pkgFiles: manyFiles(3) }));

  test('update is incremental by default and --full regenerates everything', () => withRepo(({ root, env, callsFile }) => {
    let r = aidev(root, ['knowledge', 'update', '--no-commit', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    fs.unlinkSync(callsFile);
    r = aidev(root, ['knowledge', 'update', '--no-commit', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    eq(calls(callsFile).length, 0, 'an unchanged PKG was regenerated');
    r = aidev(root, ['knowledge', 'update', '--no-commit', '--full', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    const seen = calls(callsFile);
    eq(seen[0].runMode, 'survey', '--full did not re-survey');
    eq(seen.slice(1).flatMap((c) => c.targets).length, 3, '--full did not regenerate every target');
  }, { pkgFiles: manyFiles(3) }));

  test('a changed PKG file is the only target of the next incremental update', () => withRepo(({ root, fx, env, callsFile }) => {
    let r = aidev(root, ['knowledge', 'update', '--no-commit', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    fs.unlinkSync(callsFile);
    const { advancePkg, pullPkg } = require('./fixtures');
    advancePkg(fx, 'mod/file-01.ts', 'export const v1 = 100;\n');
    pullPkg(fx);
    r = aidev(root, ['knowledge', 'update', '--no-commit', '--json'], { env: env() });
    eq(r.code, 0, r.out);
    const seen = calls(callsFile);
    ok(seen.every((c) => c.runMode === 'generate'), 'an overview exists, yet it re-surveyed');
    eq(seen.flatMap((c) => c.targets), ['mod/file-01.ts'], `wrong incremental queue: ${JSON.stringify(seen)}`);
    eq(lastJson(r.out).remaining, 0);
    // Unchanged targets keep the page hashes recorded by the earlier build, so
    // hand-edit detection and `status` stay meaningful across incremental runs.
    const records = inventory.readInventory(root);
    for (const p of ['mod/file-00.ts', 'mod/file-02.ts']) {
      const rec = records.find((x) => x.path === p);
      ok(rec && Object.keys(rec.selfHashes || {}).length > 0, `${p} lost its page hashes on the incremental build`);
    }
    eq(inventory.detectHandEdits(root, records).length, 0, 'carried hashes do not match the pages on disk');
  }, { pkgFiles: manyFiles(3) }));

  test('a bad --agent-batch-size or contradictory survey flags are refused before anything runs', () => withRepo(({ root, env, callsFile }) => {
    for (const args of [
      ['--agent-batch-size', '0'], ['--agent-batch-size', 'x'], ['--agent-batch-size', '2.5'],
      ['--survey', '--no-survey'],
    ]) {
      const r = aidev(root, ['knowledge', 'update', '--no-commit', ...args], { env: env() });
      eq(r.code, 1, `${args.join(' ')} was accepted: ${r.out}`);
    }
    ok(!fs.existsSync(callsFile), 'an agent ran on bad flags');
  }, { pkgFiles: manyFiles(2) }));

  test('the dry run announces the batch count', () => withRepo(({ root, env }) => {
    const r = aidev(root, ['knowledge', 'update', '--no-commit', '--dry-run', '--agent-batch-size', '2'], { env: env() });
    eq(r.code, 0, r.out);
    ok(/3 batch\(es\)/.test(r.out), `batch count missing: ${r.out}`);
  }, { pkgFiles: manyFiles(5) }));

  // ---------------------------------------------------------- quality gate
  suite('hook: quality-gate skips non-PKG writes');

  const hookRun = (root, payload) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-qg-')), 'input.json');
    fs.writeFileSync(f, JSON.stringify(payload), 'utf8');
    const r = aidev(root, ['hook', 'quality-gate', '--input', f]);
    try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* best effort */ }
    return r;
  };

  test('a kit-managed write does not run the PKG gates; a PKG source write does', () => {
    const fx = makeRepo();
    try {
      const cfg = path.join(fx.root, 'aidev.yaml');
      fs.appendFileSync(cfg, ['quality_gates:', `  lint: ${process.execPath} -e "process.exit(3)"`, ''].join('\n'));
      for (const rel of [`${K}/x.md`, '.aidev/workflows/w/workflow.yaml', 'aidev.yaml', 'CLAUDE.md', '.claude/settings.json']) {
        const r = hookRun(fx.root, { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, ...rel.split('/')) } });
        eq(r.code, 0, r.out);
        const j = lastJson(r.out);
        eq(j.ok, true, `${rel}: ${r.out}`);
        eq(j.ran.length, 0, `gates ran for the kit-managed file ${rel}: ${r.out}`);
        ok(j.skipped, `${rel}: skip was not explained`);
      }

      const src = hookRun(fx.root, { tool_name: 'Edit', tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts') } });
      eq(src.code, 0, src.out);
      ok(/quality gate failed: lint/.test(src.out), `the failing gate was not reported for a PKG edit: ${src.out}`);

      const docs = hookRun(fx.root, { tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'docs', 'readme.md') } });
      ok(/quality gate failed: lint/.test(docs.out), `a PKG docs edit skipped the gates: ${docs.out}`);
    } finally { fx.cleanup(); }
  });
}

if (require.main === module) {
  run();
  process.exit(require('./harness').summary() ? 0 : 1);
}
module.exports = { run };
