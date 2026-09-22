'use strict';
/**
 * Wiki state model (inventory vs HEAD, tracking branch): the warning/error
 * boundary, kit-managed noise filtering and offline degradation.
 */

const path = require('path');
const fs = require('fs');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, pullPkg, git, write } = require('./fixtures');
const state = require('../cli/lib/state');
const cfg = require('../cli/lib/config');

function local(fx) {
  return state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
}

function run() {
  suite('state: verdicts');

  test('a freshly set-up clone is OK', () => {
    const fx = makeRepo();
    try {
      const st = local(fx);
      eq(st.severity, 'ok', st.message);
      eq(st.knowledgeSha, fx.pkgSha, 'the Wiki describes the PKG commit');
      eq(st.headSha, fx.setupSha);
      eq(st.baseSha, fx.setupSha, 'base is HEAD when HEAD is on the tracking branch');
      eq(st.localTrackingSha, fx.setupSha);
      eq(st.hasWiki, true);
      eq(st.pendingPages, 0);
      eq(st.trackingBranch, 'main');
      eq(st.remoteChecked, false);
      ok(!('submoduleSha' in st) && !('remoteSha' in st), 'no submodule-era fields');
    } finally { fx.cleanup(); }
  });

  test('the setup commit (kit files only) does not count as the code moving', () => {
    const fx = makeRepo();
    try {
      ok(fx.setupSha !== fx.pkgSha, 'setup is a separate commit');
      eq(state.sourceChanged(fx.root, fx.pkgSha, fx.setupSha), false);
      eq(local(fx).severity, 'ok');
    } finally { fx.cleanup(); }
  });

  test('pulling a PKG change the Wiki has not seen is a WARNING that names the update', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      eq(pullPkg(fx), newSha);
      const st = local(fx);
      eq(st.severity, 'warn', st.message);
      ok(/knowledge update/.test(st.message), st.message);
      eq(st.wikiBehind, true);
      eq(st.behind.added, 1, 'the new file is what differs');
      eq(st.baseSha, newSha);
      eq(st.knowledgeSha, fx.pkgSha, 'the Wiki still describes the old commit');
    } finally { fx.cleanup(); }
  });

  test('remote ahead but unfetched is a WARNING, not an error', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: true, force: true });
      eq(st.severity, 'warn', st.message);
      ok(/not fetched/.test(st.message), st.message);
      eq(st.trackingSha, newSha, 'ls-remote saw the new tip');
      eq(st.remoteOk, true);
      eq(st.baseSha, fx.setupSha, 'base is still the local tracking commit');
      eq(st.knowledgeSha, fx.pkgSha, 'internally consistent');
    } finally { fx.cleanup(); }
  });

  test('a fetched-but-unmerged tracking branch is a WARNING that work may continue', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.root);
      const st = local(fx);
      eq(st.severity, 'warn', st.message);
      ok(/moved ahead/.test(st.message), st.message);
      eq(st.localTrackingSha, newSha);
      eq(st.baseSha, fx.setupSha, 'HEAD still sits on the old base');
      eq(st.trackingSha, newSha, 'without a remote check the local tracking ref stands in');
    } finally { fx.cleanup(); }
  });

  test('a feature branch commit that adds a PKG file puts the Wiki behind HEAD', () => {
    const fx = makeRepo();
    try {
      git(['checkout', '-q', '-b', 'feature/x'], fx.root);
      write(path.join(fx.root, 'src', 'api', 'feature.ts'), 'export const f = 1;\n');
      git(['add', '-A'], fx.root);
      git(['commit', '-q', '-m', 'feature work'], fx.root);
      const head = git(['rev-parse', 'HEAD'], fx.root);
      const st = local(fx);
      eq(st.headSha, head);
      eq(st.baseSha, fx.setupSha, 'merge-base with origin/main');
      eq(st.severity, 'warn', st.message);
      eq(st.wikiBehind, true, 'the Wiki describes the branch HEAD, not the base');
      const rb = state.resolveBase(fx.root, 'main');
      eq(rb, { headSha: head, baseSha: fx.setupSha, localTrackingSha: fx.setupSha });
    } finally { fx.cleanup(); }
  });

  test('a knowledgeSha this clone lacks does not matter while the inventory matches HEAD', () => {
    const fx = makeRepo();
    try {
      const m = JSON.parse(fs.readFileSync(state.manifestPath(fx.root), 'utf8'));
      m.knowledgeSha = 'a'.repeat(40);
      fs.writeFileSync(state.manifestPath(fx.root), JSON.stringify(m));
      const st = local(fx);
      eq(st.severity, 'ok', st.message);
      eq(st.wikiBehind, false);
      eq(st.knowledgeSha, 'a'.repeat(40), 'informational only');
    } finally { fx.cleanup(); }
  });

  test('pending prose is a WARNING that names the update', () => {
    const fx = makeRepo();
    try {
      const m = JSON.parse(fs.readFileSync(state.manifestPath(fx.root), 'utf8'));
      m.checkpoint = { pendingPaths: ['src/api/auth.ts', 'src/api/routing.ts'] };
      fs.writeFileSync(state.manifestPath(fx.root), JSON.stringify(m));
      const st = local(fx);
      eq(st.severity, 'warn', st.message);
      ok(/knowledge update/.test(st.message), st.message);
      eq(st.pendingPages, 2);
    } finally { fx.cleanup(); }
  });

  test('an unreachable remote degrades to UNKNOWN, never to an error', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      // Point origin at a path that does not exist.
      git(['remote', 'set-url', 'origin', path.join(fx.root, 'no-such-remote')], fx.root);
      const st = state.computeState(fx.root, config, { checkRemote: true, force: true });
      eq(st.severity, 'unknown', st.message);
      eq(st.remoteOk, false);
      eq(st.knowledgeSha, fx.pkgSha, 'local consistency still verified');
      eq(st.trackingSha, fx.setupSha, 'falls back to the local tracking ref');
    } finally { fx.cleanup(); }
  });

  test('a local WARNING outranks an unreachable remote', () => {
    const fx = makeRepo();
    try {
      advancePkg(fx);
      pullPkg(fx);
      const config = cfg.loadConfig(fx.root);
      git(['remote', 'set-url', 'origin', path.join(fx.root, 'no-such-remote')], fx.root);
      const st = state.computeState(fx.root, config, { checkRemote: true, force: true });
      eq(st.severity, 'warn', st.message);
      eq(st.remoteOk, false);
    } finally { fx.cleanup(); }
  });

  test('a missing Wiki is an error that names the fix', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const st = local(fx);
      eq(st.severity, 'error');
      eq(st.hasWiki, false);
      eq(st.knowledgeSha, null);
      ok(/aidev init/.test(st.message), st.message);
      ok(/\.aidev\/knowledge\/manifest\.json/.test(st.message), st.message);
    } finally { fx.cleanup(); }
  });

  test('a manifest without a valid SHA is an error', () => {
    const fx = makeRepo();
    try {
      fs.writeFileSync(state.manifestPath(fx.root), JSON.stringify({ schemaVersion: 3, knowledgeSha: 'not-a-sha' }));
      const st = local(fx);
      eq(st.severity, 'error');
      ok(/knowledgeSha/.test(st.message), st.message);
    } finally { fx.cleanup(); }
  });

  test('the manifest lives at .aidev/knowledge/manifest.json', () => {
    const fx = makeRepo();
    try {
      eq(path.relative(fx.root, state.manifestPath(fx.root)).split(path.sep).join('/'), '.aidev/knowledge/manifest.json');
      eq(state.knowledgeSha(fx.root), fx.pkgSha);
      eq(state.readManifest(fx.root).schemaVersion, 3);
    } finally { fx.cleanup(); }
  });

  suite('state: sourceChanged ignores kit-managed files');

  test('a commit touching only kit-managed files is not a source change', () => {
    const fx = makeRepo();
    try {
      write(path.join(fx.root, 'CLAUDE.md'), '# updated instructions\n');
      write(path.join(fx.root, '.claude', 'agents', 'new-agent.md'), '---\nname: new\n---\n');
      write(path.join(fx.root, '.mcp.json'), '{"mcpServers":{}}\n');
      write(path.join(fx.root, 'aidev.yaml'), `${fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8')}# trailing\n`);
      write(path.join(fx.root, '.aidev', 'knowledge', 'overview.md'), '# overview\n');
      write(path.join(fx.root, '.aidev', 'workflows', 'flow', 'loop.py'), 'print(1)\n');
      git(['add', '-A'], fx.root);
      git(['commit', '-q', '-m', 'kit update'], fx.root);
      const kitSha = git(['rev-parse', 'HEAD'], fx.root);
      eq(state.sourceChanged(fx.root, fx.pkgSha, kitSha), false, 'kit-only diff ignored');
      eq(state.sourceChanged(fx.root, fx.setupSha, kitSha), false);
      eq(local(fx).severity, 'ok', 'still OK after a kit update');
    } finally { fx.cleanup(); }
  });

  test('a PKG file change is a source change', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx, 'src/api/new.ts');
      pullPkg(fx);
      eq(state.sourceChanged(fx.root, fx.pkgSha, newSha), true);
      eq(state.sourceChanged(fx.root, fx.setupSha, newSha), true);
      const docSha = advancePkg(fx, 'README.md', '# renamed\n');
      pullPkg(fx);
      eq(state.sourceChanged(fx.root, newSha, docSha), true, 'files outside package.include still count');
    } finally { fx.cleanup(); }
  });

  test('identical commits and unknown commits resolve safely', () => {
    const fx = makeRepo();
    try {
      eq(state.sourceChanged(fx.root, fx.pkgSha, fx.pkgSha), false);
      eq(state.sourceChanged(fx.root, fx.pkgSha, 'a'.repeat(40)), true, 'unknown commit is treated as changed');
    } finally { fx.cleanup(); }
  });

  suite('state: remote check cache');

  test('the remote check is cached within its TTL', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const first = state.resolveRemoteSha(fx.root, config, { force: true });
      eq(first.cached, false);
      eq(first.sha, fx.setupSha);
      const second = state.resolveRemoteSha(fx.root, config, {});
      eq(second.cached, true, 'served from cache');
      eq(second.sha, first.sha);
      ok(fs.existsSync(path.join(fx.root, state.CACHE_REL)), 'cache under .aidev/cache');
      ok(/^\.aidev[\\/]cache[\\/]/.test(state.CACHE_REL), state.CACHE_REL);
    } finally { fx.cleanup(); }
  });

  test('a zero TTL disables the cache', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      config.sync.remote_check_ttl_minutes = 0;
      state.resolveRemoteSha(fx.root, config, { force: true });
      eq(state.resolveRemoteSha(fx.root, config, {}).cached, false);
    } finally { fx.cleanup(); }
  });

  test('computeState reports whether the remote answer came from the cache', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const first = state.computeState(fx.root, config, { checkRemote: true, force: true });
      eq(first.remoteCached, false);
      eq(first.severity, 'ok', first.message);
      const second = state.computeState(fx.root, config, { checkRemote: true });
      eq(second.remoteCached, true);
      eq(second.severity, 'ok', second.message);
    } finally { fx.cleanup(); }
  });

  suite('state: summary');

  test('the summary line reports head, knowledge and tracking', () => {
    const fx = makeRepo();
    try {
      const st = local(fx);
      const s = state.formatSummary(st);
      ok(/\[ai-dev-kit\]/.test(s), s);
      ok(/head=/.test(s) && /knowledge=/.test(s) && /tracking=/.test(s), s);
      ok(s.includes(`head=${fx.setupSha.slice(0, 7)}`), s);
      ok(!/base=/.test(s), 'base is no longer the reference point');
      ok(s.includes(`knowledge=${fx.pkgSha.slice(0, 7)}`), s);
      ok(!/src=|remote=/.test(s), 'no wrapper-era labels');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
