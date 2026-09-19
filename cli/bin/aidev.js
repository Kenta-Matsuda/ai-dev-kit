#!/usr/bin/env node
'use strict';
/**
 * `aidev` — the single entry point every Skill, hook and pipeline invokes.
 *
 * Responsibilities, deliberately few:
 *   - locate the wrapper repository root
 *   - route one- and two-word commands to cli/commands/<name>.js
 *   - parse argv against that command's own FLAGS declaration
 *   - translate a thrown AidevError into its documented exit code
 *
 * Everything else belongs in the command modules. The exit-code contract is
 * public — CI and the PreToolUse hook branch on it — so it is honoured here and
 * nowhere else:
 *
 *   0 success   1 general   2 drift   3 permission   4 Wiki consistency
 */

const path = require('path');
const fs = require('fs');
const { parseArgs } = require('../lib/args');
const { EXIT, AidevError } = require('../lib/errors');
const gitMod = require('../lib/git');
const ui = require('../lib/ui');

const COMMANDS = [
  'init', 'update', 'check', 'doctor', 'plan', 'sync',
  'knowledge', 'permission', 'task', 'workflow', 'hook', 'mcp', 'eject',
];

/** Subcommands are routed inside the command module, but listed here for help. */
const SUBCOMMANDS = {
  knowledge: ['build', 'status'],
  permission: ['configure', 'reconfigure', 'show'],
  task: ['list', 'show', 'resume', 'advance', 'abandon'],
  workflow: ['new', 'approve', 'run', 'list'],
  hook: ['session-start', 'guard-write', 'quality-gate', 'session-stop'],
  mcp: ['azure-devops'],
};

const VERSION = readVersion();

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch { return '0.0.0'; }
}

function loadCommand(name) {
  if (!COMMANDS.includes(name)) return null;
  // Resolved from the fixed command directory, never from user input joined to
  // an arbitrary path — `name` is already constrained to the list above.
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
  const rows = [];
  for (const name of COMMANDS) {
    let mod = null;
    try { mod = loadCommand(name); } catch { mod = null; }
    const subs = SUBCOMMANDS[name];
    rows.push([
      `${name}${subs ? ` <${subs.join('|')}>` : ''}`,
      mod ? (mod.summary || '') : '(not implemented)',
    ]);
  }
  ui.table(rows);
  ui.out('');
  ui.out('  common options:');
  ui.table([
    ['--json', 'machine-readable output (the only thing written to stdout)'],
    ['--dry-run', 'show what would change; write nothing'],
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
  const flags = Object.entries(mod.FLAGS || {});
  if (flags.length > 0) {
    ui.out('\n  options:');
    ui.table(flags.map(([f, t]) => [`--${f}`, t === 'string' ? '<value>' : 'flag']));
  }
  ui.out('');
}

async function main(argv) {
  // --version / --help before anything that could fail on a broken repo.
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
    const near = COMMANDS.filter((c) => c.startsWith(name[0]));
    throw new AidevError(
      `unknown command: ${name}${near.length ? ` (did you mean: ${near.join(', ')}?)` : ''}\n` +
      '    Run "aidev --help" for the full list.');
  }

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) { commandHelp(name, mod); return EXIT.OK; }

  const { flags, positionals } = parseArgs(rest, mod.FLAGS || {});

  // A two-word command validates its own subcommand, but catching an empty one
  // here produces a listing instead of a bare parse error.
  if (SUBCOMMANDS[name] && positionals.length === 0) {
    throw new AidevError(
      `aidev ${name} requires a subcommand: ${SUBCOMMANDS[name].join(', ')}`);
  }

  const repoRoot = gitMod.findRepoRoot(process.cwd());
  const ctx = { repoRoot, flags, positionals, argv: rest, command: name };

  // init exports an async run; the rest are synchronous. Awaiting covers both.
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
    // An unexpected error is a bug in the kit: show the stack, exit 1.
    ui.fail(`internal error: ${e && e.message ? e.message : String(e)}`);
    if (e && e.stack && process.env.AIDEV_DEBUG) ui.err(e.stack);
    else ui.err('    Set AIDEV_DEBUG=1 for a stack trace.');
    process.exitCode = EXIT.GENERAL;
  });
