'use strict';
/**
 * `aidev update` — bring the kit forward, then the package(s) with it.
 *
 *   1. Fast-forward the kit checkout that provides the running CLI.
 *   2. Re-apply the templates to the current PKG clone (or, with --all, to
 *      every clone registered on this machine). Files the kit generated and
 *      nobody edited are replaced; a locally edited file is a conflict that
 *      needs --force or a PR to the kit.
 *
 * The result is an ordinary diff in the PKG clone: review it, commit it, and
 * the whole team receives the update through git.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const home = require('../lib/home');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean', 'kit-only': 'boolean', all: 'boolean', force: 'boolean' };
const FLAG_HELP = {
  'dry-run': 'show what would change; write nothing',
  json: 'machine-readable output',
  'kit-only': 'update the CLI only; leave package files alone',
  all: 're-apply templates to every package registered on this machine',
  force: 'replace tool configuration files that were edited locally',
};
const REMOTE = 'origin';
const REF = 'main';

function readVersionAt(installRoot, sha) {
  const shown = gitMod.run(['show', `${sha}:package.json`], { cwd: installRoot });
  if (!shown.ok) return null;
  try { return JSON.parse(shown.stdout).version || null; } catch { return null; }
}

/** Fast-forward the kit checkout. Returns { updated, from, to, versionFrom, versionTo }. */
function selfUpdate(installRoot, { dryRun }) {
  if (!installRoot || !gitMod.isRepo(installRoot)) {
    throw new AidevError('the running CLI is not backed by a git checkout. Reinstall ai-dev-kit from a clone.');
  }
  const status = gitMod.run(['status', '--porcelain'], { cwd: installRoot });
  if (!status.ok) throw new AidevError(`could not inspect the kit checkout: ${status.stderr}`);
  if (status.stdout) {
    throw new AidevError(`the kit checkout has uncommitted changes (${installRoot}). Commit or stash them before updating.`);
  }
  const from = gitMod.headSha(installRoot);
  const fetched = gitMod.fetch(installRoot, REMOTE, REF);
  if (!fetched.ok) throw new AidevError(`could not fetch ${REMOTE}/${REF} for the kit: ${fetched.stderr}`);
  const to = gitMod.revParse(installRoot, `${REMOTE}/${REF}`);
  if (!to) throw new AidevError(`could not resolve ${REMOTE}/${REF} in ${installRoot}`);
  const result = { updated: false, from, to, versionFrom: readVersionAt(installRoot, from), versionTo: readVersionAt(installRoot, to) };
  if (from === to) return result;
  if (!gitMod.isAncestor(installRoot, from, to)) {
    throw new AidevError(
      `the kit checkout (${from.slice(0, 7)}) has diverged from ${REMOTE}/${REF} (${to.slice(0, 7)}). ` +
      'Resolve it in that checkout by hand (it is a normal git repository).');
  }
  if (dryRun) return { ...result, updated: true, dryRun: true };
  const branch = gitMod.currentBranch(installRoot);
  if (branch !== REF) {
    throw new AidevError(`the kit checkout is on branch ${branch || '(detached)'}; check out ${REF} before updating.`);
  }
  const merged = gitMod.run(['merge', '--ff-only', `${REMOTE}/${REF}`], { cwd: installRoot });
  if (!merged.ok) throw new AidevError(`fast-forward failed: ${merged.stderr}`);
  return { ...result, updated: true };
}

/** Re-apply the templates to one PKG clone. */
function applyToPackage(repoRoot, { installRoot, dryRun, force, human, kitVersion = null }) {
  // The PKG's aidev.yaml says which tools to set up; a clone whose config
  // cannot be read keeps the tool list recorded at the last materialisation.
  const tools = assets.configuredTools(repoRoot);
  const mat = assets.materializeStaticAssets(repoRoot, { installRoot, dryRun, force, tools });
  const kitCommit = gitMod.headSha(installRoot);
  const summary = {
    path: repoRoot, ok: mat.ok, created: mat.created, updated: mat.updated, pruned: mat.pruned,
    unchanged: mat.unchanged.length, conflicts: mat.conflicts,
  };
  if (mat.noTemplates) { summary.ok = false; summary.reason = 'no templates in the kit checkout'; return summary; }
  if (mat.conflicts.length > 0) {
    if (human) {
      ui.fail(`${repoRoot}: ${mat.conflicts.length} file(s) were edited locally and were not replaced:`);
      for (const c of mat.conflicts) ui.dim(`    ${c.path} — ${c.reason}`);
      ui.dim('    Re-run with --force to take the kit version, or send the change to ai-dev-kit as a PR.');
    }
    return summary;
  }
  const changed = mat.created.length + mat.updated.length + mat.pruned.length;
  if (!dryRun) {
    require('../lib/layout').ensureAidevGitignore(repoRoot);
    assets.writeLock(repoRoot, assets.buildLock(repoRoot, { kitCommit, kitVersion, tools, installRoot }));
    home.registerPackage(repoRoot, { remote: gitMod.remoteUrl(repoRoot, 'origin'), kitCommit });
  }
  if (human) {
    if (changed === 0) ui.ok(`${path.basename(repoRoot)}: tool configuration already current`);
    else {
      ui.ok(`${path.basename(repoRoot)}: ${dryRun ? 'would update' : 'updated'} ${changed} file(s)`);
      for (const p of mat.created) ui.dim(`    + ${p}`);
      for (const p of mat.updated) ui.dim(`    ~ ${p}`);
      for (const p of mat.pruned) ui.dim(`    - ${p}`);
      if (!dryRun) ui.dim('    Review with "git diff", then commit so your team receives the update.');
    }
  }
  summary.changed = changed;
  return summary;
}

function run(ctx) {
  const { installRoot, repoRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;

  if (human) ui.heading(`aidev update${dryRun ? ' (dry run)' : ''}`);
  const self = selfUpdate(installRoot, { dryRun });
  if (human) {
    if (!self.updated) ui.ok(`ai-dev-kit is up to date (${self.versionFrom || '?'} @ ${self.from.slice(0, 7)})`);
    else ui.ok(`${dryRun ? 'would update' : 'updated'} ai-dev-kit ${self.versionFrom || '?'} → ${self.versionTo || '?'} (${self.from.slice(0, 7)} → ${self.to.slice(0, 7)})`);
  }

  const packages = [];
  if (!flags['kit-only']) {
    let targets = [];
    if (flags.all) targets = home.listPackages().present.map((p) => p.path);
    else if (repoRoot && fs.existsSync(cfgMod.configPath(repoRoot))) targets = [repoRoot];
    if (targets.length === 0 && human) {
      ui.info('not inside a package; pass --all to update every registered package, or run this in a package clone.');
    }
    for (const t of targets) packages.push(applyToPackage(t, { installRoot, dryRun, force: !!flags.force, human, kitVersion: ctx.version || null }));
  }

  const conflicts = packages.filter((p) => p.conflicts && p.conflicts.length > 0).length;
  if (flags.json) ui.json({ ok: conflicts === 0, dryRun, kit: self, packages });
  return conflicts === 0 ? EXIT.OK : EXIT.DRIFT;
}

module.exports = { run, FLAGS, FLAG_HELP, selfUpdate, applyToPackage, summary: 'ai-dev-kit本体を更新し、PKGのツール設定を再適用する' };
