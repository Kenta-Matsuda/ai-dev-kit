'use strict';
/**
 * `aidev kit apply` — apply central kit-managed files to the current wrapper.
 *
 * This is deliberately separate from `aidev update`: applying versioned assets
 * to a wrapper produces a reviewable wrapper diff, while update only advances
 * the dedicated checkout that supplies the CLI executable.
 */

const { EXIT, AidevError } = require('../lib/errors');
const gitMod = require('../lib/git');
const assets = require('../lib/assets');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', ref: 'string', remote: 'string', json: 'boolean', force: 'boolean' };

function run(ctx) {
  const { repoRoot, flags, positionals } = ctx;
  if (positionals.length !== 1 || positionals[0] !== 'apply') {
    throw new AidevError(`unknown subcommand: ${positionals.join(' ') || '(none)'} (expected: apply)`);
  }

  const remote = flags.remote || 'upstream';
  const ref = flags.ref || 'main';
  const dryRun = !!flags['dry-run'];
  const json = !!flags.json;
  const human = !json;
  try {
    gitMod.assertSafeRef(remote, 'remote');
    gitMod.assertSafeRef(ref, 'branch');
  } catch (e) {
    throw new AidevError(e.message);
  }

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

  if (human) ui.heading(`aidev kit apply${dryRun ? ' (dry run)' : ''}`);

  const fetched = gitMod.fetch(repoRoot, remote, ref);
  if (!fetched.ok) throw new AidevError(`failed to fetch ${remote}/${ref}: ${fetched.stderr}`);
  const targetSha = gitMod.revParse(repoRoot, `${remote}/${ref}`);
  if (!targetSha) throw new AidevError(`could not resolve ${remote}/${ref}`);

  const before = assets.hashStaticFiles(repoRoot);
  const drift = assets.detectDrift(repoRoot);
  if (!drift.noLock && !drift.ok && !flags.force) {
    if (human) {
      ui.warn('local kit-owned files already differ from .aidev-lock:');
      for (const m of drift.modified) ui.dim(`    modified: ${m.path}`);
      for (const m of drift.missing) ui.dim(`    missing:  ${m}`);
      ui.dim('    "aidev kit apply" would overwrite these. Send intended changes to the central kit as a PR,');
      ui.dim('    or pass --force to discard them.');
    }
    if (!dryRun) {
      if (json) ui.json({ ok: false, exitCode: EXIT.DRIFT, targetSha, drift });
      return EXIT.DRIFT;
    }
  }

  // Preview what the incoming commit changes among kit-owned paths. `.claude/`
  // is absent here on purpose: it is generated from the templates below, so the
  // templates are what upstream actually carries.
  const KIT_PATHS = [assets.TEMPLATE_ROOT, 'CLAUDE.md', '.mcp.json', 'cli', 'scripts'];
  const diff = gitMod.run(['diff', '--name-only', 'HEAD', targetSha, '--', ...KIT_PATHS],
    { cwd: repoRoot });
  if (!diff.ok) throw new AidevError(`failed to inspect kit changes: ${diff.stderr}`);
  const changed = diff.stdout.split('\n').filter(Boolean);

  if (human) {
    if (changed.length === 0) {
      ui.ok(`already current with ${remote}/${ref} (${targetSha.slice(0, 7)}) for kit-owned files.`);
    } else {
      ui.info(`${changed.length} kit-owned file(s) change in ${targetSha.slice(0, 7)}:`);
      for (const c of changed.slice(0, 40)) ui.dim(`    ${c}`);
      if (changed.length > 40) ui.dim(`    … and ${changed.length - 40} more`);
    }
  }

  if (dryRun) {
    if (json) ui.json({ ok: true, dryRun: true, targetSha, changed, drift });
    return EXIT.OK;
  }

  if (changed.length > 0) {
    // checkout limits the update to kit-owned paths; aidev.yaml, knowledge/
    // and the submodule pointer are wrapper-owned and must survive untouched.
    const co = gitMod.run(['checkout', targetSha, '--', ...KIT_PATHS], { cwd: repoRoot });
    if (!co.ok) throw new AidevError(`failed to apply kit files: ${co.stderr}`);
    if (human) ui.ok(`applied kit files from ${targetSha.slice(0, 7)}`);
  }

  // The new templates are on disk; `.claude/` still holds the previous
  // generation until it is rebuilt from them. --force here matches the flag's
  // meaning above: discard local edits to kit-owned files.
  const mat = assets.materializeStaticAssets(repoRoot, { force: !!flags.force });
  if (mat.noTemplates) {
    throw new AidevError(
      `${assets.TEMPLATE_ROOT}/ is missing after kit apply; ${remote}/${ref} looks incomplete.`);
  }
  if (mat.conflicts.length > 0) {
    if (json) {
      ui.json({ ok: false, exitCode: EXIT.DRIFT, targetSha, changed, conflicts: mat.conflicts });
    } else {
      ui.warn(`${mat.conflicts.length} kit-owned file(s) differ from the kit copy:`);
      for (const c of mat.conflicts) ui.dim(`    ${c.path} — ${c.reason}`);
      ui.dim('    Pass --force to replace them with the kit version.');
    }
    return EXIT.DRIFT;
  }
  const rebuilt = mat.created.length + mat.updated.length;
  if (human) {
    if (rebuilt > 0 || mat.pruned.length > 0) {
      ui.ok(`rebuilt .claude/ (${rebuilt} written, ${mat.pruned.length} removed)`);
    } else {
      ui.ok('.claude/ is already current');
    }
  }

  const lock = assets.writeLock(repoRoot, assets.buildLock(repoRoot, { kitCommit: targetSha }));
  if (human) ui.ok(`updated .aidev-lock (${Object.keys(lock.files).length} file hashes)`);

  const after = assets.hashStaticFiles(repoRoot);
  const touched = Object.keys(after).filter((key) => before[key] !== after[key]);
  if (json) ui.json({ ok: true, targetSha, changed, touched });
  else {
    ui.out('');
    ui.info('review the diff and commit: git add -A && git commit -m "chore: update ai-dev-kit assets"');
  }
  return EXIT.OK;
}

module.exports = { run, FLAGS, summary: '中央kitの管理対象をwrapperへ適用する' };
