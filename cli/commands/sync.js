'use strict';
/**
 * `aidev sync tools|wiki [--package <name|path>]` — bring a package in step
 * with something that moved on.
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
 *   workflow <name>  the kit's current version of the standard workflow the
 *          PKG copied `<name>` from → that copy, keeping the PKG's edits: per
 *          file a three-way merge against the kit version recorded at the
 *          copy (`standard.json` next to the workflow.yaml), as `tools` does
 *          with the templates. Implementation in `../lib/workflow`
 *          (`syncStandard`).
 *
 * The package is the current clone, or the one `--package` names (a registry
 * name or a path, resolved by the entry point), so a machine with several
 * clones can be brought forward from one place after `aidev update`.
 */

const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const home = require('../lib/home');
const layout = require('../lib/layout');
const knowledge = require('./knowledge');
const wfMod = require('../lib/workflow');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean', force: 'boolean', from: 'string', ...knowledge.FLAGS };
const FLAG_HELP = {
  'dry-run': 'tools / workflow: show what would change. wiki: show what would be queued and written. Write nothing',
  json: 'machine-readable output',
  force: 'tools / workflow: take the kit version of every file, discarding local edits and conflicts. wiki: overwrite hand-edited pages; take over a stale publish lease',
  from: 'workflow: the standard workflow the copy came from, for a copy that has no standard.json (made before the record existed)',
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
  if (human) render(result, { dryRun, repoRoot: ctx.packageRef ? repoRoot : null });

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

/** Print one workflow result for a human. */
function renderWorkflow(r, { dryRun = false, problem = null } = {}) {
  const changed = r.created.length + r.updated.length + r.merged.length;
  const total = r.created.length + r.unchanged.length + r.updated.length + r.kept.length + r.merged.length + r.conflicts.length;
  if (r.bootstrapped) ui.info(`no ${wfMod.STANDARD_RECORD} was there; the copy matches the kit's ${r.from} at ${String(r.baseCommit).slice(0, 12)} (${r.matched.length} of ${total} file(s)), which is used as the base and recorded`);
  else if (r.baseCommit == null && r.conflicts.length) ui.info(`no ${wfMod.STANDARD_RECORD} was there and no version of the kit's ${r.from} matches the copy, so there is no base to merge from`);
  if (changed === 0 && r.conflicts.length === 0) {
    ui.ok(`workflow ${r.name} is current with the kit's ${r.from} (${total} file(s)${r.kept.length ? `, ${r.kept.length} with local edits kept` : ''})`);
  } else if (changed > 0) {
    ui.ok(`${dryRun ? 'would take' : 'took'} ${changed} change(s) from the kit's ${r.from} into workflow ${r.name}`);
  }
  for (const p of r.created) ui.dim(`    + ${p}`);
  for (const p of r.updated) ui.dim(`    ~ ${p}`);
  for (const p of r.merged) ui.dim(`    ~ ${p} (merged with your edits)`);
  for (const p of r.retired) ui.dim(`    = ${p} (no longer in the kit's ${r.from}; kept)`);
  if (r.kept.length > 0 && changed > 0) ui.dim(`    ${r.kept.length} file(s) with local edits kept as they are (the kit did not change them)`);
  if (r.conflicts.length > 0) {
    ui.fail(`${r.conflicts.length} file(s) need your attention:`);
    for (const c of r.conflicts) ui.dim(`    ! ${c.path} — ${c.reason}`);
    ui.dim(`    Resolve them (the markers, or merge by hand), then run "aidev sync workflow ${r.name}" again to record the result.`);
    ui.dim(`    "aidev sync workflow ${r.name} --force" takes the kit's version of every file instead.`);
  } else if (problem) {
    ui.warn(`the result does not validate: ${problem}`);
  } else if (changed > 0 && !dryRun) {
    ui.dim(`    Review with "git diff", then "aidev submit workflow ${r.name}" (the reviewed copy is what runs; try it first with "aidev run workflow ${r.name} --trial").`);
  }
}

function syncWorkflow(ctx, repoRoot) {
  const { installRoot, flags } = ctx;
  if (!ctx.positionals[1]) throw new AidevError('aidev sync workflow needs the name of the workflow ("aidev list workflows" names them)');
  if (ctx.positionals[2]) throw new AidevError(`unexpected argument: ${ctx.positionals[2]}`);
  const name = wfMod.sanitizeName(ctx.positionals[1]);
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;
  cfgMod.loadConfig(repoRoot);
  const kitCommit = gitMod.headSha(installRoot);
  if (!kitCommit && human) ui.warn('the kit checkout is not a git repository; edited files cannot be merged, only kept or replaced.');
  if (human) ui.heading(`aidev sync workflow ${name}${dryRun ? ' (dry run)' : ''}`);
  const r = wfMod.syncStandard(repoRoot, {
    name, installRoot, kitCommit, kitVersion: ctx.version || null,
    from: flags.from != null ? String(flags.from) : null, dryRun, force: !!flags.force,
  });
  let problem = null;
  if (!dryRun && r.conflicts.length === 0) {
    try { const def = wfMod.loadDefinition(repoRoot, name); wfMod.resolveDependencies(repoRoot, installRoot, def); } catch (e) { problem = e.message; }
  }
  if (human) renderWorkflow(r, { dryRun, problem });
  const ok = r.conflicts.length === 0 && !problem;
  if (flags.json) {
    ui.json({
      ok, dryRun, name, from: r.from, kitCommit, baseCommit: r.baseCommit, bootstrapped: r.bootstrapped,
      created: r.created, updated: r.updated, merged: r.merged, kept: r.kept, retired: r.retired, unchanged: r.unchanged.length, conflicts: r.conflicts, problem,
    });
  }
  return r.conflicts.length ? EXIT.DRIFT : problem ? EXIT.GENERAL : EXIT.OK;
}

async function syncWiki(ctx, repoRoot) {
  const config = cfgMod.loadConfig(repoRoot);
  return (await knowledge.update({ ...ctx, repoRoot }, config)).code;
}

async function run(ctx) {
  const what = ctx.positionals[0];
  const repoRoot = ctx.repoRoot;
  if (ctx.positionals[1] && what !== 'workflow') {
    throw new AidevError(`unexpected argument: ${ctx.positionals[1]} (name a package with --package ${ctx.positionals[1]})`);
  }
  if (!repoRoot) throw new AidevError(`not inside a package clone; run it in one or name it: aidev sync ${what || '<what>'} --package <name|path>`);
  if (what === 'tools') return syncTools(ctx, repoRoot);
  if (what === 'wiki') return syncWiki(ctx, repoRoot);
  if (what === 'workflow') return syncWorkflow(ctx, repoRoot);
  throw new AidevError('aidev sync needs what to sync: tools (kit templates → this package), wiki (HEAD → the LLM Wiki) or workflow <name> (the kit\'s standard workflow → the copy, keeping your edits)');
}

module.exports = { run, render, FLAGS, FLAG_HELP, summary: 'tools: kit のテンプレートを PKG のツール設定へ反映（衝突は残す）。wiki: LLM Wiki を HEAD に追従させる。workflow <name>: 標準 workflow の新しい版を、PKG の変更を保って複製に取り込む' };
