'use strict';
/**
 * CLI-level tests: the binary is run as a real subprocess.
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
const { makeRepo, write, git } = require('./fixtures');
const { EXIT } = require('../cli/lib/errors');

const BIN = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');

/** Run the CLI and capture code/stdout/stderr separately. */
function aidev(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', ...env },
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
    for (const c of ['init', 'check', 'sync', 'knowledge', 'hook', 'doctor', 'plan', 'update']) {
      ok(r.stdout.includes(c), `help mentions ${c}`);
    }
  });

  test('no arguments prints usage rather than failing', () => {
    eq(aidev([]).code, EXIT.OK, 'exit');
  });

  test('unknown command exits 1 and names the mistake', () => {
    const r = aidev(['nonesuch']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown command: nonesuch/.test(r.stderr), 'message');
  });

  test('unknown option is rejected, not ignored', () => {
    const r = aidev(['plan', '--no-such-flag']);
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
    ok(r.stdout.includes('--no-remote'), 'lists --no-remote');
  });

  test('--no-remote is accepted by every command that reads remote state', () => {
    const fx = makeRepo();
    try {
      for (const args of [['check'], ['plan'], ['knowledge', 'status']]) {
        const r = aidev([...args, '--no-remote'], { cwd: fx.root });
        ok(!/unknown option/.test(r.stderr), `${args.join(' ')} accepts --no-remote`);
      }
    } finally { fx.cleanup(); }
  });

  suite('cli: exit-code contract');

  test('missing aidev.yaml exits 1 with a pointer to init', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      const r = aidev(['check'], { cwd: dir });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/aidev init/.test(r.stderr), 'message points at init');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('missing .aidev-lock is drift (exit 2)', () => {
    const fx = makeRepo({ withLock: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'exit 2');
    } finally { fx.cleanup(); }
  });

  test('a Wiki describing a different SHA is exit 4', () => {
    const fx = makeRepo();
    try {
      const mp = path.join(fx.root, 'knowledge', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      m.knowledgeSha = 'a'.repeat(40);
      fs.writeFileSync(mp, JSON.stringify(m, null, 2));
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

  test('drift outranks consistency when both are broken', () => {
    // Ordering is part of the contract: the log must name what to fix first.
    const fx = makeRepo();
    try {
      const mp = path.join(fx.root, 'knowledge', 'manifest.json');
      const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
      m.knowledgeSha = 'b'.repeat(40);
      fs.writeFileSync(mp, JSON.stringify(m, null, 2));
      // Break a kit-owned file so both conditions genuinely hold at once.
      write(path.join(fx.root, 'CLAUDE.md'), '# edited behind the kit\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'drift wins');
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

  test('plan --json is parseable', () => {
    const fx = makeRepo();
    try {
      ok(JSON.parse(aidev(['plan', '--no-remote', '--json'], { cwd: fx.root }).stdout).plan, 'has plan');
    } finally { fx.cleanup(); }
  });

  suite('cli: knowledge build');

  test('build writes a manifest recording the checked-out SHA', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['knowledge', 'build'], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'exit');
      const m = JSON.parse(fs.readFileSync(path.join(fx.root, 'knowledge', 'manifest.json'), 'utf8'));
      eq(m.knowledgeSha, fx.pkgSha, 'knowledgeSha');
      eq(m.schemaVersion, 2, 'schemaVersion');
      ok(m.inventoryShards.length > 0, 'wrote shards');
    } finally { fx.cleanup(); }
  });

  test('build excludes secrets_paths from the inventory', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      const m = JSON.parse(fs.readFileSync(path.join(fx.root, 'knowledge', 'manifest.json'), 'utf8'));
      const rows = m.inventoryShards.flatMap((s) =>
        JSON.parse(fs.readFileSync(path.join(fx.root, 'knowledge', s), 'utf8')));
      ok(!rows.some((r) => r.path.includes('secrets')), 'no secret file is inventoried');
    } finally { fx.cleanup(); }
  });

  test('--dry-run writes nothing', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      eq(aidev(['knowledge', 'build', '--dry-run'], { cwd: fx.root }).code, EXIT.OK, 'exit');
      ok(!fs.existsSync(path.join(fx.root, 'knowledge', 'manifest.json')), 'no manifest written');
    } finally { fx.cleanup(); }
  });

  test('build creates knowledge/index.md when absent', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      ok(fs.existsSync(path.join(fx.root, 'knowledge', 'index.md')), 'index.md exists');
    } finally { fx.cleanup(); }
  });

  test('--scope narrows what is queued', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['knowledge', 'build', '--scope', 'src/docs', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      ok(parsed.pending.every((p) => p.startsWith('src/docs')), `only docs queued: ${parsed.pending}`);
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
      const pageRel = 'knowledge/pages/auth.md';
      write(path.join(fx.root, pageRel), '# auth\n');
      const shardPath = path.join(fx.root, 'knowledge', 'inventory', '00.json');
      const rows = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
      const crypto = require('crypto');
      rows[0].pages = [pageRel];
      rows[0].selfHashes = { [pageRel]: `sha256:${crypto.createHash('sha256').update('# auth\n').digest('hex')}` };
      fs.writeFileSync(shardPath, JSON.stringify(rows, null, 2));
      write(path.join(fx.root, pageRel), '# auth, edited by a human\n');

      const blocked = aidev(['knowledge', 'build', '--refresh'], { cwd: fx.root });
      eq(blocked.code, EXIT.GENERAL, 'blocked');
      ok(/edited by hand/.test(blocked.stderr), 'explains why');
      const forced = aidev(['knowledge', 'build', '--refresh', '--force'], { cwd: fx.root });
      eq(forced.code, EXIT.OK, '--force proceeds');
    } finally { fx.cleanup(); }
  });

  test('a rename costs no regeneration', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      aidev(['knowledge', 'build'], { cwd: fx.root });
      git(['mv', 'src/api/auth.ts', 'src/api/authentication.ts'], fx.pkgDir);
      git(['commit', '-q', '-m', 'rename'], fx.pkgDir);
      const r = aidev(['knowledge', 'build', '--refresh', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      ok(!parsed.pending.some((p) => p.includes('authentication')), `rename not queued: ${parsed.pending}`);
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
      ok(/deny/i.test(JSON.stringify(d)), `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write denies a write to a secret path', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'config', 'secrets', 'key.pem'), content: 'x' },
      }, fx.root);
      ok(/deny/i.test(r.stdout), `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write denies read-only src/** without a work lease', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts'), content: 'x' },
      }, fx.root);
      ok(/deny/i.test(r.stdout), `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write uses CLAUDE_PROJECT_DIR when the session cwd is inside the PKG', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'src', 'api', 'auth.ts'), content: 'x' },
      }, fx.pkgDir, { CLAUDE_PROJECT_DIR: fx.root });
      eq(r.code, EXIT.OK, `hook failed from nested cwd: ${r.stderr}`);
      ok(/deny/i.test(r.stdout), `wrapper policy was not applied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write allows an ordinary wrapper-side file', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Write',
        tool_input: { file_path: path.join(fx.root, 'notes.md'), content: 'x' },
      }, fx.root);
      ok(!/"permissionDecision":\s*"deny"/.test(r.stdout), `allowed: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write inspects Bash redirection targets', () => {
    const fx = makeRepo();
    try {
      const r = hook('guard-write', {
        tool_name: 'Bash',
        tool_input: { command: 'echo pwned > .claude/settings.json' },
      }, fx.root);
      ok(/deny/i.test(r.stdout), `denied: ${r.stdout}`);
    } finally { fx.cleanup(); }
  });

  test('guard-write fails closed on a malformed payload', () => {
    const fx = makeRepo();
    try {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-hook-')), 'bad.json');
      fs.writeFileSync(f, '{ not json', 'utf8');
      const r = aidev(['hook', 'guard-write', '--input', f], { cwd: fx.root });
      eq(r.code, EXIT.OK, 'still exits 0');
      ok(/deny/i.test(r.stdout), `fails closed: ${r.stdout}`);
      fs.rmSync(path.dirname(f), { recursive: true, force: true });
    } finally { fx.cleanup(); }
  });

  test('session-start reports state without failing the session', () => {
    const fx = makeRepo();
    try {
      const r = hook('session-start', {}, fx.root);
      eq(r.code, EXIT.OK, 'exit 0');
      ok(/ai-dev-kit/.test(r.stdout), `summary present: ${r.stdout.slice(0, 200)}`);
    } finally { fx.cleanup(); }
  });

  test('an unknown hook name is rejected', () => {
    const fx = makeRepo();
    try {
      ok(aidev(['hook', 'not-a-hook'], { cwd: fx.root }).code !== EXIT.OK, 'non-zero');
    } finally { fx.cleanup(); }
  });

  suite('cli: sync');

  test('--check-only writes nothing and judges the state', () => {
    const fx = makeRepo();
    try {
      const before = fs.readFileSync(path.join(fx.root, 'knowledge', 'manifest.json'), 'utf8');
      const r = aidev(['sync', '--check-only', '--json'], { cwd: fx.root });
      ok([EXIT.OK, EXIT.KNOWLEDGE].includes(r.code), `judged: exit ${r.code}`);
      eq(fs.readFileSync(path.join(fx.root, 'knowledge', 'manifest.json'), 'utf8'), before, 'unchanged');
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
      write(path.join(fx.root, '.aidev', 'sync.lock'), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const r = aidev(['sync'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/--resume|--abort/.test(r.stderr), 'names the recovery');
    } finally { fx.cleanup(); }
  });

  test('--to rejects a SHA unreachable from the tracking branch', () => {
    const fx = makeRepo();
    try {
      // A commit on a side branch is never a legitimate sync target.
      write(path.join(fx.pkgOrigin, 'side.txt'), 'side\n');
      git(['checkout', '-q', '-b', 'side'], fx.pkgOrigin);
      git(['add', '-A'], fx.pkgOrigin);
      git(['commit', '-q', '-m', 'side commit'], fx.pkgOrigin);
      const sideSha = git(['rev-parse', 'HEAD'], fx.pkgOrigin);
      git(['checkout', '-q', 'main'], fx.pkgOrigin);
      git(['fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'], fx.pkgDir);

      const r = aidev(['sync', '--to', sideSha], { cwd: fx.root });
      ok(r.code !== EXIT.OK, `refused: exit ${r.code}`);
    } finally { fx.cleanup(); }
  });

  suite('cli: doctor');

  test('doctor runs and reports without throwing', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['doctor'], { cwd: fx.root });
      ok(r.code === EXIT.OK || r.code === EXIT.GENERAL, `ran: exit ${r.code}`);
      ok(r.stdout.length > 0, 'produced output');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };
