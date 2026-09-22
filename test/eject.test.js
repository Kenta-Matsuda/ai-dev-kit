'use strict';
/**
 * Tests for the two internal-facing commands: `aidev mcp` and `aidev eject`.
 *
 * Both are run through the process boundary, because both are invoked that way
 * in production — `.mcp.json` spawns `aidev mcp`, and eject is a human action
 * whose exit code a pipeline may branch on.
 *
 * `aidev mcp azure-devops` is never run without --dry-run here: doing so would
 * spawn a real npx and reach the network. The dry run exercises every branch
 * this code owns; the spawn itself is one call to child_process.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, write } = require('./fixtures');
const { EXIT } = require('../cli/lib/errors');
const cfgMod = require('../cli/lib/config');
const home = require('../cli/lib/home');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');

/** One AIDEV_HOME for the run: the registry must never touch the real one. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-home-'));
const HOME_ENV = { AIDEV_HOME: HOME };

function aidev(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', AIDEV_HOME: HOME, AIDEV_NO_UPDATE_CHECK: '1', ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** The fixture's auth env var, set so mcp gets past its credential check. */
const WITH_PAT = { AZURE_DEVOPS_PAT: 'fake-pat-for-tests' };

/** Is this clone in the AIDEV_HOME registry? */
function registered(root) {
  return home.readRegistry(HOME_ENV).packages.some((p) => path.resolve(p.path).toLowerCase() === path.resolve(root).toLowerCase());
}

function run() {
  suite('cli: mcp');

  test('a missing server name lists the known ones', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['mcp'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/azure-devops/.test(r.stderr), `names the options: ${r.stderr}`);
    } finally { fx.cleanup(); }
  });

  test('an unknown server name is rejected', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['mcp', 'not-a-server'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/unknown mcp server/.test(r.stderr), 'message');
    } finally { fx.cleanup(); }
  });

  test('a missing PAT fails before spawning, naming the variable', () => {
    const fx = makeRepo();
    try {
      // Failing here rather than at the first tool call is the point: the
      // operator gets a cause instead of a broken MCP connection.
      const r = aidev(['mcp', 'azure-devops', '--dry-run'],
        { cwd: fx.root, env: { AZURE_DEVOPS_PAT: '' } });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/AZURE_DEVOPS_PAT/.test(r.stderr), 'names the env var');
    } finally { fx.cleanup(); }
  });

  test('--json reports the resolved launch and never the credential', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['mcp', 'azure-devops', '--json'], { cwd: fx.root, env: WITH_PAT });
      eq(r.code, EXIT.OK, 'exit');
      const d = JSON.parse(r.stdout);
      eq(d.organization, 'my-org', 'organization from aidev.yaml');
      eq(d.project, 'my-project', 'project from aidev.yaml');
      eq(d.authResolved, true, 'reports that auth resolved');
      // The whole document, not just the known fields: a future addition that
      // leaked the value would fail here.
      ok(!r.stdout.includes(WITH_PAT.AZURE_DEVOPS_PAT), 'the PAT value appears nowhere in the output');
    } finally { fx.cleanup(); }
  });

  test('the server version is pinned, not @latest', () => {
    const fx = makeRepo();
    try {
      const d = JSON.parse(aidev(['mcp', 'azure-devops', '--json'],
        { cwd: fx.root, env: WITH_PAT }).stdout);
      ok(!/@latest/.test(d.package), `pinned: ${d.package}`);
      ok(/@\d+\.\d+\.\d+$/.test(d.package), `exact version: ${d.package}`);
      // A PKG's toolchain must not move without a reviewed kit commit, so the
      // pin has to survive into the actual argv too.
      ok(d.args.some((a) => a === d.package), `argv carries the pinned spec: ${d.args.join(' ')}`);
    } finally { fx.cleanup(); }
  });

  test('the PAT is never placed on the command line', () => {
    const fx = makeRepo();
    try {
      const d = JSON.parse(aidev(['mcp', 'azure-devops', '--json'],
        { cwd: fx.root, env: WITH_PAT }).stdout);
      // argv is world-readable through the process table; the credential goes
      // through the child environment only.
      ok(!d.args.some((a) => String(a).includes(WITH_PAT.AZURE_DEVOPS_PAT)), 'no PAT in argv');
    } finally { fx.cleanup(); }
  });

  test('the base64 form of the PAT never leaks either', () => {
    // The server wants base64("<user>:<pat>"). Base64 is encoding, not
    // encryption, so the encoded value is exactly as sensitive as the raw one.
    const fx = makeRepo();
    try {
      const r = aidev(['mcp', 'azure-devops', '--json'], { cwd: fx.root, env: WITH_PAT });
      const encoded = Buffer.from(`aidev:${WITH_PAT.AZURE_DEVOPS_PAT}`, 'utf8').toString('base64');
      ok(!r.stdout.includes(encoded), 'the encoded credential appears nowhere in --json');
      ok(!r.stderr.includes(encoded), 'nor on stderr');
      // The bare PAT, base64'd without the user prefix, must not appear either.
      const bare = Buffer.from(WITH_PAT.AZURE_DEVOPS_PAT, 'utf8').toString('base64');
      ok(!r.stdout.includes(bare), 'no bare base64 PAT');
    } finally { fx.cleanup(); }
  });

  test('the launch matches the published server contract', () => {
    // microsoft/azure-devops-mcp takes the organization POSITIONALLY and has no
    // --organization/--project flags; passing them makes the server exit at
    // startup. Pinned here because it is a contract with someone else's CLI.
    const fx = makeRepo();
    try {
      const d = JSON.parse(aidev(['mcp', 'azure-devops', '--json'],
        { cwd: fx.root, env: WITH_PAT }).stdout);
      ok(!d.args.includes('--organization'), `no --organization flag: ${d.args.join(' ')}`);
      ok(!d.args.includes('--project'), `no --project flag: ${d.args.join(' ')}`);
      const pkgAt = d.args.indexOf(d.package);
      eq(d.args[pkgAt + 1], 'my-org', 'organization is positional, right after the package spec');
      // Without this the server defaults to interactive browser sign-in, which
      // in a headless session fails as an opaque error at the first tool call.
      const authAt = d.args.indexOf('--authentication');
      ok(authAt > -1, `authentication mode is explicit: ${d.args.join(' ')}`);
      eq(d.args[authAt + 1], 'pat', 'non-interactive PAT mode');
      eq(d.credentialEnv, 'PERSONAL_ACCESS_TOKEN', 'names the variable the server actually reads');
    } finally { fx.cleanup(); }
  });

  suite('cli: eject');

  test('--dry-run writes nothing and removes nothing', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['eject', '--dry-run'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit');
      ok(fs.existsSync(cfgMod.lockPath(fx.root)), '.aidev/materialized.json still present');
      ok(fs.existsSync(cfgMod.policyPath(fx.root)), 'policy still present');
      ok(!fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'no marker written');
    } finally { fx.cleanup(); }
  });

  test('ejecting without --yes refuses', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['eject'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/--yes/.test(r.stderr), 'names the confirmation flag');
      ok(fs.existsSync(cfgMod.lockPath(fx.root)), 'nothing was removed');
    } finally { fx.cleanup(); }
  });

  test('--yes removes the control surface and writes the marker', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['eject', '--yes'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit');
      ok(!fs.existsSync(cfgMod.lockPath(fx.root)), '.aidev/materialized.json removed');
      ok(!fs.existsSync(cfgMod.policyPath(fx.root)), 'policy removed');
      const markerPath = cfgMod.ejectMarkerPath(fx.root);
      eq(path.relative(fx.root, markerPath).replace(/\\/g, '/'), '.aidev/ejected.json', 'marker lives in .aidev/');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      ok(marker.ejectedAt, 'marker records when');
      ok(Array.isArray(marker.removed), 'marker lists what was removed');
    } finally { fx.cleanup(); }
  });

  test('eject keeps the PKG, the Wiki and team-authored content', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'workflows', 'mine.yaml'), 'name: mine\n');
      aidev(['eject', '--yes'], { cwd: fx.root });
      ok(fs.existsSync(path.join(fx.root, 'src', 'api', 'auth.ts')), 'PKG files intact');
      ok(fs.existsSync(path.join(fx.root, 'config', 'secrets', 'key.pem')), 'even the secret ones');
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'manifest.json')), 'Wiki intact');
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'workflows', 'mine.yaml')), 'workflows intact');
      ok(fs.existsSync(cfgMod.configPath(fx.root)), 'aidev.yaml kept (it records the hosting mapping)');
      // The clone must still be the same git repository, not an orphaned tree.
      ok(fs.existsSync(path.join(fx.root, '.git')), 'git repository intact');
    } finally { fx.cleanup(); }
  });

  test('eject unregisters the clone from AIDEV_HOME', () => {
    const fx = makeRepo();
    try {
      home.registerPackage(fx.root, { name: 'my-pkg' }, HOME_ENV);
      ok(registered(fx.root), 'registered first');
      eq(aidev(['eject', '--yes'], { cwd: fx.root }).code, EXIT.OK, 'exit');
      ok(!registered(fx.root), 'no longer in the registry, so "aidev update" stops listing it');
    } finally { fx.cleanup(); }
  });

  test('check exits 0 and reports the repo as ejected', () => {
    // The spec's actual promise: 以後 check 対象外.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit 0');
      ok(/eject/i.test(r.stdout), `says so: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('check --json stays parseable after ejecting', () => {
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      const d = JSON.parse(aidev(['check', '--no-remote', '--json'], { cwd: fx.root }).stdout);
      eq(d.ejected, true, 'flagged');
      eq(d.exitCode, EXIT.OK, 'exitCode 0');
    } finally { fx.cleanup(); }
  });

  test('an ejected repo does not fail check on drift it can no longer fix', () => {
    // Without the exemption this is exit 2 forever: the lock is gone, so
    // detectDrift reports noLock on every run.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      write(path.join(fx.root, 'CLAUDE.md'), '# hand-maintained now\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.OK, 'still 0');
    } finally { fx.cleanup(); }
  });

  test('eject unwires kit hooks but keeps team-owned ones', () => {
    const fx = makeRepo({ withHooks: true });
    try {
      aidev(['eject', '--yes', '--keep-assets'], { cwd: fx.root });
      const s = JSON.parse(fs.readFileSync(path.join(fx.root, '.claude', 'settings.json'), 'utf8'));
      const all = JSON.stringify(s);
      ok(!/aidev(?:\.js)?\s+hook/.test(all), `no kit hooks remain: ${all}`);
      ok(/team-owned-hook/.test(all), 'the team\'s own hook survives');
    } finally { fx.cleanup(); }
  });

  test('hooks are unwired before the policy is removed', () => {
    // The ordering that matters: loadPolicy falls back to a RESTRICTIVE policy
    // when the file is absent, and guard-write fails closed. A repo left with
    // live hooks and no policy would be maximally locked, not unmanaged.
    const fx = makeRepo({ withHooks: true });
    try {
      aidev(['eject', '--yes', '--keep-assets'], { cwd: fx.root });
      ok(!fs.existsSync(cfgMod.policyPath(fx.root)), 'policy gone');
      const s = JSON.parse(fs.readFileSync(path.join(fx.root, '.claude', 'settings.json'), 'utf8'));
      ok(!/aidev(?:\.js)?\s+hook/.test(JSON.stringify(s)), 'and no hook is left to consult it');
    } finally { fx.cleanup(); }
  });

  test('the shipped string-form hooks are recognised as kit hooks', () => {
    // The real settings.json wires `aidev hook <name>`; eject must strip that
    // form, or a real PKG would keep every hook live after ejecting.
    const fx = makeRepo({ realTemplates: true });
    try {
      const before = JSON.parse(fs.readFileSync(path.join(fx.root, '.claude', 'settings.json'), 'utf8'));
      ok(Object.keys(before.hooks || {}).length > 0, 'the real template wires hooks');
      const r = aidev(['eject', '--yes', '--keep-assets', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      ok(JSON.parse(r.stdout).hooksRemoved.length >= 4, 'every shipped hook was unwired');
      const after = JSON.parse(fs.readFileSync(path.join(fx.root, '.claude', 'settings.json'), 'utf8'));
      ok(!/aidev hook/.test(JSON.stringify(after)), 'no aidev hook remains');
    } finally { fx.cleanup(); }
  });

  test('a second eject is a no-op, not a failure', () => {
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      const r = aidev(['eject', '--yes'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'idempotent');
      ok(/already/i.test(r.stdout), 'says it was already ejected');
    } finally { fx.cleanup(); }
  });

  test('eject refuses a directory that was never kit-managed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      const r = aidev(['eject', '--yes'], { cwd: dir });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/does not look kit-managed/.test(r.stderr), 'message');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('eject refuses while a publish lease is live', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'sync.lock'), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const r = aidev(['eject', '--yes'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/publish/i.test(r.stderr), 'explains why');
      ok(fs.existsSync(cfgMod.policyPath(fx.root)), 'nothing removed');
    } finally { fx.cleanup(); }
  });

  test('--keep-assets leaves CLAUDE.md and .mcp.json in place', () => {
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes', '--keep-assets'], { cwd: fx.root });
      ok(fs.existsSync(path.join(fx.root, 'CLAUDE.md')), 'CLAUDE.md kept');
      ok(fs.existsSync(path.join(fx.root, '.mcp.json')), '.mcp.json kept');
      ok(fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'still ejected');
    } finally { fx.cleanup(); }
  });

  test('by default the kit-owned assets are removed', () => {
    // Leaving CLAUDE.md behind would keep instructing agents to use a kit that
    // is no longer installed.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      ok(!fs.existsSync(path.join(fx.root, 'CLAUDE.md')), 'CLAUDE.md removed');
      ok(!fs.existsSync(path.join(fx.root, '.mcp.json')), '.mcp.json removed');
      ok(!fs.existsSync(path.join(fx.root, '.claude', 'settings.json')), 'settings.json removed');
    } finally { fx.cleanup(); }
  });

  test('the eject marker is a protected path an agent cannot write', () => {
    // Otherwise an agent could switch enforcement off by creating one file.
    const fx = makeRepo();
    try {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-hook-')), 'input.json');
      fs.writeFileSync(f, JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, '.aidev', 'ejected.json'), content: '{}' },
      }), 'utf8');
      const r = aidev(['hook', 'guard-write', '--input', f], { cwd: fx.root });
      ok(/"permissionDecision":\s*"deny"/.test(r.stdout), `denied: ${r.stdout}`);
      ok(/protected/.test(r.stdout), 'by the protected rule, not merely read-only');
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } finally { fx.cleanup(); }
  });

  test('the marker is found even when aidev.yaml is deleted too', () => {
    // findRepoRoot keys on aidev.yaml or a .aidev/ directory. The marker lives
    // inside .aidev/, so a team that also deletes aidev.yaml is still exempt
    // rather than judged at the git toplevel.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      fs.rmSync(cfgMod.configPath(fx.root), { force: true });
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'still exempt');
      ok(/eject/i.test(r.stdout), 'found the marker');
    } finally { fx.cleanup(); }
  });

  test('doctor stays green on an ejected repo', () => {
    // CI runs `aidev check` and `aidev doctor` together. Exempting only check
    // would still break the pipeline.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      const r = aidev(['doctor'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `doctor exit 0: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('eject refuses to rewrite an unparseable settings.json', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.claude', 'settings.json'), '{ not json');
      const r = aidev(['eject', '--yes'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/not valid JSON/.test(r.stderr), 'message');
      ok(fs.existsSync(cfgMod.policyPath(fx.root)), 'nothing removed');
    } finally { fx.cleanup(); }
  });

  test('eject --json emits exactly one JSON document', () => {
    // The same stdout-purity contract check --json keeps: a bare ui.ok() for the
    // unwired hooks used to print a line before the document on a hooked repo.
    const fx = makeRepo({ withHooks: true });
    try {
      const r = aidev(['eject', '--yes', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit');
      const d = JSON.parse(r.stdout);
      eq(d.ejected, true, 'flagged');
      ok(d.hooksRemoved.length > 0, 'still reports the hooks in the document');
      eq(d.marker, '.aidev/ejected.json', 'names the marker');
    } finally { fx.cleanup(); }
  });

  test('reported paths use forward slashes on every platform', () => {
    // The marker gets committed; a Windows developer's record must read the same
    // as CI's on Linux, and match the policy globs, which are all "/"-shaped.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      const m = JSON.parse(fs.readFileSync(cfgMod.ejectMarkerPath(fx.root), 'utf8'));
      ok(!m.removed.some((r) => r.includes('\\')), `no backslashes: ${JSON.stringify(m.removed)}`);
      ok(m.removed.includes('.aidev/policy.yaml'), `policy recorded portably: ${JSON.stringify(m.removed)}`);
      ok(m.removed.includes('.aidev/materialized.json'), `lock recorded: ${JSON.stringify(m.removed)}`);
    } finally { fx.cleanup(); }
  });

  test('the runtime cache is removed with the rest of the control surface', () => {
    // .aidev/ itself stays: it still holds the Wiki and the marker.
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'cache', 'remote-check.json'), '{}\n');
      aidev(['eject', '--yes', '--force'], { cwd: fx.root });
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'cache')), 'cache removed');
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge')), '.aidev/knowledge kept');
      ok(fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'marker in place');
    } finally { fx.cleanup(); }
  });

  suite('cli: re-adoption after eject');

  test('init clears the marker so the repo is enforced again', () => {
    // The defect this pins: init reported success while check still exempted the
    // repo, so CI went green on a repository nobody was enforcing.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      ok(fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'ejected first');
      const r = aidev(['init', '--yes'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `init exit: ${r.stderr}`);
      ok(!fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'marker cleared');
      ok(fs.existsSync(cfgMod.lockPath(fx.root)), 'tool configuration recorded again');
      ok(registered(fx.root), 'registered again');
      const chk = aidev(['check', '--no-remote'], { cwd: fx.root });
      ok(!/ejected/i.test(chk.stdout), `check no longer reports ejected: ${chk.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('a re-adopted repo is judged again, not silently exempt', () => {
    // After re-adoption the policy is deliberately absent until a human approves
    // one, so check must say so (exit 3) rather than pass.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      aidev(['init', '--yes'], { cwd: fx.root });
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'policy.candidate.yaml')), 'a candidate awaits approval');
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.PERMISSION, `enforcement is back: exit ${r.code}`);
    } finally { fx.cleanup(); }
  });

  test('init --approve places the policy straight away on re-adoption', () => {
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      eq(aidev(['init', '--yes', '--approve'], { cwd: fx.root }).code, EXIT.OK, 'init');
      ok(fs.existsSync(cfgMod.policyPath(fx.root)), 'policy placed');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.OK, 'fully managed again');
    } finally { fx.cleanup(); }
  });

  test('init --dry-run does not clear the marker', () => {
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      aidev(['init', '--yes', '--dry-run'], { cwd: fx.root });
      ok(fs.existsSync(cfgMod.ejectMarkerPath(fx.root)), 'still ejected after a dry run');
    } finally { fx.cleanup(); }
  });

  test('doctor stays green on an ejected repo with no aidev.yaml', () => {
    // Ejecting and then deleting aidev.yaml is a supported end state; doctor
    // graded the absent config and policy as blocking failures.
    const fx = makeRepo();
    try {
      aidev(['eject', '--yes'], { cwd: fx.root });
      fs.rmSync(cfgMod.configPath(fx.root), { force: true });
      const r = aidev(['doctor'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `doctor exit 0: ${r.stdout}`);
      ok(/ejected/i.test(r.stdout), 'explains why nothing is expected');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
