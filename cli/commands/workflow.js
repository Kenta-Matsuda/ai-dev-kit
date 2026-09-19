'use strict';
/**
 * `aidev workflow new|approve|run|list`
 *
 * The user's requirement was explicit: workflow output must be human-reviewed,
 * but the mechanism must stay freely customisable rather than purely
 * declarative. This is how both hold at once:
 *
 *   new      → scaffolds a definition plus a free-form steps script
 *   (human)  → reads `git diff`
 *   approve  → records a hash of the exact reviewed bytes
 *   run      → executes only if the current bytes still hash to that value
 *
 * So arbitrary logic is allowed, but no byte of it runs unreviewed. Editing an
 * approved workflow invalidates the approval automatically, because the hash
 * covers the script too.
 *
 * Safety valves below are mandatory, not defaults to taste: an agent-authored
 * loop with no iteration cap is the failure mode this design exists to prevent.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const yaml = require('../lib/yaml');
const ui = require('../lib/ui');

const FLAGS = {
  json: 'boolean', force: 'boolean', 'dry-run': 'boolean',
  yes: 'boolean', 'max-iterations': 'string', 'max-minutes': 'string',
  resume: 'boolean',
};

const WORKFLOWS_DIR = 'workflows';

/** Hard ceilings: a definition may lower these, never raise them. */
const LIMITS = Object.freeze({
  maxIterations: 10,
  maxMinutes: 60,
  maxIdenticalFailures: 3,
});

function workflowDir(repoRoot, name) {
  return path.join(repoRoot, WORKFLOWS_DIR, sanitizeName(name));
}

function sanitizeName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(s)) {
    throw new AidevError(
      `invalid workflow name: ${s || '(empty)'} (lowercase letters, digits and dashes; must start alphanumeric)`);
  }
  return s;
}

function defPath(repoRoot, name) { return path.join(workflowDir(repoRoot, name), 'workflow.yaml'); }
function stepsPath(repoRoot, name) { return path.join(workflowDir(repoRoot, name), 'steps.js'); }
function approvalPath(repoRoot, name) { return path.join(workflowDir(repoRoot, name), 'approval.json'); }
function runsDir(repoRoot, name) { return path.join(workflowDir(repoRoot, name), 'runs'); }

/**
 * The most recent unfinished run, or null.
 *
 * Only a run of the *same approved bytes* can be resumed: if the definition or
 * steps.js changed since it stopped, continuing would run unreviewed logic
 * while claiming the old approval, which is the exact hole the hash check
 * exists to close.
 */
function lastResumableRun(repoRoot, name, hash) {
  let ids;
  try { ids = fs.readdirSync(runsDir(repoRoot, name)).sort().reverse(); } catch { return null; }
  for (const id of ids) {
    const cp = cfgMod.readJsonIfExists(path.join(runsDir(repoRoot, name), id, 'checkpoint.json'));
    if (!cp || cp.done) continue;
    if (cp.hash !== hash) {
      return { stale: true, runId: id, checkpoint: cp };
    }
    return { stale: false, runId: id, checkpoint: cp };
  }
  return null;
}

/**
 * Hash the reviewable surface: the definition and the steps script together.
 * Both must be covered, or logic could be swapped after approval.
 */
function contentHash(repoRoot, name) {
  const parts = [];
  for (const p of [defPath(repoRoot, name), stepsPath(repoRoot, name)]) {
    const text = cfgMod.readTextIfExists(p);
    if (text == null) throw new AidevError(`workflow file is missing: ${path.relative(repoRoot, p)}`);
    // Normalise line endings so a Windows checkout does not invalidate a hash
    // approved on POSIX; the reviewed content is identical either way.
    parts.push(`${path.basename(p)}\n${text.replace(/\r\n/g, '\n')}`);
  }
  return `sha256:${cfgMod.sha256(Buffer.from(parts.join('\0'), 'utf8'))}`;
}

/** Validate a definition and enforce the mandatory valves. */
function validateDefinition(raw, source) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AidevError(`${source}: top level must be a mapping`);
  }
  const name = raw.name ? String(raw.name) : null;
  if (!name) throw new AidevError(`${source}: name is required`);
  sanitizeName(name);

  const limits = raw.limits || {};
  const num = (v, field, dflt, max) => {
    if (v == null) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new AidevError(`${source}: ${field} must be a positive number`);
    if (n > max) {
      throw new AidevError(
        `${source}: ${field} is ${n}, above the hard ceiling of ${max}. ` +
        'A workflow may lower a limit but never raise it.');
    }
    return n;
  };

  const cost = raw.cost || {};
  // A cost cap is required, not defaulted: the definition must state a budget.
  if (cost.max_tokens == null && cost.max_usd == null) {
    throw new AidevError(
      `${source}: cost.max_tokens or cost.max_usd is required — a workflow must declare a budget ` +
      'before it may run unattended.');
  }

  const allowlist = Array.isArray(raw.commands) ? raw.commands.map(String) : [];
  if (allowlist.length === 0) {
    throw new AidevError(`${source}: commands must list the allowed executables (an empty allowlist runs nothing)`);
  }

  return {
    name,
    description: raw.description ? String(raw.description) : '',
    limits: {
      max_iterations: num(limits.max_iterations, 'limits.max_iterations', LIMITS.maxIterations, LIMITS.maxIterations),
      max_minutes: num(limits.max_minutes, 'limits.max_minutes', LIMITS.maxMinutes, LIMITS.maxMinutes),
      max_identical_failures: num(limits.max_identical_failures, 'limits.max_identical_failures',
        LIMITS.maxIdenticalFailures, LIMITS.maxIdenticalFailures),
    },
    cost: {
      max_tokens: cost.max_tokens == null ? null : Number(cost.max_tokens),
      max_usd: cost.max_usd == null ? null : Number(cost.max_usd),
    },
    commands: allowlist,
    approvals: {
      before_pr: raw.approvals?.before_pr !== false,
      before_destructive: raw.approvals?.before_destructive !== false,
    },
  };
}

function loadDefinition(repoRoot, name) {
  const p = defPath(repoRoot, name);
  const text = cfgMod.readTextIfExists(p);
  if (text == null) throw new AidevError(`no such workflow: ${name} (expected ${path.relative(repoRoot, p)})`);
  let raw;
  try { raw = yaml.parse(text); } catch (e) {
    throw new AidevError(`failed to parse ${path.relative(repoRoot, p)}: ${e.message}`);
  }
  return validateDefinition(raw, path.relative(repoRoot, p).replace(/\\/g, '/'));
}

// -------------------------------------------------------------------------- new

const TEMPLATE_YAML = (name) => `# ${name} — workflow definition
#
# 安全弁は必須です。上限を上げることはできません（下げることは可能）。
name: ${name}
description: ""

limits:
  max_iterations: ${LIMITS.maxIterations}       # 最大 ${LIMITS.maxIterations}
  max_minutes: ${LIMITS.maxMinutes}             # 最大 ${LIMITS.maxMinutes}
  max_identical_failures: ${LIMITS.maxIdenticalFailures}   # 同一失敗が続いたら停止

# 予算は必須。どちらか一方でも可。
cost:
  max_tokens: 200000
  # max_usd: 5

# 実行を許可するコマンド（ベース名で照合）
commands:
  - node
  - npm
  - git

approvals:
  before_pr: true            # PR 作成前に人間の承認
  before_destructive: true   # 破壊的操作の前に人間の承認
`;

const TEMPLATE_STEPS = (name) => `'use strict';
/**
 * ${name} — steps.
 *
 * 宣言的定義ではなく通常の JavaScript です。処理は自由に組めます。
 * ただしこのファイルも承認ハッシュの対象なので、編集すると承認は失効します。
 *
 * @param {object} ctx
 *   ctx.repoRoot   ラッパーリポジトリのルート
 *   ctx.iteration  1 始まりの反復回数
 *   ctx.log(msg)   runs/<id>/ に記録
 *   ctx.run(cmd, args)  commands 許可リストに含まれる場合のみ実行
 * @returns {{ done: boolean, note?: string }}
 */
module.exports = async function steps(ctx) {
  ctx.log(\`iteration \${ctx.iteration}\`);

  // 例: テストを実行し、通ったら終了する
  // const r = await ctx.run('npm', ['test']);
  // if (r.code === 0) return { done: true, note: 'tests pass' };

  return { done: true, note: 'template: nothing to do' };
};
`;

function newWorkflow(ctx) {
  const { repoRoot, flags, positionals } = ctx;
  const name = sanitizeName(positionals[1]);
  const dir = workflowDir(repoRoot, name);
  if (fs.existsSync(dir) && !flags.force) {
    throw new AidevError(`workflow ${name} already exists at ${WORKFLOWS_DIR}/${name} (pass --force to overwrite)`);
  }
  if (flags['dry-run']) {
    ui.ok(`would scaffold ${WORKFLOWS_DIR}/${name}/{workflow.yaml,steps.js}`);
    return EXIT.OK;
  }
  cfgMod.writeFileAtomic(defPath(repoRoot, name), TEMPLATE_YAML(name));
  cfgMod.writeFileAtomic(stepsPath(repoRoot, name), TEMPLATE_STEPS(name));

  ui.heading(`aidev workflow new ${name}`);
  ui.ok(`scaffolded ${WORKFLOWS_DIR}/${name}/`);
  ui.out('');
  ui.info('Next:');
  ui.dim(`    1. edit ${WORKFLOWS_DIR}/${name}/steps.js and workflow.yaml`);
  ui.dim(`    2. git diff                       ← 人間がレビュー`);
  ui.dim(`    3. aidev workflow approve ${name}`);
  ui.dim(`    4. aidev workflow run ${name}`);
  if (flags.json) ui.json({ ok: true, name, dir: `${WORKFLOWS_DIR}/${name}` });
  return EXIT.OK;
}

// ---------------------------------------------------------------------- approve

function approve(ctx) {
  const { repoRoot, flags, positionals } = ctx;
  const name = sanitizeName(positionals[1]);
  const def = loadDefinition(repoRoot, name); // validates the valves too
  const hash = contentHash(repoRoot, name);

  const prior = cfgMod.readJsonIfExists(approvalPath(repoRoot, name));
  if (prior && prior.hash === hash && !flags.force) {
    ui.ok(`${name} is already approved at this exact content (${hash.slice(0, 19)}…).`);
    if (flags.json) ui.json({ ok: true, name, hash, changed: false });
    return EXIT.OK;
  }

  if (flags['dry-run']) {
    ui.ok(`would approve ${name} at ${hash}`);
    return EXIT.OK;
  }

  const record = {
    schemaVersion: 1,
    name,
    hash,
    approvedAt: new Date().toISOString(),
    // Who approved is recorded from the environment; it is an audit note, not
    // an authentication claim.
    approvedBy: process.env.USERNAME || process.env.USER || null,
    limits: def.limits,
    cost: def.cost,
    commands: def.commands,
  };
  cfgMod.writeJsonAtomic(approvalPath(repoRoot, name), record);

  ui.heading(`aidev workflow approve ${name}`);
  ui.ok(`approved at ${hash}`);
  if (prior) ui.dim(`    previous approval ${prior.hash.slice(0, 19)}… is superseded`);
  ui.dim('    Editing workflow.yaml or steps.js invalidates this approval automatically.');
  if (flags.json) ui.json({ ok: true, name, hash, changed: true });
  return EXIT.OK;
}

// -------------------------------------------------------------------------- run

async function runWorkflow(ctx) {
  const { repoRoot, flags, positionals } = ctx;
  const name = sanitizeName(positionals[1]);
  const def = loadDefinition(repoRoot, name);

  // ---- approval gate -------------------------------------------------------
  const approval = cfgMod.readJsonIfExists(approvalPath(repoRoot, name));
  if (!approval) {
    throw new AidevError(
      `workflow ${name} has not been approved. Review it and run "aidev workflow approve ${name}".`);
  }
  const hash = contentHash(repoRoot, name);
  if (approval.hash !== hash) {
    throw new AidevError(
      `workflow ${name} changed after approval.\n` +
      `      approved: ${approval.hash}\n` +
      `      current:  ${hash}\n` +
      `    Review the diff and re-approve with "aidev workflow approve ${name}".`);
  }

  // ---- limits: the definition may lower, the flags may lower further -------
  const maxIterations = Math.min(
    def.limits.max_iterations,
    flags['max-iterations'] ? Number(flags['max-iterations']) : Infinity,
    LIMITS.maxIterations);
  const maxMinutes = Math.min(
    def.limits.max_minutes,
    flags['max-minutes'] ? Number(flags['max-minutes']) : Infinity,
    LIMITS.maxMinutes);
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) throw new AidevError('--max-iterations must be positive');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new AidevError('--max-minutes must be positive');

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(runsDir(repoRoot, name), runId);
  const logLines = [];
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
    if (!flags.json) ui.dim(`    ${line}`);
  };

  if (flags['dry-run']) {
    ui.heading(`aidev workflow run ${name} (dry run)`);
    ui.table([
      ['approved', approval.approvedAt],
      ['hash', `${hash.slice(0, 19)}…`],
      ['max iterations', maxIterations],
      ['max minutes', maxMinutes],
      ['commands', def.commands.join(', ')],
      ['budget', def.cost.max_tokens ? `${def.cost.max_tokens} tokens` : `$${def.cost.max_usd}`],
    ]);
    ui.ok('dry run: the approval is valid and the workflow would execute.');
    return EXIT.OK;
  }

  // ---- the executor handed to steps.js ------------------------------------
  const { execFileSync } = require('child_process');
  const deadline = Date.now() + maxMinutes * 60000;
  const allow = new Set(def.commands.map((c) => String(c).split(/[\\/]/).pop()));

  const runCmd = async (cmd, args = []) => {
    const base = String(cmd).split(/[\\/]/).pop();
    if (!allow.has(base)) {
      throw new AidevError(
        `command "${base}" is not in this workflow's allowlist (${def.commands.join(', ')})`);
    }
    if (Date.now() > deadline) throw new AidevError(`time limit of ${maxMinutes} minutes exceeded`);
    try {
      const out = execFileSync(cmd, args, {
        cwd: repoRoot, encoding: 'utf8', timeout: Math.max(1000, deadline - Date.now()),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
      return { code: e.status == null ? 1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  };

  let steps;
  try {
    // Loaded after the hash check, so only reviewed bytes are ever required().
    steps = require(stepsPath(repoRoot, name));
  } catch (e) {
    throw new AidevError(`could not load steps.js: ${e.message}`);
  }
  if (typeof steps !== 'function') throw new AidevError('steps.js must export a function');

  ui.heading(`aidev workflow run ${name}`);

  // ---- resume from the last unfinished run --------------------------------
  // Iterations already spent are carried forward so that resuming cannot be
  // used to run max_iterations again and again; the limit is per workflow run,
  // not per invocation.
  let priorIterations = 0;
  let resumedFrom = null;
  if (flags.resume) {
    const prior = lastResumableRun(repoRoot, name, hash);
    if (!prior) {
      ui.info('--resume: no unfinished run was found; starting a fresh one.');
    } else if (prior.stale) {
      throw new AidevError(
        `the unfinished run ${prior.runId} was produced by different bytes than the ones approved now. ` +
        'Re-review and re-approve, then start a fresh run rather than resuming unreviewed logic.');
    } else {
      priorIterations = Number(prior.checkpoint.iterations) || 0;
      resumedFrom = prior.runId;
      if (priorIterations >= maxIterations) {
        throw new AidevError(
          `run ${prior.runId} already used ${priorIterations} of ${maxIterations} iterations. ` +
          'Raise --max-iterations deliberately, or start a fresh run.');
      }
      log(`resuming from ${prior.runId} (${priorIterations} iteration(s) already spent): ${prior.checkpoint.stopReason}`);
    }
  }

  log(`run ${runId} starting (max ${maxIterations} iterations, ${maxMinutes} min)`);

  let iteration = priorIterations;
  let done = false;
  let note = '';
  let lastFailure = null;
  let identicalFailures = 0;
  let stopReason = 'completed';

  while (iteration < maxIterations) {
    iteration++;
    if (Date.now() > deadline) { stopReason = `time limit (${maxMinutes} min) reached`; break; }
    let result;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await steps({ repoRoot, iteration, log, run: runCmd, definition: def });
    } catch (e) {
      const sig = String(e.message);
      if (sig === lastFailure) {
        identicalFailures++;
        // Repeating the same failure is the classic runaway loop; stop early.
        if (identicalFailures >= def.limits.max_identical_failures) {
          stopReason = `the same failure repeated ${identicalFailures} times: ${sig}`;
          break;
        }
      } else { lastFailure = sig; identicalFailures = 1; }
      log(`iteration ${iteration} failed: ${sig}`);
      continue;
    }
    if (result && result.done) { done = true; note = result.note || ''; break; }
    note = (result && result.note) || note;
  }
  if (!done && stopReason === 'completed') stopReason = `iteration limit (${maxIterations}) reached`;

  // ---- checkpoint + log ----------------------------------------------------
  // runs/ is gitignored: logs can contain command output, so committing them
  // would be a route for secrets to reach the repository.
  const checkpoint = {
    runId, name, hash, startedAt: logLines[0] ? logLines[0].slice(1, 25) : null,
    finishedAt: new Date().toISOString(),
    iterations: iteration, done, note, stopReason,
    resumedFrom, priorIterations,
  };
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'log.txt'), `${logLines.join('\n')}\n`, 'utf8');
    cfgMod.writeJsonAtomic(path.join(runDir, 'checkpoint.json'), checkpoint);
  } catch (e) { ui.warn(`run artifacts could not be written: ${e.message}`); }

  if (done) ui.ok(`workflow finished after ${iteration} iteration(s)${note ? `: ${note}` : ''}`);
  else {
    ui.warn(`workflow stopped without finishing — ${stopReason}`);
    if (iteration < maxIterations) {
      ui.dim(`    continue where it stopped: aidev workflow run ${name} --resume`);
    }
  }
  ui.dim(`    artifacts: ${WORKFLOWS_DIR}/${name}/runs/${runId}/`);
  if (def.approvals.before_pr) {
    ui.dim('    approvals.before_pr is set: PR creation requires a human, and is not performed here.');
  }

  if (flags.json) ui.json({ ok: done, ...checkpoint });
  return done ? EXIT.OK : EXIT.GENERAL;
}

// ------------------------------------------------------------------------- list

function list(ctx) {
  const { repoRoot, flags } = ctx;
  const base = path.join(repoRoot, WORKFLOWS_DIR);
  let names;
  try {
    names = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { names = []; }

  const rows = names.map((n) => {
    const approval = cfgMod.readJsonIfExists(approvalPath(repoRoot, n));
    let status;
    if (!approval) status = 'not approved';
    else {
      try {
        status = contentHash(repoRoot, n) === approval.hash ? 'approved' : 'CHANGED since approval';
      } catch (e) { status = `broken (${e.message})`; }
    }
    return { name: n, status, approvedAt: approval?.approvedAt || null };
  });

  if (flags.json) { ui.json({ workflows: rows }); return EXIT.OK; }
  ui.heading('aidev workflow list');
  if (rows.length === 0) { ui.dim('    no workflows yet — "aidev workflow new <name>"'); return EXIT.OK; }
  ui.table(rows.map((r) => [r.name, `${r.status}${r.approvedAt ? `  (${r.approvedAt})` : ''}`]));
  return EXIT.OK;
}

async function run(ctx) {
  const sub = ctx.positionals[0];
  if (sub === 'list') return list(ctx);
  if (sub === 'new') return newWorkflow(ctx);
  if (sub === 'approve') return approve(ctx);
  if (sub === 'run') return runWorkflow(ctx);
  throw new AidevError(`unknown subcommand: aidev workflow ${sub || ''} (expected: new, approve, run, list)`);
}

module.exports = {
  run, FLAGS, LIMITS, contentHash, validateDefinition, loadDefinition, sanitizeName,
  lastResumableRun,
  summary: 'カスタムワークフローの作成・承認・実行',
};
