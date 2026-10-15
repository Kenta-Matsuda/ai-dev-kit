'use strict';
/**
 * `aidev hook <name> [--tool <id>]` — the runtime half of the permission and
 * Wiki design.
 *
 * The AI coding tool passes hook input as JSON on stdin and reads a JSON
 * answer on stdout. Three constraints shape everything here:
 *
 *   - The default hook timeout is 30s (5s is the practical target), so nothing
 *     in this file may touch the network. `guard-write` computes a local-only
 *     state; `session-start` uses a TTL cache and a bounded ls-remote.
 *   - The same file runs on Windows and POSIX, so no shell syntax appears.
 *   - Failure must not silently open the gate. An unreadable policy or an
 *     unexpected exception denies the write and says why.
 *
 * Tools differ in event names, in the shape of the JSON they read back and in
 * how a subagent is started. Those differences live in `tools.js`
 * (`hookAdapter`); this file asks the adapter to shape its output and never
 * looks at the tool id itself.
 *
 * Wiki follow-up (`after-bash`, `session-stop`): after a commit the CLI does
 * the structural half of `aidev sync wiki` on its own and, when prose
 * is owed, hands the interactive tool a plan for its knowledge-builder
 * subagents. The session cannot stop while the Wiki is behind a clean HEAD;
 * the tool's own loop guard (or the kit's, for tools without one) lets the
 * second stop through with a warning.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const layout = require('../lib/layout');
const gitMod = require('../lib/git');
const policyMod = require('../lib/policy');
const stateMod = require('../lib/state');
const inventory = require('../lib/inventory');
const leases = require('../lib/leases');
const home = require('../lib/home');
const toolsMod = require('../lib/tools');
const ui = require('../lib/ui');

const FLAGS = { input: 'string', tool: 'string' };
const FLAG_HELP = {
  input: 'read the hook payload from this file instead of stdin',
  tool: `shape the answer for this AI tool (${toolsMod.TOOL_IDS.join(', ')}); default: claude`,
};

/** Tools whose payload names a file to be written. */
const PATH_FIELDS = ['file_path', 'filePath', 'path', 'notebook_path', 'notebookPath'];

const LAST_HEAD_REL = '.aidev/cache/last-head.json';
const STOP_GUARD_REL = '.aidev/cache/wiki-stop.json';

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

/** The tool name and its arguments, whichever field names the tool uses. */
function toolCall(input) {
  return {
    tool: input.tool_name || input.toolName || '',
    args: input.tool_input || input.toolInput || input.toolArgs || input.tool_args || {},
  };
}

/** Collect every filesystem path a tool call would write. */
function targetsFrom(input) {
  const { tool, args: ti } = toolCall(input);
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
  if (/^(bash|shell|execute_bash|powershell)$/i.test(tool) && typeof ti.command === 'string') {
    targets.push(...policyMod.extractBashTargets(ti.command));
  }
  return [...new Set(targets)];
}

// ------------------------------------------------------------------ output

/** Print what the adapter shaped: a JSON document, raw text, or nothing. */
function emit(obj) {
  if (obj == null) return;
  if (typeof obj.raw === 'string') { ui.out(obj.raw); return; }
  ui.json(obj);
}

/** Emit the PreToolUse decision the tool expects. */
function emitDecision(adapter, allow, reason) {
  emit(adapter.decision(allow, reason));
  return allow ? EXIT.OK : adapter.denyExitCode;
}

function emitContext(adapter, event, text) {
  emit(adapter.context(event, text));
}

// ---------------------------------------------------------------- guard-write

/** What a trial never lets an agent do: push, or open a pull request through a hosting CLI. */
const TRIAL_PUSH_RE = /\bgit(?:\s+(?:-[cC]\s+\S+|--?\S+))*\s+push\b|\bgh\s+pr\s+create\b|\baz\s+repos\s+pr\s+create\b|\bglab\s+mr\s+create\b/;

function guardWrite(ctx, input, adapter) {
  const { repoRoot } = ctx;

  // Unparsable input means the guard cannot know what is being written. That is
  // exactly the case the fail-closed rule exists for — distinct from empty
  // input, which legitimately carries no tool call at all.
  if (input && input._unparsed !== undefined) {
    return emitDecision(adapter, false, 'ai-dev-kit: hook payload was not valid JSON, so the write could not be evaluated; blocked.');
  }

  // Inside a workflow run, the step's agent may call only what its
  // frontmatter and the workflow's agents: grant (tools, MCP servers,
  // subagents). Outside one this says nothing.
  const { tool } = toolCall(input);
  if (process.env.AIDEV_WORKFLOW) {
    let wfConfig;
    try { wfConfig = cfgMod.loadConfig(repoRoot, { required: false }); } catch (e) {
      return emitDecision(adapter, false, `ai-dev-kit: configuration could not be read (${e.message}); tool call blocked.`);
    }
    // Claude Code names the subagent a call comes from (agent_type, with
    // agent_id only inside a subagent); such a call is held to its grants.
    const subagent = input.agent_id && input.agent_type ? String(input.agent_type) : null;
    const t = policyMod.decideToolUse(repoRoot, tool, { config: wfConfig, subagent, toolInput: toolCall(input).args });
    if (t) return emitDecision(adapter, false, `ai-dev-kit: ${t.reason}`);
    // A trial run pushes nothing: not the runner, and not an agent through Bash.
    if (process.env.AIDEV_WORKFLOW_TRIAL && /^(bash|shell|execute_bash|powershell)$/i.test(tool)) {
      const command = String((toolCall(input).args || {}).command || '');
      if (TRIAL_PUSH_RE.test(command)) return emitDecision(adapter, false, 'ai-dev-kit: this is a trial run of the workflow; nothing is pushed and no pull request is opened from it');
    }
  }
  // Starting a subagent writes nothing; its own calls come through here.
  if (/^(Agent|Task)$/.test(tool)) return EXIT.OK;
  // An MCP call writes no file this guard can see. Answering "allow" would
  // approve it on the person's behalf, so the tool's own permissions decide.
  if (/^mcp__/.test(tool)) return EXIT.OK;

  const targets = targetsFrom(input);
  if (targets.length === 0) {
    // Nothing identifiable to govern. For Bash this is the documented limit of
    // static extraction, not a guarantee of safety.
    return emitDecision(adapter, true, 'no filesystem target identified');
  }

  let config = null;
  let policy = null;
  try {
    config = cfgMod.loadConfig(repoRoot, { required: false });
    policy = cfgMod.loadPolicy(repoRoot);
  } catch (e) {
    // Fail closed: an unreadable policy must never mean "no policy".
    return emitDecision(adapter, false, `ai-dev-kit: policy could not be evaluated (${e.message}); write blocked.`);
  }

  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  const verdict = policyMod.decideMany(repoRoot, targets, { config, policy, state: st });

  if (verdict.decision === policyMod.DECISION.DENY) {
    return emitDecision(adapter, false, `ai-dev-kit: ${verdict.reason}`);
  }
  return emitDecision(adapter, true, 'ai-dev-kit: no policy violation');
}

// --------------------------------------------------------------- session-start

function sessionStart(ctx, input, adapter) {
  const { repoRoot } = ctx;
  let config = null;
  try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
  if (!config) {
    emitContext(adapter, 'sessionStart', '[ai-dev-kit] aidev.yaml not found; run "aidev init".');
    return EXIT.OK;
  }

  // Remote check is cached and timeout-bounded so the session never stalls.
  const st = stateMod.computeState(repoRoot, config, { checkRemote: true });
  const lines = [stateMod.formatSummary(st)];

  const lease = leases.readSyncLease(repoRoot);
  if (lease) {
    const ev = leases.evaluateLease(lease);
    lines.push(ev.valid
      ? `⏳ a Wiki publish is in progress (target ${stateMod.short(lease.targetSha)}); only .aidev/knowledge/** is writable.`
      : `⚠️ a stale publish lease is present (${ev.reason}). Run "aidev sync wiki" to continue it or "aidev sync wiki --abort" to discard it.`);
  }
  if (st.severity === stateMod.SEVERITY.ERROR) {
    lines.push('❌ writes are blocked until the LLM Wiki exists and is readable.');
  } else if (needsFollowUp(st)) {
    lines.push(st.wikiBehind
      ? 'ℹ️ the Wiki will be brought to HEAD after your next commit (the hook writes a plan for the knowledge-builder subagent).'
      : `ℹ️ ${st.pendingPages} Wiki page(s) still await prose; the Stop hook will ask for the knowledge-builder subagent before the session ends.`);
  }

  // Remember HEAD so after-bash reacts to the first commit of the session.
  rememberHead(repoRoot, gitMod.headSha(repoRoot));

  emitContext(adapter, 'sessionStart', lines.join('\n'));
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
function qualityGate(ctx, input, adapter) {
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
    emitContext(adapter, 'postToolUse',
      `[ai-dev-kit] quality gate failed: ${failed.map((f) => f.gate).join(', ')}\n` +
      failed.map((f) => `--- ${f.gate} ---\n${f.output}`).join('\n'));
  } else {
    ui.json({ ok: true, ran: results.map((r) => r.gate), edited: edited.length });
  }
  return EXIT.OK;
}

// ------------------------------------------------------------ Wiki follow-up

/** The Wiki needs work: it is behind HEAD, or its structure is at HEAD but prose is owed. */
function needsFollowUp(st) {
  return st.hasWiki && st.severity !== stateMod.SEVERITY.ERROR && (st.wikiBehind || st.pendingPages > 0);
}

function rememberHead(repoRoot, sha) {
  try { cfgMod.writeJsonAtomic(layout.abs(repoRoot, LAST_HEAD_REL), { sha: sha || null, at: new Date().toISOString() }); } catch { /* best effort */ }
}

function lastHead(repoRoot) {
  const doc = cfgMod.readJsonIfExists(layout.abs(repoRoot, LAST_HEAD_REL));
  return doc && typeof doc.sha === 'string' ? doc.sha : null;
}

/**
 * What the interactive tool must do now: start the knowledge-builder as a
 * subagent per batch, then let the CLI fold the reports and commit.
 */
function planInstructions(adapter, st, planned) {
  const b = st.behind || {};
  const agent = 'knowledge-builder';
  const why = st.wikiBehind
    ? `the Wiki describes ${stateMod.short(st.knowledgeSha)} but HEAD is ${stateMod.short(st.headSha)} (+${b.added || 0} ~${b.modified || 0} -${b.removed || 0} →${b.renamed || 0})`
    : `the Wiki structure is at HEAD (${stateMod.short(st.headSha)}) but its prose is not finished`;
  return [
    `[ai-dev-kit] ${why}. The structural update is done; ${planned.targets} generation target(s) need prose in ${planned.batches} batch(es).`,
    'Do this now, before any other work:',
    `  1. For each batch in ${planned.rel} (\`batches[i]\`), ${adapter.subagentHint(agent)} with this task: ` +
      `"Read ${planned.rel}. You handle batch <i>: write the Wiki pages for its generation targets following the ${agent} contract ` +
      'and write one completion report per target under `reportDir` with the plan\'s `targetSha`." Run the batches one after another.',
    `  2. When every batch has reported, run \`${planned.finish}\`: the CLI records the reports and commits ${layout.KNOWLEDGE_REL}/ as its own commit.`,
    '  3. If the command says targets are still queued, start the subagent again for the batches it names.',
    'Do not edit the Wiki pages by hand and do not touch manifest.json or inventory/**.',
  ].join('\n');
}

/**
 * Bring the structural half of the Wiki to HEAD and say what is left.
 * Returns { kind, text } where kind is one of: 'skip', 'dirty', 'committed',
 * 'plan', 'error'.
 */
function followUp(ctx, config, st) {
  const { repoRoot } = ctx;
  const dirty = inventory.dirtyTargets(repoRoot, config);
  if (dirty.length > 0) {
    return {
      kind: 'dirty',
      text: `[ai-dev-kit] the Wiki is behind HEAD (${stateMod.short(st.headSha)}), but ${dirty.length} generation target(s) are not committed yet: ` +
        `${dirty.slice(0, 8).join(', ')}${dirty.length > 8 ? ', …' : ''}. Commit them; the Wiki is updated after the commit.`,
    };
  }
  const knowledge = require('./knowledge');
  const flags = { 'no-agent': true, json: true };
  return knowledge.updateInPlace({ ...ctx, flags }, config, repoRoot, { silent: true, commit: true, human: false })
    .then((r) => {
      if (r.remaining === 0) {
        return {
          kind: 'committed',
          text: r.committed
            ? `[ai-dev-kit] the Wiki structure was brought to HEAD without prose changes and committed as ${stateMod.short(r.commitSha)}.`
            : '[ai-dev-kit] the Wiki already describes HEAD.',
        };
      }
      const planned = knowledge.readPlanFile(repoRoot) || {};
      return {
        kind: 'plan',
        // Describe the situation the hook found, not the structure it just wrote.
        text: planInstructions(ctx.adapter, st, {
          rel: knowledge.PLAN_REL, targets: r.remaining,
          batches: Array.isArray(planned.batches) ? planned.batches.length : 1,
          finish: planned.finish || `${knowledge.COMMAND} --no-agent`,
        }),
      };
    })
    .catch((e) => ({ kind: 'error', text: `[ai-dev-kit] the Wiki is behind HEAD but could not be updated: ${e.message}` }));
}

/**
 * PostToolUse for shell commands: notice a new HEAD, and when the Wiki fell
 * behind a clean tree, do the structural update and hand over the plan.
 */
async function afterBash(ctx, input, adapter) {
  const { repoRoot } = ctx;
  let config = null;
  try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
  if (!config) { ui.json({ ok: true, skipped: 'not a package' }); return EXIT.OK; }

  const head = gitMod.headSha(repoRoot);
  const previous = lastHead(repoRoot);
  rememberHead(repoRoot, head);
  if (!head || head === previous) { ui.json({ ok: true, head: head ? stateMod.short(head) : null, changed: false }); return EXIT.OK; }

  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  if (!needsFollowUp(st)) {
    ui.json({ ok: true, head: stateMod.short(head), changed: true, wikiBehind: !!st.wikiBehind, pending: st.pendingPages });
    return EXIT.OK;
  }
  const r = await followUp({ ...ctx, adapter }, config, st);
  const shaped = adapter.context('postToolUse', r.text);
  if (shaped == null) ui.json({ ok: true, head: stateMod.short(head), changed: true, wikiBehind: true, followUp: r.kind });
  else emit({ ...shaped, ok: true, followUp: r.kind });
  return EXIT.OK;
}

/** The kit's own loop guard for tools whose Stop hook has none. */
function stopGuard(repoRoot, head) {
  const full = layout.abs(repoRoot, STOP_GUARD_REL);
  const doc = cfgMod.readJsonIfExists(full);
  if (doc && doc.sha === head) { try { fs.unlinkSync(full); } catch { /* ignore */ } return true; }
  try { cfgMod.writeJsonAtomic(full, { sha: head, at: new Date().toISOString() }); } catch { /* best effort */ }
  return false;
}

/**
 * Refuse to stop while the Wiki is behind a clean HEAD. Returns the block
 * document, or null when the session may stop (with an optional warning).
 */
async function wikiStopCheck(ctx, input, adapter, config) {
  const { repoRoot } = ctx;
  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  if (!needsFollowUp(st)) return { block: null };
  const head = st.headSha;
  const active = adapter.stopActive(input);
  const secondTime = active === null ? stopGuard(repoRoot, head) : active === true;
  const r = await followUp({ ...ctx, adapter }, config, st);
  if (r.kind === 'committed') return { block: null, note: r.text };
  if (r.kind === 'dirty') return { block: null, note: r.text };
  if (secondTime) return { block: null, note: `${r.text}\n(the session was already asked once; letting it stop)` };
  return { block: adapter.block(r.text), note: null };
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

async function sessionStop(ctx, input, adapter) {
  const { repoRoot } = ctx;
  try {
    let config = null;
    try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }

    // ---- the Wiki must be at HEAD before the session ends -------------------
    let wikiNote = null;
    if (config) {
      const w = await wikiStopCheck(ctx, input, adapter, config);
      if (w.block) { emit({ ...w.block, wiki: 'behind' }); return EXIT.OK; }
      wikiNote = w.note;
    }

    // ---- kit developer reflection ---------------------------------------------
    const dev = home.readDeveloper();
    if (!dev.enabled) { ui.json({ ok: true, skipped: 'not a kit developer machine', wiki: wikiNote }); return EXIT.OK; }
    const sessionId = input && input.session_id;
    if (!sessionId || adapter.stopActive(input) === true) { ui.json({ ok: true, wiki: wikiNote }); return EXIT.OK; }
    if (!config) { ui.json({ ok: true, skipped: 'not a package' }); return EXIT.OK; }

    const file = reflectionPath(repoRoot, sessionId);
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/');
    if (fs.existsSync(file)) {
      // Reflection written. With --auto, hand it to `npm run evolve -- run` once,
      // detached: a Stop hook has no budget to wait for an agent.
      let launched = false;
      const marker = `${file}.evolve-launched`;
      if (dev.autoEvolve && !fs.existsSync(marker)) {
        try {
          fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
          const child = require('child_process').spawn(process.execPath,
            [path.join(ctx.installRoot, 'scripts', 'evolve.js'), 'run', '--json'],
            { cwd: repoRoot, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' } });
          child.unref();
          launched = true;
        } catch { launched = false; }
      }
      ui.json({ ok: true, reflected: true, file: rel, evolveLaunched: launched, wiki: wikiNote });
      return EXIT.OK;
    }

    const m = summarizeTranscript(input.transcript_path || '');
    if (!m.ok) { ui.json({ ok: true, skipped: 'transcript unavailable', wiki: wikiNote }); return EXIT.OK; }
    const metrics = { toolCalls: m.toolCalls, outputTokens: m.outputTokens, inputTokens: m.inputTokens, toolErrors: m.toolErrors, denials: m.denials, elapsedMs: m.elapsedMs };
    if (m.toolCalls < REFLECT_MIN_TOOL_CALLS && m.outputTokens < REFLECT_MIN_OUTPUT_TOKENS) {
      ui.json({ ok: true, belowThreshold: true, metrics, wiki: wikiNote });
      return EXIT.OK;
    }
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the session writes it */ }
    emit({ ...adapter.block(reflectionInstructions(m, rel, sessionId, config)), metrics });
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
  'after-bash': afterBash,
  'session-stop': sessionStop,
};

async function run(ctx) {
  const name = ctx.positionals[0];
  if (!name) throw new AidevError(`hook name required (one of: ${Object.keys(HOOKS).join(', ')})`);
  const fn = HOOKS[name];
  if (!fn) throw new AidevError(`unknown hook: ${name} (expected one of: ${Object.keys(HOOKS).join(', ')})`);
  let adapter;
  try { adapter = toolsMod.hookAdapter(ctx.flags.tool || 'claude'); } catch (e) { throw new AidevError(`--tool: ${e.message}`); }
  const input = parseInput(readStdin(ctx.flags.input));
  try {
    return await fn(ctx, input, adapter);
  } catch (e) {
    // An unexpected fault in the guard must deny, not crash open.
    if (name === 'guard-write') {
      return emitDecision(adapter, false, `ai-dev-kit: guard failed (${e.message}); write blocked.`);
    }
    throw e;
  }
}

module.exports = {
  run, FLAGS, FLAG_HELP, HOOKS, targetsFrom, parseInput, summarizeTranscript, reflectionPath, planInstructions,
  REFLECTION_DIR_REL, REFLECT_MIN_TOOL_CALLS, REFLECT_MIN_OUTPUT_TOKENS, LAST_HEAD_REL, STOP_GUARD_REL,
  summary: 'hooksからのみ呼ばれる内部サブコマンド',
};
