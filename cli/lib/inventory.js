'use strict';
/**
 * Wiki manifest and sharded file inventory.
 *
 * Change detection compares stored git blob ids against the current tree
 * rather than running `git diff <oldSha>`. That choice is what makes the
 * design survive three otherwise fatal situations:
 *
 *   - the old commit was garbage-collected  → no old object is needed
 *   - the branch was force-pushed           → no shared ancestry is needed
 *   - a file was renamed, contents unchanged → same blob, new path, zero LLM
 *
 * Per-page `selfHashes` additionally detect hand-edited Wiki pages so
 * regeneration can warn instead of silently discarding human work.
 */

const fs = require('fs');
const path = require('path');
const { sha256, writeJsonAtomic, readJsonIfExists } = require('./config');
const pathsMod = require('./paths');
const git = require('./git');

const SCHEMA_VERSION = 2;

function knowledgeDir(repoRoot) { return path.join(repoRoot, 'knowledge'); }
function manifestPath(repoRoot) { return path.join(knowledgeDir(repoRoot), 'manifest.json'); }
function inventoryDir(repoRoot) { return path.join(knowledgeDir(repoRoot), 'inventory'); }

function emptyManifest(knowledgeSha = null, kitCommit = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    knowledgeSha,
    kitCommit,
    generatedAt: new Date().toISOString(),
    inventoryShards: [],
    stats: { files: 0, pages: 0, maskedFiles: 0 },
    checkpoint: { completedShards: 0, pendingPaths: [] },
  };
}

function readManifest(repoRoot) { return readJsonIfExists(manifestPath(repoRoot)); }

function writeManifest(repoRoot, manifest) {
  writeJsonAtomic(manifestPath(repoRoot), manifest);
  return manifest;
}

/** Load and concatenate every inventory shard listed by the manifest. */
function readInventory(repoRoot, manifest = null) {
  const m = manifest || readManifest(repoRoot);
  if (!m || !Array.isArray(m.inventoryShards)) return [];
  const out = [];
  for (const rel of m.inventoryShards) {
    // Shard paths come from a tracked file; refuse anything that escapes.
    const norm = pathsMod.normalizeRel(rel);
    if (pathsMod.escapesRoot(norm)) continue;
    const full = path.join(knowledgeDir(repoRoot), norm);
    const rows = readJsonIfExists(full);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

/** Split records into shards of `shardSize` and rewrite inventory/NN.json. */
function writeInventory(repoRoot, records, shardSize = 2000) {
  const dir = inventoryDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  // Remove shards from a previous, longer run so stale data cannot linger.
  for (const f of safeReaddir(dir)) {
    if (/^\d+\.json$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
  }
  const size = Math.max(1, shardSize | 0);
  const shards = [];
  const sorted = [...records].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 0; i < Math.max(1, Math.ceil(sorted.length / size)); i++) {
    const chunk = sorted.slice(i * size, (i + 1) * size);
    const name = `${String(i).padStart(2, '0')}.json`;
    writeJsonAtomic(path.join(dir, name), chunk);
    shards.push(`inventory/${name}`);
  }
  return shards;
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/**
 * Enumerate the PKG files in scope at a given ref, with blob hashes.
 * Paths are returned repo-relative to the wrapper (i.e. prefixed with `src/`).
 */
function scanPackage(repoRoot, config, { submodulePath = 'src', ref = 'HEAD' } = {}) {
  const subDir = path.join(repoRoot, submodulePath);
  const entries = git.lsTreeBlobs(subDir, ref);
  if (entries == null) return null;
  const include = config?.package?.include || [];
  const exclude = config?.package?.exclude || [];
  const secrets = config?.secrets_paths || [];
  const out = [];
  for (const e of entries) {
    const rel = pathsMod.normalizeRel(`${submodulePath}/${e.path}`);
    if (!pathsMod.isIncluded(rel, include, exclude)) continue;
    out.push({
      path: rel,
      blob: e.blob,
      masked: pathsMod.matchesAny(secrets, rel),
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Diff a stored inventory against a fresh scan.
 *
 * Rename detection is intentionally blob-exact: a file whose contents changed
 * *and* moved is reported as delete + add, because its prose genuinely needs
 * regenerating. Only a pure move is cheap.
 */
function diffInventory(oldRecords, newRecords) {
  const oldByPath = new Map();
  const oldByBlob = new Map();
  for (const r of oldRecords || []) {
    oldByPath.set(r.path, r);
    if (!oldByBlob.has(r.blob)) oldByBlob.set(r.blob, []);
    oldByBlob.get(r.blob).push(r);
  }
  const newByPath = new Map();
  const newByBlob = new Map();
  for (const r of newRecords || []) {
    newByPath.set(r.path, r);
    if (!newByBlob.has(r.blob)) newByBlob.set(r.blob, []);
    newByBlob.get(r.blob).push(r);
  }

  const added = [];
  const modified = [];
  const removed = [];
  const renamed = [];
  const unchanged = [];

  const consumedOld = new Set();

  for (const [p, rec] of newByPath) {
    const prev = oldByPath.get(p);
    if (prev) {
      consumedOld.add(p);
      if (prev.blob === rec.blob) unchanged.push(rec);
      else modified.push({ ...rec, previousBlob: prev.blob });
    }
  }
  // Pure renames: a new path whose blob matches an old path that vanished.
  const candidatesNew = [...newByPath.keys()].filter((p) => !oldByPath.has(p));
  for (const p of candidatesNew) {
    const rec = newByPath.get(p);
    const sameBlob = (oldByBlob.get(rec.blob) || [])
      .filter((o) => !newByPath.has(o.path) && !consumedOld.has(o.path));
    if (sameBlob.length > 0) {
      const from = sameBlob[0];
      consumedOld.add(from.path);
      renamed.push({ ...rec, from: from.path, pages: from.pages || [], selfHashes: from.selfHashes || {} });
    } else {
      added.push(rec);
    }
  }
  for (const [p, rec] of oldByPath) {
    if (!consumedOld.has(p) && !newByPath.has(p)) removed.push(rec);
  }

  return {
    added, modified, removed, renamed, unchanged,
    changed: added.length + modified.length + removed.length + renamed.length,
    // A rename alone needs no LLM call; it only rewrites structured references.
    needsGeneration: added.length + modified.length > 0,
  };
}

/**
 * Detect Wiki pages edited by hand since generation.
 * Returns the pages whose on-disk hash differs from the recorded selfHash.
 */
function detectHandEdits(repoRoot, records) {
  const edited = [];
  const seen = new Set();
  for (const rec of records || []) {
    const hashes = rec.selfHashes || {};
    for (const [pageRel, expected] of Object.entries(hashes)) {
      if (seen.has(pageRel)) continue;
      seen.add(pageRel);
      const norm = pathsMod.normalizeRel(pageRel);
      if (pathsMod.escapesRoot(norm)) continue;
      const full = path.join(repoRoot, norm);
      let actual = null;
      try { actual = `sha256:${sha256(fs.readFileSync(full))}`; } catch { actual = null; }
      if (actual == null) edited.push({ page: pageRel, reason: 'missing', expected, actual: null });
      else if (actual !== expected) edited.push({ page: pageRel, reason: 'modified', expected, actual });
    }
  }
  return edited;
}

/** Hash a generated page for storage in selfHashes. */
function hashPage(repoRoot, pageRel) {
  const full = path.join(repoRoot, pathsMod.normalizeRel(pageRel));
  try { return `sha256:${sha256(fs.readFileSync(full))}`; } catch { return null; }
}

/**
 * Pages that belonged only to deleted source files — scenario 7.
 *
 * A page is orphaned only when *every* record that referenced it is gone: one
 * page can document several sources, and deleting it because one of them went
 * away would silently drop documentation for the ones that remain.
 *
 * `index.md` is never orphaned. Index pages describe a directory rather than a
 * file, and the survivors still need them; the builder rewrites their contents.
 */
function orphanedPages(removedRecords, survivingRecords) {
  const stillReferenced = new Set();
  for (const rec of survivingRecords || []) {
    for (const page of Object.keys(rec.selfHashes || {})) stillReferenced.add(page);
    for (const page of rec.pages || []) stillReferenced.add(page);
  }

  const orphans = new Set();
  for (const rec of removedRecords || []) {
    const pages = new Set([...Object.keys(rec.selfHashes || {}), ...(rec.pages || [])]);
    for (const page of pages) {
      const norm = pathsMod.normalizeRel(page);
      if (!norm || pathsMod.escapesRoot(norm)) continue;
      if (path.basename(norm).toLowerCase() === 'index.md') continue;
      if (stillReferenced.has(page) || stillReferenced.has(norm)) continue;
      orphans.add(norm);
    }
  }
  return [...orphans].sort();
}

/**
 * Delete orphaned pages and report the parent indexes that now describe fewer
 * files. Refuses to touch anything outside knowledge/.
 */
function removeOrphanedPages(repoRoot, pages, { dryRun = false } = {}) {
  const kDir = knowledgeDir(repoRoot);
  const deleted = [];
  const skipped = [];
  const parents = new Set();

  for (const page of pages || []) {
    const norm = pathsMod.normalizeRel(page);
    const full = path.resolve(repoRoot, norm);
    // The inventory is derived data; a path escaping knowledge/ means it is
    // corrupt or crafted, and deleting on its say-so would be the bug.
    if (pathsMod.escapesRoot(norm) || !full.startsWith(path.resolve(kDir) + path.sep)) {
      skipped.push({ page: norm, reason: 'outside knowledge/' });
      continue;
    }
    if (!fs.existsSync(full)) { skipped.push({ page: norm, reason: 'already absent' }); continue; }
    if (!dryRun) {
      try { fs.rmSync(full); } catch (e) { skipped.push({ page: norm, reason: e.message }); continue; }
    }
    deleted.push(norm);
    const parentIndex = pathsMod.normalizeRel(path.join(path.dirname(norm), 'index.md'));
    if (fs.existsSync(path.resolve(repoRoot, parentIndex))) parents.add(parentIndex);
  }
  return { deleted, skipped, staleIndexes: [...parents].sort() };
}

/**
 * Verify that a page referenced from several source records carries the same
 * hash everywhere; inconsistency means the inventory was written incorrectly.
 */
function validateInventoryConsistency(records) {
  const byPage = new Map();
  const problems = [];
  for (const rec of records || []) {
    for (const [page, h] of Object.entries(rec.selfHashes || {})) {
      if (!byPage.has(page)) byPage.set(page, { hash: h, sources: [rec.path] });
      else {
        const e = byPage.get(page);
        e.sources.push(rec.path);
        if (e.hash !== h) {
          problems.push({ page, hashes: [e.hash, h], sources: e.sources.slice() });
        }
      }
    }
  }
  return problems;
}

module.exports = {
  SCHEMA_VERSION, knowledgeDir, manifestPath, inventoryDir,
  emptyManifest, readManifest, writeManifest,
  readInventory, writeInventory, scanPackage,
  diffInventory, detectHandEdits, hashPage, validateInventoryConsistency,
  orphanedPages, removeOrphanedPages,
};
