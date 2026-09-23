'use strict';
/**
 * `aidev update` — bring the kit checkout forward. Nothing else.
 *
 * This updates the CLI and the templates it carries, and nothing in any PKG.
 * Taking the new templates into a PKG is `aidev sync tools`, run by each team
 * when it suits them: that step changes files the team owns and may need a
 * merge, so it must not ride along with a routine CLI update.
 *
 * After updating, the packages registered on this machine whose recorded kit
 * commit is older are listed, so nobody has to remember which clones still
 * carry the previous templates.
 */

const { EXIT, AidevError } = require('../lib/errors');
const gitMod = require('../lib/git');
const home = require('../lib/home');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean' };
const FLAG_HELP = {
  'dry-run': 'show whether a newer kit exists; change nothing',
  json: 'machine-readable output',
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

/** Registered packages whose recorded kit commit is not the one now installed. */
function packagesBehind(kitCommit) {
  const behind = [];
  for (const p of home.listPackages().present) {
    const applied = home.appliedKitCommit(p);
    if (!applied || applied !== kitCommit) behind.push({ path: p.path, name: p.name || null, applied });
  }
  return behind;
}

function run(ctx) {
  const { installRoot, flags, positionals } = ctx;
  if (positionals.length) {
    throw new AidevError('aidev update takes no object (it updates the kit). The Wiki is "aidev sync wiki", tool configuration "aidev sync tools".');
  }
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;

  if (human) ui.heading(`aidev update${dryRun ? ' (dry run)' : ''}`);
  const self = selfUpdate(installRoot, { dryRun });
  if (human) {
    if (!self.updated) ui.ok(`ai-dev-kit is up to date (${self.versionFrom || '?'} @ ${self.from.slice(0, 7)})`);
    else ui.ok(`${dryRun ? 'would update' : 'updated'} ai-dev-kit ${self.versionFrom || '?'} → ${self.versionTo || '?'} (${self.from.slice(0, 7)} → ${self.to.slice(0, 7)})`);
  }

  const now = dryRun ? self.to : gitMod.headSha(installRoot);
  const behind = packagesBehind(now);
  if (human && behind.length > 0) {
    ui.info(`${behind.length} package(s) on this machine still carry templates from an older kit:`);
    for (const b of behind) ui.dim(`    ${b.name || b.path}${b.applied ? ` (applied ${String(b.applied).slice(0, 7)})` : ''}`);
    ui.dim('    Run "aidev sync tools --package <name>" for each when convenient; it merges the new templates with your edits.');
  } else if (human && self.updated && !dryRun) {
    ui.dim('    Run "aidev sync tools" in your package clones to take the new templates.');
  }
  if (flags.json) ui.json({ ok: true, dryRun, kit: self, packagesBehind: behind });
  return EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, selfUpdate, packagesBehind, summary: 'ai-dev-kit 本体（CLI とテンプレート）を更新する。PKG への反映は aidev sync tools' };
