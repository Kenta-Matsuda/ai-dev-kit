'use strict';
/**
 * Git plumbing.
 *
 * Every call goes through execFileSync with an argument array — never a shell
 * string — so branch names, paths and SHAs coming from config or the network
 * cannot inject shell syntax.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPOSITORY_ENV_KEYS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]);

function sanitizedGitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (REPOSITORY_ENV_KEYS.has(key.toUpperCase())) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function isSha(s) {
  return typeof s === 'string' && SHA_RE.test(s.trim());
}

/** Reject anything that could be read as an option or a refspec trick. */
function assertSafeRef(ref, label = 'ref') {
  const s = String(ref == null ? '' : ref);
  if (s === '') throw new Error(`${label} is empty`);
  if (s.startsWith('-')) throw new Error(`${label} must not start with "-": ${s}`);
  if (/[\s~^:?*[\\]/.test(s)) throw new Error(`${label} contains invalid characters: ${s}`);
  if (s.includes('..')) throw new Error(`${label} must not contain "..": ${s}`);
  if (s.endsWith('.lock') || s.endsWith('/')) throw new Error(`invalid ${label}: ${s}`);
  return s;
}

function run(args, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  try {
    const out = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 64 * 1024 * 1024,
      env: sanitizedGitEnv(),
    });
    return { ok: true, stdout: out.toString().trim(), stderr: '', status: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString().trim() : '',
      stderr: err.stderr ? err.stderr.toString().trim() : String(err.message),
      status: typeof err.status === 'number' ? err.status : -1,
    };
  }
}

/** Run and throw on failure. */
function must(args, opts = {}) {
  const r = run(args, opts);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function isRepo(cwd) {
  return run(['rev-parse', '--git-dir'], { cwd }).ok;
}

function canonicalPath(value) {
  try { return fs.realpathSync.native(path.resolve(value)); }
  catch { return path.resolve(value); }
}

/** The canonical worktree root Git resolves for cwd, or null outside a worktree. */
function repoTopLevel(cwd) {
  const r = run(['rev-parse', '--show-toplevel'], { cwd });
  return r.ok && r.stdout ? canonicalPath(r.stdout) : null;
}

function samePath(left, right) {
  const a = canonicalPath(left);
  const b = canonicalPath(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Walk upward for the wrapper root: the dir holding aidev.yaml, .aidev-lock or
 * the eject marker.
 *
 * The marker is included because eject removes .aidev-lock; without it, an
 * ejected repo whose aidev.yaml was also deleted would resolve its root by
 * git toplevel instead, and `aidev check` would miss the marker and start
 * judging the repo again.
 */
function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'aidev.yaml')) ||
        fs.existsSync(path.join(dir, '.aidev-lock')) ||
        fs.existsSync(path.join(dir, '.aidev-ejected'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const r = run(['rev-parse', '--show-toplevel'], { cwd: start });
  if (r.ok && r.stdout) return path.resolve(r.stdout);
  return path.resolve(start);
}

function headSha(cwd) {
  const r = run(['rev-parse', 'HEAD'], { cwd });
  return r.ok && isSha(r.stdout) ? r.stdout : null;
}

function currentBranch(cwd) {
  const r = run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!r.ok) return null;
  return r.stdout === 'HEAD' ? null : r.stdout;
}

/**
 * SHA the superproject records for a submodule.
 *
 * `git ls-tree` is authoritative here: it reports what the wrapper commit
 * points at, which is what a reviewer sees in the PR, independent of whether
 * the working tree happens to be checked out or dirty.
 */
function submoduleSha(repoRoot, subPath = 'src') {
  const r = run(['ls-tree', 'HEAD', '--', subPath], { cwd: repoRoot });
  if (r.ok && r.stdout) {
    const m = r.stdout.match(/^\d+\s+commit\s+([0-9a-f]{40})\s/);
    if (m) return m[1];
  }
  return headSha(path.join(repoRoot, subPath));
}

/** SHA actually checked out inside the submodule working tree. */
function submoduleWorktreeSha(repoRoot, subPath = 'src') {
  return headSha(path.join(repoRoot, subPath));
}

/**
 * Resolve the tracking branch tip on the remote.
 *
 * `ls-remote` is deliberate: it reads the remote without mutating local refs,
 * so a SessionStart freshness check can never corrupt the working tree, and a
 * short timeout keeps the hook inside its budget.
 */
function remoteSha(cwd, remote = 'origin', branch = 'main', timeoutMs = 3000) {
  assertSafeRef(remote, 'remote');
  assertSafeRef(branch, 'branch');
  const r = run(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`],
    { cwd, timeoutMs });
  if (!r.ok || !r.stdout) return { ok: false, sha: null, reason: r.stderr || 'unreachable' };
  const m = r.stdout.split('\n')[0].match(/^([0-9a-f]{40})\s/);
  if (!m) return { ok: false, sha: null, reason: 'unparsable ls-remote output' };
  return { ok: true, sha: m[1], reason: null };
}

function fetch(cwd, remote = 'origin', branch = 'main', timeoutMs = 120000) {
  assertSafeRef(remote, 'remote');
  assertSafeRef(branch, 'branch');
  return run(['fetch', '--no-tags', '--prune', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    { cwd, timeoutMs });
}

function revParse(cwd, ref) {
  assertSafeRef(ref, 'ref');
  const r = run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd });
  return r.ok && isSha(r.stdout) ? r.stdout : null;
}

function commitExists(cwd, sha) {
  if (!isSha(sha)) return false;
  return run(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok;
}

/** True when `ancestor` is reachable from `descendant`. */
function isAncestor(cwd, ancestor, descendant) {
  if (!isSha(ancestor) || !isSha(descendant)) return false;
  if (ancestor === descendant) return true;
  return run(['merge-base', '--is-ancestor', ancestor, descendant], { cwd }).ok;
}

/**
 * List tracked files at a commit with their blob hashes.
 *
 * This is the backbone of stale detection: comparing stored blob ids against
 * the current tree survives GC and force-push, because it never needs the old
 * commit object to exist.
 */
function lsTreeBlobs(cwd, ref = 'HEAD') {
  assertSafeRef(ref, 'ref');
  const r = run(['ls-tree', '-r', '-z', '--full-tree', ref], { cwd });
  if (!r.ok) return null;
  const out = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry) continue;
    const m = entry.match(/^(\d+) (blob|commit|tree) ([0-9a-f]{40})\t(.*)$/s);
    if (!m) continue;
    if (m[2] !== 'blob') continue;
    out.push({ mode: m[1], blob: m[3], path: m[4] });
  }
  return out;
}

function hasUncommittedChanges(cwd) {
  const r = run(['status', '--porcelain'], { cwd });
  // Callers use this as a destructive-operation guard, so an unreadable status
  // must fail closed rather than pretending the worktree is clean.
  return r.ok ? r.stdout.length > 0 : true;
}

module.exports = {
  run, must, isRepo, repoTopLevel, samePath, findRepoRoot, isSha, assertSafeRef,
  headSha, currentBranch, submoduleSha, submoduleWorktreeSha,
  remoteSha, fetch, revParse, commitExists, isAncestor,
  lsTreeBlobs, hasUncommittedChanges,
};
