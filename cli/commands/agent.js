'use strict';
/**
 * `aidev agent list|show|run`
 *
 * The bundled agents are normally started by other commands (`knowledge
 * build`, `sync`, a workflow). This command starts one directly, with one
 * task, through whichever AI coding tool the PKG configures for it:
 *
 *   --tool / --model for this run
 *     > tools.agents.<name> in aidev.yaml
 *       > tools.agent / tools.agent_model in aidev.yaml
 *
 * `run --dry-run` prints the exact command line without starting anything.
 * That is the way to check an adapter the kit does not verify against the
 * real tool (everything except Claude Code) before relying on it.
 *
 * Nothing here bypasses the permission model: the agent runs inside the PKG
 * clone with the same configuration files, hooks and policy an interactive
 * session would use.
 */

const fs = require('fs');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const agentMod = require('../lib/agent');
const toolsMod = require('../lib/tools');
const ui = require('../lib/ui');

const FLAGS = {
  json: 'boolean', 'dry-run': 'boolean',
  tool: 'string', model: 'string', timeout: 'string', 'prompt-file': 'string',
};

const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'run: print the command line that would start the agent; start nothing',
  tool: `run/show: AI tool for this run (${toolsMod.TOOL_IDS.join(', ')}); default: aidev.yaml`,
  model: 'run/show: model for this run; "" passes no model flag',
  timeout: `run: time budget in ms, 10000-7200000 (default ${agentMod.DEFAULT_TIMEOUT_MS})`,
  'prompt-file': 'run: read the task from this file instead of the command line',
};

function bundled(installRoot) { return toolsMod.listBundledAgents(installRoot); }

/** The named agent, or an error that lists what exists. */
function findAgent(installRoot, rawName) {
  let name;
  try { name = agentMod.assertAgentName(rawName); } catch (e) { throw new AidevError(`agent name: ${e.message}`); }
  const agents = bundled(installRoot);
  const found = agents.find((a) => a.name === name);
  if (!found) {
    throw new AidevError(
      `no such agent: ${name}. Bundled agents: ${agents.map((a) => a.name).join(', ') || '(none found; is the kit checkout complete?)'}`);
  }
  return found;
}

/** Tool and model for one run, after flags and aidev.yaml. */
function resolveRun(config, name, flags) {
  const settings = cfgMod.agentSettings(config, name);
  const tool = flags.tool != null ? agentMod.assertTool(flags.tool, '--tool') : settings.tool;
  agentMod.assertToolEnabled(tool, config, flags.tool != null ? '--tool' : 'tools.agent');
  const model = flags.model != null ? cfgMod.assertModel(flags.model, '--model') : settings.model;
  let timeoutMs = agentMod.DEFAULT_TIMEOUT_MS;
  if (flags.timeout != null) {
    const n = Number(flags.timeout);
    if (!Number.isFinite(n) || n < 10000 || n > 7200000) {
      throw new AidevError(`--timeout must be a number of milliseconds between 10000 and 7200000 (got ${flags.timeout})`);
    }
    timeoutMs = Math.round(n);
  }
  return { tool, model, timeoutMs };
}

/** The command line a run would use, for --dry-run and show. */
function previewCommand({ tool, agent, model }) {
  const adapter = toolsMod.getTool(tool);
  const resolved = toolsMod.resolveBinary(adapter, process.env);
  const promptArg = adapter.prompt === 'file' ? `<${agentMod.PROMPT_DIR_REL}/${tool}-run-<pid>-<time>.md>` : null;
  const argv = agentMod.buildArgv({ tool, agent, model, promptArg });
  return {
    bin: resolved.ok ? resolved.bin : adapter.bin,
    argv: resolved.ok ? [...resolved.argvPrefix, ...argv] : argv,
    source: resolved.ok ? resolved.source : resolved.reason,
    promptVia: adapter.prompt,
    verified: adapter.verified,
  };
}

// -------------------------------------------------------------------------- list

function list(ctx) {
  const { repoRoot, flags, installRoot } = ctx;
  const config = cfgMod.loadConfig(repoRoot, { required: false });
  const agents = bundled(installRoot).map((a) => {
    const s = cfgMod.agentSettings(config, a.name);
    return { name: a.name, description: a.description, tool: s.tool, model: s.model, file: a.file };
  });
  if (flags.json) {
    ui.json({
      tools: config ? config.tools : { default: ['claude'], agent: 'claude', agent_model: null, agents: {} },
      supportedTools: toolsMod.TOOL_IDS,
      agents,
    });
    return EXIT.OK;
  }
  ui.heading('aidev agent list');
  if (config) {
    ui.dim(`    tools set up for this PKG: ${config.tools.default.join(', ')}; agents run with ${config.tools.agent}`
      + ` (model: ${config.tools.agent_model || 'tool default'})`);
  } else {
    ui.dim('    no aidev.yaml here; showing the kit defaults (claude)');
  }
  ui.out('');
  ui.table(agents.map((a) => [a.name, `${a.tool}${a.model ? ` / ${a.model}` : ''}  —  ${a.description}`]));
  ui.out('');
  ui.dim('    aidev agent run <name> "<task>"   starts one; aidev agent show <name> prints its command line');
  return EXIT.OK;
}

// -------------------------------------------------------------------------- show

function show(ctx) {
  const { repoRoot, flags, positionals, installRoot } = ctx;
  const agent = findAgent(installRoot, positionals[1]);
  const config = cfgMod.loadConfig(repoRoot, { required: false });
  const settings = cfgMod.agentSettings(config, agent.name);
  const tool = flags.tool != null ? agentMod.assertTool(flags.tool, '--tool') : settings.tool;
  const model = flags.model != null ? cfgMod.assertModel(flags.model, '--model') : settings.model;
  const cmd = previewCommand({ tool, agent: agent.name, model });
  const doc = {
    name: agent.name, description: agent.description, file: agent.file,
    claudeTools: agent.tools, tool, model, command: cmd,
    enabled: !config || config.tools.default.includes(tool),
  };
  if (flags.json) { ui.json(doc); return EXIT.OK; }
  ui.heading(`aidev agent show ${agent.name}`);
  ui.table([
    ['description', agent.description],
    ['definition', agent.file],
    ['tool', `${tool}${doc.enabled ? '' : ' (not in tools.default; add it and run "aidev update")'}`],
    ['model', model || 'tool default (no model flag)'],
    ['prompt via', cmd.promptVia === 'stdin' ? 'stdin' : 'a file under .aidev/cache/agents/ named on the command line'],
    ['command', [cmd.bin, ...cmd.argv].join(' ')],
  ]);
  if (!cmd.verified) {
    ui.warn(`the ${toolsMod.getTool(tool).label} adapter is not verified against the real tool by the kit maintainers;`);
    ui.dim('    confirm the command line above against the version you install before relying on it.');
  }
  return EXIT.OK;
}

// --------------------------------------------------------------------------- run

/** The task text: --prompt-file, then the remaining arguments, then piped stdin. */
function readPrompt(flags, positionals) {
  if (flags['prompt-file'] != null) {
    let text;
    try { text = fs.readFileSync(flags['prompt-file'], 'utf8'); } catch (e) {
      throw new AidevError(`--prompt-file: could not read ${flags['prompt-file']}: ${e.message}`);
    }
    if (!text.trim()) throw new AidevError(`--prompt-file: ${flags['prompt-file']} is empty`);
    return text;
  }
  const inline = positionals.slice(2).join(' ').trim();
  if (inline) return inline;
  if (!process.stdin.isTTY) {
    let text = '';
    try { text = fs.readFileSync(0, 'utf8'); } catch { text = ''; }
    if (text.trim()) return text;
  }
  throw new AidevError('no task given. Pass it as arguments (aidev agent run <name> "<task>"), with --prompt-file, or on stdin.');
}

async function runOne(ctx) {
  const { repoRoot, flags, positionals, installRoot } = ctx;
  const agent = findAgent(installRoot, positionals[1]);
  const config = cfgMod.loadConfig(repoRoot); // required: the tool list lives there
  const { tool, model, timeoutMs } = resolveRun(config, agent.name, flags);
  const human = !flags.json;
  const label = toolsMod.getTool(tool).label;

  if (flags['dry-run']) {
    const cmd = previewCommand({ tool, agent: agent.name, model });
    if (flags.json) {
      ui.json({ ok: true, dryRun: true, agent: agent.name, tool, model, timeoutMs, command: cmd });
      return EXIT.OK;
    }
    ui.heading(`aidev agent run ${agent.name} (dry run)`);
    ui.table([
      ['tool', `${tool} (${label}, ${cmd.source})`],
      ['model', model || 'tool default (no model flag)'],
      ['timeout', agentMod.formatDuration(timeoutMs)],
      ['prompt via', cmd.promptVia],
      ['command', [cmd.bin, ...cmd.argv].join(' ')],
    ]);
    if (!cmd.verified) ui.warn(`the ${label} adapter is not verified against the real tool; check the command line above.`);
    ui.ok('dry run: nothing was started.');
    return EXIT.OK;
  }

  const prompt = readPrompt(flags, positionals);
  if (human) {
    ui.heading(`aidev agent run ${agent.name}`);
    ui.info(`starting ${agent.name} with ${label}${model ? ` (${model})` : ''}; budget ${agentMod.formatDuration(timeoutMs)}`);
  }
  const res = await agentMod.runAgent({
    repoRoot, installRoot, tool, agent: agent.name, prompt, model, timeoutMs, label: 'run',
    onProgress: human ? ({ elapsedMs }) => ui.dim(`    still working, ${agentMod.formatDuration(elapsedMs)} elapsed…`) : null,
  });

  const doc = {
    ok: !!res.ok, agent: agent.name, tool, model, timeoutMs,
    result: res.result == null ? null : String(res.result),
    reason: res.ok ? null : (res.reason || null),
    skipped: !!res.skipped, timedOut: !!res.timedOut, exitCode: res.exitCode ?? null,
    durationMs: res.durationMs ?? null, costUsd: res.costUsd ?? null,
    permissionDenials: res.permissionDenials || 0, promptFile: res.promptFile || null,
  };
  if (flags.json) { ui.json(doc); return res.ok ? EXIT.OK : EXIT.GENERAL; }

  if (res.skipped) {
    ui.warn(`${agent.name} did not run: ${res.reason}`);
    ui.dim(`    Install ${label} (or point ${toolsMod.getTool(tool).envBin} at it) and retry.`);
    return EXIT.GENERAL;
  }
  if (!res.ok) {
    ui.fail(`${agent.name} ${res.timedOut ? 'ran out of time' : 'failed'}: ${res.reason}`);
    if (res.result) for (const l of String(res.result).split('\n').slice(0, 20)) ui.dim(`    ${l}`);
    if (res.stderr) for (const l of res.stderr.split('\n').slice(0, 10)) ui.dim(`    ${l}`);
    return EXIT.GENERAL;
  }
  ui.ok(`${agent.name} finished in ${agentMod.formatDuration(res.durationMs)}`
    + (res.costUsd != null ? ` ($${Number(res.costUsd).toFixed(4)})` : ''));
  if (res.permissionDenials > 0) ui.warn(`    ${label} reported ${res.permissionDenials} permission denial(s).`);
  if (res.result) {
    ui.out('');
    for (const l of String(res.result).split('\n')) ui.out(`  ${l}`);
  }
  return EXIT.OK;
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  if (sub === 'list') return list(ctx);
  if (sub === 'show') return show(ctx);
  if (sub === 'run') return runOne(ctx);
  throw new AidevError(`unknown subcommand: aidev agent ${sub || ''} (expected: list, show, run)`);
}

module.exports = {
  run, FLAGS, FLAG_HELP, previewCommand, resolveRun,
  summary: '同梱エージェントを設定済みの AI ツールで起動する（list / show / run）',
};
