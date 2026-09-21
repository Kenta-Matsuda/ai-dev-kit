'use strict';
/**
 * `aidev apply` — bring this PKG's tool configuration up to the installed kit.
 *
 * Deliberately separate from `aidev update`: updating the CLI is a machine-
 * wide, instant action, while applying new templates to a PKG changes files
 * the team owns and may need a merge. Teams choose when to take that on.
 *
 * The engine is `assets.applyTemplates`. A file the team edited is merged
 * three ways against the template the previous apply used; a conflict is
 * written with git-style markers and reported with exit 2, and this command
 * refuses to run again until the markers are gone. The result is an ordinary
 * diff in the PKG: review, resolve, commit, and the team receives it through
 * git.
 */

const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const home = require('../lib/home');
const layout = require('../lib/layout');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean', force: 'boolean' };
const FLAG_HELP = {
  'dry-run': 'show what would change; write nothing',
  json: 'machine-readable output',
  force: 'take the kit version of every file, discarding local edits and conflicts',
};

/** Print one apply result for a human. Shared with init. */
function render(result, { dryRun = false, repoRoot = null } = {}) {
  const verb = (past) => (dryRun ? `would ${past.replace(/d$/, '')}` : past);
  const name = repoRoot ? `${path.basename(repoRoot)}: ` : '';
  const changed = result.created.length + result.updated.length + result.merged.length
    + result.pruned.length + result.resolved.length;
  if (changed === 0 && result.conflicts.length === 0) {
    ui.ok(`${name}tool configuration is current (${result.unchanged.length + result.kept.length} file(s) for ${result.tools.join(', ')})`);
  } else if (changed > 0) {
    ui.ok(`${name}${verb('applied')} ${changed} change(s) for ${result.tools.join(', ')}`);
  }
  for (const p of result.created) ui.dim(`    + ${p}`);
  for (const p of result.updated) ui.dim(`    ~ ${p}`);
  for (const p of result.merged) ui.dim(`    ~ ${p} (merged with your edits)`);
  for (const p of result.resolved) ui.dim(`    ✓ ${p} (conflict resolved; recorded)`);
  for (const p of result.pruned) ui.dim(`    - ${p} (no longer shipped)`);
  for (const p of result.retired) ui.dim(`    = ${p} (no longer shipped, kept because you edited it)`);
  if (result.kept.length > 0) ui.dim(`    ${result.kept.length} file(s) with local edits kept as they are`);
  if (result.conflicts.length > 0) {
    ui.fail(`${name}${result.conflicts.length} file(s) need your attention:`);
    for (const c of result.conflicts) ui.dim(`    ! ${c.path} — ${c.reason}`);
    ui.dim('    Resolve the conflict markers (or keep your version / take the kit\'s), then run "aidev apply" again');
    ui.dim('    to record the result. "aidev apply --force" takes the kit version of every file instead.');
  } else if (changed > 0 && !dryRun) {
    ui.dim('    Review with "git diff", then commit so your team receives the update.');
  }
}

function run(ctx) {
  const { installRoot, repoRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;

  const config = cfgMod.loadConfig(repoRoot); // required: apply is a PKG command
  const tools = config.tools.default;
  const kitCommit = gitMod.headSha(installRoot);
  if (!kitCommit && human) ui.warn('the kit checkout is not a git repository; edited files cannot be merged, only kept or replaced.');

  if (human) ui.heading(`aidev apply${dryRun ? ' (dry run)' : ''}`);
  const result = assets.applyTemplates(repoRoot, {
    installRoot, dryRun, force: !!flags.force, tools, kitCommit, kitVersion: ctx.version || null,
  });
  if (result.noTemplates) {
    throw new AidevError(`no templates found under ${installRoot} for ${tools.join(', ')}. The ai-dev-kit checkout looks incomplete.`);
  }
  if (!dryRun) {
    layout.ensureAidevGitignore(repoRoot);
    home.registerPackage(repoRoot, { name: config.package.name, remote: gitMod.remoteUrl(repoRoot, 'origin'), kitCommit });
  }
  if (human) render(result, { dryRun });

  const ok = result.conflicts.length === 0;
  if (flags.json) {
    ui.json({
      ok, dryRun, kitCommit, tools,
      created: result.created, updated: result.updated, merged: result.merged, kept: result.kept,
      resolved: result.resolved, pruned: result.pruned, retired: result.retired,
      unchanged: result.unchanged.length, conflicts: result.conflicts,
    });
  }
  return ok ? EXIT.OK : EXIT.DRIFT;
}

module.exports = { run, render, FLAGS, FLAG_HELP, summary: 'kit の最新テンプレートを PKG のツール設定に適用する（編集済みはマージ、衝突は残す）' };
