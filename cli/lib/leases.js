'use strict';
/**
 * The publish lease (.aidev/sync.lock): held by `aidev sync wiki`, it permits writes
 * to knowledge/** while the Wiki is missing or broken, so a sync can repair
 * the very state that otherwise blocks every write. It is TTL-bound and is
 * itself a protected path, so an agent can never mint or extend it.
 */

const fs = require('fs');
const { writeJsonAtomic, readJsonIfExists, syncLockPath, nowIso } = require('./config');
const { AidevError } = require('./errors');

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
function acquireSyncLease(repoRoot, { targetSha, originalSha, ttlMinutes = 120, force = false }) {
  const existing = readSyncLease(repoRoot);
  if (existing && !force) {
    const ev = evaluateLease(existing);
    if (ev.valid) {
      throw new AidevError(
        `sync lease already held (target=${existing.targetSha}, acquired=${existing.acquiredAt}). ` +
        'Run "aidev sync wiki" to continue it or "aidev sync wiki --abort" to release it.');
    }
    throw new AidevError(
      `a stale sync lease is present (${ev.reason}; target=${existing.targetSha}). ` +
      'Refusing to adopt it silently — run "aidev sync wiki" to continue it, ' +
      'or "aidev sync wiki --abort" to discard the unfinished publish.');
  }
  const lease = {
    schemaVersion: 1,
    kind: 'sync',
    targetSha: targetSha || null,
    originalSha: originalSha || null,
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

module.exports = { evaluateLease, readSyncLease, acquireSyncLease, releaseSyncLease };
