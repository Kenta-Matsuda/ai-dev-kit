'use strict';
/**
 * What a workflow run is likely to cost, before it runs — and how that guess
 * gets better with every run.
 *
 * A run's cost is the sum of its agent starts, so the estimate is two
 * questions per agent step:
 *
 *   how many starts   — from the definition: one per attempt (two when an
 *                       `until.agent` checks it), times the targets of a
 *                       `for_each`. Optimistic: every check passes first time,
 *                       fewest targets. Pessimistic: every retry is used, most
 *                       targets. An estimator agent (`aidev estimate --ai`) can
 *                       narrow the attempts and the target count for this task.
 *   what one start costs — in this order: the same step's recorded starts; the
 *                       same agent's anywhere in the PKG; a prior the
 *                       estimate reviewer wrote for this agent or this kind of
 *                       work; what starts of this size class cost in this PKG;
 *                       the kit's default for the size class.
 *
 * Every price is converted between models (an Opus start costs about twice a
 * Sonnet start), so history from one model still informs another.
 *
 * Learning, in three layers:
 *
 *   1. calibration (every run, no AI) — each run writes a record of what was
 *      estimated and what it cost to `.aidev/estimates/records/`, committed
 *      with the run's pull request. The records set the size classes' prices
 *      for this PKG and how much the ranges are widened so that about 80% of
 *      past runs fall inside them.
 *   2. review (automatic, AI) — after enough runs land outside their range,
 *      the estimate-reviewer agent reads the records and writes priors (the
 *      price of one start of an agent or of a kind of work) and notes, which
 *      the CLI keeps in `.aidev/estimates/priors.json` and `notes.md`.
 *   3. the method itself (kit developers) — `npm run evolve -- estimates`
 *      replays the records of the PKGs on a kit developer's machine against
 *      this file (`npm run estimate:backtest`) and lets the evolution agent
 *      change it when the replay gets better.
 *
 * The pessimistic total is capped where the runner stops: it starts no agent
 * once the reported cost reaches limits.max_usd, so a run can pass the budget by
 * at most the cost of its last start.
 */

const fs = require('fs');
const path = require('path');
const layout = require('./layout');
const cfgMod = require('./config');
const wfMod = require('./workflow');

/** Cost of one agent start (USD, on the reference model) per size class, when this PKG has no history yet. */
const SIZE_USD = Object.freeze({
  S: [0.05, 0.3],
  M: [0.3, 1.0],
  L: [1.0, 3.0],
  XL: [3.0, 8.0],
});
const SIZES = Object.keys(SIZE_USD);

/** The kinds of work a step does; priors can be written for a kind, so they carry over to new agents. */
const KINDS = Object.freeze(['survey', 'plan', 'implement', 'write-tests', 'fix', 'migrate', 'review', 'docs', 'other']);

/**
 * Input price per million tokens, by model name (cached 2026-10-06). Output,
 * cache write and cache read keep the same ratio to input across these
 * models, so the input price alone converts a cost between two models. An
 * alias (`opus`, `sonnet`, `haiku`) means the current generation. Prices are
 * the kit's to keep current; a model not listed converts at 1:1.
 */
const MODEL_PRICES = Object.freeze([
  [/fable|mythos/, 10],
  [/opus-5-5|^opus$/, 4],
  [/opus/, 5],
  [/sonnet-4/, 3],
  [/sonnet/, 2],
  [/haiku-4/, 1],
  [/haiku/, 0.1],
]);
/** The model the size classes and priors are kept in. */
const REFERENCE_MODEL = 'sonnet';

/** Below this many recorded starts the observed range is widened (a few samples miss the tails). */
const FEW_SAMPLES = 3;
/** The share of past runs the range should hold. */
const TARGET_COVERAGE = 0.8;
/** Widening factors tried, smallest first. */
const WIDEN_STEPS = Object.freeze([1, 1.25, 1.5, 2, 3, 4]);
/** Recorded estimate/actual pairs needed before the widening is learned. */
const MIN_PAIRS = 5;
/** Steps outside their range, since the last review, that start the estimate reviewer. */
const REVIEW_AFTER_MISSES = 3;

const RECORDS_REL = `${layout.ESTIMATES_REL}/records`;
const PRIORS_REL = `${layout.ESTIMATES_REL}/priors.json`;
const NOTES_REL = `${layout.ESTIMATES_REL}/notes.md`;
const JUDGMENTS_REL = `${layout.ESTIMATES_REL}/judgments`;

const round = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;

// --------------------------------------------------------------- model prices

function priceOf(model) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  for (const [re, usd] of MODEL_PRICES) if (re.test(m)) return usd;
  return null;
}

/** What a cost on `from` would be on `to` (1 when either is unknown). */
function modelFactor(from, to) {
  const a = priceOf(from);
  const b = priceOf(to);
  return a && b ? b / a : 1;
}

/** The model a recorded start ran on: what the tool reported, else what was asked for. */
function callModel(c) { return (c && (c.actualModel || c.model)) || null; }

// -------------------------------------------------------------------- history

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The records committed in `.aidev/estimates/records/`, oldest first. */
function readRecords(repoRoot) {
  const dir = layout.abs(repoRoot, RECORDS_REL);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { names = []; }
  return names.map((n) => readJson(path.join(dir, n)))
    .filter((r) => r && r.schemaVersion === 1 && r.workflow && r.runId)
    .sort((a, b) => String(a.startedAt || a.runId).localeCompare(String(b.startedAt || b.runId)));
}

/**
 * Everything the estimate learns from: the team's committed records, plus
 * this machine's run directories that have no record yet.
 * Returns { calls: [{workflow, runId, step, role, agent, model, costUsd}],
 *           runs: [{workflow, runId, steps}], records }.
 */
function collectHistory(repoRoot) {
  const records = readRecords(repoRoot);
  const seen = new Set(records.map((r) => `${r.workflow}/${r.runId}`));
  const sources = records.map((r) => ({ workflow: r.workflow, runId: r.runId, steps: r.steps, calls: r.calls }));
  for (const name of wfMod.listWorkflows(repoRoot)) {
    let ids = [];
    try { ids = fs.readdirSync(wfMod.runsDir(repoRoot, name)).filter((d) => wfMod.RUN_ID_RE.test(d)); } catch { ids = []; }
    for (const id of ids) {
      if (seen.has(`${name}/${id}`)) continue;
      const rec = readJson(path.join(wfMod.runsDir(repoRoot, name), id, 'run.json'));
      if (rec) sources.push({ workflow: name, runId: id, steps: rec.steps, calls: rec.calls });
    }
  }
  const calls = [];
  const runs = [];
  for (const s of sources) {
    runs.push({ workflow: s.workflow, runId: s.runId, steps: Array.isArray(s.steps) ? s.steps : [] });
    for (const c of Array.isArray(s.calls) ? s.calls : []) {
      const cost = Number(c && c.costUsd);
      if (!c || c.costUsd == null || !Number.isFinite(cost) || cost < 0) continue;
      calls.push({
        workflow: s.workflow, runId: s.runId, step: String(c.step || ''), role: c.role === 'until' ? 'until' : 'agent',
        agent: String(c.agent || ''), model: callModel(c), costUsd: cost,
      });
    }
  }
  return { calls, runs, records };
}

/** `p` quantile of sorted numbers (linear between neighbours). */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/** [low, high] of a list of costs: the 10th–90th percentile, widened when there are few. */
function observedRange(costs) {
  const xs = [...costs].sort((a, b) => a - b);
  if (xs.length < FEW_SAMPLES) return [xs[0] * 0.5, xs[xs.length - 1] * 2];
  if (xs.length < 10) return [xs[0], xs[xs.length - 1]];
  return [quantile(xs, 0.1), quantile(xs, 0.9)];
}

// ---------------------------------------------------------------- calibration

/**
 * One pair per agent step a record both estimated and finished:
 * { workflow, step, lo, hi, actual, size, basis }.
 */
function estimatePairs(records) {
  const pairs = [];
  for (const r of records) {
    const predicted = new Map(((r.estimate && r.estimate.steps) || []).map((s) => [s.id, s]));
    for (const s of Array.isArray(r.steps) ? r.steps : []) {
      const p = predicted.get(s.id);
      if (!p || !Array.isArray(p.usd) || !s.ok || s.costUsd == null) continue;
      // A step that had no agent start (resumed past it) teaches nothing.
      if (!(Number(s.starts) > 0)) continue;
      pairs.push({ workflow: r.workflow, runId: r.runId, step: s.id, agent: p.agent || null, lo: p.usd[0], hi: p.usd[1], actual: Number(s.costUsd), size: p.size || null, basis: p.basis || null });
    }
  }
  return pairs;
}

const inside = (pair, k = 1) => pair.actual >= pair.lo / k - 1e-9 && pair.actual <= pair.hi * k + 1e-9;

/**
 * What the records teach without any AI:
 *   widen  — the smallest factor that puts TARGET_COVERAGE of past steps
 *            inside their range (1 until there are MIN_PAIRS pairs);
 *   sizes  — per size class, the reference-model price of one start in this
 *            PKG, from the starts of the steps estimated at that size.
 */
function calibrate(history) {
  const pairs = estimatePairs(history.records || []);
  const hits = pairs.filter((p) => inside(p)).length;
  let widen = 1;
  if (pairs.length >= MIN_PAIRS) {
    widen = WIDEN_STEPS[WIDEN_STEPS.length - 1];
    for (const k of WIDEN_STEPS) {
      if (pairs.filter((p) => inside(p, k)).length / pairs.length >= TARGET_COVERAGE) { widen = k; break; }
    }
  }
  // The size each recorded step (and its checker) was estimated at.
  const sizeOf = new Map();
  for (const r of history.records || []) {
    for (const s of (r.estimate && r.estimate.steps) || []) {
      if (s.size) sizeOf.set(`${r.workflow}/${r.runId}/${s.id}/agent`, s.size);
      if (s.checkSize) sizeOf.set(`${r.workflow}/${r.runId}/${s.id}/until`, s.checkSize);
    }
  }
  const bySize = {};
  for (const c of history.calls) {
    const size = sizeOf.get(`${c.workflow}/${c.runId}/${c.step}/${c.role}`);
    if (!size) continue;
    (bySize[size] = bySize[size] || []).push(c.costUsd * modelFactor(c.model, REFERENCE_MODEL));
  }
  const sizes = {};
  for (const [size, costs] of Object.entries(bySize)) {
    if (costs.length >= FEW_SAMPLES) sizes[size] = { range: observedRange(costs), n: costs.length };
  }
  return {
    pairs: pairs.length, inside: hits, coverage: pairs.length ? hits / pairs.length : null,
    widen, sizes, misses: pairs.filter((p) => !inside(p)),
  };
}

// --------------------------------------------------------------------- priors

/**
 * The priors the estimate reviewer wrote: { reviewedAt, reviewedThrough,
 * priors: [{agent?|kind?, role, perStart: [lo, hi] (reference model), why}] }.
 */
function readPriors(repoRoot) {
  const v = readJson(layout.abs(repoRoot, PRIORS_REL));
  if (!v || v.schemaVersion !== 1 || !Array.isArray(v.priors)) return { reviewedAt: null, priors: [] };
  return v;
}

function readNotes(repoRoot) { return cfgMod.readTextIfExists(layout.abs(repoRoot, NOTES_REL)); }

function findPrior(priors, { agent, kind, role }) {
  const list = (priors && priors.priors) || [];
  return list.find((p) => p.agent && p.agent === agent && p.role === role)
    || (kind ? list.find((p) => !p.agent && p.kind === kind && p.role === role) : null)
    || null;
}

/** The estimator's last judgment of a workflow, kept while the definition is unchanged. */
function readJudgment(repoRoot, name, hash) {
  const v = readJson(layout.abs(repoRoot, `${JUDGMENTS_REL}/${name}.json`));
  return v && v.hash === hash && Array.isArray(v.steps) ? v : null;
}

// ------------------------------------------------------------------- estimate

/**
 * The cost of one start of `agent` in the role `role` of step `stepId`, on
 * `model`: { range: [low, high], basis }.
 */
function perStartCost(history, { workflow, stepId, role, agent, size, kind = null, model = null, calibration = null, priors = null }) {
  const onModel = (cs) => cs.map((c) => c.costUsd * modelFactor(c.model, model));
  const own = history.calls.filter((c) => c.workflow === workflow && c.step === stepId && c.role === role);
  if (own.length) return { range: observedRange(onModel(own)), basis: `history of this step (${own.length})` };
  const same = history.calls.filter((c) => c.agent === agent && c.role === role);
  if (same.length) return { range: observedRange(onModel(same)), basis: `history of agent ${agent} (${same.length})` };
  const factor = modelFactor(REFERENCE_MODEL, model);
  const prior = findPrior(priors, { agent, kind, role });
  if (prior) return { range: prior.perStart.map((x) => x * factor), basis: prior.agent ? `review of agent ${agent}` : `review of ${kind} work` };
  const learned = calibration && calibration.sizes[size];
  if (learned) return { range: learned.range.map((x) => x * factor), basis: `size ${size} in this package (${learned.n})` };
  return { range: SIZE_USD[size].map((x) => x * factor), basis: `size ${size}` };
}

/** The target counts earlier runs of this step saw: { low, high } or null. */
function observedItems(history, workflow, stepId) {
  const counts = [];
  for (const r of history.runs) {
    if (r.workflow !== workflow) continue;
    const s = r.steps.find((x) => x && x.id === stepId);
    const n = s ? (Array.isArray(s.items) ? s.items.length : Number(s.items)) : 0;
    if (n > 0) counts.push(n);
  }
  return counts.length ? { low: Math.min(...counts), high: Math.max(...counts), n: counts.length } : null;
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * What the estimate needs of each agent step, and nothing else — the
 * definition's steps, or a record's (for the replay of `npm run estimate:backtest`).
 */
function stepShapes(def, models = {}) {
  return def.steps.map((s) => (s.kind !== 'agent' ? { id: s.id, kind: s.kind } : {
    id: s.id, kind: 'agent', agent: s.agent, checker: s.until && s.until.agent ? s.until.agent : null,
    maxAttempts: s.max_retries + 1, maxItems: s.for_each ? s.for_each.max_items : null,
    model: models[s.agent] == null ? null : models[s.agent],
    checkerModel: s.until && s.until.agent && models[s.until.agent] != null ? models[s.until.agent] : null,
  }));
}

/**
 * Estimate a list of step shapes. `ai` is an estimator answer (parseAiAnswer)
 * or a kept judgment, or null; `budget` is limits.max_usd; `reportsCost` is
 * false when the tool reports no cost (then the budget cannot stop the run).
 */
function estimateShapes(name, shapes, { history, ai = null, budget, reportsCost = true, calibration = null, priors = null }) {
  const cal = calibration || calibrate(history);
  const byId = new Map(((ai && ai.steps) || []).map((s) => [s.id, s]));
  const k = cal.widen;
  const widened = (r) => [r[0] / k, r[1] * k];
  const steps = [];
  let optimistic = 0;
  let pessimistic = 0;
  let worst = 0;
  let largestStart = 0;
  for (const s of shapes) {
    if (s.kind !== 'agent') { steps.push({ id: s.id, kind: s.kind, starts: [0, 0], usd: [0, 0] }); continue; }
    const guess = byId.get(s.id) || null;
    const size = guess && SIZES.includes(guess.size) ? guess.size : 'M';
    const checkSize = guess && SIZES.includes(guess.checkSize) ? guess.checkSize : 'S';
    const kind = guess && KINDS.includes(guess.kind) ? guess.kind : null;
    const maxAttempts = s.maxAttempts;
    const attempts = {
      low: 1,
      high: guess && guess.attempts ? clampInt(guess.attempts.high, 1, maxAttempts, maxAttempts) : maxAttempts,
      max: maxAttempts,
    };
    let items = { low: 1, high: 1, max: 1, basis: null };
    if (s.maxItems) {
      const max = s.maxItems;
      const seen = observedItems(history, name, s.id);
      if (guess && guess.items) {
        const lo = clampInt(guess.items.low, 1, max, 1);
        items = { low: lo, high: clampInt(guess.items.high, lo, max, max), max, basis: 'estimator' };
      } else if (seen) {
        items = { low: Math.min(seen.low, max), high: Math.min(seen.high, max), max, basis: `earlier runs (${seen.n})` };
      } else {
        items = { low: 1, high: max, max, basis: 'max_items' };
      }
    }
    const work = perStartCost(history, { workflow: name, stepId: s.id, role: 'agent', agent: s.agent, size, kind, model: s.model, calibration: cal, priors });
    const judge = s.checker
      ? perStartCost(history, { workflow: name, stepId: s.id, role: 'until', agent: s.checker, size: checkSize, kind: 'review', model: s.checkerModel, calibration: cal, priors })
      : null;
    const workRange = widened(work.range);
    const judgeRange = judge ? widened(judge.range) : null;
    const perAttempt = [workRange[0] + (judge ? judgeRange[0] : 0), workRange[1] + (judge ? judgeRange[1] : 0)];
    const startsPerAttempt = judge ? 2 : 1;
    const low = items.low * attempts.low * perAttempt[0];
    const high = items.high * attempts.high * perAttempt[1];
    const max = items.max * attempts.max * perAttempt[1];
    optimistic += low;
    pessimistic += high;
    worst += max;
    largestStart = Math.max(largestStart, workRange[1], judge ? judgeRange[1] : 0);
    steps.push({
      id: s.id, kind: 'agent', agent: s.agent, checker: judge ? s.checker : null, model: s.model || null,
      size, checkSize: judge ? checkSize : null, workKind: kind,
      starts: [items.low * attempts.low * startsPerAttempt, items.high * attempts.high * startsPerAttempt],
      attempts, items: s.maxItems ? items : null,
      perStart: { agent: workRange.map(round4), checker: judge ? judgeRange.map(round4) : null },
      basis: [work.basis, ...(judge ? [`checker: ${judge.basis}`] : [])].join('; '),
      usd: [round4(low), round4(high)],
      why: guess && guess.why ? String(guess.why) : null,
    });
  }
  // The runner starts no agent once the reported cost reaches the budget; the
  // start already running can carry it past by its own cost.
  const cap = reportsCost ? budget + largestStart : null;
  const capped = (x) => (cap == null ? x : Math.min(x, cap));
  return {
    name,
    optimistic: round(capped(optimistic)),
    pessimistic: round(capped(pessimistic)),
    uncapped: round(pessimistic),
    worstCase: round(capped(worst)),
    budget,
    cap: cap == null ? null : round(cap),
    reportsCost,
    overBudget: optimistic >= budget,
    steps,
    ai: !!(ai && ai.steps && ai.steps.length),
    calibration: { pairs: cal.pairs, coverage: cal.coverage, widen: cal.widen, sizes: Object.keys(cal.sizes) },
  };
}

/** Estimate a validated definition; `models` maps each agent to the model it runs on. */
function estimateDefinition(def, { history, ai = null, reportsCost = true, models = {}, calibration = null, priors = null }) {
  return estimateShapes(def.name, stepShapes(def, models), { history, ai, budget: def.limits.max_usd, reportsCost, calibration, priors });
}

/** What a run keeps of its estimate in run.json and its record. */
function compactEstimate(est, shapes, method) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  return {
    method, optimistic: est.optimistic, pessimistic: est.pessimistic, widen: est.calibration.widen,
    steps: est.steps.filter((s) => s.kind === 'agent').map((s) => {
      const shape = byId.get(s.id);
      return {
        id: s.id, agent: s.agent, checker: s.checker, model: s.model, size: s.size, checkSize: s.checkSize, kind: s.workKind,
        maxAttempts: shape.maxAttempts, maxItems: shape.maxItems, checkerModel: shape.checkerModel || null,
        usd: s.usd, perStart: s.perStart, basis: s.basis,
      };
    }),
  };
}

// -------------------------------------------------------------------- records

/**
 * The record of one run: what it was estimated to cost and what it cost,
 * step by step, with every agent start. Small, and without prompts, reports
 * or command output: it is committed and shared with the team.
 */
function buildRecord(run, { kitVersion = null } = {}) {
  const calls = (Array.isArray(run.calls) ? run.calls : []).map((c) => ({
    step: c.step, role: c.role, agent: c.agent, ...(c.item ? { item: c.item } : {}), attempt: c.attempt,
    tool: c.tool, model: c.model || null, ...(c.actualModel ? { actualModel: c.actualModel } : {}),
    ok: !!c.ok, costUsd: c.costUsd == null ? null : round4(Number(c.costUsd)), durationMs: c.durationMs ?? null,
    ...(c.tokens ? { tokens: c.tokens } : {}),
  }));
  // Agent steps only: commands and the pull request cost nothing, and a record
  // written before the pull request is pushed must not change after it.
  const steps = (Array.isArray(run.steps) ? run.steps : []).filter((s) => s.kind === 'agent').map((s) => {
    const mine = calls.filter((c) => c.step === s.id);
    const cost = mine.reduce((a, c) => a + (c.costUsd || 0), 0);
    const items = Array.isArray(s.items) ? s.items : null;
    return {
      id: s.id, kind: s.kind, ok: !!s.ok, attempts: s.attempts || 0, starts: mine.length,
      costUsd: mine.some((c) => c.costUsd != null) ? round4(cost) : null,
      ...(items ? { items: items.length, failed: items.filter((i) => i.failed).length } : {}),
    };
  });
  return {
    schemaVersion: 1, workflow: run.name, runId: run.runId, hash: run.hash, kitVersion,
    startedAt: run.startedAt, done: !!run.done,
    costUsd: run.costUsd == null ? null : round4(Number(run.costUsd)),
    estimate: run.estimate || null, steps, calls,
  };
}

function recordRel(name, runId) { return `${RECORDS_REL}/${name}-${runId}.json`; }

/** Write a run's record unless it is the same as the one on disk. Returns its repo-relative path, or null. */
function writeRecord(repoRoot, rec) {
  if (!rec.calls.length) return null;
  const rel = recordRel(rec.workflow, rec.runId);
  const file = layout.abs(repoRoot, rel);
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  if (cfgMod.readTextIfExists(file) === text) return rel;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  cfgMod.writeFileAtomic(file, text);
  return rel;
}

/** Keep the estimator's judgment of a workflow (size, kind) for the runs that follow. */
function writeJudgment(repoRoot, name, hash, answer) {
  const steps = (answer.steps || []).map((s) => ({ id: s.id, size: s.size, checkSize: s.checkSize, kind: s.kind }));
  const file = layout.abs(repoRoot, `${JUDGMENTS_REL}/${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  cfgMod.writeFileAtomic(file, `${JSON.stringify({ schemaVersion: 1, hash, steps }, null, 2)}\n`);
  return `${JUDGMENTS_REL}/${name}.json`;
}

// --------------------------------------------------------------------- review

/** The steps outside their range since the last review: the reviewer starts once there are enough. */
function reviewDue(history, priors) {
  const reviewed = new Set((priors && priors.reviewedThrough) || []);
  const fresh = (history.records || []).filter((r) => !reviewed.has(`${r.workflow}/${r.runId}`));
  const misses = estimatePairs(fresh).filter((p) => !inside(p));
  return { due: misses.length >= REVIEW_AFTER_MISSES, misses, records: fresh };
}

/** One line per estimated step of the records, for the reviewer. */
function reviewLines(records) {
  const lines = [];
  for (const r of records) {
    const predicted = new Map(((r.estimate && r.estimate.steps) || []).map((s) => [s.id, s]));
    for (const s of r.steps || []) {
      const p = predicted.get(s.id);
      if (!p) continue;
      const models = [...new Set((r.calls || []).filter((c) => c.step === s.id).map((c) => callModel(c)).filter(Boolean))];
      const verdict = !s.ok || s.costUsd == null ? 'not finished' : (s.costUsd < p.usd[0] ? 'BELOW' : s.costUsd > p.usd[1] ? 'ABOVE' : 'inside');
      lines.push(`- ${r.workflow} ${r.runId} step ${s.id}: agent ${p.agent}${p.checker ? ` + checker ${p.checker}` : ''}; size ${p.size}${p.kind ? `, kind ${p.kind}` : ''}; `
        + `model ${models.join('/') || p.model || 'default'}; estimated $${p.usd[0]}–$${p.usd[1]} (${p.basis}); actual ${s.costUsd == null ? '?' : `$${s.costUsd}`} `
        + `in ${s.starts} start(s), ${s.attempts} attempt(s)${s.items != null ? `, ${s.items} target(s) (${s.failed || 0} failed)` : ''} — ${verdict}`);
    }
  }
  return lines;
}

/**
 * The reviewer's answer: the last ```json block of its final message, as
 * { priors: [{agent?|kind?, role, model, perStart: [lo, hi], why}], notes }.
 * Every prior is checked and converted to the reference model; null when
 * nothing usable is there.
 */
function parseReview(text) {
  const blocks = [...String(text == null ? '' : text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]).reverse();
  for (const b of blocks) {
    let v;
    try { v = JSON.parse(b); } catch { continue; }
    if (!v || !Array.isArray(v.priors)) continue;
    const priors = [];
    for (const p of v.priors.slice(0, 100)) {
      if (!p || !Array.isArray(p.perStart) || p.perStart.length !== 2) continue;
      const [lo, hi] = p.perStart.map(Number);
      if (!(lo > 0) || !(hi >= lo) || hi > 100) continue;
      const role = p.role === 'until' ? 'until' : 'agent';
      const agent = typeof p.agent === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.agent) ? p.agent : null;
      const kind = !agent && KINDS.includes(p.kind) ? p.kind : null;
      if (!agent && !kind) continue;
      const f = modelFactor(p.model || REFERENCE_MODEL, REFERENCE_MODEL);
      priors.push({ ...(agent ? { agent } : { kind }), role, perStart: [round4(lo * f), round4(hi * f)], why: typeof p.why === 'string' ? p.why.slice(0, 300) : '' });
    }
    return { priors, notes: typeof v.notes === 'string' ? v.notes.slice(0, 4000) : '' };
  }
  return null;
}

/** Keep a review: priors.json (what the estimate reads) and notes.md (what people and the estimator read). */
function writeReview(repoRoot, review, { records, previous = [], costUsd = null }) {
  const body = {
    schemaVersion: 1, reviewedAt: new Date().toISOString(),
    // Every record read so far, so the next review starts from the runs after this one.
    reviewedThrough: [...new Set([...(previous || []), ...records.map((r) => `${r.workflow}/${r.runId}`)])], costUsd, priors: review.priors,
  };
  const pFile = layout.abs(repoRoot, PRIORS_REL);
  fs.mkdirSync(path.dirname(pFile), { recursive: true });
  cfgMod.writeFileAtomic(pFile, `${JSON.stringify(body, null, 2)}\n`);
  cfgMod.writeFileAtomic(layout.abs(repoRoot, NOTES_REL), `# Estimate notes\n\nWritten by the estimate reviewer on ${body.reviewedAt.slice(0, 10)}; aidev rewrites this file on the next review.\n\n${review.notes.trim()}\n`);
  return [PRIORS_REL, NOTES_REL];
}

// -------------------------------------------------------------------- answers

/**
 * The estimator agent's answer: the last ```json block (or the last {...}) of
 * its final message, as { steps: [{id, size, checkSize?, kind?, attempts: {high},
 * items?: {low, high}, why}], notes }. Null when there is none to read.
 */
function parseAiAnswer(text) {
  const s = String(text == null ? '' : text);
  const blocks = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = blocks.length ? blocks.reverse() : [s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    let v;
    try { v = JSON.parse(c); } catch { continue; }
    if (!v || !Array.isArray(v.steps)) continue;
    const steps = v.steps.filter((x) => x && typeof x.id === 'string').map((x) => ({
      id: x.id,
      size: typeof x.size === 'string' ? x.size.toUpperCase() : null,
      checkSize: typeof x.checkSize === 'string' ? x.checkSize.toUpperCase() : null,
      kind: typeof x.kind === 'string' && KINDS.includes(x.kind) ? x.kind : null,
      attempts: x.attempts && typeof x.attempts === 'object' ? { high: x.attempts.high } : null,
      items: x.items && typeof x.items === 'object' ? { low: x.items.low, high: x.items.high } : null,
      why: typeof x.why === 'string' ? x.why.slice(0, 300) : null,
    }));
    return { steps, notes: typeof v.notes === 'string' ? v.notes.slice(0, 1000) : null };
  }
  return null;
}

/** "$0.40 – $2.10" */
function usdRange([a, b]) { return a === b ? `$${a.toFixed(2)}` : `$${a.toFixed(2)} – $${b.toFixed(2)}`; }

/**
 * After `done` of `total` targets of a step, what the rest will likely cost
 * at the rate so far: { perTarget, remaining } or null before there is a rate.
 */
function projectRemaining(costs, total) {
  if (costs.length < FEW_SAMPLES) return null;
  const perTarget = costs.reduce((a, b) => a + b, 0) / costs.length;
  return { perTarget, remaining: perTarget * Math.max(0, total - costs.length) };
}

module.exports = {
  SIZE_USD, SIZES, KINDS, MODEL_PRICES, REFERENCE_MODEL, TARGET_COVERAGE, MIN_PAIRS, REVIEW_AFTER_MISSES,
  RECORDS_REL, PRIORS_REL, NOTES_REL, JUDGMENTS_REL,
  priceOf, modelFactor, collectHistory, readRecords, observedRange, estimatePairs, calibrate,
  readPriors, readNotes, findPrior, readJudgment, perStartCost, observedItems, stepShapes, estimateShapes,
  estimateDefinition, compactEstimate, buildRecord, recordRel, writeRecord, writeJudgment,
  reviewDue, reviewLines, parseReview, writeReview, parseAiAnswer, usdRange, projectRemaining,
};
