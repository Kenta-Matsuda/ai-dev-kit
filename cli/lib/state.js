'use strict';
/**
 * The three-SHA consistency model, for a developer working in their own PKG
 * clone (typically on a feature branch).
 *
 *   trackingSha   tip of origin/<tracking_branch> — the code the Wiki is meant
 *                 to describe next
 *   baseSha       merge-base of HEAD and the tracking branch — the tracking
 *                 commit the current work is built on
 *   knowledgeSha  the commit the Wiki (.aidev/knowledge/manifest.json) describes
 *
 * A feature branch is expected to differ from the tracking branch, so
 * consistency is not "HEAD == knowledgeSha". It is: does the Wiki describe the
 * base this work stands on?
 *
 *   knowledgeSha == baseSha                   → OK (or WARN if prose is pending
 *                                               or the tracking branch moved on)
 *   knowledgeSha behind baseSha               → WARN. The base contains changes
 *                                               the Wiki has not seen; sync soon.
 *   knowledgeSha not in this branch's history → WARN. Wrong branch, or a Wiki
 *                                               from somewhere else.
 *   no Wiki, or a Wiki whose manifest is unreadable → ERROR. Nothing to reason
 *                                               from; ordinary writes stop
 *                                               until "aidev knowledge build".
 */

const path = require('path');
const git = require('./git');
const layout = require('./layout');
const { readJsonIfExists, writeJsonAtomic } = require('./config');

const SEVERITY = { OK: 'ok', UNKNOWN: 'unknown', WARN: 'warn', ERROR: 'error' };

const CACHE_REL = path.join('.aidev', 'cache', 'remote-check.json');

function manifestPath(repoRoot) {
  return layout.abs(repoRoot, `${layout.KNOWLEDGE_REL}/manifest.json`);
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
 * Resolve trackingSha on the remote with a timeout and a TTL cache.
 *
 * SessionStart has a time budget, so a slow or offline network must degrade to
 * "unverified" rather than blocking the session.
 */
function resolveRemoteSha(repoRoot, config, { useCache = true, force = false } = {}) {
  const branch = config?.sync?.tracking_branch || 'main';
  const timeoutMs = config?.sync?.remote_check_timeout_ms ?? 3000;
  const ttlMin = config?.sync?.remote_check_ttl_minutes ?? 60;

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
  const res = git.remoteSha(repoRoot, 'origin', branch, timeoutMs);
  const entry = { branch, sha: res.sha, reason: res.reason, checkedAt: new Date().toISOString() };
  writeRemoteCache(repoRoot, entry);
  return { sha: res.sha, ok: res.ok, cached: false, checkedAt: entry.checkedAt, reason: res.reason };
}

/** Did the package's own files (not the kit's) change between two commits? */
function sourceChanged(repoRoot, a, b) {
  const changed = git.treeChanged(repoRoot, a, b, layout.KIT_MANAGED_GLOBS.map((g) => g.replace(/\/\*\*$/, '')));
  // Unknown (a commit is missing) is treated as changed: the safe side.
  return changed == null ? true : changed;
}

/** The tracking commit the current HEAD is built on. */
function resolveBase(repoRoot, branch) {
  const head = git.headSha(repoRoot);
  if (!head) return { headSha: null, baseSha: null, localTrackingSha: null };
  const local = git.revParse(repoRoot, `origin/${branch}`);
  const base = local ? (git.mergeBase(repoRoot, head, local) || head) : head;
  return { headSha: head, baseSha: base, localTrackingSha: local };
}

/**
 * Compute the full consistency state.
 *
 * `checkRemote: false` yields a purely local verdict, which is what the
 * PreToolUse guard uses — the error condition never depends on the network.
 */
function computeState(repoRoot, config, { checkRemote = true, force = false } = {}) {
  const branch = config?.sync?.tracking_branch || 'main';
  const { headSha, baseSha, localTrackingSha } = resolveBase(repoRoot, branch);
  const kSha = knowledgeSha(repoRoot);

  let remote = { sha: null, ok: false, cached: false, checkedAt: null, reason: 'not checked' };
  if (checkRemote) remote = resolveRemoteSha(repoRoot, config, { force });
  const trackingSha = remote.sha || localTrackingSha;

  const manifest = readManifest(repoRoot);
  const hasWiki = manifest != null;
  const pendingPaths = Array.isArray(manifest?.checkpoint?.pendingPaths)
    ? manifest.checkpoint.pendingPaths : [];

  let severity;
  let message;
  if (!hasWiki) {
    severity = SEVERITY.ERROR;
    message = `LLM Wiki has not been generated yet (${layout.KNOWLEDGE_REL}/manifest.json is missing). Run "aidev knowledge build".`;
  } else if (!headSha) {
    severity = SEVERITY.ERROR;
    message = 'HEAD could not be resolved — is this a git repository with at least one commit?';
  } else if (!kSha) {
    severity = SEVERITY.ERROR;
    message = `${layout.KNOWLEDGE_REL}/manifest.json does not record a valid knowledgeSha.`;
  } else if (!git.commitExists(repoRoot, kSha)) {
    severity = SEVERITY.WARN;
    message = `the Wiki describes ${short(kSha)}, a commit this clone does not have. Fetch, check the branch, or run "aidev sync".`;
  } else if (sourceChanged(repoRoot, kSha, baseSha)) {
    // Only the package's own files count: the commit that adds the Wiki, or a
    // kit update, changes nothing the Wiki describes.
    severity = SEVERITY.WARN;
    message = `the code this work is based on (${short(baseSha)}) has changed since the Wiki was generated (${short(kSha)}) — run "aidev sync" to catch up.`;
  } else if (pendingPaths.length > 0) {
    severity = SEVERITY.WARN;
    message = `${pendingPaths.length} page(s) still await prose regeneration — run "aidev knowledge build".`;
  } else if (checkRemote && !remote.ok) {
    severity = SEVERITY.UNKNOWN;
    message = `remote unverified (${remote.reason || 'unreachable'}); local state is internally consistent.`;
  } else if (localTrackingSha && localTrackingSha !== baseSha && sourceChanged(repoRoot, baseSha, localTrackingSha)) {
    severity = SEVERITY.WARN;
    message = `origin/${branch} has moved ahead (${short(localTrackingSha)}); work may continue. Run "aidev sync" to catch up.`;
  } else if (remote.ok && remote.sha && remote.sha !== (localTrackingSha || baseSha)) {
    severity = SEVERITY.WARN;
    message = `origin/${branch} has new commits (${short(remote.sha)}) that are not fetched yet; "git fetch" then "aidev status" to see whether the Wiki needs a sync.`;
  } else {
    severity = SEVERITY.OK;
    message = 'the Wiki describes the code this work is based on.';
  }

  return {
    trackingSha,
    baseSha,
    headSha,
    knowledgeSha: kSha,
    localTrackingSha,
    severity,
    message,
    remoteChecked: checkRemote,
    remoteOk: remote.ok,
    remoteCached: remote.cached,
    remoteCheckedAt: remote.checkedAt,
    remoteReason: remote.reason,
    hasWiki,
    pendingPages: pendingPaths.length,
    trackingBranch: branch,
  };
}

function short(sha) {
  return sha ? String(sha).slice(0, 7) : '-';
}

/** One-line summary for SessionStart. */
function formatSummary(state) {
  const icon = { ok: '✅', unknown: 'ℹ️', warn: '⚠️', error: '❌' }[state.severity] || '•';
  const head = `[ai-dev-kit] base=${short(state.baseSha)}  knowledge=${short(state.knowledgeSha)}  tracking=${short(state.trackingSha)}`;
  return `${head}\n${icon} ${state.message}`;
}

module.exports = {
  SEVERITY, computeState, knowledgeSha, readManifest, manifestPath,
  resolveRemoteSha, resolveBase, sourceChanged, formatSummary, short, CACHE_REL,
};
