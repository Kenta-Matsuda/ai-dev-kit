'use strict';
/**
 * Where ai-dev-kit keeps things inside a PKG clone.
 *
 * Everything the kit adds to a PKG lives under `.aidev/` plus the tool
 * configuration it materialises at the root (`.claude/`, `CLAUDE.md`). MCP
 * servers (`.mcp.json`) are the package's own. All of it is committed to the PKG repository so the whole team
 * shares one setup; only runtime state (`.aidev/cache`, leases, the sync lock)
 * is ignored, through a `.gitignore` the CLI writes into `.aidev/`.
 *
 * This module has no dependencies on purpose: config, inventory and policy all
 * need these names, and a cycle between them is easy to create by accident.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'aidev.yaml';
const AIDEV_DIR = '.aidev';
const KNOWLEDGE_REL = '.aidev/knowledge';
const POLICY_REL = '.aidev/policy.yaml';
const POLICY_CANDIDATE_REL = '.aidev/policy.candidate.yaml';
const MATERIALIZED_REL = '.aidev/materialized.json';
const EJECT_MARKER_REL = '.aidev/ejected.json';
const SYNC_LOCK_REL = '.aidev/sync.lock';
const WORKFLOWS_REL = '.aidev/workflows';
const AGENTS_REL = '.aidev/agents';
const SKILLS_REL = '.aidev/skills';
const CONVENTIONS_REL = '.aidev/conventions';
/** What runs were estimated to cost and what they did cost: committed, so every run of the team calibrates the next estimate. */
const ESTIMATES_REL = '.aidev/estimates';
const AIDEV_GITIGNORE_REL = '.aidev/.gitignore';

/**
 * The configuration files the kit materialises for each AI coding tool. The
 * registry in `tools.js` reads these; they live here so that policy, layout
 * and the tool adapters agree on one list without a require cycle.
 */
const TOOL_CONFIG_GLOBS = Object.freeze({
  claude: Object.freeze(['.claude/**', 'CLAUDE.md']),
  copilot: Object.freeze(['.github/copilot-instructions.md', '.github/agents/**', '.github/skills/**', '.github/hooks/**']),
  codex: Object.freeze(['AGENTS.md', '.codex/**']),
  kiro: Object.freeze(['.kiro/steering/**', '.kiro/agents/**']),
});

/** Every tool's config globs, flattened. */
const ALL_TOOL_CONFIG_GLOBS = Object.freeze(Object.values(TOOL_CONFIG_GLOBS).flatMap((g) => [...g]));

/**
 * Paths the kit owns inside a PKG. They are never generation targets, never
 * research evidence, and a PostToolUse quality gate does not run for them.
 */
const KIT_MANAGED_GLOBS = Object.freeze([
  CONFIG_NAME, '.aidev/**', ...ALL_TOOL_CONFIG_GLOBS,
]);

/** The ignore file written into .aidev/: runtime state stays out of git. */
const AIDEV_GITIGNORE = [
  '# ai-dev-kit runtime state (regenerated; never commit)',
  'cache/',
  'sync.lock',
  'knowledge/.cache/',
  'workflows/*/runs/',
  '',
].join('\n');

function toPosix(rel) { return String(rel).replace(/\\/g, '/').replace(/^\.\//, ''); }

/** Match one kit-managed glob: either an exact file or a `dir/**` subtree. */
function matchesManagedGlob(glob, p) {
  if (glob.endsWith('/**')) {
    const dir = glob.slice(0, -3);
    return p === dir || p.startsWith(`${dir}/`);
  }
  return p === glob;
}

function isKitManaged(rel) {
  const p = toPosix(rel);
  return KIT_MANAGED_GLOBS.some((g) => matchesManagedGlob(g, p));
}

function abs(repoRoot, rel) { return path.join(repoRoot, ...toPosix(rel).split('/')); }

/** Write .aidev/.gitignore when absent or outdated. Returns true when written. */
function ensureAidevGitignore(repoRoot) {
  const full = abs(repoRoot, AIDEV_GITIGNORE_REL);
  let current = null;
  try { current = fs.readFileSync(full, 'utf8'); } catch { current = null; }
  if (current === AIDEV_GITIGNORE) return false;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, AIDEV_GITIGNORE, 'utf8');
  return true;
}

module.exports = {
  CONFIG_NAME, AIDEV_DIR, KNOWLEDGE_REL, POLICY_REL, POLICY_CANDIDATE_REL, MATERIALIZED_REL,
  EJECT_MARKER_REL, SYNC_LOCK_REL, WORKFLOWS_REL, AGENTS_REL, SKILLS_REL, CONVENTIONS_REL, ESTIMATES_REL,
  AIDEV_GITIGNORE_REL, AIDEV_GITIGNORE,
  TOOL_CONFIG_GLOBS, ALL_TOOL_CONFIG_GLOBS, KIT_MANAGED_GLOBS, isKitManaged, toPosix, abs, ensureAidevGitignore,
};
