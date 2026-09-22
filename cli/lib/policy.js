'use strict';
/**
 * The write-authorisation decision.
 *
 * Every write flows through `decide()`. Precedence, highest first:
 *
 *   1. Paths outside the repository        → deny (ungovernable)
 *   2. Secrets and protected paths         → deny, unconditionally, even during a sync
 *   3. Consistency error + no sync lease   → deny everything
 *   4. Consistency error + sync lease      → allow knowledge/** only
 *   5. writable paths                      → allow (Wiki, workflows, aidev.yaml)
 *   6. per-agent grant                     → allow when the CLI started this
 *                                            agent (AIDEV_AGENT) and the policy's
 *                                            agents.<name>.writable covers the path
 *                                            (and the branch, when one is required)
 *   7. read_only paths                     → deny
 *   8. otherwise                           → allow
 *
 * Rule 2 sitting above everything else is what makes neither the sync lease
 * nor a per-agent grant capable of widening into the kit's own control
 * surface. The agent name comes from the CLI's own environment for the child
 * process, never from anything the agent writes, so it cannot be claimed.
 */

const pathsMod = require('./paths');
const leasesMod = require('./leases');
const stateMod = require('./state');
const gitMod = require('./git');
const { ALWAYS_PROTECTED, DEFAULT_POLICY_SCOPES } = require('./config');

const DECISION = { ALLOW: 'allow', DENY: 'deny' };

function allow(reason, extra = {}) {
  return { decision: DECISION.ALLOW, reason, ...extra };
}
function deny(reason, extra = {}) {
  return { decision: DECISION.DENY, reason, ...extra };
}

/**
 * Decide whether `targetPath` may be written.
 *
 * `state` may be supplied by the caller to avoid recomputation; when omitted a
 * local-only state is computed (never touching the network, because the guard
 * runs inside a hook's time budget).
 */
function decide(repoRoot, targetPath, {
  config = null, policy = null, state = null, now = Date.now(),
  agent = process.env.AIDEV_AGENT || null,
} = {}) {
  const rel = pathsMod.toRepoRelative(repoRoot, targetPath);
  if (rel == null) {
    return deny(
      `path resolves outside the repository: ${targetPath}`,
      { rule: 'outside-repo', path: String(targetPath) });
  }
  if (rel === '.') {
    return deny('refusing to write the repository root itself', { rule: 'outside-repo', path: rel });
  }

  const pol = policy || { protected: [...ALWAYS_PROTECTED], ...DEFAULT_POLICY_SCOPES };
  const secretGlobs = config?.secrets_paths || [];

  // ---- 2. secrets and protected paths -------------------------------------
  const secretHit = pathsMod.firstMatch(secretGlobs, rel);
  if (secretHit) {
    return deny(
      `"${rel}" is a secret path (secrets_paths: ${secretHit}) and is never writable`,
      { rule: 'secrets', path: rel, pattern: secretHit });
  }
  const protHit = pathsMod.firstMatch(pol.protected, rel);
  if (protHit) {
    return deny(
      `"${rel}" is protected (${protHit}). Kit-owned files are changed by PR to the central kit, ` +
      'and policy files are placed by the CLI after human approval.',
      { rule: 'protected', path: rel, pattern: protHit });
  }

  // ---- 3 & 4. consistency gate --------------------------------------------
  const st = state || stateMod.computeState(repoRoot, config, { checkRemote: false });
  if (st.severity === stateMod.SEVERITY.ERROR) {
    const lease = leasesMod.readSyncLease(repoRoot);
    const ev = leasesMod.evaluateLease(lease, now);
    if (!ev.valid) {
      return deny(
        `Wiki consistency error (${st.message}) and no valid sync lease is held` +
        (lease ? ` (existing lease is ${ev.reason})` : '') +
        '. All writes are blocked; run "aidev knowledge update" (or "aidev knowledge update --abort" to discard an interrupted publish).',
        { rule: 'consistency-no-lease', path: rel, state: st.severity });
    }
    const syncWritable = pol.writable_during_sync && pol.writable_during_sync.length > 0
      ? pol.writable_during_sync : [...DEFAULT_POLICY_SCOPES.writable_during_sync];
    const hit = pathsMod.firstMatch(syncWritable, rel);
    if (hit) {
      return allow(
        `sync lease held; "${rel}" is within writable_during_sync (${hit})`,
        { rule: 'sync-lease', path: rel, pattern: hit, lease: { kind: 'sync', targetSha: lease.targetSha } });
    }
    return deny(
      `sync in progress: only ${syncWritable.join(', ')} may be written until the Wiki is regenerated ` +
      `(attempted "${rel}")`,
      { rule: 'sync-lease-scope', path: rel });
  }

  // ---- 5. explicitly writable regions -------------------------------------
  // The Wiki, workflows and aidev.yaml are the places an agent is meant to
  // write; they sit inside the read-only PKG, so they are checked first.
  const wHit = pathsMod.firstMatch(pol.writable || [], rel);
  if (wHit) {
    return allow(`"${rel}" is writable by policy (${wHit})`, { rule: 'writable', path: rel, pattern: wHit });
  }

  // ---- 6. read-only regions ------------------------------------------------
  // ---- 6. per-agent grant --------------------------------------------------
  // Only for an agent the CLI started: AIDEV_AGENT is set in that child's
  // environment by agent.runAgent and inherited by the hook. A grant may be
  // tied to a branch, so that issue-to-pr can only edit on its own branch.
  const grant = agent && pol.agents ? pol.agents[agent] : null;
  if (grant) {
    const gHit = pathsMod.firstMatch(grant.writable, rel);
    if (gHit) {
      if (grant.branch) {
        let branch = null;
        try { branch = gitMod.currentBranch(repoRoot); } catch { branch = null; }
        if (!branch || !pathsMod.matchesAny([grant.branch], branch)) {
          return deny(
            `"${rel}" is writable for agent ${agent} only on branch ${grant.branch} (current: ${branch || 'detached HEAD'})`,
            { rule: 'agent-branch', path: rel, pattern: gHit, agent });
        }
      }
      return allow(
        `agent ${agent} may write "${rel}" (policy agents.${agent}.writable: ${gHit}${grant.branch ? `, branch ${grant.branch}` : ''})`,
        { rule: 'agent-writable', path: rel, pattern: gHit, agent });
    }
  }

  // ---- 7. read-only regions ------------------------------------------------
  const roHit = pathsMod.firstMatch(pol.read_only, rel);
  if (roHit) {
    const hint = agent
      ? (grant
        ? `agent ${agent} is granted ${grant.writable.join(', ')}, which does not cover this path`
        : `agent ${agent} has no grant in .aidev/policy.yaml (agents.${agent}.writable)`)
      : 'this session was not started by the CLI as a named agent; grants in policy agents.<name> apply only then';
    return deny(
      `"${rel}" is read-only (${roHit}). PKG source is not written by agents by default; ${hint}. ` +
      'A team allows it by listing paths under writable, or per agent under agents.<name>.writable, in .aidev/policy.yaml.',
      { rule: 'read-only', path: rel, pattern: roHit });
  }

  return allow(`"${rel}" is not restricted by policy`, { rule: 'default', path: rel });
}

/**
 * Extract candidate filesystem targets from a Bash command line.
 *
 * Deliberately conservative and explicitly NOT a sandbox: it recognises common
 * write verbs and redirections so obvious bypasses are caught, while the real
 * enforcement remains minimal credentials, required CI and branch policies.
 */
const WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'tee', 'truncate', 'install', 'shred', 'dd',
  'chmod', 'chown', 'ln', 'mkdir', 'rmdir', 'touch', 'sed', 'patch',
]);

function extractBashTargets(command) {
  const cmd = String(command == null ? '' : command);
  const targets = new Set();
  if (cmd.trim() === '') return [];

  // Redirections: > file, >> file, and their fd-qualified forms.
  const redir = /(?:^|[\s;&|(])\d?>{1,2}\s*("([^"]+)"|'([^']+)'|([^\s;&|)]+))/g;
  let m;
  while ((m = redir.exec(cmd)) !== null) {
    const t = m[2] || m[3] || m[4];
    if (t && !t.startsWith('&') && !/^\/dev\//.test(t)) targets.add(t);
  }

  // Write-capable commands: collect their non-flag operands.
  const segments = cmd.split(/(?:\|\||&&|[;&|\n])/);
  for (const seg of segments) {
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;
    let i = 0;
    // Skip env assignments and common prefixes.
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) ||
           ['sudo', 'command', 'env', 'nohup', 'time'].includes(tokens[i]))) i++;
    if (i >= tokens.length) continue;
    const base = tokens[i].split(/[\\/]/).pop();
    if (!WRITE_COMMANDS.has(base)) continue;
    // `sed`/`patch` only write with an in-place / file flag.
    if (base === 'sed' && !tokens.some((t) => t === '-i' || t.startsWith('-i'))) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t.startsWith('-')) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
      targets.add(t);
    }
  }
  return [...targets].filter((t) => t && !/^\$/.test(t));
}

function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return out;
}

/** Decide a batch of paths; the first denial wins. */
function decideMany(repoRoot, targets, opts = {}) {
  const results = [];
  for (const t of targets) {
    const r = decide(repoRoot, t, opts);
    results.push(r);
    if (r.decision === DECISION.DENY) return { decision: DECISION.DENY, reason: r.reason, first: r, results };
  }
  return { decision: DECISION.ALLOW, reason: 'no target violates policy', results };
}

module.exports = { DECISION, decide, decideMany, extractBashTargets, WRITE_COMMANDS };
