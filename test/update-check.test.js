'use strict';
/**
 * Tests for the "a newer ai-dev-kit is available" notice.
 *
 * The kit checkout is a real clone of a bare remote, so the check runs the
 * same `git ls-remote` it runs on a user's machine. A kit whose origin/main
 * moved on has never fetched the new commit; the check must still see it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, eq, ok } = require('./harness');
const { git, write, copyDir, KIT_ROOT } = require('./fixtures');
const home = require('../cli/lib/home');

/** A bare origin, the kit clone under test, and an author clone that pushes. */
function makeKit({ withCli = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-update-'));
  const origin = path.join(base, 'origin.git');
  const author = path.join(base, 'author');
  const kit = path.join(base, 'kit');
  git(['init', '--bare', '-b', 'main', origin], base);
  git(['clone', origin, author], base);
  if (withCli) {
    copyDir(path.join(KIT_ROOT, 'cli'), path.join(author, 'cli'));
    fs.copyFileSync(path.join(KIT_ROOT, 'package.json'), path.join(author, 'package.json'));
  }
  write(path.join(author, 'README.md'), 'kit\n');
  git(['add', '-A'], author);
  git(['commit', '-m', 'first'], author);
  git(['push', 'origin', 'HEAD:main'], author);
  git(['clone', origin, kit], base);
  const homeDir = path.join(base, 'home');
  return { base, origin, author, kit, env: { AIDEV_HOME: homeDir } };
}

/** Publish a new commit on origin/main that the kit clone has not fetched. */
function release(k, n = 1) {
  for (let i = 0; i < n; i++) {
    write(path.join(k.author, `release-${Date.now()}-${i}.txt`), 'x\n');
    git(['add', '-A'], k.author);
    git(['commit', '-m', 'release'], k.author);
  }
  git(['push', 'origin', 'HEAD:main'], k.author);
  return git(['rev-parse', 'HEAD'], k.author);
}

function run() {
  suite('update check: home.checkForUpdate');

  test('up to date: not newer', () => {
    const k = makeKit();
    const r = home.checkForUpdate(k.kit, { env: k.env });
    ok(r, 'result');
    eq(r.newer, false, 'newer');
  });

  test('origin/main moved on (commit not fetched): newer', () => {
    const k = makeKit();
    const sha = release(k);
    const r = home.checkForUpdate(k.kit, { env: k.env });
    ok(r, 'result');
    eq(r.newer, true, 'newer');
    eq(r.remoteSha, sha, 'remote sha');
  });

  test('a cached "not newer" is re-checked after the TTL', () => {
    const k = makeKit();
    const t0 = Date.now();
    eq(home.checkForUpdate(k.kit, { env: k.env, now: t0 }).newer, false, 'first');
    release(k);
    eq(home.checkForUpdate(k.kit, { env: k.env, now: t0 + 1000 }).cached, true, 'still cached');
    const later = home.checkForUpdate(k.kit, { env: k.env, now: t0 + home.UPDATE_CHECK_TTL_MS + 1000 });
    eq(later.cached, false, 'asked the remote again');
    eq(later.newer, true, 'newer');
  });

  test('checkout ahead of origin/main (a maintainer branch): not newer', () => {
    const k = makeKit();
    write(path.join(k.kit, 'local.txt'), 'x\n');
    git(['add', '-A'], k.kit);
    git(['commit', '-m', 'local'], k.kit);
    eq(home.checkForUpdate(k.kit, { env: k.env }).newer, false, 'newer');
  });

  test('unreachable origin: unknown, not cached', () => {
    const k = makeKit();
    git(['remote', 'set-url', 'origin', path.join(k.base, 'missing.git')], k.kit);
    eq(home.checkForUpdate(k.kit, { env: k.env }), null, 'result');
    ok(!fs.existsSync(path.join(k.env.AIDEV_HOME, 'cache', 'update-check.json')), 'no cache written');
  });

  suite('update check: the notice on every command');

  // One kit clone that carries the CLI, behind its origin by one release.
  const k = makeKit({ withCli: true });
  release(k);
  const bin = path.join(k.kit, 'cli', 'bin', 'aidev.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-update-cwd-'));
  function aidev(args, env = {}) {
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', AIDEV_NO_UPDATE_CHECK: '', ...k.env, ...env },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const NOTICE = /a newer ai-dev-kit is available .*Run "aidev update"/;

  for (const args of [[], ['--help'], ['--version'], ['list', 'packages'], ['doctor'], ['check'], ['nosuch']]) {
    test(`aidev ${args.join(' ') || '(no arguments)'}: says a newer kit exists`, () => {
      const r = aidev(args);
      ok(NOTICE.test(r.stderr), `notice on stderr, got: ${r.stderr}`);
    });
  }

  test('--json: the notice stays off stdout', () => {
    const r = aidev(['list', 'packages', '--json']);
    ok(NOTICE.test(r.stderr), 'notice on stderr');
    JSON.parse(r.stdout);
  });

  test('hook: no notice (the AI tool reads its output)', () => {
    const r = aidev(['hook', 'session-start']);
    ok(!NOTICE.test(r.stderr) && !NOTICE.test(r.stdout), 'no notice');
  });

  test('AIDEV_NO_UPDATE_CHECK=1 turns it off', () => {
    const r = aidev(['--version'], { AIDEV_NO_UPDATE_CHECK: '1' });
    ok(!NOTICE.test(r.stderr + r.stdout), 'no notice');
  });
}

module.exports = { run };
