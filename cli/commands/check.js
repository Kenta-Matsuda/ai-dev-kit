'use strict';
/**
 * `aidev check` — the CI gate.
 *
 * Exit codes are a public contract (branch policies depend on them):
 *   0 everything agrees (a "tracking branch moved on" warning is still 0)
 *   2 materialised tool configuration disagrees with .aidev/materialized.json
 *   3 the policy file is missing or invalid
 *   4 the Wiki is missing or structurally broken
 *
 * When several problems coexist the most specific one wins, checked in the
 * order drift → permission → consistency, so a CI log names the thing a human
 * must fix first rather than the last one detected.
 *
 * A repository carrying the `aidev eject` marker is exempt entirely.
 */

const fs = require('fs');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const stateMod = require('../lib/state');
const { inspect } = require('./status');
const ui = require('../lib/ui');

const FLAGS = { strict: 'boolean', json: 'boolean', 'no-remote': 'boolean' };
const FLAG_HELP = {
  strict: 'treat warnings (tracking branch ahead, pending prose) as failures (exit 2)',
  json: 'machine-readable output',
  'no-remote': 'do not contact the remote',
};

function run(ctx) {
  const { repoRoot, flags } = ctx;
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
    else { ui.heading('aidev check'); ui.info('not an ai-dev-kit package (no aidev.yaml); nothing to check.'); }
    return EXIT.OK;
  }

  const config = cfgMod.loadConfig(repoRoot);
  const r = inspect(repoRoot, config, { checkRemote: !flags['no-remote'], installRoot: ctx.installRoot });

  // --- tool configuration (exit 2) --------------------------------------------
  // Local edits are the team's business and never fail the check. What fails
  // it is a tree nobody should merge: unresolved conflict markers, or the
  // kit's hooks removed from settings.json (the one edit that switches the
  // runtime guard off).
  if (r.config.noLock) {
    problems.push({ code: EXIT.DRIFT, message: `${cfgMod.LOCK_NAME} is missing — run "aidev init".` });
  } else if (r.config.conflicts.length > 0) {
    problems.push({
      code: EXIT.DRIFT,
      message: `${r.config.conflicts.length} tool configuration file(s) carry unresolved conflict markers. ` +
        'Resolve them and run "aidev apply" to record the result.',
    });
  } else if (r.config.hooksMissing.length > 0) {
    problems.push({
      code: EXIT.DRIFT,
      message: `the kit's hooks are missing from .claude/settings.json (${r.config.hooksMissing.join(', ')}). ` +
        'Restore them or run "aidev apply --force".',
    });
  }

  // --- policy integrity (exit 3) ---------------------------------------------
  if (!r.policy.ok) problems.push({ code: EXIT.PERMISSION, message: r.policy.error });

  // --- Wiki consistency (exit 4) ---------------------------------------------
  const st = r.state;
  if (st.severity === stateMod.SEVERITY.ERROR) {
    problems.push({ code: EXIT.KNOWLEDGE, message: st.message });
  } else if (r.inconsistencies.length > 0) {
    problems.push({ code: EXIT.KNOWLEDGE, message: `${r.inconsistencies.length} inventory inconsistency/ies (a page recorded with differing hashes)` });
  } else if (r.syncLease && !r.syncLease.evaluation.valid) {
    problems.push({ code: EXIT.KNOWLEDGE, message: `a stale sync lease is present (${r.syncLease.evaluation.reason}); run "aidev sync --resume" or "aidev sync --abort".` });
  } else if (st.severity === stateMod.SEVERITY.WARN && flags.strict) {
    problems.push({ code: EXIT.DRIFT, message: `${st.message} (--strict)` });
  }

  if (flags.json) {
    ui.json({
      ok: problems.length === 0,
      exitCode: problems.length === 0 ? EXIT.OK : problems[0].code,
      problems,
      severity: st.severity,
      trackingSha: st.trackingSha, baseSha: st.baseSha, knowledgeSha: st.knowledgeSha,
      handEdits: r.handEdits,
    });
  } else {
    ui.heading('aidev check');
    ui.table([
      ['tracking', stateMod.short(st.trackingSha)],
      ['base', stateMod.short(st.baseSha)],
      ['knowledge', stateMod.short(st.knowledgeSha)],
      ['tool config', r.config.noLock ? 'not recorded'
        : (r.config.conflicts.length ? 'CONFLICTS' : (r.config.hooksMissing.length ? 'HOOKS MISSING'
          : `ok${r.config.customised.length ? ` (${r.config.customised.length} customised)` : ''}${r.config.outdated ? ', newer kit templates available (aidev apply)' : ''}`))],
      ['policy', r.policy.ok ? 'valid' : 'INVALID'],
    ]);
    if (r.handEdits.length > 0) {
      ui.warn(`${r.handEdits.length} Wiki page(s) edited by hand since generation:`);
      for (const h of r.handEdits.slice(0, 10)) ui.dim(`    ${h.page} (${h.reason})`);
      ui.dim('    Regeneration will report these rather than overwrite them silently.');
    }
    if (problems.length === 0) {
      if (st.severity === stateMod.SEVERITY.WARN) ui.warn(st.message);
      else if (st.severity === stateMod.SEVERITY.UNKNOWN) ui.info(st.message);
      ui.ok('environment is consistent.');
    } else {
      for (const p of problems) ui.fail(`[exit ${p.code}] ${p.message}`);
      for (const m of r.config.conflicts.slice(0, 10)) ui.dim(`    conflict: ${m}`);
      for (const m of r.config.hooksMissing.slice(0, 10)) ui.dim(`    missing hook: ${m}`);
    }
  }
  return problems.length === 0 ? EXIT.OK : problems[0].code;
}

module.exports = { run, FLAGS, FLAG_HELP, summary: '環境整合性チェック（CI用。0=ok / 2=drift / 3=権限 / 4=Wiki）' };
