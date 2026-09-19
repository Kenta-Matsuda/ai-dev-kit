'use strict';
/**
 * Static-asset tracking and drift detection.
 *
 * `.claude/**`, `CLAUDE.md` and `.mcp.json` are shipped byte-identical by the
 * central kit. `.aidev-lock` records the kit commit plus a hash per file, and
 * `aidev check` fails with exit 2 when the working tree disagrees.
 *
 * This is layer 3 of the permission design: an agent that deletes the hooks
 * from settings.json slips past the runtime guard, but the edit stays in the
 * file, so the drift check catches it and the branch policy stops the merge.
 */

const fs = require('fs');
const path = require('path');
const { sha256, readJsonIfExists, writeJsonAtomic, writeFileAtomic, loadLock } = require('./config');
const pathsMod = require('./paths');

/** Roots whose contents are kit-owned, in the order they are reported. */
const STATIC_ROOTS = Object.freeze(['.claude', 'CLAUDE.md', '.mcp.json']);

/** Files inside a static root that are personal, not kit-owned. */
const STATIC_EXCLUDE = Object.freeze(['.claude/settings.local.json']);

/**
 * The pristine source for everything under `.claude/`.
 *
 * `.claude/` is a *generated* tree: `aidev init` materialises it from here and
 * `aidev update` re-materialises it after pulling the kit forward. Keeping the
 * source separate from the destination is what makes both operations safe to
 * repeat -- the templates are never the thing an agent or a hook edits, so
 * there is always an unambiguous answer to "what should this file contain".
 */
const TEMPLATE_ROOT = 'templates/claude-assets';

/** Destination the template tree is copied onto, verbatim. */
const TEMPLATE_DEST = '.claude';

function walk(dir, repoRoot, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, repoRoot, out);
    else if (e.isFile()) {
      const rel = pathsMod.normalizeRel(path.relative(repoRoot, full));
      if (!pathsMod.matchesAny(STATIC_EXCLUDE, rel)) out.push(rel);
    }
  }
}

/** Every kit-owned file currently present, repo-relative and sorted. */
function listStaticFiles(repoRoot) {
  const out = [];
  for (const root of STATIC_ROOTS) {
    const full = path.join(repoRoot, root);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, repoRoot, out);
    else if (st.isFile()) out.push(pathsMod.normalizeRel(root));
  }
  return out.sort();
}

/**
 * Every template file, as { src, dest } repo-relative pairs.
 *
 * The tree is copied shape-for-shape, so `templates/claude-assets/agents/x.md`
 * becomes `.claude/agents/x.md` with no per-file mapping to keep in sync.
 */
function listTemplateFiles(repoRoot) {
  const base = path.join(repoRoot, TEMPLATE_ROOT);
  let st;
  try { st = fs.statSync(base); } catch { return []; }
  if (!st.isDirectory()) return [];

  const found = [];
  walk(base, repoRoot, found);
  return found
    .map((src) => ({ src, dest: `${TEMPLATE_DEST}/${src.slice(`${TEMPLATE_ROOT}/`.length)}` }))
    .filter((p) => !pathsMod.matchesAny(STATIC_EXCLUDE, p.dest))
    .sort((a, b) => (a.dest < b.dest ? -1 : 1));
}

/**
 * Copy the template tree onto `.claude/`.
 *
 * A destination that already matches is left alone, so re-running is a no-op
 * rather than a churn of identical writes. A destination that differs is a
 * *conflict*, not an overwrite: kit-owned files are shared byte-identically
 * across every PKG, so a local edit belongs in a PR to the kit, and silently
 * discarding it here would destroy the only copy. `--force` resolves it the
 * way `aidev update` does, by taking the kit's version.
 *
 * Stale files are pruned only when the previous lock proves they were
 * kit-generated. Anything a team added by hand is left untouched, because the
 * lock is the only evidence that a file was ever ours to delete.
 */
function materializeStaticAssets(repoRoot, { dryRun = false, force = false } = {}) {
  const pairs = listTemplateFiles(repoRoot);
  const result = {
    ok: true, templateRoot: TEMPLATE_ROOT, noTemplates: pairs.length === 0,
    created: [], updated: [], unchanged: [], conflicts: [], pruned: [],
  };
  if (result.noTemplates) return result;

  const lock = loadLock(repoRoot);
  const locked = (lock && lock.files) || {};

  for (const { src, dest } of pairs) {
    let contents;
    try { contents = fs.readFileSync(path.join(repoRoot, src)); } catch (e) {
      result.ok = false;
      result.conflicts.push({ path: dest, reason: `template ${src} is unreadable: ${e.message}` });
      continue;
    }
    const full = path.join(repoRoot, dest);
    let current = null;
    try { current = fs.readFileSync(full); } catch { current = null; }

    if (current !== null && current.equals(contents)) { result.unchanged.push(dest); continue; }

    if (current !== null) {
      // A file differing from the template is not yet evidence of a local edit.
      // After `aidev update` pulls a newer kit, every changed file differs
      // precisely because it is the previous generation. The lock separates the
      // two: matching its recorded hash means nobody has touched the file since
      // it was generated, so replacing it loses nothing. Only an unrecorded
      // difference is a real edit, and that is what must not be overwritten.
      const untouched = locked[dest] === `sha256:${sha256(current)}`;
      if (!untouched && !force) {
        result.ok = false;
        result.conflicts.push({
          path: dest,
          reason: locked[dest] == null
            ? 'differs from the kit copy and is not recorded in .aidev-lock'
            : 'has been edited locally',
        });
        continue;
      }
    }

    const bucket = current === null ? result.created : result.updated;
    bucket.push(dest);
    if (!dryRun) writeFileAtomic(full, contents);
  }

  // Files the last materialisation produced that the kit no longer ships.
  if (lock && lock.files) {
    const wanted = new Set(pairs.map((p) => p.dest));
    for (const rel of Object.keys(lock.files)) {
      if (!rel.startsWith(`${TEMPLATE_DEST}/`)) continue;
      if (wanted.has(rel) || pathsMod.matchesAny(STATIC_EXCLUDE, rel)) continue;
      if (!fs.existsSync(path.join(repoRoot, rel))) continue;
      result.pruned.push(rel);
      if (!dryRun) { try { fs.rmSync(path.join(repoRoot, rel), { force: true }); } catch { /* keep */ } }
    }
  }

  if (!dryRun) pruneEmptyDirs(path.join(repoRoot, TEMPLATE_DEST));
  return result;
}

/** Remove directories the prune step emptied, deepest first; keep the root. */
function pruneEmptyDirs(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    pruneEmptyDirs(full);
    try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* keep */ }
  }
}

/** { "<rel>": "sha256:<hex>" } for the current working tree. */
function hashStaticFiles(repoRoot) {
  const map = {};
  for (const rel of listStaticFiles(repoRoot)) {
    try { map[rel] = `sha256:${sha256(fs.readFileSync(path.join(repoRoot, rel)))}`; } catch { /* unreadable */ }
  }
  return map;
}

function buildLock(repoRoot, { kitCommit = null, kitVersion = null } = {}) {
  return {
    schemaVersion: 1,
    kitCommit,
    kitVersion,
    appliedAt: new Date().toISOString(),
    files: hashStaticFiles(repoRoot),
  };
}

function writeLock(repoRoot, lock) {
  writeJsonAtomic(path.join(repoRoot, '.aidev-lock'), lock);
  return lock;
}

/**
 * Compare the working tree against `.aidev-lock`.
 * Returns { ok, missing, modified, extra, lock } — `extra` being kit-owned
 * files present on disk that the lock does not know about.
 */
function detectDrift(repoRoot) {
  const lock = loadLock(repoRoot);
  if (!lock || typeof lock.files !== 'object' || lock.files == null) {
    return { ok: false, noLock: true, missing: [], modified: [], extra: [], lock: null };
  }
  const current = hashStaticFiles(repoRoot);
  const missing = [];
  const modified = [];
  const extra = [];
  for (const [rel, expected] of Object.entries(lock.files)) {
    const actual = current[rel];
    if (actual == null) missing.push(rel);
    else if (actual !== expected) modified.push({ path: rel, expected, actual });
  }
  for (const rel of Object.keys(current)) {
    if (!(rel in lock.files)) extra.push(rel);
  }
  return {
    ok: missing.length === 0 && modified.length === 0 && extra.length === 0,
    noLock: false, missing, modified, extra, lock,
  };
}

module.exports = {
  STATIC_ROOTS, STATIC_EXCLUDE, TEMPLATE_ROOT, TEMPLATE_DEST,
  listStaticFiles, hashStaticFiles, buildLock, writeLock, detectDrift,
  listTemplateFiles, materializeStaticAssets,
};
