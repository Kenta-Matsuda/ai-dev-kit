'use strict';
/**
 * Launching the bundled Claude Code agents.
 *
 * The CLI owns the structured half of the Wiki — inventory, manifest and the
 * resumable checkpoint. Prose belongs to the `knowledge-builder` agent, and
 * until now nothing actually started it: `build` and `sync` queued pending
 * paths and printed who ought to drain them. This module is that missing step.
 *
 * Three properties matter more than convenience here:
 *
 *   - It is opt-in. Spawning an agent costs money and minutes, so it happens
 *     only when the operator passes `--agent`, never as a side effect of a
 *     command that used to be free.
 *   - It never throws. The structured write has already succeeded by the time
 *     an agent runs, so a missing binary or a failed agent must be *reported*,
 *     not allowed to unwind a completed unit of work. Callers get a result
 *     object and decide the exit code.
 *   - It does not re-implement the permission model. The agent definition
 *     declares its own tools and the PreToolUse guard enforces the policy at
 *     runtime; passing a second, hardcoded allowlist from here would give the
 *     kit two sources of truth that drift apart on the next kit update.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { AidevError } = require('./errors');
const cfgMod = require('./config');
const ui = require('./ui');

/** The agent that owns Wiki prose. */
const DEFAULT_AGENT = 'knowledge-builder';

/** Beyond this, the task goes in a file rather than on the command line. */
const MAX_INLINE_PROMPT_BYTES = 8192;

/** How often a human-mode run reports that Claude is still working. */
const HEARTBEAT_MS = 15000;

/** Maximum Claude result text retained for a failure diagnostic. */
const RESULT_SUMMARY_CHARS = 1600;

/** First Claude Code release supporting every launcher/hook option we use. */
const MIN_CLAUDE_VERSION = '2.1.259';

/** Grace period between SIGTERM and SIGKILL when a run overruns. */
const KILL_GRACE_MS = 5000;

/** `claude` reports SIGTERM as this, which is how a timeout surfaces. */
const EXIT_SIGTERM = 143;

/** Remove terminal control bytes and bound an agent's final message. */
function summarizeResult(value, maxChars = RESULT_SUMMARY_CHARS) {
  if (value == null) return '';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  text = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Render a duration without implying sub-second precision. */
function formatDuration(durationMs) {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Build a shell-free cmd.exe invocation for a legacy .cmd/.bat shim. */
function windowsScriptSpec(script, source, env) {
  const comspec = env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  return {
    ok: true,
    bin: comspec,
    argvPrefix: ['/d', '/s', '/c', script],
    shell: false,
    killTree: true,
    source,
  };
}

/**
 * Locate the Claude Code executable.
 *
 * `AIDEV_CLAUDE_BIN` exists so the test suite can point at a stub: the suite
 * must never spawn the real binary, which would cost money and need a network.
 * A `.js` stub is run through the current Node so the tests stay portable to
 * platforms where a shebang means nothing.
 *
 * On Windows, prefer the native executable returned by `where.exe`. Spawning a
 * bare command with `shell: true` corrupts multi-line argv and can reduce an
 * entire prompt to its first word. Legacy `.cmd` installs are launched through
 * an explicit cmd.exe argv with the natural-language prompt still on stdin.
 */
function resolveBinary(env = process.env) {
  const override = env.AIDEV_CLAUDE_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      return { ok: false, reason: `AIDEV_CLAUDE_BIN points at ${override}, which does not exist` };
    }
    if (override.endsWith('.js')) {
      return {
        ok: true, bin: process.execPath, argvPrefix: [override], shell: false,
        killTree: process.platform === 'win32', skipVersionCheck: true,
        source: 'AIDEV_CLAUDE_BIN',
      };
    }
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(override)) {
      return windowsScriptSpec(override, 'AIDEV_CLAUDE_BIN', env);
    }
    return {
      ok: true, bin: override, argvPrefix: [], shell: false,
      killTree: process.platform === 'win32', source: 'AIDEV_CLAUDE_BIN',
    };
  }

  if (process.platform === 'win32') {
    try {
      const found = spawnSync('where.exe', ['claude'], {
        encoding: 'utf8', env: { ...env }, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const candidate = found.status === 0
        ? String(found.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean)
        : null;
      if (candidate) {
        if (/\.(cmd|bat)$/i.test(candidate)) {
          return windowsScriptSpec(candidate, `PATH (${candidate})`, env);
        }
        return {
          ok: true, bin: candidate, argvPrefix: [], shell: false, killTree: true,
          source: `PATH (${candidate})`,
        };
      }
    } catch { /* spawn below produces the ordinary missing-binary diagnostic */ }
  }

  return {
    ok: true, bin: 'claude', argvPrefix: [], shell: false,
    killTree: false, source: 'PATH',
  };
}

/** Compare a parsed semantic version with the launcher feature floor. */
function versionAtLeast(actual, minimum = MIN_CLAUDE_VERSION) {
  const parse = (value) => String(value).split('.').map((part) => Number(part));
  const a = parse(actual);
  const b = parse(minimum);
  if (a.length < 3 || b.length < 3 || [...a, ...b].some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** Refuse a Claude Code version that cannot honour our permission contract. */
function checkClaudeVersion(resolved, env) {
  if (resolved.skipVersionCheck) return { ok: true, skipped: true };
  try {
    const checked = spawnSync(resolved.bin, [...resolved.argvPrefix, '--version'], {
      encoding: 'utf8', env: { ...env }, windowsHide: true,
      shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = `${checked.stdout || ''}\n${checked.stderr || ''}`.trim();
    if (checked.error && checked.error.code === 'ENOENT') {
      return { ok: false, missing: true, reason: `${resolved.bin} was not found on PATH` };
    }
    const match = /\b(\d+\.\d+\.\d+)\b/.exec(text);
    if (checked.status !== 0 || !match) {
      return { ok: false, reason: `could not determine the Claude Code version (${summarizeResult(text) || `exit ${checked.status}`})` };
    }
    if (!versionAtLeast(match[1])) {
      return {
        ok: false,
        reason: `Claude Code ${match[1]} is too old; ${MIN_CLAUDE_VERSION} or newer is required`,
      };
    }
    return { ok: true, version: match[1] };
  } catch (e) {
    return { ok: false, reason: `could not check the Claude Code version: ${e.message}` };
  }
}

/**
 * Reject anything that is not a plain agent name.
 *
 * The name reaches a subprocess argument, and `--agent ../../x` or a name
 * carrying a NUL or newline is never a legitimate request. Returns the name so
 * it can be used inline.
 */
function assertAgentName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) throw new Error('agent name is empty');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) {
    throw new Error(
      `invalid agent name: ${JSON.stringify(String(name))} ` +
      '(letters, digits, dot, underscore and hyphen only)');
  }
  return s;
}

/**
 * Build the prompt for a Wiki generation run.
 *
 * Generation targets and repository evidence are deliberately separate. A
 * scoped or documentation-only build still receives the full evidence list so
 * the agent can verify prose against implementation.
 */
function buildPrompt({
  targetSha,
  paths = [],
  taskFile = null,
  scope = null,
  evidencePaths = [],
  evidenceInclude = ['src/**'],
  evidenceExclude = [],
  secretsPaths = [],
}) {
  const lines = [
    'Generate the LLM Wiki prose for this package, following the knowledge-builder contract.',
    '',
    `Target submodule SHA: ${targetSha}`,
  ];
  if (scope) {
    lines.push(
      `Generation scope: ${scope}`,
      'This scope limits what may be regenerated; it does not limit repository research.');
  }
  lines.push('');

  if (taskFile) {
    lines.push(
      `The complete generation plan is in: ${taskFile}`,
      'Read that file first. It is a JSON object with separate generationTargets and',
      'evidence.paths arrays; evidence paths are tracked, non-secret files at the target SHA.');
  } else {
    if (paths.length > 0) {
      lines.push(
        `Generation targets (${paths.length}; update Wiki pages for these source paths):`,
        ...paths.map((p) => `  - ${p}`));
    } else {
      lines.push('Generation targets: none; refresh index pages only.');
    }

    lines.push(
      '',
      `Repository evidence (${evidencePaths.length} tracked, non-secret files; research only):`,
      `  include: ${JSON.stringify(evidenceInclude)}`,
      `  exclude: ${JSON.stringify(evidenceExclude)}`);
    if (evidencePaths.length > 0) lines.push(...evidencePaths.map((p) => `  - ${p}`));
    else lines.push('  - No exact evidence paths were supplied; discover files from the include/exclude globs.');
  }

  lines.push(
    '',
    `Secret patterns (never read): ${JSON.stringify(secretsPaths)}`,
    '',
    'Rules:',
    '  - Generation targets are an update queue, NOT the research boundary.',
    '  - Before writing, traverse the evidence inventory and inspect relevant source code,',
    '    tests, configuration, CI and documentation. Never summarize Markdown alone.',
    '  - Trace documented behavior into implementation and tests; prefer code when they conflict.',
    '  - Read PKG files only from evidence.paths. You may also read aidev.yaml and knowledge/**',
    '    as control/generated data. Never read secrets_paths.',
    '  - Write only inside knowledge/**. Never write src/**, .claude/**, or any policy file.',
    '  - Cite the source file (and line, where possible) behind each statement.',
    '  - Mark inference as 推測 and unknowns as 未確認. Do not invent detail to fill a gap.',
    '  - For each completed generation target, update its inventory pages/selfHashes first,',
    '    then remove that exact source path from checkpoint.pendingPaths in',
    '    knowledge/manifest.json. Leave unfinished and deferred target paths in place.');
  return lines.join('\n');
}

function taskDocument({
  targetSha,
  paths,
  scope,
  evidencePaths,
  evidenceInclude,
  evidenceExclude,
  secretsPaths,
}) {
  return {
    schemaVersion: 1,
    targetSha,
    generationScope: scope,
    generationTargets: paths,
    evidence: {
      include: evidenceInclude,
      exclude: evidenceExclude,
      paths: evidencePaths,
      excludedSecretPatterns: secretsPaths,
    },
  };
}

/** Persist an oversized generation/evidence plan in the gitignored cache. */
function writeTaskFile(repoRoot, targetSha, task) {
  const rel = path.join('knowledge', '.cache', `agent-task-${String(targetSha).slice(0, 12)}.json`);
  const full = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  cfgMod.writeJsonAtomic(full, task);
  return rel.split(path.sep).join('/');
}

/** Compose the prompt, spilling the combined plan when it would be oversized. */
function prepareTask(repoRoot, {
  targetSha,
  paths,
  scope = null,
  evidencePaths = [],
  evidenceInclude = ['src/**'],
  evidenceExclude = [],
  secretsPaths = [],
}) {
  const plan = {
    targetSha, paths, scope, evidencePaths, evidenceInclude, evidenceExclude, secretsPaths,
  };
  const inline = buildPrompt(plan);
  if (Buffer.byteLength(inline, 'utf8') <= MAX_INLINE_PROMPT_BYTES) {
    return { prompt: inline, taskFile: null };
  }
  const taskFile = writeTaskFile(repoRoot, targetSha, taskDocument(plan));
  return { prompt: buildPrompt({ ...plan, taskFile }), taskFile };
}

/**
 * Assemble argv for a one-shot agent run.
 *
 * The prompt is deliberately absent: it is written to stdin as text. Passing a
 * multi-line natural-language prompt through cmd.exe caused Windows to split it
 * at the first space and reinterpret the rest, including `--agent`, as shell
 * input. Only fixed flags and already-validated identifiers reach argv now.
 */
function buildArgv({ agent, model = null }) {
  const argv = [
    '-p',
    '--input-format', 'text',
    '--agent', agent,
  ];
  // Omitted entirely rather than passed empty when no model is configured.
  // `--model` is the top of Claude Code's precedence stack below managed
  // settings, so passing one unconditionally would override a developer's own
  // `.claude/settings.local.json` and `ANTHROPIC_MODEL` with a value nobody
  // chose. Leaving the flag off is how you say "your resolution, not mine".
  if (model) argv.push('--model', model);
  argv.push(
    '--output-format', 'json',
    // Wiki generation must edit files without an interactive approval dialog.
    // acceptEdits grants that narrow class while the project deny rules and
    // PreToolUse guard remain active; this intentionally is not bypass mode.
    '--permission-mode', 'acceptEdits',
    // Any operation acceptEdits does not cover is denied rather than hanging a
    // headless process waiting for a host that does not exist.
    '--permission-prompts', 'none',
  );
  return argv;
}

/**
 * Run one agent to completion.
 *
 * Never rejects: every failure — missing binary, non-zero exit, timeout or an
 * invalid JSON protocol response — comes back as a structured result so the
 * caller can render it and choose the exit code.
 */
function runAgent({
  repoRoot,
  agent,
  prompt,
  timeoutMs,
  model = null,
  env = process.env,
  onProgress = null,
}) {
  return new Promise((resolve) => {
    const resolved = resolveBinary(env);
    if (!resolved.ok) {
      resolve({ ok: false, skipped: true, reason: resolved.reason });
      return;
    }
    const compatibility = checkClaudeVersion(resolved, env);
    if (!compatibility.ok) {
      resolve({
        ok: false,
        skipped: !!compatibility.missing,
        incompatible: !compatibility.missing,
        reason: compatibility.reason,
      });
      return;
    }

    const argv = [...resolved.argvPrefix, ...buildArgv({ agent, model })];
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(resolved.bin, argv, {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: !!resolved.shell,
        windowsHide: true,
        env: { ...env },
      });
    } catch (e) {
      resolve({ ok: false, skipped: true, reason: `could not start ${resolved.bin}: ${e.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // A process that exits before consuming stdin may close the pipe. That is
    // reported by its exit/result, not as an unhandled EPIPE in this parent.
    child.stdin.on('error', () => {});
    child.stdin.end(String(prompt == null ? '' : prompt), 'utf8');

    const heartbeat = typeof onProgress === 'function' ? setInterval(() => {
      try { onProgress({ elapsedMs: Date.now() - startedAt }); } catch { /* diagnostics must not stop Claude */ }
    }, HEARTBEAT_MS) : null;

    const deadline = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && resolved.killTree && child.pid) {
        // Killing only cmd.exe (or even the native parent) can leave Claude's
        // descendants running, spending budget and writing after this command
        // has returned. taskkill /T terminates the complete process tree.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore', windowsHide: true, shell: false,
        });
        killer.on('error', () => child.kill('SIGTERM'));
      } else {
        child.kill('SIGTERM');
      }
      // Last-resort escalation if process-tree termination itself fails.
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs) : null;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      if (heartbeat) clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on('error', (e) => {
      cleanup();
      // ENOENT here is the ordinary "Claude Code is not installed" case, which
      // is a skip rather than a failure: the structured work already landed.
      const missing = e && e.code === 'ENOENT';
      resolve(missing
        ? { ok: false, skipped: true, reason: `${resolved.bin} was not found on PATH` }
        : { ok: false, reason: `${resolved.bin} could not be started: ${e.message}`, stderr });
    });

    child.on('close', (code, signal) => {
      cleanup();
      const durationMs = Date.now() - startedAt;
      const exitCode = code == null ? (signal ? EXIT_SIGTERM : 1) : code;

      if (timedOut || exitCode === EXIT_SIGTERM) {
        resolve({
          ok: false, timedOut: true, exitCode, durationMs,
          reason: `the agent exceeded its ${Math.round(timeoutMs / 1000)}s budget and was stopped`,
          stderr: stderr.trim(),
        });
        return;
      }

      let payload = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try { payload = JSON.parse(trimmed); } catch { payload = null; }
      }

      if (exitCode !== 0 || (payload && payload.is_error)) {
        resolve({
          ok: false, exitCode, durationMs,
          reason: (payload && payload.result) || stderr.trim() || `the agent exited ${exitCode}`,
          stderr: stderr.trim(),
          costUsd: payload ? payload.total_cost_usd : undefined,
        });
        return;
      }

      // `--output-format json` is a protocol contract. Treating arbitrary text
      // as success is how an early shell/CLI failure can masquerade as a build.
      if (!payload) {
        resolve({
          ok: false, exitCode, durationMs,
          reason: 'Claude exited 0 but did not return the requested JSON result',
          stderr: stderr.trim(),
          result: summarizeResult(trimmed),
        });
        return;
      }

      resolve({
        ok: true, exitCode, durationMs,
        result: payload.result,
        costUsd: payload.total_cost_usd,
        sessionId: payload.session_id,
        permissionDenials: Array.isArray(payload.permission_denials)
          ? payload.permission_denials.length : 0,
      });
    });
  });
}

/** Count how many paths from this invocation remain in the checkpoint. */
function queuedProgress(repoRoot, paths) {
  try {
    const manifest = cfgMod.readJsonIfExists(path.join(repoRoot, 'knowledge', 'manifest.json'));
    const pendingPaths = manifest?.checkpoint?.pendingPaths;
    if (!Array.isArray(pendingPaths)) return null;
    const remainingSet = new Set(pendingPaths);
    const remaining = paths.filter((p) => remainingSet.has(p)).length;
    return { completed: paths.length - remaining, remaining };
  } catch { return null; }
}

/**
 * Convert process success into Wiki-domain success.
 *
 * Claude can exit 0 after asking a clarification question or refusing a tool.
 * A requested Wiki run is complete only when its own queued source paths have
 * actually disappeared from a valid checkpoint for the expected target SHA.
 */
function assessWikiProgress(agentResult, paths, checkpointPaths, {
  expectedTargetSha = null,
  actualTargetSha = null,
  actualSourceSha = null,
} = {}) {
  if (!agentResult.ran) return agentResult;
  const manifestMismatch = expectedTargetSha != null && actualTargetSha !== expectedTargetSha;
  const sourceMismatch = expectedTargetSha != null && actualSourceSha !== expectedTargetSha;
  if (!Array.isArray(checkpointPaths) || manifestMismatch || sourceMismatch) {
    let reason = 'Wiki manifest checkpoint is missing or invalid after Claude exited';
    if (manifestMismatch) {
      reason = `Wiki manifest target changed during generation (expected ${expectedTargetSha}, got ${actualTargetSha || 'missing'})`;
    } else if (sourceMismatch) {
      reason = `PKG checkout changed during generation (expected ${expectedTargetSha}, got ${actualSourceSha || 'missing'})`;
    }
    return {
      ...agentResult,
      ok: false,
      checkpointInvalid: true,
      targetMismatch: manifestMismatch || sourceMismatch,
      total: paths.length,
      completed: 0,
      remaining: paths.length,
      reason,
    };
  }

  const remainingSet = new Set(checkpointPaths);
  const remaining = paths.filter((p) => remainingSet.has(p)).length;
  const completed = paths.length - remaining;
  const assessed = { ...agentResult, total: paths.length, completed, remaining };

  if (!agentResult.ok || remaining === 0) return assessed;
  const noProgress = completed === 0;
  return {
    ...assessed,
    ok: false,
    noProgress,
    partial: !noProgress,
    reason: noProgress
      ? `Claude exited successfully but completed none of the ${paths.length} queued generation targets`
      : `Claude completed ${completed} of ${paths.length} queued generation targets`,
  };
}

/** Show the domain result after a command has re-read the checkpoint. */
function renderWikiProgress(result, {
  human = true,
  resumeCommand = 'aidev knowledge build --refresh --agent',
} = {}) {
  if (!human || !result.ran) return;
  if (result.ok) {
    ui.ok(`${result.agent} completed ${result.completed}/${result.total} queued generation target(s)`
      + (result.costUsd != null ? ` ($${Number(result.costUsd).toFixed(4)})` : ''));
    return;
  }
  if (!result.checkpointInvalid && !result.noProgress && !result.partial) {
    return; // subprocess failure was already rendered
  }

  if (result.checkpointInvalid) {
    ui.fail(`${result.agent} left the Wiki checkpoint invalid: ${result.reason}.`);
    if (result.checkpointRestored) {
      ui.dim('    The pre-agent queue was restored so the next --refresh run cannot lose work.');
    }
  } else if (result.noProgress) {
    ui.fail(`${result.agent} made no Wiki progress: 0/${result.total} generation targets completed.`);
  } else {
    ui.warn(`${result.agent} made partial Wiki progress: ${result.completed}/${result.total} completed, ${result.remaining} remain.`);
  }
  if (result.resultSummary) {
    ui.dim('    Claude result:');
    for (const line of result.resultSummary.split('\n').slice(0, 12)) ui.dim(`      ${line}`);
  }
  if (result.permissionDenials > 0) {
    ui.warn(`    Claude reported ${result.permissionDenials} permission denial(s).`);
  }
  ui.dim(`    Resume with "${resumeCommand}" after correcting the reported cause.`);
}

/**
 * Flags every command that can launch an agent accepts.
 *
 * `agent` is boolean on purpose. As a string flag, `--agent --refresh` would
 * parse as the agent named "--refresh" (the parser takes the next token
 * verbatim), turning a typo into a confusing runtime error. The name override
 * lives on its own flag, where a missing value is caught immediately.
 */
const AGENT_FLAGS = Object.freeze({
  agent: 'boolean',
  'agent-name': 'string',
  'agent-timeout': 'string',
  'agent-model': 'string',
});

/**
 * Resolve the agent options for one invocation.
 *
 * Throws AidevError on bad input — that happens before any subprocess starts,
 * which is the one class of agent problem that *should* fail the command.
 */
function resolveOptions(flags, config, { defaultAgent = DEFAULT_AGENT } = {}) {
  const enabled = !!flags.agent || flags['agent-name'] != null;

  let agent = defaultAgent;
  if (flags['agent-name'] != null) {
    try {
      agent = assertAgentName(flags['agent-name']);
    } catch (e) {
      throw new AidevError(`--agent-name: ${e.message}`);
    }
  }

  let timeoutMs = config?.knowledge?.agent_timeout_ms ?? 1800000;
  if (flags['agent-timeout'] != null) {
    const n = Number(flags['agent-timeout']);
    if (!Number.isFinite(n) || n < 10000 || n > 7200000) {
      throw new AidevError(
        `--agent-timeout must be a number of milliseconds between 10000 and 7200000 (got ${flags['agent-timeout']})`);
    }
    timeoutMs = Math.round(n);
  }

  // `model.agent` in aidev.yaml is the PKG's standing choice; `--agent-model`
  // is one run's. `--agent-model ""` resolves to null on purpose: that is how an
  // operator opts out of the configured model for a single run and falls back
  // to whatever Claude Code would pick on its own.
  let model = config?.model?.agent ?? null;
  if (flags['agent-model'] != null) {
    model = cfgMod.assertModel(flags['agent-model'], '--agent-model');
  }
  return { enabled, agent, timeoutMs, model };
}

/**
 * Run the Wiki agent and report the subprocess result.
 *
 * The caller must then re-read the checkpoint and call `assessWikiProgress`:
 * process exit 0 alone does not prove that any Wiki target was completed.
 */
async function runWikiAgent({
  repoRoot,
  config,
  flags,
  targetSha,
  paths,
  scope = null,
  evidence = {},
  human = true,
}) {
  const opts = resolveOptions(flags, config);
  if (!opts.enabled) return { ran: false, reason: 'not requested (pass --agent to run it)' };

  const evidencePaths = evidence.paths || [];
  const { prompt, taskFile } = prepareTask(repoRoot, {
    targetSha,
    paths,
    scope,
    evidencePaths,
    evidenceInclude: evidence.include || ['src/**'],
    evidenceExclude: evidence.exclude || [],
    secretsPaths: evidence.secretsPaths || config?.secrets_paths || [],
  });
  if (human) {
    ui.out('');
    ui.info(`running the ${opts.agent} agent for ${paths.length} generation target(s)…`);
    ui.dim(`    repository evidence: ${evidencePaths.length} tracked, non-secret file(s)`);
    ui.dim(`    requested model: ${opts.model || "Claude Code's own default (no --model passed)"}`);
    if (taskFile) ui.dim(`    generation/evidence plan: ${taskFile}`);
  }

  const res = await runAgent({
    repoRoot,
    agent: opts.agent,
    prompt,
    timeoutMs: opts.timeoutMs,
    model: opts.model,
    onProgress: human ? ({ elapsedMs }) => {
      const progress = queuedProgress(repoRoot, paths);
      const checkpoint = progress
        ? `; checkpoint ${progress.completed}/${paths.length} complete`
        : '';
      ui.dim(`    Claude is still running (${formatDuration(elapsedMs)} elapsed${checkpoint})…`);
    } : null,
  });

  if (res.skipped) {
    if (human) {
      ui.warn(`the ${opts.agent} agent did not run: ${res.reason}`);
      ui.dim('    Install Claude Code, or generate the prose in an interactive session:');
      ui.dim(`        claude --agent ${opts.agent}`);
      ui.dim('    The manifest and checkpoint are written, so nothing is lost.');
    }
    return { ran: false, skipped: true, agent: opts.agent, model: opts.model, reason: res.reason };
  }

  if (!res.ok) {
    if (human) {
      ui.fail(`the ${opts.agent} agent process failed: ${res.reason}`);
      if (res.result) for (const l of res.result.split('\n').slice(0, 10)) ui.dim(`    ${l}`);
      if (res.stderr) for (const l of res.stderr.split('\n').slice(0, 10)) ui.dim(`    ${l}`);
      ui.dim(res.timedOut
        ? '    Raise --agent-timeout, or resume with "aidev knowledge build --refresh --agent".'
        : '    The checkpoint is intact; resume with "aidev knowledge build --refresh --agent".');
    }
    return {
      ran: true, ok: false, agent: opts.agent, model: opts.model, reason: res.reason,
      resultSummary: summarizeResult(res.result),
      exitCode: res.exitCode, timedOut: !!res.timedOut, durationMs: res.durationMs,
    };
  }

  if (human) {
    ui.info(`Claude process exited 0 after ${formatDuration(res.durationMs)}; validating the Wiki checkpoint…`);
  }
  return {
    ran: true, ok: true, agent: opts.agent, model: opts.model,
    costUsd: res.costUsd, sessionId: res.sessionId, durationMs: res.durationMs,
    permissionDenials: res.permissionDenials,
    resultSummary: summarizeResult(res.result),
  };
}

module.exports = {
  DEFAULT_AGENT, MAX_INLINE_PROMPT_BYTES, HEARTBEAT_MS, MIN_CLAUDE_VERSION, EXIT_SIGTERM, AGENT_FLAGS,
  resolveBinary, versionAtLeast, checkClaudeVersion, assertAgentName,
  buildPrompt, buildArgv, prepareTask, writeTaskFile, runAgent,
  assessWikiProgress, renderWikiProgress, resolveOptions, runWikiAgent,
};
