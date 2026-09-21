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
 * Record what should happen next. Deliberately does not start generation:
 * a Stop hook has no time budget for it, and the README specifies async
 * submission to the managed runner instead.
 */
function sessionStop(ctx) {
  const { repoRoot } = ctx;
  let config = null;
  try { config = cfgMod.loadConfig(repoRoot, { required: false }); } catch { config = null; }
  if (!config) { ui.json({ ok: true, queued: false }); return EXIT.OK; }

  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  const queueDir = path.join(repoRoot, '.aidev', 'cache');
  const entry = {
    queuedAt: new Date().toISOString(),
    baseSha: st.baseSha,
    knowledgeSha: st.knowledgeSha,
    severity: st.severity,
    // The runner fixes the SHA at submission time and discards the result if
    // the target moved, so record it explicitly rather than re-reading later.
    action: st.severity === stateMod.SEVERITY.ERROR ? 'knowledge-refresh' : 'none',
  };
  try {
    fs.mkdirSync(queueDir, { recursive: true });
    cfgMod.writeJsonAtomic(path.join(queueDir, 'pending-refresh.json'), entry);
  } catch { /* the queue is best-effort */ }

  const evolution = recordEvolutionObservation(repoRoot, config);

  ui.json({ ok: true, queued: entry.action !== 'none', action: entry.action, evolution });
  return EXIT.OK;
}

/**
 * Append one session observation to the self-evolution journal.
 *
 * Observations are *recorded*, never acted on: the README requires improvements
 * to be raised as a reviewed PR against the central kit, because the static
 * files are shared byte-identically by every PKG on that kit commit, and
 * rewriting `.claude/**` locally would make `aidev check` exit 2 anyway.
 *
 * Only aggregate facts are written — SHAs, severity, counts. No prompts, no
 * responses, no diffs, no work-item text: the journal must never become a place
 * where a secret can land.
 */
function recordEvolutionObservation(repoRoot, config) {
  if (!config.self_evolution?.enabled) return { enabled: false };

  const file = path.join(repoRoot, '.aidev', 'cache', 'evolution-journal.json');
  let journal = cfgMod.readJsonIfExists(file);
  if (!journal || !Array.isArray(journal.observations)) {
    journal = { schemaVersion: 1, cadence: config.self_evolution.cadence, observations: [] };
  }

  const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
  const staleWiki = st.severity === stateMod.SEVERITY.ERROR;
  const syncLease = leases.readSyncLease(repoRoot);

  // Signals worth a human's attention, in the terms the README asks for:
  // evidence of rework, wasted calls or friction — not "the session ended".
  const signals = [];
  if (staleWiki) signals.push('session ended with the Wiki out of step with the PKG');
  if (syncLease && !leases.evaluateLease(syncLease).valid) signals.push('a stale sync lease was left behind');

  if (signals.length === 0) {
    return { enabled: true, recorded: false, cadence: journal.cadence };
  }

  journal.cadence = config.self_evolution.cadence;
  journal.observations.push({ at: new Date().toISOString(), signals });
  // Bounded: this is a rolling window for weekly aggregation, not an archive.
  if (journal.observations.length > 200) {
    journal.observations = journal.observations.slice(-200);
  }
  journal.due = isAggregationDue(journal);

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    cfgMod.writeJsonAtomic(file, journal);
  } catch { return { enabled: true, recorded: false }; }

  return {
    enabled: true, recorded: true, signals: signals.length,
    observations: journal.observations.length, due: journal.due,
    cadence: journal.cadence,
  };
}

/** Whether enough time has passed to raise an aggregated central-kit PR. */
function isAggregationDue(journal) {
  const windowDays = journal.cadence === 'daily' ? 1 : journal.cadence === 'monthly' ? 30 : 7;
  const first = journal.observations[0];
  if (!first) return false;
  const age = Date.now() - Date.parse(first.at);
  return Number.isFinite(age) && age >= windowDays * 24 * 60 * 60 * 1000;
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
  run, FLAGS, HOOKS, targetsFrom, parseInput,
  summary: 'hooksからのみ呼ばれる内部サブコマンド',
};
