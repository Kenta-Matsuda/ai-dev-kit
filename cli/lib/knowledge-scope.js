'use strict';
/**
 * Resolve and scan the repository-wide evidence available to knowledge-builder.
 *
 * `package.include` selects generation targets. Evidence is deliberately a
 * separate scope: a documentation-only target set must still be checked
 * against the implementation, tests, configuration and CI in the PKG repo.
 */

const { DEFAULTS, sha256 } = require('./config');
const git = require('./git');
const pathsMod = require('./paths');

const DEFAULT_EVIDENCE_INCLUDE = DEFAULTS.knowledge.evidence.include;

function resolveEvidenceScope(config) {
  const configured = config?.knowledge?.evidence || {};
  const include = Array.isArray(configured.include)
    ? configured.include
    : DEFAULT_EVIDENCE_INCLUDE;
  const exclude = Array.isArray(configured.exclude)
    ? configured.exclude
    : (config?.package?.exclude || []);
  return { include: [...include], exclude: [...exclude] };
}

/**
 * Enumerate tracked, non-secret evidence at `ref` in the PKG submodule.
 *
 * Returning exact paths (rather than only globs) gives the agent a deterministic
 * view of the target commit and prevents generated/untracked worktree files
 * from quietly becoming evidence.
 */
function scanEvidence(repoRoot, config, { submodulePath = 'src', ref = 'HEAD' } = {}) {
  const entries = git.lsTreeBlobs(require('path').join(repoRoot, submodulePath), ref);
  if (entries == null) return null;

  const scope = resolveEvidenceScope(config);
  const secrets = config?.secrets_paths || [];
  const records = [];
  for (const entry of entries) {
    const rel = pathsMod.normalizeRel(`${submodulePath}/${entry.path}`);
    if (!pathsMod.isIncluded(rel, scope.include, scope.exclude)) continue;
    if (pathsMod.matchesAny(secrets, rel)) continue;
    records.push({ path: rel, blob: entry.blob });
  }
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return records;
}

/**
 * Build the manifest metadata used to notice changes outside generation targets.
 *
 * Target records already have their own incremental diff, so only supporting
 * evidence participates in this fingerprint. If any supporting source changes
 * and page-level dependencies are unknown, callers conservatively refresh all
 * generation targets rather than leave potentially stale prose behind.
 */
function buildEvidenceSnapshot(evidenceRecords, targetRecords, config) {
  const scope = resolveEvidenceScope(config);
  const targetPaths = new Set((targetRecords || []).map((record) => record.path));
  const supporting = (evidenceRecords || []).filter((record) => !targetPaths.has(record.path));
  const stable = (values) => [...new Set((values || []).map(String))].sort();
  const payload = {
    include: stable(scope.include),
    exclude: stable(scope.exclude),
    secrets: stable(config?.secrets_paths || []),
    files: supporting.map((record) => [record.path, record.blob]),
  };
  return {
    include: scope.include,
    exclude: scope.exclude,
    trackedFiles: (evidenceRecords || []).length,
    supportingFiles: supporting.length,
    fingerprint: `sha256:${sha256(Buffer.from(JSON.stringify(payload), 'utf8'))}`,
  };
}

function evidenceChanged(previous, current) {
  return !previous || previous.fingerprint !== current.fingerprint;
}

module.exports = {
  DEFAULT_EVIDENCE_INCLUDE,
  resolveEvidenceScope,
  scanEvidence,
  buildEvidenceSnapshot,
  evidenceChanged,
};
