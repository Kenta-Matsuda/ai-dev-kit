'use strict';
/**
 * `aidev doctor [--package <name|path>]` — diagnose this machine: the runtime, the kit
 * checkout, the registry and the AI tools. With a package (its registry name
 * or a path) it also reports that package's setup and Wiki state, for a human
 * reading a screen; the CI gate with exit codes stays `aidev check`, run in
 * the package clone.
 *
 * Never fails on a missing tool or credential: reporting "not found" is the
 * useful output, and a CI agent legitimately runs without an interactive
 * token.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const home = require('../lib/home');
const toolsMod = require('../lib/tools');
const wfMod = require('../lib/workflow');
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

/** The package rows: setup, hosting, policy, agent tool, Wiki state, workflows. */
function packageChecks(pkgRoot, installRoot, add) {
  const ejected = cfgMod.readEjectMarker(pkgRoot);
  const hasConfig = fs.existsSync(cfgMod.configPath(pkgRoot));
  add('package', 'ok', pkgRoot);
  if (ejected) add('kit management', 'ok', `ejected${ejected.ejectedAt ? ` at ${ejected.ejectedAt}` : ''} — maintained by hand`);
  if (!hasConfig) {
    add('aidev.yaml', ejected ? 'ok' : 'warn', ejected ? 'not present (ejected)' : 'not found — run "aidev init" at the root of the clone');
    return;
  }
  let config = null;
  try { config = cfgMod.loadConfig(pkgRoot); add('aidev.yaml', 'ok', `package.name=${config.package.name}, hosting=${config.hosting.type}`); }
  catch (e) { add('aidev.yaml', 'fail', e.message); return; }

  add('git repository', gitMod.isRepo(pkgRoot) ? 'ok' : 'fail', gitMod.isRepo(pkgRoot) ? `on ${gitMod.currentBranch(pkgRoot) || 'detached HEAD'}` : 'not a git repository');
  const origin = gitMod.remoteUrl(pkgRoot, 'origin');
  add('remote origin', origin ? 'ok' : 'warn', origin || 'missing — publishing the Wiki and approving workflows need it');
  try {
    const pol = cfgMod.loadPolicy(pkgRoot, { required: true });
    add('policy', 'ok', `${pol.protected.length} protected patterns`);
  } catch (e) { add('policy', 'warn', e.message); }

  const overrides = Object.keys(config.tools.agents || {});
  add('agent tool', 'ok', `${config.tools.agent}${config.tools.agent_model ? ` (${config.tools.agent_model})` : ''}${overrides.length ? `; per-agent overrides: ${overrides.join(', ')}` : ''}`);
  if (config.hosting.type === 'azure-devops') {
    const authEnv = config.hosting.auth_env;
    const has = typeof process.env[authEnv] === 'string' && process.env[authEnv].length > 0;
    add(`env ${authEnv}`, has ? 'ok' : 'warn', has ? 'set (value not read)' : 'not set — Azure DevOps calls will fail');
  }
  if (gitMod.isRepo(pkgRoot)) {
    const st = stateMod.computeState(pkgRoot, config, { force: true });
    add('remote reachability', st.remoteOk ? 'ok' : 'warn',
      st.remoteOk ? `origin/${st.trackingBranch} = ${stateMod.short(st.trackingSha)}` : (st.remoteReason || 'unreachable'));
    add('Wiki state', st.severity === 'error' ? 'fail' : (st.severity === 'ok' ? 'ok' : 'warn'), st.message);
  }
  const workflows = wfMod.listWorkflows(pkgRoot).map((n) => ({ name: n, ...wfMod.inspect(pkgRoot, installRoot, config, n) }));
  const invalid = workflows.filter((w) => !w.ok);
  const approved = workflows.filter((w) => w.ok && w.approval.approved).length;
  add('workflows', invalid.length ? 'fail' : 'ok',
    workflows.length === 0 ? 'none — "aidev create workflow <name>"' : `${workflows.length} (${approved} approved${invalid.length ? `; invalid: ${invalid.map((w) => w.name).join(', ')}` : ''})`);
}

function run(ctx) {
  const { flags, installRoot, positionals } = ctx;
  if (positionals[0]) throw new AidevError(`unexpected argument: ${positionals[0]} (name a package with --package ${positionals[0]})`);
  const pkgRoot = ctx.packageRef ? ctx.repoRoot : null;
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
  for (const p of reg.present) add('  package', 'ok', `${p.name || '?'} — ${p.path}`);

  // --- AI tools --------------------------------------------------------------
  for (const id of toolsMod.TOOL_IDS) {
    const tool = toolsMod.getTool(id);
    const resolved = toolsMod.resolveBinary(tool, process.env);
    const version = resolved.ok ? toolsMod.checkVersion(resolved, process.env) : null;
    const tag = tool.verified ? '' : ' (adapter not verified against the real tool by the kit maintainers)';
    if (!resolved.ok) add(id, 'warn', resolved.reason);
    else if (version.missing) add(id, 'warn', `${tool.label} not found on PATH — needed to run agents (aidev sync wiki, aidev run workflow)`);
    else if (!version.ok) add(id, 'warn', version.reason);
    else add(id, 'ok', `${tool.label} ${version.version || ''} (${resolved.source})${tag}`.replace('  ', ' '));
  }
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || null;
  add('proxy', 'ok', proxy ? `HTTPS_PROXY=${proxy}` : 'none configured');

  // --- one package, when named ---------------------------------------------
  if (pkgRoot) packageChecks(pkgRoot, installRoot, add);

  if (flags.json) {
    ui.json({ ok: !checks.some((c) => c.status === 'fail'), package: pkgRoot, checks });
  } else {
    ui.heading(`aidev doctor${pkgRoot ? ` --package ${ctx.packageRef}` : ''}`);
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
    if (!pkgRoot) ui.dim('    For a package: aidev doctor --package <name|path>. The CI gate is "aidev check" inside the clone.');
  }
  return checks.some((c) => c.status === 'fail') ? EXIT.GENERAL : EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, summary: 'この端末を診断する。--package を渡すとその PKG の状態も' };
