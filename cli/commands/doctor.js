'use strict';
/**
 * `aidev doctor` — diagnose the environment rather than the repository.
 *
 * Never fails on a missing credential: reporting "not set" is the useful
 * output, and a CI agent legitimately runs without an interactive PAT.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { EXIT } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const ui = require('../lib/ui');

const FLAGS = { json: 'boolean' };

const MIN_NODE_MAJOR = 20;

function toolVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .toString().trim().split('\n')[0];
  } catch { return null; }
}

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // --- runtime --------------------------------------------------------------
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  add('node', nodeMajor >= MIN_NODE_MAJOR ? 'ok' : 'fail',
    `${process.version}${nodeMajor >= MIN_NODE_MAJOR ? '' : ` (>= ${MIN_NODE_MAJOR} required)`}`);
  add('platform', 'ok', `${process.platform} ${process.arch}`);

  const gitV = toolVersion('git', ['--version']);
  add('git', gitV ? 'ok' : 'fail', gitV || 'not found on PATH');

  // --- repository shape -----------------------------------------------------
  // An ejected repository legitimately has no aidev.yaml and no policy. CI runs
  // check and doctor together, so grading those as failures here would break the
  // pipeline that `check`'s exemption exists to keep green.
  const ejected = cfgMod.readEjectMarker(repoRoot);
  const shapeStatus = ejected ? 'ok' : 'fail';

  const hasConfig = fs.existsSync(cfgMod.configPath(repoRoot));
  if (ejected) {
    add('kit management', 'ok',
      `ejected${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''} — maintained by hand`);
  }
  add('aidev.yaml', hasConfig ? 'ok' : shapeStatus,
    hasConfig ? repoRoot : (ejected ? 'not present (ejected)' : 'not found — run "aidev init"'));

  let config = null;
  if (hasConfig) {
    try { config = cfgMod.loadConfig(repoRoot); add('aidev.yaml schema', 'ok', `package.name=${config.package.name}`); }
    catch (e) { add('aidev.yaml schema', 'fail', e.message); }
  }

  add('git repository', gitMod.isRepo(repoRoot) ? 'ok' : shapeStatus,
    gitMod.isRepo(repoRoot) ? repoRoot : 'not a git repository');

  const subDir = path.join(repoRoot, 'src');
  const subInit = fs.existsSync(path.join(subDir, '.git'));
  add('src submodule', subInit ? 'ok' : 'warn',
    subInit ? gitMod.headSha(subDir) : 'not initialised — run "git submodule update --init --recursive"');

  const remotes = gitMod.run(['remote'], { cwd: repoRoot });
  const remoteList = remotes.ok ? remotes.stdout.split('\n').filter(Boolean) : [];
  add('remote origin', remoteList.includes('origin') ? 'ok' : 'warn',
    remoteList.includes('origin') ? 'present' : 'missing (the PKG-specific wrapper repo)');
  add('remote upstream', remoteList.includes('upstream') ? 'ok' : 'warn',
    remoteList.includes('upstream') ? 'present' : 'missing — "aidev kit apply" needs it to pull central assets');

  // --- policy ---------------------------------------------------------------
  try {
    const pol = cfgMod.loadPolicy(repoRoot, { required: true });
    add('policy', 'ok', `${pol.protected.length} protected patterns`);
  } catch (e) {
    add('policy', 'warn', ejected ? 'not present (ejected)' : e.message);
  }

  // --- models ---------------------------------------------------------------
  // Two separate resolutions, and conflating them is the usual confusion. The
  // CLI only ever chooses for the agents it spawns itself; an interactive
  // session is resolved by Claude Code from its own settings stack, which this
  // process cannot read. So report the first as fact and the second as the
  // one signal we can actually observe — the environment variable that outranks
  // every settings file.
  if (config) {
    add('agent model', 'ok', config.model.agent
      ? `${config.model.agent} (aidev.yaml model.agent; one run: --agent-model)`
      : 'unset — no --model is passed, so Claude Code resolves it');
  }
  const envModel = process.env.ANTHROPIC_MODEL || null;
  add('session model', 'ok', envModel
    ? `ANTHROPIC_MODEL=${envModel} (overrides every settings file)`
    : 'from .claude/settings.json, overridable in .claude/settings.local.json');

  // --- credentials (presence only; the value is never read or printed) ------
  const authEnv = config?.azure_devops?.auth_env || 'AZURE_DEVOPS_PAT';
  const hasPat = typeof process.env[authEnv] === 'string' && process.env[authEnv].length > 0;
  add(`env ${authEnv}`, hasPat ? 'ok' : 'warn',
    hasPat ? 'set (value not read)' : 'not set — Azure DevOps calls will fail');

  // --- proxy ----------------------------------------------------------------
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  add('proxy', 'ok', proxy ? `HTTPS_PROXY=${proxy}` : 'none configured');

  // --- connectivity and consistency ----------------------------------------
  if (config && subInit) {
    const st = stateMod.computeState(repoRoot, config, { force: true });
    add('remote reachability', st.remoteOk ? 'ok' : 'warn',
      st.remoteOk ? `origin/${st.trackingBranch} = ${stateMod.short(st.remoteSha)}` : (st.remoteReason || 'unreachable'));
    add('three-SHA state', st.severity === 'error' ? 'fail' : (st.severity === 'ok' ? 'ok' : 'warn'), st.message);
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
  // Warnings are informational; only a hard failure changes the exit code.
  return checks.some((c) => c.status === 'fail') ? EXIT.GENERAL : EXIT.OK;
}

module.exports = { run, FLAGS, summary: 'ランタイム・ツール・認証・プロキシを診断' };
