'use strict';
/**
 * AI coding tool adapters.
 *
 * `aidev` starts agents through one of several AI coding tools. Everything a
 * tool-specific detail touches lives here, in one record per tool: the binary
 * name and its override variable, the headless argv, how the prompt reaches
 * the process, how the result comes back, and which configuration files the
 * kit materialises into the PKG for that tool.
 *
 * The rest of the CLI is tool-agnostic. `agent.js` asks the registry for an
 * adapter and never inspects the tool id itself; `assets.js` asks it which
 * files to write; `config.js` asks it which ids are valid.
 *
 * Only Claude Code is exercised against the real binary by the maintainers.
 * The other adapters follow each tool's documented non-interactive mode and
 * are marked `verified: false`; `aidev agent run --dry-run` prints the exact
 * command line so a team can confirm it against the version they install
 * before relying on it.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const layout = require('./layout');

/** A plain agent name: what may follow `--agent` and name a definition file. */
const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Every tool has its own template tree, `templates/<tool>/`, laid out exactly
 * as it lands in the PKG root. The kit maintainers keep the trees in step by
 * hand: a tool's quirks cannot be derived from another tool's files.
 */
const TEMPLATES_DIR = 'templates';
function templateDir(id) { return `${TEMPLATES_DIR}/${getTool(id).id}`; }

/** The bundled agent definitions (Claude Code's tree is the reference copy). */
const TEMPLATE_AGENTS_DIR = 'templates/claude/.claude/agents';
const TEMPLATE_SKILLS_DIR = 'templates/claude/.claude/skills';
const TEMPLATE_INSTRUCTIONS = 'templates/claude/CLAUDE.md';

/** Remove terminal control bytes from a tool's output. */
function stripControl(text) {
  return String(text == null ? '' : text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** Parse the `---` frontmatter of an agent definition into { meta, body }. */
function parseFrontmatter(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

/** Read every bundled agent definition: [{ name, description, tools, model, body, file }]. */
function listBundledAgents(installRoot) {
  const dir = path.join(installRoot, ...TEMPLATE_AGENTS_DIR.split('/'));
  let entries;
  try { entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const file of entries) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const { meta, body } = parseFrontmatter(text);
    const name = meta.name || file.replace(/\.md$/, '');
    if (!AGENT_NAME_RE.test(name)) continue;
    out.push({
      name,
      description: meta.description || '',
      tools: meta.tools ? meta.tools.split(',').map((s) => s.trim()).filter(Boolean) : [],
      model: meta.model || null,
      body: body.trim(),
      file: `${TEMPLATE_AGENTS_DIR}/${file}`,
    });
  }
  return out;
}

/** The short sentence handed on argv when the real prompt is in a file. */
function filePointerPrompt(rel) {
  return `Your complete task is in the file ${rel}. Read it and carry out its instructions; do not wait for further input.`;
}

/** Tools that print their answer as text and signal failure through the exit code. */
function plainTextResult({ stdout, stderr, exitCode }) {
  const out = stripControl(stdout).trim();
  const err = stripControl(stderr).trim();
  if (exitCode !== 0) {
    return { ok: false, reason: err || out.split('\n').slice(-3).join('\n') || `the agent exited ${exitCode}`, result: out };
  }
  return { ok: true, result: out, costUsd: undefined, sessionId: undefined, permissionDenials: 0 };
}

/**
 * The registry. Field meanings:
 *
 *   bin          executable name looked up on PATH
 *   envBin       environment variable that replaces it (tests point it at a stub)
 *   minVersion   oldest version whose flags we rely on; null = not enforced
 *   verified     true when the maintainers run it against the real binary
 *   prompt       'stdin' (the prompt is piped) or 'file' (written to a file the argv points at)
 *   namedAgents  the tool selects an agent by name from materialised config
 *   argv(opts)   fixed flags + validated identifiers; never free text except `promptArg`
 *   parse(...)   turn stdout/stderr/exit into { ok, result, costUsd, sessionId, permissionDenials, reason }
 *   configGlobs  repo-relative globs the kit owns for this tool (protected, drift-checked)
 *   configDirs   directories pruned when they end up empty
 */
const REGISTRY = Object.freeze({
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', bin: 'claude', envBin: 'AIDEV_CLAUDE_BIN',
    minVersion: '2.1.259', verified: true, prompt: 'stdin', namedAgents: true,
    argv({ agent, model }) {
      // No --agent when the definition is inlined into the prompt (agents the
      // kit runs outside a PKG, where no .claude/agents/ tree exists).
      const argv = ['-p', '--input-format', 'text'];
      if (agent) argv.push('--agent', agent);
      // Omitted entirely rather than passed empty when no model is configured:
      // `--model` sits above the developer's own settings.local.json, so passing
      // one unconditionally would override a choice nobody made.
      if (model) argv.push('--model', model);
      argv.push(
        '--output-format', 'json',
        // Wiki generation must edit files without an interactive approval
        // dialog. acceptEdits grants that narrow class while the project deny
        // rules and PreToolUse guard remain active; this is not bypass mode.
        '--permission-mode', 'acceptEdits',
        // Anything acceptEdits does not cover is denied rather than hanging a
        // headless process waiting for a host that does not exist.
        '--permission-prompts', 'none',
      );
      return argv;
    },
    parse({ stdout, stderr, exitCode }) {
      let payload = null;
      const trimmed = String(stdout || '').trim();
      if (trimmed) { try { payload = JSON.parse(trimmed); } catch { payload = null; } }
      if (exitCode !== 0 || (payload && payload.is_error)) {
        return {
          ok: false,
          reason: (payload && payload.result) || String(stderr || '').trim() || `the agent exited ${exitCode}`,
          costUsd: payload ? payload.total_cost_usd : undefined,
        };
      }
      // `--output-format json` is a protocol contract. Treating arbitrary text
      // as success is how an early shell failure can masquerade as a build.
      if (!payload) {
        return { ok: false, reason: 'Claude Code exited 0 but did not return the requested JSON result', result: trimmed };
      }
      return {
        ok: true,
        result: payload.result,
        costUsd: payload.total_cost_usd,
        sessionId: payload.session_id,
        permissionDenials: Array.isArray(payload.permission_denials) ? payload.permission_denials.length : 0,
      };
    },
    configGlobs: layout.TOOL_CONFIG_GLOBS.claude,
    configDirs: Object.freeze(['.claude']),
  }),

  copilot: Object.freeze({
    id: 'copilot', label: 'GitHub Copilot CLI', bin: 'copilot', envBin: 'AIDEV_COPILOT_BIN',
    minVersion: null, verified: false, prompt: 'file', namedAgents: true,
    argv({ agent, model, promptArg }) {
      // `-p` is Copilot CLI's non-interactive mode; `--allow-all-tools` keeps a
      // headless run from stopping at a tool approval nobody can answer.
      const argv = ['-p', promptArg, '--allow-all-tools'];
      if (agent) argv.push('--agent', agent);
      if (model) argv.push('--model', model);
      return argv;
    },
    parse: plainTextResult,
    configGlobs: layout.TOOL_CONFIG_GLOBS.copilot,
    configDirs: Object.freeze(['.github/agents', '.github/skills']),
  }),

  codex: Object.freeze({
    id: 'codex', label: 'OpenAI Codex CLI', bin: 'codex', envBin: 'AIDEV_CODEX_BIN',
    minVersion: null, verified: false, prompt: 'file', namedAgents: false,
    argv({ model, promptArg }) {
      // `codex exec` is the non-interactive mode. workspace-write lets the
      // agent edit the PKG clone and nothing outside it.
      const argv = ['exec', '--sandbox', 'workspace-write'];
      if (model) argv.push('--model', model);
      argv.push(promptArg);
      return argv;
    },
    parse: plainTextResult,
    configGlobs: layout.TOOL_CONFIG_GLOBS.codex,
    configDirs: Object.freeze([]),
  }),

  kiro: Object.freeze({
    id: 'kiro', label: 'Kiro CLI', bin: 'kiro-cli', envBin: 'AIDEV_KIRO_BIN',
    minVersion: null, verified: false, prompt: 'file', namedAgents: true,
    argv({ agent, model, promptArg }) {
      const argv = ['chat', '--no-interactive', '--trust-all-tools'];
      if (agent) argv.push('--agent', agent);
      if (model) argv.push('--model', model);
      argv.push(promptArg);
      return argv;
    },
    parse: plainTextResult,
    configGlobs: layout.TOOL_CONFIG_GLOBS.kiro,
    configDirs: Object.freeze(['.kiro/steering', '.kiro/agents']),
  }),
});

const TOOL_IDS = Object.freeze(Object.keys(REGISTRY));

function getTool(id) {
  const t = REGISTRY[id];
  if (!t) throw new Error(`unsupported tool: ${JSON.stringify(String(id))} (supported: ${TOOL_IDS.join(', ')})`);
  return t;
}

function isTool(id) { return Object.prototype.hasOwnProperty.call(REGISTRY, String(id)); }

/** Reject anything that is not a plain agent name (it reaches a subprocess argument). */
function assertAgentName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) throw new Error('agent name is empty');
  if (!AGENT_NAME_RE.test(s)) {
    throw new Error(
      `invalid agent name: ${JSON.stringify(String(name))} (letters, digits, dot, underscore and hyphen only)`);
  }
  return s;
}

/** Every kit-owned config glob across all tools (for protection and kit-managed checks). */
const ALL_CONFIG_GLOBS = layout.ALL_TOOL_CONFIG_GLOBS;

/** Build a shell-free cmd.exe invocation for a legacy .cmd/.bat shim. */
function windowsScriptSpec(script, source, env) {
  const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return { ok: true, bin: comspec, argvPrefix: ['/d', '/s', '/c', script], shell: false, killTree: true, source };
}

/**
 * Locate a tool's executable.
 *
 * The `envBin` override exists so the test suite can point at a stub: the
 * suite must never spawn a real tool, which would cost money and need a
 * network. A `.js` stub is run through the current Node so the tests stay
 * portable to platforms where a shebang means nothing.
 *
 * On Windows, prefer the native executable returned by `where.exe`. Spawning a
 * bare command with `shell: true` corrupts multi-line argv; legacy `.cmd`
 * installs are launched through an explicit cmd.exe argv instead.
 */
function resolveBinary(tool = 'claude', env = process.env) {
  const t = typeof tool === 'string' ? getTool(tool) : tool;
  const override = env[t.envBin];
  if (override) {
    if (!fs.existsSync(override)) {
      return { ok: false, tool: t.id, reason: `${t.envBin} points at ${override}, which does not exist` };
    }
    if (override.endsWith('.js')) {
      return {
        ok: true, tool: t.id, bin: process.execPath, argvPrefix: [override], shell: false,
        killTree: process.platform === 'win32', skipVersionCheck: true, source: t.envBin,
      };
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(override)) {
      return { ...windowsScriptSpec(override, t.envBin, env), tool: t.id };
    }
    return { ok: true, tool: t.id, bin: override, argvPrefix: [], shell: false, killTree: process.platform === 'win32', source: t.envBin };
  }

  if (process.platform === 'win32') {
    try {
      const found = spawnSync('where.exe', [t.bin], {
        encoding: 'utf8', env: { ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const candidate = found.status === 0
        ? String(found.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
        : null;
      if (candidate) {
        if (/\.(cmd|bat)$/i.test(candidate)) return { ...windowsScriptSpec(candidate, `PATH (${candidate})`, env), tool: t.id };
        return { ok: true, tool: t.id, bin: candidate, argvPrefix: [], shell: false, killTree: true, source: `PATH (${candidate})` };
      }
    } catch { /* the spawn below produces the ordinary missing-binary diagnostic */ }
  }
  return { ok: true, tool: t.id, bin: t.bin, argvPrefix: [], shell: false, killTree: false, source: 'PATH' };
}

/** Compare a parsed semantic version with a floor. */
function versionAtLeast(actual, minimum) {
  const parse = (value) => String(value).split('.').map((part) => Number(part));
  const a = parse(actual);
  const b = parse(minimum);
  if (a.length < 3 || b.length < 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/**
 * Run `<tool> --version`. A missing binary is reported as `missing`; a version
 * below the tool's floor as `incompatible`. Tools without a floor pass as long
 * as the binary starts.
 */
function checkVersion(resolved, env = process.env) {
  if (resolved.skipVersionCheck) return { ok: true, skipped: true };
  const t = getTool(resolved.tool);
  try {
    const checked = spawnSync(resolved.bin, [...resolved.argvPrefix, '--version'], {
      encoding: 'utf8', env: { ...env }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = stripControl(`${checked.stdout || ''}\n${checked.stderr || ''}`).trim();
    if (checked.error && checked.error.code === 'ENOENT') {
      return { ok: false, missing: true, reason: `${resolved.bin} was not found on PATH` };
    }
    const match = /\b(\d+\.\d+\.\d+)\b/.exec(text);
    if (checked.status !== 0) {
      return { ok: false, reason: `${t.label} did not report a version (${text.split('\n')[0] || `exit ${checked.status}`})` };
    }
    if (!match) {
      if (t.minVersion) return { ok: false, reason: `could not determine the ${t.label} version (${text.split('\n')[0] || 'no output'})` };
      return { ok: true, version: null };
    }
    if (t.minVersion && !versionAtLeast(match[1], t.minVersion)) {
      return { ok: false, incompatible: true, reason: `${t.label} ${match[1]} is too old; ${t.minVersion} or newer is required` };
    }
    return { ok: true, version: match[1] };
  } catch (e) {
    return { ok: false, reason: `could not check the ${t.label} version: ${e.message}` };
  }
}

module.exports = {
  REGISTRY, TOOL_IDS, AGENT_NAME_RE, ALL_CONFIG_GLOBS, TEMPLATES_DIR,
  TEMPLATE_AGENTS_DIR, TEMPLATE_SKILLS_DIR, TEMPLATE_INSTRUCTIONS,
  getTool, isTool, templateDir, assertAgentName, parseFrontmatter, listBundledAgents,
  filePointerPrompt, resolveBinary, checkVersion, versionAtLeast, stripControl,
};
