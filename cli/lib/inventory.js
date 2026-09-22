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
const layout = require('./layout');
const git = require('./git');

const SCHEMA_VERSION = 3;

function knowledgeDir(repoRoot) { return layout.abs(repoRoot, layout.KNOWLEDGE_REL); }
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
 * Paths are repo-relative. Kit-managed files (aidev.yaml, .aidev/**, the
 * materialised tool config) are never generation targets.
 */
function scanPackage(repoRoot, config, { ref = 'HEAD' } = {}) {
  const entries = git.lsTreeBlobs(repoRoot, ref);
  if (entries == null) return null;
  const include = config?.package?.include || [];
  const exclude = config?.package?.exclude || [];
  const secrets = config?.secrets_paths || [];
  const out = [];
  for (const e of entries) {
    const rel = pathsMod.normalizeRel(e.path);
    if (layout.isKitManaged(rel)) continue;
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
      // Unchanged keeps its recorded prose: callers carry pages/selfHashes
      // forward from these records, so the fresh (hash-less) scan entry alone
      // would silently drop every page hash on each incremental build.
      if (prev.blob === rec.blob) unchanged.push({ ...rec, pages: prev.pages || [], selfHashes: prev.selfHashes || {} });
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
      skipped.push({ page: norm, reason: 'outside .aidev/knowledge/' });
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

// ------------------------------------------------------- working tree checks

/**
 * Generation targets with uncommitted changes (modified, staged, deleted or
 * untracked). The Wiki describes a commit, so it is only updated when the
 * files it describes are exactly what HEAD holds. Kit-managed paths and the
 * Wiki itself are ignored: a half-written Wiki is the normal state during an
 * update, and aidev.yaml or tool config are not described by any page.
 *
 * Returns repo-relative paths, sorted; an unreadable status fails closed by
 * returning a single pseudo entry so callers refuse rather than proceed.
 */
function dirtyTargets(repoRoot, config) {
  const entries = git.statusEntries(repoRoot);
  if (entries == null) return ['(git status failed: the working tree could not be read)'];
  const include = config?.package?.include || [];
  const exclude = config?.package?.exclude || [];
  const out = new Set();
  for (const entry of entries) {
    const rel = pathsMod.normalizeRel(entry.path);
    if (!rel || layout.isKitManaged(rel)) continue;
    if (!pathsMod.isIncluded(rel, include, exclude)) continue;
    out.add(rel);
  }
  return [...out].sort();
}

/**
 * Compare the recorded inventory with the tree at `ref` (HEAD by default):
 * the structured answer to "does the Wiki describe this commit?". No old
 * commit object is needed, so this works after a fetch, a rebase or a
 * force-push alike. Returns null when the tree cannot be listed.
 */
function compareWithTree(repoRoot, config, records, { ref = 'HEAD' } = {}) {
  const current = scanPackage(repoRoot, config, { ref });
  if (current == null) return null;
  const diff = diffInventory(records || [], current);
  return {
    added: diff.added.length,
    modified: diff.modified.length,
    removed: diff.removed.length,
    renamed: diff.renamed.length,
    unchanged: diff.unchanged.length,
    changed: diff.changed,
    behind: diff.changed > 0,
  };
}

// ------------------------------------------------------- completion reports

/**
 * Where the knowledge-builder agent reports finished work.
 *
 * The agent never edits the manifest or an inventory shard. Rewriting a
 * 2000-record JSON shard from a language model is slow, error-prone and, in a
 * headless run with no Bash, cannot even compute the page hashes it would need.
 * Instead the agent drops one small JSON file per finished generation target
 * here and the CLI folds those reports into the structured state: hashes,
 * shard records and the checkpoint. A run stopped by a timeout keeps every
 * report it already wrote, which is what makes the next run a resume rather
 * than a restart.
 */
const CACHE_DIR_REL = `${layout.KNOWLEDGE_REL}/.cache`;
const DONE_DIR_REL = `${CACHE_DIR_REL}/done`;

/** Pseudo target the survey run reports under. */
const SURVEY_TARGET = '__survey__';

/** Pages a survey run must produce; later batches read them instead of re-surveying. */
const OVERVIEW_PAGE = `${layout.KNOWLEDGE_REL}/overview.md`;
const INDEX_PAGE = `${layout.KNOWLEDGE_REL}/index.md`;

function cacheDir(repoRoot) { return layout.abs(repoRoot, CACHE_DIR_REL); }
function doneDir(repoRoot) { return layout.abs(repoRoot, DONE_DIR_REL); }

/** File name the agent is told to use for a target's report. */
function doneFileName(target) {
  return `${String(target).replace(/[\\/]/g, '__')}.json`;
}

/** Read every report in the done directory without applying anything. */
function collectCompletions(repoRoot) {
  const dir = doneDir(repoRoot);
  const reports = [];
  const invalid = [];
  for (const f of safeReaddir(dir).sort()) {
    if (!/\.json$/i.test(f)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { invalid.push({ file: f, reason: `invalid JSON (${e.message})` }); continue; }
    if (!doc || typeof doc !== 'object' || typeof doc.target !== 'string' || doc.target.trim() === '') {
      invalid.push({ file: f, reason: 'missing "target"' });
      continue;
    }
    const pages = doc.pages == null ? [] : doc.pages;
    if (!Array.isArray(pages) || pages.some((p) => typeof p !== 'string')) {
      invalid.push({ file: f, reason: '"pages" must be an array of paths' });
      continue;
    }
    const target = doc.target.trim();
    reports.push({
      file: f,
      target: target === SURVEY_TARGET ? SURVEY_TARGET : pathsMod.normalizeRel(target),
      pages,
      targetSha: typeof doc.targetSha === 'string' ? doc.targetSha : null,
      note: typeof doc.note === 'string' ? doc.note : null,
    });
  }
  return { reports, invalid };
}

/** Validate a reported page path and hash it. Returns { page, hash } or { error }. */
function checkReportedPage(repoRoot, raw) {
  const norm = pathsMod.normalizeRel(raw);
  const K = layout.KNOWLEDGE_REL;
  if (!norm || pathsMod.escapesRoot(norm) || !norm.startsWith(`${K}/`)) {
    return { error: `page outside ${K}/: ${raw}` };
  }
  if (norm.startsWith(`${K}/.cache/`) || norm === `${K}/manifest.json`
    || norm.startsWith(`${K}/inventory/`)) {
    return { error: `not a Wiki page: ${raw}` };
  }
  const hash = hashPage(repoRoot, norm);
  if (!hash) return { error: `page not found: ${norm}` };
  return { page: norm, hash };
}

/**
 * Fold the agent's completion reports into the inventory and checkpoint.
 *
 * For every valid report: the target record's `pages`/`selfHashes` are
 * replaced with the reported pages and their current hashes, a page shared by
 * several targets gets the same hash everywhere, and the target leaves
 * `checkpoint.pendingPaths`. Consumed and rejected reports are deleted; a
 * rejected target simply stays pending, so the next run does it again.
 *
 * Reports are left untouched when the manifest is missing, has no checkpoint,
 * or describes a different SHA than `targetSha`: the caller decides what that
 * means, and deleting evidence of finished work would not help it.
 */
function applyCompletions(repoRoot, { targetSha = null, shardSize = 2000 } = {}) {
  const { reports, invalid } = collectCompletions(repoRoot);
  const result = {
    applied: [],
    rejected: invalid.map((i) => ({ file: i.file, target: null, reason: i.reason })),
    survey: null,
    manifestInvalid: false,
    remaining: null,
  };
  const dir = doneDir(repoRoot);
  const drop = (file) => { try { fs.unlinkSync(path.join(dir, file)); } catch { /* best effort */ } };
  for (const i of invalid) drop(i.file);
  if (reports.length === 0) return result;

  const manifest = readManifest(repoRoot);
  const pendingPaths = manifest?.checkpoint?.pendingPaths;
  if (!manifest || !Array.isArray(pendingPaths)
    || (targetSha != null && manifest.knowledgeSha !== targetSha)) {
    result.manifestInvalid = true;
    return result;
  }

  const records = readInventory(repoRoot, manifest);
  const byPath = new Map(records.map((r) => [r.path, r]));
  const pending = new Set(pendingPaths);
  const pageHashes = new Map();
  let touched = false;

  for (const rep of reports) {
    if (rep.targetSha && targetSha && rep.targetSha !== targetSha) {
      result.rejected.push({ file: rep.file, target: rep.target, reason: `written for ${rep.targetSha}, not ${targetSha}` });
      drop(rep.file);
      continue;
    }
    const pages = [];
    let error = null;
    for (const raw of rep.pages) {
      const checked = checkReportedPage(repoRoot, raw);
      if (checked.error) { error = checked.error; break; }
      pages.push(checked.page);
      pageHashes.set(checked.page, checked.hash);
    }
    if (rep.target === SURVEY_TARGET) {
      if (!error && !pages.includes(OVERVIEW_PAGE)) error = `survey did not report ${OVERVIEW_PAGE}`;
      if (!error && !pages.includes(INDEX_PAGE)) error = `survey did not report ${INDEX_PAGE}`;
      if (error) result.rejected.push({ file: rep.file, target: rep.target, reason: error });
      else result.survey = { pages };
      drop(rep.file);
      continue;
    }
    if (error) {
      result.rejected.push({ file: rep.file, target: rep.target, reason: error });
      drop(rep.file);
      continue;
    }
    const rec = byPath.get(rep.target);
    if (!rec) {
      result.rejected.push({ file: rep.file, target: rep.target, reason: 'not a generation target in the inventory' });
      drop(rep.file);
      continue;
    }
    rec.pages = [...new Set(pages)];
    rec.selfHashes = Object.fromEntries(rec.pages.map((p) => [p, pageHashes.get(p)]));
    pending.delete(rep.target);
    touched = true;
    result.applied.push({ target: rep.target, pages: rec.pages, note: rep.note });
    drop(rep.file);
  }

  if (touched) {
    // One page, one hash: a page several targets share was just rewritten for
    // all of them, so every record referencing it must agree or `status`
    // would report an inventory inconsistency the agent never caused.
    for (const rec of records) {
      for (const page of Object.keys(rec.selfHashes || {})) {
        if (pageHashes.has(page)) rec.selfHashes[page] = pageHashes.get(page);
      }
    }
    manifest.inventoryShards = writeInventory(repoRoot, records, shardSize);
    manifest.checkpoint.pendingPaths = pendingPaths.filter((p) => pending.has(p));
    manifest.stats = {
      ...(manifest.stats || {}),
      pages: new Set(records.flatMap((r) => Object.keys(r.selfHashes || {}))).size,
    };
    writeManifest(repoRoot, manifest);
  }
  result.remaining = manifest.checkpoint.pendingPaths.length;
  return result;
}

/** How many of `targets` have a report waiting (written, not yet applied). */
function countPendingReports(repoRoot, targets) {
  const wanted = new Set(targets || []);
  let n = 0;
  for (const rep of collectCompletions(repoRoot).reports) if (wanted.has(rep.target)) n++;
  return n;
}

module.exports = {
  SCHEMA_VERSION, CACHE_DIR_REL, DONE_DIR_REL, SURVEY_TARGET, OVERVIEW_PAGE, INDEX_PAGE,
  knowledgeDir, manifestPath, inventoryDir, cacheDir, doneDir, doneFileName,
  emptyManifest, readManifest, writeManifest,
  readInventory, writeInventory, scanPackage,
  diffInventory, detectHandEdits, hashPage, validateInventoryConsistency,
  orphanedPages, removeOrphanedPages,
  collectCompletions, applyCompletions, countPendingReports,
  dirtyTargets, compareWithTree,
};
