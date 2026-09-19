'use strict';
/**
 * Lease management.
 *
 * Two distinct leases exist, and conflating them would reopen the deadlock
 * this design exists to solve:
 *
 *   sync lease  (.aidev/sync.lock)          — held by `aidev sync`, permits
 *                                             writes to knowledge/** while
 *                                             submoduleSha != knowledgeSha.
 *   work lease  (.aidev/leases/<taskId>.json) — held by issue-to-pr, permits
 *                                             writes to a scoped subset of
 *                                             src/** on a dedicated branch.
 *
 * Both are TTL-bound and both are themselves protected paths, so an agent can
 * never mint or extend its own permission.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonIfExists, syncLockPath, nowIso } = require('./config');
const { AidevError } = require('./errors');
const git = require('./git');

const LEASES_DIR_REL = path.join('.aidev', 'leases');

function leasesDir(repoRoot) { return path.join(repoRoot, LEASES_DIR_REL); }

function leasePath(repoRoot, taskId) {
  return path.join(leasesDir(repoRoot), `${sanitizeTaskId(taskId)}.json`);
}

/**
 * Task ids become filenames, so they must not traverse. Restricting to a
 * conservative charset is simpler to audit than escaping.
 */
function sanitizeTaskId(taskId) {
  const s = String(taskId == null ? '' : taskId).trim();
  if (s === '') throw new AidevError('taskId is required');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s) || s === '.' || s === '..') {
    throw new AidevError(`invalid taskId: ${s} (allowed: letters, digits, dot, dash, underscore)`);
  }
  return s;
}

function minutesToMs(m) { return Math.round(Number(m) * 60 * 1000); }

function parseTime(v) {
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** A lease is valid only when well-formed AND unexpired. */
function evaluateLease(lease, now = Date.now()) {
  if (!lease || typeof lease !== 'object') return { valid: false, reason: 'missing' };
  const acquired = parseTime(lease.acquiredAt);
  if (acquired == null) return { valid: false, reason: 'malformed acquiredAt' };
  const ttlMin = Number(lease.ttlMinutes);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) return { valid: false, reason: 'malformed ttlMinutes' };
  const expiresAt = acquired + minutesToMs(ttlMin);
  if (now >= expiresAt) {
    return { valid: false, reason: 'expired', expiredAt: new Date(expiresAt).toISOString() };
  }
  return { valid: true, reason: null, expiresAt: new Date(expiresAt).toISOString() };
}

// ---------------------------------------------------------------- sync lease

function readSyncLease(repoRoot) {
  return readJsonIfExists(syncLockPath(repoRoot));
}

/**
 * Acquire the sync lease.
 *
 * Refuses to steal a live lease. An expired lease is reported, never silently
 * adopted — the operator must choose `--resume` or `--abort` so that a
 * half-bumped submodule is reconciled deliberately.
 */
function acquireSyncLease(repoRoot, { targetSha, originalSha, taskId = null, ttlMinutes = 120, force = false }) {
  const existing = readSyncLease(repoRoot);
  if (existing && !force) {
    const ev = evaluateLease(existing);
    if (ev.valid) {
      throw new AidevError(
        `sync lease already held (target=${existing.targetSha}, acquired=${existing.acquiredAt}). ` +
        'Use "aidev sync --resume" to continue it or "aidev sync --abort" to release it.');
    }
    throw new AidevError(
      `a stale sync lease is present (${ev.reason}; target=${existing.targetSha}). ` +
      'Refusing to adopt it silently — run "aidev sync --resume" to verify and continue, ' +
      'or "aidev sync --abort" to restore the original submodule SHA.');
  }
  const lease = {
    schemaVersion: 1,
    kind: 'sync',
    targetSha: targetSha || null,
    originalSha: originalSha || null,
    taskId: taskId || null,
    acquiredAt: nowIso(),
    ttlMinutes,
    pid: process.pid,
  };
  writeJsonAtomic(syncLockPath(repoRoot), lease);
  return lease;
}

function releaseSyncLease(repoRoot) {
  const p = syncLockPath(repoRoot);
  try { fs.unlinkSync(p); return true; } catch { return false; }
}

// ---------------------------------------------------------------- work lease

/**
 * Create a work lease for issue-to-pr.
 *
 * The caller must have confirmed human approval; this function enforces the
 * mechanical half of the contract — branch shape, path scoping, TTL — and
 * refuses to grant anything touching secrets or protected config.
 */
function createWorkLease(repoRoot, {
  taskId, workItemId = null, branch, allowedPaths = [], ttlMinutes = 120,
  approvedBy = null, secretsPaths = [], protectedPaths = [],
}) {
  const id = sanitizeTaskId(taskId);
  if (!branch || !/^ai\/wi-[A-Za-z0-9._-]+$/.test(String(branch))) {
    throw new AidevError(
      `work lease branch must match "ai/wi-<id>" (got: ${branch}) — ` +
      'leases are scoped to a dedicated agent branch');
  }
  const paths = Array.isArray(allowedPaths) ? allowedPaths.filter(Boolean).map(String) : [];
  if (paths.length === 0) throw new AidevError('work lease requires at least one allowed path');
  // A lease may never widen into secrets or the kit's own control surface.
  const pathsMod = require('./paths');
  for (const p of paths) {
    for (const bad of [...secretsPaths, ...protectedPaths]) {
      if (pathsMod.normalizeRel(p) === pathsMod.normalizeRel(bad)) {
        throw new AidevError(`work lease must not cover protected path: ${p}`);
      }
    }
  }
  const lease = {
    schemaVersion: 1,
    kind: 'work',
    taskId: id,
    workItemId,
    branch: String(branch),
    allowedPaths: paths,
    acquiredAt: nowIso(),
    ttlMinutes,
    approvedBy,
  };
  writeJsonAtomic(leasePath(repoRoot, id), lease);
  return lease;
}

function readWorkLease(repoRoot, taskId) {
  return readJsonIfExists(leasePath(repoRoot, taskId));
}

function listWorkLeases(repoRoot) {
  const dir = leasesDir(repoRoot);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const lease = readJsonIfExists(path.join(dir, n));
    if (lease) out.push(lease);
  }
  return out;
}

function releaseWorkLease(repoRoot, taskId) {
  try { fs.unlinkSync(leasePath(repoRoot, taskId)); return true; } catch { return false; }
}

/**
 * Find a work lease that authorises writing `rel` right now.
 *
 * Requires: unexpired lease, the submodule actually checked out on the leased
 * branch, and the path inside the leased scope. The branch check is what stops
 * a lease issued for one task from being reused on unrelated work.
 */
function findAuthorizingWorkLease(repoRoot, rel, { submodulePath = 'src', now = Date.now() } = {}) {
  const pathsMod = require('./paths');
  const leases = listWorkLeases(repoRoot);
  if (leases.length === 0) return { lease: null, reason: 'no work lease' };
  let branch = null;
  try { branch = git.currentBranch(path.join(repoRoot, submodulePath)); } catch { branch = null; }
  let lastReason = 'no work lease covers this path';
  for (const lease of leases) {
    if (lease.kind !== 'work') continue;
    const ev = evaluateLease(lease, now);
    if (!ev.valid) { lastReason = `work lease ${lease.taskId} is ${ev.reason}`; continue; }
    if (lease.branch && branch && lease.branch !== branch) {
      lastReason = `work lease ${lease.taskId} is scoped to branch ${lease.branch} but ${submodulePath} is on ${branch}`;
      continue;
    }
    if (lease.branch && !branch) {
      lastReason = `work lease ${lease.taskId} requires branch ${lease.branch} but the submodule branch could not be determined`;
      continue;
    }
    if (pathsMod.matchesAny(lease.allowedPaths, rel)) {
      return { lease, reason: null };
    }
  }
  return { lease: null, reason: lastReason };
}

module.exports = {
  LEASES_DIR_REL, leasesDir, leasePath, sanitizeTaskId, evaluateLease,
  readSyncLease, acquireSyncLease, releaseSyncLease,
  createWorkLease, readWorkLease, listWorkLeases, releaseWorkLease,
  findAuthorizingWorkLease,
};
