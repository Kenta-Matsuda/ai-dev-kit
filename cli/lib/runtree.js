'use strict';
/**
 * Where a workflow run works: a git worktree of its own, on a branch of its
 * own, outside the PKG checkout the person works in.
 *
 *   branch     `aidev/<workflow>` — one per workflow, reused by every run of
 *              it, so a run builds on what the last one left and its pull
 *              request is updated rather than duplicated. `--dated` makes a
 *              fresh `aidev/<workflow>-<yyyymmddHHMM>` instead.
 *   worktree   `<AIDEV_HOME>/worktrees/<pkg>-<hash>/<branch with / as ->` (<hash>:
 *              8 hex of the clone's real path, so two clones never share one), made
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
const TRIAL_SUFFIX = '.trial';
const LOCK_FILE = 'aidev-run.lock';

/**
 * The branch a run of `name` works on: one per workflow, or a dated one. A
 * trial run (`--trial`) has `aidev/<name>.trial`: a workflow name cannot
 * hold a dot, so it never meets the branch of this or any other workflow.
 */
function branchFor(name, { dated = false, trial = false, now = new Date() } = {}) {
  const base = `${BRANCH_PREFIX}${name}${trial ? TRIAL_SUFFIX : ''}`;
  if (!dated) return base;
  return `${base}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
}

/** Is this the branch of a trial run (of any workflow)? */
function isTrialBranch(branch) {
  return typeof branch === 'string' && branch.startsWith(BRANCH_PREFIX) && /\.trial(-\d{12})?$/.test(branch);
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
 * may write; anything else there is no step's work). Ignored files do not
 * count, and neither does what the run never commits (`exclude`: the kit's
 * never-committed list and the workflow's `never_commit`).
 */
function dirtyEntries(root, globs = [], exclude = []) {
  if (!globs.length) return [];
  const entries = gitMod.statusEntries(root, { pathspecs: globs.map((g) => `:(glob)${g}`) });
  if (!entries) throw new AidevError(`git status failed in ${root}`);
  const pathsMod = require('./paths');
  return entries.filter((e) => !(e.xy === '??' && pathsMod.firstMatch(exclude, e.path))).map((e) => `${e.xy} ${e.path}`);
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
 *   fresh     (a trial) the branch is moved to `base` whatever it holds: a
 *             trial never pushes, so nothing on it is kept, and every trial
 *             starts from the commit the person has checked out. The caller
 *             clears what the last trial left uncommitted where the steps write.
 *   resume    the worktree is used as it is (made again from the branch
 *             if it was removed); the caller puts back what the stopped step
 *             left uncommitted.
 *
 * Returns { root, branch, created, synced: 'new'|'moved'|'merged'|'current'|'reset'|null }.
 */
function prepare(repoRoot, { branch, base, resume = false, fresh = false, writable = [], exclude = [], env = process.env }) {
  gitMod.assertSafeRef(branch, 'branch');
  const all = listWorktrees(repoRoot);
  const found = all.find((w) => w.branch === branch);
  // The person's own checkout (the first entry git lists, or wherever this
  // command runs) is never a run's worktree: a run resets and cleans its
  // worktree, and that must not be anyone's working copy.
  if (found && (all.indexOf(found) === 0 || gitMod.samePath(found.path, repoRoot))) {
    throw new AidevError(`${branch} is checked out in ${found.path}, and a run never works in that checkout; check out another branch there, or run with --dated`);
  }
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
  // A worktree another live run holds is not moved or cleaned: the caller
  // takes the lock right after this, and would be refused there anyway.
  if (!created) {
    const held = lockHolder(root);
    if (held) throw new AidevError(`another run (${held.runId || '?'}, process ${held.pid}) is working in ${root}; wait for it to end`);
  }
  if (resume) return { root, branch, created, synced: null };
  if (fresh) {
    const r = gitMod.run(['reset', '--hard', base], { cwd: root });
    if (!r.ok) throw new AidevError(`could not move ${branch} to ${base.slice(0, 12)}: ${r.stderr}`);
    return { root, branch, created, synced: 'reset' };
  }

  const dirty = dirtyEntries(root, writable, exclude);
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

/**
 * The files git ignores in `checkout` that match `globs`, one by one, as
 * `provide:` names them. Tracked files and untracked files git does not
 * ignore are not listed: they are the checkout's own state, which a run
 * never starts from. Git's own glob match is checked again with the kit's
 * matcher, so a glob brings exactly the files it names (git would also list
 * a whole ignored directory for a glob that matches one file in it).
 */
function ignoredFiles(checkout, globs) {
  if (!globs.length) return { files: [], repos: [] };
  const pathsMod = require('./paths');
  const r = gitMod.run(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...globs.map((g) => `:(glob)${g}`)], { cwd: checkout });
  if (!r.ok) throw new AidevError(`git ls-files failed in ${checkout}: ${r.stderr}`);
  const out = { files: [], repos: [] };
  for (const p of String(r.stdout || '').split('\0').filter(Boolean)) {
    // A slash-terminated entry is a directory git does not look into: a nested repository.
    if (p.endsWith('/')) { if (globs.some((g) => pathsMod.matches(g, p))) out.repos.push(p); continue; }
    if (globs.some((g) => pathsMod.matches(g, p))) out.files.push(p);
  }
  return out;
}

/**
 * Copy what `provide:` names from the checkout into the worktree: the files
 * git ignores there (a spec sheet kept out of git, test data), file by file,
 * never a tracked file (the run starts from the commit, not the checkout's
 * edits), never a secret (`secrets`), never the kit's own state. Existing
 * files in the worktree are overwritten. Returns { copied: [rel], skipped: [{ rel, why }], missing: [glob] }.
 */
function provide(checkout, root, globs, { secrets = [] } = {}) {
  const out = { copied: [], skipped: [], missing: [] };
  if (!globs.length) return out;
  const pathsMod = require('./paths');
  const under = (rel) => {
    const head = rel.split('/')[0];
    return head === '.git' || head === '.aidev';
  };
  const done = new Set();
  const { SECRET_FILE_RE } = require('./workflow');
  const layout = require('./layout');
  for (const g of globs) {
    let found;
    try { found = ignoredFiles(checkout, [g]); } catch (e) { throw new AidevError(`provide: ${g}: ${e.message}`); }
    for (const repo of found.repos) out.skipped.push({ rel: repo, why: 'a nested git repository (git does not list its files)' });
    if (!found.files.length) { out.missing.push(g); continue; }
    for (const rel of found.files) {
      if (done.has(rel)) continue;
      done.add(rel);
      if (under(rel) || layout.isKitManaged(rel)) { out.skipped.push({ rel, why: 'the kit\'s own state' }); continue; }
      const secret = pathsMod.firstMatch(secrets, rel);
      if (secret) { out.skipped.push({ rel, why: `a secret path (secrets_paths: ${secret})` }); continue; }
      if (SECRET_FILE_RE.test(rel.split('/').pop())) { out.skipped.push({ rel, why: 'a credential file, by its name' }); continue; }
      const from = path.join(checkout, ...rel.split('/'));
      const to = path.join(root, ...rel.split('/'));
      try {
        let stat = null;
        try { stat = fs.lstatSync(from); } catch { stat = null; }
        if (!stat || !stat.isFile()) { out.skipped.push({ rel, why: stat && stat.isSymbolicLink() ? 'a symbolic link' : 'not a file' }); continue; }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      } catch (e) { throw new AidevError(`provide: could not copy ${rel} into the worktree: ${e.message}`); }
      out.copied.push(rel);
    }
  }
  return out;
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

/** The live run holding a worktree's lock ({ pid, runId }), or null (no lock, or its process is gone). */
function lockHolder(root) {
  let held = null;
  try { held = JSON.parse(fs.readFileSync(lockPath(root), 'utf8')); } catch { held = null; }
  return held && alive(held.pid) ? held : null;
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
      const held = lockHolder(root);
      if (held) throw new AidevError(`another run (${held.runId || '?'}, process ${held.pid}) is working in ${root}; wait for it to end`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new AidevError(`could not lock ${root}`);
}

module.exports = {
  BRANCH_PREFIX, TRIAL_SUFFIX, branchFor, isTrialBranch, worktreesDir, listWorktrees, runRoots, branchExists, dirtyEntries, ignoredFiles, provide, prepare, lock, lockHolder, lockPath,
};
