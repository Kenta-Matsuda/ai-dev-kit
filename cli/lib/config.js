'use strict';
/**
 * Config loading and schema validation for `aidev.yaml` and
 * `.aidev/policy.yaml`, plus atomic file helpers.
 *
 * Validation is strict and fail-closed: a malformed policy must never be
 * silently downgraded into a permissive one, so a parse failure raises rather
 * than yielding defaults.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yaml = require('./yaml');
const { AidevError, EXIT } = require('./errors');

const CONFIG_NAME = 'aidev.yaml';
const LOCK_NAME = '.aidev-lock';
const POLICY_REL = path.join('.aidev', 'policy.yaml');
const SYNC_LOCK_REL = path.join('.aidev', 'sync.lock');

/**
 * Written by `aidev eject`. Its presence means "this repository is no longer
 * kit-managed": the enforcement surface has been removed deliberately, and
 * the files that remain are the team's to maintain by hand.
 *
 * It is a marker, not a switch — ejecting also removes the policy, the lock and
 * the hook wiring, so nothing is relying on this file to stay honest. It exists
 * so that tooling can tell "deliberately ejected" apart from "half-installed",
 * which otherwise look identical from disk.
 */
const EJECT_MARKER_NAME = '.aidev-ejected';

/** Paths that are protected no matter what the policy file says. */
const ALWAYS_PROTECTED = Object.freeze([
  '.claude/**',
  'CLAUDE.md',
  '.mcp.json',
  '.aidev/policy.yaml',
  '.aidev/leases/**',
  '.aidev/sync.lock',
  '.aidev-lock',
  // Writing this by hand would switch enforcement off, which is exactly the
  // move the guard exists to prevent. Ejecting is a human action through the
  // CLI, never a file an agent can create.
  '.aidev-ejected',
]);

const DEFAULTS = Object.freeze({
  sync: {
    tracking_branch: 'main',
    auto_pr: true,
    remote_check_timeout_ms: 3000,
    remote_check_ttl_minutes: 60,
    lease_ttl_minutes: 120,
  },
  task: {
    state_backend: 'azure_devops',
    cache_dir: '.aidev/tasks',
    lease_ttl_minutes: 120,
    retention_days: 90,
    max_concurrent: 3,
  },
  knowledge: {
    max_files_per_dir: 20,
    subagent_concurrency: 4,
    inventory_shard_size: 2000,
    // Wiki generation on a large package is measured in minutes, not seconds;
    // a short default would turn a working run into a truncated one.
    agent_timeout_ms: 1800000,
  },
  model: {
    // The model handed to an agent the CLI starts itself (`--agent`).
    //
    // Deliberately *not* the model an interactive session runs on: that one is
    // Claude Code's own resolution, seeded by `.claude/settings.json` (the kit's
    // shipped default) and overridden per developer in
    // `.claude/settings.local.json`. `aidev.yaml` cannot influence it, because
    // `.claude/` is byte-identical across every PKG, so claiming a key here
    // controlled it would be a setting that quietly does nothing.
    agent: 'sonnet',
  },
  self_evolution: { enabled: true, cadence: 'weekly' },
});

function readTextIfExists(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function readJsonIfExists(p) {
  const t = readTextIfExists(p);
  if (t == null) return null;
  try { return JSON.parse(t); } catch (e) {
    throw new AidevError(`invalid JSON in ${p}: ${e.message}`);
  }
}

/**
 * Write via temp file + rename so a crash can never leave a half-written
 * policy, lock or manifest behind.
 */
function writeFileAtomic(target, contents) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, contents, { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    // Windows can refuse rename onto an existing file held by another handle.
    try { fs.unlinkSync(target); fs.renameSync(tmp, target); } catch (e2) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw e2 || e;
    }
  }
}

function writeJsonAtomic(target, value) {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(p) {
  try { return sha256(fs.readFileSync(p)); } catch { return null; }
}

function asArray(v, field) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AidevError(`${field} must be a list`);
  return v.map((x) => {
    if (x == null || typeof x === 'object') throw new AidevError(`${field} entries must be strings`);
    return String(x);
  });
}

function asInt(v, field, dflt, { min, max } = {}) {
  if (v == null) return dflt;
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new AidevError(`${field} must be an integer`);
  }
  if (min != null && n < min) throw new AidevError(`${field} must be >= ${min}`);
  if (max != null && n > max) throw new AidevError(`${field} must be <= ${max}`);
  return n;
}

function asBool(v, field, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  throw new AidevError(`${field} must be a boolean`);
}

function asString(v, field, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'object') throw new AidevError(`${field} must be a string`);
  return String(v);
}

/** Longest model identifier we will accept; a Bedrock ARN is the worst case. */
const MODEL_MAX_LENGTH = 200;

/**
 * Shape of a usable model identifier — permissive about *which* model, strict
 * about what may reach an argv slot.
 *
 * An alias (`sonnet`), a pinned name (`claude-opus-4-8`), a dated name, an
 * extended-context variant (`sonnet[1m]`), a gateway path
 * (`anthropic/claude-opus-4-8`), a Bedrock inference-profile ARN and a Foundry
 * deployment name are all legitimate, and the set grows with every release.
 * Validating against a list of known models would mean shipping a kit update
 * every time Anthropic ships a model, so the check is structural instead.
 *
 * The leading character class is the part that matters: it rejects a value
 * starting with `-`, which the Claude CLI would read as a flag rather than as
 * the value of `--model`. Whitespace, NUL, newlines and shell metacharacters
 * are excluded for the same reason.
 */
const MODEL_RE = /^[A-Za-z0-9][\w.:/@[\]-]*$/;

/**
 * Normalise a model identifier.
 *
 * An explicitly empty value is not the same as an absent one: `agent: ""` means
 * "hand Claude Code no `--model` at all and let its own resolution decide",
 * which is a real choice, while an absent key takes the kit default.
 */
function asModel(v, field, dflt) {
  if (v == null) return dflt;
  if (typeof v === 'object') throw new AidevError(`${field} must be a string`);
  const s = String(v).trim();
  if (s === '') return null;
  if (s.length > MODEL_MAX_LENGTH) {
    throw new AidevError(`${field} must be at most ${MODEL_MAX_LENGTH} characters`);
  }
  if (!MODEL_RE.test(s)) {
    throw new AidevError(
      `${field}: ${JSON.stringify(String(v))} is not a usable model identifier ` +
      '(letters, digits and . _ - : / @ [ ] only, and it may not start with "-")');
  }
  return s;
}

/**
 * Validate a model identifier supplied outside `aidev.yaml` — a CLI flag, say.
 * Returns null for an empty value, meaning "let Claude Code decide".
 */
function assertModel(v, field = 'model') { return asModel(v, field, null); }

/** Validate and normalise aidev.yaml into a fully-defaulted object. */
function validateConfig(raw, source = CONFIG_NAME) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AidevError(`${source}: top level must be a mapping`);
  }
  const version = asInt(raw.version, 'version', 1, { min: 1 });
  if (version !== 1) throw new AidevError(`${source}: unsupported version ${version} (expected 1)`);

  const pkg = raw.package || {};
  if (typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new AidevError(`${source}: package must be a mapping`);
  }
  const name = asString(pkg.name, 'package.name', null);
  if (!name) throw new AidevError(`${source}: package.name is required`);

  const ado = raw.azure_devops || {};
  if (typeof ado !== 'object' || Array.isArray(ado)) {
    throw new AidevError(`${source}: azure_devops must be a mapping`);
  }
  for (const k of ['organization', 'project', 'repository']) {
    if (!asString(ado[k], `azure_devops.${k}`, null)) {
      throw new AidevError(`${source}: azure_devops.${k} is required`);
    }
  }
  // A PAT in the config file is the one mistake that leaks a credential into
  // git, so refuse it outright instead of warning.
  for (const [k, v] of Object.entries(ado)) {
    if (/^(pat|token|password|secret)$/i.test(k)) {
      throw new AidevError(
        `${source}: azure_devops.${k} must not be set — supply credentials via the ` +
        `environment variable named by azure_devops.auth_env`);
    }
    if (typeof v === 'string' && /^[A-Za-z0-9+/=]{40,}$/.test(v) && k !== 'auth_env') {
      throw new AidevError(`${source}: azure_devops.${k} looks like an embedded credential`);
    }
  }

  const triage = ado.triage || {};
  const sync = raw.sync || {};
  const task = raw.task || {};
  const knowledge = raw.knowledge || {};
  const eve = raw.self_evolution || {};
  const gates = raw.quality_gates || {};

  // `model: sonnet` is the obvious way to mis-write this, and treating it as an
  // empty mapping would silently ignore the one thing the author asked for.
  if (raw.model != null && (typeof raw.model !== 'object' || Array.isArray(raw.model))) {
    throw new AidevError(
      `${source}: model must be a mapping — write "model:" on its own line with ` +
      `"  agent: ${String(raw.model)}" beneath it`);
  }
  const model = raw.model || {};

  const cfg = {
    version,
    package: {
      name,
      include: asArray(pkg.include, 'package.include'),
      exclude: asArray(pkg.exclude, 'package.exclude'),
    },
    secrets_paths: asArray(raw.secrets_paths, 'secrets_paths'),
    azure_devops: {
      organization: String(ado.organization),
      project: String(ado.project),
      repository: String(ado.repository),
      wrapper_repository: asString(ado.wrapper_repository, 'azure_devops.wrapper_repository', null),
      auth_env: asString(ado.auth_env, 'azure_devops.auth_env', 'AZURE_DEVOPS_PAT'),
      triage: {
        labels: asArray(triage.labels, 'azure_devops.triage.labels'),
        area_path: asString(triage.area_path, 'azure_devops.triage.area_path', null),
      },
    },
    sync: {
      tracking_branch: asString(sync.tracking_branch, 'sync.tracking_branch', DEFAULTS.sync.tracking_branch),
      auto_pr: asBool(sync.auto_pr, 'sync.auto_pr', DEFAULTS.sync.auto_pr),
      wrapper_pr: {
        target_branch: asString(
          (sync.wrapper_pr || {}).target_branch, 'sync.wrapper_pr.target_branch', 'main'),
        reviewers: asArray((sync.wrapper_pr || {}).reviewers, 'sync.wrapper_pr.reviewers'),
      },
      remote_check_timeout_ms: asInt(
        sync.remote_check_timeout_ms, 'sync.remote_check_timeout_ms',
        DEFAULTS.sync.remote_check_timeout_ms, { min: 100, max: 60000 }),
      remote_check_ttl_minutes: asInt(
        sync.remote_check_ttl_minutes, 'sync.remote_check_ttl_minutes',
        DEFAULTS.sync.remote_check_ttl_minutes, { min: 0, max: 10080 }),
      lease_ttl_minutes: asInt(
        sync.lease_ttl_minutes, 'sync.lease_ttl_minutes',
        DEFAULTS.sync.lease_ttl_minutes, { min: 1, max: 10080 }),
    },
    task: {
      state_backend: asString(task.state_backend, 'task.state_backend', DEFAULTS.task.state_backend),
      cache_dir: asString(task.cache_dir, 'task.cache_dir', DEFAULTS.task.cache_dir),
      lease_ttl_minutes: asInt(task.lease_ttl_minutes, 'task.lease_ttl_minutes',
        DEFAULTS.task.lease_ttl_minutes, { min: 1, max: 10080 }),
      retention_days: asInt(task.retention_days, 'task.retention_days',
        DEFAULTS.task.retention_days, { min: 1, max: 3650 }),
      max_concurrent: asInt(task.max_concurrent, 'task.max_concurrent',
        DEFAULTS.task.max_concurrent, { min: 1, max: 100 }),
    },
    knowledge: {
      max_files_per_dir: asInt(knowledge.max_files_per_dir, 'knowledge.max_files_per_dir',
        DEFAULTS.knowledge.max_files_per_dir, { min: 1, max: 1000 }),
      subagent_concurrency: asInt(knowledge.subagent_concurrency, 'knowledge.subagent_concurrency',
        DEFAULTS.knowledge.subagent_concurrency, { min: 1, max: 64 }),
      inventory_shard_size: asInt(knowledge.inventory_shard_size, 'knowledge.inventory_shard_size',
        DEFAULTS.knowledge.inventory_shard_size, { min: 1, max: 100000 }),
      agent_timeout_ms: asInt(knowledge.agent_timeout_ms, 'knowledge.agent_timeout_ms',
        DEFAULTS.knowledge.agent_timeout_ms, { min: 10000, max: 7200000 }),
    },
    model: {
      agent: asModel(model.agent, 'model.agent', DEFAULTS.model.agent),
    },
    self_evolution: {
      enabled: asBool(eve.enabled, 'self_evolution.enabled', DEFAULTS.self_evolution.enabled),
      cadence: asString(eve.cadence, 'self_evolution.cadence', DEFAULTS.self_evolution.cadence),
    },
    quality_gates: {},
  };
  for (const [k, v] of Object.entries(gates)) {
    cfg.quality_gates[k] = asString(v, `quality_gates.${k}`, null);
  }
  if (!['azure_devops', 'local'].includes(cfg.task.state_backend)) {
    throw new AidevError(`${source}: task.state_backend must be azure_devops or local`);
  }
  return cfg;
}

function configPath(repoRoot) { return path.join(repoRoot, CONFIG_NAME); }
function policyPath(repoRoot) { return path.join(repoRoot, POLICY_REL); }
function lockPath(repoRoot) { return path.join(repoRoot, LOCK_NAME); }
function syncLockPath(repoRoot) { return path.join(repoRoot, SYNC_LOCK_REL); }
function ejectMarkerPath(repoRoot) { return path.join(repoRoot, EJECT_MARKER_NAME); }

/** Read the eject marker, or null when the repo is still kit-managed. */
function readEjectMarker(repoRoot) {
  return readJsonIfExists(ejectMarkerPath(repoRoot));
}

function loadConfig(repoRoot, { required = true } = {}) {
  const p = configPath(repoRoot);
  const text = readTextIfExists(p);
  if (text == null) {
    if (!required) return null;
    throw new AidevError(`${CONFIG_NAME} not found at ${p} — run "aidev init" first`);
  }
  let raw;
  try { raw = yaml.parse(text); } catch (e) {
    throw new AidevError(`failed to parse ${CONFIG_NAME}: ${e.message}`);
  }
  return validateConfig(raw, CONFIG_NAME);
}

/**
 * Validate `.aidev/policy.yaml`.
 *
 * ALWAYS_PROTECTED is merged in unconditionally: deleting an entry from the
 * policy file must not be a way to unprotect the kit's own control surface.
 */
function validatePolicy(raw, source = POLICY_REL) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AidevError(`${source}: top level must be a mapping`);
  }
  const version = asInt(raw.version, 'version', 1, { min: 1 });
  if (version !== 1) throw new AidevError(`${source}: unsupported version ${version}`);
  const protectedList = asArray(raw.protected, 'protected');
  const merged = [...ALWAYS_PROTECTED];
  for (const p of protectedList) if (!merged.includes(p)) merged.push(p);
  return {
    version,
    protected: merged,
    read_only: asArray(raw.read_only, 'read_only'),
    writable_during_sync: asArray(raw.writable_during_sync, 'writable_during_sync'),
    writable: asArray(raw.writable, 'writable'),
  };
}

/**
 * Load the policy. When absent we return the built-in floor rather than an
 * empty (permissive) policy — an uninitialised repo must not be wide open.
 */
function loadPolicy(repoRoot, { required = false } = {}) {
  const p = policyPath(repoRoot);
  const text = readTextIfExists(p);
  if (text == null) {
    if (required) throw new AidevError(`${POLICY_REL} not found — run "aidev permission configure"`);
    return {
      version: 1,
      protected: [...ALWAYS_PROTECTED],
      read_only: ['src/**'],
      writable_during_sync: ['knowledge/**'],
      writable: [],
      _fallback: true,
    };
  }
  let raw;
  try { raw = yaml.parse(text); } catch (e) {
    throw new AidevError(`failed to parse ${POLICY_REL}: ${e.message}`, EXIT.PERMISSION);
  }
  return validatePolicy(raw, POLICY_REL);
}

function loadLock(repoRoot) {
  return readJsonIfExists(lockPath(repoRoot));
}

function saveLock(repoRoot, lock) {
  writeJsonAtomic(lockPath(repoRoot), lock);
}

/** Effective secret globs: policy protection plus aidev.yaml secrets_paths. */
function secretGlobs(config) {
  return config && config.secrets_paths ? config.secrets_paths.slice() : [];
}

function nowIso() { return new Date().toISOString(); }

function tmpDir() { return os.tmpdir(); }

module.exports = {
  CONFIG_NAME, LOCK_NAME, POLICY_REL, SYNC_LOCK_REL, EJECT_MARKER_NAME, ALWAYS_PROTECTED, DEFAULTS,
  MODEL_MAX_LENGTH,
  configPath, policyPath, lockPath, syncLockPath, ejectMarkerPath, readEjectMarker,
  loadConfig, validateConfig, loadPolicy, validatePolicy, loadLock, saveLock,
  readTextIfExists, readJsonIfExists, writeFileAtomic, writeJsonAtomic,
  sha256, sha256File, secretGlobs, assertModel, nowIso, tmpDir,
};
