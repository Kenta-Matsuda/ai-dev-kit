'use strict';
/**
 * `AIDEV_HOME`: the per-machine area the CLI keeps outside any PKG.
 *
 *   registry.json   every PKG clone `aidev init` has set up on this machine,
 *                   so `aidev update` can list which still carry older templates
 *   cache/          the update check and other best-effort caches
 *
 * The kit checkout that provides the running CLI is *not* here: the installer
 * points the launcher at wherever the kit was cloned (`installRoot`). Keeping
 * the two apart means a reinstall to a new directory loses nothing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJsonIfExists, writeJsonAtomic, nowIso, loadLock } = require('./config');
const git = require('./git');
const { AidevError } = require('./errors');

function defaultHome() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ai-dev-kit');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'ai-dev-kit');
}

function home(env = process.env) {
  return env.AIDEV_HOME ? path.resolve(env.AIDEV_HOME) : defaultHome();
}

function registryPath(env = process.env) { return path.join(home(env), 'registry.json'); }

function readRegistry(env = process.env) {
  const doc = readJsonIfExists(registryPath(env));
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.packages)) {
    return { schemaVersion: 1, packages: [] };
  }
  return doc;
}

function writeRegistry(doc, env = process.env) {
  fs.mkdirSync(home(env), { recursive: true });
  writeJsonAtomic(registryPath(env), doc);
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** Record (or refresh) one PKG clone. */
function registerPackage(repoRoot, { name, remote = null, kitCommit = null } = {}, env = process.env) {
  const reg = readRegistry(env);
  const entry = {
    name: name || path.basename(repoRoot),
    path: path.resolve(repoRoot),
    remote,
    kitCommit,
    registeredAt: nowIso(),
  };
  const idx = reg.packages.findIndex((p) => p && samePath(p.path, repoRoot));
  if (idx >= 0) {
    entry.registeredAt = reg.packages[idx].registeredAt || entry.registeredAt;
    entry.updatedAt = nowIso();
    reg.packages[idx] = entry;
  } else {
    reg.packages.push(entry);
  }
  writeRegistry(reg, env);
  return entry;
}

function unregisterPackage(repoRoot, env = process.env) {
  const reg = readRegistry(env);
  const before = reg.packages.length;
  reg.packages = reg.packages.filter((p) => !(p && samePath(p.path, repoRoot)));
  if (reg.packages.length !== before) writeRegistry(reg, env);
  return before !== reg.packages.length;
}

/**
 * A package named on the command line: a registry name, or a directory. A
 * name that several registered packages share needs the path instead.
 */
function resolvePackage(ref, env = process.env) {
  const s = String(ref == null ? '' : ref).trim();
  if (!s) return null;
  const reg = readRegistry(env);
  const byName = reg.packages.filter((p) => p && p.name === s && typeof p.path === 'string' && fs.existsSync(p.path));
  if (byName.length === 1) return byName[0].path;
  if (byName.length > 1) {
    throw new AidevError(`${s} names ${byName.length} registered packages (${byName.map((p) => p.path).join(', ')}); pass the path instead`);
  }
  const abs = path.resolve(s);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  const names = reg.packages.map((p) => p && p.name).filter(Boolean);
  throw new AidevError(`${s} is neither a registered package nor a directory${names.length ? ` (registered: ${names.join(', ')})` : ''}`);
}

/** Registered clones that still exist on disk, plus the ones that vanished. */
function listPackages(env = process.env) {
  const reg = readRegistry(env);
  const present = [];
  const missing = [];
  for (const p of reg.packages) {
    if (!p || typeof p.path !== 'string') continue;
    if (fs.existsSync(path.join(p.path, 'aidev.yaml'))) present.push(p);
    else missing.push(p);
  }
  return { present, missing };
}

/**
 * The kit commit whose templates this package last took (`aidev init` or
 * `aidev sync tools`): the package's own record first, the registry second.
 */
function appliedKitCommit(entry) {
  let lock = null;
  try { lock = loadLock(entry.path); } catch { lock = null; }
  return (lock && lock.kitCommit) || entry.kitCommit || null;
}

// --------------------------------------------------------- kit developer

const DEVELOPER_REL = 'developer.json';

function developerPath(env = process.env) { return path.join(home(env), DEVELOPER_REL); }

/**
 * Is this machine a kit developer's? Only then does the Stop hook ask a
 * session to reflect on itself and `npm run evolve --` turn reflections into a
 * kit PR. The marker lives here, outside every PKG, so nothing distributed
 * to a PKG team can switch it on. `AIDEV_KIT_DEVELOPER=1` is the same switch
 * for environments without a writable home.
 */
function readDeveloper(env = process.env) {
  if (env.AIDEV_KIT_DEVELOPER === '1') return { enabled: true, autoEvolve: false, source: 'AIDEV_KIT_DEVELOPER' };
  const doc = readJsonIfExists(developerPath(env));
  if (!doc || doc.enabled !== true) return { enabled: false, autoEvolve: false, source: null };
  return { enabled: true, autoEvolve: doc.autoEvolve === true, source: DEVELOPER_REL, enabledAt: doc.enabledAt || null };
}

function isKitDeveloper(env = process.env) { return readDeveloper(env).enabled; }

function setDeveloper({ enabled, autoEvolve = false }, env = process.env) {
  const file = developerPath(env);
  if (!enabled) { try { fs.unlinkSync(file); } catch { /* absent */ } return { enabled: false, autoEvolve: false }; }
  const doc = { schemaVersion: 1, enabled: true, autoEvolve: !!autoEvolve, enabledAt: nowIso() };
  fs.mkdirSync(home(env), { recursive: true });
  writeJsonAtomic(file, doc);
  return doc;
}

// ------------------------------------------------------------ update check

const UPDATE_CACHE_REL = path.join('cache', 'update-check.json');
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3000;

/**
 * Is a newer kit available? Cached for a day and bounded to a few seconds,
 * because this runs before ordinary commands and must never make them slow or
 * fail. Returns { newer, localSha, remoteSha, cached } or null when unknown.
 */
function checkForUpdate(installRoot, { env = process.env, force = false, now = Date.now() } = {}) {
  if (!installRoot || !git.isRepo(installRoot)) return null;
  const file = path.join(home(env), UPDATE_CACHE_REL);
  const localSha = git.headSha(installRoot);
  if (!localSha) return null;

  if (!force) {
    const cached = readJsonIfExists(file);
    if (cached && cached.checkedAt && cached.localSha === localSha) {
      const age = now - Date.parse(cached.checkedAt);
      if (Number.isFinite(age) && age >= 0 && age < UPDATE_CHECK_TTL_MS) {
        return { newer: !!cached.newer, localSha, remoteSha: cached.remoteSha || null, cached: true };
      }
    }
  }

  const res = git.remoteSha(installRoot, 'origin', 'main', UPDATE_CHECK_TIMEOUT_MS);
  if (!res.ok) {
    // Unknown: do not cache a failure as "no update", just try again next time.
    return null;
  }
  // Newer only when origin/main is strictly ahead of the local checkout. A
  // checkout that is ahead (a maintainer's branch) or diverged is not "behind".
  const newer = res.sha !== localSha && git.isAncestor(installRoot, localSha, res.sha) === true;
  const entry = { checkedAt: new Date(now).toISOString(), localSha, remoteSha: res.sha, newer };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeJsonAtomic(file, entry); } catch { /* best effort */ }
  return { newer, localSha, remoteSha: res.sha, cached: false };
}

module.exports = {
  home, defaultHome, registryPath, readRegistry, writeRegistry,
  registerPackage, unregisterPackage, listPackages, resolvePackage, appliedKitCommit,
  developerPath, readDeveloper, isKitDeveloper, setDeveloper,
  checkForUpdate, UPDATE_CHECK_TTL_MS,
};
