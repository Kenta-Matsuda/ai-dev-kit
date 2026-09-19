'use strict';
/** Console output helpers: consistent, colour-optional, stderr for diagnostics. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const C = {
  reset: useColor ? '\x1b[0m' : '',
  dim: useColor ? '\x1b[2m' : '',
  red: useColor ? '\x1b[31m' : '',
  green: useColor ? '\x1b[32m' : '',
  yellow: useColor ? '\x1b[33m' : '',
  cyan: useColor ? '\x1b[36m' : '',
  bold: useColor ? '\x1b[1m' : '',
};

function out(s = '') { process.stdout.write(`${s}\n`); }
function err(s = '') { process.stderr.write(`${s}\n`); }

function ok(s) { out(`${C.green}✓${C.reset} ${s}`); }
function warn(s) { out(`${C.yellow}⚠${C.reset} ${s}`); }
function fail(s) { err(`${C.red}✗${C.reset} ${s}`); }
function info(s) { out(`${C.cyan}ℹ${C.reset} ${s}`); }
function dim(s) { out(`${C.dim}${s}${C.reset}`); }
function heading(s) { out(`\n${C.bold}${s}${C.reset}`); }

function json(value) { out(JSON.stringify(value, null, 2)); }

/** Render a two-column table without depending on a formatting library. */
function table(rows) {
  if (rows.length === 0) return;
  const w = Math.max(...rows.map((r) => String(r[0]).length));
  for (const [k, v] of rows) out(`  ${String(k).padEnd(w)}  ${v == null ? '-' : v}`);
}

module.exports = { out, err, ok, warn, fail, info, dim, heading, json, table, C };
