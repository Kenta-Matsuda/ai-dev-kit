'use strict';
/**
 * Shared fixture: a throwaway PKG clone set up the way `aidev init` leaves it.
 *
 * Layout (one temp directory per fixture):
 *
 *   origin.git/   bare remote — what "origin/main" points at
 *   author/       a second clone used to push new PKG commits (advancePkg)
 *   pkg/          the clone under test (fx.root): PKG files + kit files, all
 *                 committed and pushed, so HEAD == origin/main == knowledgeSha
 *
 * Kit files are written the way the CLI writes them: aidev.yaml (v2),
 * .aidev/policy.yaml, .aidev/.gitignore, .aidev/knowledge/ (manifest,
 * inventory, index.md), the tool config (.claude/settings.json, CLAUDE.md,
 * .mcp.json) and .aidev/materialized.json built with the production hasher.
 */

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

/** Recursive directory copy. */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/** The kit checkout the tests exercise (templates are read from here). */
const KIT_ROOT = path.resolve(__dirname, '..');

/** The default PKG: a small TypeScript-ish tree with docs and a secret. */
const DEFAULT_PKG_FILES = {
  'src/api/auth.ts': 'export function auth() { return 1; }\n',
  'src/api/routing.ts': 'export const routes = [];\n',
  'docs/readme.md': '# pkg docs\n',
  'config/secrets/key.pem': 'SECRET\n',
  'README.md': '# my-pkg\n',
};

function kitHook(name) {
  return { type: 'command', command: `aidev hook ${name}` };
}

/**
 * The kit-owned files every set-up PKG carries.
 *
 * `hooks: true` wires the kit's hooks the way the shipped settings.json does,
 * plus a team-owned hook that eject must leave alone. `realTemplates: true`
 * copies the kit's actual templates instead of a stand-in.
 */
function writeStaticAssets(root, { hooks = false, realTemplates = false } = {}) {
  if (realTemplates) {
    copyDir(path.join(KIT_ROOT, 'templates', 'claude'), root);
    return;
  }
  write(path.join(root, 'CLAUDE.md'), '# test package instructions\n');
  write(path.join(root, '.mcp.json'), `${JSON.stringify({
    mcpServers: { 'azure-devops': { command: 'aidev', args: ['mcp', 'azure-devops'] } },
  }, null, 2)}\n`);
  // The four kit hooks are always wired: `aidev check` refuses a settings.json
  // without them. `hooks: true` adds the team-owned hook eject must preserve.
  const settingsDoc = {
    hooks: {
      SessionStart: [{ matcher: '*', hooks: [kitHook('session-start'), ...(hooks ? [{ type: 'command', command: 'echo team-owned-hook' }] : [])] }],
      PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|Bash', hooks: [kitHook('guard-write')] }],
      PostToolUse: [
        { matcher: 'Write|Edit|MultiEdit', hooks: [kitHook('quality-gate')] },
        { matcher: 'Bash', hooks: [kitHook('after-bash')] },
      ],
      Stop: [{ hooks: [kitHook('session-stop')] }],
    },
  };
  write(path.join(root, '.claude', 'settings.json'), `${JSON.stringify(settingsDoc, null, 2)}\n`);
}

function configYaml({ name = 'my-pkg', hosting = 'azure-devops', include, exclude, secrets, extra = [] } = {}) {
  const q = (s) => JSON.stringify(s);
  const hostingLines = hosting === 'azure-devops'
    ? ['hosting:', '  type: azure-devops', '  organization: my-org', '  project: my-project',
      '  repository: my-pkg', '  auth_env: AZURE_DEVOPS_PAT', '  tracking_branch: main',
      '  triage:', '    labels: ["ai-ready"]']
    : ['hosting:', '  type: generic', '  repository: my-pkg', '  tracking_branch: main'];
  return [
    'version: 2',
    'package:',
    `  name: ${name}`,
    `  include: [${(include || ['src/**', 'docs/**', 'mod/**']).map(q).join(', ')}]`,
    '  exclude:',
    ...(exclude || ['**/node_modules/**']).map((s) => `    - ${q(s)}`),
    'secrets_paths:',
    ...(secrets || ['config/secrets/**']).map((s) => `  - ${q(s)}`),
    ...hostingLines,
    'sync:',
    '  lease_ttl_minutes: 120',
    'knowledge:',
    '  max_files_per_dir: 20',
    ...extra,
    '',
  ].join('\n');
}

function policyYaml() {
  return [
    'version: 1',
    'protected:',
    '  - ".claude/**"',
    '  - "CLAUDE.md"',
    '  - ".mcp.json"',
    '  - ".aidev/policy.yaml"',
    '  - ".aidev/sync.lock"',
    '  - ".aidev/materialized.json"',
    '  - "config/secrets/**"',
    'read_only:',
    '  - "**"',
    'writable_during_sync:',
    '  - ".aidev/knowledge/**"',
    'writable:',
    '  - ".aidev/knowledge/**"',
    '  - ".aidev/workflows/**"',
    '  - ".aidev/conventions/**"',
    '  - "aidev.yaml"',
    '',
  ].join('\n');
}

/**
 * Build a PKG clone with the kit set up.
 *
 * Returns { root, pkgDir (== root), pkgOrigin (the author clone), originGit,
 * pkgSha (the commit the Wiki describes; also HEAD and origin/main), cleanup }.
 */
function makeRepo({
  withWiki = true, withPolicy = true, withLock = true, withHooks = false,
  withAssets = true, realTemplates = false, withConfig = true,
  pkgFiles = null, hosting = 'azure-devops', configExtra = [],
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-test-'));
  const originGit = path.join(base, 'origin.git');
  const author = path.join(base, 'author');
  const root = path.join(base, 'pkg');

  // --- bare origin + author clone with the PKG's own files ---
  fs.mkdirSync(originGit, { recursive: true });
  git(['init', '-q', '--bare', '-b', 'main'], originGit);
  git(['-c', 'protocol.file.allow=always', 'clone', '-q', originGit, author], base);
  git(['checkout', '-q', '-b', 'main'], author);
  const files = pkgFiles || DEFAULT_PKG_FILES;
  for (const [rel, body] of Object.entries(files)) write(path.join(author, rel), body);
  git(['add', '-A'], author);
  git(['commit', '-q', '-m', 'initial'], author);
  git(['-c', 'protocol.file.allow=always', 'push', '-q', '-u', 'origin', 'main'], author);

  // --- the clone under test ---
  git(['-c', 'protocol.file.allow=always', 'clone', '-q', originGit, root], base);
  git(['config', 'protocol.file.allow', 'always'], root);
  git(['config', 'protocol.file.allow', 'always'], author);

  if (withConfig) write(path.join(root, 'aidev.yaml'), configYaml({ hosting, extra: configExtra }));
  write(path.join(root, '.aidev', '.gitignore'), require('../cli/lib/layout').AIDEV_GITIGNORE);
  if (withAssets) writeStaticAssets(root, { hooks: withHooks, realTemplates });
  if (withPolicy) write(path.join(root, '.aidev', 'policy.yaml'), policyYaml());

  // The Wiki describes the PKG's initial commit. The setup commit on top adds
  // only kit-managed files, which the state model ignores when deciding
  // whether the code moved — exactly what happens after a real `aidev init`.
  const pkgSha = git(['rev-parse', 'HEAD'], root);
  if (withWiki) {
    // The inventory records the PKG files the Wiki was generated from, as the
    // CLI writes it; the verdict compares it with the tree at HEAD.
    let records = [];
    let evidence;
    if (withConfig) {
      const inv = require('../cli/lib/inventory');
      const cfgMod = require('../cli/lib/config');
      const scope = require('../cli/lib/knowledge-scope');
      const config = cfgMod.loadConfig(root);
      records = (inv.scanPackage(root, config, { ref: pkgSha }) || [])
        .map((r) => ({ ...r, pages: [], selfHashes: {} }));
      evidence = scope.buildEvidenceSnapshot(scope.scanEvidence(root, config, { ref: pkgSha }) || [], records, config);
    }
    write(path.join(root, '.aidev', 'knowledge', 'index.md'), '# index\n');
    write(path.join(root, '.aidev', 'knowledge', 'inventory', '00.json'), `${JSON.stringify(records)}\n`);
    write(path.join(root, '.aidev', 'knowledge', 'manifest.json'), `${JSON.stringify({
      schemaVersion: 3, knowledgeSha: pkgSha, kitCommit: null,
      generatedAt: new Date().toISOString(), inventoryShards: ['inventory/00.json'],
      stats: { files: records.length, pages: 0, maskedFiles: 0 }, checkpoint: { pendingPaths: [] },
      ...(evidence ? { evidence } : {}),
    }, null, 2)}\n`);
  }
  if (withLock && withAssets) {
    const assets = require('../cli/lib/assets');
    assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
  }
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'aidev setup'], root);
  git(['push', '-q', 'origin', 'main'], root);
  const setupSha = git(['rev-parse', 'HEAD'], root);
  git(['pull', '-q', '--ff-only', 'origin', 'main'], author);

  return {
    root,
    pkgDir: root,
    pkgOrigin: author,
    originGit,
    /** The commit the Wiki describes (the PKG's initial commit). */
    pkgSha,
    /** HEAD == origin/main after setup (pkgSha + kit files). */
    setupSha,
    /** Re-record the lock after a test deliberately changes a static file. */
    relock() {
      const assets = require('../cli/lib/assets');
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
    },
    cleanup() { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

/**
 * Advance origin/main by one commit (through the author clone) and return the
 * new SHA. The clone under test does not see it until it fetches or pulls.
 */
function advancePkg(fx, rel = 'src/api/new.ts', body = 'export const x = 1;\n') {
  git(['pull', '-q', '--ff-only', 'origin', 'main'], fx.pkgOrigin);
  write(path.join(fx.pkgOrigin, rel), body);
  git(['add', '-A'], fx.pkgOrigin);
  git(['commit', '-q', '-m', `add ${rel}`], fx.pkgOrigin);
  git(['push', '-q', 'origin', 'main'], fx.pkgOrigin);
  return git(['rev-parse', 'HEAD'], fx.pkgOrigin);
}

/** Bring the clone under test up to origin/main (fast-forward). */
function pullPkg(fx) {
  git(['fetch', '-q', 'origin', 'main'], fx.root);
  git(['merge', '-q', '--ff-only', 'origin/main'], fx.root);
  return git(['rev-parse', 'HEAD'], fx.root);
}

module.exports = {
  makeRepo, advancePkg, pullPkg, git, write, writeStaticAssets, copyDir, configYaml, policyYaml, KIT_ROOT,
};
