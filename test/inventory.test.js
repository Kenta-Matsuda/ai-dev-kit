'use strict';
/** Inventory diffing, rename detection, scanning of the PKG root, hand-edit detection. */

const fs = require('fs');
const path = require('path');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, pullPkg, write } = require('./fixtures');
const inv = require('../cli/lib/inventory');
const cfg = require('../cli/lib/config');

const K = '.aidev/knowledge';

function rec(p, blob, extra = {}) {
  return { path: p, blob, pages: [], selfHashes: {}, masked: false, ...extra };
}

function run() {
  suite('inventory: layout constants');

  test('the Wiki and its caches live under .aidev/knowledge', () => {
    eq(inv.SCHEMA_VERSION, 3);
    eq(inv.OVERVIEW_PAGE, `${K}/overview.md`);
    eq(inv.INDEX_PAGE, `${K}/index.md`);
    eq(inv.CACHE_DIR_REL, `${K}/.cache`);
    eq(inv.DONE_DIR_REL, `${K}/.cache/done`);
    const fx = makeRepo();
    try {
      const rel = (p) => path.relative(fx.root, p).split(path.sep).join('/');
      eq(rel(inv.knowledgeDir(fx.root)), K);
      eq(rel(inv.manifestPath(fx.root)), `${K}/manifest.json`);
      eq(rel(inv.inventoryDir(fx.root)), `${K}/inventory`);
      eq(rel(inv.doneDir(fx.root)), `${K}/.cache/done`);
      const m = inv.emptyManifest('a'.repeat(40));
      eq(m.schemaVersion, 3);
      eq(m.knowledgeSha, 'a'.repeat(40));
      eq(m.checkpoint.pendingPaths, []);
    } finally { fx.cleanup(); }
  });

  suite('inventory: diffing');

  test('unchanged files produce no work', () => {
    const a = [rec('src/a.ts', 'b1'), rec('src/b.ts', 'b2')];
    const d = inv.diffInventory(a, [rec('src/a.ts', 'b1'), rec('src/b.ts', 'b2')]);
    eq(d.changed, 0);
    eq(d.needsGeneration, false);
    eq(d.unchanged.length, 2);
  });

  test('added and modified files are distinguished', () => {
    const d = inv.diffInventory(
      [rec('src/a.ts', 'b1')],
      [rec('src/a.ts', 'b1-new'), rec('src/new.ts', 'b9')]);
    eq(d.modified.length, 1);
    eq(d.modified[0].path, 'src/a.ts');
    eq(d.modified[0].previousBlob, 'b1');
    eq(d.added.length, 1);
    eq(d.added[0].path, 'src/new.ts');
    eq(d.needsGeneration, true);
  });

  test('deleted files are reported', () => {
    const d = inv.diffInventory([rec('src/a.ts', 'b1'), rec('src/gone.ts', 'b2')], [rec('src/a.ts', 'b1')]);
    eq(d.removed.length, 1);
    eq(d.removed[0].path, 'src/gone.ts');
  });

  test('a pure rename is detected with no generation needed', () => {
    const old = [rec('src/old.ts', 'blob-x', { pages: [`${K}/old.md`], selfHashes: { [`${K}/old.md`]: 'sha256:aa' } })];
    const d = inv.diffInventory(old, [rec('src/new.ts', 'blob-x')]);
    eq(d.renamed.length, 1);
    eq(d.renamed[0].from, 'src/old.ts');
    eq(d.renamed[0].path, 'src/new.ts');
    eq(d.added.length, 0);
    eq(d.removed.length, 0);
    eq(d.needsGeneration, false, 'rename alone needs no LLM call');
    eq(d.renamed[0].pages, [`${K}/old.md`], 'pages carry over');
  });

  test('a move plus an edit is not treated as a cheap rename', () => {
    const d = inv.diffInventory([rec('src/old.ts', 'blob-x')], [rec('src/new.ts', 'blob-y')]);
    eq(d.renamed.length, 0);
    eq(d.added.length, 1);
    eq(d.removed.length, 1);
    eq(d.needsGeneration, true);
  });

  test('a copy (same blob, original kept) counts as an addition', () => {
    const d = inv.diffInventory(
      [rec('src/a.ts', 'blob-x')],
      [rec('src/a.ts', 'blob-x'), rec('src/copy.ts', 'blob-x')]);
    eq(d.renamed.length, 0, 'original still present so it is not a move');
    eq(d.added.length, 1);
    eq(d.added[0].path, 'src/copy.ts');
  });

  test('empty inputs are handled', () => {
    eq(inv.diffInventory([], []).changed, 0);
    eq(inv.diffInventory(null, null).changed, 0);
    eq(inv.diffInventory([], [rec('a', 'b')]).added.length, 1);
    eq(inv.diffInventory([rec('a', 'b')], []).removed.length, 1);
  });

  test('two files swapping paths are matched as modifications, not churn', () => {
    const d = inv.diffInventory(
      [rec('src/a.ts', 'bx'), rec('src/b.ts', 'by')],
      [rec('src/a.ts', 'by'), rec('src/b.ts', 'bx')]);
    // Both paths persist, so these are modifications, not renames.
    eq(d.modified.length, 2);
    eq(d.renamed.length, 0);
  });

  suite('inventory: scanning and sharding');

  test('scan honours include, exclude and secret masking at the PKG root', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const recs = inv.scanPackage(fx.root, config);
      const paths = recs.map((r) => r.path);
      eq(paths, ['docs/readme.md', 'src/api/auth.ts', 'src/api/routing.ts'], 'sorted, repo-relative');
      ok(!paths.includes('config/secrets/key.pem'), 'outside include');
      ok(!paths.includes('README.md'), 'outside include');
      for (const r of recs) {
        ok(/^[0-9a-f]{40}$/.test(r.blob), `blob hash for ${r.path}`);
        eq(r.masked, false);
      }
    } finally { fx.cleanup(); }
  });

  test('kit-managed files are never scanned, even with include ["**"]', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      config.package.include = ['**'];
      const recs = inv.scanPackage(fx.root, config);
      const paths = recs.map((r) => r.path);
      ok(paths.includes('README.md'), JSON.stringify(paths));
      ok(paths.includes('config/secrets/key.pem'), 'secret is listed (masked) when included');
      for (const p of paths) {
        ok(!/^(aidev\.yaml|CLAUDE\.md|\.mcp\.json)$/.test(p) && !/^\.(aidev|claude)\//.test(p),
          `kit-managed path scanned: ${p}`);
      }
      ok(!paths.includes(`${K}/manifest.json`), 'the Wiki is not its own source');
      ok(!paths.includes('.claude/settings.json'), 'tool config is not source');
    } finally { fx.cleanup(); }
  });

  test('secret files inside include are flagged masked', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      config.package.include = ['config/**'];
      const recs = inv.scanPackage(fx.root, config);
      const secret = recs.find((r) => r.path === 'config/secrets/key.pem');
      ok(secret, 'secret file present');
      eq(secret.masked, true, 'flagged for masking');
    } finally { fx.cleanup(); }
  });

  test('exclude drops files inside include', () => {
    const fx = makeRepo({ pkgFiles: {
      'src/a.ts': 'a\n', 'src/node_modules/dep/index.js': 'x\n', 'src/vendor/lib.js': 'v\n',
    } });
    try {
      const config = cfg.loadConfig(fx.root);
      eq(inv.scanPackage(fx.root, config).map((r) => r.path), ['src/a.ts', 'src/vendor/lib.js']);
      config.package.exclude = ['**/node_modules/**', '**/vendor/**'];
      eq(inv.scanPackage(fx.root, config).map((r) => r.path), ['src/a.ts']);
    } finally { fx.cleanup(); }
  });

  test('scan can target a specific ref and returns null for an unknown one', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const newSha = advancePkg(fx, 'src/api/new.ts');
      pullPkg(fx);
      const atHead = inv.scanPackage(fx.root, config).map((r) => r.path);
      ok(atHead.includes('src/api/new.ts'), 'HEAD sees the new file');
      const atNew = inv.scanPackage(fx.root, config, { ref: newSha }).map((r) => r.path);
      eq(atNew, atHead);
      const atOld = inv.scanPackage(fx.root, config, { ref: fx.pkgSha }).map((r) => r.path);
      ok(!atOld.includes('src/api/new.ts'), 'the Wiki commit does not');
      eq(inv.scanPackage(fx.root, config, { ref: 'a'.repeat(40) }), null);
    } finally { fx.cleanup(); }
  });

  test('inventory round-trips through shards', () => {
    const fx = makeRepo();
    try {
      const records = [];
      for (let i = 0; i < 25; i++) records.push(rec(`src/f${String(i).padStart(3, '0')}.ts`, `blob${i}`));
      const shards = inv.writeInventory(fx.root, records, 10);
      eq(shards, ['inventory/00.json', 'inventory/01.json', 'inventory/02.json']);
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'inventory', '02.json')), 'written under .aidev/knowledge');
      const m = inv.emptyManifest('a'.repeat(40));
      m.inventoryShards = shards;
      inv.writeManifest(fx.root, m);
      eq(inv.readManifest(fx.root).knowledgeSha, 'a'.repeat(40));
      const back = inv.readInventory(fx.root);
      eq(back.length, 25);
      eq(back[0].path, 'src/f000.ts');
    } finally { fx.cleanup(); }
  });

  test('re-sharding removes shards left by a longer previous run', () => {
    const fx = makeRepo();
    try {
      inv.writeInventory(fx.root, Array.from({ length: 30 }, (_, i) => rec(`src/f${i}.ts`, `b${i}`)), 10);
      const shards = inv.writeInventory(fx.root, [rec('src/only.ts', 'b0')], 10);
      eq(shards.length, 1);
      const files = fs.readdirSync(inv.inventoryDir(fx.root)).filter((f) => /^\d+\.json$/.test(f));
      eq(files.length, 1, 'stale shards removed');
    } finally { fx.cleanup(); }
  });

  test('an inventory shard path cannot escape the knowledge directory', () => {
    const fx = makeRepo();
    try {
      const m = inv.emptyManifest('a'.repeat(40));
      m.inventoryShards = ['../../../etc/passwd', '../policy.yaml', 'inventory/00.json'];
      inv.writeManifest(fx.root, m);
      inv.writeInventory(fx.root, [rec('src/a.ts', 'b1')], 2000);
      const rows = inv.readInventory(fx.root);
      eq(rows.length, 1, 'traversing shard ignored');
    } finally { fx.cleanup(); }
  });

  suite('inventory: hand-edit detection');

  test('an unmodified page is not reported', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'knowledge', 'api.md'), '# generated\n');
      const h = inv.hashPage(fx.root, `${K}/api.md`);
      ok(/^sha256:[0-9a-f]{64}$/.test(h), h);
      const edits = inv.detectHandEdits(fx.root, [rec('src/a.ts', 'b', { selfHashes: { [`${K}/api.md`]: h } })]);
      eq(edits.length, 0);
    } finally { fx.cleanup(); }
  });

  test('an edited page is reported before it would be overwritten', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'knowledge', 'api.md'), '# generated\n');
      const h = inv.hashPage(fx.root, `${K}/api.md`);
      write(path.join(fx.root, '.aidev', 'knowledge', 'api.md'), '# generated\n\nhand written note\n');
      const edits = inv.detectHandEdits(fx.root, [rec('src/a.ts', 'b', { selfHashes: { [`${K}/api.md`]: h } })]);
      eq(edits.length, 1);
      eq(edits[0].reason, 'modified');
      eq(edits[0].page, `${K}/api.md`);
    } finally { fx.cleanup(); }
  });

  test('a deleted page is reported as missing', () => {
    const fx = makeRepo();
    try {
      const edits = inv.detectHandEdits(fx.root, [
        rec('src/a.ts', 'b', { selfHashes: { [`${K}/gone.md`]: 'sha256:zz' } })]);
      eq(edits.length, 1);
      eq(edits[0].reason, 'missing');
      eq(inv.hashPage(fx.root, `${K}/gone.md`), null);
    } finally { fx.cleanup(); }
  });

  test('a page shared by two sources is only checked once', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'knowledge', 'shared.md'), 'x\n');
      const h = inv.hashPage(fx.root, `${K}/shared.md`);
      write(path.join(fx.root, '.aidev', 'knowledge', 'shared.md'), 'y\n');
      const edits = inv.detectHandEdits(fx.root, [
        rec('src/a.ts', 'b1', { selfHashes: { [`${K}/shared.md`]: h } }),
        rec('src/b.ts', 'b2', { selfHashes: { [`${K}/shared.md`]: h } }),
      ]);
      eq(edits.length, 1, 'deduplicated');
    } finally { fx.cleanup(); }
  });

  test('a selfHashes page path that escapes the repository is ignored', () => {
    const fx = makeRepo();
    try {
      const edits = inv.detectHandEdits(fx.root, [
        rec('src/a.ts', 'b', { selfHashes: { '../outside.md': 'sha256:zz' } })]);
      eq(edits.length, 0);
    } finally { fx.cleanup(); }
  });

  test('inconsistent shared-page hashes are flagged', () => {
    const problems = inv.validateInventoryConsistency([
      rec('src/a.ts', 'b1', { selfHashes: { [`${K}/p.md`]: 'sha256:aa' } }),
      rec('src/b.ts', 'b2', { selfHashes: { [`${K}/p.md`]: 'sha256:bb' } }),
    ]);
    eq(problems.length, 1);
    eq(problems[0].page, `${K}/p.md`);
  });

  test('consistent shared-page hashes pass', () => {
    eq(inv.validateInventoryConsistency([
      rec('src/a.ts', 'b1', { selfHashes: { [`${K}/p.md`]: 'sha256:aa' } }),
      rec('src/b.ts', 'b2', { selfHashes: { [`${K}/p.md`]: 'sha256:aa' } }),
    ]).length, 0);
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
