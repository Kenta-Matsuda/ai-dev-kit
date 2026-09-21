'use strict';
/**
 * `aidev status` — one screen that answers "is this clone in good shape?"
 *
 * Purely informational: exit 0 unless the repository is not set up at all.
 * `aidev check` runs the same inspections and turns them into exit codes for
 * CI and branch policies.
 */

const fs = require('fs');
const path = require('path');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const layout = require('../lib/layout');
const assets = require('../lib/assets');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const leases = require('../lib/leases');
const gitMod = require('../lib/git');
const ui = require('../lib/ui');

const FLAGS = { json: 'boolean', 'no-remote': 'boolean' };
const FLAG_HELP = { json: 'machine-readable output', 'no-remote': 'do not contact the remote' };

/** Everything `status` and `check` look at, computed once. */
function inspect(repoRoot, config, { checkRemote = true } = {}) {
  const st = stateMod.computeState(repoRoot, config, { checkRemote });
  const drift = assets.detectDrift(repoRoot, { tools: config && config.tools ? config.tools.default : null });
  let policy = { ok: false, error: null, present: false };
  try {
    const pol = cfgMod.loadPolicy(repoRoot, { required: true });
    policy = { ok: true, present: true, protectedCount: pol.protected.length, writable: pol.writable };
  } catch (e) { policy = { ok: false, present: false, error: e.message }; }
  const manifest = inventory.readManifest(repoRoot);
  const records = inventory.readInventory(repoRoot, manifest);
  const handEdits = inventory.detectHandEdits(repoRoot, records);
  const inconsistencies = inventory.validateInventoryConsistency(records);
  const syncLease = leases.readSyncLease(repoRoot);
  const workLeases = leases.listWorkLeases(repoRoot).filter((l) => leases.evaluateLease(l).valid);
  const wikiBranch = st.trackingSha
    ? gitMod.revParse(repoRoot, `ai/wiki-${String(st.trackingSha).slice(0, 12)}`)
      || gitMod.revParse(repoRoot, `origin/ai/wiki-${String(st.trackingSha).slice(0, 12)}`)
    : null;
  return {
    state: st, drift, policy, manifest, records, handEdits, inconsistencies,
    syncLease: syncLease ? { ...syncLease, evaluation: leases.evaluateLease(syncLease) } : null,
    workLeases, wikiBranchForTracking: wikiBranch,
  };
}

function run(ctx) {
  const { repoRoot, flags, installRoot } = ctx;
  const human = !flags.json;
  const hasConfig = fs.existsSync(cfgMod.configPath(repoRoot));
  const ejected = cfgMod.readEjectMarker(repoRoot);

  if (!hasConfig) {
    if (flags.json) ui.json({ ok: false, managed: false, ejected: !!ejected });
    else {
      ui.heading('aidev status');
      if (ejected) ui.warn(`this repository was ejected from ai-dev-kit${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''}. Run "aidev init" to re-adopt it.`);
      else ui.warn('this directory is not set up for ai-dev-kit. Run "aidev init" at the root of your package clone.');
    }
    return EXIT.GENERAL;
  }

  const config = cfgMod.loadConfig(repoRoot);
  const r = inspect(repoRoot, config, { checkRemote: !flags['no-remote'] });
  const st = r.state;
  const kitCommit = gitMod.headSha(installRoot);

  if (flags.json) {
    ui.json({
      ok: true,
      package: config.package.name,
      hosting: config.hosting.type,
      tools: config.tools.default,
      kit: { version: ctx.version || null, commit: kitCommit, applied: r.drift.lock?.kitCommit || null },
      state: st,
      wiki: {
        present: !!r.manifest, pages: r.manifest?.stats?.pages ?? 0, targets: r.records.length,
        pending: st.pendingPages, handEdits: r.handEdits, inconsistencies: r.inconsistencies.length,
        branchForTracking: r.wikiBranchForTracking,
      },
      drift: { ok: r.drift.ok, noLock: r.drift.noLock, modified: r.drift.modified.map((m) => m.path), missing: r.drift.missing, extra: r.drift.extra },
      policy: r.policy,
      syncLease: r.syncLease,
      workLeases: r.workLeases.map((l) => ({ taskId: l.taskId, branch: l.branch })),
    });
    return EXIT.OK;
  }

  ui.heading(`aidev status — ${config.package.name}`);
  ui.table([
    ['hosting', `${config.hosting.type}${config.hosting.repository ? ` (${config.hosting.repository})` : ''}, tracking origin/${st.trackingBranch}`],
    ['tools', config.tools.default.join(', ')],
    ['kit', `${ctx.version || '?'} @ ${stateMod.short(kitCommit)}${r.drift.lock?.kitCommit && r.drift.lock.kitCommit !== kitCommit ? ` (this clone was set up with ${stateMod.short(r.drift.lock.kitCommit)}; run "aidev update")` : ''}`],
  ]);
  ui.out('');
  ui.out(stateMod.formatSummary(st));
  if (r.wikiBranchForTracking && st.trackingSha !== st.knowledgeSha) {
    ui.dim(`    a Wiki for ${stateMod.short(st.trackingSha)} already exists on branch ai/wiki-${String(st.trackingSha).slice(0, 12)} (waiting for merge).`);
  }
  ui.out('');
  ui.table([
    ['Wiki', r.manifest ? `${r.manifest.stats?.pages ?? 0} page(s) for ${r.records.length} target(s)${st.pendingPages ? `, ${st.pendingPages} pending` : ''}` : 'not generated'],
    ['tool config', r.drift.noLock ? 'not recorded — run "aidev init"' : (r.drift.ok ? 'matches the kit' : 'DRIFT (edited by hand or outdated)')],
    ['policy', r.policy.ok ? `placed (${r.policy.protectedCount} protected paths)` : 'missing — run "aidev permission configure --approve"'],
  ]);
  if (r.handEdits.length > 0) {
    ui.warn(`${r.handEdits.length} Wiki page(s) edited by hand since generation:`);
    for (const h of r.handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
  }
  if (r.inconsistencies.length > 0) ui.warn(`${r.inconsistencies.length} inventory inconsistency/ies; run "aidev knowledge build --full" if they persist.`);
  if (!r.drift.ok && !r.drift.noLock) {
    for (const m of r.drift.modified.slice(0, 10)) ui.dim(`    modified: ${m.path}`);
    for (const m of r.drift.missing.slice(0, 10)) ui.dim(`    missing:  ${m}`);
    for (const m of r.drift.extra.slice(0, 10)) ui.dim(`    untracked: ${m}`);
    ui.dim('    "aidev update" restores kit files; local changes belong in a PR to ai-dev-kit.');
  }
  if (r.syncLease) {
    ui.warn(r.syncLease.evaluation.valid
      ? `a sync is in progress (target ${stateMod.short(r.syncLease.targetSha)}).`
      : `a stale sync lease is present (${r.syncLease.evaluation.reason}). Run "aidev sync --resume" or "aidev sync --abort".`);
  }
  if (r.workLeases.length > 0) {
    ui.info(`active work lease(s): ${r.workLeases.map((l) => `${l.taskId} → ${l.branch}`).join(', ')}`);
  }
  ui.out('');
  return EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, inspect, summary: 'このPKGの状態を1画面で表示' };
