'use strict';
/**
 * `aidev update` — pull the central kit forward.
 *
 * Static assets are replaced wholesale from `upstream`, which is safe only
 * because they are byte-identical across PKGs by construction: nothing
 * PKG-specific lives in them, so nothing PKG-specific can be lost. Local edits
 * to kit-owned files are a drift error, not a merge conflict — they belong in
 * a PR to the central kit.
 *
 * `.claude/` is not fetched directly. Upstream carries the templates it is
 * generated from, so the update checks out those and rebuilds the tree, which
 * is also how a file the kit has stopped shipping gets removed.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', ref: 'string', remote: 'string', json: 'boolean', force: 'boolean' };

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const remote = flags.remote || 'upstream';
  const ref = flags.ref || 'main';
  const dryRun = !!flags['dry-run'];

  if (!gitMod.isRepo(repoRoot)) throw new AidevError(`${repoRoot} is not a git repository`);

  const remotes = gitMod.run(['remote'], { cwd: repoRoot });
  if (!remotes.ok || !remotes.stdout.split('\n').includes(remote)) {
    throw new AidevError(
      `remote "${remote}" is not configured. The central kit should be kept as "upstream":\n` +
      '    git remote rename origin upstream\n' +
      '    git remote add origin <wrapper-repo-url>');
  }

  // A dirty working tree plus a wholesale asset replacement loses work.
  if (!flags.force && gitMod.hasUncommittedChanges(repoRoot)) {
    throw new AidevError(
      'the working tree has uncommitted changes. Commit or stash them first, or pass --force ' +
      'if you are certain they do not touch kit-owned files.');
  }

  ui.heading(`aidev update${dryRun ? ' (dry run)' : ''}`);

  const fetched = gitMod.fetch(repoRoot, remote, ref);
  if (!fetched.ok) throw new AidevError(`failed to fetch ${remote}/${ref}: ${fetched.stderr}`);
  const targetSha = gitMod.revParse(repoRoot, `${remote}/${ref}`);
  if (!targetSha) throw new AidevError(`could not resolve ${remote}/${ref}`);

  const before = assets.hashStaticFiles(repoRoot);
  const drift = assets.detectDrift(repoRoot);
  if (!drift.noLock && !drift.ok && !flags.force) {
    ui.warn('local kit-owned files already differ from .aidev-lock:');
    for (const m of drift.modified) ui.dim(`    modified: ${m.path}`);
    for (const m of drift.missing) ui.dim(`    missing:  ${m}`);
    ui.dim('    "aidev update" would overwrite these. Send intended changes to the central kit as a PR,');
    ui.dim('    or pass --force to discard them.');
    if (!dryRun) return EXIT.DRIFT;
  }

  // Preview what the incoming commit changes among kit-owned paths. `.claude/`
  // is absent here on purpose: it is generated from the templates below, so the
  // templates are what upstream actually carries.
  const KIT_PATHS = [assets.TEMPLATE_ROOT, 'CLAUDE.md', '.mcp.json', 'cli', 'scripts'];
  const diff = gitMod.run(['diff', '--name-only', 'HEAD', targetSha, '--', ...KIT_PATHS],
    { cwd: repoRoot });
  const changed = diff.ok ? diff.stdout.split('\n').filter(Boolean) : [];

  if (changed.length === 0) {
    ui.ok(`already up to date with ${remote}/${ref} (${targetSha.slice(0, 7)}) for kit-owned files.`);
  } else {
    ui.info(`${changed.length} kit-owned file(s) change in ${targetSha.slice(0, 7)}:`);
    for (const c of changed.slice(0, 40)) ui.dim(`    ${c}`);
    if (changed.length > 40) ui.dim(`    … and ${changed.length - 40} more`);
  }

  if (dryRun) {
    if (flags.json) ui.json({ ok: true, dryRun: true, targetSha, changed });
    return EXIT.OK;
  }

  if (changed.length > 0) {
    // checkout limits the update to kit-owned paths; aidev.yaml, knowledge/
    // and the submodule pointer are wrapper-owned and must survive untouched.
    const co = gitMod.run(['checkout', targetSha, '--', ...KIT_PATHS], { cwd: repoRoot });
    if (!co.ok) throw new AidevError(`failed to apply kit files: ${co.stderr}`);
    ui.ok(`applied kit files from ${targetSha.slice(0, 7)}`);
  }

  // The new templates are on disk; `.claude/` still holds the previous
  // generation until it is rebuilt from them. --force here matches the flag's
  // meaning above: discard local edits to kit-owned files.
  const mat = assets.materializeStaticAssets(repoRoot, { force: !!flags.force });
  if (mat.noTemplates) {
    throw new AidevError(
      `${assets.TEMPLATE_ROOT}/ is missing after the update; ${remote}/${ref} looks incomplete.`);
  }
  if (mat.conflicts.length > 0) {
    ui.warn(`${mat.conflicts.length} kit-owned file(s) differ from the kit copy:`);
    for (const c of mat.conflicts) ui.dim(`    ${c.path} — ${c.reason}`);
    ui.dim('    Pass --force to replace them with the kit version.');
    return EXIT.DRIFT;
  }
  const rebuilt = mat.created.length + mat.updated.length;
  if (rebuilt > 0 || mat.pruned.length > 0) {
    ui.ok(`rebuilt .claude/ (${rebuilt} written, ${mat.pruned.length} removed)`);
  } else {
    ui.ok('.claude/ is already current');
  }

  const lock = assets.writeLock(repoRoot, assets.buildLock(repoRoot, { kitCommit: targetSha }));
  ui.ok(`updated .aidev-lock (${Object.keys(lock.files).length} file hashes)`);

  const after = assets.hashStaticFiles(repoRoot);
  const touched = Object.keys(after).filter((k) => before[k] !== after[k]);
  if (flags.json) ui.json({ ok: true, targetSha, changed, touched });
  else {
    ui.out('');
    ui.info('review the diff and commit: git add -A && git commit -m "chore: update ai-dev-kit"');
  }
  return EXIT.OK;
}

module.exports = { run, FLAGS, summary: '中央kitの更新を取り込む' };
