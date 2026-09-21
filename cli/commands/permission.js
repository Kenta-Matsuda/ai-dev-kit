'use strict';
/**
 * `aidev permission configure|reconfigure|show`
 *
 * The permission policy is the kit's control surface, so it is never written
 * by an agent and never generated silently. This command produces a *candidate*
 * at .aidev/policy.candidate.yaml, a human reads the diff, and only an explicit
 * `--approve` promotes it to .aidev/policy.yaml.
 *
 * That two-step exists because of a constraint the user set directly: agents
 * must not touch permission settings except when the policy file is first
 * created. Generating a candidate is mechanical; approving it is not.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const yaml = require('../lib/yaml');
const ui = require('../lib/ui');

const FLAGS = {
  approve: 'boolean', json: 'boolean', force: 'boolean', 'dry-run': 'boolean',
};

const CANDIDATE_REL = path.join('.aidev', 'policy.candidate.yaml');

function candidatePath(repoRoot) { return path.join(repoRoot, CANDIDATE_REL); }

/**
 * Derive a candidate policy from aidev.yaml.
 *
 * Every entry is mechanically justified: the protected floor is constant, the
 * PKG is read-only because writes to it go through a work lease, and the
 * secrets from aidev.yaml are promoted to protected so a policy edit alone can
 * never expose them.
 */
function buildCandidate(config) {
  const protectedPaths = [...cfgMod.ALWAYS_PROTECTED];
  for (const s of config.secrets_paths || []) {
    if (!protectedPaths.includes(s)) protectedPaths.push(s);
  }
  return {
    version: 1,
    protected: protectedPaths,
    read_only: [...cfgMod.DEFAULT_POLICY_SCOPES.read_only],
    writable_during_sync: [...cfgMod.DEFAULT_POLICY_SCOPES.writable_during_sync],
    writable: [...cfgMod.DEFAULT_POLICY_SCOPES.writable],
  };
}

function renderCandidate(config, policy) {
  return [
    '# .aidev/policy.yaml — 書き込み権限ポリシー',
    '#',
    '# このファイルは "aidev permission configure --approve" によってのみ配置されます。',
    '# エージェントは編集できません（protected に自分自身を含むため）。',
    '#',
    `# 生成元: ${cfgMod.CONFIG_NAME} (package.name=${config.package.name})`,
    '',
    'version: 1',
    '',
    '# 常に保護（このリストから削除しても CLI が強制的に再付与します）',
    'protected:',
    ...policy.protected.map((p) => `  - "${p}"`),
    '',
    '# PKG 本体。書き込みは issue-to-pr が取得する work lease 経由のみ。',
    'read_only:',
    ...policy.read_only.map((p) => `  - "${p}"`),
    '',
    '# sync lease 保持中に限って書き込み可能',
    'writable_during_sync:',
    ...policy.writable_during_sync.map((p) => `  - "${p}"`),
    '',
    '# 通常時に書き込み可能',
    'writable:',
    ...policy.writable.map((p) => `  - "${p}"`),
    '',
  ].join('\n');
}

function show(ctx) {
  const { repoRoot, flags } = ctx;
  const p = cfgMod.policyPath(repoRoot);
  const exists = fs.existsSync(p);
  const policy = cfgMod.loadPolicy(repoRoot, { required: false });

  if (flags.json) {
    ui.json({ exists, path: cfgMod.POLICY_REL, fallback: !!policy._fallback, policy });
    return exists ? EXIT.OK : EXIT.PERMISSION;
  }

  ui.heading('aidev permission show');
  if (!exists) {
    ui.warn(`${cfgMod.POLICY_REL} is not present; the built-in floor is in effect.`);
    ui.dim('    Run "aidev permission configure" to generate a candidate.');
  }
  for (const [section, entries] of [
    ['protected', policy.protected],
    ['read_only', policy.read_only],
    ['writable_during_sync', policy.writable_during_sync],
    ['writable', policy.writable],
  ]) {
    ui.out(`\n  ${section}:`);
    if (!entries || entries.length === 0) ui.dim('    (none)');
    else for (const e of entries) ui.out(`    • ${e}`);
  }
  ui.out('');
  return exists ? EXIT.OK : EXIT.PERMISSION;
}

/**
 * Compare a proposed policy against the one in force and report what it
 * removes.
 *
 * A change is "weakening" when it takes protection away: a protected or
 * read-only path that disappears, or a sync-only path that becomes freely
 * writable. Additions are never weakening, so a policy that only protects more
 * places approves without friction — the check must not train people to reach
 * for --force out of habit.
 */
function detectWeakening(current, candidate) {
  if (!current) return { weakening: false, losses: [] };
  const losses = [];
  const set = (v) => new Set(Array.isArray(v) ? v : []);

  for (const section of ['protected', 'read_only', 'writable_during_sync']) {
    const now = set(current[section]);
    const next = set(candidate[section]);
    for (const p of now) {
      if (!next.has(p)) losses.push({ section, path: p, kind: 'removed' });
    }
  }

  // Escalation: a path only writable while a sync lease is held becoming
  // unconditionally writable is a loss of protection even though nothing was
  // removed from a list.
  // The default policy legitimately lists the Wiki in both sections, so only
  // a path that was NOT already writable counts as newly escalated.
  const nextWritable = set(candidate.writable);
  const nowWritable = set(current.writable);
  for (const p of set(current.writable_during_sync)) {
    if (nextWritable.has(p) && !nowWritable.has(p)) losses.push({ section: 'writable_during_sync', path: p, kind: 'escalated-to-writable' });
  }

  return { weakening: losses.length > 0, losses };
}

function configure(ctx, { reconfigure = false } = {}) {
  const { repoRoot, flags } = ctx;
  const config = cfgMod.loadConfig(repoRoot);
  const target = cfgMod.policyPath(repoRoot);
  const cand = candidatePath(repoRoot);

  if (fs.existsSync(target) && !reconfigure && !flags.force) {
    throw new AidevError(
      `${cfgMod.POLICY_REL} already exists. Use "aidev permission reconfigure" to propose a change ` +
      '(it still requires --approve), or --force to regenerate the candidate.');
  }

  const policy = buildCandidate(config);
  // Validate what we are about to offer, rather than trusting the generator.
  const text = renderCandidate(config, policy);
  let parsed;
  try { parsed = yaml.parse(text); } catch (e) {
    throw new AidevError(`generated policy is not valid YAML: ${e.message}`);
  }
  cfgMod.validatePolicy(parsed, 'generated policy candidate');

  // A policy that takes protection away is the one change that must never be
  // placed on the strength of a single flag. --approve means "I read the
  // candidate"; it does not mean "I accept losing a protected path I never saw".
  const current = fs.existsSync(target) ? cfgMod.loadPolicy(repoRoot) : null;
  const weakened = detectWeakening(current, parsed);

  // ---- approval path -------------------------------------------------------
  if (flags.approve) {
    if (flags['dry-run']) {
      ui.warn('--dry-run with --approve: nothing was written.');
      return EXIT.OK;
    }
    if (weakened.weakening && !flags.force) {
      ui.fail('this candidate weakens the policy in force; it was NOT placed.');
      ui.out('');
      for (const l of weakened.losses) {
        ui.out(l.kind === 'escalated-to-writable'
          ? `  • ${l.path} — moves from ${l.section} to unconditionally writable`
          : `  • ${l.path} — removed from ${l.section}`);
      }
      ui.out('');
      ui.info('Review the difference, then re-run with --force if every loss above is intended:');
      ui.dim(`    git diff --no-index ${cfgMod.POLICY_REL} ${CANDIDATE_REL}`);
      ui.dim('    aidev permission reconfigure --approve --force');
      if (flags.json) ui.json({ ok: false, approved: false, weakening: true, losses: weakened.losses });
      return EXIT.PERMISSION;
    }
    cfgMod.writeFileAtomic(target, text);
    try { fs.unlinkSync(cand); } catch { /* candidate may not exist */ }
    ui.ok(`${cfgMod.POLICY_REL} placed (approved).`);
    if (weakened.weakening) {
      ui.warn(`${weakened.losses.length} protection(s) were given up with --force.`);
    }
    ui.dim('    It is itself a protected path, so agents cannot modify it from here on.');
    if (flags.json) {
      ui.json({ ok: true, approved: true, path: cfgMod.POLICY_REL,
        weakening: weakened.weakening, losses: weakened.losses });
    }
    return EXIT.OK;
  }

  // ---- candidate path ------------------------------------------------------
  if (flags['dry-run']) {
    if (flags.json) ui.json({ ok: true, dryRun: true, policy });
    else { ui.heading('candidate policy (dry run)'); ui.out(text); }
    return EXIT.OK;
  }

  cfgMod.writeFileAtomic(cand, text);
  if (flags.json) {
    ui.json({ ok: true, approved: false, candidate: CANDIDATE_REL, policy,
      weakening: weakened.weakening, losses: weakened.losses });
    return EXIT.OK;
  }
  ui.heading(`aidev permission ${reconfigure ? 'reconfigure' : 'configure'}`);
  ui.ok(`candidate written to ${CANDIDATE_REL}`);
  if (weakened.weakening) {
    ui.out('');
    ui.warn(`this candidate would give up ${weakened.losses.length} protection(s):`);
    for (const l of weakened.losses) {
      ui.dim(l.kind === 'escalated-to-writable'
        ? `    • ${l.path} — ${l.section} → writable`
        : `    • ${l.path} — removed from ${l.section}`);
    }
    ui.dim('    Approving this requires --force as well.');
  }
  ui.out('');
  ui.info('Review it, then approve:');
  ui.dim(`    git diff --no-index ${cfgMod.POLICY_REL} ${CANDIDATE_REL}`);
  ui.dim('    aidev permission configure --approve');
  ui.out('');
  ui.warn('The policy is never placed automatically — a human approves it, by design.');
  return EXIT.OK;
}

function run(ctx) {
  const sub = ctx.positionals[0];
  if (sub === 'show') return show(ctx);
  if (sub === 'configure') return configure(ctx);
  if (sub === 'reconfigure') return configure(ctx, { reconfigure: true });
  throw new AidevError(
    `unknown subcommand: aidev permission ${sub || ''} (expected: configure, reconfigure, show)`);
}

module.exports = {
  run, FLAGS, buildCandidate, renderCandidate, CANDIDATE_REL, candidatePath, detectWeakening,
  summary: '書き込み権限ポリシーの候補生成と承認',
};
