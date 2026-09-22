'use strict';
/**
 * Workflow definitions: the one thing a PKG team writes to make AI do work.
 *
 * A workflow is a YAML file, `.aidev/workflows/<name>/workflow.yaml`. It names
 * an objective, the paths its agents may write (`scope.writable`), the agents
 * and skills it uses, and a list of steps. All executable logic — the retry
 * loop behind `until`, command execution, commit, push, PR — lives in the kit
 * (`commands/workflow.js`), so reviewing a workflow means reading YAML, and
 * the quality of what runs is the kit's responsibility.
 *
 * Approval is not a CLI record. A workflow is approved when its definition and
 * every PKG-local agent or skill it references are byte-identical to the copy
 * on `origin/<hosting.tracking_branch>`: the way anything reaches that branch
 * is a reviewed pull request, and the hosting service's branch policy is what
 * says who may review. The check runs on every `run` and, through
 * `policy.decide`, on every write the workflow's agents attempt — so an agent
 * that edits the YAML mid-run to widen its scope only makes the workflow
 * unapproved.
 *
 * Agents and skills resolve by name: the PKG's own `.aidev/agents/<name>.md`
 * and `.aidev/skills/<name>/SKILL.md` first, then the kit's bundled copies
 * (trusted by kit version, not by origin). The definition text is handed to
 * the tool inside the prompt, so a tool that cannot select an agent by name
 * follows the same contract.
 */

const fs = require('fs');
const path = require('path');
const { AidevError } = require('./errors');
const layout = require('./layout');
const cfgMod = require('./config');
const gitMod = require('./git');
const toolsMod = require('./tools');
const yaml = require('./yaml');

/** Hard ceilings: a definition may lower these, never raise them. */
const LIMITS = Object.freeze({
  maxMinutes: 60,
  maxRetries: 10,
});

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Characters a shell would interpret; a command line containing one is refused. */
const SHELL_CHARS_RE = /[|&;<>`$"'\\]/;

const KIT_AGENTS_DIR = 'templates/claude/.claude/agents';
const KIT_SKILLS_DIR = 'templates/claude/.claude/skills';

/** The environment variable the runner sets for its agents; the write guard reads it. */
const ENV_WORKFLOW = 'AIDEV_WORKFLOW';

function sanitizeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!NAME_RE.test(s)) {
    throw new AidevError(
      `invalid workflow name: ${s || '(empty)'} (lowercase letters, digits and dashes; must start alphanumeric)`);
  }
  return s;
}

function workflowRel(name) { return `${layout.WORKFLOWS_REL}/${sanitizeName(name)}`; }
function defRel(name) { return `${workflowRel(name)}/workflow.yaml`; }
function workflowDir(repoRoot, name) { return layout.abs(repoRoot, workflowRel(name)); }
function defPath(repoRoot, name) { return layout.abs(repoRoot, defRel(name)); }
function runsDir(repoRoot, name) { return path.join(workflowDir(repoRoot, name), 'runs'); }
function agentRel(name) { return `${layout.AGENTS_REL}/${name}.md`; }
function skillRel(name) { return `${layout.SKILLS_REL}/${name}/SKILL.md`; }

/** Split a command line on whitespace. No shell: quotes and pipes are not interpreted. */
function splitCommand(text, field, source) {
  const s = String(text == null ? '' : text).trim();
  if (!s) throw new AidevError(`${source}: ${field} must be a non-empty command line`);
  if (SHELL_CHARS_RE.test(s)) {
    throw new AidevError(
      `${source}: ${field} is run without a shell; pipes, redirections, quotes and variables are not supported (${s})`);
  }
  return { text: s, argv: s.split(/\s+/) };
}

function assertGlobList(v, field, source) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AidevError(`${source}: ${field} must be a list`);
  return v.map((g) => {
    const s = String(g == null ? '' : g).trim();
    if (!s) throw new AidevError(`${source}: ${field} has an empty entry`);
    if (s.startsWith('/') || s.includes('..')) throw new AidevError(`${source}: ${field} entries are repo-relative globs (${s})`);
    return s;
  });
}

function assertNameList(v, field, source) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new AidevError(`${source}: ${field} must be a list of names`);
  return v.map((n) => {
    try { return toolsMod.assertAgentName(n); } catch (e) { throw new AidevError(`${source}: ${field}: ${e.message}`); }
  });
}

function positiveInt(v, field, source, { max, min = 1 }) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new AidevError(`${source}: ${field} must be a whole number of at least ${min}`);
  if (max != null && n > max) {
    throw new AidevError(`${source}: ${field} is ${n}, above the hard ceiling of ${max}. A workflow may lower a limit but never raise it.`);
  }
  return n;
}

/**
 * Validate a raw definition and normalise it. Everything that reaches a
 * subprocess argument (tool, model, agent names, commands) is validated here
 * with the same rules as CLI flags.
 */
function validateDefinition(raw, source = 'workflow.yaml') {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AidevError(`${source}: top level must be a mapping`);
  }
  const name = raw.name ? String(raw.name) : null;
  if (!name) throw new AidevError(`${source}: name is required`);
  sanitizeName(name);

  const objective = raw.objective == null ? '' : String(raw.objective).trim();
  if (!objective) throw new AidevError(`${source}: objective is required (what the agents are asked to achieve)`);

  if (raw.scope == null || typeof raw.scope !== 'object' || Array.isArray(raw.scope)) {
    throw new AidevError(`${source}: scope is required (scope.writable lists the paths this workflow may write; [] writes nothing)`);
  }
  if (raw.scope.writable === undefined) throw new AidevError(`${source}: scope.writable is required ([] writes nothing)`);
  const writable = assertGlobList(raw.scope.writable, 'scope.writable', source);
  for (const g of writable) {
    if (cfgMod.ALWAYS_PROTECTED.includes(g)) {
      throw new AidevError(`${source}: scope.writable lists a protected path (${g}); the kit's control surface is never a workflow's to write`);
    }
  }

  const agents = assertNameList(raw.agents, 'agents', source);
  const skills = assertNameList(raw.skills, 'skills', source);

  let tool = null;
  if (raw.tool != null) {
    tool = String(raw.tool).trim();
    if (!toolsMod.isTool(tool)) {
      throw new AidevError(`${source}: tool: ${JSON.stringify(tool)} is not a supported tool (supported: ${toolsMod.TOOL_IDS.join(', ')})`);
    }
  }
  const def = {
    name, description: raw.description ? String(raw.description).trim() : '', objective,
    scope: { writable }, agents, skills, tool,
  };
  if (raw.model !== undefined) def.model = cfgMod.assertModel(raw.model, `${source}: model`);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new AidevError(`${source}: steps must be a non-empty list`);
  const ids = new Set();
  def.steps = raw.steps.map((s, i) => {
    const where = `${source}: steps[${i}]`;
    if (s == null || typeof s !== 'object' || Array.isArray(s)) throw new AidevError(`${where} must be a mapping`);
    const id = s.id == null ? `step-${i + 1}` : String(s.id).trim();
    if (!STEP_ID_RE.test(id)) throw new AidevError(`${where}: id ${JSON.stringify(id)} must be lowercase letters, digits and dashes (max 32)`);
    if (ids.has(id)) throw new AidevError(`${where}: duplicate step id ${id}`);
    ids.add(id);
    if (s.kind != null && s.kind !== 'pull-request') {
      throw new AidevError(`${where}: kind must be "pull-request" (agent and command steps have no kind)`);
    }
    const kinds = [];
    if (s.agent != null) kinds.push('agent');
    if (s.command != null) kinds.push('command');
    if (s.kind === 'pull-request') kinds.push('pull-request');
    if (kinds.length !== 1) throw new AidevError(`${where}: exactly one of agent, command or kind: pull-request is required`);
    const kind = kinds[0];
    const step = { id, kind };
    const forbid = (keys) => {
      for (const k of keys) if (s[k] != null) throw new AidevError(`${where}: ${k} does not belong to a ${kind} step`);
    };
    if (kind === 'agent') {
      try { step.agent = toolsMod.assertAgentName(s.agent); } catch (e) { throw new AidevError(`${where}: agent: ${e.message}`); }
      if (!agents.includes(step.agent)) agents.push(step.agent);
      step.prompt = s.prompt == null ? '' : String(s.prompt).trim();
      if (!step.prompt) throw new AidevError(`${where}: prompt is required for an agent step`);
      step.until = s.until == null ? null : splitCommand(s.until, 'until', where);
      if (s.max_retries == null) step.max_retries = step.until ? 3 : 0;
      else step.max_retries = positiveInt(s.max_retries, 'max_retries', where, { max: LIMITS.maxRetries, min: 0 });
      if (step.max_retries > 0 && !step.until) throw new AidevError(`${where}: max_retries needs an until command to decide when to retry`);
      step.timeout_ms = s.timeout_ms == null ? null : positiveInt(s.timeout_ms, 'timeout_ms', where, { max: 7200000, min: 10000 });
      forbid(['title', 'command']);
    } else if (kind === 'command') {
      step.command = splitCommand(s.command, 'command', where);
      forbid(['prompt', 'until', 'max_retries', 'title', 'timeout_ms']);
    } else {
      step.title = s.title == null ? null : (String(s.title).trim() || null);
      forbid(['prompt', 'until', 'max_retries', 'command', 'timeout_ms']);
    }
    return step;
  });
  if (def.steps.filter((s) => s.kind === 'pull-request').length > 1) throw new AidevError(`${source}: at most one pull-request step`);

  const limits = raw.limits == null ? {} : raw.limits;
  if (typeof limits !== 'object' || Array.isArray(limits)) throw new AidevError(`${source}: limits must be a mapping`);
  def.limits = {
    max_minutes: limits.max_minutes == null
      ? LIMITS.maxMinutes
      : positiveInt(limits.max_minutes, 'limits.max_minutes', source, { max: LIMITS.maxMinutes }),
  };

  const cost = raw.cost == null ? {} : raw.cost;
  if (typeof cost !== 'object' || Array.isArray(cost)) throw new AidevError(`${source}: cost must be a mapping`);
  if (cost.max_usd == null) {
    throw new AidevError(`${source}: cost.max_usd is required — a workflow must state its budget before it may run unattended`);
  }
  const usd = Number(cost.max_usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new AidevError(`${source}: cost.max_usd must be a positive number`);
  def.cost = { max_usd: usd };
  return def;
}

function parseDefinitionText(text, source) {
  let raw;
  try { raw = yaml.parse(text); } catch (e) { throw new AidevError(`failed to parse ${source}: ${e.message}`); }
  return validateDefinition(raw, source);
}

function loadDefinition(repoRoot, name) {
  const rel = defRel(name);
  const text = cfgMod.readTextIfExists(layout.abs(repoRoot, rel));
  if (text == null) throw new AidevError(`no such workflow: ${name} (expected ${rel})`);
  const def = parseDefinitionText(text, rel);
  if (def.name !== sanitizeName(name)) throw new AidevError(`${rel}: name is "${def.name}" but the directory is "${name}"`);
  return def;
}

// ------------------------------------------------------------ agents & skills

function readAgentFile(file, name, source, rel) {
  const text = cfgMod.readTextIfExists(file);
  if (text == null) return null;
  const { meta, body } = toolsMod.parseFrontmatter(text);
  return { name, source, rel, file, description: meta.description || '', body: body.trim(), text };
}

/** The PKG's own copy first, then the kit's bundled definition. Null when neither exists. */
function resolveAgent(repoRoot, installRoot, name) {
  const pkg = readAgentFile(layout.abs(repoRoot, agentRel(name)), name, 'pkg', agentRel(name));
  if (pkg) return pkg;
  return readAgentFile(path.join(installRoot, ...KIT_AGENTS_DIR.split('/'), `${name}.md`), name, 'kit', null);
}

function readSkillFile(file, name, source, rel) {
  const text = cfgMod.readTextIfExists(file);
  if (text == null) return null;
  const { body } = toolsMod.parseFrontmatter(text);
  return { name, source, rel, file, body: body.trim(), text };
}

function resolveSkill(repoRoot, installRoot, name) {
  const pkg = readSkillFile(layout.abs(repoRoot, skillRel(name)), name, 'pkg', skillRel(name));
  if (pkg) return pkg;
  return readSkillFile(path.join(installRoot, ...KIT_SKILLS_DIR.split('/'), name, 'SKILL.md'), name, 'kit', null);
}

/**
 * Everything a definition depends on, resolved. Throws when an agent or skill
 * exists nowhere: a workflow must not run with a silently missing contract.
 */
function resolveDependencies(repoRoot, installRoot, def) {
  const agents = {};
  for (const n of def.agents) {
    const a = resolveAgent(repoRoot, installRoot, n);
    if (!a) throw new AidevError(`agent ${n} is neither in ${layout.AGENTS_REL}/ nor bundled with the kit`);
    agents[n] = a;
  }
  const skills = {};
  for (const n of def.skills) {
    const s = resolveSkill(repoRoot, installRoot, n);
    if (!s) throw new AidevError(`skill ${n} is neither in ${layout.SKILLS_REL}/ nor bundled with the kit`);
    skills[n] = s;
  }
  return { agents, skills };
}

/** The PKG-local files whose content the approval covers (the YAML plus PKG agents/skills). */
function reviewedFiles(def, deps) {
  const files = [{ rel: defRel(def.name), kind: 'workflow', name: def.name }];
  for (const a of Object.values(deps.agents)) if (a.source === 'pkg') files.push({ rel: a.rel, kind: 'agent', name: a.name });
  for (const s of Object.values(deps.skills)) if (s.source === 'pkg') files.push({ rel: s.rel, kind: 'skill', name: s.name });
  return files;
}

/** The text handed to the tool as the agent's definition: its body, then the skills. */
function definitionForPrompt(agent, skills) {
  const parts = [agent.body];
  for (const s of skills) parts.push('', `## Skill: ${s.name}`, '', s.body);
  return parts.join('\n');
}

// ------------------------------------------------------------------ approval

function trackingRef(config) {
  const branch = (config && config.hosting && config.hosting.tracking_branch) || 'main';
  return `origin/${branch}`;
}

function normalize(text) { return String(text == null ? '' : text).replace(/\r\n/g, '\n'); }

/**
 * Is this workflow approved, i.e. identical to origin/<tracking_branch>?
 *
 * Returns { approved, ref, refSha, reason, files: [{ rel, kind, name, state }] }
 * where state is `approved`, `missing` (not on the branch: never submitted or
 * not merged yet), `changed` (edited since) or `absent` (deleted locally).
 * Never throws: an unreadable ref is an answer ("not approved"), so the write
 * guard can fail closed on it.
 */
function approvalStatus(repoRoot, config, def, deps) {
  const ref = trackingRef(config);
  let refSha = null;
  try { refSha = gitMod.revParse(repoRoot, ref); } catch { refSha = null; }
  const files = reviewedFiles(def, deps);
  if (!refSha) {
    return {
      approved: false, ref, refSha: null, files: files.map((f) => ({ ...f, state: 'missing' })),
      reason: `${ref} is not available in this clone (run "git fetch origin" first)`,
    };
  }
  let reason = null;
  for (const f of files) {
    const local = cfgMod.readTextIfExists(layout.abs(repoRoot, f.rel));
    const remote = gitMod.showFile(repoRoot, ref, f.rel);
    if (local == null) f.state = 'absent';
    else if (remote == null) f.state = 'missing';
    else if (normalize(local) !== remote) f.state = 'changed';
    else f.state = 'approved';
    if (f.state !== 'approved' && !reason) {
      if (f.state === 'missing') reason = `${f.rel} is not on ${ref} yet (submit it and have the pull request reviewed and merged)`;
      else if (f.state === 'changed') reason = `${f.rel} differs from ${ref} (review the diff and submit again, or restore it)`;
      else reason = `${f.rel} is missing locally`;
    }
  }
  return { approved: reason == null, ref, refSha, files, reason };
}

/**
 * One call for the write guard: the named workflow, its dependencies and
 * whether it is approved. Errors become "not approved" with the message as
 * the reason; the guard never needs to catch.
 */
function inspect(repoRoot, installRoot, config, name) {
  try {
    const def = loadDefinition(repoRoot, name);
    const deps = resolveDependencies(repoRoot, installRoot, def);
    const approval = approvalStatus(repoRoot, config, def, deps);
    return { ok: true, def, deps, approval };
  } catch (e) {
    return { ok: false, def: null, deps: null, approval: { approved: false, reason: e.message, files: [] } };
  }
}

/** sha256 of the definition as reviewed (LF-normalised), for run records and PR bodies. */
function contentHash(text) {
  return `sha256:${cfgMod.sha256(Buffer.from(normalize(text), 'utf8'))}`;
}

// ------------------------------------------------------------------- listing

function listWorkflows(repoRoot) {
  const base = layout.abs(repoRoot, layout.WORKFLOWS_REL);
  try {
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
      .map((d) => d.name).sort();
  } catch { return []; }
}

module.exports = {
  LIMITS, NAME_RE, ENV_WORKFLOW,
  sanitizeName, workflowRel, defRel, workflowDir, defPath, runsDir, agentRel, skillRel,
  splitCommand, validateDefinition, parseDefinitionText, loadDefinition,
  resolveAgent, resolveSkill, resolveDependencies, reviewedFiles, definitionForPrompt,
  trackingRef, approvalStatus, inspect, contentHash, listWorkflows,
};
