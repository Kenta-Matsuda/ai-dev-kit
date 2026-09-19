'use strict';
/**
 * Argument parsing.
 *
 * Deliberately small: flags are declared per-command so an unknown flag is an
 * error rather than being silently ignored — a typo in `--dry-run` must never
 * turn a preview into a real mutation.
 */

const { AidevError } = require('./errors');

/**
 * @param {string[]} argv       raw args after the command path
 * @param {object} spec         { flagName: 'boolean'|'string' }
 * @returns {{ flags: object, positionals: string[] }}
 */
function parseArgs(argv, spec = {}) {
  const flags = {};
  const positionals = [];
  const known = new Map();
  for (const [name, type] of Object.entries(spec)) known.set(name, type);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }

    let name = arg.replace(/^--?/, '');
    let inlineValue = null;
    const eq = name.indexOf('=');
    if (eq !== -1) { inlineValue = name.slice(eq + 1); name = name.slice(0, eq); }

    if (!known.has(name)) {
      throw new AidevError(`unknown option: ${arg}`);
    }
    const type = known.get(name);
    if (type === 'boolean') {
      if (inlineValue != null) {
        if (inlineValue !== 'true' && inlineValue !== 'false') {
          throw new AidevError(`option --${name} is a flag and takes no value`);
        }
        flags[name] = inlineValue === 'true';
      } else flags[name] = true;
    } else {
      const v = inlineValue != null ? inlineValue : argv[++i];
      if (v == null) throw new AidevError(`option --${name} requires a value`);
      flags[name] = v;
    }
  }
  return { flags, positionals };
}

module.exports = { parseArgs };
