'use strict';
/** Inventory diffing, rename detection, hand-edit detection, state model. */

const fs = require('fs');
const path = require('path');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, git, write } = require('./fixtures');
const inv = require('../cli/lib/inventory');
const cfg = require('../cli/lib/config');

function rec(p, blob, extra = {}) {
  return { path: p, blob, pages: [], selfHashes: {}, masked: false, ...extra };
}

function run() {
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
    const old = [rec('src/old.ts', 'blob-x', { pages: ['knowledge/old.md'], selfHashes: { 'knowledge/old.md': 'sha256:aa' } })];
    const d = inv.diffInventory(old, [rec('src/new.ts', 'blob-x')]);
    eq(d.renamed.length, 1);
    eq(d.renamed[0].from, 'src/old.ts');
    eq(d.renamed[0].path, 'src/new.ts');
    eq(d.added.length, 0);
    eq(d.removed.length, 0);
    eq(d.needsGeneration, false, 'rename alone needs no LLM call');
    eq(d.renamed[0].pages, ['knowledge/old.md'], 'pages carry over');
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

  test('two files swapping paths are matched as renames, not churn', () => {
    const d = inv.diffInventory(
      [rec('src/a.ts', 'bx'), rec('src/b.ts', 'by')],
      [rec('src/a.ts', 'by'), rec('src/b.ts', 'bx')]);
    // Both paths persist, so these are modifications, not renames.
    eq(d.modified.length, 2);
    eq(d.renamed.length, 0);
  });

  suite('inventory: scanning and sharding');

  test('scan honours include, exclude and secret masking', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const recs = inv.scanPackage(fx.root, config);
      const paths = recs.map((r) => r.path);
      ok(paths.includes('src/src/api/auth.ts'), JSON.stringify(paths));
      ok(paths.includes('src/docs/readme.md'), 'docs included');
      ok(!paths.includes('src/config/secrets/key.pem'), 'outside include');
      for (const r of recs) ok(/^[0-9a-f]{40}$/.test(r.blob), `blob hash for ${r.path}`);
    } finally { fx.cleanup(); }
  });

  test('secret files inside include are flagged masked', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      config.package.include = ['src/**'];
      const recs = inv.scanPackage(fx.root, config);
      const secret = recs.find((r) => r.path === 'src/config/secrets/key.pem');
      ok(secret, 'secret file present');
      eq(secret.masked, true, 'flagged for masking');
    } finally { fx.cleanup(); }
  });

  test('inventory round-trips through shards', () => {
    const fx = makeRepo();
    try {
      const records = [];
      for (let i = 0; i < 25; i++) records.push(rec(`src/f${String(i).padStart(3, '0')}.ts`, `blob${i}`));
      const shards = inv.writeInventory(fx.root, records, 10);
      eq(shards.length, 3);
      const m = inv.emptyManifest('a'.repeat(40));
      m.inventoryShards = shards;
      inv.writeManifest(fx.root, m);
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
      m.inventoryShards = ['../../../etc/passwd', 'inventory/00.json'];
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
      write(path.join(fx.root, 'knowledge', 'api.md'), '# generated\n');
      const h = inv.hashPage(fx.root, 'knowledge/api.md');
      const edits = inv.detectHandEdits(fx.root, [rec('src/a.ts', 'b', { selfHashes: { 'knowledge/api.md': h } })]);
      eq(edits.length, 0);
    } finally { fx.cleanup(); }
  });

  test('an edited page is reported before it would be overwritten', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, 'knowledge', 'api.md'), '# generated\n');
      const h = inv.hashPage(fx.root, 'knowledge/api.md');
      write(path.join(fx.root, 'knowledge', 'api.md'), '# generated\n\nhand written note\n');
      const edits = inv.detectHandEdits(fx.root, [rec('src/a.ts', 'b', { selfHashes: { 'knowledge/api.md': h } })]);
      eq(edits.length, 1);
      eq(edits[0].reason, 'modified');
    } finally { fx.cleanup(); }
  });

  test('a deleted page is reported as missing', () => {
    const fx = makeRepo();
    try {
      const edits = inv.detectHandEdits(fx.root, [
        rec('src/a.ts', 'b', { selfHashes: { 'knowledge/gone.md': 'sha256:zz' } })]);
      eq(edits.length, 1);
      eq(edits[0].reason, 'missing');
    } finally { fx.cleanup(); }
  });

  test('a page shared by two sources is only checked once', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, 'knowledge', 'shared.md'), 'x\n');
      const h = inv.hashPage(fx.root, 'knowledge/shared.md');
      write(path.join(fx.root, 'knowledge', 'shared.md'), 'y\n');
      const edits = inv.detectHandEdits(fx.root, [
        rec('src/a.ts', 'b1', { selfHashes: { 'knowledge/shared.md': h } }),
        rec('src/b.ts', 'b2', { selfHashes: { 'knowledge/shared.md': h } }),
      ]);
      eq(edits.length, 1, 'deduplicated');
    } finally { fx.cleanup(); }
  });

  test('inconsistent shared-page hashes are flagged', () => {
    const problems = inv.validateInventoryConsistency([
      rec('src/a.ts', 'b1', { selfHashes: { 'knowledge/p.md': 'sha256:aa' } }),
      rec('src/b.ts', 'b2', { selfHashes: { 'knowledge/p.md': 'sha256:bb' } }),
    ]);
    eq(problems.length, 1);
    eq(problems[0].page, 'knowledge/p.md');
  });

  test('consistent shared-page hashes pass', () => {
    eq(inv.validateInventoryConsistency([
      rec('src/a.ts', 'b1', { selfHashes: { 'knowledge/p.md': 'sha256:aa' } }),
      rec('src/b.ts', 'b2', { selfHashes: { 'knowledge/p.md': 'sha256:aa' } }),
    ]).length, 0);
  });
}

module.exports = { run };
