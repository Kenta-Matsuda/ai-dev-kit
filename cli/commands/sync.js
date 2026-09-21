'use strict';
/**
 * `aidev sync` — follow the PKG tracking branch forward.
 *
 * One event is handled: "origin/<tracking_branch> now points at a commit the
 * Wiki does not describe". Whether that came from an AI-made PR or from someone
 * editing the PKG directly is deliberately indistinguishable here.
 *
 * The developer's own checkout is never touched. Sync works in a temporary git
 * worktree checked out at the target commit (.aidev/cache/sync-worktree/):
 *
 *   lease → worktree at target → diff → rewrite inventory → (agent) → commit on
 *   aidev/wiki-<sha> → push → PR → remove worktree → release
 *
 * The committed Wiki reaches everyone through the usual PR and `git pull`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EXIT, AidevError, KnowledgeError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const layout = require('../lib/layout');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const leases = require('../lib/leases');
const inventory = require('../lib/inventory');
const knowledgeScope = require('../lib/knowledge-scope');
const ado = require('../lib/ado');
const agentMod = require('../lib/agent');
const ui = require('../lib/ui');

const FLAGS = {
  to: 'string', 'dry-run': 'boolean', 'no-pr': 'boolean', resume: 'boolean',
  abort: 'boolean', 'check-only': 'boolean', json: 'boolean', force: 'boolean',
  ...agentMod.AGENT_FLAGS,
};

const FLAG_HELP = {
  to: 'sync to this commit (must be reachable from the fetched tracking branch) instead of its tip',
  'dry-run': 'fetch and show what would change; write nothing',
  'no-pr': 'commit on the local aidev/wiki-<sha> branch but do not push or open a PR',
  resume: 'continue a sync that stopped and left its lease behind',
  abort: 'discard a stopped sync: remove its worktree and release the lease',
  'check-only': 'only report whether the tracking branch moved',
  json: 'machine-readable output',
  force: 'take over a stale lease or overwrite hand-edited Wiki pages',
  ...agentMod.AGENT_FLAG_HELP,
};

const WORKTREE_REL = '.aidev/cache/sync-worktree';

function operationKey(config, targetSha) {
  const h = config.hosting;
  return crypto.createHash('sha256')
    .update([h.type, h.organization || '', h.project || '', h.repository || '', targetSha].join('\0'))
    .digest('hex').slice(0, 32);
}

function syncStreamId(config) {
  const h = config.hosting;
  return crypto.createHash('sha256')
    .update([h.type, h.organization || '', h.project || '', h.repository || '', config.sync.tracking_branch].join('\0'))
    .digest('hex').slice(0, 32);
}

function syncBranchName(config, targetSha) {
  return `aidev/wiki-${String(targetSha).slice(0, 12)}`;
}

const STREAM_MARKER = '<!-- aidev:sync-stream ';
function streamMarker(streamId) { return `${STREAM_MARKER}${streamId} -->`; }

function prDescription({ streamId, opKey, targetSha, branch, diff, pending }) {
  return [
    streamMarker(streamId),
    '',
    `Updates the LLM Wiki (\`${layout.KNOWLEDGE_REL}/\`) for \`${branch}\` at \`${targetSha}\`.`,
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
      ? `> ⚠️ ${pending} Wiki generation target(s) still need prose regeneration (\`aidev knowledge build\`).`
      : '> The Wiki is regenerated and describes the target commit.',
    '',
    '**Merging is a human decision — this PR is never auto-completed.**',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
}

/** Commit the Wiki in the worktree onto the sync branch; optionally push. */
function commitAndPush(worktree, prBranch, targetSha, { push }) {
  const co = gitMod.run(['checkout', '-B', prBranch], { cwd: worktree });
  if (!co.ok) return { committed: false, pushed: false, reason: `could not create branch ${prBranch}: ${co.stderr}` };
  gitMod.run(['add', '-A', '--', layout.KNOWLEDGE_REL, layout.AIDEV_GITIGNORE_REL], { cwd: worktree });
  const staged = gitMod.run(['diff', '--cached', '--quiet'], { cwd: worktree });
  if (staged.ok) return { committed: false, pushed: false, reason: 'the Wiki already matches the target; nothing to commit' };
  const message = [
    `docs(wiki): describe ${String(targetSha).slice(0, 12)}`,
    '',
    `Regenerates ${layout.KNOWLEDGE_REL}/ for the tracking branch.`,
    '',
    'Co-Authored-By: Claude Code <noreply@anthropic.com>',
  ].join('\n');
  const commit = gitMod.run(['commit', '-m', message], { cwd: worktree });
  if (!commit.ok) return { committed: false, pushed: false, reason: `commit failed: ${commit.stderr}` };
  if (!push) return { committed: true, pushed: false, branch: prBranch };
  const pushed = gitMod.run(['push', '--force-with-lease', '--set-upstream', 'origin', prBranch], { cwd: worktree });
  if (!pushed.ok) return { committed: true, pushed: false, branch: prBranch, reason: `push failed: ${pushed.stderr}` };
  return { committed: true, pushed: true, branch: prBranch };
}

async function openPr(config, { prBranch, streamId, opKey, targetSha, diff, pending }) {
  if (config.hosting.type !== 'azure-devops') {
    return { ok: false, reason: `hosting.type is ${config.hosting.type}; open the pull request for ${prBranch} by hand` };
  }
  const repo = config.hosting.repository;
  const targetBranch = config.sync.pr.target_branch;
  const description = prDescription({ streamId, opKey, targetSha, branch: config.sync.tracking_branch, diff, pending });
  const open = await ado.listPullRequests(config, repo, { status: 'active', targetBranch });
  const mine = open.find((pr) => String(pr.description || '').includes(streamMarker(streamId)));
  if (mine && String(mine.sourceRefName || '').endsWith(`/${prBranch}`)) {
    await ado.updatePullRequestDescription(config, repo, mine.pullRequestId, description);
    return { ok: true, updated: true, pullRequestId: mine.pullRequestId, url: mine.url };
  }
  const created = await ado.createPullRequest(config, repo, {
    sourceBranch: prBranch, targetBranch,
    title: `docs(wiki): describe ${String(targetSha).slice(0, 12)}`,
    description, reviewers: config.sync.pr.reviewers,
  });
  const result = { ok: true, created: true, pullRequestId: created?.pullRequestId || null, url: created?.url || null };
  if (mine) {
    try {
      await ado.updatePullRequestDescription(config, repo, mine.pullRequestId,
        `${String(mine.description || '')}\n\n> ⚠️ Superseded by \`${prBranch}\`${result.pullRequestId ? ` (PR !${result.pullRequestId})` : ''}. Close this one after review.`);
      result.superseded = { pullRequestId: mine.pullRequestId, branch: mine.sourceRefName };
    } catch (e) {
      result.supersedeWarning = `the previous PR !${mine.pullRequestId} could not be annotated: ${e.message}`;
    }
  }
  return result;
}

function worktreePath(repoRoot) { return layout.abs(repoRoot, WORKTREE_REL); }

/** Ensure a worktree at `targetSha`, reusing one left by an interrupted sync. */
function ensureWorktree(repoRoot, targetSha) {
  const dir = worktreePath(repoRoot);
  if (fs.existsSync(dir)) {
    if (gitMod.headSha(dir) === targetSha) return { dir, reused: true };
    gitMod.worktreeRemove(repoRoot, dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const added = gitMod.worktreeAdd(repoRoot, dir, targetSha);
  if (!added.ok) throw new AidevError(`could not create a worktree for ${stateMod.short(targetSha)}: ${added.stderr}`);
  return { dir, reused: false };
}

function removeWorktree(repoRoot) {
  const dir = worktreePath(repoRoot);
  if (!fs.existsSync(dir)) return;
  gitMod.worktreeRemove(repoRoot, dir);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function run(ctx) {
  const { repoRoot, flags } = ctx;
  const config = cfgMod.loadConfig(repoRoot);
  const branch = config.sync.tracking_branch;
  const human = !flags.json;
  if (!gitMod.isRepo(repoRoot)) throw new AidevError(`${repoRoot} is not a git repository`);

  if (flags.abort) return abort(repoRoot, flags);

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
      'Continue it with "aidev sync --resume" or discard it with "aidev sync --abort".');
  }
  if (flags.resume && !existingLease) ui.warn('no sync lease found; --resume has nothing to continue. Proceeding as a fresh sync.');

  if (human) ui.heading(`aidev sync${flags['dry-run'] ? ' (dry run)' : ''}${flags.resume ? ' (resume)' : ''}`);

  // ---- 1. resolve targetSha from the tracking branch --------------------------
  const fetched = gitMod.fetch(repoRoot, 'origin', branch);
  if (!fetched.ok) throw new AidevError(`could not fetch origin/${branch}: ${fetched.stderr}`);
  const tip = gitMod.revParse(repoRoot, `origin/${branch}`);
  if (!tip) throw new AidevError(`could not resolve origin/${branch}`);

  let targetSha = tip;
  if (flags.to) {
    const wanted = gitMod.revParse(repoRoot, flags.to);
    if (!wanted) throw new AidevError(`--to ${flags.to} is not a commit in this repository`);
    if (!gitMod.isAncestor(repoRoot, wanted, tip)) {
      throw new AidevError(`--to ${stateMod.short(wanted)} is not reachable from origin/${branch}; sync follows the tracking branch only.`);
    }
    targetSha = wanted;
  }
  if (existingLease && flags.resume && existingLease.targetSha && existingLease.targetSha !== targetSha && !flags.force) {
    throw new AidevError(
      `the held lease targets ${stateMod.short(existingLease.targetSha)} but origin/${branch} is now ${stateMod.short(targetSha)}. ` +
      `Finish it with "aidev sync --resume --to ${existingLease.targetSha}", or "aidev sync --abort" and start again.`);
  }

  const kSha = stateMod.knowledgeSha(repoRoot);
  const opKey = operationKey(config, targetSha);
  const streamId = syncStreamId(config);
  const prBranch = syncBranchName(config, targetSha);

  if (human) {
    ui.table([
      ['tracking branch', `origin/${branch}`],
      ['target', stateMod.short(targetSha)],
      ['wiki describes', stateMod.short(kSha)],
      ['sync branch', prBranch],
    ]);
  }

  // The committed Wiki at the target already describes its source: nothing to do.
  const targetManifest = readManifestAt(repoRoot, targetSha);
  const targetK = targetManifest?.knowledgeSha;
  if (!flags.force && gitMod.isSha(targetK) && gitMod.commitExists(repoRoot, targetK)
    && !stateMod.sourceChanged(repoRoot, targetK, targetSha)) {
    if (human) ui.ok(`the Wiki committed on origin/${branch} already describes ${stateMod.short(targetSha)}; "git pull" to receive it.`);
    if (flags.json) ui.json({ ok: true, noop: true, targetSha, opKey, streamId });
    return EXIT.OK;
  }
  if (!flags.force && gitMod.isSha(kSha) && gitMod.commitExists(repoRoot, kSha) && !stateMod.sourceChanged(repoRoot, kSha, targetSha)) {
    if (human) ui.ok('already in sync; nothing to do.');
    if (flags.json) ui.json({ ok: true, noop: true, targetSha, opKey, streamId });
    return EXIT.OK;
  }

  // ---- 2. change set (dry run uses the local Wiki as the "before") ---------------
  const preview = computeChangeSet(repoRoot, repoRoot, config, targetSha);
  if (human) {
    ui.out('');
    ui.info(`generation target changes: +${preview.diff.added.length} ~${preview.diff.modified.length} -${preview.diff.removed.length} →${preview.diff.renamed.length} (=${preview.diff.unchanged.length})`);
    ui.info(`repository evidence: ${preview.evidenceState.trackedFiles} tracked files`);
    if (preview.supportingEvidenceChanged) ui.dim('    supporting code/config/test/CI changed (or has no prior fingerprint); all generation targets are queued.');
  }
  if (flags['dry-run']) {
    if (flags.json) {
      ui.json({ ok: true, dryRun: true, targetSha, opKey, streamId, branch: prBranch,
        diff: counts(preview.diff), generationPaths: preview.generationPaths, evidence: preview.evidenceState });
    } else ui.ok('dry run complete; nothing was written.');
    return EXIT.OK;
  }

  // ---- 3. lease, worktree ----------------------------------------------------------
  let lease;
  if (existingLease && (flags.resume || flags.force)) {
    lease = existingLease.targetSha === targetSha ? existingLease
      : leases.acquireSyncLease(repoRoot, { targetSha, originalSha: kSha, ttlMinutes: config.sync.lease_ttl_minutes, force: true });
    if (human) ui.ok(`continuing the existing lease (target ${stateMod.short(lease.targetSha)})`);
  } else {
    lease = leases.acquireSyncLease(repoRoot, { targetSha, originalSha: kSha, ttlMinutes: config.sync.lease_ttl_minutes });
    if (human) ui.ok(`acquired sync lease (ttl ${lease.ttlMinutes}m)`);
  }

  try {
    const { dir: work, reused } = ensureWorktree(repoRoot, targetSha);
    if (human) ui.ok(`${reused ? 'reusing' : 'created'} worktree at ${WORKTREE_REL} (${stateMod.short(targetSha)})`);

    // The "before" is what is committed at the target, which is what the PR diffs against.
    const change = computeChangeSet(work, repoRoot, config, targetSha);
    const { diff, newRecords, evidenceRecords, evidenceState, generationPaths, previousManifest } = change;

    const handEdits = inventory.detectHandEdits(work, change.oldRecords);
    if (handEdits.length > 0) {
      if (human) {
        ui.warn(`${handEdits.length} Wiki page(s) were edited by hand; regeneration would overwrite them:`);
        for (const h of handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
      }
      if (!flags.force) throw new AidevError('hand-edited Wiki pages would be overwritten; re-run with --force or move the edits into the generator.');
    }

    // ---- 4. structured state in the worktree ------------------------------------
    const carried = new Map();
    for (const r of [...diff.unchanged, ...diff.renamed]) carried.set(r.path, { pages: r.pages || [], selfHashes: r.selfHashes || {} });
    const records = newRecords.map((r) => ({ ...r, pages: carried.get(r.path)?.pages || [], selfHashes: carried.get(r.path)?.selfHashes || {} }));
    const shards = inventory.writeInventory(work, records, config.knowledge.inventory_shard_size);

    let orphans = { deleted: [], skipped: [], staleIndexes: [] };
    if (diff.removed.length > 0) {
      orphans = inventory.removeOrphanedPages(work, inventory.orphanedPages(diff.removed, records));
      if (human && orphans.deleted.length > 0) ui.ok(`removed ${orphans.deleted.length} orphaned Wiki page(s)`);
    }

    const manifest = previousManifest || inventory.emptyManifest();
    manifest.schemaVersion = inventory.SCHEMA_VERSION;
    manifest.knowledgeSha = targetSha;
    manifest.kitCommit = gitMod.headSha(ctx.installRoot);
    manifest.generatedAt = new Date().toISOString();
    manifest.inventoryShards = shards;
    manifest.stats = {
      files: records.length,
      pages: new Set(records.flatMap((r) => Object.keys(r.selfHashes || {}))).size,
      maskedFiles: records.filter((r) => r.masked).length,
      evidenceFiles: evidenceState.trackedFiles,
    };
    manifest.evidence = evidenceState;
    manifest.checkpoint = { pendingPaths: generationPaths, staleIndexes: orphans.staleIndexes };
    inventory.writeManifest(work, manifest);
    layout.ensureAidevGitignore(work);
    if (human) ui.ok(`inventory rewritten (${records.length} targets, ${shards.length} shard(s))`);

    const st = stateMod.computeState(work, config, { checkRemote: false });
    if (st.severity === stateMod.SEVERITY.ERROR) throw new KnowledgeError(`post-sync verification failed: ${st.message}`);

    // ---- 5. prose (in the worktree) ----------------------------------------------
    const pendingPaths = manifest.checkpoint.pendingPaths;
    let agentResult = { ran: false };
    if (pendingPaths.length > 0) {
      agentResult = await agentMod.runWikiAgent({
        repoRoot: work, config, flags, targetSha, paths: pendingPaths,
        evidence: { paths: evidenceRecords.map((r) => r.path), include: evidenceState.include, exclude: evidenceState.exclude, secretsPaths: config.secrets_paths },
        human, fullRebuild: pendingPaths.length === newRecords.length,
      });
    }
    let after = null;
    let afterReadError = null;
    try { after = inventory.readManifest(work); } catch (e) { afterReadError = e; }
    agentResult = agentMod.assessWikiProgress(agentResult, pendingPaths, after?.checkpoint?.pendingPaths, {
      expectedTargetSha: targetSha, actualTargetSha: afterReadError ? targetSha : after?.knowledgeSha, actualSourceSha: gitMod.headSha(work),
    });
    if (afterReadError) agentResult = { ...agentResult, reason: `Wiki manifest could not be read after Claude exited: ${afterReadError.message}` };
    let structuredOk = true;
    if (agentResult.checkpointInvalid) {
      if (!after || after.knowledgeSha === targetSha) {
        manifest.checkpoint = { ...manifest.checkpoint, pendingPaths: [...pendingPaths] };
        inventory.writeManifest(work, manifest);
        after = manifest;
        agentResult = { ...agentResult, checkpointRestored: true };
      } else structuredOk = false;
    }
    const pending = Array.isArray(after?.checkpoint?.pendingPaths) ? after.checkpoint.pendingPaths.length : pendingPaths.length;
    agentMod.renderWikiProgress(agentResult, { human, resumeCommand: 'aidev sync --resume' });
    if (human && pending > 0 && !agentResult.ran) {
      ui.warn(`${pending} generation target(s) still need prose; the pull request will say so.`);
      ui.dim(flags['no-agent']
        ? '    Re-run without --no-agent to write it before opening the PR, or run "aidev knowledge build" after the merge.'
        : '    Make the agent tool available and run "aidev sync --resume", or run "aidev knowledge build" after the merge.');
    }

    // ---- 6. commit, push, PR --------------------------------------------------------
    let pr = { attempted: false };
    let publish = { committed: false, pushed: false };
    if (agentResult.checkpointInvalid) {
      pr = { attempted: false, blocked: true, reason: agentResult.reason };
      if (human) ui.fail('publication skipped: the post-agent checkpoint is invalid. Resolve it and run "aidev sync --resume".');
    } else {
      publish = commitAndPush(work, prBranch, targetSha, { push: !flags['no-pr'] });
      if (!publish.committed) {
        if (human) ui.info(publish.reason);
      } else if (flags['no-pr']) {
        if (human) ui.ok(`committed on local branch ${prBranch} (--no-pr: not pushed). Push it and open a PR when ready.`);
        pr = { attempted: false, reason: '--no-pr', branch: prBranch };
      } else if (!publish.pushed) {
        if (human) ui.warn(`committed on ${prBranch} but not pushed: ${publish.reason}`);
        pr = { attempted: false, reason: publish.reason, branch: prBranch };
      } else {
        if (human) ui.ok(`pushed ${prBranch}`);
        if (!config.sync.auto_pr) {
          pr = { attempted: false, reason: 'sync.auto_pr is false', branch: prBranch };
          if (human) ui.info('sync.auto_pr is false; open the pull request by hand.');
        } else if (config.hosting.type === 'azure-devops' && !process.env[config.hosting.auth_env]) {
          pr = { attempted: false, reason: `${config.hosting.auth_env} is not set`, branch: prBranch };
          if (human) ui.warn(`${config.hosting.auth_env} is not set; open the pull request for ${prBranch} by hand.`);
        } else {
          try {
            const res = await openPr(config, { prBranch, streamId, opKey, targetSha, diff: counts(diff), pending });
            pr = { attempted: true, ...res };
            if (human) {
              if (!res.ok) ui.info(res.reason);
              else if (res.created) ui.ok(`opened pull request${res.pullRequestId ? ` !${res.pullRequestId}` : ''}${res.url ? ` ${res.url}` : ''}`);
              else if (res.updated) ui.ok(`updated the existing pull request !${res.pullRequestId}`);
              if (res.superseded) ui.warn(`the earlier PR !${res.superseded.pullRequestId} was annotated as superseded; closing it is a human decision.`);
              if (res.supersedeWarning) ui.warn(res.supersedeWarning);
            }
          } catch (e) {
            pr = { attempted: true, ok: false, reason: e.message, branch: prBranch };
            if (human) ui.fail(`the pull request could not be created: ${e.message}. ${prBranch} is pushed; open it by hand.`);
          }
        }
        if (human) ui.dim('    Merging is always a human decision. After the merge, "git pull" brings the Wiki to every clone.');
      }
    }

    // ---- 7. clean up ----------------------------------------------------------------
    removeWorktree(repoRoot);
    leases.releaseSyncLease(repoRoot);
    if (human) ui.ok('sync lease released');

    const commandOk = structuredOk && !(agentResult.ran && !agentResult.ok);
    if (flags.json) {
      ui.json({ ok: commandOk, structuredOk, targetSha, opKey, streamId, branch: prBranch,
        committed: publish.committed, pushed: publish.pushed, pendingPages: pending, diff: counts(diff), pr, agent: agentResult });
    }
    return commandOk ? EXIT.OK : EXIT.GENERAL;
  } catch (e) {
    ui.fail(`sync failed: ${e.message}`);
    ui.dim('    The sync lease and worktree were kept so the half-finished state is not hidden.');
    ui.dim('    Run "aidev sync --resume" to continue, or "aidev sync --abort" to discard it.');
    throw e;
  }
}

/** The manifest committed at a commit, or null. */
function readManifestAt(repoRoot, sha) {
  const shown = gitMod.run(['show', `${sha}:${layout.KNOWLEDGE_REL}/manifest.json`], { cwd: repoRoot });
  if (!shown.ok) return null;
  try { return JSON.parse(shown.stdout); } catch { return null; }
}

/**
 * Diff the Wiki found in `wikiRoot` against the PKG tree at `targetSha`
 * (scanned from `scanRoot`, which holds the fetched objects).
 */
function computeChangeSet(wikiRoot, scanRoot, config, targetSha) {
  let previousManifest = inventory.readManifest(wikiRoot);
  if (previousManifest) {
    const leftover = inventory.applyCompletions(wikiRoot, { targetSha: previousManifest.knowledgeSha, shardSize: config.knowledge.inventory_shard_size });
    if (leftover.applied.length > 0) previousManifest = inventory.readManifest(wikiRoot);
  }
  const oldRecords = inventory.readInventory(wikiRoot, previousManifest);
  const newRecords = inventory.scanPackage(scanRoot, config, { ref: targetSha }) || [];
  const evidenceRecords = knowledgeScope.scanEvidence(scanRoot, config, { ref: targetSha }) || [];
  const evidenceState = knowledgeScope.buildEvidenceSnapshot(evidenceRecords, newRecords, config);
  const supportingEvidenceChanged = knowledgeScope.evidenceChanged(previousManifest?.evidence, evidenceState);
  const diff = inventory.diffInventory(oldRecords, newRecords);
  const currentTargets = new Set(newRecords.map((r) => r.path));
  const generationSet = new Set([...diff.added, ...diff.modified].map((r) => r.path));
  for (const p of previousManifest?.checkpoint?.pendingPaths || []) if (currentTargets.has(p)) generationSet.add(p);
  if (supportingEvidenceChanged) for (const r of newRecords) generationSet.add(r.path);
  return {
    previousManifest, oldRecords, newRecords, evidenceRecords, evidenceState,
    supportingEvidenceChanged, diff, generationPaths: [...generationSet].sort(),
  };
}

function counts(diff) {
  return { added: diff.added.length, modified: diff.modified.length, removed: diff.removed.length, renamed: diff.renamed.length };
}

function abort(repoRoot, flags) {
  const lease = leases.readSyncLease(repoRoot);
  removeWorktree(repoRoot);
  if (!lease) { ui.warn('no sync lease to abort.'); return EXIT.OK; }
  leases.releaseSyncLease(repoRoot);
  ui.ok('sync lease released and the worktree removed; your checkout was never touched.');
  if (flags.json) ui.json({ ok: true, aborted: true });
  return EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, operationKey, syncStreamId, syncBranchName, WORKTREE_REL, summary: 'PKGのtracking branchに追従してWikiを更新しPRを作る' };
