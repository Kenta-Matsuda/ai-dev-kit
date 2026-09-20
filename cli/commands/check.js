'use strict';
/**
 * `aidev check` — the CI gate.
 *
 * Exit codes are a public contract (branch policies depend on them):
 *   0 everything agrees (a remote-ahead warning is still 0)
 *   2 static files disagree with .aidev-lock
 *   3 the policy file is missing or invalid
 *   4 submoduleSha != knowledgeSha
 *
 * When several problems coexist the most specific one wins, checked in the
 * order drift → permission → consistency, so a CI log names the thing a human
 * must fix first rather than the last one detected.
 *
 * A repository carrying the `aidev eject` marker is exempt entirely: it has
 * been returned to manual maintenance, and there is nothing left to enforce.
 */

const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const assets = require('../lib/assets');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const ui = require('../lib/ui');

const FLAGS = { strict: 'boolean', json: 'boolean', 'no-remote': 'boolean' };

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const problems = [];
  const report = { drift: null, policy: null, state: null, handEdits: [] };

  // An ejected repository is out of scope by definition: it was deliberately
  // handed back to manual maintenance, so judging it would fail CI forever on
  // files nobody has agreed to keep in sync. Exit 0 and say why.
  const ejected = cfgMod.readEjectMarker(repoRoot);
  if (ejected) {
    if (flags.json) {
      ui.json({
        ok: true, exitCode: EXIT.OK, ejected: true,
        ejectedAt: ejected.ejectedAt || null, problems: [],
      });
    } else {
      ui.heading('aidev check');
      ui.ok(`this repository was ejected from kit management${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''}.`);
      ui.dim('    Nothing is checked. Remove "aidev check" from the branch policy and pipeline,');
      ui.dim(`    or delete ${cfgMod.EJECT_MARKER_NAME} and run "aidev init" to re-adopt the kit.`);
    }
    return EXIT.OK;
  }

  const config = cfgMod.loadConfig(repoRoot);

  // --- static-file drift (exit 2) ------------------------------------------
  const drift = assets.detectDrift(repoRoot);
  report.drift = drift;
  if (drift.noLock) {
    problems.push({ code: EXIT.DRIFT, message: '.aidev-lock is missing — run "aidev init" or "aidev kit apply".' });
  } else if (!drift.ok) {
    const parts = [];
    if (drift.modified.length) parts.push(`${drift.modified.length} modified`);
    if (drift.missing.length) parts.push(`${drift.missing.length} missing`);
    if (drift.extra.length) parts.push(`${drift.extra.length} untracked`);
    problems.push({
      code: EXIT.DRIFT,
      message: `kit-owned static files differ from .aidev-lock (${parts.join(', ')}). ` +
        'Run "aidev kit apply" to restore them, or send the change to the central kit as a PR.',
      detail: drift,
    });
  }

  // --- policy integrity (exit 3) -------------------------------------------
  let policy = null;
  try {
    policy = cfgMod.loadPolicy(repoRoot, { required: true });
    report.policy = { ok: true, protectedCount: policy.protected.length };
  } catch (e) {
    report.policy = { ok: false, error: e.message };
    problems.push({ code: EXIT.PERMISSION, message: e.message });
  }
  if (policy) {
    const missing = cfgMod.ALWAYS_PROTECTED.filter((p) => !policy.protected.includes(p));
    if (missing.length > 0) {
      // validatePolicy merges the floor, so reaching here means a loader bug.
      problems.push({ code: EXIT.PERMISSION, message: `policy is missing protected entries: ${missing.join(', ')}` });
    }
  }

  // --- three-SHA consistency (exit 4) --------------------------------------
  const st = stateMod.computeState(repoRoot, config, { checkRemote: !flags['no-remote'] });
  report.state = st;
  if (st.severity === stateMod.SEVERITY.ERROR) {
    problems.push({ code: EXIT.KNOWLEDGE, message: st.message });
  } else if (st.severity === stateMod.SEVERITY.WARN && flags.strict) {
    // --strict turns the "behind but consistent" warning into a hard failure.
    problems.push({ code: EXIT.DRIFT, message: `${st.message} (--strict)` });
  }

  // --- hand-edited Wiki pages (reported, never fatal) ----------------------
  try {
    const records = inventory.readInventory(repoRoot);
    report.handEdits = inventory.detectHandEdits(repoRoot, records);
  } catch { report.handEdits = []; }

  if (flags.json) {
    ui.json({
      ok: problems.length === 0,
      exitCode: problems.length === 0 ? EXIT.OK : problems[0].code,
      problems,
      severity: st.severity,
      remoteSha: st.remoteSha, submoduleSha: st.submoduleSha, knowledgeSha: st.knowledgeSha,
      handEdits: report.handEdits,
    });
  } else {
    ui.heading('aidev check');
    ui.table([
      ['remoteSha', stateMod.short(st.remoteSha)],
      ['submoduleSha', stateMod.short(st.submoduleSha)],
      ['knowledgeSha', stateMod.short(st.knowledgeSha)],
      ['static files', drift.noLock ? 'no .aidev-lock' : (drift.ok ? 'match .aidev-lock' : 'DRIFT')],
      ['policy', report.policy && report.policy.ok ? 'valid' : 'INVALID'],
    ]);
    if (report.handEdits.length > 0) {
      ui.warn(`${report.handEdits.length} Wiki page(s) edited by hand since generation:`);
      for (const h of report.handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
      ui.dim('    Regeneration will report these rather than overwrite them silently.');
    }
    if (problems.length === 0) {
      if (st.severity === stateMod.SEVERITY.WARN) ui.warn(st.message);
      else if (st.severity === stateMod.SEVERITY.UNKNOWN) ui.info(st.message);
      ui.ok('environment is consistent.');
    } else {
      for (const p of problems) ui.fail(`[exit ${p.code}] ${p.message}`);
      if (report.drift && report.drift.modified) {
        for (const m of report.drift.modified.slice(0, 10)) ui.dim(`    modified: ${m.path}`);
        for (const m of report.drift.missing.slice(0, 10)) ui.dim(`    missing:  ${m}`);
        for (const m of report.drift.extra.slice(0, 10)) ui.dim(`    untracked: ${m}`);
      }
    }
  }
  return problems.length === 0 ? EXIT.OK : problems[0].code;
}

module.exports = { run, FLAGS, summary: '環境整合性チェック（静的ファイル・ポリシー・3SHA）' };
