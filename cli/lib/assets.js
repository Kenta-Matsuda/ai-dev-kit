'use strict';
/**
 * Materialised tool configuration and drift detection.
 *
 * The kit ships templates; `aidev init` and `aidev update` copy them into the
 * PKG clone, where they are committed like any other file so the whole team
 * shares one setup. Which files are written depends on `tools.default` in
 * aidev.yaml: Claude Code's tree (`.claude/**`, `CLAUDE.md`, `.mcp.json`) is
 * copied verbatim from `templates/`; every other tool's files are derived
 * from the same templates by its adapter in `tools.js`, so one edit to a
 * bundled agent reaches every configured tool on the next update.
 *
 * `.aidev/materialized.json` records the kit commit, the tool list and a hash
 * per file, and `aidev check` fails with exit 2 when the working tree
 * disagrees.
 *
 * This is layer 3 of the permission design: an agent that deletes the hooks
 * from settings.json slips past the runtime guard, but the edit stays in the
 * file, so the drift check catches it and the branch policy stops the merge.
 */

const fs = require('fs');
const path = require('path');
const { sha256, writeJsonAtomic, writeFileAtomic, loadLock, lockPath, loadConfig } = require('./config');
const toolsMod = require('./tools');
const pathsMod = require('./paths');

/** The tool list assumed when neither aidev.yaml nor the lock names one. */
const DEFAULT_TOOLS = Object.freeze(['claude']);

/** Roots (in the PKG clone) whose contents are kit-owned for Claude Code. */
const STATIC_ROOTS = Object.freeze(['.claude', 'CLAUDE.md', '.mcp.json']);

/** Files inside a static root that are personal, not kit-owned. */
const STATIC_EXCLUDE = Object.freeze(['.claude/settings.local.json']);

/**
 * Template trees in the kit checkout and where each lands in the PKG.
 * `templates/claude-assets/**` becomes `.claude/**`; `templates/root/**` lands
 * at the PKG root (CLAUDE.md, .mcp.json).
 */
const TEMPLATE_SETS = Object.freeze([
  { src: 'templates/claude-assets', dest: '.claude' },
  { src: 'templates/root', dest: '' },
]);

/** Kept for callers that only care about the Claude tree. */
const TEMPLATE_ROOT = TEMPLATE_SETS[0].src;
const TEMPLATE_DEST = TEMPLATE_SETS[0].dest;

/** The kit checkout that provides the running CLI. */
const DEFAULT_INSTALL_ROOT = path.resolve(__dirname, '..', '..');

/** A validated, de-duplicated tool list; unknown ids are dropped, empty means the default. */
function normalizeTools(tools) {
  const list = (Array.isArray(tools) ? tools : []).map(String).filter((t) => toolsMod.isTool(t));
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_TOOLS];
}

/**
 * The tools this PKG is set up for: aidev.yaml first (the team's intent),
 * then the lock (what was last written), then the default.
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

/**
 * Every kit-owned file currently present in the PKG, repo-relative and sorted.
 * Claude Code's roots are walked (the kit owns the whole tree); the other
 * tools own exactly the files their adapter derives, so a team's own files
 * next to them (say, another `.github/agents/*.agent.md`) are left alone.
 */
function listStaticFiles(repoRoot, { tools = DEFAULT_TOOLS, installRoot = DEFAULT_INSTALL_ROOT } = {}) {
  const out = [];
  const list = normalizeTools(tools);
  if (list.includes('claude')) {
    for (const root of STATIC_ROOTS) {
      const full = path.join(repoRoot, root);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        const found = [];
        walk(full, repoRoot, found);
        out.push(...found.filter((rel) => !pathsMod.matchesAny(STATIC_EXCLUDE, rel)));
      } else if (st.isFile()) out.push(pathsMod.normalizeRel(root));
    }
  }
  for (const id of list) {
    if (id === 'claude') continue;
    for (const { dest } of toolsMod.deriveAssets(id, installRoot)) {
      if (fs.existsSync(path.join(repoRoot, ...dest.split('/')))) out.push(dest);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Every file to materialise, as { src (absolute or null), dest (repo-relative),
 * contents (Buffer or null), tool } entries. Claude's trees are copied
 * shape-for-shape, so no per-file mapping exists to drift; derived files carry
 * their bytes directly.
 */
function listTemplateFiles(installRoot = DEFAULT_INSTALL_ROOT, { tools = DEFAULT_TOOLS } = {}) {
  const pairs = [];
  const list = normalizeTools(tools);
  if (list.includes('claude')) {
    for (const set of TEMPLATE_SETS) {
      const base = path.join(installRoot, ...set.src.split('/'));
      let st;
      try { st = fs.statSync(base); } catch { continue; }
      if (!st.isDirectory()) continue;
      const found = [];
      walk(base, base, found);
      for (const rel of found) {
        const dest = set.dest ? `${set.dest}/${rel}` : rel;
        if (pathsMod.matchesAny(STATIC_EXCLUDE, dest)) continue;
        pairs.push({ src: path.join(base, ...rel.split('/')), dest, contents: null, tool: 'claude' });
      }
    }
  }
  for (const id of list) {
    if (id === 'claude') continue;
    for (const d of toolsMod.deriveAssets(id, installRoot)) {
      pairs.push({ src: null, dest: d.dest, contents: d.contents, tool: id });
    }
  }
  return pairs.sort((a, b) => (a.dest < b.dest ? -1 : 1));
}

/**
 * Copy the templates into the PKG.
 *
 * A destination that already matches is left alone, so re-running is a no-op.
 * A destination that differs is a *conflict*, not an overwrite, unless the
 * lock proves nobody touched it since the kit generated it (then it is simply
 * the previous kit version and is replaced). `--force` takes the kit's version
 * regardless. Stale files are pruned only when the lock proves the kit put
 * them there — which is also how a tool removed from `tools.default` has its
 * files taken back out.
 */
function materializeStaticAssets(repoRoot, {
  installRoot = DEFAULT_INSTALL_ROOT, dryRun = false, force = false, tools = DEFAULT_TOOLS,
} = {}) {
  const list = normalizeTools(tools);
  const pairs = listTemplateFiles(installRoot, { tools: list });
  const result = {
    ok: true, templateRoot: TEMPLATE_ROOT, installRoot, tools: list, noTemplates: pairs.length === 0,
    created: [], updated: [], unchanged: [], conflicts: [], pruned: [],
  };
  if (result.noTemplates) return result;

  const lock = loadLock(repoRoot);
  const locked = (lock && lock.files) || {};

  for (const { src, dest, contents: derived } of pairs) {
    let contents = derived;
    if (contents == null) {
      try { contents = fs.readFileSync(src); } catch (e) {
        result.ok = false;
        result.conflicts.push({ path: dest, reason: `template ${src} is unreadable: ${e.message}` });
        continue;
      }
    }
    const full = path.join(repoRoot, ...dest.split('/'));
    let current = null;
    try { current = fs.readFileSync(full); } catch { current = null; }

    if (current !== null && current.equals(contents)) { result.unchanged.push(dest); continue; }

    if (current !== null) {
      const untouched = locked[dest] === `sha256:${sha256(current)}`;
      if (!untouched && !force) {
        result.ok = false;
        result.conflicts.push({
          path: dest,
          reason: locked[dest] == null
            ? 'differs from the kit copy and is not recorded in .aidev/materialized.json'
            : 'has been edited locally',
        });
        continue;
      }
    }

    const bucket = current === null ? result.created : result.updated;
    bucket.push(dest);
    if (!dryRun) writeFileAtomic(full, contents);
  }

  // Files the last materialisation produced that the kit no longer ships (or
  // that belong to a tool the PKG no longer lists).
  if (lock && lock.files) {
    const wanted = new Set(pairs.map((p) => p.dest));
    for (const rel of Object.keys(lock.files)) {
      if (wanted.has(rel) || pathsMod.matchesAny(STATIC_EXCLUDE, rel)) continue;
      const full = path.join(repoRoot, ...rel.split('/'));
      if (!fs.existsSync(full)) continue;
      result.pruned.push(rel);
      if (!dryRun) { try { fs.rmSync(full, { force: true }); } catch { /* keep */ } }
    }
  }

  if (!dryRun) pruneToolDirs(repoRoot);
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
 * and a derived tool's own directory goes too once it is empty (the kit
 * created it). `.claude/` itself is kept, as before.
 */
function pruneToolDirs(repoRoot) {
  for (const id of toolsMod.TOOL_IDS) {
    for (const rel of toolsMod.getTool(id).configDirs) {
      const full = path.join(repoRoot, ...rel.split('/'));
      pruneEmptyDirs(full);
      if (id === 'claude') continue;
      try { if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* keep */ }
    }
  }
}

/** { "<rel>": "sha256:<hex>" } for the current working tree. */
function hashStaticFiles(repoRoot, opts = {}) {
  const map = {};
  for (const rel of listStaticFiles(repoRoot, opts)) {
    try { map[rel] = `sha256:${sha256(fs.readFileSync(path.join(repoRoot, ...rel.split('/'))))}`; } catch { /* unreadable */ }
  }
  return map;
}

function buildLock(repoRoot, {
  kitCommit = null, kitVersion = null, tools = DEFAULT_TOOLS, installRoot = DEFAULT_INSTALL_ROOT,
} = {}) {
  const list = normalizeTools(tools);
  return {
    schemaVersion: 3,
    kitCommit,
    kitVersion,
    tools: list,
    appliedAt: new Date().toISOString(),
    files: hashStaticFiles(repoRoot, { tools: list, installRoot }),
  };
}

function writeLock(repoRoot, lock) {
  writeJsonAtomic(lockPath(repoRoot), lock);
  return lock;
}

/**
 * Compare the working tree against .aidev/materialized.json.
 * Returns { ok, missing, modified, extra, lock } — `extra` being kit-owned
 * files present on disk that the lock does not know about. The tool list
 * defaults to the one recorded in the lock, so a caller without aidev.yaml
 * still checks the right files.
 */
function detectDrift(repoRoot, { tools = null, installRoot = DEFAULT_INSTALL_ROOT } = {}) {
  const lock = loadLock(repoRoot);
  if (!lock || typeof lock.files !== 'object' || lock.files == null) {
    return { ok: false, noLock: true, missing: [], modified: [], extra: [], lock: null };
  }
  const list = normalizeTools(tools || lock.tools || DEFAULT_TOOLS);
  const current = hashStaticFiles(repoRoot, { tools: list, installRoot });
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
    noLock: false, missing, modified, extra, lock, tools: list,
  };
}

module.exports = {
  DEFAULT_TOOLS, STATIC_ROOTS, STATIC_EXCLUDE, TEMPLATE_SETS, TEMPLATE_ROOT, TEMPLATE_DEST, DEFAULT_INSTALL_ROOT,
  normalizeTools, configuredTools,
  listStaticFiles, hashStaticFiles, buildLock, writeLock, detectDrift,
  listTemplateFiles, materializeStaticAssets,
};
