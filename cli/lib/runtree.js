'use strict';
/**
 * Where a workflow run works: a git worktree of its own, on a branch of its
 * own, outside the PKG checkout the person works in.
 *
 *   branch     `aidev/<workflow>` — one per workflow, reused by every run of
 *              it, so a run builds on what the last one left and its pull
 *              request is updated rather than duplicated. `--dated` makes a
 *              fresh `aidev/<workflow>-<yyyymmddHHMM>` instead.
 *   worktree   `<AIDEV_HOME>/worktrees/<pkg>/<branch with / as ->`, made
 *              from the branch (or from the base when the branch is new) and
 *              kept after the run: the run's record, notes and reports live
 *              in it, and `--resume` continues there.
 *
 * The worktree is outside the PKG on purpose: a test runner, linter or
 * compiler started in the PKG must not find a second copy of the sources.
 * What git ignores (node_modules, .env, build output) is not in a new
 * worktree; a workflow that needs it installs it in a command step.
 *
 * One run at a time per worktree: a lock in the worktree's git directory
 * names the process that holds it, and a lock whose process is gone is taken over.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AidevError } = require('./errors');
const gitMod = require('./git');
const homeMod = require('./home');

const BRANCH_PREFIX = 'aidev/';
const LOCK_FILE = 'aidev-run.lock';

/** The branch a run of `name` works on: one per workflow, or a dated one. */
function branchFor(name, { dated = false, now = new Date() } = {}) {
  if (!dated) return `${BRANCH_PREFIX}${name}`;
  return `${BRANCH_PREFIX}${name}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

/** This PKG's directory of worktrees: its name and a hash of its path, so two clones never share one. */
function worktreesDir(repoRoot, env = process.env) {
  const real = (() => { try { return fs.realpathSync(repoRoot); } catch { return path.resolve(repoRoot); } })();
  const key = `${path.basename(real).replace(/[^A-Za-z0-9._-]/g, '_')}-${crypto.createHash('sha256').update(real).digest('hex').slice(0, 8)}`;
  return path.join(homeMod.home(env), 'worktrees', key);
}

/** The worktrees of this repository: [{ path, branch (short name or null), head }]. */
function listWorktrees(repoRoot) {
  const r = gitMod.run(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of String(r.stdout || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), branch: null, head: null }; out.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}

/**
 * The roots run records and estimate records may be under: `repoRoot`, the
 * main checkout, and every worktree on an aidev/ branch (from any of them,
 * git lists them all).
 */
function runRoots(repoRoot) {
  const roots = [path.resolve(repoRoot)];
  for (const [i, w] of listWorktrees(repoRoot).entries()) {
    if (i > 0 && (!w.branch || !w.branch.startsWith(BRANCH_PREFIX))) continue;
    if (!fs.existsSync(w.path) || roots.some((r) => gitMod.samePath(r, w.path))) continue;
    roots.push(w.path);
  }
  return roots;
}

function branchExists(repoRoot, branch) {
  return gitMod.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot }).ok;
}

/**
 * Uncommitted changes in a worktree under `globs` (what the workflow's steps
 * may write; anything else there is no step's work). Ignored files do not count.
 */
function dirtyEntries(root, globs = []) {
  if (!globs.length) return [];
  const r = gitMod.run(['status', '--porcelain', '--untracked-files=all', '--', ...globs.map((g) => `:(glob)${g}`)], { cwd: root });
  if (!r.ok) throw new AidevError(`git status failed in ${root}: ${r.stderr}`);
  return String(r.stdout || '').split('\n').filter((l) => l.trim());
}

/**
 * Make (or find) the worktree of `branch` and bring it to where a run starts.
 *
 *   new run   the worktree must have no uncommitted change where the
 *             workflow writes (`writable`). A new branch
 *             starts at `base`. An existing one is moved to `base` when all
 *             its commits are in it already (its last pull request was
 *             merged), and otherwise has `base` merged in, so it carries the
 *             approved definition and keeps the work of the runs before.
 *   resume    the worktree is used as it is (made again from the branch
 *             if it was removed); the caller puts back what the stopped step
 *             left uncommitted.
 *
 * Returns { root, branch, created, synced: 'new'|'moved'|'merged'|'current'|null }.
 */
function prepare(repoRoot, { branch, base, resume = false, writable = [], env = process.env }) {
  gitMod.assertSafeRef(branch, 'branch');
  const found = listWorktrees(repoRoot).find((w) => w.branch === branch);
  let root = found && fs.existsSync(found.path) ? found.path : null;
  let created = false;
  if (!root) {
    gitMod.run(['worktree', 'prune'], { cwd: repoRoot });
    const dir = path.join(worktreesDir(repoRoot, env), branch.split('/').join('-'));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      throw new AidevError(`${dir} exists but is not a worktree of this repository; remove it, then run again`);
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const exists = branchExists(repoRoot, branch);
    if (resume && !exists) throw new AidevError(`branch ${branch} no longer exists, so the run cannot be resumed; start a new run`);
    const add = exists
      ? gitMod.run(['worktree', 'add', dir, branch], { cwd: repoRoot })
      : gitMod.run(['worktree', 'add', '-b', branch, dir, base], { cwd: repoRoot });
    if (!add.ok) throw new AidevError(`could not make the worktree ${dir} for ${branch}: ${add.stderr}`);
    root = dir;
    created = true;
    if (!exists) return { root, branch, created, synced: 'new' };
  }
  if (resume) return { root, branch, created, synced: null };

  const dirty = dirtyEntries(root, writable);
  if (dirty.length) {
    throw new AidevError(
      `the worktree of ${branch} (${root}) has uncommitted changes, left by a run that stopped in the middle of a step:\n` +
      `      ${dirty.slice(0, 5).join('\n      ')}${dirty.length > 5 ? '\n      …' : ''}\n` +
      '      Continue that run with --resume last, or throw the changes away first:\n' +
      `      git -C "${root}" reset --hard && git -C "${root}" clean -fd`);
  }
  const tip = gitMod.headSha(root);
  if (tip === base || gitMod.isAncestor(root, base, tip)) return { root, branch, created, synced: 'current' };
  if (gitMod.isAncestor(root, tip, base)) {
    const r = gitMod.run(['reset', '--hard', base], { cwd: root });
    if (!r.ok) throw new AidevError(`could not move ${branch} to ${base.slice(0, 12)}: ${r.stderr}`);
    return { root, branch, created, synced: 'moved' };
  }
  const m = gitMod.run(['merge', '--no-edit', '-m', `aidev: bring ${base.slice(0, 12)} into ${branch}`, base], { cwd: root });
  if (!m.ok) {
    gitMod.run(['merge', '--abort'], { cwd: root });
    throw new AidevError(
      `${branch} has work that conflicts with ${base.slice(0, 12)}; resolve it in ${root} (git merge ${base.slice(0, 12)}), ` +
      'or start on a branch of its own with --dated');
  }
  return { root, branch, created, synced: 'merged' };
}

/** The lock file of a worktree (in its own git directory, so it is never committed or seen). */
function lockPath(root) {
  const r = gitMod.run(['rev-parse', '--absolute-git-dir'], { cwd: root });
  if (!r.ok) throw new AidevError(`${root} is not a git worktree: ${r.stderr}`);
  return path.join(r.stdout.trim(), LOCK_FILE);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Hold the worktree for this run; returns release(). Refuses while another live process holds it. */
function lock(root, { runId }) {
  const file = lockPath(root);
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, runId, at: new Date().toISOString() }), { flag: 'wx' });
      return () => { try { fs.rmSync(file, { force: true }); } catch { /* gone already */ } };
    } catch (e) {
      if (e.code !== 'EEXIST') throw new AidevError(`could not lock ${root}: ${e.message}`);
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
      if (held && alive(held.pid)) {
        throw new AidevError(`another run (${held.runId || '?'}, process ${held.pid}) is working in ${root}; wait for it to end`);
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new AidevError(`could not lock ${root}`);
}

module.exports = {
  BRANCH_PREFIX, branchFor, worktreesDir, listWorktrees, runRoots, branchExists, dirtyEntries, prepare, lock, lockPath,
};
