'use strict';
/**
 * `aidev task list|show|resume|advance|abandon`
 *
 * The two-stage PR flow as a resumable state machine:
 *
 *   IMPLEMENTING → PKG_PR_OPEN → PKG_PR_MERGED → SYNCHRONIZING → WIKI_PR_OPEN → DONE
 *                       │              │              └── SYNC_FAILED ──(--resume)──┘
 *                       └── PKG_PR_ABANDONED          WIKI_PR_ABANDONED / BLOCKED
 *
 * Exactly two transitions are human merge gates (PKG_PR_OPEN → PKG_PR_MERGED,
 * WIKI_PR_OPEN → DONE); the CLI observes them via the API and never performs
 * them.
 *
 * State authority is Azure DevOps. `.aidev/tasks/` is a gitignored local cache
 * — committing it would create a cycle in which the repository's own history
 * became the record of changes to that history.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const gitMod = require('../lib/git');
const stateMod = require('../lib/state');
const leases = require('../lib/leases');
const ado = require('../lib/ado');
const ui = require('../lib/ui');

const FLAGS = {
  json: 'boolean', all: 'boolean', 'dry-run': 'boolean',
  state: 'string', reason: 'string',
};

const STATES = Object.freeze([
  'IMPLEMENTING', 'PKG_PR_OPEN', 'PKG_PR_MERGED', 'SYNCHRONIZING',
  'SYNC_FAILED', 'WIKI_PR_OPEN', 'DONE',
  'PKG_PR_ABANDONED', 'WIKI_PR_ABANDONED', 'BLOCKED',
]);

const TERMINAL = Object.freeze(['DONE', 'PKG_PR_ABANDONED', 'WIKI_PR_ABANDONED']);

/**
 * Legal transitions. SYNC_FAILED routes back to SYNCHRONIZING, never forward to
 * DONE — a failed sync that could be "resumed" straight to completion would
 * mark the Wiki current without regenerating it.
 */
const TRANSITIONS = Object.freeze({
  IMPLEMENTING: ['PKG_PR_OPEN', 'PKG_PR_ABANDONED', 'BLOCKED'],
  PKG_PR_OPEN: ['PKG_PR_MERGED', 'PKG_PR_ABANDONED', 'BLOCKED'],
  PKG_PR_MERGED: ['SYNCHRONIZING', 'BLOCKED'],
  SYNCHRONIZING: ['WIKI_PR_OPEN', 'SYNC_FAILED', 'BLOCKED'],
  SYNC_FAILED: ['SYNCHRONIZING', 'BLOCKED'],
  WIKI_PR_OPEN: ['DONE', 'WIKI_PR_ABANDONED', 'BLOCKED'],
  DONE: [],
  PKG_PR_ABANDONED: [],
  WIKI_PR_ABANDONED: [],
  BLOCKED: ['IMPLEMENTING', 'SYNCHRONIZING', 'PKG_PR_ABANDONED', 'WIKI_PR_ABANDONED'],
});

function cacheDir(repoRoot, config) {
  return path.join(repoRoot, config?.task?.cache_dir || path.join('.aidev', 'tasks'));
}

function taskPath(repoRoot, config, taskId) {
  return path.join(cacheDir(repoRoot, config), `${leases.sanitizeTaskId(taskId)}.json`);
}

function readTask(repoRoot, config, taskId) {
  const rec = cfgMod.readJsonIfExists(taskPath(repoRoot, config, taskId));
  if (!rec) throw new AidevError(`no cached task record for ${taskId} (the cache is local and gitignored)`);
  return rec;
}

function writeTask(repoRoot, config, rec) {
  rec.updatedAt = new Date().toISOString();
  cfgMod.writeJsonAtomic(taskPath(repoRoot, config, rec.taskId), rec);
  return rec;
}

function listTasks(repoRoot, config) {
  const dir = cacheDir(repoRoot, config);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = cfgMod.readJsonIfExists(path.join(dir, n));
    if (rec && rec.taskId) out.push(rec);
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

function assertTransition(from, to) {
  if (!STATES.includes(to)) {
    throw new AidevError(`unknown state: ${to} (expected one of: ${STATES.join(', ')})`);
  }
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new AidevError(
      `illegal transition ${from} → ${to}. From ${from} the legal next states are: ` +
      `${allowed.length ? allowed.join(', ') : '(none; this state is terminal)'}`);
  }
}

// ------------------------------------------------------------------- list/show

function list(ctx, config) {
  const { repoRoot, flags } = ctx;
  let tasks = listTasks(repoRoot, config);
  if (!flags.all) tasks = tasks.filter((t) => !TERMINAL.includes(t.state));

  if (flags.json) { ui.json({ tasks, cacheDir: config?.task?.cache_dir }); return EXIT.OK; }

  ui.heading(`aidev task list${flags.all ? ' (including finished)' : ''}`);
  if (tasks.length === 0) {
    ui.dim('    no tasks in the local cache');
    ui.dim('    (the cache is gitignored; Azure DevOps holds the authoritative state)');
    return EXIT.OK;
  }
  ui.table(tasks.map((t) => [
    t.taskId,
    `${t.state.padEnd(20)} ${t.pkgPullRequestId ? `pkg!${t.pkgPullRequestId} ` : ''}` +
    `${t.wikiPullRequestId ? `wiki!${t.wikiPullRequestId} ` : ''}` +
    `${t.updatedAt || ''}`,
  ]));
  return EXIT.OK;
}

function show(ctx, config) {
  const { repoRoot, flags, positionals } = ctx;
  const taskId = positionals[1];
  if (!taskId) throw new AidevError('usage: aidev task show <taskId>');
  const rec = readTask(repoRoot, config, taskId);

  if (flags.json) { ui.json(rec); return EXIT.OK; }
  ui.heading(`aidev task show ${rec.taskId}`);
  ui.table([
    ['state', rec.state],
    ['work item', rec.workItemId || '-'],
    ['pkg branch', rec.pkgBranch || '-'],
    ['pkg PR', rec.pkgPullRequestId || '-'],
    ['merged SHA', stateMod.short(rec.mergedSha)],
    ['Wiki PR', rec.wikiPullRequestId || '-'],
    ['operationKey', rec.operationKey || '-'],
    ['syncStreamId', rec.syncStreamId || '-'],
    ['updated', rec.updatedAt || '-'],
    ['next states', (TRANSITIONS[rec.state] || []).join(', ') || '(terminal)'],
  ]);
  if (rec.note) { ui.out(''); ui.dim(`    ${rec.note}`); }
  return EXIT.OK;
}

// --------------------------------------------------------------------- advance

/**
 * Advance one task.
 *
 * Where a transition depends on a merge, the merge result is read from the PR
 * API — never from the agent's branch tip, which squash, rebase, reviewer
 * commits and interleaved PRs all move independently of the merge.
 */
async function advance(ctx, config) {
  const taskId = ctx.positionals[1];
  // No id means "advance everything that can advance" — the form the nightly
  // pipeline runs. --state targets one specific task, so it is not meaningful
  // in bulk and is rejected rather than applied to every task at once.
  if (!taskId) {
    if (ctx.flags.state) {
      throw new AidevError('--state requires a task id: aidev task advance <taskId> --state <STATE>');
    }
    return advanceAll(ctx, config);
  }
  await advanceOne(ctx, config, taskId);
  return EXIT.OK;
}

/**
 * Advance every non-terminal task, one at a time.
 *
 * One task's failure must not strand the rest: a PR whose id has gone missing,
 * or a single API error, is recorded against that task and the loop continues.
 * The exit code reports whether anything failed, so a pipeline still goes red.
 */
async function advanceAll(ctx, config) {
  const { repoRoot, flags } = ctx;
  const all = listTasks(repoRoot, config);
  const pending = all.filter((r) => !TERMINAL.includes(r.state));

  if (pending.length === 0) {
    const msg = all.length === 0 ? 'no tasks are cached locally' : 'every cached task is already terminal';
    if (flags.json) ui.json({ ok: true, tasks: [], advanced: 0, failed: 0, detail: msg });
    else ui.ok(`nothing to advance — ${msg}.`);
    return EXIT.OK;
  }

  if (!flags.json) ui.heading(`aidev task advance (${pending.length} open task(s))`);

  const results = [];
  let failed = 0;
  for (const rec of pending) {
    try {
      const r = await advanceOne(ctx, config, rec.taskId, { bulk: true });
      results.push(r);
      if (r.changed && !flags.json) {
        ui.ok(`${r.taskId}: ${r.from} → ${r.state}${r.detail ? ` (${r.detail})` : ''}`);
      } else if (!r.changed && !flags.json) {
        ui.info(`${r.taskId}: staying in ${r.state} — ${r.detail}`);
      }
    } catch (e) {
      failed++;
      results.push({ taskId: rec.taskId, state: rec.state, changed: false, error: e.message });
      if (!flags.json) ui.fail(`${rec.taskId}: ${e.message}`);
    }
  }

  const advanced = results.filter((r) => r.changed).length;
  if (flags.json) ui.json({ ok: failed === 0, tasks: results, advanced, failed });
  else {
    ui.out('');
    ui.info(`${advanced} advanced, ${pending.length - advanced - failed} unchanged, ${failed} failed`);
  }
  return failed > 0 ? EXIT.GENERAL : EXIT.OK;
}

async function advanceOne(ctx, config, taskId, { bulk = false } = {}) {
  const { repoRoot, flags } = ctx;
  const emit = (payload) => {
    // In bulk mode the caller renders and aggregates; emitting here too would
    // print a JSON document per task and break `--json` parseability.
    if (bulk) return payload;
    if (flags.json) ui.json({ ok: true, ...payload });
    return payload;
  };
  const rec = readTask(repoRoot, config, taskId);
  const from = rec.state;

  if (TERMINAL.includes(from)) {
    if (!bulk) ui.ok(`task ${rec.taskId} is already in terminal state ${from}; nothing to do.`);
    return emit({ taskId: rec.taskId, from, state: from, changed: false,
      detail: `already terminal (${from})` });
  }

  // --state forces a specific transition (still validated against the machine).
  if (flags.state) {
    assertTransition(from, flags.state);
    if (flags['dry-run']) {
      ui.ok(`would move ${rec.taskId}: ${from} → ${flags.state}`);
      return emit({ dryRun: true, taskId: rec.taskId, from, state: flags.state, changed: false });
    }
    rec.state = flags.state;
    if (flags.reason) rec.note = String(flags.reason);
    writeTask(repoRoot, config, rec);
    ui.ok(`${rec.taskId}: ${from} → ${rec.state}`);
    return emit({ taskId: rec.taskId, from, state: rec.state, changed: true });
  }

  // Otherwise observe the world and derive the next state.
  let next = null;
  let detail = '';

  if (from === 'PKG_PR_OPEN') {
    if (!rec.pkgPullRequestId) throw new AidevError(`task ${rec.taskId} is PKG_PR_OPEN but records no PR id`);
    const pr = await ado.getPullRequest(config, config.azure_devops.repository, rec.pkgPullRequestId);
    if (pr.status === 'completed') {
      const merged = ado.mergeResultSha(pr);
      if (!merged) {
        throw new AidevError(
          `PKG PR !${rec.pkgPullRequestId} is completed but exposes no merge commit; ` +
          'refusing to guess the resulting SHA.');
      }
      // Verify the SHA is genuinely on the tracking branch before trusting it.
      const branch = config.sync.tracking_branch;
      gitMod.fetch(repoRoot, 'origin', branch);
      if (!gitMod.commitExists(repoRoot, merged)) {
        throw new AidevError(
          `merge commit ${stateMod.short(merged)} is not present after fetching origin/${branch}. ` +
          'Re-run once the push has propagated.');
      }
      rec.mergedSha = merged;
      next = 'PKG_PR_MERGED';
      detail = `merged as ${stateMod.short(merged)}`;
    } else if (pr.status === 'abandoned') {
      next = 'PKG_PR_ABANDONED';
      detail = 'the PKG PR was abandoned';
    } else {
      detail = `PKG PR !${rec.pkgPullRequestId} is still ${pr.status}; waiting on a human merge`;
    }
  } else if (from === 'PKG_PR_MERGED') {
    next = 'SYNCHRONIZING';
    detail = 'ready to sync; run "aidev sync"';
  } else if (from === 'SYNCHRONIZING' || from === 'SYNC_FAILED') {
    const st = stateMod.computeState(repoRoot, config, { checkRemote: false });
    if (st.severity === stateMod.SEVERITY.ERROR) {
      next = from === 'SYNCHRONIZING' ? 'SYNC_FAILED' : null;
      detail = `sync has not completed: ${st.message}`;
    } else if (rec.wikiPullRequestId) {
      next = 'WIKI_PR_OPEN';
      detail = `Wiki PR !${rec.wikiPullRequestId} is open`;
    } else {
      detail = 'sync is consistent, but no Wiki PR is recorded yet';
    }
  } else if (from === 'WIKI_PR_OPEN') {
    if (!rec.wikiPullRequestId) throw new AidevError(`task ${rec.taskId} is WIKI_PR_OPEN but records no PR id`);
    const repo = config.hosting.repository;
    if (!repo || config.hosting.type !== 'azure-devops') throw new AidevError('the Wiki PR state can only be checked on azure-devops hosting');
    const pr = await ado.getPullRequest(config, repo, rec.wikiPullRequestId);
    if (pr.status === 'completed') { next = 'DONE'; detail = 'Wiki PR merged'; }
    else if (pr.status === 'abandoned') { next = 'WIKI_PR_ABANDONED'; detail = 'Wiki PR abandoned'; }
    else detail = `Wiki PR !${rec.wikiPullRequestId} is still ${pr.status}; waiting on a human merge`;
  } else {
    detail = `state ${from} advances through agent work, not through observation`;
  }

  if (!next) {
    if (!bulk) ui.info(`${rec.taskId}: staying in ${from} — ${detail}`);
    return emit({ taskId: rec.taskId, from, state: from, changed: false, detail });
  }

  assertTransition(from, next);
  if (flags['dry-run']) {
    ui.ok(`would move ${rec.taskId}: ${from} → ${next} (${detail})`);
    return emit({ dryRun: true, taskId: rec.taskId, from, state: next, changed: false, detail });
  }

  rec.state = next;
  rec.note = detail;
  writeTask(repoRoot, config, rec);

  // Mirror the new state to the authoritative store, best-effort: the cache is
  // not the record, so a failure here is reported rather than fatal.
  if (rec.workItemId) {
    try { await ado.postStateComment(config, rec.workItemId, rec); } catch (e) {
      ui.warn(`state comment could not be posted to the work item: ${e.message}`);
    }
  }

  if (!bulk) ui.ok(`${rec.taskId}: ${from} → ${next} (${detail})`);
  return emit({ taskId: rec.taskId, from, state: next, changed: true, detail });
}

// ---------------------------------------------------------------------- resume

/**
 * `aidev task resume <id>` — observe the world, move the task as far as it can
 * go, and say what the human has to do next.
 *
 * Resume actually advances rather than only advising: it is one of the three
 * documented restart points (user, SessionStart hook, nightly pipeline) and all
 * three must go through the same state machine, or the paths diverge.
 *
 * It advances repeatedly, because one observation can unblock the next
 * transition (a merged PKG PR becomes PKG_PR_MERGED, which is immediately ready
 * to become SYNCHRONIZING). The loop stops at a terminal state, at a state that
 * needs work rather than observation, or when nothing changed.
 */
async function resume(ctx, config) {
  const { repoRoot, flags } = ctx;
  const taskId = ctx.positionals[1];
  if (!taskId) throw new AidevError('usage: aidev task resume <taskId>');

  const before = readTask(repoRoot, config, taskId);
  if (!flags.json) ui.heading(`aidev task resume ${before.taskId}`);

  const steps = [];
  let current = before.state;
  // Bounded by the number of states: the machine is acyclic apart from
  // SYNCHRONIZING ↔ SYNC_FAILED, so this cannot spin.
  for (let i = 0; i < STATES.length; i++) {
    let r;
    try {
      r = await advanceOne(ctx, config, taskId, { bulk: true });
    } catch (e) {
      if (!flags.json) ui.fail(e.message);
      steps.push({ from: current, error: e.message });
      break;
    }
    if (!r.changed) { steps.push({ from: r.state, detail: r.detail, changed: false }); break; }
    steps.push({ from: r.from, state: r.state, detail: r.detail, changed: true });
    if (!flags.json) ui.ok(`${r.from} → ${r.state}${r.detail ? ` (${r.detail})` : ''}`);
    current = r.state;
    if (TERMINAL.includes(current) || flags['dry-run']) break;
  }

  const rec = readTask(repoRoot, config, taskId);

  // What the human or the agent must do from here. Observation alone cannot
  // move these states, so naming the command is the useful half of resume.
  const guidance = {
    IMPLEMENTING: 'continue the implementation on the work branch, then open the PKG PR',
    PKG_PR_OPEN: 'waiting for a human to merge the PKG PR; re-run this afterwards',
    PKG_PR_MERGED: 'run "aidev sync" to regenerate the Wiki and open the Wiki PR',
    SYNCHRONIZING: 'run "aidev sync --resume" to finish the in-flight sync',
    SYNC_FAILED: 'run "aidev sync --resume" (or "aidev sync --abort" to unwind)',
    WIKI_PR_OPEN: 'waiting for a human to merge the Wiki PR',
    DONE: 'nothing to resume',
    PKG_PR_ABANDONED: 'nothing to resume; the PKG PR was abandoned',
    WIKI_PR_ABANDONED: 'nothing to resume; the Wiki PR was abandoned',
    BLOCKED: `blocked: ${rec.note || 'no reason recorded'}`,
  }[rec.state] || 'no resume path is defined for this state';

  const lease = leases.readWorkLease(repoRoot, rec.taskId);
  const leaseInfo = lease ? leases.evaluateLease(lease) : null;

  if (flags.json) {
    ui.json({
      ok: true, taskId: rec.taskId, from: before.state, state: rec.state,
      changed: rec.state !== before.state, steps, guidance,
      lease: leaseInfo ? { valid: leaseInfo.valid, reason: leaseInfo.reason || null } : null,
    });
    return EXIT.OK;
  }

  if (rec.state === before.state) ui.info(`still ${rec.state}`);
  ui.out('');
  ui.table([['state', rec.state], ['next', guidance]]);
  if (leaseInfo) {
    ui.out('');
    if (leaseInfo.valid) ui.ok(`work lease is active until ${leaseInfo.expiresAt} (branch ${lease.branch})`);
    else ui.warn(`work lease is ${leaseInfo.reason}; issue-to-pr must request a fresh one before writing src/**`);
  }
  return EXIT.OK;
}

// --------------------------------------------------------------------- abandon

function abandon(ctx, config) {
  const { repoRoot, flags, positionals } = ctx;
  const taskId = positionals[1];
  if (!taskId) throw new AidevError('usage: aidev task abandon <taskId> [--reason <text>]');
  const rec = readTask(repoRoot, config, taskId);

  if (TERMINAL.includes(rec.state)) {
    ui.ok(`task ${rec.taskId} is already terminal (${rec.state}).`);
    return EXIT.OK;
  }
  const next = ['WIKI_PR_OPEN'].includes(rec.state) ? 'WIKI_PR_ABANDONED' : 'PKG_PR_ABANDONED';
  assertTransition(rec.state, next);

  if (flags['dry-run']) { ui.ok(`would abandon ${rec.taskId}: ${rec.state} → ${next}`); return EXIT.OK; }

  const from = rec.state;
  rec.state = next;
  rec.note = flags.reason ? String(flags.reason) : 'abandoned by operator';
  writeTask(repoRoot, config, rec);

  // Releasing the work lease is the point of abandoning: src/** returns to
  // read-only immediately rather than at TTL expiry.
  const released = leases.releaseWorkLease(repoRoot, rec.taskId);
  ui.ok(`${rec.taskId}: ${from} → ${next}`);
  if (released) ui.ok('work lease released; src/** is read-only again');
  ui.dim('    Open PRs are not touched — closing them is a human decision.');
  if (flags.json) ui.json({ ok: true, taskId: rec.taskId, from, state: next, leaseReleased: released });
  return EXIT.OK;
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  const config = cfgMod.loadConfig(ctx.repoRoot);
  if (sub === 'list') return list(ctx, config);
  if (sub === 'show') return show(ctx, config);
  if (sub === 'advance') return advance(ctx, config);
  if (sub === 'resume') return resume(ctx, config);
  if (sub === 'abandon') return abandon(ctx, config);
  throw new AidevError(
    `unknown subcommand: aidev task ${sub || ''} (expected: list, show, resume, advance, abandon)`);
}

module.exports = {
  run, FLAGS, STATES, TERMINAL, TRANSITIONS, assertTransition,
  readTask, writeTask, listTasks, taskPath,
  summary: 'issue-to-pr タスクの状態遷移を管理',
};
