'use strict';
/**
 * Path normalisation and glob matching.
 *
 * Every policy decision in this kit is a path decision, so this module is
 * security-relevant. Two rules matter above all:
 *
 *   1. `..` is resolved lexically BEFORE matching, so a write to
 *      `knowledge/../.claude/settings.json` is tested as `.claude/settings.json`
 *      and hits the protected list.
 *   2. Windows separators are folded to `/` so the same policy file behaves
 *      identically on Windows, macOS and WSL.
 */

const path = require('path');

/** Fold separators, drop `.`, resolve `..` lexically, strip trailing slash. */
function normalizeRel(p) {
  if (p == null) return '';
  let s = String(p).replace(/\\/g, '/').trim();
  if (s === '') return '';
  // Strip a drive letter or leading slash; callers use toRepoRelative first.
  s = s.replace(/^[A-Za-z]:/, '');
  const absolute = s.startsWith('/');
  const out = [];
  let escaped = 0;
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) { out.push('..'); escaped++; }
      continue;
    }
    out.push(seg);
  }
  const rel = out.join('/');
  return absolute ? `/${rel}` : rel;
}

/** True when a normalised relative path climbs out of the repository. */
function escapesRoot(rel) {
  return rel === '..' || rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(String(rel));
}

/**
 * Convert an arbitrary (absolute or relative) path to a repo-relative one.
 * Returns null when the path resolves outside the repository root, which
 * callers must treat as "not governable" — and therefore deny for writes.
 */
function toRepoRelative(repoRoot, p) {
  if (p == null) return null;
  const raw = String(p).trim();
  if (raw === '') return null;
  const abs = path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel === '') return '.';
  const norm = normalizeRel(rel);
  if (escapesRoot(norm)) return null;
  return norm;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentToRegex(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }
  return out;
}

const cache = new Map();

/**
 * Compile a glob to a RegExp.
 *
 * Semantics:
 *   `*`      one path segment, partially
 *   `?`      one character, not `/`
 *   `**`     zero or more whole segments
 *   `a/**`   matches `a` itself as well as everything beneath it, so that
 *            `.claude/**` protects the directory and not only its contents.
 */
function globToRegex(pattern) {
  const key = String(pattern);
  const hit = cache.get(key);
  if (hit) return hit;
  const norm = normalizeRel(key);
  const segs = norm.split('/').filter((s) => s !== '');
  let re = '^';
  let needSep = false;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const isLast = i === segs.length - 1;
    if (seg === '**') {
      if (isLast) {
        re += needSep ? '(?:/.*)?' : '.*';
        needSep = false;
      } else if (needSep) {
        re += '(?:/[^/]*)*';
      } else {
        re += '(?:[^/]*/)*';
        needSep = false;
      }
      continue;
    }
    if (needSep) re += '/';
    re += segmentToRegex(seg);
    needSep = true;
  }
  re += '$';
  const compiled = new RegExp(re);
  cache.set(key, compiled);
  return compiled;
}

/** Match one already-normalised repo-relative path against one glob. */
function matches(pattern, rel) {
  return globToRegex(pattern).test(normalizeRel(rel));
}

/** Match against a list; returns the first matching pattern or null. */
function firstMatch(patterns, rel) {
  if (!patterns) return null;
  const norm = normalizeRel(rel);
  for (const p of patterns) {
    if (p == null || p === '') continue;
    if (globToRegex(p).test(norm)) return p;
  }
  return null;
}

function matchesAny(patterns, rel) {
  return firstMatch(patterns, rel) !== null;
}

/** Apply include/exclude the way `package.include` / `package.exclude` do. */
function isIncluded(rel, include, exclude) {
  const norm = normalizeRel(rel);
  if (include && include.length > 0 && !matchesAny(include, norm)) return false;
  if (exclude && exclude.length > 0 && matchesAny(exclude, norm)) return false;
  return true;
}

module.exports = {
  normalizeRel,
  escapesRoot,
  toRepoRelative,
  globToRegex,
  matches,
  matchesAny,
  firstMatch,
  isIncluded,
};
