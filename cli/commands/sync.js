'use strict';
/**
 * `aidev sync` — follow the PKG tracking branch forward.
 *
 * One event is handled: "the tracking branch now points at a different SHA".
 * Whether that came from the AI environment or from someone editing the PKG
 * directly is deliberately indistinguishable here — that is what keeps the
 * standalone path from rotting through disuse.
 *
 * Ordering is forced and cannot be rearranged:
 *
 *   lease → bump → diff → regenerate → check → release → PR
 *
 * The lease must precede the bump because generation reads the checked-out
 * tree, so from the bump until regeneration completes the repository is by
 * definition in the `submoduleSha != knowledgeSha` error state — which would
 * otherwise block the only tool able to fix it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXIT, AidevError, KnowledgeError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const leases = require('../lib/leases');
const inventory = require('../lib/inventory');
const assets = require('../lib/assets');
const ado = require('../lib/ado');
const agentMod = require('../lib/agent');
const ui = require('../lib/ui');

const FLAGS = {
  to: 'string', 'dry-run': 'boolean', 'no-pr': 'boolean', resume: 'boolean',
  abort: 'boolean', 'check-only': 'boolean', json: 'boolean', force: 'boolean',
  ...agentMod.AGENT_FLAGS,
};

/**
 * Immutable identity of one sync operation: re-running it must not create a
 * second commit or PR.
 */
function operationKey(config, targetSha) {
  const ado = config.azure_devops;
  return crypto.createHash('sha256')
    .update([ado.organization, ado.project, ado.repository, targetSha, ado.wrapper_repository || ''].join('\0'))
    .digest('hex').slice(0, 32);
}

/**
 * Stable identity of the sync *stream*: finds the same open PR even after the
 * target SHA moves on, so a superseding sync updates rather than duplicates.
 */
function syncStreamId(config) {
  const ado = config.azure_devops;
  return crypto.createHash('sha256')
    .update([ado.organization, ado.project, ado.repository,
      config.sync.tracking_branch, ado.wrapper_repository || ''].join('\0'))
    .digest('hex').slice(0, 32);
}

function syncBranchName(config, targetSha) {
  return `ai/sync-${String(targetSha).slice(0, 12)}`;
}

/** Marker carried in the PR description so a sync stream can find its own PR. */
const STREAM_MARKER = '<!-- aidev:sync-stream ';

function streamMarker(streamId) {
  return `${STREAM_MARKER}${streamId} -->`;
}

function prDescription({ streamId, opKey, targetSha, branch, diff, pending }) {
  return [
    streamMarker(streamId),
    '',
    `Follows the PKG tracking branch \`${branch}\` forward to \`${targetSha}\`.`,
    '',
    '| | |',
    '| --- | --- |',
    `| target SHA | \`${targetSha}\` |`,
    `| operation key | \`${opKey}\` |`,
    `| sync stream | \`${streamId}\` |`,
    '',
    '### Change set',
    '',
    `- added: ${diff.added}`,
    `- modified: ${diff.modified}`,
    `- removed: ${diff.removed}`,
    `- renamed: ${diff.renamed}`,
    '',
    pending > 0
      ? `> ⚠️ ${pending} Wiki page(s) still need prose regeneration (\`aidev knowledge build --refresh\`).`
      : '> The Wiki is regenerated and the three SHAs agree.',
    '',
    '**Merging is a human decision — this PR is never auto-completed.**',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

/**
 * Commit the bump and the Wiki diff onto the sync branch and push it.
 *
 * Returns { pushed, branch, reason }. A failure here is reported, not thrown:
 * the sync itself already succeeded and the working tree holds the result, so
 * the operator can push by hand rather than lose the regeneration.
 */
function commitAndPush(repoRoot, prBranch, targetSha, remote) {
  if (!gitMod.hasUncommittedChanges(repoRoot)) {
    return { pushed: false, reason: 'nothing to commit — the working tree already matches the target' };
  }

  const startBranch = gitMod.currentBranch(repoRoot);
  const co = gitMod.run(['checkout', '-B', prBranch], { cwd: repoRoot });
  if (!co.ok) return { pushed: false, reason: `could not create branch ${prBranch}: ${co.stderr}` };

  // Only the two things sync owns. `git add -A` would sweep up whatever else
  // the operator happened to have in the tree.
  for (const spec of ['src', 'knowledge']) {
    if (fs.existsSync(path.join(repoRoot, spec))) {
      gitMod.run(['add', '--', spec], { cwd: repoRoot });
    }
  }

  const staged = gitMod.run(['diff', '--cached', '--quiet'], { cwd: repoRoot });
  if (staged.ok) {
    if (startBranch) gitMod.run(['checkout', startBranch], { cwd: repoRoot });
    return { pushed: false, reason: 'no submodule or Wiki changes were staged' };
  }

  const message = [
    `chore(sync): follow PKG to ${String(targetSha).slice(0, 12)}`,
    '',
    'Bumps the src/ submodule pointer and updates the generated Wiki to match.',
    '',
    'Co-Authored-By: Claude Code <noreply@anthropic.com>',
  ].join('\n');

  const commit = gitMod.run(['commit', '-m', message], { cwd: repoRoot });
  if (!commit.ok) {
    // Deliberately left checked out on prBranch with the changes staged: the
    // regeneration is expensive, and switching back could discard it. Say so,
    // so the operator is not silently standing on a branch they did not pick.
    return { pushed: false, branch: prBranch,
      reason: `commit failed on ${prBranch} (changes remain staged there): ${commit.stderr}` };
  }

  const push = gitMod.run(['push', '--set-upstream', remote, prBranch], { cwd: repoRoot });
  if (!push.ok) {
    return { pushed: false, committed: true, branch: prBranch,
      reason: `push failed; the commit is on local branch ${prBranch}: ${push.stderr}` };
  }
  return { pushed: true, committed: true, branch: prBranch };
}

/**
 * Create the wrapper PR, or update the one this sync stream already has open.
 *
 * Deduplication is by sync stream rather than by target SHA: when the tracking
 * branch moves while a sync PR is still open, the new target must supersede the
 * old PR instead of opening a second one for the same stream.
 */
async function openWrapperPr(config, { prBranch, streamId, opKey, targetSha, diff, pending }) {
  const repo = config.azure_devops.wrapper_repository;
  if (!repo) {
    return { ok: false, reason: 'azure_devops.wrapper_repository is not configured' };
  }
  const targetBranch = config.sync.wrapper_pr?.target_branch || 'main';
  const description = prDescription({
    streamId, opKey, targetSha, branch: config.sync.tracking_branch, diff, pending,
  });

  const open = await ado.listPullRequests(config, repo, { status: 'active', targetBranch });
  const mine = open.find((pr) => String(pr.description || '').includes(streamMarker(streamId)));

  // Same stream, same branch: the target SHA did not move, so update in place.
  if (mine && String(mine.sourceRefName || '').endsWith(`/${prBranch}`)) {
    await ado.updatePullRequestDescription(config, repo, mine.pullRequestId, description);
    return { ok: true, updated: true, pullRequestId: mine.pullRequestId, url: mine.url };
  }

  const created = await ado.createPullRequest(config, repo, {
    sourceBranch: prBranch,
    targetBranch,
    title: `chore(sync): follow PKG to ${String(targetSha).slice(0, 12)}`,
    description,
    reviewers: config.sync.wrapper_pr?.reviewers || [],
  });
  const result = { ok: true, created: true,
    pullRequestId: created?.pullRequestId || null, url: created?.url || null };

  // The stream had a PR open from an earlier target. Azure DevOps cannot
  // re-point an existing PR at a new source branch, so the new SHA needs its
  // own PR and the old one is annotated rather than left looking current.
  // Closing it is a human decision, like every other merge-state change here.
  if (mine) {
    try {
      await ado.updatePullRequestDescription(config, repo, mine.pullRequestId,
        `${String(mine.description || '')}\n\n> ⚠️ Superseded by \`${prBranch}\`` +
        `${result.pullRequestId ? ` (PR !${result.pullRequestId})` : ''}. Close this one after review.`);
      result.superseded = { pullRequestId: mine.pullRequestId, branch: mine.sourceRefName };
    } catch (e) {
      result.supersedeWarning = `the previous PR !${mine.pullRequestId} could not be annotated: ${e.message}`;
    }
  }
  return result;
}

async function run(ctx) {
  const { repoRoot, flags } = ctx;
  const config = cfgMod.loadConfig(repoRoot);
  const subDir = path.join(repoRoot, 'src');
  const branch = config.sync.tracking_branch;

  if (!fs.existsSync(subDir)) {
    throw new AidevError('src/ submodule is not present — run "git submodule update --init --recursive"');
  }

  // ---- --abort: restore the recorded original SHA and release -------------
  if (flags.abort) return abort(repoRoot, flags);

  // ---- --check-only: judge, write nothing ---------------------------------
  if (flags['check-only']) {
    const st = stateMod.computeState(repoRoot, config, { force: true });
    if (flags.json) ui.json(st); else ui.out(stateMod.formatSummary(st));
    return st.severity === stateMod.SEVERITY.ERROR ? EXIT.KNOWLEDGE : EXIT.OK;
  }

  const existingLease = leases.readSyncLease(repoRoot);
  if (existingLease && !flags.resume && !flags.force) {
    const ev = leases.evaluateLease(existingLease);
    throw new AidevError(
      `a sync lease is present (${ev.valid ? 'active' : ev.reason}; target ${stateMod.short(existingLease.targetSha)}). ` +
      'Continue it with "aidev sync --resume" or release it with "aidev sync --abort".');
  }
  if (flags.resume && !existingLease) {
    ui.warn('no sync lease found; --resume has nothing to continue. Proceeding as a fresh sync.');
  }

  ui.heading(`aidev sync${flags['dry-run'] ? ' (dry run)' : ''}${flags.resume ? ' (resume)' : ''}`);

  // ---- 1. resolve targetSha from the tracking branch ----------------------
  const fetched = gitMod.fetch(subDir, 'origin', branch);
  if (!fetched.ok) {
    throw new AidevError(`could not fetch origin/${branch} in src/: ${fetched.stderr}`);
  }
  const tip = gitMod.revParse(subDir, `origin/${branch}`);
  if (!tip) throw new AidevError(`could not resolve origin/${branch}`);

  let targetSha = tip;
  if (flags.to) {
    const wanted = gitMod.revParse(subDir, flags.to);
    if (!wanted) throw new AidevError(`--to ${flags.to} is not a commit in src/`);
    // Only a SHA reachable from the fetched tracking branch is allowed: an
    // agent's branch tip is not a legitimate sync target.
    if (!gitMod.isAncestor(subDir, wanted, tip)) {
      throw new AidevError(
        `--to ${stateMod.short(wanted)} is not reachable from origin/${branch}. ` +
        'sync follows the tracking branch; an agent branch tip is never a valid target.');
    }
    targetSha = wanted;
  }

  const originalSha = gitMod.submoduleWorktreeSha(repoRoot, 'src') || gitMod.submoduleSha(repoRoot, 'src');
  const opKey = operationKey(config, targetSha);
  const streamId = syncStreamId(config);
  const kSha = stateMod.knowledgeSha(repoRoot);

  ui.table([
    ['tracking branch', `origin/${branch}`],
    ['current src', stateMod.short(originalSha)],
    ['target', stateMod.short(targetSha)],
    ['wiki describes', stateMod.short(kSha)],
    ['operationKey', opKey],
    ['syncStreamId', streamId],
  ]);

  if (targetSha === originalSha && targetSha === kSha && !flags.force) {
    ui.ok('already in sync; nothing to do.');
    if (flags.json) ui.json({ ok: true, noop: true, targetSha, opKey, streamId });
    return EXIT.OK;
  }

  // ---- 2. compute the change set before touching anything -----------------
  const oldRecords = inventory.readInventory(repoRoot);
  const newRecords = inventory.scanPackage(repoRoot, config, { ref: targetSha }) || [];
  const diff = inventory.diffInventory(oldRecords, newRecords);
  ui.out('');
  ui.info(`change set: +${diff.added.length} ~${diff.modified.length} -${diff.removed.length} →${diff.renamed.length} (=${diff.unchanged.length})`);
  if (!diff.needsGeneration && diff.renamed.length > 0) {
    ui.dim('    renames only — no LLM calls required.');
  }

  const handEdits = inventory.detectHandEdits(repoRoot, oldRecords);
  if (handEdits.length > 0) {
    ui.warn(`${handEdits.length} Wiki page(s) were edited by hand; regeneration would overwrite them:`);
    for (const h of handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
    if (!flags.force) {
      ui.dim('    Re-run with --force to proceed, or move those edits into the generator.');
    }
  }

  if (flags['dry-run']) {
    if (flags.json) {
      ui.json({ ok: true, dryRun: true, targetSha, originalSha, opKey, streamId,
        diff: { added: diff.added.length, modified: diff.modified.length, removed: diff.removed.length,
          renamed: diff.renamed.length, unchanged: diff.unchanged.length }, handEdits });
    } else ui.ok('dry run complete; nothing was written.');
    return EXIT.OK;
  }

  // ---- 3. acquire the lease BEFORE the bump -------------------------------
  let lease;
  if (existingLease && (flags.resume || flags.force)) {
    // The tracking branch may have moved since the lease was taken. Adopting
    // it blindly would bump src/ to the *new* tip while the lease still records
    // the old one, so --abort would restore the wrong commit.
    if (existingLease.targetSha && existingLease.targetSha !== targetSha) {
      if (!flags.force) {
        throw new AidevError(
          `the held lease targets ${stateMod.short(existingLease.targetSha)} but origin/${branch} is now ` +
          `${stateMod.short(targetSha)}. Finish the in-flight sync with ` +
          `"aidev sync --resume --to ${existingLease.targetSha}", or release it with "aidev sync --abort" ` +
          'and start again from the new tip.');
      }
      // --force: retarget, but keep originalSha so --abort still unwinds to the
      // commit that was checked out before any bump happened.
      ui.warn(`retargeting the held lease ${stateMod.short(existingLease.targetSha)} → ${stateMod.short(targetSha)} (--force)`);
      lease = leases.acquireSyncLease(repoRoot, {
        targetSha,
        originalSha: existingLease.originalSha || originalSha,
        ttlMinutes: config.sync.lease_ttl_minutes,
        force: true,
      });
    } else {
      lease = existingLease;
      ui.ok(`continuing the existing lease (target ${stateMod.short(lease.targetSha)})`);
    }
  } else {
    lease = leases.acquireSyncLease(repoRoot, {
      targetSha, originalSha, ttlMinutes: config.sync.lease_ttl_minutes,
    });
    ui.ok(`acquired sync lease (ttl ${lease.ttlMinutes}m)`);
  }

  try {
    // ---- 4. bump the submodule -------------------------------------------
    const co = gitMod.run(['checkout', '--detach', targetSha], { cwd: subDir });
    if (!co.ok) throw new AidevError(`failed to check out ${stateMod.short(targetSha)} in src/: ${co.stderr}`);
    ui.ok(`src bumped to ${stateMod.short(targetSha)}`);

    // ---- 5 & 6. record the new inventory ---------------------------------
    // Prose regeneration is the knowledge-builder agent's job; the CLI owns the
    // structured half — inventory, manifest and the checkpoint it resumes from.
    const carried = new Map();
    for (const r of [...diff.unchanged, ...diff.renamed]) {
      carried.set(r.path, { pages: r.pages || [], selfHashes: r.selfHashes || {} });
    }
    const records = newRecords.map((r) => ({
      ...r,
      pages: carried.get(r.path)?.pages || [],
      selfHashes: carried.get(r.path)?.selfHashes || {},
    }));

    const shards = inventory.writeInventory(repoRoot, records, config.knowledge.inventory_shard_size);

    // Scenario 7: a source file that no longer exists must not leave its page
    // behind. A stale page is worse than a missing one — it reads as current
    // and describes code that is gone.
    let orphans = { deleted: [], skipped: [], staleIndexes: [] };
    if (diff.removed.length > 0) {
      const pages = inventory.orphanedPages(diff.removed, records);
      orphans = inventory.removeOrphanedPages(repoRoot, pages);
      if (orphans.deleted.length > 0) {
        ui.ok(`removed ${orphans.deleted.length} orphaned Wiki page(s)`);
        for (const p of orphans.deleted.slice(0, 10)) ui.dim(`    - ${p}`);
        if (orphans.deleted.length > 10) ui.dim(`    …and ${orphans.deleted.length - 10} more`);
      }
      for (const s of orphans.skipped) ui.warn(`kept ${s.page}: ${s.reason}`);
    }

    const manifest = inventory.readManifest(repoRoot) || inventory.emptyManifest();
    manifest.schemaVersion = inventory.SCHEMA_VERSION;
    manifest.knowledgeSha = targetSha;
    manifest.kitCommit = gitMod.headSha(repoRoot);
    manifest.generatedAt = new Date().toISOString();
    manifest.inventoryShards = shards;
    manifest.stats = {
      files: records.length,
      pages: new Set(records.flatMap((r) => Object.keys(r.selfHashes || {}))).size,
      maskedFiles: records.filter((r) => r.masked).length,
    };
    // Pages the builder still owes; `aidev knowledge build --refresh` drains it.
    manifest.checkpoint = {
      completedShards: shards.length,
      pendingPaths: [...diff.added, ...diff.modified].map((r) => r.path),
      // An index that listed a now-deleted page still links to it, so the
      // parents of every removed page owe a rewrite too.
      staleIndexes: orphans.staleIndexes,
    };
    inventory.writeManifest(repoRoot, manifest);
    ui.ok(`inventory rewritten (${records.length} files, ${shards.length} shard(s))`);

    if (manifest.checkpoint.pendingPaths.length > 0) {
      ui.warn(`${manifest.checkpoint.pendingPaths.length} page(s) still need prose regeneration — run "aidev knowledge build --refresh".`);
    }
    if (orphans.staleIndexes.length > 0) {
      ui.warn(`${orphans.staleIndexes.length} parent index(es) still link to removed pages — the same refresh rewrites them.`);
    }

    // ---- 7. verify -------------------------------------------------------
    const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
    if (st.severity === stateMod.SEVERITY.ERROR) {
      throw new KnowledgeError(`post-sync verification failed: ${st.message}`);
    }
    const drift = assets.detectDrift(repoRoot);
    if (!drift.noLock && !drift.ok) {
      ui.warn('kit-owned static files differ from .aidev-lock; the wrapper PR will fail CI until resolved.');
    }
    ui.ok('three SHAs agree locally');

    // ---- 8. release, then prepare the wrapper PR -------------------------
    leases.releaseSyncLease(repoRoot);
    ui.ok('sync lease released');

    // Prose generation runs here: after the lease is gone (so it cannot block a
    // concurrent sync for the minutes an agent takes) but before the PR, so the
    // generated pages land in the same commit the reviewer reads. The manifest
    // already records targetSha, so the three SHAs agree and ordinary policy
    // permits the agent's knowledge/** writes without a lease.
    const pendingPaths = manifest.checkpoint.pendingPaths || [];
    let agentResult = { ran: false };
    if (pendingPaths.length > 0) {
      agentResult = await agentMod.runWikiAgent({
        repoRoot, config, flags, targetSha, paths: pendingPaths, human: !flags.json,
      });
    }
    // Re-read: the agent clears the paths it actually finished, so a partial
    // run must still show the remainder rather than the list we handed it.
    const afterManifest = inventory.readManifest(repoRoot);
    const pending = afterManifest?.checkpoint?.pendingPaths?.length ?? pendingPaths.length;

    const prBranch = syncBranchName(config, targetSha);
    const diffCounts = {
      added: diff.added.length, modified: diff.modified.length,
      removed: diff.removed.length, renamed: diff.renamed.length,
    };
    let pr = { attempted: false };

    if (flags['no-pr']) {
      ui.info(`--no-pr: changes are in the working tree only. Branch would have been ${prBranch}.`);
      pr = { attempted: false, reason: '--no-pr' };
    } else if (!config.sync.auto_pr) {
      ui.info(`sync.auto_pr is false, so no wrapper PR was opened. Branch would have been ${prBranch}.`);
      pr = { attempted: false, reason: 'sync.auto_pr is false' };
    } else {
      // Creating the PR needs the Azure DevOps API; without a PAT we stop at
      // the working tree rather than pretending it succeeded.
      const authEnv = config.azure_devops.auth_env;
      if (!process.env[authEnv]) {
        ui.warn(`${authEnv} is not set, so no wrapper PR was created.`);
        ui.dim(`    Commit and push ${prBranch} yourself, or set ${authEnv} and re-run.`);
        pr = { attempted: false, reason: `${authEnv} is not set` };
      } else {
        ui.out('');
        ui.info(`wrapper PR: branch ${prBranch}, stream ${streamId}, operation ${opKey}`);

        const pushed = commitAndPush(repoRoot, prBranch, targetSha, 'origin');
        if (!pushed.pushed) {
          ui.warn(`the sync branch was not pushed: ${pushed.reason}`);
          ui.dim('    The regenerated Wiki and the bump are still in the working tree.');
          pr = { attempted: false, reason: pushed.reason, committed: !!pushed.committed };
        } else {
          ui.ok(`pushed ${prBranch}`);
          try {
            const res = await openWrapperPr(config, {
              prBranch, streamId, opKey, targetSha, diff: diffCounts, pending,
            });
            if (!res.ok) {
              ui.warn(`no wrapper PR was opened: ${res.reason}`);
            } else if (res.created) {
              ui.ok(`opened wrapper PR${res.pullRequestId ? ` !${res.pullRequestId}` : ''}`);
            } else if (res.updated) {
              ui.ok(`updated the existing wrapper PR !${res.pullRequestId} for this stream`);
            }
            if (res.superseded) {
              ui.warn(`the earlier PR !${res.superseded.pullRequestId} for this stream targets an older SHA;`);
              ui.dim('    it was annotated as superseded. Closing it is a human decision.');
            }
            if (res.supersedeWarning) ui.warn(res.supersedeWarning);
            pr = { attempted: true, ...res };
          } catch (e) {
            // The sync itself succeeded and is pushed; failing the whole command
            // now would hide that and invite a destructive re-run.
            ui.fail(`the wrapper PR could not be created: ${e.message}`);
            ui.dim(`    ${prBranch} is pushed — open the PR by hand, or re-run once the cause is fixed.`);
            pr = { attempted: true, ok: false, reason: e.message };
          }
        }
      }
      ui.dim('    Merging is always a human decision.');
    }

    if (flags.json) {
      ui.json({ ok: true, targetSha, originalSha, opKey, streamId, branch: prBranch,
        pendingPages: pending, shards: shards.length, diff: diffCounts, pr, agent: agentResult });
    }
    // The sync itself succeeded — src/ is bumped, the Wiki is consistent and the
    // PR is open. A failed agent only means prose is still owed, so it is
    // reported through the exit code without unwinding any of that.
    return agentResult.ran && !agentResult.ok ? EXIT.GENERAL : EXIT.OK;
  } catch (e) {
    // Leave the lease in place: the repository is mid-bump, and an operator
    // must choose --resume or --abort. Silently releasing would strand writes.
    ui.fail(`sync failed: ${e.message}`);
    ui.dim('    The sync lease was intentionally kept so the half-applied state is not hidden.');
    ui.dim('    Run "aidev sync --resume" to continue, or "aidev sync --abort" to restore src/.');
    throw e;
  }
}

function abort(repoRoot, flags) {
  const lease = leases.readSyncLease(repoRoot);
  if (!lease) { ui.warn('no sync lease to abort.'); return EXIT.OK; }
  const subDir = path.join(repoRoot, 'src');
  if (lease.originalSha && gitMod.commitExists(subDir, lease.originalSha)) {
    const co = gitMod.run(['checkout', '--detach', lease.originalSha], { cwd: subDir });
    if (co.ok) ui.ok(`src restored to ${stateMod.short(lease.originalSha)}`);
    else ui.fail(`could not restore src/: ${co.stderr}`);
  } else {
    ui.warn('the lease records no reachable original SHA; src/ was left as it is.');
  }
  leases.releaseSyncLease(repoRoot);
  ui.ok('sync lease released');
  if (flags.json) ui.json({ ok: true, aborted: true, restoredTo: lease.originalSha || null });
  return EXIT.OK;
}

module.exports = { run, FLAGS, operationKey, syncStreamId, syncBranchName, summary: 'PKG追跡ブランチの前進に追従' };
