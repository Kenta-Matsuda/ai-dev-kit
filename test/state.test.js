'use strict';
/** Three-SHA state model: the warning/error boundary and offline degradation. */

const path = require('path');
const fs = require('fs');
const { suite, test, eq, ok } = require('./harness');
const { makeRepo, advancePkg, git } = require('./fixtures');
const state = require('../cli/lib/state');
const cfg = require('../cli/lib/config');

function run() {
  suite('state: three-SHA verdicts');

  test('all three agreeing is OK', () => {
    const fx = makeRepo();
    try {
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      eq(st.severity, 'ok');
      eq(st.submoduleSha, fx.pkgSha);
      eq(st.knowledgeSha, fx.pkgSha);
    } finally { fx.cleanup(); }
  });

  test('behind but internally consistent is a WARNING, not an error', () => {
    const fx = makeRepo();
    try {
      // Remote advances; the wrapper stays where it is.
      advancePkg(fx);
      const config = cfg.loadConfig(fx.root);
      const st = state.computeState(fx.root, config, { checkRemote: true, force: true });
      eq(st.severity, 'warn', st.message);
      ok(st.remoteSha !== st.submoduleSha, 'remote ahead');
      eq(st.submoduleSha, st.knowledgeSha, 'internally consistent');
    } finally { fx.cleanup(); }
  });

  test('wiki describing other code is an ERROR', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.pkgDir);
      git(['checkout', '-q', newSha], fx.pkgDir);
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      eq(st.severity, 'error');
      ok(st.submoduleSha !== st.knowledgeSha, 'mismatch detected');
    } finally { fx.cleanup(); }
  });

  test('an unreachable remote degrades to UNKNOWN, never to an error', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      // Point origin at a path that does not exist.
      git(['remote', 'set-url', 'origin', path.join(fx.root, 'no-such-remote')], fx.pkgDir);
      const st = state.computeState(fx.root, config, { checkRemote: true, force: true });
      eq(st.severity, 'unknown', st.message);
      eq(st.remoteOk, false);
      ok(st.submoduleSha === st.knowledgeSha, 'local consistency still verified');
    } finally { fx.cleanup(); }
  });

  test('a missing Wiki is an error that names the fix', () => {
    const fx = makeRepo({ withWiki: false });
    try {
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      eq(st.severity, 'error');
      ok(/knowledge build/.test(st.message), st.message);
    } finally { fx.cleanup(); }
  });

  test('a manifest without a valid SHA is an error', () => {
    const fx = makeRepo();
    try {
      fs.writeFileSync(state.manifestPath(fx.root), JSON.stringify({ schemaVersion: 2, knowledgeSha: 'not-a-sha' }));
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      eq(st.severity, 'error');
      ok(/knowledgeSha/.test(st.message), st.message);
    } finally { fx.cleanup(); }
  });

  test('the remote check is cached within its TTL', () => {
    const fx = makeRepo();
    try {
      const config = cfg.loadConfig(fx.root);
      const first = state.resolveRemoteSha(fx.root, config, { force: true });
      eq(first.cached, false);
      const second = state.resolveRemoteSha(fx.root, config, {});
      eq(second.cached, true, 'served from cache');
      eq(second.sha, first.sha);
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

  test('the summary line reports all three SHAs', () => {
    const fx = makeRepo();
    try {
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      const s = state.formatSummary(st);
      ok(/\[ai-dev-kit\]/.test(s), s);
      ok(/src=/.test(s) && /knowledge=/.test(s) && /remote=/.test(s), s);
    } finally { fx.cleanup(); }
  });

  test('a dirty checkout is judged on what is actually checked out', () => {
    const fx = makeRepo();
    try {
      const newSha = advancePkg(fx);
      git(['fetch', '-q', 'origin', 'main'], fx.pkgDir);
      git(['checkout', '-q', newSha], fx.pkgDir);
      const st = state.computeState(fx.root, cfg.loadConfig(fx.root), { checkRemote: false });
      // The gitlink still records the old SHA; the worktree is what matters.
      eq(st.worktreeSubmoduleSha, newSha);
      eq(st.submoduleSha, newSha, 'worktree wins');
      eq(st.severity, 'error');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };
