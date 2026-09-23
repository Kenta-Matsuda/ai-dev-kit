'use strict';
/**
 * `aidev check` — one screen that answers "is this clone in good shape?", and
 * the CI gate at the same time.
 *
 * A person reads the screen; a pipeline reads the exit code. Both come from
 * one inspection, so there is never a question of which command to look at.
 *
 * Exit codes are a public contract (branch policies depend on them):
 *   0 everything agrees (a warning — Wiki behind HEAD, pending prose, tracking
 *     branch ahead — is still 0; `--strict` makes it 2)
 *   1 aidev.yaml does not parse (a configuration error, not drift)
 *   2 materialised tool configuration disagrees with .aidev/materialized.json
 *   3 the policy file is missing or invalid
 *   4 the Wiki is missing or structurally broken
 *
 * When several problems coexist the most specific one wins, checked in the
 * order drift → permission → consistency, so a CI log names the thing a human
 * must fix first rather than the last one detected.
 *
 * A repository carrying the eject marker (`aidev uninstall --package`) is exempt entirely, and a
 * directory without aidev.yaml is "not a package": exit 0, nothing to check.
 */

const fs = require('fs');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const assets = require('../lib/assets');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const leases = require('../lib/leases');
const gitMod = require('../lib/git');
const wfMod = require('../lib/workflow');
const ui = require('../lib/ui');

const FLAGS = { strict: 'boolean', json: 'boolean', 'no-remote': 'boolean' };
const FLAG_HELP = {
  strict: 'treat warnings (Wiki behind HEAD, pending prose, tracking branch ahead) as failures (exit 2)',
  json: 'machine-readable output',
  'no-remote': 'do not contact the remote',
};

/** Everything the check looks at, computed once (hooks and uninstall reuse it). */
function inspect(repoRoot, config, { checkRemote = true, installRoot = assets.DEFAULT_INSTALL_ROOT } = {}) {
  const st = stateMod.computeState(repoRoot, config, { checkRemote });
  const configState = assets.inspectConfig(repoRoot, {
    tools: config && config.tools ? config.tools.default : null,
    installRoot,
    kitCommit: gitMod.headSha(installRoot),
  });
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
  const wikiBranch = st.trackingSha
    ? gitMod.revParse(repoRoot, `aidev/wiki-${String(st.trackingSha).slice(0, 12)}`)
      || gitMod.revParse(repoRoot, `origin/aidev/wiki-${String(st.trackingSha).slice(0, 12)}`)
    : null;
  // Workflows and the agents / skills they reference: an invalid one is a
  // problem the team must fix before anyone runs it.
  const workflows = wfMod.listWorkflows(repoRoot).map((n) => {
    const w = wfMod.inspect(repoRoot, installRoot, config, n);
    return { name: n, ok: w.ok, approved: w.approval.approved, reason: w.ok ? null : w.approval.reason };
  });
  return {
    state: st, config: configState, policy, manifest, records, handEdits, inconsistencies,
    syncLease: syncLease ? { ...syncLease, evaluation: leases.evaluateLease(syncLease) } : null,
    wikiBranchForTracking: wikiBranch,
    workflows,
  };
}

function run(ctx) {
  const { repoRoot, flags, installRoot } = ctx;
  const problems = [];

  const ejected = cfgMod.readEjectMarker(repoRoot);
  if (ejected) {
    if (flags.json) {
      ui.json({ ok: true, exitCode: EXIT.OK, ejected: true, ejectedAt: ejected.ejectedAt || null, problems: [] });
    } else {
      ui.heading('aidev check');
      ui.ok(`this repository was ejected from kit management${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''}.`);
      ui.dim('    Nothing is checked. Remove "aidev check" from the branch policy and pipeline,');
      ui.dim('    or run "aidev init" to re-adopt the kit.');
    }
    return EXIT.OK;
  }
  if (!fs.existsSync(cfgMod.configPath(repoRoot))) {
    if (flags.json) ui.json({ ok: true, exitCode: EXIT.OK, managed: false, problems: [] });
    else {
      ui.heading('aidev check');
      ui.info('not an ai-dev-kit package (no aidev.yaml); nothing to check. Run "aidev init" at the root of a package clone to set one up.');
    }
    return EXIT.OK;
  }

  let config;
  try { config = cfgMod.loadConfig(repoRoot); } catch (e) {
    if (flags.json) ui.json({ ok: false, exitCode: EXIT.GENERAL, problems: [{ code: EXIT.GENERAL, message: e.message }] });
    else { ui.heading('aidev check'); ui.fail(`[exit ${EXIT.GENERAL}] ${e.message}`); }
    return EXIT.GENERAL;
  }
  const r = inspect(repoRoot, config, { checkRemote: !flags['no-remote'], installRoot });
  const st = r.state;
  const cfgState = r.config;
  const kitCommit = gitMod.headSha(installRoot);

  // --- tool configuration (exit 2) --------------------------------------------
  // Local edits are the team's business and never fail the check. What fails
  // it is a tree nobody should merge: unresolved conflict markers, or the
  // kit's hooks removed from settings.json (the one edit that switches the
  // runtime guard off).
  if (cfgState.noLock) {
    problems.push({ code: EXIT.DRIFT, message: `${cfgMod.LOCK_NAME} is missing — run "aidev init".` });
  } else if (cfgState.conflicts.length > 0) {
    problems.push({
      code: EXIT.DRIFT,
      message: `${cfgState.conflicts.length} tool configuration file(s) carry unresolved conflict markers. ` +
        'Resolve them and run "aidev sync tools" to record the result.',
    });
  } else if (cfgState.hooksMissing.length > 0) {
    problems.push({
      code: EXIT.DRIFT,
      message: `the kit's hooks are missing from .claude/settings.json (${cfgState.hooksMissing.join(', ')}). ` +
        'Restore them or run "aidev sync tools --force".',
    });
  }

  // --- policy integrity (exit 3) ---------------------------------------------
  if (!r.policy.ok) problems.push({ code: EXIT.PERMISSION, message: r.policy.error });

  // --- Wiki consistency (exit 4) ---------------------------------------------
  if (st.severity === stateMod.SEVERITY.ERROR) {
    problems.push({ code: EXIT.KNOWLEDGE, message: st.message });
  } else if (r.inconsistencies.length > 0) {
    problems.push({ code: EXIT.KNOWLEDGE, message: `${r.inconsistencies.length} inventory inconsistency/ies (a page recorded with differing hashes)` });
  } else if (r.syncLease && !r.syncLease.evaluation.valid) {
    problems.push({ code: EXIT.KNOWLEDGE, message: `a stale publish lease is present (${r.syncLease.evaluation.reason}); run "aidev sync wiki" to continue it or "aidev sync wiki --abort" to discard it.` });
  } else if (st.severity === stateMod.SEVERITY.WARN && flags.strict) {
    problems.push({ code: EXIT.DRIFT, message: `${st.message} (--strict)` });
  }

  // --- workflows (exit 1) ----------------------------------------------------
  for (const w of r.workflows) {
    if (!w.ok) problems.push({ code: EXIT.GENERAL, message: `workflow ${w.name} is invalid: ${w.reason}` });
  }

  const exitCode = problems.length === 0 ? EXIT.OK : problems[0].code;
  if (flags.json) {
    ui.json({
      ok: problems.length === 0,
      exitCode,
      problems,
      package: config.package.name,
      hosting: config.hosting.type,
      tools: config.tools.default,
      kit: { version: ctx.version || null, commit: kitCommit, applied: cfgState.lock?.kitCommit || null },
      severity: st.severity,
      trackingSha: st.trackingSha, headSha: st.headSha, baseSha: st.baseSha, knowledgeSha: st.knowledgeSha, wikiBehind: st.wikiBehind,
      state: st,
      wiki: {
        present: !!r.manifest, pages: r.manifest?.stats?.pages ?? 0, targets: r.records.length,
        pending: st.pendingPages, handEdits: r.handEdits, inconsistencies: r.inconsistencies.length,
        branchForTracking: r.wikiBranchForTracking,
      },
      toolConfig: {
        ok: cfgState.ok, noLock: cfgState.noLock, conflicts: cfgState.conflicts, hooksMissing: cfgState.hooksMissing,
        missing: cfgState.missing, customised: cfgState.customised, outdated: cfgState.outdated,
      },
      policy: r.policy,
      syncLease: r.syncLease,
      workflows: r.workflows,
      handEdits: r.handEdits,
    });
    return exitCode;
  }

  // --- the one screen ---------------------------------------------------------
  const configLine = cfgState.noLock ? 'not recorded — run "aidev init"'
    : cfgState.conflicts.length ? `CONFLICTS in ${cfgState.conflicts.length} file(s) — resolve, then "aidev sync tools"`
      : cfgState.hooksMissing.length ? `kit hooks missing from .claude/settings.json (${cfgState.hooksMissing.join(', ')})`
        : `applied from kit ${stateMod.short(cfgState.lock.kitCommit)}${cfgState.customised.length ? `, ${cfgState.customised.length} file(s) customised` : ''}${cfgState.missing.length ? `, ${cfgState.missing.length} missing` : ''}${cfgState.outdated ? ' — newer templates available: "aidev sync tools"' : ''}`;
  const approvedCount = r.workflows.filter((w) => w.ok && w.approved).length;
  const workflowLine = r.workflows.length === 0
    ? 'none — "aidev create workflow <name> --describe <what you want>"'
    : `${r.workflows.length} (${approvedCount} approved${r.workflows.some((w) => !w.ok) ? `, ${r.workflows.filter((w) => !w.ok).length} INVALID` : ''})`;

  ui.heading(`aidev check — ${config.package.name}`);
  ui.table([
    ['hosting', `${config.hosting.type}${config.hosting.repository ? ` (${config.hosting.repository})` : ''}, tracking origin/${st.trackingBranch}`],
    ['tools', config.tools.default.join(', ')],
    ['kit', `${ctx.version || '?'} @ ${stateMod.short(kitCommit)}`],
  ]);
  ui.out('');
  ui.out(stateMod.formatSummary(st));
  if (r.wikiBranchForTracking && st.trackingSha !== st.knowledgeSha) {
    ui.dim(`    a Wiki for ${stateMod.short(st.trackingSha)} already exists on branch aidev/wiki-${String(st.trackingSha).slice(0, 12)} (waiting for merge).`);
  }
  ui.out('');
  ui.table([
    ['head / knowledge / tracking', `${stateMod.short(st.headSha)} / ${stateMod.short(st.knowledgeSha)} / ${stateMod.short(st.trackingSha)}`],
    ['Wiki', r.manifest ? `${r.manifest.stats?.pages ?? 0} page(s) for ${r.records.length} target(s)${st.pendingPages ? `, ${st.pendingPages} pending` : ''}` : 'not generated'],
    ['tool config', configLine],
    ['policy', r.policy.ok ? `placed (${r.policy.protectedCount} protected paths)` : 'missing — run "aidev create policy --approve"'],
    ['workflows', workflowLine],
  ]);
  if (r.handEdits.length > 0) {
    ui.warn(`${r.handEdits.length} Wiki page(s) edited by hand since generation:`);
    for (const h of r.handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
    ui.dim('    Regeneration will report these rather than overwrite them silently.');
  }
  if (!cfgState.noLock) {
    for (const m of cfgState.conflicts.slice(0, 10)) ui.dim(`    conflict:   ${m}`);
    for (const m of cfgState.hooksMissing.slice(0, 10)) ui.dim(`    missing hook: ${m}`);
    for (const m of cfgState.missing.slice(0, 10)) ui.dim(`    missing:    ${m} (restored by "aidev sync tools")`);
    for (const m of cfgState.customised.slice(0, 10)) ui.dim(`    customised: ${m}`);
  }
  for (const w of r.workflows.filter((x) => !x.ok).slice(0, 10)) ui.dim(`    workflow ${w.name}: ${w.reason}`);
  if (r.syncLease && r.syncLease.evaluation.valid) {
    ui.warn(`a Wiki publish is in progress (target ${stateMod.short(r.syncLease.targetSha)}).`);
  }
  ui.out('');
  if (problems.length === 0) {
    if (st.severity === stateMod.SEVERITY.WARN) ui.warn(st.message);
    else if (st.severity === stateMod.SEVERITY.UNKNOWN) ui.info(st.message);
    ui.ok('environment is consistent.');
  } else {
    for (const p of problems) ui.fail(`[exit ${p.code}] ${p.message}`);
  }
  ui.out('');
  return exitCode;
}

module.exports = { run, FLAGS, FLAG_HELP, inspect, summary: 'このPKGの状態を1画面で表示し、整合性を終了コードで返す（CI用。0=ok / 1=設定・workflow / 2=drift / 3=権限 / 4=Wiki）' };
