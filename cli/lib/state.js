'use strict';
/**
 * The three-SHA consistency model.
 *
 *   remoteSha     tip of the PKG tracking branch — the true source
 *   submoduleSha  what the wrapper has checked out
 *   knowledgeSha  what the Wiki actually describes
 *
 * The decisive distinction:
 *
 *   remoteSha != submoduleSha  while submoduleSha == knowledgeSha
 *       → WARNING. Behind, but internally consistent: the Wiki correctly
 *         describes the code on disk, so work may continue.
 *
 *   submoduleSha != knowledgeSha
 *       → ERROR. The Wiki describes code that is not checked out, so the AI
 *         would be reasoning from false information. Writes stop.
 *
 *   submoduleSha == knowledgeSha but prose pages are still queued
 *       → WARNING. The structured inventory is current, so nothing is
 *         misfiled, but some pages still carry prose written for older code.
 *         Work continues — blocking here would deadlock sync, which must
 *         finish before the builder can run — yet the state must not claim
 *         full currency, or stale prose is read as fresh.
 */

const path = require('path');
const fs = require('fs');
const git = require('./git');
const { readJsonIfExists, writeJsonAtomic } = require('./config');

const SEVERITY = { OK: 'ok', UNKNOWN: 'unknown', WARN: 'warn', ERROR: 'error' };

const CACHE_REL = path.join('.aidev', 'cache', 'remote-check.json');

function manifestPath(repoRoot) {
  return path.join(repoRoot, 'knowledge', 'manifest.json');
}

function readManifest(repoRoot) {
  return readJsonIfExists(manifestPath(repoRoot));
}

function knowledgeSha(repoRoot) {
  const m = readManifest(repoRoot);
  if (!m) return null;
  const sha = m.knowledgeSha || m.targetSha || null;
  return git.isSha(sha) ? sha : null;
}

function readRemoteCache(repoRoot) {
  return readJsonIfExists(path.join(repoRoot, CACHE_REL));
}

function writeRemoteCache(repoRoot, entry) {
  try { writeJsonAtomic(path.join(repoRoot, CACHE_REL), entry); } catch { /* cache is best-effort */ }
}

/**
 * Resolve remoteSha with a timeout and a TTL cache.
 *
 * SessionStart has a time budget, so a slow or offline network must degrade to
 * "unverified" rather than blocking the session.
 */
function resolveRemoteSha(repoRoot, config, { submodulePath = 'src', useCache = true, force = false } = {}) {
  const branch = config?.sync?.tracking_branch || 'main';
  const timeoutMs = config?.sync?.remote_check_timeout_ms ?? 3000;
  const ttlMin = config?.sync?.remote_check_ttl_minutes ?? 60;
  const subDir = path.join(repoRoot, submodulePath);

  if (useCache && !force && ttlMin > 0) {
    const cached = readRemoteCache(repoRoot);
    if (cached && cached.branch === branch && cached.checkedAt) {
      const age = Date.now() - Date.parse(cached.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < ttlMin * 60000) {
        return { sha: cached.sha || null, ok: !!cached.sha, cached: true,
          checkedAt: cached.checkedAt, reason: cached.reason || null };
      }
    }
  }
  if (!fs.existsSync(subDir)) {
    return { sha: null, ok: false, cached: false, checkedAt: new Date().toISOString(),
      reason: `submodule directory not found: ${submodulePath}` };
  }
  const res = git.remoteSha(subDir, 'origin', branch, timeoutMs);
  const entry = {
    branch, sha: res.sha, reason: res.reason,
    checkedAt: new Date().toISOString(),
  };
  writeRemoteCache(repoRoot, entry);
  return { sha: res.sha, ok: res.ok, cached: false, checkedAt: entry.checkedAt, reason: res.reason };
}

/**
 * Compute the full consistency state.
 *
 * `checkRemote: false` yields a purely local verdict, which is what the
 * PreToolUse guard uses — the error condition never depends on the network.
 */
function computeState(repoRoot, config, { submodulePath = 'src', checkRemote = true, force = false } = {}) {
  const subSha = git.submoduleSha(repoRoot, submodulePath);
  const worktreeSha = git.submoduleWorktreeSha(repoRoot, submodulePath);
  const kSha = knowledgeSha(repoRoot);
  // The checked-out tree is what generation actually reads, so prefer it when
  // it disagrees with the recorded gitlink (mid-bump, or a dirty worktree).
  const effectiveSub = worktreeSha || subSha;

  let remote = { sha: null, ok: false, cached: false, checkedAt: null, reason: 'not checked' };
  if (checkRemote) {
    remote = resolveRemoteSha(repoRoot, config, { submodulePath, force });
  }

  const manifest = readManifest(repoRoot);
  const hasWiki = manifest != null;
  const pendingPaths = Array.isArray(manifest?.checkpoint?.pendingPaths)
    ? manifest.checkpoint.pendingPaths : [];

  let severity;
  let message;
  if (!hasWiki) {
    severity = SEVERITY.ERROR;
    message = 'LLM Wiki has not been generated yet (knowledge/manifest.json is missing). Run "aidev knowledge build".';
  } else if (!effectiveSub) {
    severity = SEVERITY.ERROR;
    message = `submodule SHA could not be determined at "${submodulePath}" — run "git submodule update --init --recursive".`;
  } else if (!kSha) {
    severity = SEVERITY.ERROR;
    message = 'knowledge/manifest.json does not record a valid knowledgeSha.';
  } else if (effectiveSub !== kSha) {
    severity = SEVERITY.ERROR;
    message = `the Wiki describes ${short(kSha)} but ${short(effectiveSub)} is checked out — run "aidev sync".`;
  } else if (pendingPaths.length > 0) {
    // Deliberately a warning, not an error: sync must be able to complete and
    // release its lease before the knowledge-builder agent can run at all.
    severity = SEVERITY.WARN;
    message = `${pendingPaths.length} page(s) still await prose regeneration — run "aidev knowledge build --refresh".`;
  } else if (checkRemote && !remote.ok) {
    severity = SEVERITY.UNKNOWN;
    message = `remote unverified (${remote.reason || 'unreachable'}); local state is internally consistent.`;
  } else if (checkRemote && remote.sha && remote.sha !== effectiveSub) {
    severity = SEVERITY.WARN;
    message = `the PKG tracking branch has moved ahead (remote ${short(remote.sha)}); work may continue. Run "aidev sync" to catch up.`;
  } else {
    severity = SEVERITY.OK;
    message = 'all three SHAs agree.';
  }

  return {
    remoteSha: remote.sha,
    submoduleSha: effectiveSub,
    recordedSubmoduleSha: subSha,
    worktreeSubmoduleSha: worktreeSha,
    knowledgeSha: kSha,
    severity,
    message,
    remoteChecked: checkRemote,
    remoteOk: remote.ok,
    remoteCached: remote.cached,
    remoteCheckedAt: remote.checkedAt,
    remoteReason: remote.reason,
    hasWiki,
    pendingPages: pendingPaths.length,
    trackingBranch: config?.sync?.tracking_branch || 'main',
  };
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '-';
}

/** One-line summary for SessionStart. */
function formatSummary(state) {
  const icon = { ok: '✅', unknown: 'ℹ️', warn: '⚠️', error: '❌' }[state.severity] || '•';
  const head = `[ai-dev-kit] src=${short(state.submoduleSha)}  knowledge=${short(state.knowledgeSha)}  remote=${short(state.remoteSha)}`;
  return `${head}\n${icon} ${state.message}`;
}

module.exports = {
  SEVERITY, computeState, knowledgeSha, readManifest, manifestPath,
  resolveRemoteSha, formatSummary, short, CACHE_REL,
};
