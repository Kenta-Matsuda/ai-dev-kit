'use strict';
/**
 * `npm run evolve -- enable|disable|status|run` — self-evolution, step two.
 *
 * Step one is the Stop hook (`aidev hook session-stop`): on a kit developer's
 * machine it asks a session that did real work to write a reflection into
 * `.aidev/cache/evolution/<session>.md` of the package it worked in.
 *
 * This command turns those reflections into a pull request against the kit:
 * it collects them from every package registered on this machine, checks a
 * fresh worktree of the kit out on `aidev/evolve-<date>`, and runs the
 * `evolution` agent there. The agent edits the kit's templates, runs the
 * kit's checks, commits, and opens the PR with whatever it has (GitHub MCP,
 * `gh`, the Azure DevOps MCP). A human merges.
 *
 * None of this exists for package users: `enable` writes a marker under
 * AIDEV_HOME, never anything a PKG repository distributes.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../cli/lib/errors');
const cfgMod = require('../cli/lib/config');
const gitMod = require('../cli/lib/git');
const home = require('../cli/lib/home');
const agentMod = require('../cli/lib/agent');
const toolsMod = require('../cli/lib/tools');
const ui = require('../cli/lib/ui');

const FLAGS = { json: 'boolean', 'dry-run': 'boolean', auto: 'boolean', tool: 'string', model: 'string', timeout: 'string' };
const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'run: list the reflections and the command; start nothing',
  auto: 'enable: also let the Stop hook start "npm run evolve -- run" by itself',
  tool: `run: AI tool that runs the evolution agent (${toolsMod.TOOL_IDS.join(', ')}; default claude)`,
  model: 'run: model for the evolution agent; "" passes no model flag',
  timeout: `run: time budget in ms (default ${agentMod.DEFAULT_TIMEOUT_MS})`,
};

const REFLECTION_DIR_REL = '.aidev/cache/evolution';
const AGENT_DEF_REL = 'cli/agents/evolution.md';
const AGENT_NAME = 'evolution';

/** Tool calls the evolution agent needs in the kit worktree (Claude Code form). */
const CLAUDE_ALLOWED_TOOLS = 'Read,Glob,Grep,Edit,Write,Bash(git *),Bash(npm *),Bash(node *),Bash(gh *)';

function requireDeveloper() {
  const dev = home.readDeveloper();
  if (!dev.enabled) {
    throw new AidevError('self-evolution is for ai-dev-kit developers only. Run "npm run evolve -- enable" on a kit developer machine.');
  }
  return dev;
}

/** Every reflection on this machine: [{ file, pkg, session }]. */
function collectReflections(repoRoot) {
  const roots = new Map();
  for (const p of home.listPackages().present) roots.set(path.resolve(p.path).toLowerCase(), { path: p.path, name: p.name || path.basename(p.path) });
  if (repoRoot && fs.existsSync(cfgMod.configPath(repoRoot))) {
    roots.set(path.resolve(repoRoot).toLowerCase(), { path: repoRoot, name: path.basename(repoRoot) });
  }
  const out = [];
  for (const r of roots.values()) {
    const dir = path.join(r.path, ...REFLECTION_DIR_REL.split('/'));
    let names;
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort(); } catch { continue; }
    for (const n of names) out.push({ file: path.join(dir, n), pkg: r.name, session: n.replace(/\.md$/, '') });
  }
  return out;
}

function readAgentDefinition(installRoot) {
  const p = path.join(installRoot, ...AGENT_DEF_REL.split('/'));
  const text = cfgMod.readTextIfExists(p);
  if (text == null) throw new AidevError(`the evolution agent definition is missing from the kit checkout (${AGENT_DEF_REL}).`);
  return toolsMod.parseFrontmatter(text).body.trim();
}

function buildPrompt({ branch, worktree, inputDir, reflections, kitCommit }) {
  return [
    'Improve the ai-dev-kit templates from the session reflections below.',
    '',
    `Kit worktree (your working directory, branch ${branch}, based on ${String(kitCommit).slice(0, 12)}): ${worktree}`,
    `Reflections (${reflections.length}), copied to ${inputDir}:`,
    ...reflections.map((r) => `  - ${r.copy}  (package ${r.pkg}, session ${r.session})`),
    '',
    'Steps:',
    '  1. Read every reflection. Group the proposals by the template file they name.',
    '  2. Apply the changes that generalise across packages to templates/<tool>/ (keep the trees in step:',
    '     an agent or skill changed for claude is changed the same way for copilot and kiro).',
    '  3. Run "npm run check" and "npm run docs:check" in the worktree; fix what you broke.',
    '  4. Commit on the current branch with a message that lists the reflections used.',
    '  5. Open a pull request for this branch against main with the tools available to you',
    '     (GitHub MCP, "gh pr create", or the Azure DevOps MCP, whichever matches the remote of this checkout).',
    '     The PR body summarises each change and the evidence behind it. Never merge.',
    '  6. Report: the branch, the PR link (or why none was opened), and any proposal you rejected and why.',
    '',
    'Rules: never weaken settings.json deny rules, hooks, or policy defaults; never copy prompts, responses,',
    'diffs or secrets from a reflection into the kit; do not touch files outside templates/, docs/ and tests.',
  ].join('\n');
}

function enable(ctx) {
  const doc = home.setDeveloper({ enabled: true, autoEvolve: !!ctx.flags.auto });
  if (ctx.flags.json) { ui.json({ ok: true, ...doc, path: home.developerPath() }); return EXIT.OK; }
  ui.heading('npm run evolve -- enable');
  ui.ok(`this machine is now a kit developer machine (${home.developerPath()})`);
  ui.dim('    Sessions that do real work will be asked to write a reflection before they stop.');
  ui.dim(doc.autoEvolve
    ? '    The Stop hook will also start "npm run evolve -- run" by itself (--auto).'
    : '    Turn reflections into a kit PR with "npm run evolve -- run" (or enable --auto).');
  return EXIT.OK;
}

function disable(ctx) {
  home.setDeveloper({ enabled: false });
  if (ctx.flags.json) { ui.json({ ok: true, enabled: false }); return EXIT.OK; }
  ui.heading('npm run evolve -- disable');
  ui.ok('self-evolution is off on this machine; the Stop hook does nothing here now.');
  return EXIT.OK;
}

function status(ctx) {
  const dev = home.readDeveloper();
  const reflections = dev.enabled ? collectReflections(ctx.repoRoot) : [];
  if (ctx.flags.json) { ui.json({ ...dev, reflections: reflections.map((r) => ({ file: r.file, pkg: r.pkg, session: r.session })) }); return EXIT.OK; }
  ui.heading('npm run evolve -- status');
  ui.table([
    ['enabled', dev.enabled ? `yes (${dev.source})` : 'no'],
    ['auto run', dev.autoEvolve ? 'yes' : 'no'],
    ['reflections', dev.enabled ? String(reflections.length) : '-'],
  ]);
  for (const r of reflections.slice(0, 20)) ui.dim(`    ${r.pkg}: ${r.file}`);
  return EXIT.OK;
}

async function runEvolve(ctx) {
  const { repoRoot, installRoot, flags } = ctx;
  const human = !flags.json;
  requireDeveloper();
  if (!gitMod.isRepo(installRoot)) throw new AidevError('the kit checkout is not a git repository; evolve needs one to create a worktree.');

  const tool = flags.tool != null ? agentMod.assertTool(flags.tool, '--tool') : 'claude';
  const model = flags.model != null ? cfgMod.assertModel(flags.model, '--model') : null;
  let timeoutMs = agentMod.DEFAULT_TIMEOUT_MS;
  if (flags.timeout != null) {
    const n = Number(flags.timeout);
    if (!Number.isFinite(n) || n < 10000 || n > 7200000) throw new AidevError(`--timeout must be between 10000 and 7200000 ms (got ${flags.timeout})`);
    timeoutMs = Math.round(n);
  }

  const reflections = collectReflections(repoRoot);
  if (reflections.length === 0) {
    if (flags.json) ui.json({ ok: true, reflections: 0, ran: false });
    else { ui.heading('npm run evolve -- run'); ui.info('no reflections to work from; nothing to do.'); }
    return EXIT.OK;
  }

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const branch = `aidev/evolve-${date}`;
  const base = path.join(home.home(), 'cache', 'evolve');
  const worktree = path.join(base, date);
  const inputDir = path.join(base, `${date}-input`);
  const kitCommit = gitMod.headSha(installRoot);
  const definition = readAgentDefinition(installRoot);

  if (flags['dry-run']) {
    const cmd = agentMod.previewCommand({ tool, agent: null, model });
    if (flags.json) ui.json({ ok: true, dryRun: true, reflections: reflections.map((r) => r.file), branch, worktree, command: cmd });
    else {
      ui.heading('npm run evolve -- run (dry run)');
      ui.table([['reflections', String(reflections.length)], ['branch', branch], ['worktree', worktree], ['tool', tool], ['command', [cmd.bin, ...cmd.argv].join(' ')]]);
      for (const r of reflections) ui.dim(`    ${r.pkg}: ${r.file}`);
      ui.ok('dry run: nothing was started.');
    }
    return EXIT.OK;
  }

  // A fresh worktree keeps the developer's kit checkout (and `aidev update`,
  // which requires main) untouched while the agent works on its own branch.
  fs.mkdirSync(base, { recursive: true });
  if (!fs.existsSync(worktree)) {
    const exists = gitMod.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: installRoot }).ok;
    const add = exists
      ? gitMod.run(['worktree', 'add', worktree, branch], { cwd: installRoot })
      : gitMod.run(['worktree', 'add', '-b', branch, worktree, 'main'], { cwd: installRoot });
    if (!add.ok) throw new AidevError(`could not create the kit worktree: ${add.stderr || add.stdout}`);
  }
  fs.mkdirSync(inputDir, { recursive: true });
  for (const r of reflections) {
    r.copy = path.join(inputDir, `${r.pkg.replace(/[^A-Za-z0-9._-]/g, '_')}--${r.session}.md`);
    fs.copyFileSync(r.file, r.copy);
  }

  if (human) {
    ui.heading('npm run evolve -- run');
    ui.info(`${reflections.length} reflection(s) → ${branch} in ${worktree} with ${agentMod.toolLabel(tool)}`);
  }
  const res = await agentMod.runAgent({
    repoRoot: worktree, installRoot, tool, agent: AGENT_NAME, definition,
    prompt: buildPrompt({ branch, worktree, inputDir, reflections, kitCommit }),
    model, timeoutMs, label: 'evolve',
    extraArgv: tool === 'claude' ? ['--allowedTools', CLAUDE_ALLOWED_TOOLS] : [],
    onProgress: human ? ({ elapsedMs }) => ui.dim(`    evolution agent working, ${agentMod.formatDuration(elapsedMs)} elapsed…`) : null,
  });

  // Consumed reflections move aside so the next run starts from new evidence.
  if (res.ok) {
    for (const r of reflections) {
      const done = path.join(path.dirname(r.file), 'done');
      try { fs.mkdirSync(done, { recursive: true }); fs.renameSync(r.file, path.join(done, path.basename(r.file))); } catch { /* keep */ }
    }
  }
  const doc = {
    ok: !!res.ok, branch, worktree, reflections: reflections.length, tool, model,
    result: res.result == null ? null : String(res.result), reason: res.ok ? null : (res.reason || null),
    durationMs: res.durationMs ?? null, costUsd: res.costUsd ?? null,
  };
  if (flags.json) { ui.json(doc); return res.ok ? EXIT.OK : EXIT.GENERAL; }
  if (!res.ok) {
    ui.fail(`the evolution agent ${res.timedOut ? 'ran out of time' : 'failed'}: ${res.reason}`);
    if (res.result) for (const l of String(res.result).split('\n').slice(0, 20)) ui.dim(`    ${l}`);
    ui.dim(`    The worktree is kept for inspection: ${worktree}`);
    return EXIT.GENERAL;
  }
  ui.ok(`evolution agent finished in ${agentMod.formatDuration(res.durationMs)}${res.costUsd != null ? ` ($${Number(res.costUsd).toFixed(4)})` : ''}`);
  if (res.result) { ui.out(''); for (const l of String(res.result).split('\n')) ui.out(`  ${l}`); }
  ui.dim(`    branch ${branch} in ${worktree}. Review the PR; remove the worktree afterwards with`);
  ui.dim(`    "git -C ${installRoot} worktree remove ${worktree}".`);
  return EXIT.OK;
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  if (sub === 'enable') return enable(ctx);
  if (sub === 'disable') return disable(ctx);
  if (sub === 'status') return status(ctx);
  if (sub === 'run') return runEvolve(ctx);
  throw new AidevError(`unknown subcommand: npm run evolve -- ${sub || ''} (expected: enable, disable, status, run)`);
}

module.exports = { run, FLAGS, FLAG_HELP, collectReflections, buildPrompt, REFLECTION_DIR_REL, AGENT_DEF_REL };

// Kit developers run this from a kit checkout: `npm run evolve -- <subcommand>`.
// It is deliberately not an `aidev` command; nothing here exists for package users.
if (require.main === module) {
  const { parseArgs } = require('../cli/lib/args');
  const argv = process.argv.slice(2);
  (async () => {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      ui.out('usage: npm run evolve -- enable|disable|status|run [--auto] [--dry-run] [--json] [--tool <t>] [--model <m>] [--timeout <ms>]');
      return EXIT.OK;
    }
    const { flags, positionals } = parseArgs(argv, FLAGS);
    const installRoot = path.resolve(__dirname, '..');
    const repoRoot = gitMod.findRepoRoot(process.cwd());
    let version = null;
    try { version = require('../package.json').version; } catch { version = null; }
    return run({ installRoot, repoRoot, flags, positionals, version, argv, command: 'evolve' });
  })().then((code) => { process.exitCode = typeof code === 'number' ? code : EXIT.OK; })
    .catch((e) => {
      ui.fail(e instanceof AidevError ? e.message : `internal error: ${e && e.message ? e.message : e}`);
      process.exitCode = e instanceof AidevError && typeof e.code === 'number' ? e.code : EXIT.GENERAL;
    });
}
