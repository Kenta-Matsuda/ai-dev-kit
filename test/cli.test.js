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
const gitLib = require('../cli/lib/git');
const home = require('../cli/lib/home');
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
    for (const c of ['init', 'check', 'doctor', 'create', 'remove', 'list', 'submit', 'run', 'update', 'sync', 'uninstall']) {
      ok(new RegExp(`^\\s+${c}\\b`, 'm').test(r.stdout), `help mentions ${c}`);
    }
    for (const c of ['status', 'knowledge', 'permission', 'workflow', 'apply', 'configure', 'show', 'eject', 'mcp', 'evolve', 'hook']) {
      ok(!new RegExp(`^\\s+${c}\\b`, 'm').test(r.stdout), `${c} is not advertised`);
    }
    ok(!/^\s+agent\b/m.test(r.stdout), 'agent is gone (agents run inside workflows)');
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
    const r = aidev(['check', '--no-such-flag']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown option/.test(r.stderr), 'message');
  });

  test('a typo in --dry-run cannot silently become a real run', () => {
    // The whole reason unknown flags are fatal.
    const r = aidev(['check', '--dryrun']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/unknown option/.test(r.stderr), 'message');
  });

  test('a verb without its object explains itself', () => {
    const r = aidev(['sync']);
    eq(r.code, EXIT.GENERAL, 'exit');
    ok(/needs an object: tools, wiki/.test(r.stderr), r.stderr);
    ok(/needs an object: workflow, agent, skill, policy/.test(aidev(['create']).stderr), 'create too');
  });

  test('an unknown object is rejected before the command runs', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['update', 'frobnicate'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/takes no object/.test(r.stderr), r.stderr);
      ok(/expected one of workflow/.test(aidev(['run', 'agent', 'x'], { cwd: fx.root }).stderr), 'run takes workflow only');
    } finally { fx.cleanup(); }
  });

  test('the old feature-first commands are gone', () => {
    for (const c of ['status', 'knowledge', 'permission', 'workflow', 'agent', 'apply', 'configure', 'show', 'eject', 'mcp', 'evolve']) {
      const r = aidev([c]);
      eq(r.code, EXIT.GENERAL, `${c} exit`);
      ok(/unknown command/.test(r.stderr), `${c}: ${r.stderr}`);
    }
    ok(/takes no object/.test(aidev(['update', 'wiki']).stderr), 'update is the kit updater only');
  });

  test('per-command --help shows that command\'s flags', () => {
    const r = aidev(['sync', '--help']);
    eq(r.code, EXIT.OK, 'exit');
    ok(r.stdout.includes('--scope'), 'lists --scope');
    ok(r.stdout.includes('--full'), 'lists --full');
    ok(r.stdout.includes('--no-commit'), 'lists --no-commit');
    ok(r.stdout.includes('--branch'), 'lists --branch');
    ok(!r.stdout.includes('--refresh'), 'does not advertise the retired --refresh');
  });

  test('update --help documents the self-update flags only; applying is a separate command', () => {
    const r = aidev(['update', '--help']);
    eq(r.code, EXIT.OK, 'exit');
    for (const f of ['--dry-run', '--json']) ok(r.stdout.includes(f), `lists ${f}`);
    for (const f of ['--all', '--kit-only', '--no-commit']) ok(!r.stdout.includes(f), `still advertises ${f}`);
    const a = aidev(['sync', '--help']);
    eq(a.code, EXIT.OK, 'sync --help exit');
    for (const f of ['--dry-run', '--force', '--json', '--no-commit']) ok(a.stdout.includes(f), `sync lists ${f}`);
  });

  test('every command answers --help without needing a repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      for (const c of ['init', 'check', 'doctor', 'create', 'remove', 'list', 'submit', 'run',
        'update', 'sync', 'uninstall', 'hook']) {
        const r = aidev([c, '--help'], { cwd: dir });
        eq(r.code, EXIT.OK, `${c} --help exit: ${r.stderr}`);
        ok(r.stdout.includes(`aidev ${c}`), `${c} --help names itself`);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('--no-remote is accepted by every command that reads remote state', () => {
    const fx = makeRepo();
    try {
      for (const args of [['check']]) {
        const r = aidev([...args, '--no-remote'], { cwd: fx.root });
        ok(!/unknown option/.test(r.stderr), `${args.join(' ')} accepts --no-remote`);
      }
    } finally { fx.cleanup(); }
  });

  suite('cli: check as the one screen');

  test('check outside a package exits 0 and points at init', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-bare-'));
    try {
      const r = aidev(['check'], { cwd: dir });
      eq(r.code, EXIT.OK, 'exit');
      ok(/aidev init/.test(r.stdout + r.stderr), 'message points at init');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('check in a set-up clone exits 0 and names the package', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      ok(/my-pkg/.test(r.stdout), `names the package: ${r.stdout}`);
      ok(/\[ai-dev-kit\] head=/.test(r.stdout), 'prints the head/knowledge/tracking summary');
    } finally { fx.cleanup(); }
  });

  test('a warning state still exits 0 (only --strict turns it into 2)', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const r = aidev(['check', '--no-remote', '--json'], { cwd: fx.root });
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

  test('a tool file edited by the team is not drift (exit 0); the kit hooks removed is (exit 2)', () => {
    const fx = makeRepo({ realTemplates: true });
    try {
      write(path.join(fx.root, 'CLAUDE.md'), '# edited by the team\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.OK, 'a customised file must pass');
      const settings = path.join(fx.root, '.claude', 'settings.json');
      write(settings, fs.readFileSync(settings, 'utf8').replace('"aidev hook guard-write"', '"echo nope"'));
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.DRIFT, 'exit 2');
      ok(/guard-write/.test(r.stderr), `names the missing hook: ${r.stderr}`);
    } finally { fx.cleanup(); }
  });

  test('unresolved conflict markers in a tool file are drift (exit 2)', () => {
    const fx = makeRepo({ realTemplates: true });
    try {
      write(path.join(fx.root, 'CLAUDE.md'), '<<<<<<< CLAUDE.md (this package)\nours\n=======\nkit\n>>>>>>> kit abc1234\n');
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.DRIFT, 'exit 2');
      ok(/conflict/.test(r.stderr), `names the conflict: ${r.stderr}`);
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
      const s = aidev(['check', '--no-remote', '--json'], { cwd: fx.root });
      eq(JSON.parse(s.stdout).state.severity, 'error', 'the JSON agrees');
    } finally { fx.cleanup(); }
  });

  test('a missing Wiki is exit 4, not a crash', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.KNOWLEDGE, 'exit 4');
    } finally { fx.cleanup(); }
  });

  test('a knowledgeSha this clone lacks is not a problem while the inventory matches HEAD', () => {
    // The verdict compares the inventory with the tree at HEAD; the recorded
    // commit is informational, so a squash or force-push cannot fail the check.
    const fx = makeRepo();
    try {
      const m = readManifest(fx.root);
      m.knowledgeSha = 'a'.repeat(40);
      writeManifest(fx.root, m);
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.OK, 'exit 0');
      eq(aidev(['check', '--no-remote', '--strict'], { cwd: fx.root }).code, EXIT.OK, 'still 0 under --strict');
    } finally { fx.cleanup(); }
  });

  test('code that moved under the Wiki is a warning; --strict makes it exit 2', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit 0: ${r.stderr}`);
      ok(/sync wiki/.test(r.stdout), `suggests the update: ${r.stdout}`);
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
      // Remove the kit hooks so both conditions genuinely hold at once.
      write(path.join(fx.root, '.claude', 'settings.json'), '{"hooks":{}}\n');
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'drift wins');
    } finally { fx.cleanup(); }
  });

  test('drift outranks a missing policy', () => {
    const fx = makeRepo({ withLock: false, withPolicy: false });
    try {
      eq(aidev(['check', '--no-remote'], { cwd: fx.root }).code, EXIT.DRIFT, 'drift wins');
    } finally { fx.cleanup(); }
  });

  test('a stale publish lease is exit 4 and names the recovery', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'sync.lock'), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: '2000-01-01T00:00:00.000Z', ttlMinutes: 1,
      }));
      const r = aidev(['check', '--no-remote'], { cwd: fx.root });
      eq(r.code, EXIT.KNOWLEDGE, 'exit 4');
      ok(/--abort/.test(r.stderr), `names the recovery: ${r.stderr}`);
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

  test('check --json is parseable and carries the state, tool config and policy', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['check', '--no-remote', '--json'], { cwd: fx.root });
      const d = JSON.parse(r.stdout);
      eq(d.package, 'my-pkg', 'package name');
      eq(d.hosting, 'azure-devops', 'hosting');
      ok(d.state && d.state.severity, 'has state');
      eq(d.toolConfig.ok, true, 'the tool configuration of a fresh fixture passes');
      eq(d.policy.ok, true, 'policy valid');
    } finally { fx.cleanup(); }
  });

  test('knowledge update --json prints no human output before the JSON', () => {
    // The regression this guards: ui.heading/ui.table ran before ui.json.
    const fx = makeRepo({ withWiki: false });
    try {
      const r = aidev(['sync', 'wiki', '--dry-run', '--json'], { cwd: fx.root });
      const parsed = JSON.parse(r.stdout);
      eq(parsed.ok, true, 'ok');
      ok(Array.isArray(parsed.pending), 'pending is a list');
    } finally { fx.cleanup(); }
  });

  suite('cli: knowledge update');

  // `--no-commit` keeps the update in place; the fixtures sit on the tracking
  // branch, where a committing update would publish on aidev/wiki-<sha>.
  const upd = (args, cwd) => aidev(['sync', 'wiki', '--no-commit', '--no-agent', ...args], { cwd });

  test('update writes a manifest describing HEAD and leaves prose owed', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = upd(['--json'], fx.root);
      // Prose is owed (--no-agent), so the exit code says "not done"; the
      // structure is nonetheless written and describes HEAD.
      eq(r.code, EXIT.GENERAL, `exit: ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      eq(j.structuredOk, true, 'structure written');
      ok(j.remaining > 0, 'targets stay queued without an agent');
      eq(j.committed, false, '--no-commit');
      const m = readManifest(fx.root);
      eq(m.knowledgeSha, fx.setupSha, 'knowledgeSha is HEAD');
      eq(m.schemaVersion, 3, 'schemaVersion');
      ok(m.inventoryShards.length > 0, 'wrote shards');
      ok(fs.existsSync(path.join(fx.root, ...layout.KNOWLEDGE_REL.split('/'), '.cache', 'plan.json')), 'a plan for subagents is written');
    } finally { fx.cleanup(); }
  });

  test('update excludes secrets_paths and kit-managed files from the inventory', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      upd([], fx.root);
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
      eq(aidev(['sync', 'wiki', '--dry-run'], { cwd: fx.root }).code, EXIT.OK, 'exit');
      ok(!fs.existsSync(manifestPath(fx.root)), 'no manifest written');
    } finally { fx.cleanup(); }
  });

  test('update creates .aidev/knowledge/index.md when absent', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      upd([], fx.root);
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'knowledge', 'index.md')), 'index.md exists');
    } finally { fx.cleanup(); }
  });

  test('--scope narrows what is queued', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = upd(['--scope', 'docs', '--json'], fx.root);
      const parsed = JSON.parse(r.stdout);
      ok(parsed.pending.length > 0, 'something in scope was queued');
      ok(parsed.pending.every((p) => p.startsWith('docs')), `only docs queued: ${parsed.pending}`);
      ok(parsed.deferred.length > 0, 'out-of-scope changes are reported as deferred');
    } finally { fx.cleanup(); }
  });

  test('--scope matching nothing is an error, not a silent no-op', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const r = upd(['--scope', 'src/nowhere'], fx.root);
      eq(r.code, EXIT.GENERAL, 'exit');
      ok(/matched no files/.test(r.stderr), 'message');
    } finally { fx.cleanup(); }
  });

  test('a hand-edited page halts the update until --force', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      upd([], fx.root);
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

      const blocked = upd([], fx.root);
      eq(blocked.code, EXIT.GENERAL, 'blocked');
      ok(/edited by hand/.test(blocked.stderr), 'explains why');
      const forced = upd(['--force', '--json'], fx.root);
      eq(JSON.parse(forced.stdout).structuredOk, true, '--force proceeds');
    } finally { fx.cleanup(); }
  });

  test('uncommitted generation targets block the update and are listed', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, 'src', 'api', 'auth.ts'), 'export function auth() { return 2; }\n');
      const r = aidev(['sync', 'wiki'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/uncommitted/.test(r.stderr), `explains why: ${r.stderr}`);
      ok(/src\/api\/auth\.ts/.test(r.stderr), `lists the file: ${r.stderr}`);
      // A dirty Wiki or kit file is not a reason to refuse.
      git(['checkout', '--', 'src/api/auth.ts'], fx.root);
      write(path.join(fx.root, 'aidev.yaml'), `${fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8')}# note\n`);
      const ok2 = aidev(['sync', 'wiki', '--json'], { cwd: fx.root });
      eq(ok2.code, EXIT.OK, `kit files may be dirty: ${ok2.stderr}`);
    } finally { fx.cleanup(); }
  });

  test('a rename costs no regeneration and is committed on the feature branch without an agent', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'feature/rename'], fx.root);
      git(['mv', 'src/api/auth.ts', 'src/api/authentication.ts'], fx.root);
      git(['commit', '-q', '-m', 'rename'], fx.root);
      const head = git(['rev-parse', 'HEAD'], fx.root);
      const r = aidev(['sync', 'wiki', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      eq(j.pending, [], `rename not queued: ${j.pending}`);
      eq(j.diff.renamed, 1, 'seen as a rename');
      eq(j.committed, true, 'the structural update is committed');
      eq(j.branch, 'feature/rename', 'on the developer branch');
      // The Wiki commit is separate from the source commit and touches only the Wiki.
      eq(git(['rev-parse', 'HEAD~1'], fx.root), head, 'one commit on top of the source commit');
      const files = git(['show', '--name-only', '--format=', 'HEAD'], fx.root).split('\n').filter(Boolean);
      ok(files.every((f) => f.startsWith('.aidev/')), `only kit files committed: ${files.join(', ')}`);
      ok(/aidev: update Wiki for/.test(git(['log', '-1', '--format=%s'], fx.root)), 'fixed commit message');
      eq(readManifest(fx.root).knowledgeSha, head, 'describes the source commit');
      eq(git(['status', '--porcelain'], fx.root), '', 'working tree clean');
      // Nothing to do on a second run.
      const again = JSON.parse(aidev(['sync', 'wiki', '--json'], { cwd: fx.root }).stdout);
      eq(again.noop, true, 'no-op when the Wiki describes HEAD');
    } finally { fx.cleanup(); }
  });

  test('the retired build/status subcommands and sync flags are rejected', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      for (const sub of ['build', 'status']) {
        const r = aidev(['update', sub], { cwd: fx.root });
        eq(r.code, EXIT.GENERAL, `${sub}: ${r.stderr}`);
        ok(/takes no object/.test(r.stderr), `${sub}: ${r.stderr}`);
      }
      for (const f of ['--refresh', '--resume', '--to', '--check-only', '--no-pr']) {
        const r = aidev(['sync', 'wiki', f, '--dry-run'], { cwd: fx.root });
        eq(r.code, EXIT.GENERAL, `${f}: ${r.stderr}`);
        ok(new RegExp(`unknown option: ${f}`).test(r.stderr), `${f}: ${r.stderr}`);
      }
      ok(aidev(['sync'], { cwd: fx.root }).code !== EXIT.OK, 'sync is gone');
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

  test('guard-write denies read-only PKG source', () => {
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

  test('guard-write never approves an MCP call for the person, and refuses one a workflow step was not granted', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, '.aidev', 'agents', 'reader.md'), '---\nname: reader\ndescription: t\nmcp: [tickets]\n---\n\nRead.\n');
      write(path.join(fx.root, '.aidev', 'workflows', 'wf', 'workflow.yaml'), [
        'name: wf', 'objective: read', 'steps:', '  - id: a', '    agent: reader', '    writable: []', '    prompt: go',
        'limits:', '  max_usd: 1', '',
      ].join('\n'));
      git(['add', '-A'], fx.root);
      git(['commit', '-q', '-m', 'wf'], fx.root);
      git(['push', '-q', 'origin', 'main'], fx.root);
      const call = (tool, env) => hook('guard-write', { tool_name: tool, tool_input: {} }, fx.root, env);
      const outside = call('mcp__billing__charge', {});
      eq([outside.code, outside.stdout.trim()], [EXIT.OK, ''], 'no answer: the tool\'s own permission settings decide');
      const inRun = { AIDEV_WORKFLOW: 'wf', AIDEV_WORKFLOW_STEP: 'a' };
      eq(call('mcp__tickets__get', inRun).stdout.trim(), '', 'a granted server: no answer either (the launch pre-approved it)');
      const refused = call('mcp__billing__charge', inRun);
      ok(DENIED.test(refused.stdout), `denied: ${refused.stdout}`);
      ok(/not among the MCP servers of agent reader \(tickets\)/.test(refused.stdout), refused.stdout);
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
      ok(/head=/.test(r.stdout), 'the head/knowledge/tracking line');
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

  suite('cli: knowledge update on the tracking branch (publish)');

  const leasePath = (root) => path.join(root, '.aidev', 'sync.lock');
  const worktreePath = (root) => path.join(root, '.aidev', 'cache', 'wiki-worktree');

  test('--abort with no lease is a no-op, not an error', () => {
    const fx = makeRepo();
    try {
      eq(aidev(['sync', 'wiki', '--abort'], { cwd: fx.root }).code, EXIT.OK, 'exit 0');
    } finally { fx.cleanup(); }
  });

  test('a lease for another target blocks a publish and names --abort', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      write(leasePath(fx.root), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: 'c'.repeat(40), originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const r = aidev(['sync', 'wiki'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/--abort/.test(r.stderr), `names the recovery: ${r.stderr}`);
      ok(fs.existsSync(leasePath(fx.root)), 'the lease is left for the operator');
    } finally { fx.cleanup(); }
  });

  test('--abort removes the lease and the worktree without touching the checkout', () => {
    const fx = makeRepo();
    try {
      write(leasePath(fx.root), JSON.stringify({
        schemaVersion: 1, kind: 'sync', targetSha: fx.setupSha, originalSha: fx.pkgSha,
        acquiredAt: new Date().toISOString(), ttlMinutes: 120,
      }));
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', 'wiki', '--abort', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      ok(!fs.existsSync(leasePath(fx.root)), 'lease released');
      ok(!fs.existsSync(worktreePath(fx.root)), 'no worktree left');
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'manifest untouched');
    } finally { fx.cleanup(); }
  });

  test('a no-op when the Wiki already describes HEAD takes no lease', () => {
    const fx = makeRepo();
    try {
      const r = aidev(['sync', 'wiki', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      eq(JSON.parse(r.stdout).noop, true, `noop: ${r.stdout}`);
      ok(!fs.existsSync(leasePath(fx.root)), 'no lease taken');
      ok(!fs.existsSync(worktreePath(fx.root)), 'no worktree');
    } finally { fx.cleanup(); }
  });

  test('--dry-run reports the change set and writes nothing', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      pullPkg(fx);
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', 'wiki', '--dry-run', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, r.stderr);
      const d = JSON.parse(r.stdout);
      eq(d.dryRun, true, 'dry run');
      eq(d.targetSha, newSha, 'targets HEAD');
      ok(d.diff.added >= 1, `sees the added file: ${JSON.stringify(d.diff)}`);
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'manifest untouched');
      ok(!fs.existsSync(leasePath(fx.root)), 'no lease');
      ok(!git(['branch', '--list', `aidev/wiki-${newSha.slice(0, 12)}`], fx.root), 'no branch created');
    } finally { fx.cleanup(); }
  });

  test('a rename on the tracking branch is published on aidev/wiki-<sha> without touching the checkout', () => {
    const fx = makeRepo();
    try {
      git(['mv', 'src/api/auth.ts', 'src/api/authentication.ts'], fx.root);
      git(['commit', '-q', '-m', 'rename'], fx.root);
      git(['push', '-q', 'origin', 'main'], fx.root);
      const head = git(['rev-parse', 'HEAD'], fx.root);
      const before = fs.readFileSync(manifestPath(fx.root), 'utf8');
      const r = aidev(['sync', 'wiki', '--no-push', '--branch', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.OK, `exit: ${r.stderr}`);
      const d = JSON.parse(r.stdout);
      const branch = `aidev/wiki-${head.slice(0, 12)}`;
      eq(d.branch, branch, 'branch name');
      eq(d.committed, true, 'committed');
      eq(d.pushed, false, '--no-push does not push');
      const shown = git(['show', `${branch}:${MANIFEST_REL}`], fx.root);
      eq(JSON.parse(shown).knowledgeSha, head, 'the committed manifest describes HEAD');
      ok(!git(['ls-remote', '--heads', 'origin', branch], fx.root), 'nothing was pushed');
      eq(fs.readFileSync(manifestPath(fx.root), 'utf8'), before, 'local manifest untouched');
      eq(git(['rev-parse', 'HEAD'], fx.root), head, 'HEAD did not move');
      eq(git(['status', '--porcelain'], fx.root), '', 'working tree clean');
      ok(!fs.existsSync(leasePath(fx.root)), 'lease released');
      ok(!fs.existsSync(worktreePath(fx.root)), 'worktree removed');
    } finally { fx.cleanup(); }
  });

  test('without an agent nothing is published; the worktree waits for a re-run or --abort', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const r = aidev(['sync', 'wiki', '--no-agent', '--json'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, `prose is owed: ${r.stderr}`);
      const d = JSON.parse(r.stdout);
      eq(d.published, false, 'not published');
      ok(d.remaining > 0, 'targets remain');
      ok(fs.existsSync(leasePath(fx.root)), 'the lease is kept so the state is not hidden');
      ok(fs.existsSync(worktreePath(fx.root)), 'the worktree is kept for the next run');
      eq(aidev(['sync', 'wiki', '--abort'], { cwd: fx.root }).code, EXIT.OK, 'abort');
      ok(!fs.existsSync(worktreePath(fx.root)), 'worktree removed');
    } finally { fx.cleanup(); }
  });

  test('--no-push without --branch is rejected', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'feature/x'], fx.root);
      const r = aidev(['sync', 'wiki', '--no-push'], { cwd: fx.root });
      eq(r.code, EXIT.GENERAL, 'refused');
      ok(/--branch/.test(r.stderr), r.stderr);
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

  suite('cli: packages (list packages, --package)');

  /** Two clones in a private registry, so the names are known and nothing else is listed. */
  function withPackages(fn) {
    const env = { AIDEV_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-home-pkgs-')) };
    const a = makeRepo({ realTemplates: true });
    const b = makeRepo({ realTemplates: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-outside-'));
    try {
      eq(aidev(['sync', 'tools'], { cwd: a.root, env }).code, EXIT.OK, 'sync a');
      eq(aidev(['sync', 'tools'], { cwd: b.root, env }).code, EXIT.OK, 'sync b');
      // Distinct names: both fixtures share one package name in aidev.yaml.
      home.registerPackage(a.root, { name: 'pkg-a', kitCommit: home.readRegistry(env).packages[0].kitCommit }, env);
      home.registerPackage(b.root, { name: 'pkg-b', kitCommit: home.readRegistry(env).packages[1].kitCommit }, env);
      fn({ a, b, env, outside });
    } finally {
      a.cleanup(); b.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(env.AIDEV_HOME, { recursive: true, force: true });
    }
  }

  test('list packages shows every registered clone and marks the current one', () => {
    withPackages(({ a, env }) => {
      const r = aidev(['list', 'packages'], { cwd: a.root, env });
      eq(r.code, EXIT.OK, r.stderr);
      ok(/\* pkg-a/.test(r.stdout), `pkg-a marked: ${r.stdout}`);
      ok(/ {2}pkg-b/.test(r.stdout), `pkg-b listed: ${r.stdout}`);
      const d = JSON.parse(aidev(['list', 'packages', '--json'], { cwd: a.root, env }).stdout);
      eq(d.packages.map((p) => p.name), ['pkg-a', 'pkg-b'], 'names');
      eq(d.packages.map((p) => p.here), [true, false], 'here');
      eq(d.packages.map((p) => p.present), [true, true], 'present');
    });
  });

  test('list packages works outside a package and reports a clone that is gone', () => {
    withPackages(({ b, env, outside }) => {
      fs.rmSync(path.join(b.root, 'aidev.yaml'));
      const d = JSON.parse(aidev(['list', 'packages', '--json'], { cwd: outside, env }).stdout);
      eq(d.packages.find((p) => p.name === 'pkg-b').present, false, 'missing');
      const r = aidev(['list', 'packages'], { cwd: outside, env });
      ok(/missing/.test(r.stdout), r.stdout);
    });
  });

  test('--package runs a command on a registered package by name or path', () => {
    withPackages(({ a, b, env, outside }) => {
      const byName = JSON.parse(aidev(['sync', 'tools', '--package', 'pkg-b', '--dry-run', '--json'], { cwd: outside, env }).stdout);
      ok(gitLib.samePath(byName.package, b.root), `by name: ${byName.package}`);
      const byPath = JSON.parse(aidev(['sync', 'tools', `--package=${a.root}`, '--dry-run', '--json'], { cwd: b.root, env }).stdout);
      ok(gitLib.samePath(byPath.package, a.root), `by path: ${byPath.package}`);
      const checked = JSON.parse(aidev(['check', '-p', 'pkg-a', '--json', '--no-remote'], { cwd: outside, env }).stdout);
      ok(checked.managed !== false && checked.package, `check -p ran on the package: ${JSON.stringify(checked)}`);
      const doc = JSON.parse(aidev(['doctor', '--package', 'pkg-a', '--json'], { cwd: outside, env }).stdout);
      ok(gitLib.samePath(doc.package, a.root), 'doctor reports that package');
    });
  });

  test('--package rejects an unknown name, a machine command and a positional package', () => {
    withPackages(({ a, env, outside }) => {
      const unknown = aidev(['sync', 'tools', '--package', 'nope'], { cwd: outside, env });
      eq(unknown.code, EXIT.GENERAL, 'unknown');
      ok(/neither a registered package nor a directory \(registered: pkg-a, pkg-b\)/.test(unknown.stderr), unknown.stderr);
      const upd = aidev(['update', '--package', 'pkg-a'], { cwd: outside, env });
      eq(upd.code, EXIT.GENERAL, 'update');
      ok(/does not take --package/.test(upd.stderr), upd.stderr);
      const pos = aidev(['sync', 'tools', 'pkg-a'], { cwd: a.root, env });
      eq(pos.code, EXIT.GENERAL, 'positional');
      ok(/unexpected argument: pkg-a \(name a package with --package pkg-a\)/.test(pos.stderr), pos.stderr);
      const none = aidev(['sync', 'tools', '--package'], { cwd: outside, env });
      ok(/requires a package name or path/.test(none.stderr), none.stderr);
    });
  });

  suite('cli: ask');

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-ask-'));
    const stub = path.join(dir, 'fake-claude.js');
    const argvOut = path.join(dir, 'argv.json');
    const promptOut = path.join(dir, 'prompt.md');
    const cwdOut = path.join(dir, 'cwd.txt');
    fs.writeFileSync(stub, `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('2.1.300 (Claude Code)\\n'); process.exit(0); }
fs.writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(argv));
fs.writeFileSync(process.env.STUB_CWD_OUT, process.cwd());
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.STUB_PROMPT_OUT, stdin);
  process.stdout.write(JSON.stringify({ type: 'result', result: process.env.STUB_ANSWER || '', is_error: false, total_cost_usd: 0.01, session_id: 's' }) + '\\n');
});
`, 'utf8');
    fs.chmodSync(stub, 0o755);
    const env = (answer) => ({ AIDEV_CLAUDE_BIN: stub, STUB_ARGV_OUT: argvOut, STUB_PROMPT_OUT: promptOut, STUB_CWD_OUT: cwdOut, STUB_ANSWER: answer });
    const kitRoot = path.resolve(__dirname, '..');

    test('ask hands the question to the read-only kit-guide in the kit checkout, with the command list', () => {
      const fx = makeRepo();
      const r = aidev(['ask', 'how', 'do I resume a failed run?', '--json'], { cwd: fx.root, env: env('Run `aidev run workflow <name> --resume`.') });
      eq(r.code, EXIT.OK, r.stderr);
      const j = JSON.parse(r.stdout);
      eq([j.ok, j.answer, j.tool], [true, 'Run `aidev run workflow <name> --resume`.', 'claude']);
      const a = JSON.parse(fs.readFileSync(argvOut, 'utf8'));
      eq(a.slice(a.indexOf('--tools') + 1), ['Read', 'Glob', 'Grep'], 'kit-guide only reads');
      ok(a.includes('--strict-mcp-config'), 'and loads no MCP server');
      eq(fs.realpathSync(fs.readFileSync(cwdOut, 'utf8')), fs.realpathSync(kitRoot), 'it runs where the guide is');
      const prompt = fs.readFileSync(promptOut, 'utf8');
      ok(/# Agent: kit-guide/.test(prompt) && /how do I resume a failed run\?/.test(prompt), prompt.slice(0, 300));
      ok(/aidev run <workflow> — [\s\S]*--resume/.test(prompt), 'the prompt lists the commands and their options');
      ok(!/aidev hook/.test(prompt), 'not the internal hook entry point');
      ok(/- package: my-pkg/.test(prompt), 'and names the package it was asked in');
    });

    test('ask works outside a package, and fails without a question or an answer', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-ask-out-'));
      const r = aidev(['ask', 'what is a PKG?'], { cwd: outside, env: env('A repository set up with aidev init.') });
      eq(r.code, EXIT.OK, r.stderr);
      ok(/A repository set up with aidev init\./.test(r.stdout), r.stdout);
      ok(/asked outside a package/.test(fs.readFileSync(promptOut, 'utf8')));
      const none = aidev(['ask'], { cwd: outside, env: env('x') });
      eq(none.code, EXIT.GENERAL);
      ok(/needs a question/.test(none.stderr), none.stderr);
      const empty = aidev(['ask', 'anything', '--json'], { cwd: outside, env: env('') });
      eq(empty.code, EXIT.GENERAL);
      eq([JSON.parse(empty.stdout).ok, JSON.parse(empty.stdout).reason], [false, 'the agent gave no answer']);
    });
  }
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
