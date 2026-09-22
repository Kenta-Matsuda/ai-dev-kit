'use strict';
/**
 * Launching the bundled agents through an AI coding tool.
 *
 * The CLI owns the structured half of the Wiki — inventory, manifest and the
 * resumable checkpoint. Prose belongs to the `knowledge-builder` agent, and
 * this module starts it. It also backs `aidev agent run` and the `ctx.agent`
 * call inside `aidev workflow`, so every agent the CLI starts goes through
 * one launcher.
 *
 * Which tool runs an agent is configuration, not code: `tools.agent` in
 * aidev.yaml is the PKG-wide choice, `tools.agents.<name>` overrides it per
 * agent, and a flag overrides both for one run. The tool-specific details
 * (binary, argv, output format, prompt delivery) live in `tools.js`.
 *
 * Three properties matter more than convenience here:
 *
 *   - It runs by default. A Wiki without prose is not useful to anyone, so
 *     the commands that own the Wiki (`knowledge build`, `sync`) start the
 *     agent unless `--no-agent` is passed. That flag is for CI and scripts
 *     that maintain only the structured half; cost is shown up front and
 *     progress is saved per target.
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
const toolsMod = require('./tools');
const inventory = require('./inventory');
const pathsMod = require('./paths');
const ui = require('./ui');

/** The agent that owns Wiki prose. */
const DEFAULT_AGENT = 'knowledge-builder';

/** Beyond this, the task goes in a file rather than on the command line. */
const MAX_INLINE_PROMPT_BYTES = 8192;

/** How often a human-mode run reports that the tool is still working. */
const HEARTBEAT_MS = 15000;

/** Maximum result text retained for a failure diagnostic. */
const RESULT_SUMMARY_CHARS = 1600;

/** First Claude Code release supporting every launcher/hook option we use. */
const MIN_CLAUDE_VERSION = toolsMod.REGISTRY.claude.minVersion;

/** Grace period between SIGTERM and SIGKILL when a run overruns. */
const KILL_GRACE_MS = 5000;

/** `claude` reports SIGTERM as this, which is how a timeout surfaces. */
const EXIT_SIGTERM = 143;

/** Default time budget for one agent run started outside the Wiki build. */
const DEFAULT_TIMEOUT_MS = 1800000;

/** Prompt files for tools that cannot take the prompt on stdin (gitignored). */
const PROMPT_DIR_REL = '.aidev/cache/agents';

/** The kit checkout that provides the running CLI. */
const DEFAULT_INSTALL_ROOT = path.resolve(__dirname, '..', '..');

/** Remove terminal control bytes and bound an agent's final message. */
function summarizeResult(value, maxChars = RESULT_SUMMARY_CHARS) {
  if (value == null) return '';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  text = toolsMod.stripControl(text).trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** Render a duration without implying sub-second precision. */
function formatDuration(durationMs) {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const assertAgentName = toolsMod.assertAgentName;

/** Compare a version with the Claude Code feature floor (kept for callers that only know Claude). */
function versionAtLeast(actual, minimum = MIN_CLAUDE_VERSION) {
  return toolsMod.versionAtLeast(actual, minimum);
}

/** Validate a tool id from a flag or a workflow definition. */
function assertTool(id, field = 'tool') {
  const s = String(id == null ? '' : id).trim();
  if (!toolsMod.isTool(s)) {
    throw new AidevError(`${field}: ${JSON.stringify(String(id))} is not a supported tool (supported: ${toolsMod.TOOL_IDS.join(', ')})`);
  }
  return s;
}

/** A tool may only start an agent when the PKG sets it up (its config files exist). */
function assertToolEnabled(id, config, field = 'tool') {
  const enabled = (config && config.tools && config.tools.default) || ['claude'];
  if (!enabled.includes(id)) {
    throw new AidevError(
      `${field}: ${id} is not listed in tools.default (${enabled.join(', ')}) in aidev.yaml. ` +
      'Add it there and run "aidev update" so its configuration files exist, then retry.');
  }
  return id;
}

/** Default number of generation targets handed to one agent run. */
const DEFAULT_BATCH_SIZE = 20;

/**
 * The completion protocol, stated once so the prompt and the agent definition
 * cannot drift: the agent reports finished work as small files, and the CLI
 * (`inventory.applyCompletions`) turns those into hashes and checkpoint state.
 */
function completionRules(targetSha) {
  return [
    '  - Do NOT edit .aidev/knowledge/manifest.json or .aidev/knowledge/inventory/**. The CLI updates them from your reports.',
    `  - The moment ONE generation target is finished (all of its pages written), report it by writing`,
    `    ${inventory.DONE_DIR_REL}/<target path with "/" replaced by "__">.json containing`,
    `      {"target": "<exact target path>", "targetSha": "${targetSha}", "pages": [".aidev/knowledge/...md", ...]}`,
    '    List every page you wrote or updated for that target, shared and index pages included.',
    '    Never defer these reports to the end: the CLI reads them for progress and keeps them if the run',
    '    is stopped, so a report written early is work that will not be repeated.',
    '  - A target that needs no page of its own (masked secret, binary, generated noise) is still',
    '    reported, with "pages": [] and a short "note".',
  ];
}

/**
 * Build the prompt for one agent run.
 *
 * Two modes. A `survey` run has no generation targets: it maps the repository
 * into `knowledge/overview.md` and `knowledge/index.md` once, so that every
 * later batch can read those two pages instead of re-orienting itself in a
 * multi-thousand-file tree. A `generate` run takes one batch of targets.
 *
 * Generation targets and repository evidence are deliberately separate. A
 * scoped or documentation-only build still receives the full evidence list so
 * the agent can verify prose against implementation.
 */
function buildPrompt({
  targetSha,
  mode = 'generate',
  batch = null,
  paths = [],
  taskFile = null,
  scope = null,
  hasOverview = false,
  evidencePaths = [],
  evidenceInclude = ['**'],
  evidenceExclude = [],
  secretsPaths = [],
  maxFilesPerDir = 20,
}) {
  const survey = mode === 'survey';
  const lines = [
    survey
      ? 'Survey this package for its LLM Wiki, following the knowledge-builder contract.'
      : 'Generate the LLM Wiki prose for this package, following the knowledge-builder contract.',
    '',
    `Target PKG commit: ${targetSha}`,
  ];
  if (!survey && batch) lines.push(`This is batch ${batch.index} of ${batch.total}.`);
  if (scope) {
    lines.push(
      `Generation scope: ${scope}`,
      'This scope limits what may be regenerated; it does not limit repository research.');
  }
  lines.push('');

  if (survey) {
    lines.push(
      'This run has NO generation targets. Map the repository once so later batches need not:',
      `  - ${inventory.OVERVIEW_PAGE}: purpose, workspaces/packages, build/lint/typecheck/test commands,`,
      '    entry points, main modules and their responsibilities, data flow, external boundaries,',
      '    conventions, known pitfalls. Cite src/ paths (and lines where possible) for every statement.',
      `  - ${inventory.INDEX_PAGE}: the Wiki entry point. What the Wiki contains, how it is organised,`,
      `    a link to overview.md, and the page directories planned for the generation targets`,
      `    (at most ${maxFilesPerDir} pages per directory).`,
      'Be complete but concise: these two pages are the map every later run starts from.',
      '');
  }

  if (taskFile) {
    lines.push(
      `The complete plan for this run is in: ${taskFile}`,
      'Read that file first. It is a JSON object with separate generationTargets and',
      'evidence.paths arrays; evidence paths are tracked, non-secret files at the target SHA.');
  } else {
    if (!survey) {
      if (paths.length > 0) {
        lines.push(
          `Generation targets (${paths.length}; update Wiki pages for these source paths):`,
          ...paths.map((p) => `  - ${p}`));
      } else {
        lines.push('Generation targets: none; refresh index pages only.');
      }
      lines.push('');
    }
    lines.push(
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
    'Rules:');
  if (!survey && hasOverview) {
    lines.push(
      `  - Start by reading ${inventory.INDEX_PAGE} and ${inventory.OVERVIEW_PAGE}: they are the repository map`,
      '    from the survey run. Do not re-survey the whole repository; research what the targets need.');
  }
  lines.push(
    '  - Generation targets are an update queue, NOT the research boundary.',
    '  - Before writing, inspect the relevant source code, tests, configuration, CI and',
    '    documentation from the evidence. Never summarize Markdown alone.',
    '  - Trace documented behavior into implementation and tests; prefer code when they conflict.',
    '  - Read PKG files only from the evidence. You may also read aidev.yaml and .aidev/knowledge/**',
    '    as control/generated data. Never read secrets_paths.',
    '  - Write only inside .aidev/knowledge/**. Never write PKG source files, .claude/**, or any policy file.',
    '  - Cite the source file (and line, where possible) behind each statement.',
    '  - Mark inference as 推測 and unknowns as 未確認. Do not invent detail to fill a gap.',
    ...completionRules(targetSha));
  if (survey) {
    lines.push(
      `  - When both pages are written, report by writing ${inventory.DONE_DIR_REL}/${inventory.SURVEY_TARGET}.json:`,
      `      {"target": "${inventory.SURVEY_TARGET}", "targetSha": "${targetSha}", "pages": ["${inventory.INDEX_PAGE}", "${inventory.OVERVIEW_PAGE}"]}`);
  }
  return lines.join('\n');
}

function taskDocument({
  targetSha,
  mode = 'generate',
  batch = null,
  paths,
  scope,
  evidencePaths,
  evidenceInclude,
  evidenceExclude,
  secretsPaths,
}) {
  return {
    schemaVersion: 2,
    targetSha,
    mode,
    batch,
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

/** Persist an oversized plan in the gitignored cache, one file per run. */
function writeTaskFile(repoRoot, targetSha, task, label = null) {
  const name = `agent-task-${String(targetSha).slice(0, 12)}${label ? `-${label}` : ''}.json`;
  const rel = `${inventory.CACHE_DIR_REL}/${name}`;
  const full = path.join(repoRoot, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  cfgMod.writeJsonAtomic(full, task);
  return rel;
}

/** Compose the prompt, spilling the combined plan when it would be oversized. */
function prepareTask(repoRoot, {
  targetSha,
  mode = 'generate',
  batch = null,
  paths = [],
  scope = null,
  hasOverview = false,
  evidencePaths = [],
  evidenceInclude = ['**'],
  evidenceExclude = [],
  secretsPaths = [],
  maxFilesPerDir = 20,
}, label = null) {
  const plan = {
    targetSha, mode, batch, paths, scope, hasOverview,
    evidencePaths, evidenceInclude, evidenceExclude, secretsPaths, maxFilesPerDir,
  };
  const inline = buildPrompt(plan);
  if (Buffer.byteLength(inline, 'utf8') <= MAX_INLINE_PROMPT_BYTES) {
    return { prompt: inline, taskFile: null };
  }
  const taskFile = writeTaskFile(repoRoot, targetSha, taskDocument(plan), label);
  return { prompt: buildPrompt({ ...plan, taskFile }), taskFile };
}

/** Split the queue into runs of at most `size` targets, in queue order. */
function chunk(list, size) {
  const n = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** A rough "time left" from the batches finished so far; null until one has. */
function estimateRemaining(durationsMs, batchesLeft) {
  if (durationsMs.length === 0 || batchesLeft <= 0) return null;
  const avg = durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length;
  return formatDuration(avg * batchesLeft);
}

/**
 * Assemble argv for a one-shot agent run with the given tool.
 *
 * For Claude Code the prompt is deliberately absent: it is written to stdin
 * as text. Passing a multi-line natural-language prompt through cmd.exe caused
 * Windows to split it at the first space and reinterpret the rest, including
 * `--agent`, as shell input. Tools that take the prompt on argv receive a
 * one-line pointer at a prompt file instead (`promptArg`); only fixed flags and
 * already-validated identifiers reach argv otherwise.
 */
function buildArgv({ tool = 'claude', agent, model = null, promptArg = null }) {
  return toolsMod.getTool(tool).argv({ agent, model, promptArg });
}

/**
 * Write the prompt for a tool that cannot read it from stdin, and return the
 * repo-relative path the argv points at. A tool without named agents gets the
 * bundled agent definition as the preamble, so it still follows the agent's
 * contract even though it cannot select it by name.
 */
function writePromptFile(repoRoot, installRoot, { tool, agent, prompt, label }) {
  const adapter = toolsMod.getTool(tool);
  const safeLabel = String(label || 'run').replace(/[^A-Za-z0-9._-]/g, '_');
  const rel = `${PROMPT_DIR_REL}/${tool}-${safeLabel}-${process.pid}-${Date.now()}.md`;
  const full = path.join(repoRoot, ...rel.split('/'));
  const parts = [];
  if (!adapter.namedAgents && agent) {
    const def = toolsMod.listBundledAgents(installRoot).find((a) => a.name === agent);
    if (def) {
      parts.push(
        `# Agent: ${agent}`,
        '',
        `You are acting as the ai-dev-kit agent "${agent}". Follow its definition below, then the task.`,
        '',
        '---',
        def.body,
        '---',
        '');
    }
  }
  parts.push('# Task', '', String(prompt == null ? '' : prompt), '');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, parts.join('\n'), 'utf8');
  return rel;
}

/**
 * Run one agent to completion.
 *
 * Never rejects: every failure — missing binary, non-zero exit, timeout or an
 * invalid protocol response — comes back as a structured result so the caller
 * can render it and choose the exit code.
 */
function runAgent({
  repoRoot,
  installRoot = DEFAULT_INSTALL_ROOT,
  tool = 'claude',
  agent,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  model = null,
  label = null,
  env = process.env,
  onProgress = null,
  // An agent definition to inline into the prompt instead of selecting it by
  // name (for runs outside a PKG, where no agents tree exists). The tool then
  // receives no agent flag.
  definition = null,
  // Extra tool arguments appended verbatim (caller checks the tool supports them).
  extraArgv = [],
}) {
  return new Promise((resolve) => {
    let adapter;
    try { adapter = toolsMod.getTool(tool); } catch (e) {
      resolve({ ok: false, skipped: true, tool, reason: e.message });
      return;
    }
    const namedAgent = definition ? null : agent;
    if (definition) {
      prompt = [
        `# Agent: ${agent}`, '',
        `You are acting as the ai-dev-kit agent "${agent}". Follow its definition below, then the task.`,
        '', '---', String(definition).trim(), '---', '', '# Task', '', String(prompt == null ? '' : prompt), '',
      ].join('\n');
    }
    const resolved = toolsMod.resolveBinary(adapter, env);
    if (!resolved.ok) {
      resolve({ ok: false, skipped: true, tool, reason: resolved.reason });
      return;
    }
    const compatibility = toolsMod.checkVersion(resolved, env);
    if (!compatibility.ok) {
      resolve({
        ok: false, tool,
        skipped: !!compatibility.missing,
        incompatible: !compatibility.missing,
        reason: compatibility.reason,
      });
      return;
    }

    let promptArg = null;
    let promptFile = null;
    if (adapter.prompt === 'file') {
      try {
        promptFile = writePromptFile(repoRoot, installRoot, { tool, agent: namedAgent, prompt, label });
        promptArg = toolsMod.filePointerPrompt(promptFile);
      } catch (e) {
        resolve({ ok: false, tool, reason: `could not write the prompt file: ${e.message}` });
        return;
      }
    }

    const argv = [...resolved.argvPrefix, ...buildArgv({ tool, agent: namedAgent, model, promptArg }), ...extraArgv];
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(resolved.bin, argv, {
        cwd: repoRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: !!resolved.shell,
        windowsHide: true,
        // The hook the tool runs inherits this environment, which is how the
        // write guard learns which agent the CLI started (policy agents.<name>).
        env: { ...env, AIDEV_AGENT: String(agent || '') },
      });
    } catch (e) {
      resolve({ ok: false, skipped: true, tool, reason: `could not start ${resolved.bin}: ${e.message}` });
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
    child.stdin.end(adapter.prompt === 'stdin' ? String(prompt == null ? '' : prompt) : '', 'utf8');

    const heartbeat = typeof onProgress === 'function' ? setInterval(() => {
      try { onProgress({ elapsedMs: Date.now() - startedAt }); } catch { /* diagnostics must not stop the tool */ }
    }, HEARTBEAT_MS) : null;

    const deadline = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && resolved.killTree && child.pid) {
        // Killing only cmd.exe (or even the native parent) can leave the
        // tool's descendants running, spending budget and writing after this
        // command has returned. taskkill /T terminates the complete tree.
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
      // ENOENT here is the ordinary "tool is not installed" case, which is a
      // skip rather than a failure: the structured work already landed.
      const missing = e && e.code === 'ENOENT';
      resolve(missing
        ? { ok: false, skipped: true, tool, reason: `${resolved.bin} was not found on PATH` }
        : { ok: false, tool, reason: `${resolved.bin} could not be started: ${e.message}`, stderr });
    });

    child.on('close', (code, signal) => {
      cleanup();
      const durationMs = Date.now() - startedAt;
      const exitCode = code == null ? (signal ? EXIT_SIGTERM : 1) : code;

      if (timedOut || exitCode === EXIT_SIGTERM) {
        resolve({
          ok: false, timedOut: true, tool, exitCode, durationMs, promptFile,
          reason: `the agent exceeded its ${Math.round(timeoutMs / 1000)}s budget and was stopped`,
          stderr: stderr.trim(),
        });
        return;
      }

      const parsed = adapter.parse({ stdout, stderr, exitCode });
      resolve({
        ...parsed,
        tool, exitCode, durationMs, promptFile,
        stderr: parsed.ok ? undefined : stderr.trim(),
        result: parsed.ok ? parsed.result : summarizeResult(parsed.result),
      });
    });
  });
}

/** How many of a running batch's targets the agent has reported done so far. */
function batchProgress(repoRoot, paths) {
  try { return inventory.countPendingReports(repoRoot, paths); } catch { return 0; }
}

/**
 * Convert process success into Wiki-domain success.
 *
 * A tool can exit 0 after asking a clarification question or refusing a
 * tool call. A requested Wiki run is complete only when its own queued source
 * paths have actually disappeared from a valid checkpoint for the expected
 * target SHA.
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
    let reason = 'Wiki manifest checkpoint is missing or invalid after the agent exited';
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
      ? `the agent exited successfully but completed none of the ${paths.length} queued generation targets`
      : `the agent completed ${completed} of ${paths.length} queued generation targets`,
  };
}

/** Show the domain result after a command has re-read the checkpoint. */
function renderWikiProgress(result, {
  human = true,
  resumeCommand = 'aidev knowledge build',
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
      ui.dim('    The pre-agent queue was restored so the next build cannot lose work.');
    }
  } else if (result.noProgress) {
    ui.fail(`${result.agent} made no Wiki progress: 0/${result.total} generation targets completed.`);
  } else {
    ui.warn(`${result.agent} made partial Wiki progress: ${result.completed}/${result.total} completed, ${result.remaining} remain.`);
  }
  if (result.resultSummary) {
    ui.dim(`    ${toolLabel(result.tool)} result:`);
    for (const line of result.resultSummary.split('\n').slice(0, 12)) ui.dim(`      ${line}`);
  }
  if (result.permissionDenials > 0) {
    ui.warn(`    ${toolLabel(result.tool)} reported ${result.permissionDenials} permission denial(s).`);
  }
  ui.dim(`    Resume with "${resumeCommand}" after correcting the reported cause.`);
}

function toolLabel(id) {
  try { return toolsMod.getTool(id || 'claude').label; } catch { return String(id); }
}

/**
 * Flags every command that can launch an agent accepts.
 *
 * The agent runs by default, so the only switch is the opt-out. The agent
 * name lives on its own string flag, where a missing value is caught
 * immediately instead of swallowing the next token.
 */
const AGENT_FLAGS = Object.freeze({
  'no-agent': 'boolean',
  'agent-name': 'string',
  'agent-tool': 'string',
  'agent-timeout': 'string',
  'agent-model': 'string',
  'agent-batch-size': 'string',
  survey: 'boolean',
  'no-survey': 'boolean',
});

/** One line per agent flag for `aidev <command> --help`. */
const AGENT_FLAG_HELP = Object.freeze({
  'no-agent': 'write only the manifest and inventory; leave the prose for a later run',
  'agent-name': 'start this agent instead of knowledge-builder',
  'agent-tool': `AI tool that runs the agent (${toolsMod.TOOL_IDS.join(', ')}); default: aidev.yaml tools.agent`,
  'agent-timeout': `time budget per agent run in ms (default ${1800000}, i.e. 30 minutes)`,
  'agent-model': 'model for the agent run; "" leaves the choice to the tool',
  'agent-batch-size': `generation targets per agent run (default ${DEFAULT_BATCH_SIZE})`,
  survey: 'always start with a survey run that rewrites overview.md and index.md',
  'no-survey': 'never run the survey, even on a full rebuild',
});

/**
 * Resolve the agent options for one invocation.
 *
 * Throws AidevError on bad input — that happens before any subprocess starts,
 * which is the one class of agent problem that *should* fail the command.
 *
 * Precedence for the tool and the model, highest first: the flag for this
 * run, `tools.agents.<agent>` in aidev.yaml, then `tools.agent` /
 * `tools.agent_model`.
 */
function resolveOptions(flags, config, { defaultAgent = DEFAULT_AGENT } = {}) {
  // The agent runs unless the operator opts out. Naming an agent while opting
  // out is a contradiction rather than a silent precedence rule.
  if (flags['no-agent'] && flags['agent-name'] != null) {
    throw new AidevError('--no-agent cannot be combined with --agent-name');
  }
  const enabled = !flags['no-agent'];

  let agent = defaultAgent;
  if (flags['agent-name'] != null) {
    try {
      agent = assertAgentName(flags['agent-name']);
    } catch (e) {
      throw new AidevError(`--agent-name: ${e.message}`);
    }
  }

  const settings = cfgMod.agentSettings(config, agent);
  let tool = settings.tool;
  if (flags['agent-tool'] != null) tool = assertTool(flags['agent-tool'], '--agent-tool');
  assertToolEnabled(tool, config, flags['agent-tool'] != null ? '--agent-tool' : 'tools.agent');

  let timeoutMs = config?.knowledge?.agent_timeout_ms ?? 1800000;
  if (flags['agent-timeout'] != null) {
    const n = Number(flags['agent-timeout']);
    if (!Number.isFinite(n) || n < 10000 || n > 7200000) {
      throw new AidevError(
        `--agent-timeout must be a number of milliseconds between 10000 and 7200000 (got ${flags['agent-timeout']})`);
    }
    timeoutMs = Math.round(n);
  }

  // `--agent-model ""` resolves to null on purpose: that is how an operator
  // opts out of the configured model for a single run and falls back to
  // whatever the tool would pick on its own.
  let model = settings.model;
  if (flags['agent-model'] != null) {
    model = cfgMod.assertModel(flags['agent-model'], '--agent-model');
  }

  let batchSize = config?.knowledge?.agent_batch_size ?? DEFAULT_BATCH_SIZE;
  if (flags['agent-batch-size'] != null) {
    const n = Number(flags['agent-batch-size']);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new AidevError(
        `--agent-batch-size must be a whole number between 1 and 500 (got ${flags['agent-batch-size']})`);
    }
    batchSize = n;
  }

  // 'auto' = survey when the Wiki has no overview yet or everything is being
  // regenerated; the flags force it either way for one run.
  if (flags.survey && flags['no-survey']) {
    throw new AidevError('--survey and --no-survey cannot both be given');
  }
  const survey = flags.survey ? true : flags['no-survey'] ? false : 'auto';

  return { enabled, agent, tool, timeoutMs, model, batchSize, survey };
}

/**
 * Run the Wiki agent, one batch of generation targets per process.
 *
 * Why batches: a single run over hundreds of targets shows no progress until
 * it ends, and a timeout throws all of it away. With batches the CLI folds the
 * agent's completion reports into the checkpoint after every run, so progress
 * is real ("batch 3/7, 41/163 targets") and a stopped build resumes from the
 * next batch. An optional survey run first writes the repository map that
 * later batches read instead of re-orienting themselves.
 *
 * The caller must still re-read the checkpoint and call `assessWikiProgress`:
 * process exit 0 alone does not prove that any Wiki target was completed.
 */
async function runWikiAgent({
  repoRoot,
  installRoot = DEFAULT_INSTALL_ROOT,
  config,
  flags,
  targetSha,
  paths,
  scope = null,
  evidence = {},
  human = true,
  fullRebuild = false,
}) {
  const opts = resolveOptions(flags, config);
  if (!opts.enabled) return { ran: false, skipped: true, reason: 'not requested (--no-agent)' };

  const evidencePaths = evidence.paths || [];
  const shardSize = config?.knowledge?.inventory_shard_size ?? 2000;
  const planBase = {
    targetSha,
    scope,
    evidencePaths,
    evidenceInclude: evidence.include || ['**'],
    evidenceExclude: evidence.exclude || [],
    secretsPaths: evidence.secretsPaths || config?.secrets_paths || [],
    maxFilesPerDir: config?.knowledge?.max_files_per_dir ?? 20,
  };
  const overviewPath = path.join(repoRoot, ...inventory.OVERVIEW_PAGE.split('/'));
  let hasOverview = fs.existsSync(overviewPath);
  const needSurvey = opts.survey === true || (opts.survey === 'auto' && (fullRebuild || !hasOverview));
  const batches = chunk(paths, opts.batchSize);
  const label = toolLabel(opts.tool);

  if (human) {
    ui.out('');
    ui.info(`running the ${opts.agent} agent with ${label}: ${paths.length} generation target(s) in `
      + `${batches.length} batch(es) of up to ${opts.batchSize}${needSurvey ? ', after a survey run' : ''}`);
    ui.dim(`    repository evidence: ${evidencePaths.length} tracked, non-secret file(s)`);
    ui.dim(`    requested model: ${opts.model || `${label}'s own default (no model flag passed)`}`);
    ui.dim(`    each run has a ${formatDuration(opts.timeoutMs)} budget. Progress is saved per target,`);
    ui.dim('    so if this stops, "aidev knowledge build" continues where it left off.');
  }

  const summary = {
    ran: true, ok: true, agent: opts.agent, tool: opts.tool, model: opts.model,
    survey: { requested: needSurvey, ran: false, ok: null },
    batches: [], durationMs: 0, costUsd: undefined, permissionDenials: 0,
  };
  const addCost = (res) => {
    summary.durationMs += res.durationMs || 0;
    if (res.costUsd != null) summary.costUsd = (summary.costUsd || 0) + (Number(res.costUsd) || 0);
    summary.permissionDenials += res.permissionDenials || 0;
  };
  const cost = (res) => (res.costUsd != null ? ` ($${Number(res.costUsd).toFixed(4)})` : '');

  const runOne = async (plan, runLabel, describe) => {
    const { prompt, taskFile } = prepareTask(repoRoot, plan, runLabel);
    if (human && taskFile) ui.dim(`    plan file: ${taskFile}`);
    const res = await runAgent({
      repoRoot, installRoot, tool: opts.tool, agent: opts.agent, prompt,
      timeoutMs: opts.timeoutMs, model: opts.model, label: runLabel,
      onProgress: human ? ({ elapsedMs }) => ui.dim(`    ${describe()}, ${formatDuration(elapsedMs)} elapsed…`) : null,
    });
    addCost(res);
    return res;
  };

  const skipped = (res) => {
    if (human) {
      ui.warn(`the ${opts.agent} agent did not run: ${res.reason}`);
      ui.dim(`    Install ${label} and run the same command again; the manifest and checkpoint`);
      ui.dim('    are written, so nothing is lost. To skip the prose on purpose, pass --no-agent.');
    }
    return { ran: false, skipped: true, agent: opts.agent, tool: opts.tool, model: opts.model, reason: res.reason };
  };

  const rejectedReports = (folded) => {
    if (!human || folded.rejected.length === 0) return;
    ui.warn(`${folded.rejected.length} completion report(s) were rejected; those targets stay queued:`);
    for (const r of folded.rejected.slice(0, 10)) ui.dim(`    ${r.target || r.file}: ${r.reason}`);
  };

  const failed = (res, reason, extra = {}) => {
    Object.assign(summary, {
      ok: false, reason, resultSummary: summarizeResult(res.result),
      exitCode: res.exitCode, timedOut: !!res.timedOut, ...extra,
    });
    if (human) {
      ui.fail(`the ${opts.agent} agent ${res.timedOut ? 'ran out of time' : 'failed'}: ${reason}`);
      if (res.result) for (const l of String(res.result).split('\n').slice(0, 10)) ui.dim(`    ${l}`);
      if (res.stderr) for (const l of res.stderr.split('\n').slice(0, 10)) ui.dim(`    ${l}`);
      ui.dim(res.timedOut
        ? '    Finished targets are saved. Resume with "aidev knowledge build"; raise --agent-timeout or lower --agent-batch-size if it keeps happening.'
        : '    Finished targets are saved. Resume with "aidev knowledge build" after correcting the cause.');
    }
    return summary;
  };

  // ---- survey ---------------------------------------------------------------
  if (needSurvey) {
    if (human) ui.info(`survey: mapping the repository into ${inventory.OVERVIEW_PAGE} and ${inventory.INDEX_PAGE}…`);
    const res = await runOne({ ...planBase, mode: 'survey', paths: [] }, 'survey',
      () => 'surveying the repository');
    if (res.skipped) return skipped(res);
    summary.survey.ran = true;
    const folded = inventory.applyCompletions(repoRoot, { targetSha, shardSize });
    rejectedReports(folded);
    summary.survey.ok = !!folded.survey;
    if (folded.manifestInvalid) {
      return failed(res, 'the Wiki manifest or checkpoint is invalid after the survey run', { stage: 'survey' });
    }
    if (!res.ok) return failed(res, res.reason, { stage: 'survey' });
    if (!folded.survey) {
      return failed(res,
        `the survey run exited 0 but did not report ${inventory.OVERVIEW_PAGE} and ${inventory.INDEX_PAGE} as written`,
        { stage: 'survey', surveyIncomplete: true });
    }
    hasOverview = true;
    if (human) ui.ok(`survey complete in ${formatDuration(res.durationMs)}${cost(res)}`);
  }

  // ---- batches --------------------------------------------------------------
  const durations = [];
  let lastResult = null;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const runLabel = `b${String(i + 1).padStart(2, '0')}`;
    const tag = `batch ${i + 1}/${batches.length}`;
    if (human) {
      const eta = estimateRemaining(durations, batches.length - i);
      const span = batch.length > 1 ? `${batch[0]} … ${batch[batch.length - 1]}` : batch[0];
      ui.info(`${tag}: ${batch.length} target(s), ${span}${eta ? ` (about ${eta} left)` : ''}`);
    }
    const res = await runOne(
      { ...planBase, mode: 'generate', paths: batch, batch: { index: i + 1, total: batches.length }, hasOverview },
      runLabel,
      () => `${tag}: ${batchProgress(repoRoot, batch)}/${batch.length} target(s) reported done`);
    if (res.skipped) return skipped(res);
    lastResult = res;
    durations.push(res.durationMs || 0);

    const folded = inventory.applyCompletions(repoRoot, { targetSha, shardSize });
    rejectedReports(folded);
    const done = new Set(folded.applied.map((a) => a.target));
    const completed = batch.filter((p) => done.has(p)).length;
    summary.batches.push({
      index: i + 1, targets: batch.length, completed,
      durationMs: res.durationMs, costUsd: res.costUsd, ok: res.ok && completed === batch.length,
    });

    if (folded.manifestInvalid) {
      return failed(res, `the Wiki manifest or checkpoint is invalid after ${tag}`, { stage: 'batch' });
    }
    if (!res.ok) {
      return failed(res, `${res.reason} (${tag}: ${completed}/${batch.length} target(s) finished and saved)`, { stage: 'batch' });
    }
    if (completed < batch.length) {
      // Exit 0 with targets left is the agent stopping on purpose (a stop
      // condition, a question) or forgetting reports. Either way, continuing
      // would repeat it; stop and let the caller grade partial/no progress.
      summary.stoppedAtBatch = i + 1;
      summary.resultSummary = summarizeResult(res.result);
      if (human) {
        ui.warn(`${tag} ended with ${completed}/${batch.length} target(s) reported done; stopping here.`);
      }
      return summary;
    }
    if (human) ui.ok(`${tag} complete: ${completed}/${batch.length} in ${formatDuration(res.durationMs)}${cost(res)}`);
  }

  summary.resultSummary = summarizeResult(lastResult ? lastResult.result : '');
  if (human) {
    ui.info(`${batches.length} batch(es) finished in ${formatDuration(summary.durationMs)}; validating the Wiki checkpoint…`);
  }
  return summary;
}

/**
 * Resolve `references` from aidev.yaml against the checkout: each entry is a
 * text file or a directory of them. Secret paths are left out (and said so),
 * missing paths are reported rather than silently dropped, so the agent knows
 * the team meant to point it at something. Returns { entries, files, text }
 * where `text` is the prompt section (empty string when nothing is listed).
 */
const REFERENCE_DIR_LIMIT = 200;

function resolveReferences(repoRoot, config) {
  const refs = config && config.references ? config.references : {};
  const secrets = cfgMod.secretGlobs(config);
  const entries = [];
  const files = [];
  const seen = new Set();
  const addFile = (topic, rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    files.push({ topic, path: rel });
  };
  for (const [topic, list] of Object.entries(refs)) {
    for (const rel of list) {
      if (pathsMod.matchesAny(secrets, rel)) { entries.push({ topic, path: rel, status: 'secret' }); continue; }
      const abs = path.join(repoRoot, rel);
      let st = null;
      try { st = fs.statSync(abs); } catch { st = null; }
      if (!st) { entries.push({ topic, path: rel, status: 'missing' }); continue; }
      if (st.isFile()) { entries.push({ topic, path: rel, status: 'file' }); addFile(topic, rel); continue; }
      const found = [];
      walkTextFiles(abs, rel, found, secrets);
      entries.push({ topic, path: rel, status: 'dir', count: found.length });
      for (const f of found) addFile(topic, f);
    }
  }
  return { entries, files, text: referencesText(entries, files) };
}

function walkTextFiles(absDir, relDir, out, secrets) {
  let names = [];
  try { names = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  names.sort((a, b) => a.name.localeCompare(b.name));
  for (const d of names) {
    if (out.length >= REFERENCE_DIR_LIMIT) return;
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const rel = `${relDir}/${d.name}`;
    if (pathsMod.matchesAny(secrets, rel)) continue;
    if (d.isDirectory()) { walkTextFiles(path.join(absDir, d.name), rel, out, secrets); continue; }
    if (!d.isFile()) continue;
    if (cfgMod.NON_TEXT_REFERENCE_EXTENSIONS.includes(path.extname(d.name).toLowerCase())) continue;
    out.push(rel);
  }
}

function referencesText(entries, files) {
  if (entries.length === 0) return '';
  const lines = [
    '# Reference documents',
    '',
    'The team listed these documents in aidev.yaml (`references`). Read the ones for your',
    'topic before the code. They are important sources but may be out of date: verify every',
    'claim you rely on against the code, the configuration and the existing tests, and report',
    'where a document and the repository disagree instead of choosing silently.',
    '',
  ];
  const byTopic = new Map();
  for (const f of files) {
    if (!byTopic.has(f.topic)) byTopic.set(f.topic, []);
    byTopic.get(f.topic).push(f.path);
  }
  for (const [topic, paths] of byTopic) {
    lines.push(`## ${topic}`, '');
    for (const p of paths) lines.push(`- ${p}`);
    lines.push('');
  }
  const missing = entries.filter((e) => e.status === 'missing');
  const secret = entries.filter((e) => e.status === 'secret');
  const empty = entries.filter((e) => e.status === 'dir' && e.count === 0);
  if (missing.length || secret.length || empty.length) {
    lines.push('## Not available', '');
    for (const e of missing) lines.push(`- ${e.path} (${e.topic}): listed in aidev.yaml but not in the checkout`);
    for (const e of empty) lines.push(`- ${e.path} (${e.topic}): directory holds no text files`);
    for (const e of secret) lines.push(`- ${e.path} (${e.topic}): matches secrets_paths; not read`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

module.exports = {
  DEFAULT_AGENT, DEFAULT_BATCH_SIZE, DEFAULT_TIMEOUT_MS, MAX_INLINE_PROMPT_BYTES, HEARTBEAT_MS, MIN_CLAUDE_VERSION,
  EXIT_SIGTERM, PROMPT_DIR_REL, AGENT_FLAGS, AGENT_FLAG_HELP,
  versionAtLeast, assertAgentName, assertTool, assertToolEnabled, toolLabel, formatDuration, summarizeResult,
  buildPrompt, buildArgv, writePromptFile, prepareTask, writeTaskFile, chunk, runAgent, resolveReferences,
  assessWikiProgress, renderWikiProgress, resolveOptions, runWikiAgent,
};
