'use strict';
/**
 * Tests for `aidev uninstall`.
 *
 * Every test gets its own AIDEV_HOME and AIDEV_BIN_DIR: the command removes
 * both, and the real per-machine area must never be the one it removes. The
 * kit checkout and the registered packages must survive every run — that is
 * the command's contract, and the fixture package is checked for it.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, write } = require('./fixtures');
const { EXIT } = require('../cli/lib/errors');
const home = require('../cli/lib/home');
const uninstall = require('../cli/commands/uninstall');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');
const INSTALL_ROOT = path.resolve(__dirname, '..');

/** A throwaway machine: AIDEV_HOME with a registry and cache, a bin dir with launchers. */
function makeMachine({ launchers = true, foreign = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-uninstall-'));
  const homeDir = path.join(base, 'home');
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, 'cache'), { recursive: true });
  write(path.join(homeDir, 'cache', 'update-check.json'), '{}\n');
  home.writeRegistry({ schemaVersion: 1, packages: [] }, { AIDEV_HOME: homeDir });
  if (launchers) {
    write(path.join(binDir, 'aidev.cmd'), `@echo off\r\nREM ${uninstall.LAUNCHER_MARKER} scripts\\install.ps1\r\nnode "x" %*\r\n`);
    write(path.join(binDir, 'aidev.ps1'), `# ${uninstall.LAUNCHER_MARKER} scripts\\install.ps1\n& node "x" @args\n`);
    write(path.join(binDir, 'aidev'), `#!/usr/bin/env bash\n# ${uninstall.LAUNCHER_MARKER} scripts/install.sh\nexec node "x" "$@"\n`);
  }
  if (foreign) write(path.join(binDir, 'aidev.cmd'), '@echo off\r\nREM somebody else\'s shim\r\n');
  const env = { AIDEV_HOME: homeDir, AIDEV_BIN_DIR: binDir };
  return {
    base, homeDir, binDir, env,
    cleanup() { fs.rmSync(base, { recursive: true, force: true }); },
  };
}

function aidev(args, { cwd = os.tmpdir(), env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', AIDEV_NO_UPDATE_CHECK: '1', ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function run() {
  suite('cli: uninstall');

  test('--dry-run lists the launcher and AIDEV_HOME files and writes nothing', () => {
    const m = makeMachine();
    try {
      const r = aidev(['uninstall', '--dry-run'], { env: m.env });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      ok(r.stdout.includes(path.join(m.binDir, 'aidev.cmd')), `lists the launcher: ${r.stdout}`);
      ok(r.stdout.includes(path.join(m.homeDir, 'registry.json')), 'lists the registry');
      ok(fs.existsSync(path.join(m.binDir, 'aidev.cmd')), 'launcher still there');
      ok(fs.existsSync(path.join(m.homeDir, 'registry.json')), 'registry still there');
    } finally { m.cleanup(); }
  });

  test('without --yes it refuses and removes nothing', () => {
    const m = makeMachine();
    try {
      const r = aidev(['uninstall'], { env: m.env });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/--yes/.test(r.stderr), 'names the confirmation flag');
      ok(fs.existsSync(path.join(m.binDir, 'aidev')), 'nothing removed');
      ok(fs.existsSync(path.join(m.homeDir, 'cache', 'update-check.json')), 'cache intact');
    } finally { m.cleanup(); }
  });

  test('--yes removes the generated launchers, the registry and the cache', () => {
    const m = makeMachine();
    try {
      const r = aidev(['uninstall', '--yes'], { env: m.env });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      for (const n of ['aidev.cmd', 'aidev.ps1', 'aidev']) ok(!fs.existsSync(path.join(m.binDir, n)), `${n} removed`);
      ok(!fs.existsSync(path.join(m.homeDir, 'registry.json')), 'registry removed');
      ok(!fs.existsSync(path.join(m.homeDir, 'cache')), 'cache removed');
      ok(!fs.existsSync(m.binDir), 'empty bin dir pruned');
      ok(!fs.existsSync(m.homeDir), 'empty AIDEV_HOME pruned');
    } finally { m.cleanup(); }
  });

  test('a launcher without the installer marker is somebody else\'s and is kept', () => {
    const m = makeMachine({ launchers: false, foreign: true });
    try {
      write(path.join(m.homeDir, 'notes.txt'), 'mine\n');
      eq(aidev(['uninstall', '--yes'], { env: m.env }).code, EXIT.OK, 'exit');
      ok(fs.existsSync(path.join(m.binDir, 'aidev.cmd')), 'foreign shim kept');
      ok(fs.existsSync(path.join(m.homeDir, 'notes.txt')), 'unknown file under AIDEV_HOME kept');
      ok(fs.existsSync(m.homeDir), 'non-empty AIDEV_HOME kept');
    } finally { m.cleanup(); }
  });

  test('the kit checkout is never deleted, only named with the command to delete it', () => {
    const m = makeMachine();
    try {
      const d = JSON.parse(aidev(['uninstall', '--yes', '--json'], { env: m.env }).stdout);
      eq(d.ok, true, 'ok');
      ok(d.checkout.includes(INSTALL_ROOT), `names the checkout: ${d.checkout}`);
      ok(fs.existsSync(path.join(INSTALL_ROOT, 'cli', 'bin', 'aidev.js')), 'checkout intact');
      ok(!d.removed.some((f) => f.startsWith(INSTALL_ROOT)), 'nothing under the checkout was removed');
    } finally { m.cleanup(); }
  });

  test('a registered package is kept and gets the commands that would remove the kit files', () => {
    const m = makeMachine();
    const fx = makeRepo({ realTemplates: true });
    try {
      // The team's own file next to ours keeps .claude from being folded whole.
      write(path.join(fx.root, '.claude', 'settings.local.json'), '{}\n');
      home.registerPackage(fx.root, { name: 'my-pkg' }, { AIDEV_HOME: m.homeDir });
      const r = aidev(['uninstall', '--yes'], { env: m.env });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      ok(r.stdout.includes(fx.root), `names the package: ${r.stdout}`);
      ok(/aidev uninstall \S+ --yes/.test(r.stdout), 'points at "aidev uninstall <package>" while the CLI still exists');
      const rm = r.stdout.split('\n').find((l) => /git rm -r -q --/.test(l)) || '';
      for (const p of ['CLAUDE.md', '.claude/settings.json', '.claude/agents', '.claude/skills', '.aidev', 'aidev.yaml']) {
        ok(new RegExp(`\\s${p.replace(/\./g, '\\.')}(\\s|$)`).test(rm), `git rm names ${p}: ${rm}`);
      }
      ok(!/\s\.claude(\s|$)/.test(rm), 'does not fold .claude while settings.local.json lives there');
      ok(!/\.claude\/agents\//.test(rm), 'agents are folded into their directory');
      // Nothing in the package moved.
      for (const rel of ['CLAUDE.md', '.claude/settings.json', '.aidev/policy.yaml', '.aidev/knowledge/manifest.json', 'aidev.yaml']) {
        ok(fs.existsSync(path.join(fx.root, ...rel.split('/'))), `${rel} still in the package`);
      }
    } finally { fx.cleanup(); m.cleanup(); }
  });

  test('collapsePaths stays file-level where the team keeps its own files', () => {
    const fx = makeRepo({ realTemplates: true });
    try {
      write(path.join(fx.root, '.claude', 'agents', 'team-agent.md'), '# ours\n');
      const files = ['.claude/agents/issue-to-pr.md', '.claude/agents/knowledge-builder.md', '.claude/skills/code-review/SKILL.md'];
      const out = uninstall.collapsePaths(fx.root, files);
      ok(out.includes('.claude/agents/issue-to-pr.md'), `agent files stay listed one by one: ${out}`);
      ok(!out.includes('.claude/agents'), 'the agents dir is not folded');
      ok(out.includes('.claude/skills/code-review'), 'a wholly-owned skill dir is folded');
    } finally { fx.cleanup(); }
  });

  test('--json after a previous uninstall reports nothing to remove and exits 0', () => {
    const m = makeMachine();
    try {
      aidev(['uninstall', '--yes'], { env: m.env });
      const r = aidev(['uninstall', '--yes', '--json'], { env: m.env });
      eq(r.code, EXIT.OK, 'exit');
      const d = JSON.parse(r.stdout);
      eq(d.removed, [], 'nothing left');
    } finally { m.cleanup(); }
  });

  test('--json prints one document and nothing else', () => {
    const m = makeMachine();
    try {
      const r = aidev(['uninstall', '--dry-run', '--json'], { env: m.env });
      const d = JSON.parse(r.stdout);
      eq(d.dryRun, true, 'flagged');
      eq(d.launchers.length, 3, 'three launchers');
      ok(Array.isArray(d.packages), 'packages array');
    } finally { m.cleanup(); }
  });
}

module.exports = { run };
