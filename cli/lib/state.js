'use strict';
/**
 * The Wiki consistency model, for a developer working in their own PKG clone.
 *
 *   headSha       the commit the checkout is at — the code the Wiki must describe
 *   knowledgeSha  the commit the Wiki (.aidev/knowledge/manifest.json) says it
 *                 describes; informational, never the basis of the verdict
 *   trackingSha   tip of origin/<tracking_branch>; only used to warn that the
 *                 branch has moved on
 *
 * The verdict compares the *inventory* (the paths and blob ids the Wiki was
 * generated from) with the tree at HEAD. That needs no old commit object, so
 * it is the same after a fetch, a rebase, a squash or a force-push, and it is
 * what `aidev knowledge update` uses to decide what to regenerate.
 *
 *   inventory == tree at HEAD, nothing pending   → OK (or WARN when the
 *                                                  tracking branch moved on)
 *   inventory != tree at HEAD                    → WARN: the Wiki is behind
 *                                                  HEAD; update it
 *   prose still queued                           → WARN
 *   no Wiki, or a Wiki whose manifest is unreadable → ERROR. Nothing to reason
 *                                                  from; ordinary writes stop
 *                                                  until the Wiki exists.
 */

const path = require('path');
const git = require('./git');
const layout = require('./layout');
const { readJsonIfExists, writeJsonAtomic } = require('./config');
const inventory = require('./inventory');

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
  const branch = config?.hosting?.tracking_branch || config?.sync?.tracking_branch || 'main';
  const { headSha, baseSha, localTrackingSha } = resolveBase(repoRoot, branch);
  const kSha = knowledgeSha(repoRoot);

  let remote = { sha: null, ok: false, cached: false, checkedAt: null, reason: 'not checked' };
  if (checkRemote) remote = resolveRemoteSha(repoRoot, config, { force });
  const trackingSha = remote.sha || localTrackingSha;

  const manifest = readManifest(repoRoot);
  const hasWiki = manifest != null;
  const pendingPaths = Array.isArray(manifest?.checkpoint?.pendingPaths)
    ? manifest.checkpoint.pendingPaths : [];

  // The structured verdict: what the Wiki was generated from versus HEAD.
  let behind = null;
  if (hasWiki && headSha) {
    const records = inventory.readInventory(repoRoot, manifest);
    behind = inventory.compareWithTree(repoRoot, config, records, { ref: 'HEAD' });
  }

  let severity;
  let message;
  if (!hasWiki) {
    severity = SEVERITY.ERROR;
    message = `LLM Wiki has not been generated yet (${layout.KNOWLEDGE_REL}/manifest.json is missing). Run "aidev init" (or "aidev knowledge update").`;
  } else if (!headSha) {
    severity = SEVERITY.ERROR;
    message = 'HEAD could not be resolved — is this a git repository with at least one commit?';
  } else if (!kSha) {
    severity = SEVERITY.ERROR;
    message = `${layout.KNOWLEDGE_REL}/manifest.json does not record a valid knowledgeSha.`;
  } else if (behind == null) {
    severity = SEVERITY.ERROR;
    message = 'the tree at HEAD could not be listed, so the Wiki cannot be compared with it.';
  } else if (behind.behind) {
    severity = SEVERITY.WARN;
    message = `the Wiki describes ${short(kSha)}, but ${behind.changed} file(s) differ at HEAD (${short(headSha)}): `
      + `+${behind.added} ~${behind.modified} -${behind.removed} →${behind.renamed} — run "aidev knowledge update".`;
  } else if (pendingPaths.length > 0) {
    severity = SEVERITY.WARN;
    message = `${pendingPaths.length} page(s) still await prose regeneration — run "aidev knowledge update".`;
  } else if (checkRemote && !remote.ok) {
    severity = SEVERITY.UNKNOWN;
    message = `remote unverified (${remote.reason || 'unreachable'}); local state is internally consistent.`;
  } else if (localTrackingSha && localTrackingSha !== baseSha && sourceChanged(repoRoot, baseSha, localTrackingSha)) {
    severity = SEVERITY.WARN;
    message = `origin/${branch} has moved ahead (${short(localTrackingSha)}); work may continue. Merge or rebase, then "aidev knowledge update".`;
  } else if (remote.ok && remote.sha && remote.sha !== (localTrackingSha || baseSha)) {
    severity = SEVERITY.WARN;
    message = `origin/${branch} has new commits (${short(remote.sha)}) that are not fetched yet; "git fetch" then "aidev status" to see whether the Wiki needs an update.`;
  } else {
    severity = SEVERITY.OK;
    message = `the Wiki describes HEAD (${short(headSha)}).`;
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
    behind,
    wikiBehind: !!(behind && behind.behind),
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
  const head = `[ai-dev-kit] head=${short(state.headSha)}  knowledge=${short(state.knowledgeSha)}  tracking=${short(state.trackingSha)}`;
  return `${head}\n${icon} ${state.message}`;
}

module.exports = {
  SEVERITY, computeState, knowledgeSha, readManifest, manifestPath,
  resolveRemoteSha, resolveBase, sourceChanged, formatSummary, short, CACHE_REL,
};
