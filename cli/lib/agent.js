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
const { spawn } = require('child_process');
const { AidevError } = require('./errors');
const cfgMod = require('./config');
const ui = require('./ui');

/** The agent that owns Wiki prose. */
const DEFAULT_AGENT = 'knowledge-builder';

/** Beyond this, the task goes in a file rather than on the command line. */
const MAX_INLINE_PROMPT_BYTES = 8192;

/** Grace period between SIGTERM and SIGKILL when a run overruns. */
const KILL_GRACE_MS = 5000;

/** `claude` reports SIGTERM as this, which is how a timeout surfaces. */
const EXIT_SIGTERM = 143;

/**
 * Locate the Claude Code executable.
 *
 * `AIDEV_CLAUDE_BIN` exists so the test suite can point at a stub: the suite
 * must never spawn the real binary, which would cost money and need a network.
 * A `.js` stub is run through the current Node so the tests stay portable to
 * platforms where a shebang means nothing.
 */
function resolveBinary(env = process.env) {
  const override = env.AIDEV_CLAUDE_BIN;
  if (override) {
    if (!fs.existsSync(override)) {
      return { ok: false, reason: `AIDEV_CLAUDE_BIN points at ${override}, which does not exist` };
    }
    return override.endsWith('.js')
      ? { ok: true, bin: process.execPath, argvPrefix: [override], source: 'AIDEV_CLAUDE_BIN' }
      : { ok: true, bin: override, argvPrefix: [], source: 'AIDEV_CLAUDE_BIN' };
  }
  return { ok: true, bin: 'claude', argvPrefix: [], source: 'PATH' };
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
 * Ordering is not cosmetic: `--allowedTools`, `--disallowedTools` and `--tools`
 * are variadic in the Claude CLI, so a positional prompt placed after any of
 * them would be swallowed as one of their values. Keeping `-p <prompt>` first
 * makes that class of bug impossible regardless of what is appended later.
 */
function buildArgv({ agent, prompt, model = null }) {
  const argv = [
    '-p', prompt,
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
    // Unattended: anything that would prompt is denied rather than hanging
    // forever on a question nobody is present to answer. Deliberately not
    // `bypassPermissions`, which would also disable the kit's own guard.
    '--permission-mode', 'dontAsk',
  );
  return argv;
}

/**
 * Run one agent to completion.
 *
 * Never rejects: every failure — missing binary, non-zero exit, timeout,
 * unparseable output — comes back as a structured result so the caller can
 * render it in human or JSON mode and choose the exit code.
 */
function runAgent({ repoRoot, agent, prompt, timeoutMs, model = null, env = process.env }) {
  return new Promise((resolve) => {
    const resolved = resolveBinary(env);
    if (!resolved.ok) {
      resolve({ ok: false, skipped: true, reason: resolved.reason });
      return;
    }

    const argv = [...resolved.argvPrefix, ...buildArgv({ agent, prompt, model })];
    let child;
    try {
      child = spawn(resolved.bin, argv, {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A shell is needed for exactly one reason: on Windows, a bare `claude`
        // has to become `claude.cmd`, and only cmd.exe knows that. An absolute
        // path needs no such help, and routing one through a shell is actively
        // harmful — Node does not quote the executable when `shell` is set, so
        // `C:\Program Files\nodejs\node.exe` is split at the space and cmd
        // answers `'C:\Program' is not recognized`. Everywhere else argv goes
        // straight to execve with no word splitting at all.
        shell: process.platform === 'win32' && !/[\\/]/.test(resolved.bin),
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

    const deadline = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A wedged agent may ignore SIGTERM; escalate rather than hang the CLI.
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs) : null;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
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
      const exitCode = code == null ? (signal ? EXIT_SIGTERM : 1) : code;

      if (timedOut || exitCode === EXIT_SIGTERM) {
        resolve({
          ok: false, timedOut: true, exitCode,
          reason: `the agent exceeded its ${Math.round(timeoutMs / 1000)}s budget and was stopped`,
          stderr: stderr.trim(),
        });
        return;
      }

      // `--output-format json` prints one object; parse it when we can, but a
      // zero exit with unreadable stdout is still a success for our purposes.
      let payload = null;
      const trimmed = stdout.trim();
      if (trimmed) {
        try { payload = JSON.parse(trimmed); } catch { payload = null; }
      }

      if (exitCode !== 0 || (payload && payload.is_error)) {
        resolve({
          ok: false, exitCode,
          reason: (payload && payload.result) || stderr.trim() || `the agent exited ${exitCode}`,
          stderr: stderr.trim(),
          costUsd: payload ? payload.total_cost_usd : undefined,
        });
        return;
      }

      resolve({
        ok: true, exitCode,
        result: payload ? payload.result : trimmed,
        costUsd: payload ? payload.total_cost_usd : undefined,
        sessionId: payload ? payload.session_id : undefined,
      });
    });
  });
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
 * Run the Wiki agent and report it, in whichever mode the caller is in.
 *
 * Returns `{ ran, ok, ... }` for the caller's JSON payload. A skip is not a
 * failure: the structured write already succeeded, so a machine without Claude
 * Code installed still gets a usable manifest and a clear next step.
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
    ui.dim(`    model: ${opts.model || "Claude Code's own default (no --model passed)"}`);
    if (taskFile) ui.dim(`    generation/evidence plan: ${taskFile}`);
  }

  const res = await runAgent({
    repoRoot, agent: opts.agent, prompt, timeoutMs: opts.timeoutMs, model: opts.model,
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
      ui.fail(`the ${opts.agent} agent failed: ${res.reason}`);
      if (res.stderr) for (const l of res.stderr.split('\n').slice(0, 10)) ui.dim(`    ${l}`);
      ui.dim(res.timedOut
        ? '    Raise --agent-timeout, or resume with "aidev knowledge build --refresh --agent".'
        : '    The checkpoint is intact; resume with "aidev knowledge build --refresh --agent".');
    }
    return {
      ran: true, ok: false, agent: opts.agent, model: opts.model, reason: res.reason,
      exitCode: res.exitCode, timedOut: !!res.timedOut,
    };
  }

  if (human) {
    ui.ok(`the ${opts.agent} agent finished`
      + (res.costUsd != null ? ` ($${Number(res.costUsd).toFixed(4)})` : ''));
  }
  return {
    ran: true, ok: true, agent: opts.agent, model: opts.model,
    costUsd: res.costUsd, sessionId: res.sessionId,
  };
}

module.exports = {
  DEFAULT_AGENT, MAX_INLINE_PROMPT_BYTES, EXIT_SIGTERM, AGENT_FLAGS,
  resolveBinary, assertAgentName, buildPrompt, buildArgv, prepareTask, writeTaskFile, runAgent,
  resolveOptions, runWikiAgent,
};
