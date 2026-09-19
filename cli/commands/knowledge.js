'use strict';
/**
 * `aidev knowledge build|status`
 *
 * The CLI owns the structured half of the Wiki — the file inventory, the
 * manifest and the resumable checkpoint. Prose generation belongs to the
 * knowledge-builder agent, which reads the plan this command produces. Keeping
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
const leases = require('../lib/leases');
const pathsMod = require('../lib/paths');
const agentMod = require('../lib/agent');
const ui = require('../lib/ui');

const FLAGS = {
  scope: 'string', refresh: 'boolean', resume: 'boolean',
  'dry-run': 'boolean', json: 'boolean', force: 'boolean',
  'no-remote': 'boolean',
  ...agentMod.AGENT_FLAGS,
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
    ['remoteSha', stateMod.short(st.remoteSha)],
    ['submoduleSha', stateMod.short(st.submoduleSha)],
    ['knowledgeSha', stateMod.short(st.knowledgeSha)],
    ['generatedAt', manifest?.generatedAt || '-'],
    ['files', records.length],
    ['shards', manifest?.inventoryShards?.length ?? 0],
    ['masked files', manifest?.stats?.maskedFiles ?? 0],
    ['pending pages', manifest?.checkpoint?.pendingPaths?.length ?? 0],
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

async function build(ctx, config) {
  const { repoRoot, flags } = ctx;
  const human = !flags.json; // --json must emit exactly one JSON document
  const subDir = path.join(repoRoot, 'src');
  if (!fs.existsSync(subDir)) {
    throw new AidevError('src/ submodule is not present — run "git submodule update --init --recursive"');
  }
  const targetSha = gitMod.submoduleWorktreeSha(repoRoot, 'src') || gitMod.submoduleSha(repoRoot, 'src');
  if (!targetSha) throw new AidevError('could not determine the submodule SHA');

  const existing = inventory.readManifest(repoRoot);
  const oldRecords = flags.refresh || flags.resume ? inventory.readInventory(repoRoot, existing) : [];
  const newRecords = inventory.scanPackage(repoRoot, config) || [];

  // --scope narrows the work; it must narrow what is *written* too, or the
  // out-of-scope files would have fresh blobs recorded without fresh prose and
  // the next build would see them as unchanged — stale prose, silently.
  let scope = null;
  if (flags.scope) {
    scope = pathsMod.normalizeRel(flags.scope);
    if (pathsMod.escapesRoot(scope)) throw new AidevError(`--scope ${flags.scope} escapes the repository root`);
  }
  const inScope = (p) => scope === null || p === scope || p.startsWith(`${scope}/`);
  const scoped = newRecords.filter((r) => inScope(r.path));
  if (scope !== null && scoped.length === 0) {
    throw new AidevError(`--scope ${flags.scope} matched no files in package.include`);
  }

  const diff = inventory.diffInventory(oldRecords, newRecords);
  const pending = [...diff.added, ...diff.modified].map((r) => r.path).filter(inScope);
  const deferred = [...diff.added, ...diff.modified].map((r) => r.path).filter((p) => !inScope(p));

  if (human) {
    ui.heading(`aidev knowledge build${flags['dry-run'] ? ' (dry run)' : ''}`);
    ui.table([
      ['target', stateMod.short(targetSha)],
      ['files in scope', `${scoped.length}${scope === null ? '' : ` of ${newRecords.length}`}`],
      ['added', diff.added.length],
      ['modified', diff.modified.length],
      ['removed', diff.removed.length],
      ['renamed (free)', diff.renamed.length],
      ['unchanged', diff.unchanged.length],
      ['masked', newRecords.filter((r) => r.masked).length],
      ['queued now', pending.length],
      ...(deferred.length > 0 ? [['deferred (out of scope)', deferred.length]] : []),
    ]);
  }

  // Hand edits are human work. Overwriting them must be an explicit decision,
  // so this halts rather than warning-and-proceeding.
  const handEdits = inventory.detectHandEdits(repoRoot, oldRecords)
    .filter((h) => h.reason !== 'missing');
  if (handEdits.length > 0 && !flags.force && !flags['dry-run']) {
    const list = handEdits.slice(0, 10).map((h) => `      ${h.page} (${h.reason})`).join('\n');
    throw new AidevError(
      `${handEdits.length} Wiki page(s) were edited by hand and would be overwritten:\n${list}` +
      `${handEdits.length > 10 ? `\n      … and ${handEdits.length - 10} more` : ''}\n` +
      '    Re-run with --force to discard those edits, or move them into the generator.');
  }

  if (flags['dry-run']) {
    if (flags.json) ui.json({ ok: true, dryRun: true, targetSha, pending, deferred, handEdits });
    else {
      if (handEdits.length > 0) {
        ui.warn(`${handEdits.length} hand-edited page(s) would block this build; --force would discard them:`);
        for (const h of handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
      }
      ui.ok('dry run complete; nothing was written.');
      if (flags.agent || flags['agent-name'] != null) {
        const opts = agentMod.resolveOptions(flags, config);
        ui.dim(`    would then run the ${opts.agent} agent for ${pending.length} page(s).`);
      }
    }
    return EXIT.OK;
  }

  // Writing knowledge/** while the Wiki is inconsistent is precisely what the
  // sync lease authorises — and regenerating is what *resolves* that state. So
  // refusing here would make `aidev sync` the only way out even when src/ is
  // already at the commit the operator wants described (a rename committed
  // straight into the submodule, say). Take the lease for the duration of the
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
        originalSha: st.submoduleSha,
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
  try {
    shards = inventory.writeInventory(repoRoot, records, config.knowledge.inventory_shard_size);
    const manifest = existing || inventory.emptyManifest();
    manifest.schemaVersion = inventory.SCHEMA_VERSION;
    // Safe to advance: the inventory now describes targetSha exactly. Pages whose
    // prose is still queued are reported by computeState as a WARN, not by
    // holding this SHA back — sync must be able to finish and release its lease.
    manifest.knowledgeSha = targetSha;
    manifest.kitCommit = gitMod.headSha(repoRoot);
    manifest.generatedAt = new Date().toISOString();
    manifest.inventoryShards = shards;
    manifest.stats = {
      files: records.length,
      pages: new Set(records.flatMap((r) => Object.keys(r.selfHashes || {}))).size,
      maskedFiles: records.filter((r) => r.masked).length,
    };
    manifest.checkpoint = { completedShards: shards.length, pendingPaths: [...pending, ...deferred] };
    inventory.writeManifest(repoRoot, manifest);

    // The index is the entry point the design requires; create a stub if absent
    // so the directory is never a bare pile of generated pages.
    const indexPath = path.join(repoRoot, 'knowledge', 'index.md');
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
      ui.info(`${pending.length} page(s) queued for the knowledge-builder agent:`);
      for (const p of pending.slice(0, 20)) ui.dim(`    ${p}`);
      if (pending.length > 20) ui.dim(`    … and ${pending.length - 20} more`);
      ui.dim('    Prose generation runs as an agent task; the checkpoint above lets it resume.');
    } else ui.ok('no pages in scope need regeneration.');
    if (deferred.length > 0) {
      ui.warn(`${deferred.length} changed file(s) outside --scope were left for a later build.`);
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
      // Only in-scope paths: the manifest checkpoint merges pending and
      // deferred, so passing it verbatim would break the --scope promise.
      paths: pending,
      scope, human,
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

  // Re-read rather than trusting the list we queued: the agent owns clearing
  // its own completed paths, and a partial run must leave the remainder
  // visible so --refresh can resume.
  const after = inventory.readManifest(repoRoot);
  const remaining = after?.checkpoint?.pendingPaths?.length ?? pending.length;
  if (human && agentResult.ran && agentResult.ok) {
    if (remaining === 0) ui.ok('all queued pages are generated.');
    else ui.warn(`${remaining} page(s) still pending — re-run with --refresh to continue.`);
  }

  if (!human) {
    ui.json({
      ok: true, targetSha, files: records.length, shards: shards.length,
      pending, deferred, remaining, agent: agentResult,
    });
  }
  // A failed agent is reported but does not discard the structured write; the
  // non-zero exit is what tells CI that the Wiki is not yet complete.
  return agentResult.ran && !agentResult.ok ? EXIT.GENERAL : EXIT.OK;
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  const config = cfgMod.loadConfig(ctx.repoRoot);
  if (sub === 'status') return status(ctx, config);
  if (sub === 'build') return build(ctx, config);
  throw new AidevError(`unknown subcommand: aidev knowledge ${sub || ''} (expected: build, status)`);
}

module.exports = { run, FLAGS, summary: 'LLM Wikiの生成と状態確認' };
