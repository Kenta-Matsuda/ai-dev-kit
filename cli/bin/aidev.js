#!/usr/bin/env node
'use strict';
/**
 * `aidev` entry point.
 *
 * Commands are routed by name to `cli/commands/<name>.js`. Each module exports
 * `run(ctx)`, `FLAGS` (its accepted options) and `summary`. Flags are parsed
 * per command so an unknown flag is an error, never silently ignored.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { EXIT, AidevError } = require('../lib/errors');
const { parseArgs } = require('../lib/args');
const gitMod = require('../lib/git');
const home = require('../lib/home');
const ui = require('../lib/ui');

/**
 * Verb first: `aidev <verb> [<object>] [<name>]`. The objects are workflow,
 * agent, skill, wiki, kit and policy; a verb that takes one object only
 * still names it, so every command reads the same way.
 */
const COMMANDS = [
  'init', 'check', 'doctor',
  'create', 'remove', 'list', 'submit', 'run',
  'update', 'sync', 'uninstall',
  'hook',
];

/** Objects are routed inside the command module, but listed here for help. */
const SUBCOMMANDS = {
  create: ['workflow', 'agent', 'skill', 'policy'],
  remove: ['workflow', 'agent', 'skill'],
  list: ['workflows', 'agents', 'skills', 'packages'],
  submit: ['workflow'],
  run: ['workflow'],
  sync: ['tools', 'wiki'],
  hook: ['session-start', 'guard-write', 'quality-gate', 'after-bash', 'session-stop'],
};

/**
 * No update notice: the AI tools call `hook` and read its output, and `update`
 * is the updater itself. Every other invocation — help and --version included —
 * says when a newer kit exists.
 */
const QUIET_COMMANDS = new Set(['hook', 'update']);

/** Say the notice, but do not offer to update before these. */
const NO_OFFER_COMMANDS = new Set(['uninstall']);

/**
 * Commands that act on one package: `--package <name|path>` (`-p`) points them
 * at a registered package or a clone elsewhere instead of the current
 * directory. `update` acts on the machine only; `hook` follows the tool.
 */
const PACKAGE_COMMANDS = new Set(['init', 'check', 'doctor', 'create', 'remove', 'list', 'submit', 'run', 'sync', 'uninstall']);

/** Internal entry points (the AI tools' hooks call them); routable, not advertised. */
const HIDDEN_COMMANDS = new Set(['hook']);

const INSTALL_ROOT = path.resolve(__dirname, '..', '..');
const VERSION = readVersion();

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function loadCommand(name) {
  if (!COMMANDS.includes(name)) return null;
  try {
    return require(path.join(__dirname, '..', 'commands', `${name}.js`));
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`${name}.js`)) return null;
    throw e;
  }
}

function usage() {
  ui.out(`aidev ${VERSION} — ai-dev-kit CLI`);
  ui.out('');
  ui.out('  usage: aidev <command> [subcommand] [options]');
  ui.out('');
  const groups = [
    ['develop (in a package clone)', ['run', 'create', 'submit', 'list', 'remove']],
    ['maintain (in a package clone)', ['init', 'check', 'sync']],
    ['this machine', ['update', 'doctor', 'uninstall']],
  ];
  for (const [title, names] of groups) {
    ui.out(`  ${title}:`);
    const rows = [];
    for (const name of names) {
      let mod = null;
      try { mod = loadCommand(name); } catch { mod = null; }
      const subs = SUBCOMMANDS[name];
      rows.push([`  ${name}${subs ? ` <${subs.join('|')}>` : ''}`, mod ? (mod.summary || '') : '(not implemented)']);
    }
    ui.table(rows);
    ui.out('');
  }
  ui.out('  common options:');
  ui.table([
    ['--json', 'machine-readable output (the only thing written to stdout)'],
    ['--dry-run', 'show what would change; write nothing'],
    ['--package, -p <name|path>', 'act on this package instead of the current clone ("aidev list packages")'],
    ['--help, -h', 'this message, or a command\'s options'],
    ['--version, -V', 'print the kit version'],
  ]);
  ui.out('');
  ui.out('  exit codes: 0 ok · 1 error · 2 drift · 3 permission · 4 wiki inconsistent');
  ui.out('');
}

function commandHelp(name, mod) {
  ui.out(`aidev ${name} — ${mod.summary || ''}`);
  const subs = SUBCOMMANDS[name];
  if (subs) ui.out(`\n  subcommands: ${subs.join(', ')}`);
  if (PACKAGE_COMMANDS.has(name)) {
    ui.out('\n  package:');
    ui.table([['--package, -p <name|path>', 'act on this package instead of the current clone ("aidev list packages")']]);
  }
  const help = mod.FLAG_HELP || {};
  // A flag documented as hidden is accepted for compatibility but not shown.
  const flags = Object.entries(mod.FLAGS || {}).filter(([f]) => help[f] !== false);
  if (flags.length > 0) {
    ui.out('\n  options:');
    ui.table(flags.map(([f, t]) => [
      `--${f}${t === 'string' ? ' <value>' : ''}`,
      typeof help[f] === 'string' ? help[f] : (t === 'string' ? '<value>' : 'flag'),
    ]));
  }
  ui.out('');
}

/**
 * Tell the user a newer kit exists. Bounded and cached (see
 * home.checkForUpdate), never fatal, and written to stderr so `--json` output
 * stays clean. Returns the check result, or null when there is nothing to say.
 */
function updateNotice(argv) {
  if (QUIET_COMMANDS.has(argv[0]) || process.env.AIDEV_NO_UPDATE_CHECK) return null;
  let info = null;
  try { info = home.checkForUpdate(INSTALL_ROOT); } catch { info = null; }
  if (!info || !info.newer) return null;
  const { C } = ui;
  ui.err(`${C.yellow}⚠${C.reset} a newer ai-dev-kit is available (${info.localSha.slice(0, 7)} → ${String(info.remoteSha).slice(0, 7)}). Run "aidev update".`);
  return info;
}

/**
 * In a terminal, offer to update before running the command.
 *
 * Returns null to carry on with this process, or the exit code of the
 * updated CLI when the user chose to update and the command was re-run
 * with the new code (so "update first, then run" means exactly that).
 */
async function offerUpdate(name, flags, argv) {
  if (NO_OFFER_COMMANDS.has(name) || flags.json) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('  Update now, before running this command? (y/N): ', (a) => resolve(a.trim())));
  rl.close();
  if (!/^y(es)?$/i.test(answer)) return null;
  const before = safeHead();
  const upd = loadCommand('update');
  await upd.run({ installRoot: INSTALL_ROOT, repoRoot: null, flags: {}, positionals: [], version: VERSION });
  if (safeHead() === before) {
    ui.dim('  (the kit did not change; continuing with the current CLI.)');
    return null;
  }
  ui.dim(`  (re-running "aidev ${argv.join(' ')}" with the updated CLI.`);
  ui.dim('   New templates reach a package only through "aidev sync tools", when you choose to run it.)');
  const r = spawnSync(process.execPath, [__filename, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, AIDEV_NO_UPDATE_CHECK: '1' },
  });
  return typeof r.status === 'number' ? r.status : EXIT.GENERAL;
}

/**
 * Take `--package <ref>` / `--package=<ref>` / `-p <ref>` out of the command's
 * arguments, so every command accepts it without declaring it.
 */
function takePackageOption(args) {
  let ref = null;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i)); break; }
    let value;
    if (a === '--package' || a === '-p') {
      value = args[++i];
      if (value == null || value === '') throw new AidevError(`option ${a} requires a package name or path`);
    } else if (a.startsWith('--package=')) {
      value = a.slice('--package='.length);
      if (!value) throw new AidevError('option --package requires a package name or path');
    } else { rest.push(a); continue; }
    if (ref != null) throw new AidevError('pass --package once');
    ref = value;
  }
  return { ref, rest };
}

function safeHead() {
  try { return gitMod.headSha(INSTALL_ROOT); } catch { return null; }
}

async function main(argv) {
  const update = updateNotice(argv);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    usage();
    return EXIT.OK;
  }
  if (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version') {
    ui.out(VERSION);
    return EXIT.OK;
  }

  const name = argv[0];
  if (name.startsWith('-')) throw new AidevError(`unknown option: ${name} (run "aidev --help")`);

  const mod = loadCommand(name);
  if (!mod) {
    const near = COMMANDS.filter((c) => c.startsWith(name[0]) && !HIDDEN_COMMANDS.has(c));
    throw new AidevError(
      `unknown command: ${name}${near.length ? ` (did you mean: ${near.join(', ')}?)` : ''}\n` +
      '    Run "aidev --help" for the full list.');
  }

  if (argv.slice(1).includes('--help') || argv.slice(1).includes('-h')) { commandHelp(name, mod); return EXIT.OK; }

  const { ref: packageRef, rest } = takePackageOption(argv.slice(1));
  if (packageRef != null && !PACKAGE_COMMANDS.has(name)) {
    throw new AidevError(`aidev ${name} does not take --package (it does not act on a package)`);
  }

  const { flags, positionals } = parseArgs(rest, mod.FLAGS || {});
  if (SUBCOMMANDS[name] && positionals.length === 0) {
    throw new AidevError(`aidev ${name} needs an object: ${SUBCOMMANDS[name].join(', ')}`);
  }
  if (SUBCOMMANDS[name] && !SUBCOMMANDS[name].includes(positionals[0])) {
    throw new AidevError(`aidev ${name} ${positionals[0]}: expected one of ${SUBCOMMANDS[name].join(', ')}`);
  }

  // Hooks may fire while the tool's current directory is a nested folder.
  // Claude Code supplies the project root explicitly; start discovery there.
  let repoRoot;
  if (packageRef != null) {
    const dir = home.resolvePackage(packageRef);
    repoRoot = gitMod.findRepoRoot(dir) || dir;
  } else {
    const start = name === 'hook' && process.env.CLAUDE_PROJECT_DIR
      ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
      : process.cwd();
    repoRoot = gitMod.findRepoRoot(start);
  }

  if (update) {
    const reran = await offerUpdate(name, flags, argv);
    if (reran !== null) return reran;
  }

  const ctx = { installRoot: INSTALL_ROOT, version: VERSION, repoRoot, packageRef, flags, positionals, argv: rest, command: name };
  const code = await mod.run(ctx);
  return typeof code === 'number' ? code : EXIT.OK;
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    if (e instanceof AidevError) {
      ui.fail(e.message);
      process.exitCode = typeof e.code === 'number' ? e.code : EXIT.GENERAL;
      return;
    }
    ui.fail(`internal error: ${e && e.message ? e.message : String(e)}`);
    if (e && e.stack && process.env.AIDEV_DEBUG) ui.err(e.stack);
    else ui.err('    Set AIDEV_DEBUG=1 for a stack trace.');
    process.exitCode = EXIT.GENERAL;
  });
