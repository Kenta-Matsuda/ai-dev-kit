'use strict';
/**
 * What a workflow run is likely to cost, before it runs.
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
 *   what one start costs — from the costs this PKG's runs recorded (run.json
 *                       `calls`): the same step first, then the same agent in
 *                       any workflow. Without history, a size class (S/M/L/XL)
 *                       maps to a default range; the estimator agent picks the
 *                       class, otherwise it is M for a step and S for a checker.
 *
 * The pessimistic total is capped where the runner stops: it starts no agent
 * once the reported cost reaches limits.max_usd, so a run can pass the budget by
 * at most the cost of its last start.
 */

const fs = require('fs');
const path = require('path');
const wfMod = require('./workflow');

/** Cost of one agent start (USD) per size class, when this PKG has no history yet. */
const SIZE_USD = Object.freeze({
  S: [0.05, 0.3],
  M: [0.3, 1.0],
  L: [1.0, 3.0],
  XL: [3.0, 8.0],
});
const SIZES = Object.keys(SIZE_USD);

/** Below this many recorded starts the observed range is widened (a few samples miss the tails). */
const FEW_SAMPLES = 3;

const round = (x) => Math.round(x * 100) / 100;

/**
 * The agent starts this PKG's runs recorded, read from every
 * `.aidev/workflows/<name>/runs/<id>/run.json` that has `calls`.
 * Returns { calls: [{workflow, step, role, agent, costUsd}], runs: [{workflow, steps}] }.
 */
function collectHistory(repoRoot) {
  const calls = [];
  const runs = [];
  for (const name of wfMod.listWorkflows(repoRoot)) {
    let ids = [];
    try { ids = fs.readdirSync(wfMod.runsDir(repoRoot, name)).filter((d) => wfMod.RUN_ID_RE.test(d)); } catch { ids = []; }
    for (const id of ids) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(wfMod.runsDir(repoRoot, name), id, 'run.json'), 'utf8')); } catch { continue; }
      runs.push({ workflow: name, steps: Array.isArray(rec.steps) ? rec.steps : [] });
      for (const c of Array.isArray(rec.calls) ? rec.calls : []) {
        const cost = Number(c && c.costUsd);
        if (!c || c.costUsd == null || !Number.isFinite(cost) || cost < 0) continue;
        calls.push({ workflow: name, step: String(c.step || ''), role: c.role === 'until' ? 'until' : 'agent', agent: String(c.agent || ''), costUsd: cost });
      }
    }
  }
  return { calls, runs };
}

/** [low, high] of a list of costs; widened when there are few. */
function observedRange(costs) {
  const lo = Math.min(...costs);
  const hi = Math.max(...costs);
  return costs.length < FEW_SAMPLES ? [lo * 0.5, hi * 2] : [lo, hi];
}

/**
 * The cost of one start of `agent` in the role `role` of step `stepId`:
 * { range: [low, high], basis } — the step's own history, the agent's
 * history anywhere in the PKG, or the size class.
 */
function perStartCost(history, { workflow, stepId, role, agent, size }) {
  const own = history.calls.filter((c) => c.workflow === workflow && c.step === stepId && c.role === role).map((c) => c.costUsd);
  if (own.length) return { range: observedRange(own), basis: `history of this step (${own.length})` };
  const same = history.calls.filter((c) => c.agent === agent && c.role === role).map((c) => c.costUsd);
  if (same.length) return { range: observedRange(same), basis: `history of agent ${agent} (${same.length})` };
  return { range: [...SIZE_USD[size]], basis: `size ${size}` };
}

/** The target counts earlier runs of this step saw: { low, high } or null. */
function observedItems(history, workflow, stepId) {
  const counts = [];
  for (const r of history.runs) {
    if (r.workflow !== workflow) continue;
    const s = r.steps.find((x) => x && x.id === stepId);
    if (s && Array.isArray(s.items) && s.items.length) counts.push(s.items.length);
  }
  return counts.length ? { low: Math.min(...counts), high: Math.max(...counts), n: counts.length } : null;
}

const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/**
 * Estimate a validated definition. `ai` is the estimator agent's answer
 * (parseAiAnswer), or null. `reportsCost` is false when the tool reports no
 * cost (then limits.max_usd cannot stop the run and the cap does not apply).
 */
function estimateDefinition(def, { history, ai = null, reportsCost = true }) {
  const byId = new Map(((ai && ai.steps) || []).map((s) => [s.id, s]));
  const steps = [];
  let optimistic = 0;
  let pessimistic = 0;
  let worst = 0;
  let largestStart = 0;
  for (const s of def.steps) {
    if (s.kind !== 'agent') { steps.push({ id: s.id, kind: s.kind, starts: [0, 0], usd: [0, 0] }); continue; }
    const guess = byId.get(s.id) || null;
    const size = guess && SIZES.includes(guess.size) ? guess.size : 'M';
    const maxAttempts = s.max_retries + 1;
    const attempts = {
      low: 1,
      high: guess && guess.attempts ? clampInt(guess.attempts.high, 1, maxAttempts, maxAttempts) : maxAttempts,
      max: maxAttempts,
    };
    let items = { low: 1, high: 1, max: 1, basis: null };
    if (s.for_each) {
      const max = s.for_each.max_items;
      const seen = observedItems(history, def.name, s.id);
      if (guess && guess.items) {
        const lo = clampInt(guess.items.low, 1, max, 1);
        items = { low: lo, high: clampInt(guess.items.high, lo, max, max), max, basis: 'estimator' };
      } else if (seen) {
        items = { low: Math.min(seen.low, max), high: Math.min(seen.high, max), max, basis: `earlier runs (${seen.n})` };
      } else {
        items = { low: 1, high: max, max, basis: 'max_items' };
      }
    }
    const work = perStartCost(history, { workflow: def.name, stepId: s.id, role: 'agent', agent: s.agent, size });
    const judge = s.until && s.until.agent
      ? perStartCost(history, { workflow: def.name, stepId: s.id, role: 'until', agent: s.until.agent, size: guess && SIZES.includes(guess.checkSize) ? guess.checkSize : 'S' })
      : null;
    const perAttempt = [work.range[0] + (judge ? judge.range[0] : 0), work.range[1] + (judge ? judge.range[1] : 0)];
    const startsPerAttempt = judge ? 2 : 1;
    const low = items.low * attempts.low * perAttempt[0];
    const high = items.high * attempts.high * perAttempt[1];
    const max = items.max * attempts.max * perAttempt[1];
    optimistic += low;
    pessimistic += high;
    worst += max;
    largestStart = Math.max(largestStart, work.range[1], judge ? judge.range[1] : 0);
    steps.push({
      id: s.id, kind: 'agent', agent: s.agent, checker: judge ? s.until.agent : null,
      starts: [items.low * attempts.low * startsPerAttempt, items.high * attempts.high * startsPerAttempt],
      attempts, items: s.for_each ? items : null,
      perStart: { agent: work.range.map(round), checker: judge ? judge.range.map(round) : null },
      basis: [work.basis, ...(judge ? [`checker: ${judge.basis}`] : [])].join('; '),
      usd: [round(low), round(high)],
      why: guess && guess.why ? String(guess.why) : null,
    });
  }
  // The runner starts no agent once the reported cost reaches the budget; the
  // start already running can carry it past by its own cost.
  const cap = reportsCost ? def.limits.max_usd + largestStart : null;
  const capped = (x) => (cap == null ? x : Math.min(x, cap));
  return {
    name: def.name,
    optimistic: round(capped(optimistic)),
    pessimistic: round(capped(pessimistic)),
    uncapped: round(pessimistic),
    worstCase: round(capped(worst)),
    budget: def.limits.max_usd,
    cap: cap == null ? null : round(cap),
    reportsCost,
    overBudget: optimistic >= def.limits.max_usd,
    steps,
    ai: !!ai,
  };
}

/**
 * The estimator agent's answer: the last ```json block (or the last {...}) of
 * its final message, as { steps: [{id, size, checkSize?, attempts: {high},
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

module.exports = { SIZE_USD, SIZES, collectHistory, perStartCost, observedItems, estimateDefinition, parseAiAnswer, usdRange };
