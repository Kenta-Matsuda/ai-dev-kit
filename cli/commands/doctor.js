'use strict';
/**
 * `aidev doctor` — diagnose the machine and, when run inside one, the PKG.
 *
 * Never fails on a missing credential: reporting "not set" is the useful
 * output, and a CI agent legitimately runs without an interactive token.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const home = require('../lib/home');
const toolsMod = require('../lib/tools');
const ui = require('../lib/ui');

const FLAGS = { json: 'boolean' };
const FLAG_HELP = { json: 'machine-readable output' };

const MIN_NODE_MAJOR = 20;

function toolVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .toString().trim().split('\n')[0];
  } catch { return null; }
}

function run(ctx) {
  const { repoRoot, flags, installRoot } = ctx;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // --- runtime --------------------------------------------------------------
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  add('node', nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    `${process.version}${nodeMajor >= MIN_NODE_MAJOR ? '' : ` (>= ${MIN_NODE_MAJOR} required)`}`);
  add('platform', 'ok', `${process.platform} ${process.arch}`);
  const gitV = toolVersion('git', ['--version']);
  add('git', gitV ? 'ok' : 'fail', gitV || 'not found on PATH');

  // --- the kit itself --------------------------------------------------------
  add('aidev', 'ok', `${ctx.version || '?'} @ ${installRoot}`);
  const kitCommit = gitMod.headSha(installRoot);
  add('kit checkout', kitCommit ? 'ok' : 'warn', kitCommit ? stateMod.short(kitCommit) : 'not a git checkout; "aidev update" cannot self-update');
  const upd = home.checkForUpdate(installRoot);
  if (upd) add('kit update', upd.newer ? 'warn' : 'ok', upd.newer ? `newer version available (${stateMod.short(upd.remoteSha)}) — run "aidev update"` : 'up to date');
  else add('kit update', 'warn', 'could not check (offline?)');
  add('AIDEV_HOME', 'ok', home.home());
  const reg = home.listPackages();
  add('registered packages', 'ok', `${reg.present.length}${reg.missing.length ? ` (+${reg.missing.length} missing on disk)` : ''}`);

  // --- AI tools --------------------------------------------------------------
  // Every tool the PKG lists (or Claude Code alone outside a PKG) is looked up;
  // a missing one is a warning, since only the tool that runs agents matters.
  let toolIds = ['claude'];
  try {
    const early = fs.existsSync(cfgMod.configPath(repoRoot)) ? cfgMod.loadConfig(repoRoot) : null;
    if (early) toolIds = early.tools.default;
  } catch { /* reported below under aidev.yaml schema */ }
  for (const id of toolIds) {
    const tool = toolsMod.getTool(id);
    const resolved = toolsMod.resolveBinary(tool, process.env);
    const version = resolved.ok ? toolsMod.checkVersion(resolved, process.env) : null;
    const tag = tool.verified ? '' : ' (adapter not verified against the real tool by the kit maintainers)';
    if (!resolved.ok) add(id, 'warn', resolved.reason);
    else if (version.missing) add(id, 'warn', `${tool.label} not found on PATH — needed to run agents (aidev knowledge update, aidev agent run)`);
    else if (!version.ok) add(id, 'warn', version.reason);
    else add(id, 'ok', `${tool.label} ${version.version || ''} (${resolved.source})${tag}`.replace('  ', ' '));
  }

  // --- this package ------------------------------------------------------------
  const ejected = cfgMod.readEjectMarker(repoRoot);
  const hasConfig = fs.existsSync(cfgMod.configPath(repoRoot));
  if (ejected) add('kit management', 'ok', `ejected${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''} — maintained by hand`);
  if (!hasConfig) {
    add('aidev.yaml', ejected ? 'ok' : 'warn', ejected ? 'not present (ejected)' : 'not found here — run "aidev init" in a package clone to check it');
  } else {
    add('aidev.yaml', 'ok', repoRoot);
    let config = null;
    try { config = cfgMod.loadConfig(repoRoot); add('aidev.yaml schema', 'ok', `package.name=${config.package.name}, hosting=${config.hosting.type}`); }
    catch (e) { add('aidev.yaml schema', 'fail', e.message); }

    add('git repository', gitMod.isRepo(repoRoot) ? 'ok' : 'fail', gitMod.isRepo(repoRoot) ? repoRoot : 'not a git repository');
    const origin = gitMod.remoteUrl(repoRoot, 'origin');
    add('remote origin', origin ? 'ok' : 'warn', origin || 'missing — publishing the Wiki and the tracking branch need it');

    try {
      const pol = cfgMod.loadPolicy(repoRoot, { required: true });
      add('policy', 'ok', `${pol.protected.length} protected patterns`);
    } catch (e) { add('policy', 'warn', e.message); }

    if (config) {
      const overrides = Object.keys(config.tools.agents || {});
      add('agent tool', 'ok', `${config.tools.agent} (aidev.yaml tools.agent; one run: --agent-tool)`
        + (overrides.length ? `; per-agent overrides: ${overrides.join(', ')}` : ''));
      add('agent model', 'ok', config.tools.agent_model
        ? `${config.tools.agent_model} (aidev.yaml tools.agent_model; one run: --agent-model)`
        : 'unset — Claude Code resolves it');
      if (config.hosting.type === 'azure-devops') {
        const authEnv = config.hosting.auth_env;
        const has = typeof process.env[authEnv] === 'string' && process.env[authEnv].length > 0;
        add(`env ${authEnv}`, has ? 'ok' : 'warn', has ? 'set (value not read)' : 'not set — Azure DevOps calls will fail');
      }
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
      add('proxy', 'ok', proxy ? `HTTPS_PROXY=${proxy}` : 'none configured');
      if (gitMod.isRepo(repoRoot)) {
        const st = stateMod.computeState(repoRoot, config, { force: true });
        add('remote reachability', st.remoteOk ? 'ok' : 'warn',
          st.remoteOk ? `origin/${st.trackingBranch} = ${stateMod.short(st.trackingSha)}` : (st.remoteReason || 'unreachable'));
        add('Wiki state', st.severity === 'error' ? 'fail' : (st.severity === 'ok' ? 'ok' : 'warn'), st.message);
      }
    }
  }

  if (flags.json) {
    ui.json({ ok: !checks.some((c) => c.status === 'fail'), checks });
  } else {
    ui.heading('aidev doctor');
    for (const c of checks) {
      const mark = { ok: '✓', warn: '⚠', fail: '✗' }[c.status];
      ui.out(`  ${mark} ${c.name.padEnd(22)} ${c.detail == null ? '' : c.detail}`);
    }
    const fails = checks.filter((c) => c.status === 'fail').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    ui.out('');
    if (fails === 0 && warns === 0) ui.ok('no problems found.');
    else if (fails === 0) ui.warn(`${warns} warning(s); nothing blocking.`);
    else ui.fail(`${fails} blocking problem(s), ${warns} warning(s).`);
  }
  return checks.some((c) => c.status === 'fail') ? EXIT.GENERAL : EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, summary: 'この端末とPKGの実行環境を診断' };
