'use strict';
/**
 * `aidev init` — set up ai-dev-kit inside a PKG clone.
 *
 * Two people run this, and it behaves differently for each:
 *
 *   - The first person on a PKG (the "onboarding owner") has no aidev.yaml
 *     yet. init asks a handful of questions, writes aidev.yaml, materialises
 *     the tool configuration, proposes the permission policy and (after the
 *     human says yes) places it. Everything it writes is meant to be
 *     committed, so the rest of the team inherits it.
 *   - Everyone after that already has aidev.yaml, .claude/ and the policy from
 *     git. For them init asks nothing: it verifies the materialised files,
 *     registers the clone on this machine and reports what to do next.
 *
 * The Wiki is part of the setup: the first init builds it (asking first when
 * a terminal is attached, since it costs time and tokens), and a later init
 * continues an unfinished build. The policy is placed only after a human
 * approved it.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const layout = require('../lib/layout');
const assets = require('../lib/assets');
const gitMod = require('../lib/git');
const home = require('../lib/home');
const yaml = require('../lib/yaml');
const permission = require('./permission');
const inventory = require('../lib/inventory');
const knowledge = require('./knowledge');
const ui = require('../lib/ui');

const FLAGS = {
  'dry-run': 'boolean', yes: 'boolean', force: 'boolean', json: 'boolean',
  name: 'string', include: 'string', exclude: 'string', secrets: 'string',
  hosting: 'string', org: 'string', project: 'string', repository: 'string',
  'tracking-branch': 'string', tools: 'string', 'agent-model': 'string',
  approve: 'boolean', wiki: 'boolean', 'no-wiki': 'boolean',
};

const FLAG_HELP = {
  'dry-run': 'show what would be written; write nothing',
  yes: 'do not ask questions; use the values inferred or given by flags',
  force: 'replace tool configuration files that were edited locally',
  json: 'machine-readable output',
  name: 'package name (default: the repository name)',
  include: 'Wiki generation targets, comma-separated globs (default: inferred from the tree)',
  exclude: 'globs excluded from generation targets, comma-separated',
  secrets: 'secret paths never read by the AI, comma-separated globs',
  hosting: 'azure-devops or generic (default: inferred from the origin URL)',
  org: 'Azure DevOps organization',
  project: 'Azure DevOps project',
  repository: 'repository name on the hosting',
  'tracking-branch': 'branch the Wiki follows (default: main)',
  tools: `AI coding tools to configure, comma-separated (${cfgMod.TOOLS.join(', ')}; default: claude)`,
  'agent-model': 'model for agents the CLI starts itself (default: sonnet)',
  approve: 'place the generated permission policy without asking',
  wiki: 'build (or continue) the LLM Wiki without asking',
  'no-wiki': 'do not build the LLM Wiki now',
};

/** Top-level directories that usually hold what a Wiki should describe. */
const SOURCE_DIRS = ['src', 'lib', 'app', 'apps', 'packages', 'services', 'api', 'cmd', 'pkg',
  'internal', 'core', 'docs', 'doc'];

const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/generated/**'];
const DEFAULT_SECRETS = ['.env*', '**/secrets/**', '**/*.pem', '**/*.pfx', '**/*.key'];

function ask(rl, question, dflt) {
  return new Promise((resolve) => {
    rl.question(`${question}${dflt ? ` [${dflt}]` : ''}: `, (a) => resolve(a.trim() || dflt || ''));
  });
}

function splitList(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt;
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Infer hosting details from the origin URL. */
function inferHosting(repoRoot) {
  const url = gitMod.remoteUrl(repoRoot, 'origin') || '';
  let m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { type: 'azure-devops', organization: m[1], project: decodeURIComponent(m[2]), repository: m[3].replace(/\.git$/, ''), url };
  m = url.match(/\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { type: 'azure-devops', organization: m[1], project: decodeURIComponent(m[2]), repository: m[3].replace(/\.git$/, ''), url };
  m = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i);
  if (m) return { type: 'azure-devops', organization: m[1], project: decodeURIComponent(m[2]), repository: m[3], url };
  m = url.match(/([^/\\:]+?)(?:\.git)?\/?$/);
  return { type: 'generic', organization: null, project: null, repository: m ? m[1] : null, url };
}

/** Propose generation targets from the tracked tree. */
function inferInclude(repoRoot) {
  const entries = gitMod.lsTreeBlobs(repoRoot, 'HEAD') || [];
  const top = new Set();
  for (const e of entries) {
    const first = e.path.split('/')[0];
    if (e.path.includes('/')) top.add(first);
  }
  const hits = SOURCE_DIRS.filter((d) => top.has(d));
  return hits.length > 0 ? hits.map((d) => `${d}/**`) : ['**'];
}

const q = (s) => JSON.stringify(s);

function buildConfigYaml(v) {
  const list = (items) => (items.length ? items.map((s) => `  - ${q(s)}`) : ['  []']);
  const hostingLines = [`  type: ${v.hosting.type}`];
  if (v.hosting.type === 'azure-devops') {
    hostingLines.push(
      `  organization: ${q(v.hosting.organization)}`,
      `  project: ${q(v.hosting.project)}`,
      `  repository: ${q(v.hosting.repository)}`,
      '  # The PAT itself lives in this environment variable, never in this file.',
      `  auth_env: ${v.hosting.auth_env}`,
      '  triage:',
      '    labels: ["ai-ready"]');
  } else if (v.hosting.repository) {
    hostingLines.push(`  repository: ${q(v.hosting.repository)}`);
  }
  hostingLines.push(`  tracking_branch: ${q(v.tracking_branch)}`);
  return [
    '# aidev.yaml — ai-dev-kit settings for this package. Commit this file.',
    '# Run "aidev init" to regenerate it, or edit it by hand; "aidev check" validates it.',
    'version: 2',
    '',
    'package:',
    `  name: ${q(v.name)}`,
    '  # Paths the LLM Wiki documents (generation targets). Research covers the whole repo.',
    '  include:',
    ...list(v.include),
    '  exclude:',
    ...list(v.exclude),
    '',
    '# Never read or written by the AI; also masked out of the Wiki.',
    'secrets_paths:',
    ...(v.secrets.length ? v.secrets.map((s) => `  - ${q(s)}`) : ['  []']),
    '',
    'hosting:',
    ...hostingLines,
    '',
    '# AI coding tools this PKG is set up for. Each listed tool gets its configuration',
    `# files from the kit (supported: ${cfgMod.TOOLS.join(', ')}). Claude Code is the only one`,
    '# whose write policy is enforced at runtime through hooks.',
    'tools:',
    `  default: [${v.tools.map(q).join(', ')}]`,
    '  # Tool that runs agents the CLI starts (aidev knowledge build, aidev sync,',
    '  # aidev agent run, workflows). Must be one of tools.default.',
    `  agent: ${q(v.tools[0])}`,
    '  # Model for those agents. "" passes no model flag and lets the tool decide.',
    `  agent_model: ${q(v.agent_model)}`,
    '  # Per-agent overrides (tool and/or model); omitted keys inherit the two above.',
    '  # agents:',
    '  #   knowledge-builder: { model: opus }',
    '  #   issue-to-pr: { tool: copilot, model: "" }',
    '',
    'knowledge:',
    '  # Time budget for each agent run (survey or one batch), in ms. Default 30 minutes.',
    '  agent_timeout_ms: 1800000',
    '  # Generation targets per agent run. Progress is saved after every run.',
    '  agent_batch_size: 20',
    '',
    '# Commands the PostToolUse hook runs after the AI edits a PKG file (run from the repo root).',
    '# quality_gates:',
    '#   lint: npm run lint',
    '#   test: npm test',
    '',
  ].join('\n');
}

async function run(ctx) {
  const { repoRoot, flags, installRoot } = ctx;
  const dryRun = !!flags['dry-run'];
  const human = !flags.json;
  const steps = [];
  const say = {
    heading: (s) => { if (human) ui.heading(s); },
    ok: (s) => { if (human) ui.ok(s); },
    warn: (s) => { if (human) ui.warn(s); },
    info: (s) => { if (human) ui.info(s); },
    dim: (s) => { if (human) ui.dim(s); },
    out: (s) => { if (human) ui.out(s); },
  };
  const interactive = !flags.yes && !flags.json && !!process.stdin.isTTY;

  say.heading(`aidev init${dryRun ? ' (dry run — nothing will be written)' : ''}`);

  // --- preconditions --------------------------------------------------------
  if (!gitMod.isRepo(repoRoot)) {
    throw new AidevError(`${repoRoot} is not a git repository. Run "aidev init" inside the clone of your package.`);
  }
  if (!gitMod.headSha(repoRoot)) {
    throw new AidevError('this repository has no commits yet; commit something first.');
  }
  const top = gitMod.repoTopLevel(repoRoot);
  if (top && !gitMod.samePath(top, repoRoot)) {
    throw new AidevError(`run "aidev init" at the repository root (${top}), not in a subdirectory.`);
  }

  // --- 1. the eject marker: re-adoption must actually re-adopt --------------
  const marker = cfgMod.readEjectMarker(repoRoot);
  if (marker) {
    if (dryRun) {
      say.info(`would clear ${cfgMod.EJECT_MARKER_NAME} (re-adopting a previously ejected repository)`);
      steps.push({ step: 'eject marker', action: 'would-clear' });
    } else {
      fs.rmSync(cfgMod.ejectMarkerPath(repoRoot), { force: true });
      say.ok(`cleared ${cfgMod.EJECT_MARKER_NAME} — this repository is kit-managed again`);
      steps.push({ step: 'eject marker', action: 'cleared' });
    }
  }

  // --- 2. aidev.yaml --------------------------------------------------------
  const configExists = fs.existsSync(cfgMod.configPath(repoRoot));
  let firstTime = !configExists;
  let requestedTools = null;
  if (configExists) {
    say.ok('aidev.yaml is present (set up by your team); nothing to ask.');
    steps.push({ step: 'aidev.yaml', action: 'keep' });
  } else {
    const inferred = inferHosting(repoRoot);
    const v = {
      name: flags.name || inferred.repository || path.basename(repoRoot),
      include: splitList(flags.include, inferInclude(repoRoot)),
      exclude: splitList(flags.exclude, DEFAULT_EXCLUDE),
      secrets: splitList(flags.secrets, DEFAULT_SECRETS),
      hosting: {
        type: flags.hosting || inferred.type,
        organization: flags.org || inferred.organization || '',
        project: flags.project || inferred.project || '',
        repository: flags.repository || inferred.repository || '',
        auth_env: 'AZURE_DEVOPS_PAT',
      },
      tracking_branch: flags['tracking-branch'] || 'main',
      tools: splitList(flags.tools, [...cfgMod.DEFAULTS.tools.default]),
      agent_model: cfgMod.assertModel(flags['agent-model'], '--agent-model') || cfgMod.DEFAULTS.tools.agent_model,
    };

    if (interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        say.out('');
        say.out('Four questions. Press Enter to accept the value in brackets.');
        say.out('');
        v.tools = splitList(await ask(rl, `1/4 AI coding tool(s) to set up (${cfgMod.TOOLS.join(', ')})`, v.tools.join(', ')), v.tools);
        v.include = splitList(await ask(rl, '2/4 Paths the Wiki should document (comma-separated globs)', v.include.join(', ')), v.include);
        v.secrets = splitList(await ask(rl, '3/4 Secret paths the AI must never read', v.secrets.join(', ')), v.secrets);
        if (v.hosting.type === 'azure-devops') {
          say.out(`4/4 Hosting: Azure DevOps (from ${inferred.url})`);
          v.hosting.organization = await ask(rl, '    organization', v.hosting.organization);
          v.hosting.project = await ask(rl, '    project', v.hosting.project);
          v.hosting.repository = await ask(rl, '    repository', v.hosting.repository);
        } else {
          v.hosting.type = await ask(rl, '4/4 Hosting type (azure-devops or generic)', v.hosting.type);
          if (v.hosting.type === 'azure-devops') {
            v.hosting.organization = await ask(rl, '    organization', v.hosting.organization);
            v.hosting.project = await ask(rl, '    project', v.hosting.project);
            v.hosting.repository = await ask(rl, '    repository', v.hosting.repository);
          }
        }
        v.tracking_branch = await ask(rl, '    tracking branch', v.tracking_branch);
      } finally { rl.close(); }
    }

    if (!cfgMod.HOSTING_TYPES.includes(v.hosting.type)) {
      throw new AidevError(`hosting must be one of ${cfgMod.HOSTING_TYPES.join(', ')} (got ${v.hosting.type})`);
    }
    if (v.hosting.type === 'azure-devops') {
      for (const k of ['organization', 'project', 'repository']) {
        if (!v.hosting[k]) {
          throw new AidevError(
            `hosting.${k} could not be determined. Pass --${k === 'organization' ? 'org' : k} or run interactively.`);
        }
      }
    }

    for (const t of v.tools) {
      if (!cfgMod.TOOLS.includes(t)) {
        throw new AidevError(`tools must be chosen from ${cfgMod.TOOLS.join(', ')} (got ${t})`);
      }
    }
    const text = buildConfigYaml(v);
    cfgMod.validateConfig(yaml.parse(text), 'generated aidev.yaml');
    requestedTools = v.tools;
    steps.push({ step: 'aidev.yaml', action: 'create' });
    if (dryRun) { say.dim('--- aidev.yaml (preview) ---'); say.out(text); }
    else { cfgMod.writeFileAtomic(cfgMod.configPath(repoRoot), text); say.ok('wrote aidev.yaml'); }
  }

  const config = configExists || !dryRun ? cfgMod.loadConfig(repoRoot, { required: false }) : null;
  const toolList = config?.tools?.default || requestedTools || [...cfgMod.DEFAULTS.tools.default];

  // --- 3. .aidev/.gitignore -------------------------------------------------
  if (!dryRun && layout.ensureAidevGitignore(repoRoot)) {
    say.ok(`wrote ${layout.AIDEV_GITIGNORE_REL} (runtime state stays out of git)`);
  }

  // --- 4. materialise the tool configuration --------------------------------
  const mat = assets.materializeStaticAssets(repoRoot, { installRoot, dryRun, force: !!flags.force, tools: toolList });
  if (mat.noTemplates) {
    ui.fail(`no templates found under ${installRoot}. The ai-dev-kit checkout looks incomplete.`);
    steps.push({ step: 'tool config', action: 'missing-templates' });
  } else if (mat.conflicts.length > 0) {
    ui.fail(`${mat.conflicts.length} kit-owned file(s) differ from the kit copy:`);
    for (const c of mat.conflicts) say.dim(`    ${c.path} — ${c.reason}`);
    say.dim('    Send intended changes to ai-dev-kit as a PR, or re-run with --force to take the kit version.');
    steps.push({ step: 'tool config', action: 'conflict', conflicts: mat.conflicts.map((c) => c.path) });
    if (flags.json) ui.json({ ok: false, dryRun, steps });
    return EXIT.DRIFT;
  } else {
    const wrote = mat.created.length + mat.updated.length;
    if (wrote === 0) say.ok(`tool configuration is current (${mat.unchanged.length} file(s) for ${toolList.join(', ')})`);
    else say.ok(`${dryRun ? 'would write' : 'wrote'} ${wrote} tool configuration file(s) (${mat.unchanged.length} already current)`);
    for (const p of mat.created) say.dim(`    + ${p}`);
    for (const p of mat.updated) say.dim(`    ~ ${p}`);
    for (const p of mat.pruned) say.dim(`    - ${p} (no longer shipped)`);
    steps.push({ step: 'tool config', action: dryRun ? 'would-materialise' : 'materialised',
      created: mat.created.length, updated: mat.updated.length, unchanged: mat.unchanged.length, pruned: mat.pruned.length });
  }

  // --- 5. record what was materialised --------------------------------------
  const kitCommit = gitMod.headSha(installRoot);
  if (!dryRun && !mat.noTemplates) {
    assets.writeLock(repoRoot, assets.buildLock(repoRoot, { kitCommit, kitVersion: ctx.version || null, tools: toolList, installRoot }));
    steps.push({ step: 'materialized.json', action: 'write' });
  }

  // --- 6. register this clone on this machine --------------------------------
  if (!dryRun) {
    home.registerPackage(repoRoot, {
      name: config?.package?.name, remote: gitMod.remoteUrl(repoRoot, 'origin'), kitCommit,
    });
    steps.push({ step: 'registry', action: 'registered' });
  }

  // --- 7. credentials (presence only) ----------------------------------------
  if (config?.hosting?.type === 'azure-devops') {
    const authEnv = config.hosting.auth_env;
    if (!process.env[authEnv]) say.warn(`${authEnv} is not set; Azure DevOps operations (PRs, work items) will fail until it is.`);
    else say.ok(`${authEnv} is set (value not read)`);
  }

  // --- 8. permission policy: candidate → human approval → CLI places it -----
  let policyPlaced = fs.existsSync(cfgMod.policyPath(repoRoot));
  if (policyPlaced) {
    say.ok('.aidev/policy.yaml is present');
    steps.push({ step: 'policy', action: 'keep' });
  } else if (config && !dryRun) {
    const candidate = permission.buildCandidate(config);
    const text = permission.renderCandidate(config, candidate);
    say.out('');
    say.info('permission policy for this package (what the AI may write):');
    say.dim(`    writable: ${candidate.writable.join(', ')}`);
    say.dim('    read-only: everything else in the package (issue-to-pr edits it under a work lease)');
    say.dim(`    protected: ${candidate.protected.length} path(s), including secrets_paths`);
    let approve = !!flags.approve;
    if (!approve && interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const a = await ask(rl, '    Place this policy now? (y/N)', 'N');
        approve = /^y(es)?$/i.test(a);
      } finally { rl.close(); }
    }
    if (approve) {
      cfgMod.writeFileAtomic(cfgMod.policyPath(repoRoot), text);
      policyPlaced = true;
      say.ok(`placed ${cfgMod.POLICY_REL} (approved)`);
      steps.push({ step: 'policy', action: 'placed' });
    } else {
      cfgMod.writeFileAtomic(permission.candidatePath(repoRoot), text);
      say.warn(`policy not placed. Review ${permission.CANDIDATE_REL}, then run "aidev permission configure --approve".`);
      steps.push({ step: 'policy', action: 'candidate' });
    }
  } else {
    steps.push({ step: 'policy', action: 'pending' });
  }

  // --- 9. Wiki ---------------------------------------------------------------
  // The Wiki is part of the setup, not a separate chore: the first init builds
  // it, and a later init picks an unfinished build up where it stopped.
  if (flags.wiki && flags['no-wiki']) throw new AidevError('--wiki and --no-wiki cannot both be given');
  let manifest = null;
  try { manifest = inventory.readManifest(repoRoot); } catch { manifest = null; }
  const hasWiki = manifest != null;
  const pendingPages = Array.isArray(manifest?.checkpoint?.pendingPaths) ? manifest.checkpoint.pendingPaths.length : 0;
  let wikiComplete = hasWiki && pendingPages === 0;
  let wikiCode = EXIT.OK;
  if (wikiComplete) {
    say.ok(`LLM Wiki is present (${layout.KNOWLEDGE_REL}/)`);
    steps.push({ step: 'knowledge', action: 'keep' });
  } else if (dryRun || !config) {
    say.info(hasWiki
      ? `LLM Wiki is incomplete (${pendingPages} page(s) without prose); init would continue the build`
      : 'LLM Wiki is not generated yet; init would build it');
    steps.push({ step: 'knowledge', action: 'would-build' });
  } else {
    // A member whose team's Wiki is still in an open pull request must not
    // build a second one by accident, so that case defaults to "no".
    const teamWikiPending = !firstTime && !hasWiki;
    let doBuild = !!flags.wiki;
    if (!doBuild && !flags['no-wiki']) {
      if (interactive) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          say.out('');
          if (teamWikiPending) {
            say.info('the LLM Wiki is not in this clone yet. If your team set it up, "git pull" after their pull request merges.');
            const a = await ask(rl, '    Build it on this machine now? (y/N)', 'N');
            doBuild = /^y(es)?$/i.test(a);
          } else {
            const q = hasWiki
              ? `    Continue building the LLM Wiki (${pendingPages} page(s) left)? (Y/n)`
              : '    Build the LLM Wiki now? It takes a while; "aidev init" again continues where it stopped. (Y/n)';
            const a = await ask(rl, q, 'Y');
            doBuild = !/^n(o)?$/i.test(a);
          }
        } finally { rl.close(); }
      } else {
        doBuild = !teamWikiPending;
      }
    }
    if (doBuild) {
      say.out('');
      const r = await knowledge.build({ ...ctx, flags: { json: !!flags.json } }, config, { silent: !!flags.json });
      wikiCode = r.code;
      wikiComplete = r.code === EXIT.OK;
      steps.push({ step: 'knowledge', action: 'built', ok: wikiComplete, result: r.json });
    } else {
      say.warn(hasWiki
        ? `LLM Wiki is incomplete (${pendingPages} page(s) without prose). Run "aidev init" again to continue.`
        : 'LLM Wiki not built. Run "aidev init --wiki" when you want to build it on this machine.');
      steps.push({ step: 'knowledge', action: 'pending' });
    }
  }

  if (flags.json) { ui.json({ ok: wikiCode === EXIT.OK, dryRun, firstTime, steps }); return wikiCode; }

  say.out('');
  if (firstTime) {
    say.info('next steps (you are setting this package up for your team):');
    const todo = [];
    if (!policyPlaced) todo.push('aidev permission configure --approve   # after reviewing the candidate');
    if (!wikiComplete) todo.push('aidev init                              # builds (or continues) the LLM Wiki');
    todo.push('git add aidev.yaml .aidev .claude CLAUDE.md .mcp.json && git commit');
    todo.push('open a pull request so everyone gets the same setup');
    todo.forEach((t, i) => say.dim(`    ${i + 1}. ${t}`));
  } else if (!wikiComplete) {
    say.info('next: run "aidev init" again to finish the LLM Wiki, then commit .aidev/knowledge.');
  } else {
    say.info('ready. Run "aidev status" any time, then start your AI tool (e.g. "claude") in this directory.');
  }
  return wikiCode;
}

module.exports = { run, FLAGS, FLAG_HELP, summary: 'このPKGにai-dev-kitを導入する（初回は対話、2人目以降は質問なし）', buildConfigYaml, inferHosting, inferInclude };
