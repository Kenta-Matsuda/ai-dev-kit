'use strict';
/**
 * `aidev update` — fast-forward the dedicated ai-dev-kit checkout that
 * provides the running CLI.
 *
 * The target is derived from this executable's location, never from the
 * caller's current wrapper repository. A wrapper checkout is rejected rather
 * than risking a merge from its PKG-specific `origin`.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const gitMod = require('../lib/git');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean' };
const REMOTE = 'origin';
const REF = 'main';
const WRAPPER_MARKERS = ['aidev.yaml', '.aidev-lock', '.aidev-ejected'];

function readVersionAt(installRoot, sha) {
  const shown = gitMod.run(['show', `${sha}:package.json`], { cwd: installRoot });
  if (!shown.ok) return null;
  try {
    const pkg = JSON.parse(shown.stdout);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function wrapperEvidence(installRoot, remotes) {
  const marker = WRAPPER_MARKERS.find((name) => fs.existsSync(path.join(installRoot, name)));
  if (marker) return marker;
  if (remotes.includes('origin') && remotes.includes('upstream')) return 'origin + upstream remotes';
  return null;
}

function assertClean(installRoot) {
  const status = gitMod.run(['status', '--porcelain'], { cwd: installRoot });
  if (!status.ok) {
    throw new AidevError(`could not inspect the dedicated ai-dev-kit checkout: ${status.stderr}`);
  }
  if (status.stdout) {
    throw new AidevError(
      `the dedicated ai-dev-kit checkout has uncommitted changes (${installRoot}). ` +
      'Commit or stash them before updating the CLI.');
  }
}

function run(ctx) {
  const { installRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const json = !!flags.json;

  if (!installRoot || !gitMod.isRepo(installRoot)) {
    throw new AidevError(
      'the running CLI is not backed by a git checkout. Reinstall ai-dev-kit from a dedicated clone.');
  }

  const topLevel = gitMod.repoTopLevel(installRoot);
  if (!topLevel || !gitMod.samePath(topLevel, installRoot)) {
    throw new AidevError(
      `the CLI directory is not the root of its Git checkout (${installRoot}). ` +
      'Reinstall from a dedicated ai-dev-kit clone.');
  }

  const remoteResult = gitMod.run(['remote'], { cwd: installRoot });
  if (!remoteResult.ok) throw new AidevError(`could not inspect CLI remotes: ${remoteResult.stderr}`);
  const remotes = remoteResult.stdout.split('\n').filter(Boolean);
  const evidence = wrapperEvidence(installRoot, remotes);
  if (evidence) {
    throw new AidevError(
      `the aidev launcher points at a wrapper checkout (${installRoot}; detected ${evidence}).\n` +
      '    aidev update never updates a wrapper or its origin. Clone ai-dev-kit into a separate, stable\n' +
      '    directory and run that clone\'s scripts/install.ps1 or scripts/install.sh, then retry.');
  }
  if (!remotes.includes(REMOTE)) {
    throw new AidevError(
      `remote "${REMOTE}" is not configured in the CLI checkout (${installRoot}). ` +
      'The dedicated ai-dev-kit clone must keep the central repository as "origin".');
  }

  const branch = gitMod.currentBranch(installRoot);
  if (!branch) {
    throw new AidevError(
      'the dedicated ai-dev-kit checkout is detached. Check out main before running aidev update.');
  }
  if (branch !== REF) {
    throw new AidevError(
      `the dedicated ai-dev-kit checkout is on branch "${branch}"; expected "${REF}". ` +
      'Switch to main before updating the CLI.');
  }
  assertClean(installRoot);

  if (!json) ui.heading(`aidev update${dryRun ? ' (dry run)' : ''}`);

  const fetched = gitMod.fetch(installRoot, REMOTE, REF);
  if (!fetched.ok) throw new AidevError(`failed to fetch CLI update from ${REMOTE}/${REF}: ${fetched.stderr}`);

  const currentSha = gitMod.headSha(installRoot);
  const targetSha = gitMod.revParse(installRoot, `${REMOTE}/${REF}`);
  if (!currentSha) throw new AidevError('could not resolve the current ai-dev-kit checkout commit');
  if (!targetSha) throw new AidevError(`could not resolve ${REMOTE}/${REF} in the CLI checkout`);

  const currentVersion = readVersionAt(installRoot, currentSha);
  const targetVersion = readVersionAt(installRoot, targetSha);
  const baseResult = {
    ok: true,
    dryRun,
    updated: false,
    installRoot,
    remote: REMOTE,
    ref: REF,
    currentSha,
    targetSha,
    currentVersion,
    targetVersion,
    changed: [],
  };

  if (currentSha === targetSha) {
    if (json) ui.json(baseResult);
    else ui.ok(`ai-dev-kit CLI is already current at ${targetSha.slice(0, 7)}${targetVersion ? ` (v${targetVersion})` : ''}.`);
    return EXIT.OK;
  }

  if (!gitMod.isAncestor(installRoot, currentSha, targetSha)) {
    throw new AidevError(
      `cannot fast-forward the CLI checkout from ${currentSha.slice(0, 7)} to ${targetSha.slice(0, 7)}.\n` +
      '    The checkout has diverged from origin/main; resolve it manually or reinstall from a clean clone.');
  }

  const diff = gitMod.run(['diff', '--name-only', currentSha, targetSha], { cwd: installRoot });
  if (!diff.ok) throw new AidevError(`failed to inspect the CLI update: ${diff.stderr}`);
  const changed = diff.stdout.split('\n').filter(Boolean);
  const result = { ...baseResult, changed };

  if (!json) {
    ui.info(`${changed.length} file(s) change in ai-dev-kit ${currentSha.slice(0, 7)} -> ${targetSha.slice(0, 7)}:`);
    for (const file of changed.slice(0, 40)) ui.dim(`    ${file}`);
    if (changed.length > 40) ui.dim(`    … and ${changed.length - 40} more`);
  }

  if (dryRun) {
    if (json) ui.json(result);
    return EXIT.OK;
  }

  if (gitMod.currentBranch(installRoot) !== branch || gitMod.headSha(installRoot) !== currentSha) {
    throw new AidevError('the CLI checkout branch or commit changed while the update was being prepared; retry the command');
  }
  assertClean(installRoot);

  const merged = gitMod.run(['merge', '--ff-only', '--no-edit', targetSha], { cwd: installRoot });
  if (!merged.ok) throw new AidevError(`failed to fast-forward the CLI checkout: ${merged.stderr}`);

  const updatedResult = { ...result, updated: true };
  if (json) ui.json(updatedResult);
  else {
    ui.ok(`updated ai-dev-kit CLI to ${targetSha.slice(0, 7)}${targetVersion ? ` (v${targetVersion})` : ''}.`);
    ui.info('The next aidev invocation will use the updated CLI code.');
  }
  return EXIT.OK;
}

module.exports = { run, FLAGS, summary: 'ai-dev-kit CLI 本体を更新する' };
