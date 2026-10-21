'use strict';
/**
 * Workflow definitions: the one thing a PKG team writes to make AI do work.
 *
 * A workflow is a YAML file, `.aidev/workflows/<name>/workflow.yaml`. It names
 * an objective and a list of steps; each agent step names its agent and the
 * paths that step may write (`writable`). What an agent can do — its skills,
 * its tools, its MCP servers — is the agent's own definition
 * (`.aidev/agents/<name>.md` frontmatter), and a workflow may assign more in
 * its top-level `agents:` (agents: { <agent>: { skills, mcp, tools } }) for
 * the runs of that workflow only: capabilities belong to the agent, constraints
 * to the step. All executable logic — the
 * retry loop behind `until` (a command that must exit 0 and/or an agent that
 * must answer VERDICT: PASS), command execution, commit, push, PR — lives in
 * the kit (`commands/workflow.js`), so reviewing a workflow means reading
 * YAML, and the quality of what runs is the kit's responsibility.
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
const pathsMod = require('./paths');
const yaml = require('./yaml');

/**
 * Hard ceilings a definition cannot raise. There is no ceiling on a run's
 * time: limits.max_usd (required) and the bounded retries are what stop an
 * unattended run, and limits.max_minutes is the team's choice — required only
 * when an agent runs on a tool that reports no cost (the budget cannot stop it).
 */
const LIMITS = Object.freeze({
  maxRetries: 10,
  // One start of an agent, one command: a hang must end even without a run time limit.
  maxTimeoutMinutes: 240,
  maxItems: 10000,
  // Agents running at once: the targets of one for_each step, or the steps of one parallel group.
  maxParallel: 16,
});

const NAME_RE = layout.WORKFLOW_NAME_RE;
const STEP_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Characters a shell would interpret; a command line containing one is refused. */
const SHELL_CHARS_RE = /[|&;<>`$"'\\]/;

const KIT_AGENTS_DIR = 'templates/claude/.claude/agents';
const KIT_SKILLS_DIR = 'templates/claude/.claude/skills';
/**
 * The standard workflows the kit bundles: `templates/workflows/<name>/` holds
 * a workflow.yaml and the agents (`agents/<agent>.md`) and skills
 * (`skills/<skill>/SKILL.md`) it names. They are templates, not runnable in
 * place: `aidev create workflow <name> --from <standard>` copies them into a
 * PKG, where they are reviewed and approved like any workflow the PKG wrote.
 */
const KIT_WORKFLOWS_DIR = 'templates/workflows';

/** The environment variables the runner sets for its agents; the write guard reads them. */
const ENV_WORKFLOW = 'AIDEV_WORKFLOW';
const ENV_STEP = 'AIDEV_WORKFLOW_STEP';
const ENV_RUN = 'AIDEV_WORKFLOW_RUN';
/** The target a for_each step's agent works on: `{item}` in its writable stands for it. */
const ENV_ITEM = 'AIDEV_WORKFLOW_ITEM';

/** A run id is the start time (`2026-10-01T01-08-32-123Z`); it names a directory under runs/. */
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** The only keys a definition may carry; anything else is a mistake worth naming. */
const TOP_KEYS = ['name', 'description', 'objective', 'tool', 'model', 'agents', 'inputs', 'env_required', 'provide', 'never_commit', 'steps', 'limits'];

/**
 * `inputs`: what a run is given on the command line (`--input name=value`),
 * declared so that the kit can check it before anything starts and put it
 * where the definition says (`{inputs.<name>}` in prompts and commands).
 *   description  for the person running it (and the pull request)
 *   default      the value when none is given; an input without one is required
 *   pattern      a regular expression the whole value must match; required
 *                when the input reaches a command's argv (unless it is a path
 *                or a file, which are bounded already)
 *   path         true: the value is a path inside the repository that must
 *                exist when the run starts (after `provide` has copied)
 *   file         true: the value is a file anywhere on this machine; the
 *                runner copies it into the run's directory (gitignored, inside
 *                the worktree) and `{inputs.<name>}` is that copy's path
 */
const INPUT_KEYS = ['description', 'default', 'pattern', 'path', 'file'];
const INPUT_NAME_RE = layout.INPUT_NAME_RE;
/**
 * `env_required`: environment variables a run needs from the shell that
 * starts it — the credentials a command or a test needs (a password, a token)
 * — as a list of names, or a mapping of name to a description for the person
 * running it. The kit checks they are set before anything starts, and the
 * agents and commands inherit them as they inherit the rest of the
 * environment; their values are never read into a prompt, a record or a log.
 * A value that is not a secret belongs in `inputs` (recorded, reviewed, and
 * written where the definition says), not here.
 */
const ENV_REQUIRED_MAX = 32;
/** `{inputs.<name>}` wherever a value may be written; anything else inside the braces is a mistake. */
const INPUT_TOKEN_RE = /\{inputs\.([^}]*)\}/g;
const INPUT_MAX_CHARS = 1000;
const INPUT_PATTERN_MAX_CHARS = 200;
/** A value is one line of text; control characters never belong in a prompt or an argv. */
const INPUT_CONTROL_RE = /[\x00-\x1f\x7f]/;
/**
 * A value that reaches a command's argv is held to a fixed whitelist the
 * author cannot loosen (the author's pattern narrows it further), as a
 * for_each target is: one plain token of letters, digits and . _ / @ : = + -,
 * not starting with a dash, no way up the tree. Nothing a shell, a cmd.exe
 * shim or an option parser reads specially.
 */
const COMMAND_VALUE_RE = /^[A-Za-z0-9._@][A-Za-z0-9._/@:=+-]{0,999}$/;
/** Where a file input lands: inside the run's directory, which runs/ is gitignored. */
const INPUTS_DIR = 'inputs';

/**
 * Paths a run never commits, wherever a step may write: what toolchains
 * leave behind, never what a step produces. The pull-request step, the
 * checkpoints, `unchanged` and the undo of a failed target all leave them
 * out, as if the PKG ignored them (a PKG without a .gitignore does not).
 * A workflow adds its own with `never_commit:`; nothing takes these away.
 */
/** File names that hold credentials, as a last name of a `provide` glob: never copied into a run. */
const SECRET_FILE_RE = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|.*\.(pem|key|p12|pfx|jks|keystore))$/i;

const NEVER_COMMITTED = Object.freeze([
  '**/node_modules/**', '**/bower_components/**', '**/.pnpm-store/**', '**/.yarn/cache/**',
  '**/.venv/**', '**/venv/**', '**/__pycache__/**', '**/*.pyc', '**/.pytest_cache/**', '**/.mypy_cache/**', '**/.ruff_cache/**',
  '**/.tox/**', '**/.nox/**', '**/.gradle/**', '**/.DS_Store', '**/Thumbs.db', '**/*.orig', '**/*.rej',
]);
/** What a workflow's `agents: { <agent>: ... }` may assign to one agent. */
const AGENT_GRANT_KEYS = ['skills', 'mcp', 'tools', 'subagents'];
/** Where an agent's capabilities are written, for the messages that point there. */
const GRANTS_HINT = 'assign it to the agent in the top-level agents: (agents: { <agent>: { skills: [...], mcp: [...], tools: [...], subagents: [...] } }) or in the agent\'s own frontmatter';
const LIMIT_KEYS = ['max_usd', 'max_minutes'];
/**
 * A step is the kind its one kind key names: `agent:`, `command:` or
 * `pull_request:`. Everything else on the step says how that kind runs.
 */
const STEP_KINDS = [['agent', 'agent'], ['command', 'command'], ['pull_request', 'pull-request'], ['parallel', 'parallel']];
const STEP_KEYS = {
  parallel: ['id', 'description', 'parallel'],
  agent: ['id', 'description', 'agent', 'prompt', 'writable', 'unchanged', 'env', 'for_each', 'until', 'timeout_minutes'],
  command: ['id', 'description', 'command', 'cwd', 'env', 'timeout_minutes', 'writable'],
  'pull-request': ['id', 'description', 'pull_request'],
};
const UNTIL_KEYS = ['command', 'cwd', 'env', 'timeout_minutes', 'agent', 'prompt', 'max_retries'];
const PULL_REQUEST_KEYS = ['title'];
/** Keys that were renamed or moved: the message says where they are now. */
const RENAMED = {
  timeout_ms: 'timeout_ms is timeout_minutes now (minutes, not milliseconds)',
  kind: 'a pull-request step is written as pull_request: { title: ... } now (no kind)',
  title: 'the title of a pull request is written inside it now (pull_request: { title: ... })',
  max_retries: 'max_retries is written inside until now (until: { ..., max_retries: 3 }); retries only happen when until fails',
  skills: `a step does not carry skills; ${GRANTS_HINT}`,
  mcp: `a step does not carry MCP servers; ${GRANTS_HINT}`,
  tools: `a step does not carry tools; ${GRANTS_HINT}`,
  subagents: `a step does not carry subagents; ${GRANTS_HINT}`,
};

/**
 * `for_each`: an agent step run once per target. The targets are the lines of
 * a file in the run's notes directory (an earlier step writes it; the kit
 * reads it), and `{item}` in the step's prompt and `until` stands for the
 * target. A target reaches a command's argv, so it is one plain token: no
 * whitespace, nothing a command would read as an option, no way up the tree.
 */
const FOR_EACH_KEYS = ['from', 'max_items', 'on_failure', 'parallel'];
const FOR_EACH_MAX_ITEMS = LIMITS.maxItems;
/** stop: the first target that fails stops the run. continue: its changes are undone and the next target starts. */
const ON_FAILURE = ['stop', 'continue'];
const ITEM_TOKEN = '{item}';
const ITEM_RE = /^[A-Za-z0-9._@][A-Za-z0-9._/@-]{0,199}$/;
const NOTE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * The step id the runner hands the guard while an `until` agent checks a
 * step's work. A step id cannot contain ':', so this never names a real step.
 */
const UNTIL_STEP_SUFFIX = ':until';
function untilStepId(stepId) { return `${stepId}${UNTIL_STEP_SUFFIX}`; }

/** The line an `until` agent ends its final message with; anything else counts as FAIL. */
const VERDICT_RE = /^[ \t]*VERDICT:[ \t]*(PASS|FAIL)[ \t]*$/gim;
function parseVerdict(text) {
  const all = [...String(text == null ? '' : text).matchAll(VERDICT_RE)];
  return all.length ? all[all.length - 1][1].toUpperCase() : null;
}

/** A built-in tool name in an agent's `tools:` (Read, Grep, Bash, …). */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** An MCP server name in an agent's `mcp:`: a key of the PKG's .mcp.json. */
const MCP_SERVER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]|_(?!_)){0,63}$/;
/** Claude Code accepts the old name of the subagent tool; both mean the same grant. */
const TOOL_ALIASES = Object.freeze({ Task: 'Agent', Agent: 'Task' });
/** The file a PKG registers its MCP servers in (the PKG's own; the kit never writes it). */
const MCP_CONFIG_REL = '.mcp.json';

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
function runRel(name, runId) { return `${workflowRel(name)}/runs/${runId}`; }
/**
 * Where the agent steps of one run leave files for each other (gitignored with
 * the rest of runs/). Null for anything that is not a run id, so a forged
 * AIDEV_WORKFLOW_RUN cannot name another directory.
 */
function notesRel(name, runId) {
  return RUN_ID_RE.test(String(runId || '')) ? `${runRel(name, runId)}/notes` : null;
}
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

/** A step's writable globs: repo-relative, and never the kit's own control surface. */
function writableList(v, where) {
  const list = assertGlobList(v, 'writable', where);
  for (const g of list) {
    if (cfgMod.ALWAYS_PROTECTED.includes(g)) {
      throw new AidevError(`${where}: writable lists a protected path (${g}); the kit's control surface is never a workflow's to write`);
    }
  }
  return list;
}

/** Refuse keys the runner would silently ignore; `moved` says where a removed key went. */
function assertKnownKeys(obj, allowed, source, moved = {}) {
  for (const k of Object.keys(obj)) {
    if (allowed.includes(k)) continue;
    if (moved[k]) throw new AidevError(`${source}: ${k} is not a workflow key; ${moved[k]}`);
    throw new AidevError(`${source}: unknown key ${k} (allowed: ${allowed.join(', ')})`);
  }
}

/** Where a command runs: a directory inside the repository (null: the repository root). */
function cwdRel(v, field, where) {
  if (v == null) return null;
  const s = String(v).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s || s === '.') return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) {
    throw new AidevError(`${where}: ${field} is a directory inside the repository (${s})`);
  }
  return s;
}

/**
 * Fixed environment variables for a command. The values are part of the
 * reviewed YAML, so they are settings (CI=1, a local URL), never secrets; the
 * runner's own AIDEV_* variables cannot be set from here.
 */
/**
 * Names an agent step's `env` may not set: they change what the agent's
 * tool runs (and so whether the kit's hooks run), where it talks, or how git
 * behaves under it. A command step's env is the kit's own child and has no
 * hook to defeat, so these stay allowed there.
 */
const AGENT_ENV_DENY_RE = /^(PATH|PATHEXT|COMSPEC|SHELL|HOME|USERPROFILE|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|CLAUDE_.*|ANTHROPIC_.*|GIT_.*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i;

function envMap(v, field, where, { agent = false } = {}) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new AidevError(`${where}: ${field} must be a mapping of NAME: value`);
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!ENV_NAME_RE.test(k)) throw new AidevError(`${where}: ${field}: ${JSON.stringify(k)} is not an environment variable name`);
    if (/^AIDEV_/i.test(k)) throw new AidevError(`${where}: ${field}: ${k} is the kit's own; a workflow cannot set AIDEV_* variables`);
    if (agent && AGENT_ENV_DENY_RE.test(k)) {
      throw new AidevError(`${where}: ${field}: ${k} changes what the agent's tool runs or where it talks; a workflow cannot set it for an agent (it comes from the shell that runs aidev)`);
    }
    // The git configuration a run hands its children (a trial's no-push settings) is not a step's to change.
    if (/^GIT_CONFIG/i.test(k)) throw new AidevError(`${where}: ${field}: ${k} is git configuration, which the runner sets; a workflow cannot set GIT_CONFIG* variables`);
    if (raw == null || typeof raw === 'object') throw new AidevError(`${where}: ${field}: ${k} must be a plain value`);
    const s = String(raw);
    if (/[\r\n\0]/.test(s)) throw new AidevError(`${where}: ${field}: ${k} must be a single line`);
    out[k] = s;
  }
  return out;
}

/**
 * The top-level `env_required`, validated: { <NAME>: <description> } (an
 * empty string when none was given). Names follow the environment variable
 * rules of `env`, and the runner's own AIDEV_* / GIT_CONFIG* names are not a
 * workflow's to require.
 */
function envRequiredSpec(v, source) {
  if (v == null) return {};
  const where = `${source}: env_required`;
  let entries;
  if (Array.isArray(v)) entries = v.map((n) => [n, '']);
  else if (typeof v === 'object') entries = Object.entries(v);
  else throw new AidevError(`${where} is a list of environment variable names, or a mapping of name to a description (env_required: { E2E_PASSWORD: the password of the test user })`);
  if (entries.length > ENV_REQUIRED_MAX) throw new AidevError(`${where} names ${entries.length} variables, above ${ENV_REQUIRED_MAX}`);
  const out = {};
  for (const [raw, descRaw] of entries) {
    const name = String(raw == null ? '' : raw).trim();
    if (!ENV_NAME_RE.test(name)) throw new AidevError(`${where}: ${JSON.stringify(name)} is not an environment variable name`);
    if (/^AIDEV_/i.test(name)) throw new AidevError(`${where}: ${name} is the kit's own; a workflow cannot require AIDEV_* variables`);
    if (/^GIT_CONFIG/i.test(name)) throw new AidevError(`${where}: ${name} is git configuration, which the runner sets`);
    if (descRaw != null && typeof descRaw === 'object') throw new AidevError(`${where}: ${name} takes a description (one line of text), nothing else`);
    const desc = String(descRaw == null ? '' : descRaw).trim();
    if (/[\r\n\0]/.test(desc)) throw new AidevError(`${where}: the description of ${name} must be a single line`);
    if (Object.prototype.hasOwnProperty.call(out, name)) throw new AidevError(`${where}: ${name} is listed twice`);
    out[name] = desc;
  }
  return out;
}

/** `timeout_minutes`: a positive number of minutes up to the ceiling, kept as milliseconds (null: none given). */
function timeoutMinutes(v, field, where) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new AidevError(`${where}: ${field} must be a positive number of minutes`);
  if (n > LIMITS.maxTimeoutMinutes) throw new AidevError(`${where}: ${field} is ${n}, above the ceiling of ${LIMITS.maxTimeoutMinutes} minutes`);
  return Math.round(n * 60000);
}

/**
 * A step's `until`: when the step's work is done. Every `command` (one line,
 * or a list run in order) must exit 0, and `agent` (with `prompt`, what to
 * check) must answer VERDICT: PASS; with both, the commands run first and the
 * agent only after they pass. `cwd`, `env` and `timeout_minutes` apply to the
 * commands; `max_retries` (default 3) is how often the step's agent is started
 * again when the check fails.
 */
function untilSpec(v, where) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AidevError(`${where}: until must be a mapping with command, agent (and prompt), or both (e.g. until: { command: npm test })`);
  }
  assertKnownKeys(v, UNTIL_KEYS, `${where}: until`, { timeout_ms: RENAMED.timeout_ms });
  const out = { commands: [], cwd: null, env: {}, timeout_ms: null, agent: null, prompt: null };
  out.max_retries = v.max_retries == null ? 3 : positiveInt(v.max_retries, 'until.max_retries', where, { max: LIMITS.maxRetries, min: 0 });
  if (v.command != null) {
    const list = Array.isArray(v.command) ? v.command : [v.command];
    if (list.length === 0) throw new AidevError(`${where}: until.command must not be an empty list`);
    out.commands = list.map((c) => splitCommand(c, 'until.command', where));
    out.cwd = cwdRel(v.cwd, 'until.cwd', where);
    out.env = envMap(v.env, 'until.env', where);
    out.timeout_ms = timeoutMinutes(v.timeout_minutes, 'until.timeout_minutes', where);
  } else {
    for (const k of ['cwd', 'env', 'timeout_minutes']) {
      if (v[k] != null) throw new AidevError(`${where}: until.${k} needs until.command (it says how the command runs)`);
    }
  }
  if (v.agent != null) {
    try { out.agent = toolsMod.assertAgentName(v.agent); } catch (e) { throw new AidevError(`${where}: until.agent: ${e.message}`); }
    out.prompt = v.prompt == null ? '' : String(v.prompt).trim();
    if (!out.prompt) throw new AidevError(`${where}: until.prompt is required with until.agent (what the agent checks)`);
  } else if (v.prompt != null) {
    throw new AidevError(`${where}: until.prompt needs until.agent (the agent that checks)`);
  }
  if (!out.commands.length && !out.agent) throw new AidevError(`${where}: until needs a command, an agent, or both`);
  return out;
}

function forEachSpec(v, where) {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AidevError(`${where}: for_each must be a mapping with from and max_items (e.g. for_each: { from: targets.txt, max_items: 20 })`);
  }
  assertKnownKeys(v, FOR_EACH_KEYS, `${where}: for_each`);
  const from = v.from == null ? '' : String(v.from).trim();
  if (!NOTE_FILE_RE.test(from)) {
    throw new AidevError(`${where}: for_each.from is the name of a file in the run's notes directory, one target per line (${from || 'missing'})`);
  }
  if (v.max_items == null) throw new AidevError(`${where}: for_each.max_items is required (how many targets one run may take on)`);
  const onFailure = v.on_failure == null ? 'stop' : String(v.on_failure).trim();
  if (!ON_FAILURE.includes(onFailure)) throw new AidevError(`${where}: for_each.on_failure is ${ON_FAILURE.join(' or ')}`);
  return {
    from,
    max_items: positiveInt(v.max_items, 'for_each.max_items', where, { max: FOR_EACH_MAX_ITEMS }),
    on_failure: onFailure,
    // How many targets run at once (default 1: one after another).
    parallel: v.parallel == null ? 1 : positiveInt(v.parallel, 'for_each.parallel', where, { max: LIMITS.maxParallel }),
  };
}

/** The leading segments of a glob that hold no wildcard and no {item}: where it can match at all. */
function literalPrefix(glob) {
  const out = [];
  for (const seg of String(glob).split('/')) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out;
}

/**
 * Could two globs match one path? Answered from their literal prefixes: when
 * neither prefix is an ancestor of (or equal to) the other they cannot, and
 * otherwise they are taken to overlap. Errs towards "they might".
 */
function mayOverlap(a, b) {
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  const whole = (g, p) => p.length === String(g).split('/').length;
  // Two literal paths overlap only when they are the same path.
  if (whole(a, pa) && whole(b, pb)) return pa.join('/') === pb.join('/');
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false;
  // One prefix contains the other. A literal path shorter than the other's
  // prefix is a file beside it, not above it, unless it is that directory.
  if (whole(a, pa) && pa.length < pb.length) return false;
  if (whole(b, pb) && pb.length < pa.length) return false;
  return true;
}

/**
 * The steps of a parallel group share one working tree, so none may write
 * where another writes, nor where another must leave things unchanged.
 */
function assertDisjoint(members, where) {
  for (let a = 0; a < members.length; a++) {
    for (let b = 0; b < members.length; b++) {
      if (a === b) continue;
      const A = members[a];
      const B = members[b];
      for (const g of A.writable) {
        for (const h of B.writable) {
          if (a < b && mayOverlap(g, h)) {
            throw new AidevError(`${where}: steps ${A.id} and ${B.id} run at the same time but may write the same paths (${g} and ${h}); give each its own directory`);
          }
        }
        for (const h of B.unchanged) {
          if (mayOverlap(g, h)) {
            throw new AidevError(`${where}: step ${A.id} may write ${g}, which step ${B.id} must leave unchanged (${h}) while both run at the same time`);
          }
        }
      }
    }
  }
}

/**
 * The targets of a `for_each` step, from the text of its list file: one per
 * line, blank lines and `#` lines skipped, duplicates dropped. Throws on a
 * line that is not a plain token and on more targets than `max_items`; a list
 * the runner cannot take as written is a reason to stop, not to guess.
 */
function parseItems(text, spec) {
  const items = [];
  String(text == null ? '' : text).split(/\r?\n/).forEach((raw, n) => {
    const s = raw.trim().replace(/^[-*]\s+/, '');
    if (!s || s.startsWith('#')) return;
    if (!ITEM_RE.test(s) || s.split('/').includes('..')) {
      throw new AidevError(`${spec.from} line ${n + 1}: ${JSON.stringify(s.slice(0, 80))} is not a target (letters, digits and . _ / @ - only; no spaces, no leading dash, no "..")`);
    }
    if (!items.includes(s)) items.push(s);
  });
  if (items.length > spec.max_items) {
    throw new AidevError(`${spec.from} lists ${items.length} targets, above for_each.max_items (${spec.max_items}); shorten the list or run the rest in another run`);
  }
  return items;
}

/** The step as one target sees it: `{item}` replaced in the prompt, the env values and in `until`. */
function forItem(step, item) {
  const put = (s) => String(s).split(ITEM_TOKEN).join(item);
  const env = (e) => Object.fromEntries(Object.entries(e || {}).map(([k, v]) => [k, put(v)]));
  const until = step.until && {
    ...step.until,
    commands: step.until.commands.map((c) => ({ text: put(c.text), argv: c.argv.map(put) })),
    env: env(step.until.env),
    prompt: step.until.prompt == null ? null : put(step.until.prompt),
  };
  return { ...step, prompt: put(step.prompt), writable: step.writable.map(put), env: env(step.env), until };
}

function positiveInt(v, field, source, { max, min = 1 }) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new AidevError(`${source}: ${field} must be a whole number of at least ${min}`);
  if (max != null && n > max) {
    throw new AidevError(`${source}: ${field} is ${n}, above the hard ceiling of ${max}. A workflow may lower a limit but never raise it.`);
  }
  return n;
}

/** A list of names in a workflow's `agents:` entry: a YAML list (or one name), each passing `check`. */
function grantList(v, field, where, check) {
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  for (const raw of list) {
    const s = String(raw == null ? '' : raw).trim();
    try { check(s); } catch (e) { throw new AidevError(`${where}: ${field}: ${e.message}`); }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The top-level `agents:`: what this workflow assigns to the agents its steps
 * name (and to the subagents they may start), on top of each agent's own
 * frontmatter.
 *   skills     added to the agent's skills
 *   mcp        added to the agent's MCP servers
 *   tools      the built-in tools the agent may use in this workflow (replaces
 *              the frontmatter's list; omitted: the frontmatter decides)
 *   subagents  added to the agents it may start as subagents
 * An entry for an agent no step names and no subagents list names is
 * refused: it would grant nothing.
 * Returns { <agent>: { skills, mcp, tools, subagents } } ({} when there is no agents:).
 */
function agentGrants(v, used, source) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AidevError(`${source}: agents is a mapping of agent name to what it is given (agents: { <agent>: { skills: [...], mcp: [...], tools: [...], subagents: [...] } })`);
  }
  const out = {};
  for (const [name, g] of Object.entries(v)) {
    const where = `${source}: agents.${name}`;
    try { toolsMod.assertAgentName(name); } catch (e) { throw new AidevError(`${where}: ${e.message}`); }
    if (g == null) { out[name] = { skills: [], mcp: [], tools: null, subagents: [] }; continue; }
    if (typeof g !== 'object' || Array.isArray(g)) throw new AidevError(`${where} must be a mapping with skills, mcp, tools and/or subagents`);
    assertKnownKeys(g, AGENT_GRANT_KEYS, where);
    out[name] = {
      skills: g.skills == null ? [] : grantList(g.skills, 'skills', where, (s) => toolsMod.assertAgentName(s)),
      mcp: g.mcp == null ? [] : grantList(g.mcp, 'mcp', where, (s) => {
        if (!MCP_SERVER_RE.test(s)) throw new Error(`${JSON.stringify(s)} is not an MCP server name (a key of ${MCP_CONFIG_REL})`);
      }),
      tools: g.tools == null ? null : grantList(g.tools, 'tools', where, (s) => {
        if (!TOOL_NAME_RE.test(s)) throw new Error(`${JSON.stringify(s)} is not a tool name (Read, Grep, Bash, …)`);
      }),
      subagents: g.subagents == null ? [] : grantList(g.subagents, 'subagents', where, (s) => toolsMod.assertAgentName(s)),
    };
    if (out[name].tools && out[name].tools.length === 0) {
      throw new AidevError(`${where}: tools must name at least one tool (leave it out for the agent's own tools)`);
    }
    if (out[name].subagents.includes(name)) throw new AidevError(`${where}: an agent cannot be its own subagent`);
  }
  // A subagent a step's agent may start can be given things here too.
  const named = new Set(used);
  for (const n of used) for (const sub of (out[n] ? out[n].subagents : [])) named.add(sub);
  for (const name of Object.keys(out)) {
    if (!named.has(name)) {
      throw new AidevError(`${source}: agents.${name}: no step names agent ${name} (agents: assigns skills, MCP servers, tools and subagents to the agents the steps use and to their subagents)`);
    }
  }
  return out;
}

/**
 * The capabilities an agent has in one workflow: its frontmatter's, plus what
 * the workflow's `agents:` assigns to it (see agentGrants).
 */
function mergeCapabilities(own, grant) {
  const ownSubs = own.subagents || [];
  if (!grant) return { ...own, subagents: ownSubs };
  return {
    skills: [...new Set([...own.skills, ...grant.skills])],
    tools: grant.tools ? [...grant.tools] : own.tools,
    mcp: [...new Set([...own.mcp, ...grant.mcp])],
    subagents: [...new Set([...ownSubs, ...(grant.subagents || [])])],
  };
}

/** The names written as `{inputs.<name>}` in a text, in order of appearance (a malformed one throws). */
function inputRefs(text, where) {
  const out = [];
  for (const m of String(text == null ? '' : text).matchAll(INPUT_TOKEN_RE)) {
    const name = m[1];
    if (!INPUT_NAME_RE.test(name)) throw new AidevError(`${where}: ${JSON.stringify(m[0])} is not an input reference (write {inputs.<name>}, lowercase letters, digits, - and _)`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The checks every input value passes: one line, bounded, the author's
 * pattern when there is one, and the argv shape when the input reaches a
 * command. Throws with the reason.
 */
function checkInputValue(spec, name, value, where, { placed = false } = {}) {
  const s = String(value == null ? '' : value);
  if (s.length > INPUT_MAX_CHARS) throw new AidevError(`${where}: input ${name} is ${s.length} characters long, above ${INPUT_MAX_CHARS}`);
  if (INPUT_CONTROL_RE.test(s)) throw new AidevError(`${where}: input ${name} must be one line without control characters`);
  // A value is never a template: what it says is what the agent gets.
  if (/[{}]/.test(s)) throw new AidevError(`${where}: input ${name} cannot contain { or } (a value is not a template; ${ITEM_TOKEN} and {inputs.…} are written in the definition)`);
  if (spec.pattern && !spec.patternRe.test(s)) throw new AidevError(`${where}: input ${name}: ${JSON.stringify(s.slice(0, 80))} does not match its pattern (${spec.pattern})`);
  const textOnly = (p) => {
    if (cfgMod.NON_TEXT_REFERENCE_EXTENSIONS.includes(path.extname(p).toLowerCase())) {
      throw new AidevError(`${where}: input ${name}: the AI tools read text; export ${p} to Markdown, CSV or text first and pass that file`);
    }
  };
  if (spec.file && !placed) {
    // A file on this machine, to be copied into the run: it must be there
    // now. What a command sees is the copy's path, checked when placed.
    if (!s) throw new AidevError(`${where}: input ${name} is a file on this machine (empty)`);
    textOnly(s);
    let stat = null;
    try { stat = fs.statSync(path.resolve(s)); } catch { stat = null; }
    if (!stat || !stat.isFile()) throw new AidevError(`${where}: input ${name}: ${s} is not a file on this machine`);
    return s;
  }
  if (spec.path || spec.file) {
    if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split(/[\\/]/).includes('..')) {
      throw new AidevError(`${where}: input ${name} is a path inside the repository (${s || 'empty'})`);
    }
    textOnly(s);
  }
  if (spec.inCommand && (!COMMAND_VALUE_RE.test(s) || s.split('/').includes('..'))) {
    throw new AidevError(`${where}: input ${name} reaches a command, so its value must be one plain token (letters, digits and . _ / @ : = + - only; no spaces, no leading dash, no "..")`);
  }
  return s;
}

/**
 * The top-level `inputs:`, validated: { <name>: { description, default,
 * pattern, patternRe, path, inCommand } }. `inCommand` is filled in by the
 * caller once it knows where each input is written.
 */
function inputSpecs(v, source) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AidevError(`${source}: inputs is a mapping of input name to its declaration (inputs: { <name>: { description: ..., default: ..., pattern: ..., path: true } })`);
  }
  const out = {};
  for (const [name, raw] of Object.entries(v)) {
    const where = `${source}: inputs.${name}`;
    if (!INPUT_NAME_RE.test(name)) throw new AidevError(`${source}: inputs: ${JSON.stringify(name)} is not an input name (lowercase letters, digits and _, starting with a letter, at most 32)`);
    const decl = raw == null ? {} : raw;
    if (typeof decl !== 'object' || Array.isArray(decl)) throw new AidevError(`${where} must be a mapping with description, default, pattern and/or path`);
    assertKnownKeys(decl, INPUT_KEYS, where);
    const spec = {
      description: decl.description == null ? '' : String(decl.description).trim(),
      default: null, pattern: null, patternRe: null, path: decl.path === true, file: decl.file === true, inCommand: false,
    };
    if (decl.path != null && typeof decl.path !== 'boolean') throw new AidevError(`${where}: path is true or false`);
    if (decl.file != null && typeof decl.file !== 'boolean') throw new AidevError(`${where}: file is true or false`);
    if (spec.path && spec.file) throw new AidevError(`${where}: path (inside the repository) and file (anywhere on this machine) exclude each other`);
    if (decl.pattern != null) {
      const p = String(decl.pattern);
      if (!p || p.length > INPUT_PATTERN_MAX_CHARS) throw new AidevError(`${where}: pattern must be a regular expression of at most ${INPUT_PATTERN_MAX_CHARS} characters`);
      try { spec.patternRe = new RegExp(`^(?:${p})$`); } catch (e) { throw new AidevError(`${where}: pattern is not a regular expression (${e.message})`); }
      spec.pattern = p;
    }
    if (decl.default != null) {
      if (typeof decl.default === 'object') throw new AidevError(`${where}: default must be a plain value`);
      if (spec.file) throw new AidevError(`${where}: a file input has no default (the file is on the machine of whoever runs it)`);
      spec.default = String(decl.default);
    }
    out[name] = spec;
  }
  return out;
}

/**
 * Every input written in the definition, with where: [{ name, where,
 * command }]. `command` is true where the value reaches a child process (an
 * argv entry, an env value): such an input is held to the argv whitelist.
 * Anywhere else in the definition, {inputs.…} is a mistake.
 */
function inputUses(def, source = null) {
  const uses = [];
  const at = (where) => (source ? `${source}: ${where}` : where);
  const note = (text, where, command = false) => {
    for (const name of inputRefs(text, at(where))) uses.push({ name, where, command });
  };
  const never = (text, where) => {
    if (String(text == null ? '' : text).includes('{inputs.')) throw new AidevError(`${at(where)} cannot name an input ({inputs.…}); inputs go in objective, a step's prompt, until.prompt, a command or an env value`);
  };
  note(def.objective, 'objective');
  never(def.description, 'description');
  for (const s of def.steps) {
    const where = `steps[${s.id}]`;
    const cmd = (c, at) => {
      if (c.argv[0].includes('{inputs.')) throw new AidevError(`${source ? `${source}: ` : ''}${at}: the executable of a command (${c.argv[0]}) is fixed; an input can be an argument, not the command`);
      note(c.text, at, true);
    };
    never(s.description, `${where}.description`);
    if (s.kind === 'agent') {
      note(s.prompt, `${where}.prompt`);
      for (const [k, v] of Object.entries(s.env || {})) note(v, `${where}.env.${k}`, true);
      if (s.until) {
        for (const c of s.until.commands) cmd(c, `${where}.until.command`);
        for (const [k, v] of Object.entries(s.until.env || {})) note(v, `${where}.until.env.${k}`, true);
        if (s.until.prompt != null) note(s.until.prompt, `${where}.until.prompt`);
      }
    } else if (s.kind === 'command') {
      cmd(s.command, `${where}.command`);
      for (const [k, v] of Object.entries(s.env || {})) note(v, `${where}.env.${k}`, true);
    } else if (s.kind === 'pull-request') {
      never(s.title, `${where}.pull_request.title`);
    }
  }
  return uses;
}

/**
 * The values of a run's inputs, from `--input name=value` lines (or a
 * recorded { name: value } object): defaults filled in, everything checked.
 * Throws on an input the definition does not declare, a required one that is
 * missing, or a value its declaration refuses.
 *
 * `configured` is what the PKG's aidev.yaml sets for this workflow
 * (`workflows.<name>.inputs`, as config.js validated it): the values that
 * are the same for every run in this PKG (the URL of the environment under
 * test, the login of the test user). A value given now wins over it, and it
 * wins over the declaration's `default`. It is checked as a given value is
 * (`configuredWhere` names it in the message), and it cannot stand in for a
 * `file: true` input: that file is on the machine of whoever runs it.
 */
function collectInputs(def, given, where = '--input', { allowMissing = false, placed = false, configured = null, configuredWhere = `${layout.CONFIG_NAME}: workflows.${def.name}.inputs` } = {}) {
  const specs = def.inputs || {};
  const values = {};
  const entries = Array.isArray(given)
    ? given.map((line) => {
      const s = String(line == null ? '' : line);
      const at = s.indexOf('=');
      if (at <= 0) throw new AidevError(`${where} takes name=value (got ${JSON.stringify(s.slice(0, 80))})`);
      return [s.slice(0, at).trim(), s.slice(at + 1)];
    })
    : Object.entries(given || {});
  for (const [name, value] of entries) {
    if (!specs[name]) {
      const known = Object.keys(specs);
      throw new AidevError(`${where}: the workflow declares no input ${JSON.stringify(name)}${known.length ? ` (its inputs: ${known.join(', ')})` : ' (it declares no inputs)'}`);
    }
    if (name in values) throw new AidevError(`${where}: input ${name} is given twice`);
    values[name] = checkInputValue(specs[name], name, value, where, { placed });
  }
  for (const [name, value] of Object.entries(configured || {})) {
    if (name in values) continue;
    if (!specs[name]) {
      const known = Object.keys(specs);
      throw new AidevError(`${configuredWhere}: the workflow declares no input ${JSON.stringify(name)}${known.length ? ` (its inputs: ${known.join(', ')})` : ' (it declares no inputs)'}`);
    }
    if (specs[name].file) throw new AidevError(`${configuredWhere}: input ${name} is a file on the machine of whoever runs the workflow; pass it with ${where} ${name}=<path>, not in ${layout.CONFIG_NAME}`);
    values[name] = checkInputValue(specs[name], name, value, configuredWhere);
  }
  const missing = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (name in values) continue;
    if (spec.default == null) { missing.push(name); continue; }
    values[name] = spec.default;
  }
  if (missing.length && !allowMissing) {
    throw new AidevError(`the workflow needs ${where} for: ${missing.map((n) => `${n}${specs[n].description ? ` (${specs[n].description})` : ''}`).join(', ')}`);
  }
  // In the order the definition declares them, wherever each value came from.
  const ordered = {};
  for (const name of Object.keys(specs)) if (name in values) ordered[name] = values[name];
  return ordered;
}

/**
 * Where a file input lands in the run: `{inputs.<name>}` names this
 * repo-relative path, under the run's directory (gitignored, inside the
 * worktree, so the agents read it and nothing commits it). Returns the values
 * with file inputs replaced by their destination, and the files to copy:
 * { values, files: [{ name, from, to }] }.
 */
function placeFileInputs(def, values, { name, runId }) {
  const out = { ...values };
  const files = [];
  for (const [n, spec] of Object.entries(def.inputs || {})) {
    if (!spec.file || values[n] == null) continue;
    const from = path.resolve(values[n]);
    const ext = path.extname(from).toLowerCase();
    const to = `${runRel(name, runId)}/${INPUTS_DIR}/${n}${/^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''}`;
    out[n] = to;
    files.push({ name: n, from, to });
  }
  return { values: out, files };
}

/** `text` with every `{inputs.<name>}` replaced by its value. */
function putInputs(text, values) {
  return String(text == null ? '' : text).replace(INPUT_TOKEN_RE, (m, name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : m));
}

/**
 * The definition as a run with these input values sees it: the values
 * written into the objective, the prompts, the commands (each argv entry on
 * its own, so a value is one argument) and the env values. Everything else,
 * `writable` included, is the definition's own: an input never widens what
 * a step may touch.
 */
function withInputs(def, values) {
  if (!Object.keys(values || {}).length) return def;
  const put = (s) => putInputs(s, values);
  const cmd = (c) => ({ text: put(c.text), argv: c.argv.map(put) });
  const env = (e) => Object.fromEntries(Object.entries(e || {}).map(([k, v]) => [k, put(v)]));
  return {
    ...def,
    objective: put(def.objective),
    steps: def.steps.map((s) => {
      if (s.kind === 'agent') {
        const until = s.until && { ...s.until, commands: s.until.commands.map(cmd), env: env(s.until.env), prompt: s.until.prompt == null ? null : put(s.until.prompt) };
        return { ...s, prompt: put(s.prompt), env: env(s.env), until };
      }
      if (s.kind === 'command') return { ...s, command: cmd(s.command), env: env(s.env) };
      return s;
    }),
  };
}

/** The globs a run never commits: the kit's own list and the workflow's `never_commit:`. */
function neverCommitted(def) {
  return [...NEVER_COMMITTED, ...((def && def.never_commit) || [])];
}

/** Git pathspecs for "under these globs" (and, when given, "but not under those"). */
function pathspecs(globs, exclude = []) {
  return [...globs.map((g) => `:(glob)${g}`), ...exclude.map((g) => `:(exclude,glob)${g}`)];
}

/**
 * Residue: an untracked file that matches the never-committed globs. Only
 * untracked ones: an edit to a file git tracks is the run's work wherever
 * the file is, and stays visible to the checkpoints, `unchanged` and the
 * undo. `entries` are git status entries ({ xy, path }).
 */
function isResidue(entry, exclude) {
  return entry.xy === '??' && !!pathsMod.firstMatch(exclude, entry.path);
}
function withoutResidue(entries, exclude) { return entries.filter((e) => !isResidue(e, exclude)); }
function residueOf(entries, exclude) { return entries.filter((e) => isResidue(e, exclude)); }

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

  assertKnownKeys(raw, TOP_KEYS, source, {
    scope: 'writable is written on each step now (steps[].writable)',
    cost: 'the budget is limits.max_usd now',
    skills: `skills belong to an agent; ${GRANTS_HINT}`,
    mcp: `MCP servers belong to an agent; ${GRANTS_HINT}`,
    tools: `tools belong to an agent; ${GRANTS_HINT}`,
  });

  const objective = raw.objective == null ? '' : String(raw.objective).trim();
  if (!objective) throw new AidevError(`${source}: objective is required (what the agents are asked to achieve)`);

  const agents = [];

  let tool = null;
  if (raw.tool != null) {
    tool = String(raw.tool).trim();
    if (!toolsMod.isTool(tool)) {
      throw new AidevError(`${source}: tool: ${JSON.stringify(tool)} is not a supported tool (supported: ${toolsMod.TOOL_IDS.join(', ')})`);
    }
  }
  const def = {
    name, description: raw.description ? String(raw.description).trim() : '', objective, agents, tool,
  };
  if (raw.model !== undefined) def.model = cfgMod.assertModel(raw.model, `${source}: model`);

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new AidevError(`${source}: steps must be a non-empty list`);
  const ids = new Set();
  /** One step, validated and normalised; `inGroup` is the parallel group it belongs to (null: none). */
  const oneStep = (s, i, where, inGroup) => {
    if (s == null || typeof s !== 'object' || Array.isArray(s)) throw new AidevError(`${where} must be a mapping`);
    const id = s.id == null ? (inGroup ? `${inGroup}-${i + 1}` : `step-${i + 1}`) : String(s.id).trim();
    if (!STEP_ID_RE.test(id)) throw new AidevError(`${where}: id ${JSON.stringify(id)} must be lowercase letters, digits and dashes (max 32)`);
    if (ids.has(id)) throw new AidevError(`${where}: duplicate step id ${id}`);
    ids.add(id);
    for (const k of Object.keys(s)) if (RENAMED[k]) throw new AidevError(`${where}: ${RENAMED[k]}`);
    // `pull_request:` with nothing after it is a pull request with the default title.
    const kinds = STEP_KINDS.filter(([key]) => (key === 'pull_request' ? key in s : s[key] != null)).map(([, kind]) => kind);
    if (kinds.length !== 1) throw new AidevError(`${where}: a step has exactly one of agent, command, pull_request or parallel`);
    const kind = kinds[0];
    if (inGroup && kind !== 'agent') {
      throw new AidevError(`${where}: a parallel group holds agent steps only (a ${kind} step runs before or after the group)`);
    }
    for (const k of Object.keys(s)) {
      if (!STEP_KEYS[kind].includes(k)) throw new AidevError(`${where}: ${k} does not belong to ${kind === 'agent' ? 'an' : 'a'} ${kind} step (allowed: ${STEP_KEYS[kind].join(', ')})`);
    }
    const step = { id, kind, description: s.description == null ? '' : String(s.description).trim() };
    if (kind === 'parallel') {
      const list = s.parallel;
      if (!Array.isArray(list) || list.length < 2) throw new AidevError(`${where}: parallel is a list of at least two agent steps that run at the same time`);
      if (list.length > LIMITS.maxParallel) throw new AidevError(`${where}: parallel lists ${list.length} steps, above the ceiling of ${LIMITS.maxParallel}`);
      step.members = list.map((m, j) => oneStep(m, j, `${where}.parallel[${j}]`, id));
      assertDisjoint(step.members, where);
      return step;
    }
    if (inGroup) step.group = inGroup;
    if (kind === 'agent') {
      try { step.agent = toolsMod.assertAgentName(s.agent); } catch (e) { throw new AidevError(`${where}: agent: ${e.message}`); }
      if (!agents.includes(step.agent)) agents.push(step.agent);
      step.prompt = s.prompt == null ? '' : String(s.prompt).trim();
      if (!step.prompt) throw new AidevError(`${where}: prompt is required for an agent step`);
      if (s.writable === undefined) {
        throw new AidevError(`${where}: writable is required for an agent step (the paths this step may write; [] writes nothing)`);
      }
      step.writable = writableList(s.writable, where);
      // Paths the step must leave as it found them, even inside its writable:
      // the tests an upgrade must not weaken, the config a test writer must not loosen.
      step.unchanged = assertGlobList(s.unchanged, 'unchanged', where);
      // Where a step may write is read by the reviewer as written: no input decides it.
      for (const [field, list] of [['writable', step.writable], ['unchanged', step.unchanged]]) {
        if (list.some((g) => g.includes('{inputs.'))) throw new AidevError(`${where}: ${field} cannot name an input ({inputs.…}); what a step may touch is fixed by the definition`);
      }
      if (step.unchanged.some((g) => g.includes(ITEM_TOKEN))) throw new AidevError(`${where}: unchanged cannot name ${ITEM_TOKEN} (it holds for every target)`);
      // Fixed environment variables for the step's agent and its until
      // commands (settings a tool or a test reads: a URL, a mode), as a
      // command step's env. The until's own env comes on top of it.
      step.env = envMap(s.env, 'env', where, { agent: true });
      step.for_each = forEachSpec(s.for_each, where);
      step.until = untilSpec(s.until, where);
      if (step.until && step.until.agent && !agents.includes(step.until.agent)) agents.push(step.until.agent);
      const usesItem = [step.prompt, ...step.writable, ...Object.values(step.env), ...(step.until ? [...step.until.commands.map((c) => c.text), step.until.prompt || '', ...Object.values(step.until.env)] : [])]
        .some((t) => t.includes(ITEM_TOKEN));
      if (step.for_each && !step.prompt.includes(ITEM_TOKEN)) {
        throw new AidevError(`${where}: a for_each step's prompt must name its target as ${ITEM_TOKEN}`);
      }
      if (!step.for_each && usesItem) throw new AidevError(`${where}: ${ITEM_TOKEN} needs for_each (the list the targets come from)`);
      for (const g of step.writable) {
        if (g.includes(ITEM_TOKEN) && (literalPrefix(g).length === 0 || literalPrefix(g).length === g.split('/').length)) {
          throw new AidevError(`${where}: writable ${g} must start with a fixed directory before ${ITEM_TOKEN} (e.g. e2e/tests/${ITEM_TOKEN}.spec.ts)`);
        }
      }
      // Targets run at the same time share one working tree: each may only
      // write paths named after itself, so two targets never write one file
      // and a failed target is undone without touching the others.
      if (step.for_each && step.for_each.parallel > 1 && step.writable.some((g) => !g.includes(ITEM_TOKEN))) {
        throw new AidevError(`${where}: for_each.parallel needs every writable path to name the target as ${ITEM_TOKEN} (e.g. writable: [e2e/tests/${ITEM_TOKEN}.spec.ts]), so targets running at once never write the same file`);
      }
      // Retries belong to the check: without an until, a failed attempt
      // (a changed `unchanged` path) ends the step.
      step.max_retries = step.until ? step.until.max_retries : 0;
      step.timeout_ms = timeoutMinutes(s.timeout_minutes, 'timeout_minutes', where);
    } else if (kind === 'command') {
      step.command = splitCommand(s.command, 'command', where);
      if (step.command.text.includes(ITEM_TOKEN)) throw new AidevError(`${where}: ${ITEM_TOKEN} belongs to an agent step with for_each`);
      step.cwd = cwdRel(s.cwd, 'cwd', where);
      step.env = envMap(s.env, 'env', where);
      step.timeout_ms = timeoutMinutes(s.timeout_minutes, 'timeout_minutes', where);
      // A command is run by the kit, not an agent, so no hook stands between
      // it and the tree; its writable only says which of its outputs the
      // pull-request step commits.
      step.writable = writableList(s.writable == null ? [] : s.writable, where);
      if (step.writable.some((g) => g.includes(ITEM_TOKEN))) throw new AidevError(`${where}: ${ITEM_TOKEN} belongs to an agent step with for_each`);
    } else {
      const pr = s.pull_request == null ? {} : s.pull_request;
      if (typeof pr !== 'object' || Array.isArray(pr)) {
        throw new AidevError(`${where}: pull_request is a mapping (pull_request: { title: ... }, or pull_request: {} for the default title)`);
      } else {
        assertKnownKeys(pr, PULL_REQUEST_KEYS, `${where}: pull_request`);
        step.title = pr.title == null ? null : (String(pr.title).trim() || null);
      }
    }
    return step;
  };
  // A parallel group is written as one step holding its members; the runner
  // and everything else see the members as steps of their own, in order,
  // marked with the group (`group`), and the group in def.groups.
  def.groups = [];
  def.steps = [];
  raw.steps.forEach((s, i) => {
    const step = oneStep(s, i, `${source}: steps[${i}]`, null);
    if (step.kind !== 'parallel') { def.steps.push(step); return; }
    def.groups.push({ id: step.id, description: step.description, members: step.members.map((m) => m.id) });
    def.steps.push(...step.members);
  });
  if (def.steps.filter((s) => s.kind === 'pull-request').length > 1) throw new AidevError(`${source}: at most one pull-request step`);
  // What the pull-request step commits: everything any step may write. A
  // path named after a for_each target stands for every target's: the
  // directory before {item}, whole.
  def.writable = [...new Set(def.steps.flatMap((s) => (s.writable || []).map((g) => (g.includes(ITEM_TOKEN) ? `${literalPrefix(g).join('/')}/**` : g))))];
  def.grants = agentGrants(raw.agents, agents, source);

  // What a run is given (`--input`), what it finds in its worktree
  // (`provide`), and what it never commits (`never_commit`).
  def.inputs = inputSpecs(raw.inputs, source);
  for (const s of def.steps) {
    for (const [field, v] of [['cwd', s.cwd], ['until.cwd', s.until && s.until.cwd], ['for_each.from', s.for_each && s.for_each.from]]) {
      if (v && String(v).includes('{inputs.')) throw new AidevError(`${source}: steps[${s.id}]: ${field} cannot name an input ({inputs.…})`);
    }
  }
  for (const use of inputUses(def, source)) {
    const spec = def.inputs[use.name];
    if (!spec) throw new AidevError(`${source}: ${use.where} names {inputs.${use.name}}, which inputs: does not declare`);
    if (use.command) {
      if (!spec.pattern && !spec.path && !spec.file) throw new AidevError(`${source}: inputs.${use.name} reaches a command (${use.where}), so it needs a pattern that bounds its value (or path: true / file: true)`);
      spec.inCommand = true;
    }
  }
  for (const [name, spec] of Object.entries(def.inputs)) {
    if (spec.default != null) checkInputValue(spec, name, spec.default, `${source}: inputs.${name}.default`);
  }
  // What the shell that starts a run must have set (credentials, mostly).
  def.env_required = envRequiredSpec(raw.env_required, source);
  for (const s of def.steps) {
    const fixed = [...Object.keys(s.env || {}), ...Object.keys((s.until && s.until.env) || {})];
    const hit = fixed.find((k) => Object.prototype.hasOwnProperty.call(def.env_required, k));
    if (hit) throw new AidevError(`${source}: steps[${s.id}]: env sets ${hit}, which env_required says the shell provides; take it out of one of them`);
  }
  def.provide = assertGlobList(raw.provide, 'provide', source);
  for (const g of def.provide) {
    const prefix = literalPrefix(g);
    const head = prefix[0] || '';
    if (!head) throw new AidevError(`${source}: provide: ${g} must start with a fixed directory or file name (what a run copies from a checkout is named, never "everything that is ignored")`);
    if (head === '.git' || layout.isKitManaged(prefix.join('/')) || layout.isKitManaged(g) || cfgMod.ALWAYS_PROTECTED.some((p) => pathsMod.matches(p, prefix.join('/')))) {
      throw new AidevError(`${source}: provide cannot name ${g}; the kit's own state and the tool configuration are never copied into a run`);
    }
    // The files a PKG keeps out of git most often are its credentials.
    const last = g.split('/').pop();
    if (SECRET_FILE_RE.test(last)) throw new AidevError(`${source}: provide cannot name ${g}: credentials never go into a run (settings reach a command through env)`);
  }
  def.never_commit = assertGlobList(raw.never_commit, 'never_commit', source);
  // A subtree that is never committed cannot be where a step does its work.
  for (const g of def.never_commit) {
    if (!g.endsWith('/**')) continue;
    const under = literalPrefix(g);
    const covers = (h) => { const p = literalPrefix(h); return under.length <= p.length && under.every((seg, i) => seg === p[i]); };
    for (const st of def.steps) {
      const hit = (st.writable || []).find(covers);
      if (hit) throw new AidevError(`${source}: never_commit ${g} covers what step ${st.id} may write (${hit}); nothing that step did would ever be committed`);
    }
    const prov = def.provide.find(covers);
    if (prov) throw new AidevError(`${source}: never_commit ${g} covers provide ${prov}`);
  }

  // The budget and the time limit, together. max_usd is required: it is what
  // stops an unattended run. max_minutes is optional: without it a run goes on
  // until it finishes, the budget is spent or a step runs out of retries.
  const limits = raw.limits;
  if (limits == null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new AidevError(`${source}: limits is required, with limits.max_usd — a workflow must state its budget before it may run unattended`);
  }
  assertKnownKeys(limits, LIMIT_KEYS, `${source}: limits`);
  if (limits.max_usd == null) {
    throw new AidevError(`${source}: limits.max_usd is required — a workflow must state its budget before it may run unattended`);
  }
  const usd = Number(limits.max_usd);
  if (!Number.isFinite(usd) || usd <= 0) throw new AidevError(`${source}: limits.max_usd must be a positive number`);
  def.limits = {
    max_usd: usd,
    max_minutes: limits.max_minutes == null ? null : positiveInt(limits.max_minutes, 'limits.max_minutes', source, {}),
  };
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

/** A frontmatter list: `[a, b]` or `a, b`. Null when the key is absent or empty. */
function frontmatterList(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^\[(.*)\]$/, '$1').trim();
  if (!s) return null;
  return s.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/**
 * What an agent can do, from its frontmatter:
 *   skills  skills inlined into its prompt ([] when none)
 *   tools   the built-in tools it may use (null: the tool's default set)
 *   mcp     the MCP servers from the PKG's .mcp.json it may use ([] when none)
 *   subagents  the agents it may start as subagents ([]: whatever the tool offers)
 * Throws on a malformed entry; the caller names the file.
 */
function agentCapabilities(meta) {
  const skills = frontmatterList(meta.skills) || [];
  for (const n of skills) toolsMod.assertAgentName(n);
  const tools = frontmatterList(meta.tools);
  for (const t of tools || []) {
    if (!TOOL_NAME_RE.test(t)) throw new Error(`tools: ${JSON.stringify(t)} is not a tool name (Read, Grep, Bash, …)`);
  }
  const mcp = frontmatterList(meta.mcp) || [];
  for (const m of mcp) {
    if (!MCP_SERVER_RE.test(m)) throw new Error(`mcp: ${JSON.stringify(m)} is not an MCP server name (a key of ${MCP_CONFIG_REL})`);
  }
  const subagents = frontmatterList(meta.subagents) || [];
  for (const n of subagents) toolsMod.assertAgentName(n);
  return { skills: [...new Set(skills)], tools: tools ? [...new Set(tools)] : null, mcp: [...new Set(mcp)], subagents: [...new Set(subagents)] };
}

function readAgentFile(file, name, source, rel) {
  const text = cfgMod.readTextIfExists(file);
  if (text == null) return null;
  const { meta, body } = toolsMod.parseFrontmatter(text);
  let capabilities = null;
  let capabilityError = null;
  try { capabilities = agentCapabilities(meta); } catch (e) { capabilityError = e.message; }
  return { name, source, rel, file, description: meta.description || '', body: body.trim(), text, capabilities, capabilityError };
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
  const skills = {};
  const subagents = {};
  const grants = def.grants || {};
  // One agent with what it has in this workflow: `capabilities` is its
  // frontmatter plus the workflow's agents:, `ownCapabilities` the frontmatter alone.
  const load = (n, by = null) => {
    const a = resolveAgent(repoRoot, installRoot, n);
    if (!a) throw new AidevError(`${by ? `${by}: subagent` : 'agent'} ${n} is neither in ${layout.AGENTS_REL}/ nor bundled with the kit`);
    const where = a.rel || `the kit's ${n}.md`;
    if (a.capabilityError) throw new AidevError(`${where}: ${a.capabilityError}`);
    const out = { ...a, where, ownCapabilities: a.capabilities, capabilities: mergeCapabilities(a.capabilities, grants[n]) };
    for (const sn of out.capabilities.skills) {
      if (skills[sn]) continue;
      const s = resolveSkill(repoRoot, installRoot, sn);
      if (!s) {
        const from = a.capabilities.skills.includes(sn) ? where : `${defRel(def.name)}: agents.${n}`;
        throw new AidevError(`${from}: skill ${sn} is neither in ${layout.SKILLS_REL}/ nor bundled with the kit`);
      }
      skills[sn] = s;
    }
    return out;
  };
  const hasTool = (tools, t) => tools.includes(t) || (TOOL_ALIASES[t] != null && tools.includes(TOOL_ALIASES[t]));
  for (const n of def.agents) agents[n] = load(n);
  // Subagents: what a step's agent may start with its Agent tool. A subagent
  // runs inside its parent's session, so it can never have more than the
  // parent: its tools and MCP servers are a part of the parent's.
  for (const n of def.agents) {
    const parent = agents[n];
    const pc = parent.capabilities;
    parent.subagentDefs = {};
    if (!pc.subagents.length) continue;
    const at = pc.subagents.some((x) => !parent.ownCapabilities.subagents.includes(x)) ? `${defRel(def.name)}: agents.${n}` : parent.where;
    if (pc.tools && !hasTool(pc.tools, 'Agent')) {
      throw new AidevError(`${at}: agent ${n} names subagents but its tools do not include Agent (the tool that starts them)`);
    }
    for (const sn of pc.subagents) {
      if (sn === n) throw new AidevError(`${at}: agent ${n} cannot be its own subagent`);
      const sub = subagents[sn] || load(sn, at);
      subagents[sn] = sub;
      const sc = sub.capabilities;
      if (sc.subagents.length) throw new AidevError(`${sub.where}: subagent ${sn} (of ${n}) names subagents of its own; a subagent cannot start others`);
      let tools = sc.tools;
      if (pc.tools) {
        if (!tools) tools = pc.tools.filter((t) => !hasTool(['Agent'], t));
        const extra = tools.filter((t) => !hasTool(pc.tools, t));
        if (extra.length) throw new AidevError(`${at}: subagent ${sn} may use ${extra.join(', ')}, which its parent ${n} may not (a subagent works inside its parent's session)`);
      }
      const extraMcp = sc.mcp.filter((m) => !pc.mcp.includes(m));
      if (extraMcp.length) throw new AidevError(`${at}: subagent ${sn} uses the MCP server(s) ${extraMcp.join(', ')}, which its parent ${n} does not`);
      parent.subagentDefs[sn] = { ...sub, capabilities: { ...sc, tools } };
    }
  }
  return { agents, skills, subagents };
}

/** The skills an agent brings, resolved (resolveDependencies has checked they exist). */
function agentSkills(deps, agentName) {
  return deps.agents[agentName].capabilities.skills.map((s) => deps.skills[s]);
}

/**
 * What one step may do: the step's own writable, and its agent's tools and
 * MCP servers. `<id>:until` is the step's `until` agent: its own tools and
 * MCP servers, and nothing writable (it judges the work, it does not do it).
 * `item` is the for_each target the agent works on: `{item}` in the step's
 * writable stands for it (without a valid one, those paths are not writable).
 * `subagent` is the agent type of a subagent making the call (Claude Code's
 * hook input `agent_type` when `agent_id` is present): it is held to its own
 * grants, and to nothing at all when its parent may not start it.
 * Null for an unknown step id (the guard treats that as nothing).
 */
function stepAccess(def, deps, stepId, { item = null, subagent = null } = {}) {
  const id = String(stepId || '');
  const judging = id.endsWith(UNTIL_STEP_SUFFIX);
  const step = def.steps.find((s) => s.id === (judging ? id.slice(0, -UNTIL_STEP_SUFFIX.length) : id));
  if (!step) return null;
  const forAgent = (name, base) => {
    const a = deps.agents[name];
    const cap = a.capabilities;
    const out = { ...base, agent: name, tools: cap.tools, mcp: cap.mcp, subagents: cap.subagents };
    if (subagent == null) return out;
    // A call from inside a subagent. When the agent names its subagents, only
    // those exist; when it names none, its subagents share its grants.
    if (!cap.subagents.length) return { ...out, subagent };
    const sub = (a.subagentDefs || {})[subagent];
    if (!sub) return { ...out, subagent, tools: [], mcp: [], subagents: [], refused: `subagent ${subagent} is not one agent ${name} may start (${cap.subagents.join(', ')})` };
    return { ...out, subagent, tools: sub.capabilities.tools, mcp: sub.capabilities.mcp, subagents: [] };
  };
  if (judging) {
    if (step.kind !== 'agent' || !step.until || !step.until.agent) return null;
    return forAgent(step.until.agent, { step, writable: [], unchanged: [], notes: false });
  }
  if (step.kind !== 'agent') return { step, agent: null, writable: step.writable || [], unchanged: [], notes: false, tools: null, mcp: [], subagents: [] };
  const valid = item != null && ITEM_RE.test(String(item)) && !String(item).split('/').includes('..');
  const writable = step.writable
    .filter((g) => !g.includes(ITEM_TOKEN) || valid)
    .map((g) => (g.includes(ITEM_TOKEN) ? g.split(ITEM_TOKEN).join(String(item)) : g));
  // `notes`: the step's agent may also write the run's notes directory (notesRel).
  // `unchanged`: paths it must not write even where `writable` covers them.
  return forAgent(step.agent, { step, writable, unchanged: step.unchanged, notes: true });
}

/** Whether a call of the Agent tool may start this subagent type ([] subagents: any). */
function subagentGranted(access, type) {
  if (!access.subagents || !access.subagents.length) return true;
  return access.subagents.includes(String(type || ''));
}

/**
 * Whether a tool call's name falls inside what the step's agent was granted.
 * `mcp__<server>__<tool>` needs the server in `mcp`; any other name needs to
 * be in `tools` when the agent lists them (null tools = the default set).
 */
function toolGranted(access, toolName) {
  if (access.refused) return false;
  const t = String(toolName || '');
  const m = /^mcp__(.+?)__/.exec(t);
  if (m) return access.mcp.includes(m[1]);
  if (t.startsWith('mcp__')) return false;
  if (access.tools == null) return true;
  return access.tools.includes(t) || (TOOL_ALIASES[t] != null && access.tools.includes(TOOL_ALIASES[t]));
}

/**
 * The server definitions an agent may use, taken from the PKG's .mcp.json.
 * Throws when a named server is not registered there: an agent must not run
 * believing it has a server it does not.
 */
function mcpServersFor(repoRoot, agent) {
  if (agent.capabilities.mcp.length === 0) return {};
  const text = cfgMod.readTextIfExists(layout.abs(repoRoot, MCP_CONFIG_REL));
  if (text == null) {
    throw new AidevError(`agent ${agent.name} uses MCP (${agent.capabilities.mcp.join(', ')}) but ${MCP_CONFIG_REL} does not exist in this PKG`);
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new AidevError(`${MCP_CONFIG_REL}: ${e.message}`); }
  const all = (parsed && parsed.mcpServers) || {};
  const out = {};
  for (const n of agent.capabilities.mcp) {
    if (!all[n] || typeof all[n] !== 'object') {
      throw new AidevError(`agent ${agent.name} uses the MCP server ${n}, which ${MCP_CONFIG_REL} does not register`);
    }
    out[n] = all[n];
  }
  return out;
}

/** The PKG-local files whose content the approval covers (the YAML plus PKG agents/skills). */
function reviewedFiles(def, deps) {
  const files = [{ rel: defRel(def.name), kind: 'workflow', name: def.name }];
  for (const a of Object.values(deps.agents)) if (a.source === 'pkg') files.push({ rel: a.rel, kind: 'agent', name: a.name });
  for (const a of Object.values(deps.subagents || {})) {
    if (a.source === 'pkg' && !deps.agents[a.name]) files.push({ rel: a.rel, kind: 'agent', name: a.name });
  }
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

// --------------------------------------------------------------------- trial

/**
 * A trial run (`aidev run workflow --trial`) runs a definition that is not
 * approved, in a worktree of its own, and pushes nothing. In place of the
 * tracking branch, the guard holds the agents to a record the runner leaves
 * in the worktree's git directory (outside the working tree, where no agent
 * writes): the workflow's name, a token the runner also puts in the agents'
 * environment (AIDEV_WORKFLOW_TRIAL), and the hash of the reviewed files as
 * the trial started. A file that changes mid-run changes the hash, and the
 * guard refuses from then on, exactly as an edit unapproves a workflow.
 */
const TRIAL_FILE = 'aidev-trial.json';
const ENV_TRIAL = 'AIDEV_WORKFLOW_TRIAL';
const TRIAL_REF = 'trial';

/** One hash over the reviewed files (the YAML, the PKG agents and skills), as approval compares them. Null when one is missing. */
function reviewedHash(repoRoot, files) {
  const parts = [];
  for (const f of [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const text = cfgMod.readTextIfExists(layout.abs(repoRoot, f.rel));
    if (text == null) return null;
    parts.push(`${f.rel}\0${normalize(text)}\0`);
  }
  return `sha256:${cfgMod.sha256(Buffer.from(parts.join(''), 'utf8'))}`;
}

/** The trial record of a worktree: in its git directory, beside the run lock. Null outside a git worktree. */
function trialFile(repoRoot) {
  const r = gitMod.run(['rev-parse', '--absolute-git-dir'], { cwd: repoRoot });
  return r.ok && r.stdout ? path.join(r.stdout.trim(), TRIAL_FILE) : null;
}

/** Leave the trial record for the guard; returns the token the agents' environment carries, with release(). */
function startTrial(repoRoot, { name, hash, runId }) {
  const file = trialFile(repoRoot);
  if (!file) throw new AidevError(`${repoRoot} is not a git worktree; a trial run needs one`);
  const token = require('crypto').randomBytes(16).toString('hex');
  cfgMod.writeJsonAtomic(file, { schemaVersion: 1, name, token, hash, runId, startedAt: new Date().toISOString() });
  return { token, release: () => { try { fs.rmSync(file, { force: true }); } catch { /* gone already */ } } };
}

function readTrial(repoRoot) {
  const file = trialFile(repoRoot);
  if (!file) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Is this definition the one a trial run started with? { ok, hash, reason }:
 * ok when the worktree's record names this workflow, carries `token`, and
 * the reviewed files still hash as recorded. Not an approval: the guard
 * grants a trial its step's writable on this, and nothing else does. Never throws.
 */
function trialStatus(repoRoot, def, deps, token) {
  const refuse = (reason) => ({ ok: false, hash: null, reason });
  const rec = readTrial(repoRoot);
  if (!rec || typeof rec !== 'object') return refuse('no trial run is recorded for this worktree');
  if (!token || rec.token !== token) return refuse('the trial token does not match the record of this worktree');
  if (rec.name !== def.name) return refuse(`the trial recorded here is of workflow ${rec.name}, not ${def.name}`);
  const hash = reviewedHash(repoRoot, reviewedFiles(def, deps));
  if (!hash) return refuse('a reviewed file is missing locally');
  if (hash !== rec.hash) return refuse('the definition (or an agent or skill it uses) changed since the trial started');
  return { ok: true, hash: rec.hash, reason: null };
}

/**
 * One call for the write guard: the named workflow, its dependencies and
 * whether it is approved. Errors become "not approved" with the message as
 * the reason; the guard never needs to catch. With `trial` (the token from
 * AIDEV_WORKFLOW_TRIAL) the answer also carries `trial` ({ ok, hash, reason }):
 * a trial run is never approved, but its steps may write while the trial
 * record holds.
 */
function inspect(repoRoot, installRoot, config, name, { trial = null } = {}) {
  try {
    const def = loadDefinition(repoRoot, name);
    const deps = resolveDependencies(repoRoot, installRoot, def);
    const approval = approvalStatus(repoRoot, config, def, deps);
    return { ok: true, def, deps, approval, trial: trial ? trialStatus(repoRoot, def, deps, trial) : null };
  } catch (e) {
    return { ok: false, def: null, deps: null, approval: { approved: false, reason: e.message, files: [] }, trial: trial ? { ok: false, hash: null, reason: e.message } : null };
  }
}

/** Whether a run's steps may write at all: approved, or a trial whose record holds. { granted, how: 'approved'|'trial'|null, reason } */
function writeGrant(wf) {
  if (wf.approval.approved) return { granted: true, how: 'approved', reason: null };
  if (wf.trial && wf.trial.ok) return { granted: true, how: 'trial', reason: null };
  if (wf.trial) return { granted: false, how: null, reason: `trial run: ${wf.trial.reason}` };
  return { granted: false, how: null, reason: wf.approval.reason };
}

/** sha256 of the definition as reviewed (LF-normalised), for run records and PR bodies. */
function contentHash(text) {
  return `sha256:${cfgMod.sha256(Buffer.from(normalize(text), 'utf8'))}`;
}

// ------------------------------------------------------- standard workflows

function standardWorkflowsDir(installRoot) { return path.join(installRoot, ...KIT_WORKFLOWS_DIR.split('/')); }

/**
 * One standard workflow of the kit, read from `templates/workflows/<name>/`:
 * { name, dir, text (its workflow.yaml), description, agents: [{ name, rel,
 * text }], skills: [{ name, rel, text }] }, or null when the kit bundles no
 * such workflow. `rel` is where the file lands in a PKG. The text is not
 * validated here (a PKG validates its copy); `description` is read off the
 * YAML when it parses, else ''.
 */
function readStandardWorkflow(installRoot, name) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const dir = path.join(standardWorkflowsDir(installRoot), name);
  const text = cfgMod.readTextIfExists(path.join(dir, 'workflow.yaml'));
  if (text == null) return null;
  let description = '';
  try { const raw = yaml.parse(text); description = raw && raw.description ? String(raw.description).trim() : ''; } catch { description = ''; }
  const agents = [];
  try {
    for (const f of fs.readdirSync(path.join(dir, 'agents')).sort()) {
      if (!f.endsWith('.md')) continue;
      const n = f.replace(/\.md$/, '');
      agents.push({ name: n, rel: agentRel(n), text: fs.readFileSync(path.join(dir, 'agents', f), 'utf8') });
    }
  } catch { /* a workflow that names only the kit's agents has no agents/ */ }
  const skills = [];
  try {
    for (const d of fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const t = cfgMod.readTextIfExists(path.join(dir, 'skills', d.name, 'SKILL.md'));
      if (t == null) continue;
      skills.push({ name: d.name, rel: skillRel(d.name), text: t });
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch { /* none */ }
  return { name, dir, text, description, agents, skills };
}

/** The standard workflows the kit bundles, by name: [{ name, description }]. */
function listStandardWorkflows(installRoot) {
  let names = [];
  try { names = fs.readdirSync(standardWorkflowsDir(installRoot), { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name).sort(); } catch { return []; }
  return names.map((n) => readStandardWorkflow(installRoot, n)).filter(Boolean).map((w) => ({ name: w.name, description: w.description }));
}

/**
 * The files a PKG gets from a standard workflow under the name it chose:
 * [{ rel, kind, name, text }], the YAML's `name:` line rewritten to that
 * name. Every other line of the YAML, and the agents and skills, are copied
 * as they are; the PKG edits its copies (the paths of its tests, the
 * commands it runs) and submits them for review like a workflow it wrote.
 */
function standardWorkflowFiles(std, name) {
  const renamed = std.text.replace(/^name:[^\n]*$/m, `name: ${name}`);
  if (!/^name:/m.test(renamed)) throw new AidevError(`the kit's ${std.name} has no name: line in its workflow.yaml`);
  return [
    { rel: defRel(name), kind: 'workflow', name, text: renamed },
    ...std.agents.map((a) => ({ rel: a.rel, kind: 'agent', name: a.name, text: a.text })),
    ...std.skills.map((s) => ({ rel: s.rel, kind: 'skill', name: s.name, text: s.text })),
  ];
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
  LIMITS, NAME_RE, RUN_ID_RE, ENV_WORKFLOW, ENV_STEP, ENV_RUN, ENV_ITEM, ENV_TRIAL, TRIAL_REF, MCP_CONFIG_REL, untilStepId, parseVerdict,
  sanitizeName, workflowRel, defRel, workflowDir, defPath, runsDir, runRel, notesRel, agentRel, skillRel,
  splitCommand, parseItems, forItem, ITEM_TOKEN, validateDefinition, parseDefinitionText, loadDefinition,
  NEVER_COMMITTED, SECRET_FILE_RE, INPUTS_DIR, neverCommitted, pathspecs, isResidue, withoutResidue, residueOf, collectInputs, placeFileInputs, withInputs, putInputs, inputUses,
  resolveAgent, resolveSkill, resolveDependencies, reviewedFiles, definitionForPrompt,
  agentCapabilities, agentGrants, mergeCapabilities, agentSkills, stepAccess, toolGranted, subagentGranted, literalPrefix, mayOverlap, mcpServersFor,
  trackingRef, approvalStatus, reviewedHash, trialFile, startTrial, readTrial, trialStatus, inspect, writeGrant, contentHash, listWorkflows,
  KIT_WORKFLOWS_DIR, standardWorkflowsDir, readStandardWorkflow, listStandardWorkflows, standardWorkflowFiles, envRequiredSpec,
};
