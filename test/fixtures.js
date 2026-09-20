'use strict';
/** Shared fixture: a throwaway wrapper repo with git, submodule and policy. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e.x',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@e.x',
      GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'aidev-test-gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(os.tmpdir(), 'aidev-test-gitconfig-sys'),
      GIT_TERMINAL_PROMPT: '0',
    },
  }).toString().trim();
}

function write(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s, 'utf8');
}

/** Recursive directory copy, used to plant the kit's real templates. */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Plant the kit's real `templates/claude-assets/` in a fixture repo.
 *
 * The real files rather than a stand-in: the point of a materialisation test is
 * that what the kit ships is what lands in `.claude/`, which a fake template
 * could not demonstrate.
 */
function copyTemplates(root) {
  const assets = require('../cli/lib/assets');
  const rel = assets.TEMPLATE_ROOT.split('/');
  copyDir(path.join(__dirname, '..', ...rel), path.join(root, ...rel));
}

/**
 * The kit-owned files every wrapper repo carries, byte-identical.
 *
 * `settings: false` leaves `.claude/` empty, which is what a clone looks like
 * before `aidev init` materialises it.
 */
function writeStaticAssets(root, { hooks = false, settings = true } = {}) {
  write(path.join(root, 'CLAUDE.md'), '# test wrapper\n');
  write(path.join(root, '.mcp.json'), `${JSON.stringify({
    mcpServers: { 'azure-devops': { command: 'aidev', args: ['mcp', 'azure-devops'] } },
  }, null, 2)}\n`);
  // `hooks: true` wires the kit's hooks the way a real settings.json does, plus
  // a team-owned hook that eject must leave alone.
  const kitHook = (name) => ({
    type: 'command', command: 'node',
    args: ['${CLAUDE_PROJECT_DIR}/cli/bin/aidev.js', 'hook', name],
  });
  const settingsDoc = hooks ? {
    hooks: {
      PreToolUse: [
        { matcher: 'Write|Edit|MultiEdit|Bash', hooks: [kitHook('guard-write')] },
      ],
      SessionStart: [
        { matcher: '*', hooks: [
          kitHook('session-start'),
          { type: 'command', command: 'echo team-owned-hook' },
        ] },
      ],
    },
  } : { hooks: {} };
  if (settings) {
    write(path.join(root, '.claude', 'settings.json'), `${JSON.stringify(settingsDoc, null, 2)}\n`);
  }
}

/**
 * Build a wrapper repo containing a real PKG submodule.
 *
 * The repo is built the way a correctly-initialised one looks: kit-owned static
 * files present and recorded in `.aidev-lock`. Without that, `detectDrift`
 * reports `noLock` and every `aidev check` returns exit 2, which would mask the
 * exit codes most of these tests exist to pin down. `withLock: false` recreates
 * the un-initialised repo on purpose.
 *
 * Returns { root, pkgRoot, pkgOrigin, cleanup }.
 */
function makeRepo({
  withWiki = true, withPolicy = true, withLock = true, withHooks = false,
  withTemplates = false, pkgFiles = null,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-test-'));
  const pkgOrigin = path.join(base, 'pkg-origin');
  const root = path.join(base, 'wrapper');

  // --- the PKG repository (acts as the submodule's origin) ---
  fs.mkdirSync(pkgOrigin, { recursive: true });
  git(['init', '-q', '-b', 'main'], pkgOrigin);
  const files = pkgFiles || {
    'src/api/auth.ts': 'export function auth() { return 1; }\n',
    'src/api/routing.ts': 'export const routes = [];\n',
    'docs/readme.md': '# pkg docs\n',
    'config/secrets/key.pem': 'SECRET\n',
  };
  for (const [rel, body] of Object.entries(files)) write(path.join(pkgOrigin, rel), body);
  git(['add', '-A'], pkgOrigin);
  git(['commit', '-q', '-m', 'initial'], pkgOrigin);
  const pkgSha = git(['rev-parse', 'HEAD'], pkgOrigin);

  // --- the wrapper repository ---
  fs.mkdirSync(root, { recursive: true });
  git(['init', '-q', '-b', 'main'], root);
  write(path.join(root, 'README.md'), '# wrapper\n');
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', pkgOrigin, 'src'], root);

  // --- kit-owned static assets (shipped identically by the central kit) ---
  // With templates present, `.claude/` is left empty so init has something to
  // materialise; otherwise a stand-in settings.json stands in for a repo that
  // has already been initialised.
  writeStaticAssets(root, { hooks: withHooks, settings: !withTemplates });
  if (withTemplates) copyTemplates(root);

  write(path.join(root, 'aidev.yaml'), [
    'version: 1',
    'package:',
    '  name: my-pkg',
    '  include: ["src/src/**", "src/docs/**"]',
    '  exclude:',
    '    - "**/node_modules/**"',
    'secrets_paths:',
    '  - "src/config/secrets/**"',
    'azure_devops:',
    '  organization: my-org',
    '  project: my-project',
    '  repository: my-pkg',
    '  wrapper_repository: my-pkg-ai-dev',
    '  auth_env: AZURE_DEVOPS_PAT',
    '  triage:',
    '    labels: ["ai-ready"]',
    'sync:',
    '  tracking_branch: main',
    '  lease_ttl_minutes: 120',
    'task:',
    '  lease_ttl_minutes: 120',
    'knowledge:',
    '  max_files_per_dir: 20',
    '',
  ].join('\n'));

  if (withPolicy) {
    write(path.join(root, '.aidev', 'policy.yaml'), [
      'version: 1',
      'protected:',
      '  - ".claude/**"',
      '  - "CLAUDE.md"',
      '  - ".mcp.json"',
      '  - ".aidev/policy.yaml"',
      '  - ".aidev/leases/**"',
      '  - ".aidev/sync.lock"',
      '  - ".aidev-lock"',
      '  - "src/config/secrets/**"',
      'read_only:',
      '  - "src/**"',
      'writable_during_sync:',
      '  - "knowledge/**"',
      '',
    ].join('\n'));
  }

  if (withWiki) {
    write(path.join(root, 'knowledge', 'manifest.json'), `${JSON.stringify({
      schemaVersion: 2,
      knowledgeSha: pkgSha,
      kitCommit: null,
      generatedAt: new Date().toISOString(),
      inventoryShards: ['inventory/00.json'],
      stats: { files: 0, pages: 0, maskedFiles: 0 },
    }, null, 2)}\n`);
    write(path.join(root, 'knowledge', 'inventory', '00.json'), '[]\n');
    write(path.join(root, 'knowledge', 'index.md'), '# index\n');
  }

  // Built with the production hasher rather than a hand-rolled copy, so the
  // fixture cannot drift from what detectDrift actually computes.
  if (withLock) {
    const assets = require('../cli/lib/assets');
    assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
  }

  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'wrapper init'], root);

  return {
    root, pkgOrigin, pkgSha,
    pkgDir: path.join(root, 'src'),
    /** Re-record the lock after a test deliberately changes a static file. */
    relock() {
      const assets = require('../cli/lib/assets');
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
    },
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/** Advance the PKG origin by one commit and return the new SHA. */
function advancePkg(fx, rel = 'src/api/new.ts', body = 'export const x = 1;\n') {
  write(path.join(fx.pkgOrigin, rel), body);
  git(['add', '-A'], fx.pkgOrigin);
  git(['commit', '-q', '-m', `add ${rel}`], fx.pkgOrigin);
  return git(['rev-parse', 'HEAD'], fx.pkgOrigin);
}

module.exports = { makeRepo, advancePkg, git, write, writeStaticAssets, copyTemplates, copyDir };
