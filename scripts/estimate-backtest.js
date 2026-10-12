'use strict';
/**
 * `npm run estimate:backtest -- <dir>... [--json]` — how good the estimate
 * method in cli/lib/estimate.js is, measured on real runs.
 *
 * Each <dir> is a package clone (its `.aidev/estimates/records/`) or a
 * directory of record files. Within a package the records are replayed in
 * the order the runs started: each run is estimated again by today's code
 * from the records before it only, with the sizes and kinds its own estimate
 * used, and compared with what its steps cost. The numbers:
 *
 *   coverage     — share of finished agent steps whose cost fell inside the
 *                  range (the method aims at TARGET_COVERAGE, 80%)
 *   width        — median of high / low (narrower is more useful)
 *   log error    — median |ln(actual / geometric middle of the range)|
 *
 * The evolution agent (`npm run evolve -- estimates`) runs this before and
 * after a change to the method; a change is kept only when it gets closer to
 * the target coverage without a wider range, or narrower at the same coverage.
 * It reads records only; it starts no agent and writes nothing.
 */

const fs = require('fs');
const path = require('path');
const estimateMod = require('../cli/lib/estimate');
const ui = require('../cli/lib/ui');

/** The records under a directory: a package's records directory, or the directory itself. */
function recordsIn(dir) {
  const pkgDir = path.join(dir, ...estimateMod.RECORDS_REL.split('/'));
  const where = fs.existsSync(pkgDir) ? pkgDir : dir;
  let names = [];
  try { names = fs.readdirSync(where).filter((n) => n.endsWith('.json')); } catch { names = []; }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(where, n), 'utf8'));
      if (r && r.schemaVersion === 1 && r.workflow && r.runId) out.push(r);
    } catch { /* not a record */ }
  }
  return out.sort((a, b) => String(a.startedAt || a.runId).localeCompare(String(b.startedAt || b.runId)));
}

/** History as collectHistory builds it, from records alone. */
function historyOf(records) {
  const calls = [];
  for (const r of records) {
    for (const c of r.calls || []) {
      const cost = Number(c && c.costUsd);
      if (!c || c.costUsd == null || !Number.isFinite(cost) || cost < 0) continue;
      calls.push({ workflow: r.workflow, runId: r.runId, step: String(c.step || ''), role: c.role === 'until' ? 'until' : 'agent', agent: String(c.agent || ''), model: c.actualModel || c.model || null, costUsd: cost });
    }
  }
  return { calls, runs: records.map((r) => ({ workflow: r.workflow, runId: r.runId, steps: r.steps || [] })), records };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Replay one package's records. Returns the pairs { workflow, runId, step,
 * lo, hi, actual } today's code would have produced.
 */
function replay(records) {
  const pairs = [];
  records.forEach((r, i) => {
    const steps = ((r.estimate && r.estimate.steps) || []).filter((s) => s && s.id && s.maxAttempts);
    if (!steps.length) return;
    const shapes = steps.map((s) => ({
      id: s.id, kind: 'agent', agent: s.agent, checker: s.checker || null, maxAttempts: s.maxAttempts,
      maxItems: s.maxItems || null, model: s.model || null, checkerModel: s.checkerModel || null,
    }));
    const ai = { steps: steps.map((s) => ({ id: s.id, size: s.size, checkSize: s.checkSize, kind: s.kind })) };
    const est = estimateMod.estimateShapes(r.workflow, shapes, { history: historyOf(records.slice(0, i)), ai, budget: Infinity, reportsCost: false });
    for (const s of r.steps || []) {
      const p = est.steps.find((x) => x.id === s.id);
      if (!p || !s.ok || s.costUsd == null || !(Number(s.starts) > 0)) continue;
      pairs.push({ workflow: r.workflow, runId: r.runId, step: s.id, lo: p.usd[0], hi: p.usd[1], actual: Number(s.costUsd) });
    }
  });
  return pairs;
}

function score(pairs) {
  const inside = pairs.filter((p) => p.actual >= p.lo - 1e-9 && p.actual <= p.hi + 1e-9).length;
  return {
    pairs: pairs.length,
    coverage: pairs.length ? inside / pairs.length : null,
    width: median(pairs.filter((p) => p.lo > 0).map((p) => p.hi / p.lo)),
    logError: median(pairs.filter((p) => p.lo > 0 && p.actual > 0).map((p) => Math.abs(Math.log(p.actual / Math.sqrt(p.lo * p.hi))))),
    target: estimateMod.TARGET_COVERAGE,
  };
}

/** Backtest several sources (each one package); the replay never mixes packages. */
function backtest(dirs) {
  const packages = dirs.map((d) => {
    const records = recordsIn(d);
    const pairs = replay(records);
    return { dir: d, records: records.length, ...score(pairs), pairList: pairs };
  });
  const all = packages.flatMap((p) => p.pairList);
  return { ...score(all), packages: packages.map(({ pairList, ...p }) => p) };
}

const pct = (x) => (x == null ? '-' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? '-' : x.toFixed(2));

function main(argv) {
  const json = argv.includes('--json');
  const dirs = argv.filter((a) => !a.startsWith('--'));
  if (!dirs.length) {
    ui.out('usage: npm run estimate:backtest -- <package clone or records directory>... [--json]');
    return 1;
  }
  const r = backtest(dirs.map((d) => path.resolve(d)));
  if (json) { ui.json(r); return 0; }
  ui.heading('estimate backtest');
  ui.table([
    ['steps', String(r.pairs)],
    ['coverage', `${pct(r.coverage)} inside their range (target ${pct(r.target)})`],
    ['width', `median high/low ${num(r.width)}`],
    ['log error', `median |ln(actual / middle)| ${num(r.logError)}`],
  ]);
  ui.out('');
  ui.table([['source', 'records', 'steps', 'coverage', 'width'], ...r.packages.map((p) => [p.dir, String(p.records), String(p.pairs), pct(p.coverage), num(p.width)])]);
  return 0;
}

module.exports = { recordsIn, historyOf, replay, score, backtest };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
