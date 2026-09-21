'use strict';
/**
 * `aidev hook <name>` — the runtime half of the permission design.
 *
 * Claude Code passes hook input as JSON on stdin and reads a JSON decision on
 * stdout. Three constraints shape everything here:
 *
 *   - The default hook timeout is 30s (5s is the practical target), so nothing
 *     in this file may touch the network. `guard-write` computes a local-only
 *     state; `session-start` uses a TTL cache and a bounded ls-remote.
 *   - The same file runs on Windows and POSIX, so no shell syntax appears.
 *   - Failure must not silently open the gate. An unreadable policy or an
 *     unexpected exception denies the write and says why.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const policyMod = require('../lib/policy');
const stateMod = require('../lib/state');
const leases = require('../lib/leases');
const home = require('../lib/home');
const ui = require('../lib/ui');

const FLAGS = { input: 'string' };

/** Tools whose payload names a file to be written. */
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath'];

function readStdin(inputFlag) {
  if (inputFlag) {
    // `--input <file>` exists so the guard can be exercised without a TTY.
    return fs.readFileSync(inputFlag, 'utf8');
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput(raw) {
  const text = String(raw || '').trim();
  if (text === '') return {};
  try { return JSON.parse(text); } catch { return { _unparsed: text }; }
}

/** Collect every filesystem path a tool call would write. */
function targetsFrom(input) {
  const tool = input.tool_name || input.toolName || '';
  const ti = input.tool_input || input.toolInput || {};
  const targets = [];

  for (const f of PATH_FIELDS) {
    if (typeof ti[f] === 'string' && ti[f].trim() !== '') targets.push(ti[f]);
  }
  // MultiEdit and similar batch shapes.
  for (const key of ['edits', 'files', 'operations']) {
    if (Array.isArray(ti[key])) {
      for (const e of ti[key]) {
        if (!e || typeof e !== 'object') continue;
        for (const f of PATH_FIELDS) {
          if (typeof e[f] === 'string' && e[f].trim() !== '') targets.push(e[f]);
        }
      }
    }
  }
  if (/^bash$/i.test(tool) && typeof ti.command === 'string') {
    targets.push(...policyMod.extractBashTargets(ti.command));
  }
  return [...new Set(targets)];
}

/** Emit the PreToolUse decision Claude Code expects. */
function emitDecision(allow, reason) {
  ui.json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: allow ? 'allow' : 'deny',
      permissionDecisionReason: reason,
    },
  });
}

// ---------------------------------------------------------------- guard-write

function guardWrite(ctx, input) {
  const { repoRoot } = ctx;

  // Unparsable input means the guard cannot know what is being written. That is
  // exactly the case the fail-closed rule exists for — distinct from empty
  // input, which legitimately carries no tool call at all.
  if (input && input._unparsed !== undefined) {
    emitDecision(false, 'ai-dev-kit: hook payload was not valid JSON, so the write could not be evaluated; blocked.');
    return EXIT.OK;
  }

  const targets = targetsFrom(input);
  if (targets.length === 0) {
    // Nothing identifiable to govern. For Bash this is the documented limit of
    // static extraction, not a guarantee of safety.
    emitDecision(true, 'no filesystem target identified');
    return EXIT.OK;
  }

  let config = null;
  let policy = null;
  try {
    config = cfgMod.loadConfig(repoRoot, { required: false });
    policy = cfgMod.loadPolicy(repoRoot);
  } catch (e) {
    // Fail closed: an unreadable policy must never mean "no policy".
    emitDecision(false, `ai-dev-kit: policy could not be evaluated (${e.message}); write blocked.`);
    return EXIT.OK;
  }

  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  const verdict = policyMod.decideMany(repoRoot, targets, { config, policy, state: st });

  if (verdict.decision === policyMod.DECISION.DENY) {
    emitDecision(false, `ai-dev-kit: ${verdict.reason}`);
  } else {
    emitDecision(true, 'ai-dev-kit: no policy violation');
  }
  return EXIT.OK;
}

// --------------------------------------------------------------- session-start

function sessionStart(ctx) {
  const { repoRoot } = ctx;
  let config = null;
  try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
  if (!config) {
    ui.json({ hookSpecificOutput: { hookEventName: 'SessionStart',
      additionalContext: '[ai-dev-kit] aidev.yaml not found; run "aidev init".' } });
    return EXIT.OK;
  }

  // Remote check is cached and timeout-bounded so the session never stalls.
  const st = stateMod.computeState(repoRoot, config, { checkRemote: true });
  const lines = [stateMod.formatSummary(st)];

  const sync = leases.readSyncLease(repoRoot);
  if (sync) {
    const ev = leases.evaluateLease(sync);
    lines.push(ev.valid
      ? `⏳ a sync is in progress (target ${stateMod.short(sync.targetSha)}); only .aidev/knowledge/** is writable.`
      : `⚠️ a stale sync lease is present (${ev.reason}). Run "aidev sync --resume" or "aidev sync --abort".`);
  }
  if (st.severity === stateMod.SEVERITY.ERROR) {
    lines.push('❌ writes are blocked until the LLM Wiki exists and is readable.');
  }

  ui.json({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
  return EXIT.OK;
}

// ---------------------------------------------------------------- quality-gate

/**
 * Run the configured format/lint/typecheck commands.
 *
 * Commands come from `quality_gates` in aidev.yaml and run at the PKG root
 * via the platform shell. This is PKG-owned configuration, executed
 * on the developer's own machine — it is not a trust boundary, and nothing
 * from a Work Item or the network reaches it.
 */
function qualityGate(ctx, input) {
  const { repoRoot } = ctx;
  let config = null;
  try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
  const gates = config?.quality_gates || {};
  const names = Object.keys(gates).filter((k) => gates[k]);
  if (names.length === 0) { ui.json({ ok: true, ran: [] }); return EXIT.OK; }

  const edited = targetsFrom(input);
  const cwd = repoRoot;

  // The gates verify PKG code. A Wiki page, a workflow or aidev.yaml is not
  // PKG code, and running the PKG's lint and typecheck after each of dozens of
  // Wiki writes is what made agent-driven Wiki generation crawl.
  const pathsMod = require('../lib/paths');
  const layout = require('../lib/layout');
  const touchesPkg = edited.some((t) => {
    const rel = pathsMod.toRepoRelative(repoRoot, t);
    return rel != null && rel !== '.' && !layout.isKitManaged(rel);
  });
  if (!touchesPkg) {
    ui.json({ ok: true, ran: [], skipped: 'no PKG file was edited (only kit-managed files)', edited: edited.length });
    return EXIT.OK;
  }
  const { execSync } = require('child_process');
  const results = [];
  for (const name of names) {
    try {
      execSync(gates[name], { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' });
      results.push({ gate: name, ok: true });
    } catch (e) {
      results.push({ gate: name, ok: false, output: String(e.stdout || e.stderr || e.message).slice(0, 4000) });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    ui.json({
      hookSpecificOutput: { hookEventName: 'PostToolUse',
        additionalContext: `[ai-dev-kit] quality gate failed: ${failed.map((f) => f.gate).join(', ')}\n` +
          failed.map((f) => `--- ${f.gate} ---\n${f.output}`).join('\n') },
    });
  } else {
    ui.json({ ok: true, ran: results.map((r) => r.gate), edited: edited.length });
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------- session-stop

/**
 * Self-evolution, step one: ask the session to reflect on itself.
 *
 * Only on a kit developer's machine (`home.readDeveloper`), and only once per
 * session that did real work. A Stop hook fires after every response; when a
 * session crosses the thresholds below and has not yet written its
 * reflection, the hook answers `decision: "block"` with instructions, and the
 * same session — the one that holds the context of what it just did — writes
 * where it wasted time or tokens and what the kit could change. The next Stop
 * sees the file and lets the session end.
 *
 * On every other machine this hook does nothing at all: no journal, no cost.
 * The reflection carries aggregate facts and proposals, never prompts,
 * responses, diffs or secrets; the instructions say so explicitly.
 */

const REFLECT_MIN_TOOL_CALLS = 30;
const REFLECT_MIN_OUTPUT_TOKENS = 20000;
const REFLECTION_DIR_REL = '.aidev/cache/evolution';

function reflectionPath(repoRoot, sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return path.join(repoRoot, ...REFLECTION_DIR_REL.split('/'), `${safe}.md`);
}

/**
 * Aggregate a Claude Code transcript (JSONL). Defensive: any malformed line
 * is skipped, and an unreadable file yields { ok: false }.
 */
function summarizeTranscript(transcriptPath) {
  let text;
  try { text = fs.readFileSync(transcriptPath, 'utf8'); } catch { return { ok: false }; }
  const m = {
    ok: true, turns: 0, toolCalls: 0, toolErrors: 0, denials: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    firstAt: null, lastAt: null, toolCounts: {},
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (Number.isFinite(ts)) { if (m.firstAt == null || ts < m.firstAt) m.firstAt = ts; if (m.lastAt == null || ts > m.lastAt) m.lastAt = ts; }
    const msg = obj.message;
    if (!msg || typeof msg !== 'object') continue;
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (obj.type === 'assistant') {
      m.turns++;
      const u = msg.usage || {};
      m.inputTokens += Number(u.input_tokens) || 0;
      m.outputTokens += Number(u.output_tokens) || 0;
      m.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
      m.cacheCreateTokens += Number(u.cache_creation_input_tokens) || 0;
      for (const c of content) {
        if (c && c.type === 'tool_use') { m.toolCalls++; m.toolCounts[c.name || '?'] = (m.toolCounts[c.name || '?'] || 0) + 1; }
      }
    } else if (obj.type === 'user') {
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        if (c.is_error) m.toolErrors++;
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
        if (/ai-dev-kit:.*(blocked|denied|read-only|protected)/.test(body) || /"permissionDecision"\s*:\s*"deny"/.test(body)) m.denials++;
      }
    }
  }
  m.elapsedMs = m.firstAt != null && m.lastAt != null ? m.lastAt - m.firstAt : null;
  return m;
}

function reflectionInstructions(m, rel, sessionId, config) {
  const minutes = m.elapsedMs != null ? Math.round(m.elapsedMs / 60000) : null;
  const top = Object.entries(m.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    'ai-dev-kit self-evolution (kit developer machine): before stopping, reflect on this session once.',
    `Facts from the transcript: ${m.toolCalls} tool calls (${top || 'none'}), ${m.toolErrors} tool errors, ${m.denials} permission denials,`,
    `${m.outputTokens} output tokens, ${m.inputTokens} input tokens (${m.cacheReadTokens} cache reads)${minutes != null ? `, ${minutes} min elapsed` : ''}.`,
    `Write the file ${rel} with exactly these sections and nothing else, then stop:`,
    `# session ${sessionId} / ${config && config.package ? config.package.name : 'unknown'} / claude / ${new Date().toISOString().slice(0, 10)}`,
    '## 事実 — the numbers above and which stage of the work consumed the most calls or tokens',
    '## 無駄と原因 — what was wasted (repeated reads, retries, denied writes, re-orientation) and the cause: agent instructions, a skill, a hook, a default value',
    '## kit への提案 — concrete changes to the kit templates (name the file under templates/<tool>/) that would have avoided the waste',
    '## 提案しないこと — findings specific to this package that do not belong in the kit',
    'Rules: aggregate facts and proposals only. Do NOT copy prompts, responses, diffs, file contents, work item text or anything secret into the file.',
    'Do not change any other file. If you have nothing worth proposing, still write the file with "特になし" under 提案.',
  ].join('\n');
}

function sessionStop(ctx, input) {
  const { repoRoot } = ctx;
  try {
    const dev = home.readDeveloper();
    if (!dev.enabled) { ui.json({ ok: true, skipped: 'not a kit developer machine' }); return EXIT.OK; }
    const sessionId = input && input.session_id;
    if (!sessionId || (input && input.stop_hook_active)) { ui.json({ ok: true }); return EXIT.OK; }
    let config = null;
    try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
    if (!config) { ui.json({ ok: true, skipped: 'not a package' }); return EXIT.OK; }

    const file = reflectionPath(repoRoot, sessionId);
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (fs.existsSync(file)) {
      // Reflection written. With --auto, hand it to `aidev evolve run` once,
      // detached: a Stop hook has no budget to wait for an agent.
      let launched = false;
      const marker = `${file}.evolve-launched`;
      if (dev.autoEvolve && !fs.existsSync(marker)) {
        try {
          fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
          const child = require('child_process').spawn(process.execPath,
            [path.join(ctx.installRoot, 'cli', 'bin', 'aidev.js'), 'evolve', 'run', '--json'],
            { cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' } });
          child.unref();
          launched = true;
        } catch { launched = false; }
      }
      ui.json({ ok: true, reflected: true, file: rel, evolveLaunched: launched });
      return EXIT.OK;
    }

    const m = summarizeTranscript(input.transcript_path || '');
    if (!m.ok) { ui.json({ ok: true, skipped: 'transcript unavailable' }); return EXIT.OK; }
    const metrics = { toolCalls: m.toolCalls, outputTokens: m.outputTokens, inputTokens: m.inputTokens, toolErrors: m.toolErrors, denials: m.denials, elapsedMs: m.elapsedMs };
    if (m.toolCalls < REFLECT_MIN_TOOL_CALLS && m.outputTokens < REFLECT_MIN_OUTPUT_TOKENS) {
      ui.json({ ok: true, belowThreshold: true, metrics });
      return EXIT.OK;
    }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the session writes it */ }
    ui.json({ decision: 'block', reason: reflectionInstructions(m, rel, sessionId, config), metrics });
    return EXIT.OK;
  } catch (e) {
    // A Stop hook must never fail the session.
    ui.json({ ok: true, skipped: `session-stop failed: ${e.message}` });
    return EXIT.OK;
  }
}

const HOOKS = {
  'session-start': sessionStart,
  'guard-write': guardWrite,
  'quality-gate': qualityGate,
  'session-stop': sessionStop,
};

function run(ctx) {
  const name = ctx.positionals[0];
  if (!name) throw new AidevError(`hook name required (one of: ${Object.keys(HOOKS).join(', ')})`);
  const fn = HOOKS[name];
  if (!fn) throw new AidevError(`unknown hook: ${name} (expected one of: ${Object.keys(HOOKS).join(', ')})`);
  const input = parseInput(readStdin(ctx.flags.input));
  try {
    return fn(ctx, input);
  } catch (e) {
    // An unexpected fault in the guard must deny, not crash open.
    if (name === 'guard-write') {
      emitDecision(false, `ai-dev-kit: guard failed (${e.message}); write blocked.`);
      return EXIT.OK;
    }
    throw e;
  }
}

module.exports = {
  run, FLAGS, HOOKS, targetsFrom, parseInput, summarizeTranscript, reflectionPath,
  REFLECTION_DIR_REL, REFLECT_MIN_TOOL_CALLS, REFLECT_MIN_OUTPUT_TOKENS,
  summary: 'hooksからのみ呼ばれる内部サブコマンド',
};
