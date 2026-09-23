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

/** Aligned columns; every column but the last is padded to its widest cell. */
function table(rows) {
  if (rows.length === 0) return;
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (v) => (v == null ? '-' : String(v));
  const widths = [];
  for (let c = 0; c < cols - 1; c++) widths.push(Math.max(...rows.map((r) => cell(r[c]).length)));
  for (const r of rows) {
    const cells = [];
    for (let c = 0; c < cols; c++) cells.push(c < cols - 1 ? cell(r[c]).padEnd(widths[c]) : cell(r[c]));
    out(`  ${cells.join('  ').trimEnd()}`);
  }
}

module.exports = { out, err, ok, warn, fail, info, dim, heading, json, table, C };
