'use strict';
/**
 * `aidev plan` — show what init / update / sync would change. Never writes.
 *
 * Exists so the destructive-looking commands have a safe rehearsal, and so a
 * reviewer can see the intended change set without granting write access.
 */

const fs = require('fs');
const path = require('path');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const assets = require('../lib/assets');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const gitMod = require('../lib/git');
const ui = require('../lib/ui');

const FLAGS = { json: 'boolean', 'no-remote': 'boolean' };

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const plan = { init: [], update: [], sync: [] };

  const hasConfig = fs.existsSync(cfgMod.configPath(repoRoot));
  const config = hasConfig ? cfgMod.loadConfig(repoRoot) : null;

  // --- init ----------------------------------------------------------------
  if (!hasConfig) plan.init.push('create aidev.yaml (interactive)');

  // `.claude/` is generated, so the rehearsal has to cover it or the largest
  // thing init does stays invisible until it has already happened.
  const mat = assets.materializeStaticAssets(repoRoot, { dryRun: true });
  if (mat.noTemplates) {
    plan.init.push(`no asset templates under ${mat.templateRoot}/ — this clone is incomplete`);
  } else {
    for (const p of mat.created) plan.init.push(`create kit file: ${p}`);
    for (const p of mat.updated) plan.init.push(`replace kit file: ${p}`);
    for (const p of mat.pruned) plan.init.push(`remove kit file the kit no longer ships: ${p}`);
    for (const c of mat.conflicts) {
      plan.init.push(`conflict (needs --force or a PR to the kit): ${c.path} — ${c.reason}`);
    }
  }
  if (!fs.existsSync(cfgMod.policyPath(repoRoot))) {
    plan.init.push('place .aidev/policy.yaml from an approved candidate ("aidev permission configure")');
  }
  if (!fs.existsSync(path.join(repoRoot, 'knowledge', 'manifest.json'))) {
    plan.init.push('generate the LLM Wiki ("aidev knowledge build")');
  }
  if (!fs.existsSync(cfgMod.lockPath(repoRoot))) plan.init.push('write .aidev-lock');

  // --- update --------------------------------------------------------------
  const drift = assets.detectDrift(repoRoot);
  if (drift.noLock) plan.update.push('no .aidev-lock — run "aidev init" or "aidev update"');
  else if (!drift.ok) {
    for (const m of drift.modified) plan.update.push(`restore modified kit file: ${m.path}`);
    for (const m of drift.missing) plan.update.push(`restore missing kit file: ${m}`);
    for (const m of drift.extra) plan.update.push(`untracked kit-owned file: ${m}`);
  }

  // --- sync ----------------------------------------------------------------
  let st = null;
  if (config) {
    st = stateMod.computeState(repoRoot, config, { checkRemote: !flags['no-remote'] });
    if (st.remoteSha && st.remoteSha !== st.submoduleSha) {
      plan.sync.push(`bump src: ${stateMod.short(st.submoduleSha)} → ${stateMod.short(st.remoteSha)}`);
    }
    if (st.submoduleSha !== st.knowledgeSha) {
      plan.sync.push(`regenerate the Wiki for ${stateMod.short(st.submoduleSha)} (currently describes ${stateMod.short(st.knowledgeSha)})`);
    }
    // Estimate the regeneration cost without calling an LLM.
    try {
      const old = inventory.readInventory(repoRoot);
      const now = inventory.scanPackage(repoRoot, config);
      if (now) {
        const d = inventory.diffInventory(old, now);
        plan.sync.push(
          `inventory diff: +${d.added.length} ~${d.modified.length} -${d.removed.length} ` +
          `→${d.renamed.length} (=${d.unchanged.length} unchanged); ` +
          `${d.needsGeneration ? `${d.added.length + d.modified.length} page(s) need regeneration` : 'no LLM calls needed'}`);
      }
    } catch (e) { plan.sync.push(`inventory diff unavailable: ${e.message}`); }
  }

  if (flags.json) { ui.json({ plan, state: st }); return EXIT.OK; }

  ui.heading('aidev plan (read-only)');
  for (const [name, items] of Object.entries(plan)) {
    ui.out(`\n  ${name}:`);
    if (items.length === 0) ui.dim('    nothing to do');
    else for (const i of items) ui.out(`    • ${i}`);
  }
  if (st) { ui.out(''); ui.out(stateMod.formatSummary(st)); }
  return EXIT.OK;
}

module.exports = { run, FLAGS, summary: 'init / update / sync の差分をプレビュー' };
