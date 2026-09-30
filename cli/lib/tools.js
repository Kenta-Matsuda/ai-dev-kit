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
 * are marked `verified: false`; `aidev run workflow --dry-run` names the tool
 * and agent a run would use, and `agent.previewCommand` prints the exact
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

/** Parse one line of a JSON-lines stream; null for anything that is not a JSON object. */
function jsonLine(line) {
  const text = String(line == null ? '' : line).trim();
  if (!text.startsWith('{')) return null;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * The final `result` record of a Claude Code stream-json run (the last one
 * wins). Also accepts a single JSON object, which is what `--output-format
 * json` prints, so a stub that answers with one object still parses.
 */
function claudeResultRecord(stdout) {
  let result = null;
  for (const line of String(stdout || '').split('\n')) {
    const rec = jsonLine(line);
    if (rec && rec.type === 'result') result = rec;
  }
  if (result) return result;
  const whole = jsonLine(stdout);
  return whole && whole.type == null && 'result' in whole ? whole : null;
}

/**
 * Turn one stream-json line into progress events: [{ kind, ... }], empty when
 * the line carries nothing a person watching the run needs to see.
 *
 *   tool    { kind: 'tool', id, name, input, nested }   the agent called a tool
 *   text    { kind: 'text', text, nested }              the agent said something
 *   error   { kind: 'error', toolUseId, text, nested }  a tool call failed or was denied
 *
 * `nested` is true for events from a subagent (Claude Code sets
 * parent_tool_use_id on them).
 */
function claudeStreamProgress(line) {
  const rec = jsonLine(line);
  if (!rec || !rec.message || !Array.isArray(rec.message.content)) return [];
  const nested = rec.parent_tool_use_id != null;
  const out = [];
  if (rec.type === 'assistant') {
    for (const block of rec.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') out.push({ kind: 'tool', id: block.id, name: String(block.name || ''), input: block.input || {}, nested });
      else if (block.type === 'text' && String(block.text || '').trim()) out.push({ kind: 'text', text: String(block.text), nested });
    }
  } else if (rec.type === 'user') {
    for (const block of rec.message.content) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_result' || !block.is_error) continue;
      const content = block.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((c) => (c && c.text) || '').join(' ') : '';
      out.push({ kind: 'error', toolUseId: block.tool_use_id, text, nested });
    }
  }
  return out;
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
 *   progress     optional: (line) => progress events for one line of stdout, while the tool runs
 *   configGlobs  repo-relative globs the kit owns for this tool (protected, drift-checked)
 *   configDirs   directories pruned when they end up empty
 */
const REGISTRY = Object.freeze({
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', bin: 'claude', envBin: 'AIDEV_CLAUDE_BIN',
    minVersion: '2.1.259', verified: true, prompt: 'stdin', namedAgents: true,
    // Can be launched with only an agent's granted tools and MCP servers
    // (verified against Claude Code 2.1.280: --tools hides the other built-in
    // tools, --strict-mcp-config loads only --mcp-config's servers).
    capabilities: true,
    argv({ agent, model, capabilities = null }) {
      // No --agent when the definition is inlined into the prompt (agents the
      // kit runs outside a PKG, where no .claude/agents/ tree exists).
      const argv = ['-p', '--input-format', 'text'];
      if (agent) argv.push('--agent', agent);
      // Omitted entirely rather than passed empty when no model is configured:
      // `--model` sits above the developer's own settings.local.json, so passing
      // one unconditionally would override a choice nobody made.
      if (model) argv.push('--model', model);
      argv.push(
        // stream-json prints one JSON event per line while the agent works
        // (every tool call, every assistant message) and ends with the same
        // `result` record `--output-format json` prints. `progress` below
        // turns the events into the live progress lines; `parse` reads only
        // the result record. -p requires --verbose for it.
        '--output-format', 'stream-json', '--verbose',
        // Wiki generation must edit files without an interactive approval
        // dialog. acceptEdits grants that narrow class while the project deny
        // rules and PreToolUse guard remain active; this is not bypass mode.
        '--permission-mode', 'acceptEdits',
        // Anything acceptEdits does not cover is denied rather than hanging a
        // headless process waiting for a host that does not exist.
        '--permission-prompts', 'none',
      );
      if (capabilities) {
        // Only the agent's MCP servers are loaded (none when it names none);
        // the PKG's .mcp.json and the person's own servers are ignored. Each
        // granted server is pre-approved, since no one is there to approve a
        // call. The variadic --tools goes last.
        argv.push('--mcp-config', capabilities.mcpConfigFile, '--strict-mcp-config');
        if (capabilities.mcp.length) argv.push('--allowedTools', capabilities.mcp.map((s) => `mcp__${s}`).join(','));
        if (capabilities.tools) argv.push('--tools', ...capabilities.tools);
      }
      return argv;
    },
    progress: claudeStreamProgress,
    parse({ stdout, stderr, exitCode }) {
      const trimmed = String(stdout || '').trim();
      const payload = claudeResultRecord(trimmed);
      if (exitCode !== 0 || (payload && payload.is_error)) {
        return {
          ok: false,
          reason: (payload && payload.result) || String(stderr || '').trim() || `the agent exited ${exitCode}`,
          costUsd: payload ? payload.total_cost_usd : undefined,
        };
      }
      // The result record is a protocol contract. Treating arbitrary text as
      // success is how an early shell failure can masquerade as a build.
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

/**
 * Hook adapters: how each tool wires hooks and reads their answers.
 *
 * `hook.js` never looks at the tool id. It asks the adapter to shape a
 * context injection, a permission decision or a stop refusal, and to phrase
 * "start the knowledge-builder as a subagent" the way that tool understands.
 * Where a tool cannot do one of these (Kiro discards PostToolUse stdout), the
 * adapter returns null and the hook prints nothing.
 *
 *   configFiles   the repo files the kit materialises to wire its hooks
 *   events        the tool's names for the four events the kit uses
 *   inSubagents   whether the tool fires hooks inside subagents (guard-write
 *                 coverage; false means the agent definition must restrict
 *                 writes on its own)
 *   context()     shape { additionalContext } for an event; { raw } prints text
 *   decision()    shape the PreToolUse allow/deny answer
 *   denyExitCode  exit status that also signals a denial (0 = JSON only)
 *   block()       shape the "do not stop yet" answer
 *   stopActive()  true/false when the tool says whether this stop was already
 *                 refused once; null when it has no such flag (the kit counts)
 *   subagentHint  how the main agent starts a named subagent
 */
const claudeShaped = Object.freeze({
  context: (eventName) => (text) => ({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }),
  decision: (allow, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: reason } }),
  block: (reason) => ({ decision: 'block', reason }),
  stopActive: (input) => (input && typeof input.stop_hook_active === 'boolean' ? input.stop_hook_active : false),
});

const HOOK_ADAPTERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    configFiles: Object.freeze(['.claude/settings.json']),
    events: Object.freeze({ sessionStart: 'SessionStart', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop' }),
    inSubagents: true,
    context(event, text) { return claudeShaped.context(this.events[event] || event)(text); },
    decision: claudeShaped.decision,
    denyExitCode: 0,
    block: claudeShaped.block,
    stopActive: claudeShaped.stopActive,
    subagentHint: (agent) => `start the "${agent}" subagent with the Agent tool`,
  }),
  copilot: Object.freeze({
    id: 'copilot',
    configFiles: Object.freeze(['.github/hooks/aidev.json']),
    events: Object.freeze({ sessionStart: 'sessionStart', preToolUse: 'preToolUse', postToolUse: 'postToolUse', stop: 'agentStop' }),
    inSubagents: false,
    context: (event, text) => ({ additionalContext: text }),
    decision: (allow, reason) => ({ permissionDecision: allow ? 'allow' : 'deny', permissionDecisionReason: reason }),
    denyExitCode: 0,
    block: claudeShaped.block,
    stopActive: claudeShaped.stopActive,
    subagentHint: (agent) => `delegate to the custom agent "${agent}" (its profile is in .github/agents/)`,
  }),
  codex: Object.freeze({
    id: 'codex',
    configFiles: Object.freeze(['.codex/hooks.json']),
    events: Object.freeze({ sessionStart: 'SessionStart', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop' }),
    inSubagents: true,
    context(event, text) { return claudeShaped.context(this.events[event] || event)(text); },
    decision: claudeShaped.decision,
    denyExitCode: 0,
    block: claudeShaped.block,
    stopActive: claudeShaped.stopActive,
    subagentHint: (agent) => `spawn the "${agent}" custom agent (defined in .codex/agents/) and delegate the batch to it`,
  }),
  kiro: Object.freeze({
    id: 'kiro',
    configFiles: Object.freeze(['.kiro/agents/aidev.json']),
    events: Object.freeze({ sessionStart: 'agentSpawn', preToolUse: 'preToolUse', postToolUse: 'postToolUse', stop: 'stop' }),
    inSubagents: false,
    // agentSpawn stdout becomes context as plain text; postToolUse stdout is discarded.
    context: (event, text) => (event === 'sessionStart' ? { raw: text } : null),
    decision: claudeShaped.decision,
    denyExitCode: 2,
    block: claudeShaped.block,
    stopActive: () => null,
    subagentHint: (agent) => `start the "${agent}" agent with the subagent tool`,
  }),
});

function hookAdapter(id) {
  const a = HOOK_ADAPTERS[String(id)];
  if (!a) throw new Error(`unsupported tool: ${JSON.stringify(String(id))} (supported: ${TOOL_IDS.join(', ')})`);
  return a;
}

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

/**
 * A legacy .cmd/.bat shim, run through cmd.exe. `cmdScript` marks the spec:
 * `spawnSpec` composes the command line itself, because cmd.exe does not read
 * the quoting Node applies to an ordinary argv.
 */
function windowsScriptSpec(script, source, env) {
  const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return { ok: true, bin: comspec, argvPrefix: [], cmdScript: script, shell: false, killTree: true, source };
}

/** Characters cmd.exe acts on, inside double quotes or not. */
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument for a .cmd/.bat shim: wrapped in double quotes (a trailing
 * backslash doubled so it does not swallow the closing quote), then every
 * cmd.exe metacharacter caret-escaped so the outer cmd.exe passes it through.
 * The shim then sees a quoted argument, which both `%*` forwarding and a
 * `"%~1"==...` test handle. Escaping twice (as for npm's own shims) would
 * survive a second expansion, but breaks a shim that inspects its arguments.
 *
 * A double quote or a line break cannot be carried through a shim unchanged,
 * so they are refused here instead of arriving altered.
 */
function quoteCmdArg(arg) {
  const raw = String(arg);
  if (/[\r\n"]/.test(raw)) {
    throw new Error('an argument for a .cmd/.bat launcher cannot contain a double quote or a line break');
  }
  return `"${raw.replace(/(\\*)$/, '$1$1')}"`.replace(CMD_META_RE, '^$1');
}

/**
 * What to hand `spawn` / `spawnSync` / `execFileSync` for a resolved binary:
 * `{ bin, args, options }`. Spread `options` into the call's own options.
 *
 * A .cmd/.bat shim needs the whole command as one verbatim string in an outer
 * pair of quotes. Passed as a plain argv, a script path with a space (npm under
 * `C:\Program Files\nodejs`) is quoted by Node, `/s` strips that quote, and
 * cmd.exe tries to run `C:\Program`.
 */
function spawnSpec(resolved, argv = []) {
  if (!resolved.cmdScript) return { bin: resolved.bin, args: [...resolved.argvPrefix, ...argv], options: {} };
  const line = [`"${resolved.cmdScript}"`.replace(CMD_META_RE, '^$1'), ...argv.map(quoteCmdArg)].join(' ');
  return { bin: resolved.bin, args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
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

  const located = process.platform === 'win32' ? locateOnWindows(t.bin, env) : null;
  if (located) return { ...located, tool: t.id };
  return { ok: true, tool: t.id, bin: t.bin, argvPrefix: [], shell: false, killTree: false, source: 'PATH' };
}

/**
 * The first `where.exe` result Windows can start: a native executable or a
 * .cmd/.bat shim. `where npm` lists the extensionless POSIX shell script that
 * ships next to `npm.cmd` first; taking that line ends in ENOENT.
 */
function pickWindowsCandidate(whereOutput) {
  return String(whereOutput || '').split(/\r?\n/).map((s) => s.trim())
    .find((candidate) => /\.(exe|com|cmd|bat)$/i.test(candidate)) || null;
}

/** `where.exe` lookup: the native executable, or a cmd.exe spec for a .cmd/.bat shim. Null when not found. */
function locateOnWindows(bin, env) {
  try {
    const found = spawnSync('where.exe', [bin], {
      encoding: 'utf8', env: { ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const candidate = found.status === 0 ? pickWindowsCandidate(found.stdout) : null;
    if (!candidate) return null;
    if (/\.(cmd|bat)$/i.test(candidate)) return windowsScriptSpec(candidate, `PATH (${candidate})`, env);
    return { ok: true, bin: candidate, argvPrefix: [], shell: false, killTree: true, source: `PATH (${candidate})` };
  } catch { return null; }
}

/**
 * Resolve any command name the way a tool binary is resolved (so `npm test`
 * in a workflow works on Windows, where npm is a .cmd shim), without a shell.
 */
function resolveCommand(bin, env = process.env) {
  const located = process.platform === 'win32' ? locateOnWindows(bin, env) : null;
  if (located) return located;
  return { ok: true, bin, argvPrefix: [], shell: false, killTree: process.platform === 'win32', source: 'PATH' };
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
    const launch = spawnSpec(resolved, ['--version']);
    const checked = spawnSync(launch.bin, launch.args, {
      encoding: 'utf8', env: { ...env }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      ...launch.options,
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
  REGISTRY, TOOL_IDS, HOOK_ADAPTERS, hookAdapter, AGENT_NAME_RE, ALL_CONFIG_GLOBS, TEMPLATES_DIR,
  TEMPLATE_AGENTS_DIR, TEMPLATE_SKILLS_DIR, TEMPLATE_INSTRUCTIONS,
  getTool, isTool, templateDir, assertAgentName, parseFrontmatter, listBundledAgents, resolveCommand,
  filePointerPrompt, resolveBinary, checkVersion, versionAtLeast, stripControl,
  spawnSpec, pickWindowsCandidate, quoteCmdArg,
};
