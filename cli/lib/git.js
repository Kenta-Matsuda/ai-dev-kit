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
 * Walk upward for the PKG root: the dir holding aidev.yaml or a `.aidev/`
 * directory (which an ejected repository keeps, with its marker inside).
 * Falls back to the git worktree root, then to the start directory.
 */
function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'aidev.yaml')) || fs.existsSync(path.join(dir, '.aidev'))) {
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

/** URL of a remote, or null. */
function remoteUrl(cwd, remote = 'origin') {
  const r = run(['remote', 'get-url', remote], { cwd });
  return r.ok && r.stdout ? r.stdout : null;
}

/**
 * Did anything outside `excludes` change between two commits?
 *
 * The Wiki describes the package's source, not the kit's own files, so a
 * commit that only adds `.aidev/knowledge/` or updates `.claude/` must not
 * count as "the code moved". Returns null when either commit is unknown.
 */
function treeChanged(cwd, a, b, excludes = []) {
  if (!isSha(a) || !isSha(b)) return null;
  if (a === b) return false;
  const spec = ['--', '.', ...excludes.map((e) => `:(exclude)${e}`)];
  const r = run(['diff', '--quiet', a, b, ...spec], { cwd });
  if (r.ok) return false;
  if (r.status === 1) return true;
  return null;
}

/** The merge base of two commits, or null when they share no history. */
function mergeBase(cwd, a, b) {
  if (!a || !b) return null;
  const r = run(['merge-base', a, b], { cwd });
  return r.ok && isSha(r.stdout) ? r.stdout : null;
}

/**
 * Add a detached worktree at `dir` for `ref`. Used by sync so the Wiki can be
 * regenerated for the tracking branch without touching the developer's own
 * checkout. Returns { ok, stderr }.
 */
function worktreeAdd(cwd, dir, ref) {
  assertSafeRef(ref, 'ref');
  return run(['worktree', 'add', '--detach', dir, ref], { cwd });
}

function worktreeRemove(cwd, dir) {
  const r = run(['worktree', 'remove', '--force', dir], { cwd });
  run(['worktree', 'prune'], { cwd });
  return r;
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

/**
 * The content of one file at a ref (`git show ref:path`), or null when the
 * ref or the path does not exist. LF-normalised so a comparison with the
 * working file does not depend on autocrlf.
 */
function showFile(cwd, ref, rel) {
  assertSafeRef(ref, 'ref');
  const p = String(rel).replace(/\\/g, '/');
  if (p.startsWith('-') || p.includes('..')) throw new Error(`invalid path: ${p}`);
  // Not through run(): that trims the output, and a byte comparison with the
  // working file needs the content exactly as stored.
  try {
    const out = execFileSync('git', ['show', `${ref}:${p}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, env: sanitizedGitEnv(),
    });
    return out.replace(/\r\n/g, '\n');
  } catch { return null; }
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

/**
 * Parsed `git status --porcelain -z` entries: [{ xy, path, from }] (`from`:
 * the original path of a rename or copy, else null). Untracked files are
 * listed one by one; `pathspecs` narrows the walk (git pathspecs, magic
 * allowed). Returns null when the status cannot be read; the output is
 * deliberately not trimmed, because the two-character XY prefix of an
 * unstaged change starts with a space.
 */
function statusEntries(cwd, { pathspecs = [] } = {}) {
  let out;
  try {
    out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '-z', ...(pathspecs.length ? ['--', ...pathspecs] : [])], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: sanitizedGitEnv(),
    });
  } catch { return null; }
  const fields = String(out).split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const e = fields[i];
    if (!e || e.length < 4) continue;
    const xy = e.slice(0, 2);
    // A rename/copy entry is followed by its original path in the next field.
    const from = /[RC]/.test(xy) ? (fields[++i] || null) : null;
    entries.push({ xy, path: e.slice(3), from });
  }
  return entries;
}

function hasUncommittedChanges(cwd) {
  const r = run(['status', '--porcelain'], { cwd });
  // Callers use this as a destructive-operation guard, so an unreadable status
  // must fail closed rather than pretending the worktree is clean.
  return r.ok ? r.stdout.length > 0 : true;
}

module.exports = {
  run, must, isRepo, repoTopLevel, samePath, findRepoRoot, isSha, assertSafeRef,
  headSha, currentBranch, remoteUrl, mergeBase, treeChanged, worktreeAdd, worktreeRemove,
  remoteSha, fetch, revParse, showFile, commitExists, isAncestor,
  lsTreeBlobs, hasUncommittedChanges, statusEntries,
};
