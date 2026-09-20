'use strict';
/**
 * `aidev init` — first-time setup for a wrapper repository.
 *
 * `.claude/` is generated here from `templates/claude-assets/`, so a fresh
 * clone ends up with the hooks wired rather than merely verified. A destination
 * that already differs from the kit copy stops init with exit 2 instead of
 * being overwritten: kit-owned files are byte-identical across PKGs, so a local
 * edit is drift to be raised upstream, not a merge to be resolved here.
 *
 * What it still does NOT do matters just as much. `.aidev/policy.yaml` is
 * placed only from a reviewed candidate, because "the agent wrote its own
 * permission file" is exactly the failure this design exists to prevent.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const assets = require('../lib/assets');
const gitMod = require('../lib/git');
const yaml = require('../lib/yaml');
const ui = require('../lib/ui');

const FLAGS = {
  'dry-run': 'boolean', resume: 'boolean', yes: 'boolean', force: 'boolean',
  org: 'string', project: 'string', repository: 'string',
  'wrapper-repository': 'string', name: 'string', 'tracking-branch': 'string',
  'agent-model': 'string',
  json: 'boolean',
};

function ask(rl, question, dflt) {
  return new Promise((resolve) => {
    rl.question(`${question}${dflt ? ` [${dflt}]` : ''}: `, (a) => resolve(a.trim() || dflt || ''));
  });
}

/** Infer org/project/repo from the submodule's origin URL when possible. */
function inferFromSubmodule(repoRoot) {
  const subDir = path.join(repoRoot, 'src');
  const r = gitMod.run(['remote', 'get-url', 'origin'], { cwd: subDir });
  if (!r.ok) return {};
  const url = r.stdout;
  // https://dev.azure.com/<org>/<project>/_git/<repo>
  let m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { organization: m[1], project: decodeURIComponent(m[2]), repository: m[3] };
  // https://<org>.visualstudio.com/<project>/_git/<repo>
  m = url.match(/\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i);
  if (m) return { organization: m[1], project: decodeURIComponent(m[2]), repository: m[3] };
  m = url.match(/([^/\\]+?)(?:\.git)?$/);
  return m ? { repository: m[1] } : {};
}

function buildConfigYaml(v) {
  return [
    '# ai-dev-kit — PKG-specific configuration.',
    '# This is the only file where PKGs differ; everything under .claude/ is',
    '# byte-identical across all PKGs applying the same central-kit commit.',
    'version: 1',
    '',
    'package:',
    `  name: ${v.name}`,
    `  include: [${v.include.map((s) => JSON.stringify(s)).join(', ')}]`,
    '  exclude:',
    ...v.exclude.map((s) => `    - ${JSON.stringify(s)}`),
    '',
    '# Never read or written by the AI; also masked out of the Wiki.',
    'secrets_paths:',
    ...v.secrets.map((s) => `    - ${JSON.stringify(s)}`.replace('    -', '  -')),
    '',
    'azure_devops:',
    `  organization: ${v.organization}`,
    `  project: ${v.project}`,
    `  repository: ${v.repository}`,
    `  wrapper_repository: ${v.wrapper_repository}`,
    '  # The PAT itself lives in this environment variable, never in this file.',
    `  auth_env: ${v.auth_env}`,
    '  triage:',
    '    labels: ["ai-ready"]',
    '',
    'sync:',
    `  tracking_branch: ${v.tracking_branch}`,
    '  auto_pr: true',
    '  remote_check_timeout_ms: 3000',
    '  remote_check_ttl_minutes: 60',
    '',
    'task:',
    '  state_backend: azure_devops',
    '  lease_ttl_minutes: 120',
    '',
    'knowledge:',
    '  max_files_per_dir: 20',
    '  subagent_concurrency: 4',
    '  inventory_shard_size: 2000',
    '  # Generation targets come from package.include. Evidence is the broader',
    '  # read-only research scope used to verify docs against implementation.',
    '  evidence:',
    '    include: ["src/**"]',
    '    # exclude defaults to package.exclude when omitted.',
    '  # Ceiling for an agent started with --agent (default 30 minutes).',
    '  agent_timeout_ms: 1800000',
    '',
    'model:',
    '  # The model aidev hands to an agent it starts itself (--agent). An alias',
    '  # (sonnet, opus, haiku), a pinned name (claude-opus-4-8), or a provider ID.',
    '  # Set it to "" to pass no --model at all and leave the choice to Claude',
    '  # Code. Override for a single run with --agent-model.',
    `  agent: ${v.agent_model}`,
    '  # Your interactive sessions are not set here: .claude/ is byte-identical',
    '  # across PKGs, so the kit default lives in .claude/settings.json and each',
    '  # developer overrides it in .claude/settings.local.json ("model": "opus").',
    '',
    'self_evolution:',
    '  enabled: true',
    '  cadence: weekly',
    '',
    '# Run after every edit by the PostToolUse hook. Commands run inside src/.',
    '# quality_gates:',
    '#   format: npm run format',
    '#   lint: npm run lint',
    '#   typecheck: npm run typecheck',
    '',
  ].join('\n');
}

async function run(ctx) {
  const { repoRoot, flags } = ctx;
  const dryRun = !!flags['dry-run'];
  const steps = [];

  // --json must emit exactly one JSON document, the same contract every other
  // command keeps. `fail` is exempt: it writes to stderr, which stays available
  // for diagnostics without touching the document on stdout.
  const human = !flags.json;
  const say = {
    heading: (s) => { if (human) ui.heading(s); },
    ok: (s) => { if (human) ui.ok(s); },
    warn: (s) => { if (human) ui.warn(s); },
    info: (s) => { if (human) ui.info(s); },
    dim: (s) => { if (human) ui.dim(s); },
    out: (s) => { if (human) ui.out(s); },
  };

  say.heading(`aidev init${dryRun ? ' (dry run — nothing will be written)' : ''}`);

  // --- preconditions --------------------------------------------------------
  if (!gitMod.isRepo(repoRoot)) {
    throw new AidevError(`${repoRoot} is not a git repository — clone the central kit first.`);
  }
  const subDir = path.join(repoRoot, 'src');
  if (!fs.existsSync(subDir)) {
    say.warn('src/ does not exist yet. Add the PKG as a submodule first:');
    say.dim('    git submodule add <pkg-url> src && git submodule update --init --recursive');
  }

  // --- 1. the eject marker: re-adoption must actually re-adopt --------------
  // Leaving it in place would be the worst of both worlds: init reports success
  // while `check` still exempts the repo, so CI goes green on a repository
  // nobody is enforcing. Clearing it is the deliberate act that ends the
  // exemption, and it happens before anything else is written.
  const marker = cfgMod.readEjectMarker(repoRoot);
  if (marker) {
    if (dryRun) {
      say.info(`would clear ${cfgMod.EJECT_MARKER_NAME} (re-adopting a previously ejected repository)`);
      steps.push({ step: cfgMod.EJECT_MARKER_NAME, action: 'would-clear' });
    } else {
      fs.rmSync(cfgMod.ejectMarkerPath(repoRoot), { force: true });
      say.ok(`cleared ${cfgMod.EJECT_MARKER_NAME} — this repository is kit-managed again`);
      steps.push({ step: cfgMod.EJECT_MARKER_NAME, action: 'cleared' });
    }
  }

  // --- 2. aidev.yaml --------------------------------------------------------
  const configExists = fs.existsSync(cfgMod.configPath(repoRoot));
  if (configExists && !flags.resume) {
    say.warn('aidev.yaml already exists; leaving it untouched. Use "aidev plan" to preview changes.');
  } else {
    const inferred = inferFromSubmodule(repoRoot);
    const v = {
      name: flags.name || inferred.repository || path.basename(repoRoot),
      organization: flags.org || inferred.organization || '',
      project: flags.project || inferred.project || '',
      repository: flags.repository || inferred.repository || '',
      wrapper_repository: flags['wrapper-repository'] || '',
      tracking_branch: flags['tracking-branch'] || 'main',
      auth_env: 'AZURE_DEVOPS_PAT',
      // Validated here rather than only when the generated file is re-read, so
      // `--agent-model garbage` fails on the flag that carried it.
      agent_model: cfgMod.assertModel(
        flags['agent-model'], '--agent-model') || cfgMod.DEFAULTS.model.agent,
      include: ['src/src/**', 'src/docs/**'],
      exclude: ['**/node_modules/**', '**/generated/**', '**/vendor/**'],
      secrets: ['src/**/*.pem', 'src/**/*.pfx', 'src/**/secrets/**', 'src/.env*'],
    };

    // --json rules out prompting: the questions would land on the same stdout
    // the document has to be the only thing on.
    const interactive = !flags.yes && !flags.json && process.stdin.isTTY;
    if (interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        say.out('\nAzure DevOps connection (no credentials are stored here):');
        v.organization = await ask(rl, '  organization', v.organization);
        v.project = await ask(rl, '  project', v.project);
        v.repository = await ask(rl, '  PKG repository', v.repository);
        v.wrapper_repository = await ask(rl, '  wrapper repository', v.wrapper_repository || `${v.repository}-ai-dev`);
        v.tracking_branch = await ask(rl, '  tracking branch', v.tracking_branch);
        v.name = await ask(rl, '  package name', v.name);
      } finally { rl.close(); }
    } else if (!v.wrapper_repository) {
      v.wrapper_repository = v.repository ? `${v.repository}-ai-dev` : '';
    }

    for (const k of ['organization', 'project', 'repository']) {
      if (!v[k]) {
        throw new AidevError(
          `azure_devops.${k} could not be determined. Pass --${k === 'organization' ? 'org' : k} or run interactively.`);
      }
    }

    const text = buildConfigYaml(v);
    // Validate what we are about to write rather than trusting the template.
    cfgMod.validateConfig(yaml.parse(text), 'generated aidev.yaml');
    steps.push({ step: 'aidev.yaml', action: configExists ? 'keep' : 'create' });
    if (dryRun) { say.dim('--- aidev.yaml (preview) ---'); say.out(text); }
    else { cfgMod.writeFileAtomic(cfgMod.configPath(repoRoot), text); say.ok('wrote aidev.yaml'); }
  }

  // --- 3. materialise .claude/ from the kit's templates ---------------------
  // This is what makes a fresh clone usable: until `.claude/settings.json`
  // exists, no hook is wired and layers 1 and 2 of the permission model are
  // simply absent, yet everything else reports success. Generating it here ties
  // "init finished" to "the guard is actually running".
  const mat = assets.materializeStaticAssets(repoRoot, { dryRun, force: !!flags.force });

  if (mat.noTemplates) {
    ui.fail(`no asset templates found under ${mat.templateRoot}/.`);
    say.dim('    These ship with the central kit; a clone missing them is incomplete.');
    steps.push({ step: '.claude', action: 'missing-templates' });
  } else if (mat.conflicts.length > 0) {
    // Overwriting would destroy the only copy of a local edit. Kit-owned files
    // are byte-identical across PKGs, so the fix is a PR to the kit, not a
    // silent overwrite here.
    ui.fail(`${mat.conflicts.length} kit-owned file(s) differ from the kit copy:`);
    for (const c of mat.conflicts) say.dim(`    ${c.path} — ${c.reason}`);
    say.dim('    Send intended changes to the central kit as a PR, or re-run with --force');
    say.dim('    to replace them with the kit version.');
    steps.push({ step: '.claude', action: 'conflict', conflicts: mat.conflicts.map((c) => c.path) });
    if (flags.json) ui.json({ ok: false, dryRun, steps });
    return EXIT.DRIFT;
  } else {
    const wrote = mat.created.length + mat.updated.length;
    const verb = dryRun ? 'would materialise' : 'materialised';
    if (wrote === 0) say.ok(`.claude/ is already current (${mat.unchanged.length} file(s))`);
    else say.ok(`${verb} ${wrote} file(s) into .claude/ (${mat.unchanged.length} already current)`);
    for (const p of mat.created) say.dim(`    + ${p}`);
    for (const p of mat.updated) say.dim(`    ~ ${p}`);
    for (const p of mat.pruned) say.dim(`    - ${p} (no longer shipped)`);
    steps.push({
      step: '.claude',
      action: dryRun ? 'would-materialise' : 'materialised',
      created: mat.created.length,
      updated: mat.updated.length,
      unchanged: mat.unchanged.length,
      pruned: mat.pruned.length,
    });
  }

  const staticFiles = assets.listStaticFiles(repoRoot);
  if (staticFiles.length === 0) {
    say.warn('no kit-owned static files are present (.claude/, CLAUDE.md, .mcp.json).');
    steps.push({ step: 'static assets', action: 'missing' });
  } else {
    say.ok(`tracking ${staticFiles.length} kit-owned static file(s)`);
    steps.push({ step: 'static assets', action: 'verified', count: staticFiles.length });
  }

  // --- 4. connection sanity (no credential is stored or printed) ------------
  const config = fs.existsSync(cfgMod.configPath(repoRoot)) ? cfgMod.loadConfig(repoRoot) : null;
  if (config) {
    const authEnv = config.azure_devops.auth_env;
    if (!process.env[authEnv]) {
      say.warn(`${authEnv} is not set; Azure DevOps operations will fail until it is.`);
    } else say.ok(`${authEnv} is set (value not read)`);
  }

  // --- 5. permission policy: candidate → human approval → CLI places it -----
  const policyFile = cfgMod.policyPath(repoRoot);
  if (fs.existsSync(policyFile)) {
    say.ok('.aidev/policy.yaml already present');
    steps.push({ step: 'policy', action: 'keep' });
  } else {
    say.warn('.aidev/policy.yaml is not present.');
    say.dim('    Run "aidev permission configure" — the policy is placed by the CLI after');
    say.dim('    a human approves the candidate. init never writes it directly.');
    steps.push({ step: 'policy', action: 'pending' });
  }

  // --- 6. Wiki --------------------------------------------------------------
  const manifest = path.join(repoRoot, 'knowledge', 'manifest.json');
  if (fs.existsSync(manifest)) {
    say.ok('knowledge/manifest.json present');
    steps.push({ step: 'knowledge', action: 'keep' });
  } else {
    say.warn('the LLM Wiki has not been generated. Run "aidev knowledge build".');
    say.dim('    This is the expensive first-run step; it can be resumed from its checkpoint.');
    steps.push({ step: 'knowledge', action: 'pending' });
  }

  // --- 7. .aidev-lock -------------------------------------------------------
  if (dryRun) {
    steps.push({ step: '.aidev-lock', action: 'would-write' });
  } else if (staticFiles.length > 0) {
    const kitCommit = gitMod.headSha(repoRoot);
    assets.writeLock(repoRoot, assets.buildLock(repoRoot, { kitCommit }));
    say.ok(`wrote .aidev-lock (${staticFiles.length} file hashes, kit ${kitCommit ? kitCommit.slice(0, 7) : 'unknown'})`);
    steps.push({ step: '.aidev-lock', action: 'write' });
  }

  if (flags.json) ui.json({ ok: true, dryRun, steps });
  else {
    say.out('');
    say.info('next: "aidev permission configure", then "aidev knowledge build", then commit.');
  }
  return EXIT.OK;
}

module.exports = { run, FLAGS, summary: '初期セットアップ', buildConfigYaml, inferFromSubmodule };
