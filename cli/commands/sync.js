'use strict';
/**
 * `aidev sync tools|wiki [<package>]` — bring a package in step with something
 * that moved on.
 *
 *   tools  the kit's templates → this package's AI tool configuration
 *          (`.claude/**`, `CLAUDE.md`, the other tools' files). Deliberately
 *          separate from `aidev update`: updating the CLI is a machine-wide,
 *          instant action, while taking new templates into a PKG changes files
 *          the team owns and may need a merge. A file the team edited is
 *          merged three ways against the template the previous sync used; a
 *          conflict is written with git-style markers and reported with exit
 *          2, and this command refuses to run again until the markers are
 *          gone.
 *   wiki   HEAD → the LLM Wiki: the structured half by the CLI, the prose by
 *          the knowledge-builder agent, committed as its own commit; on the
 *          tracking branch, published as a pull request. Implementation in
 *          `./knowledge`.
 *
 * The package is the current clone, or the one named (a registry name or a
 * path), so a machine with several clones can be brought forward from one
 * place after `aidev update`.
 */

const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const home = require('../lib/home');
const layout = require('../lib/layout');
const knowledge = require('./knowledge');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean', force: 'boolean', ...knowledge.FLAGS };
const FLAG_HELP = {
  'dry-run': 'tools: show what would change. wiki: show what would be queued and written. Write nothing',
  json: 'machine-readable output',
  force: 'tools: take the kit version of every file, discarding local edits and conflicts. wiki: overwrite hand-edited pages; take over a stale publish lease',
  ...Object.fromEntries(Object.entries(knowledge.FLAG_HELP)
    .filter(([k]) => !['dry-run', 'json', 'force'].includes(k))
    .map(([k, v]) => [k, `wiki: ${v}`])),
};

/** Print one tools result for a human. */
function render(result, { dryRun = false, repoRoot = null } = {}) {
  const name = repoRoot ? `${path.basename(repoRoot)}: ` : '';
  const changed = result.created.length + result.updated.length + result.merged.length
    + result.pruned.length + result.resolved.length;
  if (changed === 0 && result.conflicts.length === 0) {
    ui.ok(`${name}tool configuration is current (${result.unchanged.length + result.kept.length} file(s) for ${result.tools.join(', ')})`);
  } else if (changed > 0) {
    ui.ok(`${name}${dryRun ? 'would apply' : 'applied'} ${changed} change(s) for ${result.tools.join(', ')}`);
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
    ui.dim('    Resolve the conflict markers (or keep your version / take the kit\'s), then run "aidev sync tools" again');
    ui.dim('    to record the result. "aidev sync tools --force" takes the kit version of every file instead.');
  } else if (changed > 0 && !dryRun) {
    ui.dim('    Review with "git diff", then commit so your team receives the update.');
  }
}

function syncTools(ctx, repoRoot) {
  const { installRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;

  const config = cfgMod.loadConfig(repoRoot);
  const tools = config.tools.default;
  const kitCommit = gitMod.headSha(installRoot);
  if (!kitCommit && human) ui.warn('the kit checkout is not a git repository; edited files cannot be merged, only kept or replaced.');

  if (human) ui.heading(`aidev sync tools${dryRun ? ' (dry run)' : ''}`);
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
  if (human) render(result, { dryRun, repoRoot: ctx.positionals[1] ? repoRoot : null });

  const ok = result.conflicts.length === 0;
  if (flags.json) {
    ui.json({
      ok, dryRun, kitCommit, tools, package: repoRoot,
      created: result.created, updated: result.updated, merged: result.merged, kept: result.kept,
      resolved: result.resolved, pruned: result.pruned, retired: result.retired,
      unchanged: result.unchanged.length, conflicts: result.conflicts,
    });
  }
  return ok ? EXIT.OK : EXIT.DRIFT;
}

async function syncWiki(ctx, repoRoot) {
  const config = cfgMod.loadConfig(repoRoot);
  return (await knowledge.update({ ...ctx, repoRoot }, config)).code;
}

async function run(ctx) {
  const what = ctx.positionals[0];
  const ref = ctx.positionals[1];
  let repoRoot = ctx.repoRoot;
  if (ref) repoRoot = gitMod.findRepoRoot(home.resolvePackage(ref)) || home.resolvePackage(ref);
  if (!repoRoot) throw new AidevError('not inside a package clone; pass the package name or path: aidev sync tools <package>');
  if (what === 'tools') return syncTools(ctx, repoRoot);
  if (what === 'wiki') return syncWiki(ctx, repoRoot);
  throw new AidevError('aidev sync needs what to sync: tools (kit templates → this package) or wiki (HEAD → the LLM Wiki)');
}

module.exports = { run, render, FLAGS, FLAG_HELP, summary: 'tools: kit のテンプレートを PKG のツール設定へ反映（衝突は残す）。wiki: LLM Wiki を HEAD に追従させる' };
