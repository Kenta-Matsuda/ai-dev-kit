'use strict';
/**
 * `aidev knowledge build|status`
 *
 * The CLI owns the structured half of the Wiki — the file inventory, the
 * manifest and the resumable checkpoint. Prose generation belongs to the
 * knowledge-builder agent, which reads the plan this command produces and is
 * started right after the structured write (`--no-agent` skips it). Keeping
 * the split here is what lets `build` be re-run safely: scanning, sharding and
 * diffing are deterministic and free, so a resumed run never re-pays for work
 * already done.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const knowledgeScope = require('../lib/knowledge-scope');
const leases = require('../lib/leases');
const pathsMod = require('../lib/paths');
const agentMod = require('../lib/agent');
const ui = require('../lib/ui');

const FLAGS = {
  scope: 'string', full: 'boolean',
  'dry-run': 'boolean', json: 'boolean', force: 'boolean',
  'no-remote': 'boolean',
  ...agentMod.AGENT_FLAGS,
};

const FLAG_HELP = {
  scope: 'only (re)generate targets under this path; research still covers the whole PKG',
  full: 'regenerate every target from scratch instead of only what changed or was left queued',
  'dry-run': 'show what would be queued and written; write nothing',
  json: 'machine-readable output',
  force: 'overwrite Wiki pages that were edited by hand',
  'no-remote': 'status: skip the remote check',
  ...agentMod.AGENT_FLAG_HELP,
};

function status(ctx, config) {
  const { repoRoot, flags } = ctx;
  const st = stateMod.computeState(repoRoot, config, { checkRemote: !flags['no-remote'] });
  const manifest = inventory.readManifest(repoRoot);
  const records = inventory.readInventory(repoRoot, manifest);
  const handEdits = inventory.detectHandEdits(repoRoot, records);
  const problems = inventory.validateInventoryConsistency(records);

  if (flags.json) {
    ui.json({ state: st, manifest, files: records.length, handEdits, problems });
    return st.severity === stateMod.SEVERITY.ERROR ? EXIT.KNOWLEDGE : EXIT.OK;
  }

  ui.heading('aidev knowledge status');
  ui.table([
    ['tracking', stateMod.short(st.trackingSha)],
    ['base', stateMod.short(st.baseSha)],
    ['knowledge', stateMod.short(st.knowledgeSha)],
    ['generatedAt', manifest?.generatedAt || '-'],
    ['generation targets', records.length],
    ['evidence files', manifest?.evidence?.trackedFiles ?? '-'],
    ['shards', manifest?.inventoryShards?.length ?? 0],
    ['masked files', manifest?.stats?.maskedFiles ?? 0],
    ['pending targets', manifest?.checkpoint?.pendingPaths?.length ?? 0],
  ]);
  ui.out('');
  ui.out(stateMod.formatSummary(st));
  if (handEdits.length > 0) {
    ui.warn(`${handEdits.length} page(s) edited by hand since generation:`);
    for (const h of handEdits.slice(0, 20)) ui.dim(`    ${h.page} (${h.reason})`);
  }
  if (problems.length > 0) {
    ui.warn(`${problems.length} inventory inconsistency/ies (a page recorded with differing hashes):`);
    for (const p of problems.slice(0, 10)) ui.dim(`    ${p.page} ← ${p.sources.join(', ')}`);
  }
  return st.severity === stateMod.SEVERITY.ERROR ? EXIT.KNOWLEDGE : EXIT.OK;
}

async function build(ctx, config, { silent = false } = {}) {
  const { repoRoot, flags } = ctx;
  const human = !flags.json; // --json must emit exactly one JSON document
  // With `silent` the JSON document is handed back to the caller (init embeds
  // it in its own report) instead of being printed here.
  let json = null;
  const emitJson = (obj) => { json = obj; if (!silent) ui.json(obj); };
  if (!gitMod.isRepo(repoRoot)) throw new AidevError(`${repoRoot} is not a git repository`);
  // The Wiki describes the tracking-branch commit this work is based on. On a
  // feature branch that is the merge-base; without a fetched tracking branch it
  // is HEAD itself.
  const base = stateMod.resolveBase(repoRoot, config.sync.tracking_branch);
  const targetSha = base.baseSha;
  if (!targetSha) throw new AidevError('could not resolve HEAD — commit something first');

  let existing = inventory.readManifest(repoRoot);

  // A previous run may have been stopped (timeout, Ctrl-C) after the agent
  // reported targets the CLI never got to record. Fold those in first, so they
  // count as done rather than being generated a second time.
  if (existing && !flags['dry-run']) {
    const leftover = inventory.applyCompletions(repoRoot, {
      targetSha: existing.knowledgeSha, shardSize: config.knowledge.inventory_shard_size,
    });
    if (leftover.applied.length > 0) {
      existing = inventory.readManifest(repoRoot);
      if (human) ui.info(`${leftover.applied.length} target(s) finished by an earlier run were recorded.`);
    }
  }

  // Incremental by default: only what changed since the recorded inventory is
  // regenerated, and whatever an earlier run left queued is picked up again.
  // `--full` throws the inventory away and regenerates every target.
  const resuming = !flags.full;
  const existingRecords = inventory.readInventory(repoRoot, existing);
  const oldRecords = resuming ? existingRecords : [];
  const newRecords = inventory.scanPackage(repoRoot, config) || [];
  const evidenceRecords = knowledgeScope.scanEvidence(repoRoot, config) || [];
  const evidenceState = knowledgeScope.buildEvidenceSnapshot(evidenceRecords, newRecords, config);
  const supportingEvidenceChanged = knowledgeScope.evidenceChanged(existing?.evidence, evidenceState);

  // --scope narrows generation only. Repository evidence deliberately remains
  // broad so even a docs-only scoped run can verify claims against source code.
  let scope = null;
  if (flags.scope) {
    scope = pathsMod.normalizeRel(flags.scope);
    if (pathsMod.escapesRoot(scope)) throw new AidevError(`--scope ${flags.scope} escapes the repository root`);
  }
  const inScope = (p) => scope === null || p === scope || p.startsWith(`${scope}/`);
  const scoped = newRecords.filter((r) => inScope(r.path));
  if (scope !== null && scoped.length === 0) {
    throw new AidevError(`--scope ${flags.scope} matched no files in generation targets (package.include)`);
  }

  const diff = inventory.diffInventory(oldRecords, newRecords);
  const currentTargets = new Set(newRecords.map((record) => record.path));
  const generationSet = new Set(
    [...diff.added, ...diff.modified].map((record) => record.path));

  // Whatever an earlier run left queued is still owed. Merge it back instead
  // of losing it merely because its target blob is now recorded as unchanged.
  if (resuming) {
    for (const pendingPath of existing?.checkpoint?.pendingPaths || []) {
      if (currentTargets.has(pendingPath)) generationSet.add(pendingPath);
    }
  }

  // We do not yet store page-level evidence dependencies. If supporting code,
  // tests, config or CI changes, refreshing every generation target is the only
  // safe alternative to silently retaining prose based on stale evidence.
  if (supportingEvidenceChanged) {
    for (const record of newRecords) generationSet.add(record.path);
  }

  const generationPaths = [...generationSet].sort();
  const pending = generationPaths.filter(inScope);
  const deferred = generationPaths.filter((p) => !inScope(p));

  if (human) {
    ui.heading(`aidev knowledge build${flags['dry-run'] ? ' (dry run)' : ''}`);
    ui.table([
      ['target', stateMod.short(targetSha)],
      ['generation targets', `${scoped.length}${scope === null ? '' : ` of ${newRecords.length}`}`],
      ['repository evidence', `${evidenceState.trackedFiles} tracked files`],
      ['supporting evidence', `${evidenceState.supportingFiles} outside generation targets`],
      ['evidence changed', supportingEvidenceChanged ? 'yes — refresh targets' : 'no'],
      ['added', diff.added.length],
      ['modified', diff.modified.length],
      ['removed', diff.removed.length],
      ['renamed (free)', diff.renamed.length],
      ['unchanged', diff.unchanged.length],
      ['masked targets', newRecords.filter((r) => r.masked).length],
      ['queued now', pending.length],
      ...(deferred.length > 0 ? [['deferred (out of scope)', deferred.length]] : []),
    ]);
  }

  // Hand edits are human work. Overwriting them must be an explicit decision,
  // so this halts rather than warning-and-proceeding — with --full as well,
  // which is why the check reads the recorded inventory, not oldRecords.
  const handEdits = inventory.detectHandEdits(repoRoot, existingRecords)
    .filter((h) => h.reason !== 'missing');
  if (handEdits.length > 0 && !flags.force && !flags['dry-run']) {
    const list = handEdits.slice(0, 10).map((h) => `      ${h.page} (${h.reason})`).join('\n');
    throw new AidevError(
      `${handEdits.length} Wiki page(s) were edited by hand and would be overwritten:\n${list}` +
      `${handEdits.length > 10 ? `\n      … and ${handEdits.length - 10} more` : ''}\n` +
      '    Re-run with --force to discard those edits, or move them into the generator.');
  }

  if (flags['dry-run']) {
    if (flags.json) {
      emitJson({
        ok: true,
        dryRun: true,
        targetSha,
        pending,
        deferred,
        evidence: evidenceState,
        evidenceChanged: supportingEvidenceChanged,
        handEdits,
      });
    } else {
      if (handEdits.length > 0) {
        ui.warn(`${handEdits.length} hand-edited page(s) would block this build; --force would discard them:`);
        for (const h of handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
      }
      ui.ok('dry run complete; nothing was written.');
      const opts = agentMod.resolveOptions(flags, config);
      if (opts.enabled && pending.length > 0) {
        const batches = Math.ceil(pending.length / opts.batchSize);
        ui.dim(`    would then run the ${opts.agent} agent with ${agentMod.toolLabel(opts.tool)} for ${pending.length} generation target(s) in ${batches} batch(es).`);
      } else if (!opts.enabled && pending.length > 0) {
        ui.dim(`    --no-agent: ${pending.length} generation target(s) would stay queued without prose.`);
      }
    }
    return { code: EXIT.OK, json };
  }

  // Writing knowledge/** while the Wiki is inconsistent is precisely what the
  // sync lease authorises — and regenerating is what *resolves* that state. So
  // refusing here would make `aidev sync` the only way out even when the code is
  // already at the commit the operator wants described (a rename committed
  // a fresh clone with a Wiki committed later, say). Take the lease for the duration of the
  // write instead: the invariant "knowledge/** is only rewritten under a lease"
  // holds, concurrent syncs are still excluded, and the deadlock is gone.
  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  let ownedLease = false;
  if (st.severity === stateMod.SEVERITY.ERROR && st.hasWiki) {
    const ev = leases.evaluateLease(leases.readSyncLease(repoRoot));
    if (!ev.valid) {
      // A stale lease is NOT adopted silently — acquireSyncLease throws and
      // names --resume/--abort, which is the right outcome here too.
      leases.acquireSyncLease(repoRoot, {
        targetSha,
        originalSha: st.knowledgeSha,
        ttlMinutes: config.sync.lease_ttl_minutes,
        force: !!flags.force,
      });
      ownedLease = true;
    }
  }

  // Carry forward prose that is still valid; only added/modified need an LLM.
  const carried = new Map();
  for (const r of [...diff.unchanged, ...diff.renamed]) {
    carried.set(r.path, { pages: r.pages || [], selfHashes: r.selfHashes || {} });
  }
  const oldByPath = new Map((oldRecords || []).map((r) => [r.path, r]));
  const records = [];
  for (const r of newRecords) {
    if (inScope(r.path)) {
      records.push({
        ...r,
        pages: carried.get(r.path)?.pages || [],
        selfHashes: carried.get(r.path)?.selfHashes || {},
      });
    } else if (oldByPath.has(r.path)) {
      // Untouched by this run: keep the previous blob so a later full build
      // still recognises it as changed.
      records.push(oldByPath.get(r.path));
    }
    // An out-of-scope file with no previous record is deliberately omitted:
    // absent from the inventory, the next build sees it as added.
  }

  let shards;
  let structuredManifest = null;
  try {
    shards = inventory.writeInventory(repoRoot, records, config.knowledge.inventory_shard_size);
    const manifest = existing || inventory.emptyManifest();
    manifest.schemaVersion = inventory.SCHEMA_VERSION;
    // Safe to advance: the inventory now describes targetSha exactly. Pages whose
    // prose is still queued are reported by computeState as a WARN, not by
    // holding this SHA back — sync must be able to finish and release its lease.
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
    manifest.checkpoint = { completedShards: shards.length, pendingPaths: [...pending, ...deferred] };
    structuredManifest = JSON.parse(JSON.stringify(manifest));
    inventory.writeManifest(repoRoot, manifest);

    // The index is the entry point the design requires; create a stub if absent
    // so the directory is never a bare pile of generated pages.
    const indexPath = path.join(repoRoot, ...inventory.INDEX_PAGE.split('/'));
    if (!fs.existsSync(indexPath)) {
      cfgMod.writeFileAtomic(indexPath, [
        `# ${config.package.name} — LLM Wiki`,
        '',
        `Generated for \`${targetSha}\`.`,
        '',
        'This index is maintained by the knowledge-builder agent. Directories are split so',
        `that no single directory holds more than ${config.knowledge.max_files_per_dir} pages.`,
        '',
      ].join('\n'));
    }
  } finally {
    // Only ever release what this command minted. A lease taken by `aidev sync`
    // belongs to that operation and must survive this build, or sync would lose
    // its protection mid-flight.
    if (ownedLease) leases.releaseSyncLease(repoRoot);
  }

  if (human) {
    ui.ok(`manifest and ${shards.length} shard(s) written for ${stateMod.short(targetSha)}`);
    if (pending.length > 0) {
      ui.info(`${pending.length} generation target(s) queued for the knowledge-builder agent:`);
      for (const p of pending.slice(0, 20)) ui.dim(`    ${p}`);
      if (pending.length > 20) ui.dim(`    … and ${pending.length - 20} more`);
      ui.dim(`    The agent can research ${evidenceState.trackedFiles} tracked, non-secret file(s) across the PKG repository.`);
    } else ui.ok('no generation targets in scope need regeneration.');
    if (deferred.length > 0) {
      ui.warn(`${deferred.length} generation target(s) outside --scope were left for a later build.`);
    }
  }

  // The agent runs *after* the lease is released and the manifest has advanced
  // to targetSha. At that point the three SHAs agree and the state is WARN (or
  // OK), so writes to knowledge/** are permitted by ordinary policy — which is
  // exactly why state.js grades pending prose as a warning rather than an
  // error. Running it inside the lease would instead require holding the lease
  // across a multi-minute subprocess and would block every concurrent sync.
  let agentResult = { ran: false };
  if (pending.length > 0) {
    agentResult = await agentMod.runWikiAgent({
      repoRoot, config, flags, targetSha,
      // Only in-scope generation targets are writable. Evidence intentionally
      // remains repository-wide so scoped docs can still be code-verified.
      paths: pending,
      scope,
      evidence: {
        paths: evidenceRecords.map((record) => record.path),
        include: evidenceState.include,
        exclude: evidenceState.exclude,
        secretsPaths: config.secrets_paths,
      },
      human,
      // Everything is being (re)generated: the repository map is worth
      // redoing before the batches start.
      fullRebuild: scope === null && pending.length === scoped.length,
    });
  } else {
    // Still validate the agent flags even with nothing to do. Otherwise a typo
    // in --agent-name, --agent-timeout or --agent-model is silently accepted whenever the
    // queue happens to be empty and rejected when it is not — the same command
    // passing or failing based on unrelated state.
    const opts = agentMod.resolveOptions(flags, config);
    if (opts.enabled) {
      agentResult = { ran: false, reason: 'nothing to generate' };
      if (human) ui.info('nothing to generate, so the agent was not started.');
    }
  }

  // Re-read rather than trusting the list we queued: the checkpoint was
  // advanced from the agent's completion reports after every batch, and a
  // partial run must leave the remainder visible so the next build resumes.
  let after = null;
  let afterReadError = null;
  try { after = inventory.readManifest(repoRoot); }
  catch (e) { afterReadError = e; }
  const observedPending = after?.checkpoint?.pendingPaths;
  const actualSourceSha = stateMod.resolveBase(repoRoot, config.sync.tracking_branch).baseSha;
  agentResult = agentMod.assessWikiProgress(agentResult, pending, observedPending, {
    expectedTargetSha: targetSha,
    actualTargetSha: afterReadError ? targetSha : after?.knowledgeSha,
    actualSourceSha,
  });
  if (afterReadError) {
    agentResult = { ...agentResult, reason: `Wiki manifest could not be read after Claude exited: ${afterReadError.message}` };
  }

  let structuredOk = true;
  if (agentResult.checkpointInvalid) {
    // If Claude only damaged/deleted the checkpoint while the source and
    // manifest target stayed put, restore the exact pre-agent queue. Never
    // overwrite state belonging to a concurrent sync that moved the target.
    const canRestore = structuredManifest && actualSourceSha === targetSha
      && (!after || after.knowledgeSha === targetSha);
    if (canRestore) {
      inventory.writeManifest(repoRoot, structuredManifest);
      after = structuredManifest;
      agentResult = { ...agentResult, checkpointRestored: true };
    } else {
      structuredOk = false;
    }
  }

  const afterPending = after?.checkpoint?.pendingPaths;
  const remaining = Array.isArray(afterPending) ? afterPending.length : pending.length;
  agentMod.renderWikiProgress(agentResult, { human });
  if (human && pending.length > 0 && agentResult.reason?.startsWith('not requested')) {
    ui.info(`--no-agent: ${remaining} generation target(s) stay queued without prose.`);
    ui.dim('    Run "aidev knowledge build" to write them; the manifest and checkpoint are saved.');
  }

  const commandOk = structuredOk && !(agentResult.ran && !agentResult.ok);
  if (!human) {
    emitJson({
      ok: commandOk,
      structuredOk,
      targetSha,
      files: records.length,
      generationTargets: records.length,
      evidenceFiles: evidenceState.trackedFiles,
      shards: shards.length,
      pending,
      deferred,
      remaining,
      agent: agentResult,
    });
  }
  // A failed or incomplete agent is reported but does not discard the
  // structured write; the non-zero exit tells CI that prose is still owed.
  return { code: commandOk ? EXIT.OK : EXIT.GENERAL, json };
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  const config = cfgMod.loadConfig(ctx.repoRoot);
  if (sub === 'status') return status(ctx, config);
  if (sub === 'build') return (await build(ctx, config)).code;
  throw new AidevError(`unknown subcommand: aidev knowledge ${sub || ''} (expected: build, status)`);
}

module.exports = { run, build, FLAGS, FLAG_HELP, summary: 'LLM Wikiの生成と状態確認' };
