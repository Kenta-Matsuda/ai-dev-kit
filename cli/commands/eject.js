'use strict';
/**
 * `aidev eject` — leave kit management.
 *
 * Spec: kit管理から外す（以後 `check` 対象外・手動管理へ）. After ejecting, the
 * repository keeps everything that is *its own* — the submodule, the generated
 * Wiki, aidev.yaml, any workflows — but nothing enforces the kit's rules any
 * more, and `aidev check` stops judging it.
 *
 * The removal order is load-bearing, and it is the reason this is a command
 * rather than a documented `rm`:
 *
 *   1. Hooks are unwired from .claude/settings.json FIRST.
 *   2. Only then are the policy, the lock and the leases removed.
 *
 * Reversing those steps would brick the repository. `loadPolicy` falls back to
 * a *restrictive* built-in policy when .aidev/policy.yaml is absent (src/**
 * read-only, .claude/** protected), and guard-write fails closed. So a repo
 * with live hooks and no policy file is not unmanaged — it is maximally locked,
 * with every path denied and no CLI left to mint a lease that would open it.
 * Removing the enforcement surface therefore has to mean removing the
 * enforcement too.
 *
 * What is deliberately NOT deleted:
 *   - `src/` and its git submodule wiring — the PKG is the point of the repo.
 *   - `knowledge/` — an expensive artefact the team may still want to read.
 *   - `aidev.yaml` — it records the ADO connection; deleting it silently would
 *     lose the organization/project mapping. It stops being read, not existing.
 *   - `workflows/` — team-authored content, never kit-owned.
 * Ejecting is about ending enforcement, not about destroying work.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const assets = require('../lib/assets');
const leases = require('../lib/leases');
const gitMod = require('../lib/git');
const pathsMod = require('../lib/paths');
const ui = require('../lib/ui');

const FLAGS = {
  yes: 'boolean',
  'dry-run': 'boolean',
  json: 'boolean',
  force: 'boolean',
  'keep-assets': 'boolean',
};

/** The kit's control surface: removed on eject, in this order. */
const CONTROL_FILES = Object.freeze([
  cfgMod.POLICY_REL,
  path.join('.aidev', 'policy.candidate.yaml'),
  cfgMod.LOCK_NAME,
  cfgMod.SYNC_LOCK_REL,
]);

/**
 * Directories under .aidev that hold only kit runtime state.
 *
 * `.aidev/tasks` is the default `task.cache_dir`: a local cache of Work Item
 * ids, branch names and SHAs whose source of truth is Azure DevOps, so deleting
 * it loses nothing. A team that relocated cache_dir elsewhere keeps that path —
 * eject does not follow config into directories it did not choose.
 */
const CONTROL_DIRS = Object.freeze([
  path.join('.aidev', 'leases'),
  path.join('.aidev', 'cache'),
  path.join('.aidev', 'tasks'),
]);

/**
 * Strip ai-dev-kit's hooks from .claude/settings.json, preserving everything
 * else in the file.
 *
 * Only entries whose command actually invokes this kit are removed; a team that
 * added its own hooks keeps them. Returns { changed, removed, text }.
 */
function unwireHooks(repoRoot) {
  const rel = path.join('.claude', 'settings.json');
  const full = path.join(repoRoot, rel);
  const raw = cfgMod.readTextIfExists(full);
  if (raw == null) return { changed: false, removed: [], rel, missing: true };

  let doc;
  try { doc = JSON.parse(raw); } catch (e) {
    // Refusing beats guessing: rewriting a file we cannot parse could destroy
    // settings, and leaving kit hooks live after "eject" would be worse still.
    throw new AidevError(
      `${rel} is not valid JSON (${e.message}), so its hooks cannot be safely unwired.\n` +
      '    Fix the file, or remove the "aidev hook" entries by hand and re-run.');
  }
  if (!doc || typeof doc !== 'object' || !doc.hooks || typeof doc.hooks !== 'object') {
    return { changed: false, removed: [], rel, missing: false };
  }

  const removed = [];
  const isKitHook = (entry) => {
    const cmd = entry && typeof entry === 'object' ? entry.command : null;
    return typeof cmd === 'string' && /(^|[\s/\\"'])aidev(\.js)?(["']?\s+|\s+)hook\b/.test(cmd);
  };

  for (const [event, matchers] of Object.entries(doc.hooks)) {
    if (!Array.isArray(matchers)) continue;
    const keptMatchers = [];
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== 'object' || !Array.isArray(matcher.hooks)) {
        keptMatchers.push(matcher);
        continue;
      }
      const kept = matcher.hooks.filter((h) => {
        if (!isKitHook(h)) return true;
        removed.push(`${event}: ${h.command}`);
        return false;
      });
      // A matcher whose only purpose was the kit hook goes away entirely rather
      // than lingering as an empty stanza. One that was already empty is left
      // exactly as the team wrote it — eject removes kit hooks, not tidiness.
      if (kept.length > 0) keptMatchers.push({ ...matcher, hooks: kept });
      else if (matcher.hooks.length === 0) keptMatchers.push(matcher);
    }
    if (keptMatchers.length > 0) doc.hooks[event] = keptMatchers;
    else delete doc.hooks[event];
  }

  if (removed.length === 0) return { changed: false, removed: [], rel, missing: false };
  return { changed: true, removed, rel, text: `${JSON.stringify(doc, null, 2)}\n` };
}

/** Everything eject would touch, computed without writing anything. */
function planEject(repoRoot, { keepAssets }) {
  const remove = [];
  for (const rel of CONTROL_FILES) {
    if (fs.existsSync(path.join(repoRoot, rel))) remove.push(rel);
  }
  for (const rel of CONTROL_DIRS) {
    if (fs.existsSync(path.join(repoRoot, rel))) remove.push(`${rel}/`);
  }

  // Kit-owned static assets are removed by default: leaving CLAUDE.md and
  // .claude/agents behind would keep instructing agents to use a kit that is no
  // longer installed. --keep-assets is for teams adopting them as their own.
  const staticFiles = keepAssets ? [] : assets.listStaticFiles(repoRoot);

  return { remove, staticFiles };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
}

/**
 * Report a path with forward slashes on every platform, keeping the trailing
 * slash that marks a directory in the preview.
 */
function reportRel(rel) {
  const isDir = rel.endsWith('/') || rel.endsWith(path.sep);
  return pathsMod.normalizeRel(rel) + (isDir ? '/' : '');
}

/** Drop now-empty .aidev/, but never a directory a team still has files in. */
function pruneAidevDir(repoRoot) {
  const dir = path.join(repoRoot, '.aidev');
  try {
    if (fs.readdirSync(dir).length === 0) { fs.rmdirSync(dir); return true; }
  } catch { /* absent or non-empty: nothing to do */ }
  return false;
}

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const keepAssets = !!flags['keep-assets'];

  const already = cfgMod.readEjectMarker(repoRoot);
  if (already && !flags.force) {
    // Idempotent rather than an error: re-running must not fail a pipeline.
    if (flags.json) ui.json({ ok: true, alreadyEjected: true, ejectedAt: already.ejectedAt || null });
    else {
      ui.heading('aidev eject');
      ui.ok(`this repository was already ejected${already.ejectedAt ? ` at ${already.ejectedAt}` : ''}.`);
      ui.dim('    Pass --force to run the removal again.');
    }
    return EXIT.OK;
  }

  const isManaged = fs.existsSync(cfgMod.configPath(repoRoot)) ||
    fs.existsSync(cfgMod.lockPath(repoRoot)) ||
    fs.existsSync(cfgMod.policyPath(repoRoot));
  if (!isManaged && !flags.force) {
    throw new AidevError(
      `${repoRoot} does not look kit-managed (no aidev.yaml, .aidev-lock or .aidev/policy.yaml).\n` +
      '    Refusing to delete files from a directory that was never initialised. Use --force to override.');
  }

  // An in-flight operation means someone else's work is mid-write. Ejecting
  // would strand a sync with knowledge/** half-rewritten, or a work lease whose
  // branch is still open.
  if (!flags.force) {
    const sync = leases.readSyncLease(repoRoot);
    if (sync && leases.evaluateLease(sync).valid) {
      throw new AidevError(
        'a sync is in progress; ejecting now would strand it mid-write.\n' +
        '    Finish it, or run "aidev sync --abort", then eject.');
    }
    const work = leases.listWorkLeases(repoRoot).filter((l) => leases.evaluateLease(l).valid);
    if (work.length > 0) {
      throw new AidevError(
        `${work.length} active work lease(s): ${work.map((l) => l.taskId).join(', ')}.\n` +
        '    Land or abandon those tasks ("aidev task abandon <id>") before ejecting.');
    }
  }

  const { remove, staticFiles } = planEject(repoRoot, { keepAssets });
  const hooks = unwireHooks(repoRoot);

  if (!flags.json) {
    ui.heading(`aidev eject${dryRun ? ' (dry run)' : ''}`);
    ui.warn('this removes ai-dev-kit\'s enforcement from this repository.');
    ui.out('');
    ui.info('will remove:');
    for (const r of remove) ui.dim(`    ${reportRel(r)}`);
    for (const f of staticFiles) ui.dim(`    ${f}`);
    if (remove.length + staticFiles.length === 0) ui.dim('    (nothing left to remove)');
    if (hooks.changed) {
      ui.info(`will unwire ${hooks.removed.length} hook(s) from ${reportRel(hooks.rel)}:`);
      for (const h of hooks.removed) ui.dim(`    ${h}`);
    }
    ui.out('');
    ui.info('will keep:');
    ui.dim('    src/ (the PKG submodule)   knowledge/ (the generated Wiki)');
    ui.dim('    aidev.yaml (no longer read)   workflows/ (team-authored)');
    if (keepAssets) ui.dim('    .claude/, CLAUDE.md, .mcp.json (--keep-assets)');
  }

  if (dryRun) {
    if (flags.json) {
      ui.json({
        ok: true, dryRun: true,
        remove: remove.map(reportRel),
        staticFiles, hooksRemoved: hooks.removed,
      });
    } else {
      ui.out('');
      ui.ok('dry run: nothing was written.');
    }
    return EXIT.OK;
  }

  // Deliberately not an interactive prompt. `eject` is destructive and may run
  // from a pipeline with no TTY, where a prompt would hang; requiring --yes
  // makes the confirmation explicit and scriptable in one rule.
  if (!flags.yes) {
    throw new AidevError(
      'refusing to eject without confirmation. Re-run with --yes once you have read the list above,\n' +
      '    or use --dry-run to preview.');
  }

  // --- 1. hooks first: never leave them live with no policy to consult ------
  if (hooks.changed) {
    cfgMod.writeFileAtomic(path.join(repoRoot, hooks.rel), hooks.text);
    // Guarded: under --json stdout carries one document and nothing else, the
    // same contract `check --json` keeps. The count is reported in that document.
    if (!flags.json) ui.ok(`unwired ${hooks.removed.length} hook(s) from ${reportRel(hooks.rel)}`);
  }

  // --- 2. then the control surface -----------------------------------------
  const removed = [];
  for (const rel of [...remove].reverse()) {
    if (rmrf(path.join(repoRoot, rel.replace(/\/$/, '')))) removed.push(rel);
  }
  for (const rel of staticFiles) {
    if (rmrf(path.join(repoRoot, rel))) removed.push(rel);
  }
  if (!keepAssets) {
    // Directories the asset sweep may have emptied.
    for (const d of ['.claude']) {
      const full = path.join(repoRoot, d);
      try { if (fs.existsSync(full) && fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch { /* keep */ }
    }
  }
  pruneAidevDir(repoRoot);

  // --- 3. record that this was deliberate ----------------------------------
  const marker = {
    schemaVersion: 1,
    ejectedAt: cfgMod.nowIso(),
    // An audit note, not an authorisation record — nothing trusts this field.
    ejectedBy: process.env.USERNAME || process.env.USER || null,
    kitCommit: gitMod.headSha(repoRoot),
    // Forward slashes regardless of platform, so the record a Windows developer
    // commits reads identically to the one CI produces on Linux.
    removed: removed.map(reportRel),
    hooksRemoved: hooks.removed,
    note: 'This repository is no longer managed by ai-dev-kit. "aidev check" no longer applies; ' +
      'the remaining files are maintained by hand. Re-adopt with "aidev init".',
  };
  cfgMod.writeJsonAtomic(cfgMod.ejectMarkerPath(repoRoot), marker);

  if (flags.json) {
    ui.json({
      ok: true, ejected: true, removed: marker.removed,
      hooksRemoved: hooks.removed, marker: cfgMod.EJECT_MARKER_NAME,
    });
    return EXIT.OK;
  }

  ui.ok(`removed ${removed.length} kit file(s); wrote ${cfgMod.EJECT_MARKER_NAME}`);
  ui.out('');
  ui.info('this repository is now maintained by hand.');
  ui.dim('    "aidev check" no longer applies — remove it from the branch policy and the pipeline,');
  ui.dim('    or CI will keep failing on a repo that is no longer kit-managed.');
  ui.dim('    Review and commit: git add -A && git commit -m "chore: eject from ai-dev-kit"');
  ui.dim('    To re-adopt later: aidev init');
  return EXIT.OK;
}

module.exports = {
  run, FLAGS, CONTROL_FILES, CONTROL_DIRS, unwireHooks, planEject,
  summary: 'kit管理から外す（以後 check 対象外・手動管理へ）',
};
