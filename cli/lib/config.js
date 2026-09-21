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

const layout = require('./layout');
const toolsMod = require('./tools');

const CONFIG_NAME = layout.CONFIG_NAME;
/** Records the kit commit and per-file hashes of the materialised tool config. */
const LOCK_NAME = layout.MATERIALIZED_REL;
const POLICY_REL = layout.POLICY_REL;
const SYNC_LOCK_REL = layout.SYNC_LOCK_REL;

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
const EJECT_MARKER_NAME = layout.EJECT_MARKER_REL;

/** Paths that are protected no matter what the policy file says. */
const ALWAYS_PROTECTED = Object.freeze([
  // The configuration of every supported AI tool, whether or not the PKG uses
  // it: an agent must never rewrite the instructions another tool will read.
  ...layout.ALL_TOOL_CONFIG_GLOBS,
  layout.POLICY_REL,
  '.aidev/leases/**',
  layout.SYNC_LOCK_REL,
  layout.MATERIALIZED_REL,
  layout.AIDEV_GITIGNORE_REL,
  // Writing this by hand would switch enforcement off, which is exactly the
  // move the guard exists to prevent. Ejecting is a human action through the
  // CLI, never a file an agent can create.
  layout.EJECT_MARKER_REL,
]);

/**
 * The write scopes every policy starts from. The PKG is read-only for an agent
 * (issue-to-pr edits it under a work lease); the Wiki, workflows and the PKG's
 * own aidev.yaml are the places an agent is expected to write.
 */
const DEFAULT_POLICY_SCOPES = Object.freeze({
  read_only: Object.freeze(['**']),
  writable: Object.freeze([`${layout.KNOWLEDGE_REL}/**`, `${layout.WORKFLOWS_REL}/**`, layout.CONFIG_NAME]),
  writable_during_sync: Object.freeze([`${layout.KNOWLEDGE_REL}/**`]),
});

/** Hosting providers the CLI knows how to talk to. */
const HOSTING_TYPES = Object.freeze(['azure-devops', 'generic']);

/** AI coding tools whose configuration the kit can materialise and which it can start. */
const TOOLS = toolsMod.TOOL_IDS;

const DEFAULTS = Object.freeze({
  hosting: {
    type: 'generic',
    tracking_branch: 'main',
    auth_env: { 'azure-devops': 'AZURE_DEVOPS_PAT', generic: null },
  },
  tools: {
    default: Object.freeze(['claude']),
    agent: 'claude',
    // The model handed to an agent the CLI starts itself (knowledge build, sync). An
    // interactive session resolves its own model from the tool's settings.
    agent_model: 'sonnet',
  },
  sync: {
    auto_pr: true,
    remote_check_timeout_ms: 3000,
    remote_check_ttl_minutes: 60,
    lease_ttl_minutes: 120,
  },
  task: {
    cache_dir: '.aidev/tasks',
    lease_ttl_minutes: 120,
    retention_days: 90,
    max_concurrent: 3,
  },
  knowledge: {
    max_files_per_dir: 20,
    inventory_shard_size: 2000,
    evidence: {
      // The whole PKG: a docs-only target set is still verified against code.
      include: Object.freeze(['**']),
    },
    // Wiki generation on a large package is measured in minutes, not seconds;
    // a short default would turn a working run into a truncated one. The
    // budget applies to each batch, not the whole build.
    agent_timeout_ms: 1800000,
    // Generation targets handed to one agent run. Smaller batches show
    // progress sooner and lose less to a timeout; larger ones repeat the
    // agent's orientation less often.
    agent_batch_size: 20,
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

/** Validate and normalise aidev.yaml (schema version 2) into a fully-defaulted object. */
function validateConfig(raw, source = CONFIG_NAME) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AidevError(`${source}: top level must be a mapping`);
  }
  const version = asInt(raw.version, 'version', 2, { min: 1 });
  if (version !== 2) {
    throw new AidevError(
      `${source}: unsupported version ${version} (expected 2). ` +
      'Version 1 described the retired wrapper-repository layout; run "aidev init" to write a new file.');
  }
  const mapping = (v, name) => {
    if (v == null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new AidevError(`${source}: ${name} must be a mapping`);
    return v;
  };

  const pkg = mapping(raw.package, 'package');
  const name = asString(pkg.name, 'package.name', null);
  if (!name) throw new AidevError(`${source}: package.name is required`);

  // ---- hosting ------------------------------------------------------------
  const hosting = mapping(raw.hosting, 'hosting');
  const type = asString(hosting.type, 'hosting.type', DEFAULTS.hosting.type);
  if (!HOSTING_TYPES.includes(type)) {
    throw new AidevError(`${source}: hosting.type must be one of ${HOSTING_TYPES.join(', ')} (got ${type})`);
  }
  // A token in the config file is the one mistake that leaks a credential
  // into git, so refuse it outright instead of warning.
  for (const [k, v] of Object.entries(hosting)) {
    if (/^(pat|token|password|secret)$/i.test(k)) {
      throw new AidevError(
        `${source}: hosting.${k} must not be set — supply credentials via the ` +
        'environment variable named by hosting.auth_env');
    }
    if (typeof v === 'string' && /^[A-Za-z0-9+/=]{40,}$/.test(v) && k !== 'auth_env') {
      throw new AidevError(`${source}: hosting.${k} looks like an embedded credential`);
    }
  }
  if (type === 'azure-devops') {
    for (const k of ['organization', 'project', 'repository']) {
      if (!asString(hosting[k], `hosting.${k}`, null)) {
        throw new AidevError(`${source}: hosting.${k} is required when hosting.type is azure-devops`);
      }
    }
  }
  const triage = mapping(hosting.triage, 'hosting.triage');
  const hostingCfg = {
    type,
    organization: asString(hosting.organization, 'hosting.organization', null),
    project: asString(hosting.project, 'hosting.project', null),
    repository: asString(hosting.repository, 'hosting.repository', null),
    auth_env: asString(hosting.auth_env, 'hosting.auth_env', DEFAULTS.hosting.auth_env[type]),
    tracking_branch: asString(hosting.tracking_branch, 'hosting.tracking_branch', DEFAULTS.hosting.tracking_branch),
    triage: {
      labels: asArray(triage.labels, 'hosting.triage.labels'),
      area_path: asString(triage.area_path, 'hosting.triage.area_path', null),
    },
  };

  // ---- tools --------------------------------------------------------------
  const tools = mapping(raw.tools, 'tools');
  const toolList = tools.default == null
    ? [...DEFAULTS.tools.default]
    : (typeof tools.default === 'string' ? [tools.default] : asArray(tools.default, 'tools.default'));
  for (const t of toolList) {
    if (!TOOLS.includes(t)) throw new AidevError(`${source}: tools.default contains unsupported tool "${t}" (supported: ${TOOLS.join(', ')})`);
  }
  if (toolList.length === 0) throw new AidevError(`${source}: tools.default must name at least one tool`);
  const agentTool = asString(tools.agent, 'tools.agent', toolList[0]);
  if (!TOOLS.includes(agentTool)) throw new AidevError(`${source}: tools.agent "${agentTool}" is not a supported tool`);
  if (!toolList.includes(agentTool)) {
    throw new AidevError(`${source}: tools.agent "${agentTool}" is not listed in tools.default (${toolList.join(', ')})`);
  }
  // Per-agent overrides: `tools.agents.<name>: { tool, model }`. A tool named
  // here must be one the PKG sets up, or its configuration files would be
  // missing when the agent starts. `model: ""` means "pass no model flag".
  const agentsRaw = mapping(tools.agents, 'tools.agents');
  const agentOverrides = {};
  for (const [name, v] of Object.entries(agentsRaw)) {
    if (!toolsMod.AGENT_NAME_RE.test(name)) {
      throw new AidevError(`${source}: tools.agents has an invalid agent name ${JSON.stringify(name)}`);
    }
    const m = mapping(v, `tools.agents.${name}`);
    const tool = asString(m.tool, `tools.agents.${name}.tool`, null);
    if (tool != null && !TOOLS.includes(tool)) {
      throw new AidevError(`${source}: tools.agents.${name}.tool "${tool}" is not a supported tool (supported: ${TOOLS.join(', ')})`);
    }
    if (tool != null && !toolList.includes(tool)) {
      throw new AidevError(`${source}: tools.agents.${name}.tool "${tool}" is not listed in tools.default (${toolList.join(', ')})`);
    }
    const entry = { tool };
    if (m.model !== undefined) entry.model = asModel(m.model, `tools.agents.${name}.model`, null);
    agentOverrides[name] = entry;
  }

  const sync = mapping(raw.sync, 'sync');
  const pr = mapping(sync.pr, 'sync.pr');
  const task = mapping(raw.task, 'task');
  const knowledge = mapping(raw.knowledge, 'knowledge');
  const eve = mapping(raw.self_evolution, 'self_evolution');
  const gates = mapping(raw.quality_gates, 'quality_gates');

  const cfg = {
    version,
    package: {
      name,
      include: asArray(pkg.include, 'package.include'),
      exclude: asArray(pkg.exclude, 'package.exclude'),
    },
    secrets_paths: asArray(raw.secrets_paths, 'secrets_paths'),
    hosting: hostingCfg,
    // Modules that talk to Azure DevOps read this alias; it is null for any
    // other hosting so they can refuse cleanly instead of guessing.
    azure_devops: type === 'azure-devops' ? {
      organization: hostingCfg.organization,
      project: hostingCfg.project,
      repository: hostingCfg.repository,
      auth_env: hostingCfg.auth_env,
      triage: hostingCfg.triage,
    } : null,
    tools: {
      default: toolList,
      agent: agentTool,
      agent_model: asModel(tools.agent_model, 'tools.agent_model', DEFAULTS.tools.agent_model),
      agents: agentOverrides,
    },
    sync: {
      tracking_branch: hostingCfg.tracking_branch,
      auto_pr: asBool(sync.auto_pr, 'sync.auto_pr', DEFAULTS.sync.auto_pr),
      pr: {
        target_branch: asString(pr.target_branch, 'sync.pr.target_branch', hostingCfg.tracking_branch),
        reviewers: asArray(pr.reviewers, 'sync.pr.reviewers'),
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
      inventory_shard_size: asInt(knowledge.inventory_shard_size, 'knowledge.inventory_shard_size',
        DEFAULTS.knowledge.inventory_shard_size, { min: 1, max: 100000 }),
      agent_timeout_ms: asInt(knowledge.agent_timeout_ms, 'knowledge.agent_timeout_ms',
        DEFAULTS.knowledge.agent_timeout_ms, { min: 10000, max: 7200000 }),
      agent_batch_size: asInt(knowledge.agent_batch_size, 'knowledge.agent_batch_size',
        DEFAULTS.knowledge.agent_batch_size, { min: 1, max: 500 }),
      // Generation targets remain package.include. Evidence is independently
      // repository-wide by default so a docs-only target set is still checked
      // against source code, tests, configuration and CI.
      evidence: (() => {
        const evidence = mapping(knowledge.evidence, 'knowledge.evidence');
        return {
          include: evidence.include == null
            ? [...DEFAULTS.knowledge.evidence.include]
            : asArray(evidence.include, 'knowledge.evidence.include'),
          // Omission inherits package.exclude; an explicit list is independent.
          exclude: evidence.exclude == null
            ? asArray(pkg.exclude, 'package.exclude')
            : asArray(evidence.exclude, 'knowledge.evidence.exclude'),
        };
      })(),
    },
    self_evolution: {
      enabled: asBool(eve.enabled, 'self_evolution.enabled', DEFAULTS.self_evolution.enabled),
      cadence: asString(eve.cadence, 'self_evolution.cadence', DEFAULTS.self_evolution.cadence),
    },
    quality_gates: {},
  };
  // Older call sites read the agent model here.
  cfg.model = { agent: cfg.tools.agent_model };
  for (const [k, v] of Object.entries(gates)) {
    cfg.quality_gates[k] = asString(v, `quality_gates.${k}`, null);
  }
  return cfg;
}

/**
 * The tool and model one named agent runs with, after `tools.agents.<name>`
 * overrides are applied to the PKG-wide `tools.agent` / `tools.agent_model`.
 * Returns { tool, model } with model null meaning "no model flag".
 */
function agentSettings(config, agentName) {
  const tools = (config && config.tools) || {};
  const over = (tools.agents && tools.agents[agentName]) || {};
  // `config.model.agent` is the older alias of tools.agent_model; a caller that
  // built a config by hand may carry only that.
  let baseModel = null;
  if (tools.agent_model !== undefined) baseModel = tools.agent_model;
  else if (config && config.model && config.model.agent !== undefined) baseModel = config.model.agent;
  return {
    tool: over.tool || tools.agent || 'claude',
    model: Object.prototype.hasOwnProperty.call(over, 'model') ? over.model : (baseModel == null ? null : baseModel),
  };
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
      ...DEFAULT_POLICY_SCOPES,
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
  DEFAULT_POLICY_SCOPES, HOSTING_TYPES, TOOLS, MODEL_MAX_LENGTH,
  configPath, policyPath, lockPath, syncLockPath, ejectMarkerPath, readEjectMarker,
  loadConfig, validateConfig, loadPolicy, validatePolicy, loadLock, saveLock,
  readTextIfExists, readJsonIfExists, writeFileAtomic, writeJsonAtomic,
  sha256, sha256File, secretGlobs, assertModel, agentSettings, nowIso, tmpDir,
};
