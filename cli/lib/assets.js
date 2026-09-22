'use strict';
/**
 * Applying the kit's tool templates to a PKG, and inspecting the result.
 *
 * Each supported AI tool has a template tree in the kit checkout,
 * `templates/<tool>/`, laid out exactly as it lands in the PKG root. `aidev
 * init` copies the trees of the tools listed in `tools.default`; `aidev apply`
 * brings a PKG up to the templates of the kit that is installed now. Every
 * file that lands is committed in the PKG like any other file, so the whole
 * team shares one setup through git.
 *
 * The team may edit those copies. `apply` therefore behaves like a merge, not
 * a copy:
 *
 *   - untouched since the last apply → replaced with the new template
 *   - edited, kit unchanged            → the edit is kept
 *   - edited, kit changed              → 3-way merge (base = the template the
 *                                         last apply used, read from the kit's
 *                                         git history); a conflict is written
 *                                         with git-style markers and reported,
 *                                         and the PKG team resolves it
 *   - kit stopped shipping it          → removed if untouched, kept if edited
 *
 * `.aidev/materialized.json` (the "lock") remembers, per file, the template
 * hash that was applied (`kit`) and the hash of what was written or accepted
 * (`file`), plus the list of files still in conflict. That is what tells the
 * next apply which case it is in, and what lets `aidev check` refuse a tree
 * with unresolved conflicts or with the kit's hooks removed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sha256, writeJsonAtomic, writeFileAtomic, loadLock, lockPath, loadConfig } = require('./config');
const toolsMod = require('./tools');
const pathsMod = require('./paths');

/** The tool list assumed when neither aidev.yaml nor the lock names one. */
const DEFAULT_TOOLS = Object.freeze(['claude']);

/** Files inside a template tree's destination that are personal, never kit-owned. */
const STATIC_EXCLUDE = Object.freeze(['.claude/settings.local.json']);

/** The kit checkout that provides the running CLI. */
const DEFAULT_INSTALL_ROOT = path.resolve(__dirname, '..', '..');

/** Lock schema written by this version. */
const LOCK_SCHEMA = 4;

/** git-style conflict markers, as `git merge-file` writes them. */
const CONFLICT_RE = /^(<{7}|={7}|>{7})( |\r?$)/m;

/** Hook commands the kit wires into Claude Code; `check` refuses a settings.json without them. */
const KIT_HOOK_RE = /"aidev hook (session-start|guard-write|quality-gate|after-bash|session-stop)"/g;

/** A validated, de-duplicated tool list; unknown ids are dropped, empty means the default. */
function normalizeTools(tools) {
  const list = (Array.isArray(tools) ? tools : []).map(String).filter((t) => toolsMod.isTool(t));
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_TOOLS];
}

/**
 * The tools this PKG is set up for: aidev.yaml first (the team's intent),
 * then the lock (what was last applied), then the default.
 */
function configuredTools(repoRoot) {
  try {
    const cfg = loadConfig(repoRoot, { required: false });
    if (cfg && cfg.tools && cfg.tools.default) return normalizeTools(cfg.tools.default);
  } catch { /* an unreadable config must not stop eject or status from listing files */ }
  const lock = loadLock(repoRoot);
  if (lock && Array.isArray(lock.tools)) return normalizeTools(lock.tools);
  return [...DEFAULT_TOOLS];
}

function walk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(pathsMod.normalizeRel(path.relative(base, full)));
  }
}

function abs(repoRoot, rel) { return path.join(repoRoot, ...rel.split('/')); }

function readIfExists(full) {
  try { return fs.readFileSync(full); } catch { return null; }
}

/**
 * Every template file of the listed tools, as { src (absolute), dest
 * (repo-relative, posix), tool }. A template tree is copied shape-for-shape,
 * so there is no mapping table to drift.
 */
function listTemplateFiles(installRoot = DEFAULT_INSTALL_ROOT, { tools = DEFAULT_TOOLS } = {}) {
  const pairs = [];
  for (const id of normalizeTools(tools)) {
    const base = path.join(installRoot, ...toolsMod.templateDir(id).split('/'));
    let st;
    try { st = fs.statSync(base); } catch { continue; }
    if (!st.isDirectory()) continue;
    const found = [];
    walk(base, base, found);
    for (const rel of found) {
      if (pathsMod.matchesAny(STATIC_EXCLUDE, rel)) continue;
      pairs.push({ src: path.join(base, ...rel.split('/')), dest: rel, tool: id });
    }
  }
  return pairs.sort((a, b) => (a.dest < b.dest ? -1 : 1));
}

/**
 * Every kit-owned file currently present in the PKG, repo-relative and sorted:
 * what the lock recorded plus what the current templates would place. A file
 * the team added next to them is not listed.
 */
function listStaticFiles(repoRoot, { tools = null, installRoot = DEFAULT_INSTALL_ROOT } = {}) {
  const lock = loadLock(repoRoot);
  const list = normalizeTools(tools || (lock && lock.tools) || DEFAULT_TOOLS);
  const out = new Set();
  for (const { dest } of listTemplateFiles(installRoot, { tools: list })) {
    if (fs.existsSync(abs(repoRoot, dest))) out.add(dest);
  }
  for (const rel of Object.keys((lock && lock.files) || {})) {
    if (!pathsMod.matchesAny(STATIC_EXCLUDE, rel) && fs.existsSync(abs(repoRoot, rel))) out.add(rel);
  }
  return [...out].sort();
}

/** Lock entries were plain hash strings before schema 4; read both forms. */
function lockEntry(files, rel) {
  const e = files ? files[rel] : undefined;
  if (e == null) return null;
  if (typeof e === 'string') return { kit: null, file: e };
  return { kit: e.kit || null, file: e.file || null };
}

function hashOf(buf) { return `sha256:${sha256(buf)}`; }

function hasConflictMarkers(buf) {
  return CONFLICT_RE.test(buf.toString('utf8'));
}

/**
 * The template a previous apply used, read from the kit's git history at the
 * commit the lock recorded. Null when unavailable (not a git checkout, a
 * shallow clone, or the file did not exist there).
 */
function readTemplateAt(installRoot, kitCommit, tool, rel) {
  if (!kitCommit || !/^[0-9a-f]{7,40}$/i.test(String(kitCommit))) return null;
  const spec = `${kitCommit}:${toolsMod.templateDir(tool)}/${rel}`;
  try {
    return execFileSync('git', ['show', spec], {
      cwd: installRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return null; }
}

/**
 * Three-way merge through `git merge-file`. Returns { status, content } with
 * status `clean`, `conflict` (content carries markers) or `error`.
 */
function mergeFile({ ours, base, theirs, labels }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-merge-'));
  const files = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
  try {
    fs.writeFileSync(files[0], ours);
    fs.writeFileSync(files[1], base);
    fs.writeFileSync(files[2], theirs);
    const args = ['merge-file', '-p',
      '-L', labels.ours, '-L', labels.base, '-L', labels.theirs,
      files[0], files[1], files[2]];
    let status = 0;
    let out;
    try {
      out = execFileSync('git', args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      status = typeof e.status === 'number' ? e.status : -1;
      out = e.stdout;
    }
    // git merge-file exits with the number of conflicts (0 = clean); a real
    // failure is negative, which Node reports as 255 or similar.
    if (status === 0) return { status: 'clean', content: out };
    if (status > 0 && status < 128 && out && out.length > 0) return { status: 'conflict', content: out };
    return { status: 'error', content: null };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Bring the PKG's tool configuration up to the templates of `installRoot`.
 *
 * Per template file, decided from the lock (see the module comment):
 *   created      the file did not exist
 *   unchanged    already identical to the template
 *   updated      untouched since the last apply; replaced (or --force)
 *   kept         edited locally while the kit did not change it; left alone
 *   merged       edited locally and the kit changed it; merged cleanly
 *   conflicts    the merge conflicted (markers written), or it could not be
 *                merged (no record, or no base in the kit history) and the
 *                file was left alone
 *   resolved     a previous conflict whose markers are gone; now recorded
 *   pruned       no longer shipped and untouched; removed
 *   retired      no longer shipped but edited; left in place, dropped from the lock
 *
 * Writes the lock unless `dryRun`. Never throws for a per-file problem.
 */
function applyTemplates(repoRoot, {
  installRoot = DEFAULT_INSTALL_ROOT, dryRun = false, force = false,
  tools = DEFAULT_TOOLS, kitCommit = null, kitVersion = null,
} = {}) {
  const list = normalizeTools(tools);
  const pairs = listTemplateFiles(installRoot, { tools: list });
  const result = {
    ok: true, installRoot, tools: list, kitCommit, noTemplates: pairs.length === 0,
    created: [], unchanged: [], updated: [], kept: [], merged: [], conflicts: [],
    resolved: [], pruned: [], retired: [], lock: null,
  };
  if (result.noTemplates) return result;

  const lock = loadLock(repoRoot);
  const files = (lock && lock.files) || {};
  const previousConflicts = new Set((lock && lock.conflicts) || []);
  const newFiles = {};
  const newConflicts = [];
  const shortKit = (sha) => (sha ? String(sha).slice(0, 7) : 'unknown');

  for (const { src, dest, tool } of pairs) {
    let template;
    try { template = fs.readFileSync(src); } catch (e) {
      result.ok = false;
      result.conflicts.push({ path: dest, reason: `template ${src} is unreadable: ${e.message}` });
      continue;
    }
    const kitHash = hashOf(template);
    const full = abs(repoRoot, dest);
    const current = readIfExists(full);
    let entry = lockEntry(files, dest);

    // A file left in conflict last time: still marked → still in conflict;
    // markers gone → the team resolved it, and the result is now theirs.
    if (previousConflicts.has(dest) && current !== null) {
      if (hasConflictMarkers(current)) {
        result.conflicts.push({ path: dest, reason: 'conflict markers from the previous apply are still present' });
        newConflicts.push(dest);
        newFiles[dest] = { kit: entry ? entry.kit : kitHash, file: hashOf(current) };
        continue;
      }
      result.resolved.push(dest);
      entry = { kit: entry ? entry.kit : kitHash, file: hashOf(current) };
    }

    if (current === null) {
      result.created.push(dest);
      if (!dryRun) writeFileAtomic(full, template);
      newFiles[dest] = { kit: kitHash, file: kitHash };
      continue;
    }
    if (current.equals(template)) {
      result.unchanged.push(dest);
      newFiles[dest] = { kit: kitHash, file: kitHash };
      continue;
    }
    const currentHash = hashOf(current);
    // Pristine = still exactly the template a previous apply placed (for a
    // pre-schema-4 lock, the hash it recorded). Anything else is a local edit.
    const pristine = !!entry && (entry.kit ? entry.kit === currentHash : entry.file === currentHash);

    if (force || pristine) {
      // The copy is simply the previous generation (or --force): replaced
      // without ceremony.
      result.updated.push(dest);
      if (!dryRun) writeFileAtomic(full, template);
      newFiles[dest] = { kit: kitHash, file: kitHash };
      continue;
    }

    // Edited locally.
    if (entry && entry.kit === kitHash) {
      result.kept.push(dest);
      newFiles[dest] = { kit: kitHash, file: currentHash };
      continue;
    }
    if (!entry || !entry.kit) {
      result.ok = false;
      result.conflicts.push({
        path: dest,
        reason: entry
          ? 'edited locally and the record has no template hash to merge from; re-run with --force or send the change to ai-dev-kit'
          : 'exists and differs from the template, but was not placed by the kit; move it aside or re-run with --force',
      });
      newFiles[dest] = entry || { kit: null, file: currentHash };
      continue;
    }
    const base = readTemplateAt(installRoot, lock && lock.kitCommit, tool, dest);
    if (!base || hashOf(base) !== entry.kit) {
      result.ok = false;
      result.conflicts.push({
        path: dest,
        reason: `edited locally and the template it was based on (kit ${shortKit(lock && lock.kitCommit)}) is not in the kit checkout's history; resolve by hand or re-run with --force`,
      });
      newFiles[dest] = entry;
      continue;
    }
    const merged = mergeFile({
      ours: current, base, theirs: template,
      labels: {
        ours: `${dest} (this package)`,
        base: `kit ${shortKit(lock && lock.kitCommit)}`,
        theirs: `kit ${shortKit(kitCommit)}`,
      },
    });
    if (merged.status === 'clean') {
      result.merged.push(dest);
      if (!dryRun) writeFileAtomic(full, merged.content);
      newFiles[dest] = { kit: kitHash, file: hashOf(merged.content) };
    } else if (merged.status === 'conflict') {
      result.ok = false;
      result.conflicts.push({ path: dest, reason: 'the kit and this package changed the same lines; conflict markers were written' });
      newConflicts.push(dest);
      if (!dryRun) writeFileAtomic(full, merged.content);
      newFiles[dest] = { kit: kitHash, file: hashOf(merged.content) };
    } else {
      result.ok = false;
      result.conflicts.push({ path: dest, reason: 'git merge-file failed; resolve by hand or re-run with --force' });
      newFiles[dest] = entry;
    }
  }

  // Files a previous apply placed that the templates no longer contain (the
  // kit stopped shipping them, or their tool left tools.default).
  const wanted = new Set(pairs.map((p) => p.dest));
  for (const rel of Object.keys(files)) {
    if (wanted.has(rel) || pathsMod.matchesAny(STATIC_EXCLUDE, rel)) continue;
    const full = abs(repoRoot, rel);
    const current = readIfExists(full);
    if (current === null) continue;
    const entry = lockEntry(files, rel);
    const currentHash = hashOf(current);
    const pristine = !!entry && (entry.kit ? entry.kit === currentHash : entry.file === currentHash);
    if (pristine) {
      result.pruned.push(rel);
      if (!dryRun) { try { fs.rmSync(full, { force: true }); } catch { /* keep */ } }
    } else {
      result.retired.push(rel);
    }
  }

  result.lock = {
    schemaVersion: LOCK_SCHEMA,
    kitCommit,
    kitVersion,
    tools: list,
    appliedAt: new Date().toISOString(),
    files: newFiles,
    conflicts: newConflicts,
  };
  if (!dryRun) {
    pruneToolDirs(repoRoot);
    writeLock(repoRoot, result.lock);
  }
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

/**
 * Tidy every tool's config directories: subdirectories emptied by a prune go,
 * and a non-Claude tool's own directory goes too once it is empty (the kit
 * created it). `.claude/` itself is kept.
 */
function pruneToolDirs(repoRoot) {
  for (const id of toolsMod.TOOL_IDS) {
    for (const rel of toolsMod.getTool(id).configDirs) {
      const full = abs(repoRoot, rel);
      pruneEmptyDirs(full);
      if (id === 'claude') continue;
      try { if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* keep */ }
    }
  }
}

/**
 * Record the files currently on disk as applied, without changing them. Used
 * by tests and by `init` on a clone whose files came from git without a lock.
 */
function buildLock(repoRoot, {
  kitCommit = null, kitVersion = null, tools = DEFAULT_TOOLS, installRoot = DEFAULT_INSTALL_ROOT,
} = {}) {
  const list = normalizeTools(tools);
  const files = {};
  for (const { src, dest } of listTemplateFiles(installRoot, { tools: list })) {
    const current = readIfExists(abs(repoRoot, dest));
    if (current === null) continue;
    const template = readIfExists(src);
    files[dest] = { kit: template ? hashOf(template) : null, file: hashOf(current) };
  }
  return { schemaVersion: LOCK_SCHEMA, kitCommit, kitVersion, tools: list, appliedAt: new Date().toISOString(), files, conflicts: [] };
}

function writeLock(repoRoot, lock) {
  writeJsonAtomic(lockPath(repoRoot), lock);
  return lock;
}

/** Hook commands present in the template's settings.json but absent from the PKG's. */
function missingHooks(repoRoot, installRoot) {
  const rel = '.claude/settings.json';
  const tpl = readIfExists(path.join(installRoot, ...toolsMod.templateDir('claude').split('/'), ...rel.split('/')));
  const cur = readIfExists(abs(repoRoot, rel));
  if (!tpl || !cur) return [];
  const wanted = new Set((tpl.toString('utf8').match(KIT_HOOK_RE) || []).map((m) => m.slice(1, -1)));
  const have = new Set((cur.toString('utf8').match(KIT_HOOK_RE) || []).map((m) => m.slice(1, -1)));
  return [...wanted].filter((h) => !have.has(h)).sort();
}

/**
 * How the PKG's tool configuration relates to the lock and to the installed kit.
 *
 *   noLock       nothing recorded; run init/apply
 *   conflicts    files still carrying conflict markers (or listed as unresolved)
 *   hooksMissing kit hooks removed from .claude/settings.json (claude only)
 *   missing      recorded files absent from disk
 *   customised   files edited since the last apply (allowed; informational)
 *   outdated     the lock was written by another kit commit than the installed one
 *
 * `ok` is false only for noLock, conflicts or hooksMissing: those are the
 * states `aidev check` refuses.
 */
function inspectConfig(repoRoot, { tools = null, installRoot = DEFAULT_INSTALL_ROOT, kitCommit = null } = {}) {
  const lock = loadLock(repoRoot);
  if (!lock || typeof lock.files !== 'object' || lock.files == null) {
    return { ok: false, noLock: true, lock: null, conflicts: [], hooksMissing: [], missing: [], customised: [], outdated: false, tools: normalizeTools(tools) };
  }
  const list = normalizeTools(tools || lock.tools || DEFAULT_TOOLS);
  const conflicts = [];
  const missing = [];
  const customised = [];
  const listed = new Set(lock.conflicts || []);
  for (const rel of Object.keys(lock.files)) {
    if (pathsMod.matchesAny(STATIC_EXCLUDE, rel)) continue;
    const current = readIfExists(abs(repoRoot, rel));
    if (current === null) { missing.push(rel); continue; }
    if (listed.has(rel) || hasConflictMarkers(current)) { conflicts.push(rel); continue; }
    const entry = lockEntry(lock.files, rel);
    const currentHash = hashOf(current);
    const pristine = !!entry && (entry.kit ? entry.kit === currentHash : entry.file === currentHash);
    if (!pristine) customised.push(rel);
  }
  const hooksMissing = list.includes('claude') ? missingHooks(repoRoot, installRoot) : [];
  const outdated = !!(kitCommit && lock.kitCommit && lock.kitCommit !== kitCommit);
  return {
    ok: conflicts.length === 0 && hooksMissing.length === 0,
    noLock: false, lock, tools: list,
    conflicts: conflicts.sort(), hooksMissing, missing: missing.sort(), customised: customised.sort(), outdated,
  };
}

module.exports = {
  DEFAULT_TOOLS, STATIC_EXCLUDE, DEFAULT_INSTALL_ROOT, LOCK_SCHEMA, CONFLICT_RE,
  normalizeTools, configuredTools, listTemplateFiles, listStaticFiles,
  hasConflictMarkers, readTemplateAt, mergeFile, applyTemplates,
  buildLock, writeLock, missingHooks, inspectConfig,
};
