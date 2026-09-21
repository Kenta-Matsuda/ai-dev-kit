'use strict';
/**
 * CLI-level tests: the binary is run as a real subprocess inside a PKG clone.
 *
 * Testing through the process boundary is deliberate — the exit code and the
 * purity of stdout are the public contract that branch policies, CI and the
 * PreToolUse hook depend on. Calling run() in-process would verify neither.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, pullPkg, write, git } = require('./fixtures');
const { EXIT } = require('../cli/lib/errors');
const layout = require('../cli/lib/layout');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');

/**
 * One AIDEV_HOME for the whole run: the registry and the update-check cache
 * must never land in the developer's real per-machine area.
 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-home-'));

/** Run the CLI and capture code/stdout/stderr separately. */
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

/** Feed a hook its payload through --input, as the hook harness does. */
function hook(name, payload, cwd, env = {}) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-hook-')), 'input.json');
  fs.writeFileSync(f, JSON.stringify(payload), 'utf8');
  const r = aidev(['hook', name, '--input', f], { cwd, env });
  try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* best effort */ }
  return r;
}

const MANIFEST_REL = `${layout.KNOWLEDGE_REL}/manifest.json`;
function manifestPath(root) { return path.join(root, ...MANIFEST_REL.split('/')); }
function readManifest(root) { return JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')); }
function writeManifest(root, m) { fs.writeFileSync(manifestPath(root), JSON.stringify(m, null, 2)); }

const DENIED = /"permissionDecision":\s*"deny"/;
const ALLOWED = /"permissionDecision":\s*"allow"/;

function run() {
  suite('cli: entry point');

  test('--version prints a version and exits 0', () => {
    const r = aidev(['--version']);
    eq(r.code, EXIT.OK, 'exit');
    ok(/^\d+\.\d+\.\d+/.test(r.stdout.trim()), `version-ish output, got ${JSON.stringify(r.stdout)}`);
  });

  test('--help lists every command', () => {
    const r = aidev(['--help']);
    eq(r.code, EXIT.OK, 'exit');
    for (const c of ['init', 'status', 'check', 'sync', 'knowledge', 'permission', 'task', 'workflow',
      'update', 'doctor', 'eject', 'hook', 'mcp']) {
      ok(new RegExp(`^\\s+${c}\\b`, 'm').test(r.stdout), `help mentions ${c}`);
    }
  });

  test('--help no longer lists the removed plan and kit commands', () => {
    const r = aidev(['--help']);
    ok(!/^\s+plan\b/m.test(r.stdout), 'plan is gone');
    ok(!/^\s+kit\b/m.test(r.stdout), 'kit apply is gone');
  });

  test('no arguments prints usage rather than failing', () => {
    eq(aidev([]).code, EXIT.OK, 'exit');
  });

  test('unknown command exits 1 and names the mistake', () => {
    const r = aidev(['nonesuch']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown command: nonesuch/.test(r.stderr), 'message');
  });

  test('the removed plan command is an unknown command, not a silent no-op', () => {
    const r = aidev(['plan']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown command: plan/.test(r.stderr), `message: ${r.stderr}`);
  });

  test('unknown option is rejected, not ignored', () => {
    const r = aidev(['status', '--no-such-flag']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown option/.test(r.stderr), 'message');
  });

  test('a typo in --dry-run cannot silently become a real run', () => {
    // The whole reason unknown flags are fatal.
    const r = aidev(['sync', '--dryrun']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown option/.test(r.stderr), 'message');
  });

  test('two-word command without a subcommand explains itself', () => {
    const r = aidev(['knowledge']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/requires a subcommand/.test(r.stderr), 'message');
  });

  test('unknown subcommand is rejected', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['knowledge', 'frobnicate'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/unknown subcommand/.test(r.stderr), 'message');
    } finally { fx.cleanup(); }
  });

  test('per-command --help shows that command\'s flags', () => {
    const r = aidev(['knowledge', '--help']);
    eq(r.code, EXIT.OK, 'exit');
    ok(r.stdout.includes('--scope'), 'lists --scope');
    ok(r.stdout.includes('--full'), 'lists --full');
    ok(r.stdout.includes('--no-remote'), 'lists --no-remote');
    // Accepted for compatibility but hidden: nobody should be steered to it.
    ok(!r.stdout.includes('--refresh'), 'does not advertise the no-op --refresh');
  });

  test('update --help documents the self-update and re-apply flags', () => {
    const r = aidev(['update', '--help']);
    eq(r.code, EXIT.OK, 'exit');
    for (const f of ['--all', '--kit-only', '--dry-run', '--force', '--json']) {
      ok(r.stdout.includes(f), `lists ${f}`);
    }
  });

  test('every command answers --help without needing a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      for (const c of ['init', 'status', 'check', 'sync', 'knowledge', 'permission', 'task', 'workflow',
        'update', 'doctor', 'eject', 'hook', 'mcp']) {
        const r = aidev([c, '--help'], { cwd: dir });
        eq(r.code, EXIT.OK, `${c} --help exit: ${r.stderr}`);
        ok(r.stdout.includes(`aidev ${c}`), `${c} --help names itself`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--no-remote is accepted by every command that reads remote state', () => {
    const fx = makeRepo();
    try {
      for (const args of [['check'], ['status'], ['knowledge', 'status']]) {
        const r = aidev([...args, '--no-remote'], { cwd: fx.root });
        ok(!/unknown option/.test(r.stderr), `${args.join(' ')} accepts --no-remote`);
      }
    } finally { fx.cleanup(); }
  });

  suite('cli: status');

  test('status outside a package exits 1 and points at init', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      const r = aidev(['status'], { cwd: dir });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/aidev init/.test(r.stdout + r.stderr), 'message points at init');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('status in a set-up clone exits 0 and names the package', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['status', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      ok(/my-pkg/.test(r.stdout), `names the package: ${r.stdout}`);
      ok(/\[ai-dev-kit\] base=/.test(r.stdout), 'prints the three-SHA summary');
    } finally { fx.cleanup(); }
  });

  test('status is informational: a warning state still exits 0', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const r = aidev(['status', '--no-remote', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit');
      eq(JSON.parse(r.stdout).state.severity, 'warn', 'reports the moved code as a warning');
    } finally { fx.cleanup(); }
  });

  suite('cli: exit-code contract');

  test('a directory without aidev.yaml is not judged (exit 0)', () => {
    // CI may run "aidev check" across many repos; one that never adopted the
    // kit is not a failure, it is simply not managed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      const r = aidev(['check'], { cwd: dir });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      ok(/not an ai-dev-kit package/.test(r.stdout), `says so: ${r.stdout}`);
      const j = JSON.parse(aidev(['check', '--json'], { cwd: dir }).stdout);
      eq(j.managed, false, '--json flags it as unmanaged');
      eq(j.exitCode, EXIT.OK, 'exitCode 0');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing .aidev/materialized.json is drift (exit 2)', () => {
    const fx = makeRepo({ withLock: false });
    try {
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.DRIFT, 'exit 2');
      ok(/materialized\.json/.test(r.stderr), `names the record: ${r.stderr}`);
    } finally { fx.cleanup(); }
  });

  test('a kit-owned file edited by hand is drift (exit 2)', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, 'CLAUDE.md'), '# edited behind the kit\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'exit 2');
    } finally { fx.cleanup(); }
  });

  test('a missing policy is exit 3', () => {
    const fx = makeRepo({ withPolicy: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.PERMISSION, 'exit 3');
    } finally { fx.cleanup(); }
  });

  test('a manifest without a valid knowledgeSha is exit 4', () => {
    const fx = makeRepo();
    try {
      const m = readManifest(fx.root);
      m.knowledgeSha = 'not-a-sha';
      writeManifest(fx.root, m);
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.KNOWLEDGE, 'exit 4');
      const s = aidev(['knowledge', 'status', '--no-remote'], { cwd: fx.root });
      eq(s.code, EXIT.KNOWLEDGE, 'knowledge status agrees');
    } finally { fx.cleanup(); }
  });

  test('a missing Wiki is exit 4, not a crash', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.KNOWLEDGE, 'exit 4');
    } finally { fx.cleanup(); }
  });

  test('a Wiki describing a commit this clone lacks is a warning, not an error', () => {
    // Someone else's sync may have landed; the developer needs to fetch, not
    // stop working. --strict is how CI turns that warning into a failure.
    const fx = makeRepo();
    try {
      const m = readManifest(fx.root);
      m.knowledgeSha = 'a'.repeat(40);
      writeManifest(fx.root, m);
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.OK, 'exit 0');
      eq(aidev(['check', '--no-remote', '--strict'], { cwd: fx.root }).code, EXIT.DRIFT, '--strict fails it');
    } finally { fx.cleanup(); }
  });

  test('code that moved under the Wiki is a warning; --strict makes it exit 2', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit 0: ${r.stderr}`);
      ok(/aidev sync/.test(r.stdout), `suggests a sync: ${r.stdout}`);
      eq(aidev(['check', '--no-remote', '--strict'], { cwd: fx.root }).code, EXIT.DRIFT, '--strict');
    } finally { fx.cleanup(); }
  });

  test('drift outranks consistency when both are broken', () => {
    // Ordering is part of the contract: the log must name what to fix first.
    const fx = makeRepo();
    try {
      const m = readManifest(fx.root);
      m.knowledgeSha = 'not-a-sha';
      writeManifest(fx.root, m);
      // Break a kit-owned file so both conditions genuinely hold at once.
      write(path.join(fx.root, 'CLAUDE.md'), '# edited behind the kit\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'drift wins');
    } finally { fx.cleanup(); }
  });

  test('drift outranks a missing policy', () => {
    const fx = makeRepo({ withLock: false, withPolicy: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'drift wins');
    } finally { fx.cleanup(); }
  });

  test('a stale sync lease is exit 4 and names the recovery', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'sync.lock'), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: '2000-01-01T00:00:00.000Z', ttlMinutes: 1,
      }));
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.KNOWLEDGE, 'exit 4');
      ok(/--resume|--abort/.test(r.stderr), `names the recovery: ${r.stderr}`);
    } finally { fx.cleanup(); }
  });

  suite('cli: --json purity');

  test('check --json emits exactly one JSON document on stdout', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['check', '--no-remote', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      ok(typeof parsed === 'object' && parsed !== null, 'parsed an object');
      ok('exitCode' in parsed, 'carries exitCode');
      eq(parsed.knowledgeSha, fx.pkgSha, 'reports the Wiki SHA');
    } finally { fx.cleanup(); }
  });

  test('status --json is parseable and carries the state', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['status', '--no-remote', '--json'], { cwd: fx.root });
      const d = JSON.parse(r.stdout);
      eq(d.package, 'my-pkg', 'package name');
      eq(d.hosting, 'azure-devops', 'hosting');
      ok(d.state && d.state.severity, 'has state');
      eq(d.drift.ok, true, 'no drift on a fresh fixture');
      eq(d.policy.ok, true, 'policy valid');
    } finally { fx.cleanup(); }
  });

  test('knowledge status --json is parseable', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['knowledge', 'status', '--no-remote', '--json'], { cwd: fx.root });
      ok(JSON.parse(r.stdout).state, 'has state');
    } finally { fx.cleanup(); }
  });

  test('knowledge build --json prints no human output before the JSON', () => {
    // The regression this guards: ui.heading/ui.table ran before ui.json.
    const fx = makeRepo();
    try {
      const r = aidev(['knowledge', 'build', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      eq(parsed.ok, true, 'ok');
      ok(Array.isArray(parsed.pending), 'pending is a list');
    } finally { fx.cleanup(); }
  });

  test('sync --check-only --json is parseable', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['sync', '--check-only', '--json'], { cwd: fx.root });
      ok(JSON.parse(r.stdout).severity, 'has a severity');
    } finally { fx.cleanup(); }
  });

  suite('cli: knowledge build');

  test('build writes a manifest recording the base SHA', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['knowledge', 'build'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      const m = readManifest(fx.root);
      // HEAD == origin/main, so the base this work stands on is HEAD itself.
      eq(m.knowledgeSha, fx.setupSha, 'knowledgeSha');
      eq(m.schemaVersion, 3, 'schemaVersion');
      ok(m.inventoryShards.length > 0, 'wrote shards');
    } finally { fx.cleanup(); }
  });

  test('build excludes secrets_paths and kit-managed files from the inventory', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      const m = readManifest(fx.root);
      const rows = m.inventoryShards.flatMap((s) =>
        JSON.parse(fs.readFileSync(path.join(fx.root, ...layout.KNOWLEDGE_REL.split('/'), ...s.split('/')), 'utf8')));
      ok(rows.length > 0, 'something was inventoried');
      ok(!rows.some((r) => r.path.includes('secrets')), 'no secret file is inventoried');
      ok(!rows.some((r) => layout.isKitManaged(r.path)), `no kit file is a generation target: ${rows.map((r) => r.path)}`);
      ok(rows.some((r) => r.path === 'src/api/auth.ts'), 'the PKG source is');
    } finally { fx.cleanup(); }
  });

  test('--dry-run writes nothing', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      eq(aidev(['knowledge', 'build', '--dry-run'], { cwd: fx.root }).code, EXIT.OK, 'exit');
      ok(!fs.existsSync(manifestPath(fx.root)), 'no manifest written');
    } finally { fx.cleanup(); }
  });

  test('build creates .aidev/knowledge/index.md when absent', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'index.md')), 'index.md exists');
    } finally { fx.cleanup(); }
  });

  test('--scope narrows what is queued', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['knowledge', 'build', '--scope', 'docs', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      ok(parsed.pending.length > 0, 'something in scope was queued');
      ok(parsed.pending.every((p) => p.startsWith('docs')), `only docs queued: ${parsed.pending}`);
      ok(parsed.deferred.length > 0, 'out-of-scope changes are reported as deferred');
    } finally { fx.cleanup(); }
  });

  test('--scope matching nothing is an error, not a silent no-op', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['knowledge', 'build', '--scope', 'src/nowhere'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/matched no files/.test(r.stderr), 'message');
    } finally { fx.cleanup(); }
  });

  test('a hand-edited page halts the build until --force', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      // Record a page hash, then edit that page behind the generator's back.
      const pageRel = `${layout.KNOWLEDGE_REL}/api/auth.md`;
      write(path.join(fx.root, ...pageRel.split('/')), '# auth\n');
      const shardPath = path.join(fx.root, '.aidev', 'knowledge', 'inventory', '00.json');
      const rows = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
      const crypto = require('crypto');
      rows[0].pages = [pageRel];
      rows[0].selfHashes = { [pageRel]: `sha256:${crypto.createHash('sha256').update('# auth\n').digest('hex')}` };
      fs.writeFileSync(shardPath, JSON.stringify(rows, null, 2));
      write(path.join(fx.root, ...pageRel.split('/')), '# auth, edited by a human\n');

      const blocked = aidev(['knowledge', 'build'], { cwd: fx.root });
      eq(blocked.code, EXIT.GENERAL, 'blocked');
      ok(/edited by hand/.test(blocked.stderr), 'explains why');
      const forced = aidev(['knowledge', 'build', '--force'], { cwd: fx.root });
      eq(forced.code, EXIT.OK, '--force proceeds');
    } finally { fx.cleanup(); }
  });

  test('a rename costs no regeneration', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      git(['mv', 'src/api/auth.ts', 'src/api/authentication.ts'], fx.root);
      git(['commit', '-q', '-m', 'rename'], fx.root);
      git(['push', '-q', 'origin', 'main'], fx.root);
      const r = aidev(['knowledge', 'build', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      ok(!parsed.pending.some((p) => p.includes('authentication')), `rename not queued: ${parsed.pending}`);
    } finally { fx.cleanup(); }
  });

  test('the retired --refresh, --resume and --agent flags are rejected', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      for (const f of ['--refresh', '--resume', '--agent']) {
        const r = aidev(['knowledge', 'build', f, '--dry-run'], { cwd: fx.root });
        eq(r.code, EXIT.GENERAL, `${f}: ${r.stderr}`);
        ok(new RegExp(`unknown option: ${f}`).test(r.stderr), `${f}: ${r.stderr}`);
      }
    } finally { fx.cleanup(); }
  });

  suite('cli: hooks');

  test('guard-write denies a write to a protected path', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, '.claude', 'settings.json'), content: 'x' },
      }, fx.root);
      eq(r.code, EXIT.OK, 'hooks always exit 0; the decision is in the JSON');
      const d = JSON.parse(r.stdout);
      eq(d.hookSpecificOutput.permissionDecision, 'deny', `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write denies a write to a secret path', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'config', 'secrets', 'key.pem'), content: 'x' },
      }, fx.root);
      ok(DENIED.test(r.stdout), `denied: ${r.stdout}`);
      ok(/secret/i.test(r.stdout), 'names the reason');
    } finally { fx.cleanup(); }
  });

  test('guard-write denies read-only PKG source without a work lease', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts'), content: 'x' },
      }, fx.root);
      ok(DENIED.test(r.stdout), `denied: ${r.stdout}`);
      ok(/read-only/.test(r.stdout), 'names the rule');
    } finally { fx.cleanup(); }
  });

  test('guard-write denies an ordinary PKG file too: the whole clone is read-only by default', () => {
    // The old wrapper allowed "wrapper-side" files by default; inside the PKG
    // clone there is no such side, so notes.md is PKG content and read-only.
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'notes.md'), content: 'x' },
      }, fx.root);
      ok(DENIED.test(r.stdout), `denied: ${r.stdout}`);
      ok(/read-only/.test(r.stdout), 'by the read-only rule');
    } finally { fx.cleanup(); }
  });

  test('guard-write allows the Wiki and aidev.yaml', () => {
    const fx = makeRepo();
    try {
      for (const rel of [['.aidev', 'knowledge', 'x.md'], ['aidev.yaml']]) {
        const r = hook('guard-write', {
          tool_name: 'Write',
          tool_input: { file_path: path.join(fx.root, ...rel), content: 'x' },
        }, fx.root);
        ok(ALLOWED.test(r.stdout), `${rel.join('/')} allowed: ${r.stdout}`);
      }
    } finally { fx.cleanup(); }
  });

  test('guard-write applies the policy from a nested cwd', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts'), content: 'x' },
      }, path.join(fx.root, 'src'));
      eq(r.code, EXIT.OK, `hook failed from nested cwd: ${r.stderr}`);
      ok(DENIED.test(r.stdout), `policy was not applied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write uses CLAUDE_PROJECT_DIR when the hook runs from elsewhere', () => {
    // Without the project dir, a Wiki path is "outside the repository" seen
    // from an unrelated cwd and would be denied; with it, policy applies.
    const fx = makeRepo();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-elsewhere-'));
    try {
      const payload = {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, '.aidev', 'knowledge', 'x.md'), content: 'x' },
      };
      const without = hook('guard-write', payload, elsewhere);
      ok(DENIED.test(without.stdout), `no project dir → denied: ${without.stdout}`);
      const withDir = hook('guard-write', payload, elsewhere, { CLAUDE_PROJECT_DIR: fx.root });
      eq(withDir.code, EXIT.OK, withDir.stderr);
      ok(ALLOWED.test(withDir.stdout), `project dir honoured: ${withDir.stdout}`);
    } finally { fx.cleanup(); fs.rmSync(elsewhere, { recursive: true, force: true }); }
  });

  test('guard-write inspects Bash redirection targets', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Bash',
        tool_input: { command: 'echo pwned > .claude/settings.json' },
      }, fx.root);
      ok(DENIED.test(r.stdout), `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write fails closed on a malformed payload', () => {
    const fx = makeRepo();
    try {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-hook-')), 'bad.json');
      fs.writeFileSync(f, '{ not json', 'utf8');
      const r = aidev(['hook', 'guard-write', '--input', f], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'still exits 0');
      ok(DENIED.test(r.stdout), `fails closed: ${r.stdout}`);
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } finally { fx.cleanup(); }
  });

  test('guard-write blocks everything while the Wiki is missing', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'aidev.yaml'), content: 'x' },
      }, fx.root);
      ok(DENIED.test(r.stdout), `denied: ${r.stdout}`);
      ok(/consistency/i.test(r.stdout), 'names the consistency gate');
    } finally { fx.cleanup(); }
  });

  test('session-start reports state without failing the session', () => {
    const fx = makeRepo();
    try {
      const r = hook('session-start', {}, fx.root);
      eq(r.code, EXIT.OK, 'exit 0');
      ok(/ai-dev-kit/.test(r.stdout), `summary present: ${r.stdout.slice(0, 200)}`);
      ok(/base=/.test(r.stdout), 'three-SHA line');
    } finally { fx.cleanup(); }
  });

  test('quality-gate runs only when a PKG file was edited', () => {
    const fx = makeRepo({ configExtra: ['quality_gates:', '  version: git --version'] });
    try {
      const kit = hook('quality-gate', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, '.aidev', 'knowledge', 'x.md'), content: 'x' },
      }, fx.root);
      eq(kit.code, EXIT.OK, kit.stderr);
      const kd = JSON.parse(kit.stdout);
      eq(kd.ran, [], 'nothing ran for a kit-managed write');
      ok(kd.skipped, 'says it skipped');

      const pkg = hook('quality-gate', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts'), content: 'x' },
      }, fx.root);
      eq(pkg.code, EXIT.OK, pkg.stderr);
      eq(JSON.parse(pkg.stdout).ran, ['version'], `the gate ran for a PKG write: ${pkg.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('an unknown hook name is rejected', () => {
    const fx = makeRepo();
    try {
      ok(aidev(['hook', 'not-a-hook'], { cwd: fx.root }).code !== EXIT.OK, 'non-zero');
    } finally { fx.cleanup(); }
  });

  suite('cli: sync');

  const syncLockPath = (root) => path.join(root, '.aidev', 'sync.lock');
  const worktreePath = (root) => path.join(root, '.aidev', 'cache', 'sync-worktree');

  test('--check-only writes nothing and judges the state', () => {
    const fx = makeRepo();
    try {
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', '--check-only', '--json'], { cwd: fx.root });
      ok([EXIT.OK, EXIT.KNOWLEDGE].includes(r.code), `judged: exit ${r.code}`);
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'unchanged');
      ok(!fs.existsSync(syncLockPath(fx.root)), 'no lease taken');
    } finally { fx.cleanup(); }
  });

  test('--abort with no lease is a no-op, not an error', () => {
    const fx = makeRepo();
    try {
      eq(aidev(['sync', '--abort'], { cwd: fx.root }).code, EXIT.OK, 'exit 0');
    } finally { fx.cleanup(); }
  });

  test('an existing lease blocks a fresh sync and names the recovery', () => {
    const fx = makeRepo();
    try {
      write(syncLockPath(fx.root), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const r = aidev(['sync'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/--resume|--abort/.test(r.stderr), 'names the recovery');
      ok(fs.existsSync(syncLockPath(fx.root)), 'the lease is left for the operator');
    } finally { fx.cleanup(); }
  });

  test('--abort removes the lease and the worktree without touching the checkout', () => {
    const fx = makeRepo();
    try {
      write(syncLockPath(fx.root), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: fx.setupSha, originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', '--abort', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      ok(!fs.existsSync(syncLockPath(fx.root)), 'lease released');
      ok(!fs.existsSync(worktreePath(fx.root)), 'no worktree left');
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'manifest untouched');
    } finally { fx.cleanup(); }
  });

  test('--to rejects a SHA unreachable from the tracking branch', () => {
    const fx = makeRepo();
    try {
      // A commit on a side branch is never a legitimate sync target.
      git(['checkout', '-q', '-b', 'side'], fx.pkgOrigin);
      write(path.join(fx.pkgOrigin, 'side.txt'), 'side\n');
      git(['add', '-A'], fx.pkgOrigin);
      git(['commit', '-q', '-m', 'side commit'], fx.pkgOrigin);
      const sideSha = git(['rev-parse', 'HEAD'], fx.pkgOrigin);
      git(['push', '-q', 'origin', 'side'], fx.pkgOrigin);
      git(['checkout', '-q', 'main'], fx.pkgOrigin);
      git(['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'], fx.root);
      ok(git(['cat-file', '-t', sideSha], fx.root) === 'commit', 'the side commit is present locally');

      const r = aidev(['sync', '--to', sideSha], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, `refused: exit ${r.code}`);
      ok(/not reachable/.test(r.stderr), `explains why: ${r.stderr}`);
      ok(!fs.existsSync(syncLockPath(fx.root)), 'no lease taken');
    } finally { fx.cleanup(); }
  });

  test('sync is a no-op when the Wiki already describes the tracking branch', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['sync', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      eq(JSON.parse(r.stdout).noop, true, `noop: ${r.stdout}`);
      ok(!fs.existsSync(syncLockPath(fx.root)), 'no lease taken');
    } finally { fx.cleanup(); }
  });

  test('--dry-run reports the change set and writes nothing', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', '--dry-run', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      const d = JSON.parse(r.stdout);
      eq(d.dryRun, true, 'dry run');
      eq(d.targetSha, newSha, 'targets the new tip');
      // The fixture's inventory is empty, so every generation target is new.
      ok(d.diff.added >= 1, `sees the added file: ${JSON.stringify(d.diff)}`);
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'manifest untouched');
      ok(!fs.existsSync(syncLockPath(fx.root)), 'no lease');
      ok(!git(['branch', '--list', `ai/wiki-${newSha.slice(0, 12)}`], fx.root), 'no branch created');
    } finally { fx.cleanup(); }
  });

  test('sync --no-pr commits the Wiki on ai/wiki-<sha> without touching the checkout', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', '--no-pr', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      const d = JSON.parse(r.stdout);
      eq(d.ok, true, 'ok');
      eq(d.targetSha, newSha, 'target is the new tip');
      const branch = `ai/wiki-${newSha.slice(0, 12)}`;
      eq(d.branch, branch, 'branch name');
      eq(d.committed, true, 'committed');
      eq(d.pushed, false, '--no-pr does not push');
      ok(d.pendingPages > 0, 'the new file awaits prose');

      // The commit lives on the local sync branch...
      const shown = git(['show', `${branch}:${MANIFEST_REL}`], fx.root);
      eq(JSON.parse(shown).knowledgeSha, newSha, 'the committed manifest describes the target');
      ok(git(['rev-parse', '--verify', `${branch}^{commit}`], fx.root), 'branch exists');
      ok(!git(['ls-remote', '--heads', 'origin', branch], fx.root), 'nothing was pushed');

      // ...and the developer's checkout is exactly as it was.
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'local manifest untouched');
      eq(git(['rev-parse', 'HEAD'], fx.root), fx.setupSha, 'HEAD did not move');
      eq(git(['status', '--porcelain'], fx.root), '', 'working tree clean');
      ok(!fs.existsSync(syncLockPath(fx.root)), 'lease released');
      ok(!fs.existsSync(worktreePath(fx.root)), 'worktree removed');
    } finally { fx.cleanup(); }
  });

  test('sync pushes the branch and leaves the PR to a human on generic hosting', () => {
    const fx = makeRepo({ hosting: 'generic' });
    try {
      const newSha = advancePkg(fx);
      const r = aidev(['sync', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      const d = JSON.parse(r.stdout);
      eq(d.pushed, true, 'pushed');
      eq(d.pr.ok, false, `no PR API on generic hosting: ${JSON.stringify(d.pr)}`);
      ok(/by hand/.test(d.pr.reason), `tells the human to open it: ${d.pr.reason}`);
      const branch = `ai/wiki-${newSha.slice(0, 12)}`;
      ok(git(['ls-remote', '--heads', 'origin', branch], fx.root).includes(branch), 'branch is on origin');
      ok(!fs.existsSync(syncLockPath(fx.root)), 'lease released');
      ok(!fs.existsSync(worktreePath(fx.root)), 'worktree removed');
    } finally { fx.cleanup(); }
  });

  test('a hand-edited page in the committed Wiki stops sync unless --force', () => {
    const fx = makeRepo();
    try {
      // Commit a Wiki page whose recorded hash no longer matches its content.
      const pageRel = `${layout.KNOWLEDGE_REL}/api/auth.md`;
      const shardPath = path.join(fx.root, '.aidev', 'knowledge', 'inventory', '00.json');
      const crypto = require('crypto');
      fs.writeFileSync(shardPath, JSON.stringify([{
        path: 'src/api/auth.ts', blob: '0'.repeat(40), masked: false, pages: [pageRel],
        selfHashes: { [pageRel]: `sha256:${crypto.createHash('sha256').update('# auth\n').digest('hex')}` },
      }], null, 2));
      write(path.join(fx.root, ...pageRel.split('/')), '# auth, edited by a human\n');
      git(['add', '-A'], fx.root);
      git(['commit', '-q', '-m', 'hand edit'], fx.root);
      git(['push', '-q', 'origin', 'main'], fx.root);
      advancePkg(fx);

      const blocked = aidev(['sync', '--no-pr'], { cwd: fx.root });
      eq(blocked.code, EXIT.GENERAL, `blocked: ${blocked.stdout}`);
      ok(/hand/.test(blocked.stderr), `explains why: ${blocked.stderr}`);
      ok(fs.existsSync(syncLockPath(fx.root)), 'the lease is kept so the state is not hidden');
      eq(aidev(['sync', '--abort'], { cwd: fx.root }).code, EXIT.OK, 'abort');
      const forced = aidev(['sync', '--no-pr', '--force', '--json'], { cwd: fx.root });
      eq(forced.code, EXIT.OK, `--force proceeds: ${forced.stderr}`);
      eq(JSON.parse(forced.stdout).committed, true, 'committed');
    } finally { fx.cleanup(); }
  });

  suite('cli: doctor');

  test('doctor runs and reports without throwing', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['doctor'], { cwd: fx.root });
      ok(r.code === EXIT.OK || r.code === EXIT.GENERAL, `ran: exit ${r.code}`);
      ok(r.stdout.length > 0, 'produced output');
      ok(/AIDEV_HOME/.test(r.stdout), 'reports the home directory');
    } finally { fx.cleanup(); }
  });

  test('doctor --json is parseable', () => {
    const fx = makeRepo();
    try {
      const d = JSON.parse(aidev(['doctor', '--json'], { cwd: fx.root }).stdout);
      ok(Array.isArray(d.checks) && d.checks.length > 0, 'lists checks');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
