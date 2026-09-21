'use strict';
/**
 * End-to-end check of the kit's own shipped assets.
 *
 * The unit suites build their static files from fixtures, so they would keep
 * passing even if the kit shipped none. This script exercises the real files in
 * this repository against the code that consumes them:
 *
 *   - templates/root/.mcp.json   must route to an implemented `aidev mcp` server
 *   - templates/claude-assets/settings.json
 *                                its hooks must name implemented `aidev hook`
 *                                names, and its deny list must cover the
 *                                protected floor
 *   - templates/root/CLAUDE.md   must exist and be tracked as a kit-owned file
 *   - agents / skills            frontmatter must parse and declare name + description
 *
 * The PKG's `.claude/`, `CLAUDE.md` and `.mcp.json` are generated from those
 * templates, so the contract has two halves and both are checked here: the
 * templates must be valid, and `aidev init` must turn them into a tree whose
 * hooks are really wired. Validating only the templates would pass on a repo
 * where init silently wrote nothing at all.
 *
 * Run: node test/assets.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, copyDir, KIT_ROOT } = require('./fixtures');

const ROOT = KIT_ROOT;
const BIN = path.join(ROOT, 'cli', 'bin', 'aidev.js');
const hookMod = require('../cli/commands/hook');
const mcpMod = require('../cli/commands/mcp');
const assets = require('../cli/lib/assets');
const layout = require('../cli/lib/layout');
const cfgMod = require('../cli/lib/config');
const home = require('../cli/lib/home');
const { ALWAYS_PROTECTED } = cfgMod;

/** One AIDEV_HOME for the run: init registers clones there, never in the real one. */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-home-'));

/** Run the real CLI the way a pipeline does, capturing code and output. */
function aidev(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', AIDEV_HOME: HOME, AIDEV_NO_UPDATE_CHECK: '1' },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      out: `${e.stdout || ''}${e.stderr || ''}`,
    };
  }
}

/** The last JSON document in mixed human/JSON output, as the other suites read it. */
function lastJson(text) {
  const matches = String(text).match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  try { return JSON.parse(matches[matches.length - 1]); } catch { return null; }
}

/**
 * A private copy of the kit's templates plus an empty repository to
 * materialise into.
 *
 * Materialisation needs no git and no config, so the fixture is deliberately
 * smaller than makeRepo(): anything else in the directory could only obscure
 * which file the code under test actually wrote. Tests that need to *change* a
 * template edit the copy, never the kit checkout.
 */
function withTempKit(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-assets-'));
  const installRoot = path.join(base, 'kit');
  const repoRoot = path.join(base, 'repo');
  try {
    copyDir(path.join(ROOT, 'templates'), path.join(installRoot, 'templates'));
    fs.mkdirSync(repoRoot, { recursive: true });
    return fn(repoRoot, installRoot);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Like withTempKit, but the kit copy is a git repository: `commit(msg)` commits
 * the current templates and returns the SHA, which apply then uses as the
 * kit commit (and, later, as the merge base for edited files).
 */
function withGitKit(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-gitkit-'));
  const installRoot = path.join(base, 'kit');
  const repoRoot = path.join(base, 'repo');
  const git = (args) => execFileSync('git', args, {
    cwd: installRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@e.x' },
  }).toString().trim();
  try {
    copyDir(path.join(ROOT, 'templates'), path.join(installRoot, 'templates'));
    fs.mkdirSync(repoRoot, { recursive: true });
    git(['init', '-q', '-b', 'main']);
    const commit = (msg) => { git(['add', '-A']); git(['commit', '-q', '--allow-empty', '-m', msg]); return git(['rev-parse', 'HEAD']); };
    return fn(repoRoot, installRoot, commit);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const readIfExists = (rel) => {
  const p = path.join(ROOT, ...rel.split('/'));
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

/** Minimal frontmatter reader: the delimited block plus top-level scalars. */
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}

function listMd(dir) {
  const full = path.join(ROOT, ...dir.split('/'));
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.md')).sort();
}

const ROOT_TEMPLATES = 'templates/claude';
const CLAUDE_TEMPLATES = 'templates/claude/.claude';
const tpl = (installRoot, rel) => path.join(installRoot, ...CLAUDE_TEMPLATES.split('/'), ...rel.split('/'));
const toolsMod = require('../cli/lib/tools');
const pathsMod = require('../cli/lib/paths');

function run() {
  // ---------------------------------------------------------------- .mcp.json
  suite('assets: .mcp.json template');

  const mcpRaw = readIfExists(`${ROOT_TEMPLATES}/.mcp.json`);

  test('.mcp.json ships with the kit as a root template', () => {
    ok(mcpRaw !== null, `${ROOT_TEMPLATES}/.mcp.json is missing; the static-asset contract requires it`);
  });

  if (mcpRaw !== null) {
    const doc = JSON.parse(mcpRaw);

    test('every server is launched through the aidev CLI', () => {
      ok(Object.keys(doc.mcpServers || {}).length > 0, 'no servers declared');
      for (const [name, entry] of Object.entries(doc.mcpServers || {})) {
        eq(entry.command, 'aidev', `${name} must be launched via aidev`);
      }
    });

    test('every declared server is actually implemented', () => {
      for (const [name, entry] of Object.entries(doc.mcpServers || {})) {
        const target = (entry.args || [])[1];
        ok(Object.keys(mcpMod.SERVERS).includes(target),
          `${name} routes to "${target}", which aidev mcp does not implement`);
      }
    });

    // The whole reason the connection is resolved at runtime: a committed file
    // must never be able to leak a credential or pin one PKG's endpoint.
    test('no credential or endpoint is embedded', () => {
      ok(!/pat|token|password|secret|dev\.azure\.com/i.test(mcpRaw),
        '.mcp.json must not embed credentials or an organisation URL');
    });
  }

  // ------------------------------------------------------------- settings.json
  suite('assets: settings.json template');

  const settingsRaw = readIfExists(`${CLAUDE_TEMPLATES}/settings.json`);

  test('the settings.json template ships with the kit', () => {
    ok(settingsRaw !== null,
      `${CLAUDE_TEMPLATES}/settings.json is missing; without it aidev init cannot wire any hook`);
  });

  if (settingsRaw !== null) {
    const settings = JSON.parse(settingsRaw);

    test('all four documented hook events are wired', () => {
      const events = Object.keys(settings.hooks || {}).sort();
      eq(events, ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort());
    });

    // The provider-side half of model selection. Shared project settings sit above
    // the user's own ~/.claude/settings.json and below .claude/settings.local.json,
    // so one value here is the environment default that a developer can still
    // override for themselves without producing drift.
    test('a kit default model ships, so there is something to override', () => {
      ok(typeof settings.model === 'string' && settings.model.length > 0,
        'settings.json has no model key');
    });

    test('every wired hook names an implemented subcommand', () => {
      const implemented = Object.keys(hookMod.HOOKS);
      for (const [event, matchers] of Object.entries(settings.hooks || {})) {
        for (const matcher of matchers) {
          for (const h of matcher.hooks || []) {
            const invocation = [h.command, ...(h.args || [])].join(' ');
            const m = /aidev(?:\.js)?["']?\s+hook\s+([\w-]+)/.exec(invocation);
            ok(m, `${event}: ${JSON.stringify(h)} does not invoke an "aidev hook <name>" subcommand`);
            ok(implemented.includes(m[1]),
              `${event}: hook "${m[1]}" is not implemented (have: ${implemented.join(', ')})`);
          }
        }
      }
    });

    // A hook that only fires for Write would miss every Bash-driven write, which
    // is the bypass the guard is specifically written to catch.
    test('the guard matches the write tools and Bash', () => {
      const pre = (settings.hooks.PreToolUse || [])
        .find((m) => (m.hooks || []).some((h) =>
          /guard-write/.test([h.command, ...(h.args || [])].join(' '))));
      ok(pre, 'no PreToolUse matcher runs guard-write');
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'Bash']) {
        ok(new RegExp(`\\b${tool}\\b`).test(pre.matcher),
          `guard-write does not match ${tool}`);
      }
    });

    test('the deny list covers the protected floor', () => {
      const deny = (settings.permissions && settings.permissions.deny) || [];
      const denied = deny.join('\n');
      for (const p of ALWAYS_PROTECTED) {
        // `.aidev/.gitignore` is written by the CLI and is protected by policy;
        // it is also a plain file Claude Code has no reason to touch, so the
        // deny list is not required to spell it out.
        if (p === layout.AIDEV_GITIGNORE_REL) continue;
        ok(denied.includes(p),
          `permissions.deny does not mention the protected path ${p}`);
      }
    });

    // Claude Code consults only Edit(path) and Read(path) for file permissions.
    // A path rule written for Write, NotebookEdit or the legacy MultiEdit is
    // accepted and then never read, so the floor above would look covered while
    // nothing enforced it. Claude Code warns at startup; this fails the build
    // instead, which is the only version anyone sees before shipping.
    test('path rules name a tool the file permission check actually reads', () => {
      const IGNORED = ['Write', 'MultiEdit', 'NotebookEdit', 'Glob'];
      for (const list of ['deny', 'ask', 'allow']) {
        for (const rule of (settings.permissions || {})[list] || []) {
          const m = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
          if (!m) continue;
          ok(!IGNORED.includes(m[1]),
            `permissions.${list}: "${rule}" is never consulted — ` +
            `use Edit(${m[2]}) (Edit covers every file-editing tool)`);
        }
      }
    });

    // Every path the floor protects must be unwritable by any tool, and Edit is
    // the only rule shape that reaches all of them.
    test('every protected path is denied through an Edit rule', () => {
      const deny = (settings.permissions && settings.permissions.deny) || [];
      const edits = new Set(deny
        .map((r) => /^Edit\((.+)\)$/.exec(r))
        .filter(Boolean)
        .map((m) => m[1]));
      for (const p of ALWAYS_PROTECTED) {
        if (p === layout.AIDEV_GITIGNORE_REL) continue;
        ok(edits.has(p), `permissions.deny lacks Edit(${p})`);
      }
    });

    // `aidev` is installed on PATH by the installer, so the hook can be one
    // plain command. The old exec form pointed at ${CLAUDE_PROJECT_DIR}/cli,
    // which no longer exists inside a PKG clone.
    test('hooks use the string form "aidev hook <name>"', () => {
      for (const [event, matchers] of Object.entries(settings.hooks || {})) {
        for (const matcher of matchers) {
          for (const h of matcher.hooks || []) {
            eq(h.type, 'command', `${event}: hook type`);
            ok(/^aidev hook [\w-]+$/.test(h.command), `${event}: unexpected command ${JSON.stringify(h.command)}`);
            ok(h.args === undefined, `${event}: exec-form args are no longer used: ${JSON.stringify(h)}`);
            ok(!/CLAUDE_PROJECT_DIR|cli\/bin/.test(JSON.stringify(h)), `${event}: hook must not point into the old wrapper layout`);
          }
        }
      }
    });
  }

  // ----------------------------------------------------------------- CLAUDE.md
  suite('assets: CLAUDE.md');

  test('CLAUDE.md ships with the kit as a root template', () => {
    ok(readIfExists(`${ROOT_TEMPLATES}/CLAUDE.md`) !== null, `${ROOT_TEMPLATES}/CLAUDE.md is missing`);
  });

  test('the shipped CLAUDE.md describes the PKG-clone layout, not the wrapper', () => {
    const text = readIfExists(`${ROOT_TEMPLATES}/CLAUDE.md`) || '';
    ok(text.includes(layout.KNOWLEDGE_REL), `mentions ${layout.KNOWLEDGE_REL}`);
    ok(!/submodule/i.test(text), 'no longer talks about a submodule');
  });

  test('kit-owned files are tracked once applied', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot });
      const tracked = assets.listStaticFiles(repoRoot, { installRoot });
      for (const rel of ['CLAUDE.md', '.mcp.json', '.claude/settings.json']) {
        ok(tracked.includes(rel), `${rel} was materialised but is not tracked as a static asset`);
      }
    });
  });

  test('personal settings are never tracked', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot });
      fs.writeFileSync(path.join(repoRoot, '.claude', 'settings.local.json'), '{"mine":true}\n');
      ok(!assets.listStaticFiles(repoRoot, { installRoot }).includes('.claude/settings.local.json'),
        'settings.local.json is personal and must stay out of the lock');
    });
  });

  // ------------------------------------------------------------------- agents
  suite('assets: bundled agents');

  const AGENTS = [
    'agents-creator', 'issue-to-pr', 'knowledge-builder',
    'workflow-creator', 'permission-setting',
  ];
  const AGENT_DIR = `${CLAUDE_TEMPLATES}/agents`;
  const agentFiles = listMd(AGENT_DIR);

  test('all five documented agents ship', () => {
    const missing = AGENTS.filter((a) => !agentFiles.includes(`${a}.md`));
    ok(missing.length === 0, `missing agents: ${missing.join(', ') || '(none)'}`);
  });

  for (const file of agentFiles) {
    const fm = frontmatter(fs.readFileSync(path.join(ROOT, ...AGENT_DIR.split('/'), file), 'utf8'));
    test(`${file}: frontmatter declares name and description`, () => {
      ok(fm, 'no frontmatter block');
      eq(fm.name, file.replace(/\.md$/, ''), 'name must match the filename');
      ok(fm.description && fm.description.length > 10, 'description is missing or too short');
    });

    test(`${file}: frontmatter does not pin a model`, () => {
      // Claude Code gives a subagent's frontmatter `model` precedence over the
      // session model with no way to override it from above. A name here would
      // silently defeat .claude/settings.json, settings.local.json,
      // aidev.yaml's tools.agent_model and --agent-model all at once.
      ok(fm.model === undefined || fm.model === 'inherit',
        `a bundled agent must inherit the session model, not pin one (got ${fm.model})`);
    });
  }

  // ------------------------------------------------------------------- skills
  suite('assets: bundled skills');

  const SKILLS = [
    'repository-discovery', 'knowledge-usage', 'test-and-verify', 'secure-coding',
    'azure-devops', 'change-planning', 'code-review', 'commit-and-pr',
    'knowledge-sync', 'failure-triage',
  ];

  const SKILL_DIR = path.join(ROOT, ...CLAUDE_TEMPLATES.split('/'), 'skills');

  test('all ten documented skills ship', () => {
    const present = fs.existsSync(SKILL_DIR)
      ? fs.readdirSync(SKILL_DIR).filter((d) => fs.existsSync(path.join(SKILL_DIR, d, 'SKILL.md')))
      : [];
    const missing = SKILLS.filter((s) => !present.includes(s));
    ok(missing.length === 0, `missing skills: ${missing.join(', ') || '(none)'}`);
  });

  test('the renamed submodule-sync skill is gone', () => {
    ok(!fs.existsSync(path.join(SKILL_DIR, 'submodule-sync')), 'submodule-sync was replaced by knowledge-sync');
  });

  for (const name of SKILLS) {
    const p = path.join(SKILL_DIR, name, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    test(`${name}/SKILL.md: frontmatter declares name and description`, () => {
      const fm = frontmatter(fs.readFileSync(p, 'utf8'));
      ok(fm, 'no frontmatter block');
      eq(fm.name, name, 'name must match the directory');
      ok(fm.description && fm.description.length > 10, 'description is missing or too short');
    });
  }

  // ---------------------------------------------------------------- bootstrap
  suite('assets: bootstrap and CI');

  for (const rel of [
    'scripts/install.sh',
    'scripts/install.ps1',
    'pipelines/azure-pipelines-check.yml',
    'pipelines/azure-pipelines-sync.yml',
    '.gitignore',
    '.gitattributes',
  ]) {
    test(`${rel} ships with the kit`, () => {
      ok(readIfExists(rel) !== null, `${rel} is missing`);
    });
  }

  const ignore = readIfExists('.gitignore');
  if (ignore) {
    test('the kit\'s own .gitignore excludes credential-bearing paths', () => {
      for (const p of ['.claude/settings.local.json', '.env', '*.pem', '*.key']) {
        ok(ignore.includes(p), `.gitignore does not list ${p}`);
      }
    });
  }

  // The runtime-state ignores now live in the PKG, written by the CLI as
  // .aidev/.gitignore, so every clone gets them without editing its own root
  // .gitignore.
  test('.aidev/.gitignore keeps runtime state out of git', () => {
    for (const p of ['cache/', 'sync.lock', 'knowledge/.cache/', 'workflows/*/runs/']) {
      ok(layout.AIDEV_GITIGNORE.includes(p), `.aidev/.gitignore does not list ${p}`);
    }
  });

  // policy.yaml is reviewed and shared; ignoring it would silently unshare
  // the one file the whole approval flow exists to distribute. The Wiki and
  // the materialisation record are shared the same way.
  test('.aidev/.gitignore does not exclude the shared files', () => {
    for (const p of ['policy.yaml', 'knowledge/', 'materialized.json']) {
      ok(!new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm').test(layout.AIDEV_GITIGNORE),
        `.aidev/${p} must be committed, not ignored`);
    }
  });

  const attrs = readIfExists('.gitattributes');
  if (attrs) {
    // CRLF on checkout would change every hash and make `aidev check` report
    // drift on Windows for files nobody edited.
    test('.gitattributes pins LF so hashes match across platforms', () => {
      ok(/^\*\s+text=auto\s+eol=lf/m.test(attrs), 'missing "* text=auto eol=lf"');
    });
  }

  // ------------------------------------------------------ materialising the PKG
  // The templates above are only a promise; these tests are the delivery. Every
  // assertion in this suite is about the tree `aidev init` actually produces,
  // because that is the copy the hooks and the guard read.
  suite('assets: template trees and apply');

  const templatePairs = assets.listTemplateFiles(ROOT);
  const ROOT_FILES = ['CLAUDE.md', '.mcp.json'];

  test('every Claude template lands under .claude/ or as one of the two root files', () => {
    ok(templatePairs.length > 0, 'no templates were discovered');
    for (const { src, dest, tool } of templatePairs) {
      ok(path.isAbsolute(src), `${dest}: src is not absolute (${src})`);
      eq(tool, 'claude');
      ok(dest.startsWith('.claude/') || ROOT_FILES.includes(dest), `${dest} lands somewhere unexpected`);
    }
  });

  test('the templates cover settings, the root files, all agents and all skills', () => {
    const dests = templatePairs.map((p) => p.dest);
    ok(dests.includes('.claude/settings.json'), 'settings.json is not materialised');
    for (const f of ROOT_FILES) ok(dests.includes(f), `${f} is not materialised`);
    for (const a of AGENTS) ok(dests.includes(`.claude/agents/${a}.md`), `agent ${a} is not materialised`);
    for (const s of SKILLS) ok(dests.includes(`.claude/skills/${s}/SKILL.md`), `skill ${s} is not materialised`);
  });

  test('every tool has its own template tree, and each tree stays inside its config globs', () => {
    for (const id of toolsMod.TOOL_IDS) {
      const pairs = assets.listTemplateFiles(ROOT, { tools: [id] });
      ok(pairs.length > 0, `templates/${id} is empty`);
      for (const { dest } of pairs) {
        ok(pathsMod.matchesAny(layout.TOOL_CONFIG_GLOBS[id], dest), `${dest} (${id}) is outside the tool's config globs`);
      }
    }
    // The non-Claude trees carry every bundled agent so `--agent <name>` resolves there too.
    for (const a of AGENTS) {
      ok(fs.existsSync(path.join(ROOT, 'templates', 'copilot', '.github', 'agents', `${a}.agent.md`)), `copilot lacks ${a}`);
      ok(fs.existsSync(path.join(ROOT, 'templates', 'kiro', '.kiro', 'agents', `${a}.json`)), `kiro lacks ${a}`);
    }
    ok(fs.existsSync(path.join(ROOT, 'templates', 'codex', 'AGENTS.md')), 'codex lacks AGENTS.md');
  });

  test('the running CLI reads its templates from its own checkout by default', () => {
    eq(path.resolve(assets.DEFAULT_INSTALL_ROOT), ROOT, 'DEFAULT_INSTALL_ROOT');
    eq(assets.listTemplateFiles().map((p) => p.dest), templatePairs.map((p) => p.dest), 'same set');
  });

  test('applying to a fresh repo writes every template byte-identically and records it', () => {
    withTempKit((repoRoot, installRoot) => {
      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'abc' });
      ok(r.ok, `apply reported conflicts: ${JSON.stringify(r.conflicts)}`);
      eq(r.unchanged.length, 0, 'a fresh repo should have nothing already current');
      ok(r.created.length >= 17, `expected at least 17 files, got ${r.created.length}`);
      eq(r.created.length, templatePairs.length, 'one file per template');
      for (const { src, dest } of assets.listTemplateFiles(installRoot)) {
        ok(fs.readFileSync(src).equals(fs.readFileSync(path.join(repoRoot, ...dest.split('/')))), `${dest} does not match its template`);
      }
      const lockFile = path.join(repoRoot, '.aidev', 'materialized.json');
      ok(fs.existsSync(lockFile), 'lock written at .aidev/materialized.json');
      eq(path.resolve(cfgMod.lockPath(repoRoot)), path.resolve(lockFile), 'cfg.lockPath agrees');
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      eq(lock.schemaVersion, assets.LOCK_SCHEMA);
      eq(lock.kitCommit, 'abc', 'records the kit commit');
      eq(lock.tools, ['claude']);
      eq(lock.conflicts, []);
      for (const { dest } of templatePairs) {
        ok(lock.files[dest] && lock.files[dest].kit === lock.files[dest].file, `${dest} absent from the lock or not recorded as pristine`);
      }
      const insp = assets.inspectConfig(repoRoot, { installRoot, kitCommit: 'abc' });
      ok(insp.ok && insp.customised.length === 0 && !insp.outdated, `a fresh apply is not clean: ${JSON.stringify(insp)}`);
    });
  });

  test('applying twice changes nothing the second time', () => {
    withTempKit((repoRoot, installRoot) => {
      const first = assets.applyTemplates(repoRoot, { installRoot });
      const second = assets.applyTemplates(repoRoot, { installRoot });
      eq(second.created.length, 0, 'the second run created files');
      eq(second.updated.length, 0, 'the second run rewrote files');
      eq(second.unchanged.length, first.created.length, 'not every file was recognised as current');
    });
  });

  test('--dry-run writes nothing, not even the lock', () => {
    withTempKit((repoRoot, installRoot) => {
      const r = assets.applyTemplates(repoRoot, { installRoot, dryRun: true });
      ok(r.created.length > 0, 'dry run reported no work');
      ok(!fs.existsSync(path.join(repoRoot, '.claude', 'settings.json')), 'a dry run wrote a file');
      ok(!fs.existsSync(path.join(repoRoot, 'CLAUDE.md')), 'a dry run wrote a root file');
      ok(!fs.existsSync(path.join(repoRoot, '.aidev', 'materialized.json')), 'a dry run wrote the lock');
    });
  });

  // The routine update path: a newer kit ships a changed file and nobody
  // touched the copy. It is replaced without ceremony.
  test('an untouched file is replaced when the kit ships a new version', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'one' });
      const t = tpl(installRoot, 'settings.json');
      const bumped = `${fs.readFileSync(t, 'utf8').trimEnd()}\n`.replace('"deny"', '"deny" ');
      fs.writeFileSync(t, bumped);

      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'two' });
      ok(r.ok, `a routine update was reported as a conflict: ${JSON.stringify(r.conflicts)}`);
      eq(r.updated, ['.claude/settings.json']);
      eq(fs.readFileSync(path.join(repoRoot, '.claude', 'settings.json'), 'utf8'), bumped);
    });
  });

  // The team owns its copies: an edit is kept, reported as customised, and
  // never fails the inspection.
  test('a local edit is kept while the kit does not change the file', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'one' });
      const dest = path.join(repoRoot, 'CLAUDE.md');
      fs.appendFileSync(dest, '\n## Team notes\n\n- ours\n');

      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'one' });
      ok(r.ok, JSON.stringify(r.conflicts));
      eq(r.kept, ['CLAUDE.md']);
      ok(fs.readFileSync(dest, 'utf8').includes('- ours'), 'the edit was destroyed');
      const insp = assets.inspectConfig(repoRoot, { installRoot, kitCommit: 'one' });
      ok(insp.ok, 'a customised file must not fail the inspection');
      eq(insp.customised, ['CLAUDE.md']);
      eq(insp.conflicts, []);
    });
  });

  test('--force takes the kit version of an edited file', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot });
      const target = path.join(repoRoot, '.claude', 'settings.json');
      fs.writeFileSync(target, '{"hooks":{}}\n');
      const forced = assets.applyTemplates(repoRoot, { installRoot, force: true });
      ok(forced.ok, 'force reported a conflict');
      eq(forced.updated, ['.claude/settings.json']);
      ok(fs.readFileSync(tpl(installRoot, 'settings.json')).equals(fs.readFileSync(target)), 'force left the file unlike the template');
    });
  });

  test('a file that exists before the first apply and differs is a conflict, not an overwrite', () => {
    withTempKit((repoRoot, installRoot) => {
      const target = path.join(repoRoot, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"hooks":{}}\n');
      const r = assets.applyTemplates(repoRoot, { installRoot });
      ok(!r.ok, 'a pre-existing divergent file was accepted');
      eq(r.conflicts.map((c) => c.path), ['.claude/settings.json']);
      eq(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n', 'the file was overwritten');
      ok(!assets.hasConflictMarkers(fs.readFileSync(target)), 'markers were written although nothing could be merged');
    });
  });

  // The design centre: both sides changed. With the kit's history at hand the
  // previous template is the merge base; disjoint hunks merge, overlapping
  // ones are written as git-style conflicts for the team to resolve.
  test('an edited file is merged three ways when the kit changes it too', () => {
    withGitKit((repoRoot, installRoot, commit) => {
      const one = commit('one');
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: one });
      const dest = path.join(repoRoot, 'CLAUDE.md');
      fs.appendFileSync(dest, '\n## Team notes\n\n- ours\n');

      const t = tpl(installRoot, '../CLAUDE.md');
      fs.writeFileSync(t, fs.readFileSync(t, 'utf8').replace('# CLAUDE.md — ai-dev-kit', '# CLAUDE.md — ai-dev-kit (v2)'));
      const two = commit('two');

      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: two });
      ok(r.ok, `expected a clean merge: ${JSON.stringify(r.conflicts)}`);
      eq(r.merged, ['CLAUDE.md']);
      const text = fs.readFileSync(dest, 'utf8');
      ok(text.includes('(v2)'), 'the kit change is missing after the merge');
      ok(text.includes('- ours'), 'the local edit is missing after the merge');
      ok(!assets.hasConflictMarkers(Buffer.from(text)), 'markers in a clean merge');
      eq(assets.inspectConfig(repoRoot, { installRoot, kitCommit: two }).customised, ['CLAUDE.md']);
    });
  });

  test('overlapping changes leave conflict markers, fail the inspection, and are recorded until resolved', () => {
    withGitKit((repoRoot, installRoot, commit) => {
      const one = commit('one');
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: one });
      const dest = path.join(repoRoot, 'CLAUDE.md');
      fs.appendFileSync(dest, '\n- ours\n');
      const t = tpl(installRoot, '../CLAUDE.md');
      fs.appendFileSync(t, '\n- kit\n');
      const two = commit('two');

      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: two });
      ok(!r.ok, 'an overlapping change merged cleanly?');
      eq(r.conflicts.map((c) => c.path), ['CLAUDE.md']);
      const text = fs.readFileSync(dest, 'utf8');
      ok(assets.hasConflictMarkers(Buffer.from(text)), 'no markers were written');
      ok(text.includes('<<<<<<< CLAUDE.md (this package)') && text.includes(`>>>>>>> kit ${two.slice(0, 7)}`), text.slice(-300));
      eq(JSON.parse(fs.readFileSync(path.join(repoRoot, '.aidev', 'materialized.json'), 'utf8')).conflicts, ['CLAUDE.md']);
      let insp = assets.inspectConfig(repoRoot, { installRoot, kitCommit: two });
      ok(!insp.ok && insp.conflicts.length === 1, 'the inspection passed with markers present');

      // Still marked → still a conflict; apply leaves the file alone.
      const again = assets.applyTemplates(repoRoot, { installRoot, kitCommit: two });
      eq(again.conflicts.map((c) => c.path), ['CLAUDE.md']);
      eq(fs.readFileSync(dest, 'utf8'), text, 'apply rewrote a file the team is resolving');

      // Resolved (markers removed) → recorded, inspection clean, edit kept.
      fs.writeFileSync(dest, text.replace(/<<<<<<<[^\n]*\n/, '').replace(/=======\n/, '').replace(/>>>>>>>[^\n]*\n/, ''));
      const done = assets.applyTemplates(repoRoot, { installRoot, kitCommit: two });
      ok(done.ok, JSON.stringify(done.conflicts));
      eq(done.resolved, ['CLAUDE.md']);
      insp = assets.inspectConfig(repoRoot, { installRoot, kitCommit: two });
      ok(insp.ok, 'still failing after resolution');
      eq(insp.customised, ['CLAUDE.md']);
      ok(fs.readFileSync(dest, 'utf8').includes('- ours') && fs.readFileSync(dest, 'utf8').includes('- kit'), 'the resolution was lost');
    });
  });

  test('without the base in the kit history, an edited-and-changed file is a conflict left untouched', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'one' });
      const dest = path.join(repoRoot, '.claude', 'settings.json');
      fs.writeFileSync(dest, '{"hooks":{}}\n');
      const t = tpl(installRoot, 'settings.json');
      fs.writeFileSync(t, `${fs.readFileSync(t, 'utf8').trimEnd()}\n\n`);
      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'two' });
      ok(!r.ok, 'a local edit was silently overwritten');
      eq(r.conflicts.length, 1, JSON.stringify(r.conflicts));
      ok(/not in the kit checkout's history/.test(r.conflicts[0].reason), r.conflicts[0].reason);
      eq(fs.readFileSync(dest, 'utf8'), '{"hooks":{}}\n', 'the edit was destroyed');
    });
  });

  // A file the kit stops shipping has to disappear if it is still the kit's
  // copy, and must stay if the team changed it. Only lock-known files qualify.
  test('a retired file is pruned when pristine and kept when edited; a team file is untouched', () => {
    withTempKit((repoRoot, installRoot) => {
      const retiredTpl = tpl(installRoot, 'agents/retired.md');
      const editedTpl = tpl(installRoot, 'agents/edited.md');
      fs.writeFileSync(retiredTpl, '# was shipped once\n');
      fs.writeFileSync(editedTpl, '# was shipped once\n');
      assets.applyTemplates(repoRoot, { installRoot });
      const retired = path.join(repoRoot, '.claude', 'agents', 'retired.md');
      const edited = path.join(repoRoot, '.claude', 'agents', 'edited.md');
      const teamOwned = path.join(repoRoot, '.claude', 'agents', 'team-owned.md');
      fs.appendFileSync(edited, 'team change\n');
      fs.writeFileSync(teamOwned, '# never shipped\n');
      fs.rmSync(retiredTpl); fs.rmSync(editedTpl);

      const r = assets.applyTemplates(repoRoot, { installRoot });
      eq(r.pruned, ['.claude/agents/retired.md']);
      eq(r.retired, ['.claude/agents/edited.md']);
      ok(!fs.existsSync(retired), 'retired.md is still on disk');
      ok(fs.existsSync(edited), 'an edited retired file was deleted');
      ok(fs.existsSync(teamOwned), 'a team-owned file was deleted');
      ok(!assets.listStaticFiles(repoRoot, { installRoot }).includes('.claude/agents/team-owned.md'), 'a team file is listed as kit-owned');
      ok(!('.claude/agents/edited.md' in r.lock.files), 'a retired file stayed in the lock');
    });
  });

  test('personal settings are never overwritten, pruned or recorded', () => {
    withTempKit((repoRoot, installRoot) => {
      const local = path.join(repoRoot, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, '{"mine":true}\n');
      assets.applyTemplates(repoRoot, { installRoot });
      const r = assets.applyTemplates(repoRoot, { installRoot });
      eq(fs.readFileSync(local, 'utf8'), '{"mine":true}\n', 'settings.local.json was touched');
      ok(!('.claude/settings.local.json' in r.lock.files), 'personal settings recorded in the lock');
      ok(!assets.listStaticFiles(repoRoot, { installRoot }).includes('.claude/settings.local.json'));
    });
  });

  test('removing the kit hooks from settings.json fails the inspection; other edits do not', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot });
      const target = path.join(repoRoot, '.claude', 'settings.json');
      const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
      doc.permissions.deny.push('Edit(team/**)');
      fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
      ok(assets.inspectConfig(repoRoot, { installRoot }).ok, 'an added deny rule failed the inspection');

      delete doc.hooks.PreToolUse;
      fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
      const insp = assets.inspectConfig(repoRoot, { installRoot });
      ok(!insp.ok, 'removing the guard passed');
      eq(insp.hooksMissing, ['aidev hook guard-write']);
    });
  });

  test('a lock written by an older kit commit is reported as outdated, and a missing file as missing', () => {
    withTempKit((repoRoot, installRoot) => {
      assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'one' });
      fs.rmSync(path.join(repoRoot, '.mcp.json'));
      const insp = assets.inspectConfig(repoRoot, { installRoot, kitCommit: 'two' });
      ok(insp.ok, 'missing or outdated must not fail the inspection');
      eq(insp.missing, ['.mcp.json']);
      eq(insp.outdated, true);
      const r = assets.applyTemplates(repoRoot, { installRoot, kitCommit: 'two' });
      eq(r.created, ['.mcp.json'], 'apply did not restore the missing file');
    });
  });

  // ------------------------------------------------------------- init end-to-end
  suite('assets: aidev init sets up a bare PKG clone');

  const BARE = { withConfig: false, withAssets: false, withPolicy: false, withWiki: false, withLock: false };

  test('init on a fresh clone writes the config, the tool config and the record', () => {
    const fx = makeRepo(BARE);
    try {
      ok(!fs.existsSync(path.join(fx.root, 'aidev.yaml')), 'the fixture already had aidev.yaml; the test would prove nothing');
      ok(!fs.existsSync(path.join(fx.root, '.claude', 'settings.json')), 'the fixture already had settings.json');

      const r = aidev(['init', '--yes'], fx.root);
      eq(r.code, 0, `init failed: ${r.out}`);

      // aidev.yaml: schema v2, hosting inferred as generic from the local origin.
      const cfgText = fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8');
      ok(/^version:\s*2\s*$/m.test(cfgText), `aidev.yaml is not schema v2: ${cfgText.slice(0, 200)}`);
      const config = cfgMod.loadConfig(fx.root);
      eq(config.hosting.type, 'generic', 'hosting inferred from a local origin URL');
      // The fixture's bare remote is <tmp>/origin.git, so that is the inferred name.
      eq(config.package.name, 'origin', 'named after the origin repository');
      ok(config.package.include.includes('src/**'), `include proposed from the tree: ${config.package.include}`);
      ok(config.package.include.includes('docs/**'), 'docs proposed too');

      // The materialised tool configuration.
      const settingsPath = path.join(fx.root, '.claude', 'settings.json');
      ok(fs.existsSync(settingsPath), `init did not create settings.json: ${r.out}`);
      const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      eq(Object.keys(doc.hooks || {}).sort(),
        ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort());
      for (const f of ROOT_FILES) ok(fs.existsSync(path.join(fx.root, f)), `missing ${f}`);
      for (const a of AGENTS) {
        ok(fs.existsSync(path.join(fx.root, '.claude', 'agents', `${a}.md`)), `missing agent ${a}`);
      }
      for (const s of SKILLS) {
        ok(fs.existsSync(path.join(fx.root, '.claude', 'skills', s, 'SKILL.md')), `missing skill ${s}`);
      }

      // Drift detection is only meaningful if the generated tree is in the lock.
      const lock = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev', 'materialized.json'), 'utf8'));
      ok(lock.files['.claude/settings.json'], 'settings.json is absent from .aidev/materialized.json');
      ok(lock.files['CLAUDE.md'], 'CLAUDE.md is absent from the record');
      ok(assets.inspectConfig(fx.root).ok, 'a freshly initialised repo already fails the tool-config inspection');

      // Runtime state stays out of git.
      eq(fs.readFileSync(path.join(fx.root, '.aidev', '.gitignore'), 'utf8'), layout.AIDEV_GITIGNORE, '.aidev/.gitignore');

      // The policy waits for a human: a candidate, not the real thing.
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'policy.candidate.yaml')), 'policy candidate written');
      ok(!fs.existsSync(cfgMod.policyPath(fx.root)), 'policy not placed without approval');

      // The clone is registered on this machine.
      const reg = JSON.parse(fs.readFileSync(path.join(HOME, 'registry.json'), 'utf8'));
      ok(reg.packages.some((p) => path.resolve(p.path).toLowerCase() === path.resolve(fx.root).toLowerCase()),
        `registered in AIDEV_HOME: ${JSON.stringify(reg)}`);
    } finally { fx.cleanup(); }
  });

  test('init --approve places the policy directly', () => {
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes', '--approve'], fx.root);
      eq(r.code, 0, `init failed: ${r.out}`);
      ok(fs.existsSync(cfgMod.policyPath(fx.root)), 'policy placed');
      ok(!fs.existsSync(path.join(fx.root, '.aidev', 'policy.candidate.yaml')), 'no dangling candidate');
      const pol = cfgMod.loadPolicy(fx.root, { required: true });
      for (const p of ALWAYS_PROTECTED) ok(pol.protected.includes(p), `policy protects ${p}`);
      ok(pol.protected.some((p) => /secrets/.test(p)), 'secrets_paths are protected');
    } finally { fx.cleanup(); }
  });

  test('init --json on a fresh clone reports the first-time steps', () => {
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes', '--json'], fx.root);
      eq(r.code, 0, r.out);
      const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
      eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}: ${r.out}`);
      const j = lastJson(r.out);
      eq(j.ok, true, 'ok');
      eq(j.firstTime, true, 'first time');
      const names = j.steps.map((s) => `${s.step}:${s.action}`);
      ok(names.includes('aidev.yaml:create'), `wrote the config: ${names}`);
      ok(names.includes('tool config:materialised'), `materialised: ${names}`);
      ok(names.includes('materialized.json:write'), `recorded: ${names}`);
      ok(names.includes('registry:registered'), `registered: ${names}`);
      ok(names.includes('policy:candidate'), `candidate: ${names}`);
      // A first-time init builds the Wiki. Without Claude Code (the harness points
      // AIDEV_CLAUDE_BIN at nothing) only the structured half is written, which is
      // still a successful build step; the prose stays queued for the next init.
      ok(names.includes('knowledge:built'), `wiki built: ${names}`);
    } finally { fx.cleanup(); }
  });

  test('init --dry-run writes nothing', () => {
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes', '--dry-run'], fx.root);
      eq(r.code, 0, r.out);
      for (const rel of ['aidev.yaml', 'CLAUDE.md', '.mcp.json', '.claude/settings.json',
        '.aidev/materialized.json', '.aidev/policy.candidate.yaml']) {
        ok(!fs.existsSync(path.join(fx.root, ...rel.split('/'))), `dry run wrote ${rel}`);
      }
    } finally { fx.cleanup(); }
  });

  test('init is idempotent and reports nothing to do the second time', () => {
    const fx = makeRepo(BARE);
    try {
      eq(aidev(['init', '--yes'], fx.root).code, 0);
      const cfgBefore = fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8');
      const r = aidev(['init', '--yes', '--json'], fx.root);
      eq(r.code, 0, r.out);

      // The stdout contract every other command keeps: exactly one JSON document.
      const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
      eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}: ${r.out}`);

      const j = lastJson(r.out);
      ok(j, `no JSON in output: ${r.out}`);
      eq(j.firstTime, false, 'no longer first time');
      const step = j.steps.find((s) => s.step === 'tool config');
      ok(step, `no tool config step reported: ${r.out}`);
      // The files and the record came from git the second time: init reports
      // and leaves them alone (taking newer templates is "aidev apply").
      eq(step.action, 'keep', `the second init touched the tool config: ${JSON.stringify(step)}`);
      eq(step.conflicts, 0);
      eq(fs.readFileSync(path.join(fx.root, 'aidev.yaml'), 'utf8'), cfgBefore, 'aidev.yaml was not rewritten');
    } finally { fx.cleanup(); }
  });

  // The team owns its copies once placed: a later init leaves an edit alone
  // and only reports; the kit's hooks removed is the one edit it warns about.
  test('a later init leaves an edited tool file alone; apply --force restores it', () => {
    const fx = makeRepo(BARE);
    try {
      eq(aidev(['init', '--yes'], fx.root).code, 0);
      const target = path.join(fx.root, '.claude', 'settings.json');
      fs.writeFileSync(target, '{"hooks":{}}\n');

      const r = aidev(['init', '--yes'], fx.root);
      eq(r.code, 0, `init failed on an edited file: ${r.out}`);
      eq(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n', 'init overwrote the edit');
      ok(/hooks are missing/.test(r.out), `init did not warn about the missing hooks: ${r.out}`);
      eq(aidev(['check', '--no-remote'], fx.root).code, 2, 'check must refuse a settings.json without the kit hooks');

      eq(aidev(['apply', '--force'], fx.root).code, 0, 'apply --force did not recover');
      ok(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PreToolUse, '--force did not restore the hooks');
      ok(assets.inspectConfig(fx.root).ok, 'the record was not refreshed after --force');
    } finally { fx.cleanup(); }
  });

  test('a pre-existing divergent file stops the first init with exit 2 and is not overwritten', () => {
    const fx = makeRepo(BARE);
    try {
      const target = path.join(fx.root, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{"hooks":{}}\n');
      const r = aidev(['init', '--yes'], fx.root);
      eq(r.code, 2, `expected exit 2, got ${r.code}: ${r.out}`);
      eq(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n', 'init overwrote the file');
      eq(aidev(['init', '--yes', '--force'], fx.root).code, 0, 'init --force did not recover');
      ok(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PreToolUse, '--force did not place the kit version');
    } finally { fx.cleanup(); }
  });

  test('init honours explicit flags over inference', () => {
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes', '--name', 'explicit', '--hosting', 'azure-devops',
        '--org', 'o', '--project', 'p', '--repository', 'r', '--include', 'src/**',
        '--tracking-branch', 'develop', '--agent-model', 'opus'], fx.root);
      eq(r.code, 0, r.out);
      const config = cfgMod.loadConfig(fx.root);
      eq(config.package.name, 'explicit', 'name');
      eq(config.hosting.type, 'azure-devops', 'hosting');
      eq(config.hosting.organization, 'o', 'org');
      eq(config.hosting.project, 'p', 'project');
      eq(config.hosting.repository, 'r', 'repository');
      eq(config.package.include, ['src/**'], 'include');
      eq(config.sync.tracking_branch, 'develop', 'tracking branch');
      eq(config.tools.agent_model, 'opus', 'agent model');
    } finally { fx.cleanup(); }
  });

  test('init with azure-devops hosting needs the three coordinates', () => {
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes', '--hosting', 'azure-devops'], fx.root);
      ok(r.code !== 0, 'refused');
      ok(/organization|--org/.test(r.out), `names what is missing: ${r.out}`);
      ok(!fs.existsSync(path.join(fx.root, 'aidev.yaml')), 'nothing half-written');
    } finally { fx.cleanup(); }
  });

  test('init run from a subdirectory sets up the clone root, not the subdirectory', () => {
    // findRepoRoot walks up to the directory holding .aidev/ (or, failing that,
    // the git toplevel), so nothing kit-owned can land inside src/.
    const fx = makeRepo(BARE);
    try {
      const r = aidev(['init', '--yes'], path.join(fx.root, 'src'));
      eq(r.code, 0, r.out);
      ok(fs.existsSync(path.join(fx.root, 'aidev.yaml')), 'aidev.yaml at the root');
      ok(!fs.existsSync(path.join(fx.root, 'src', 'aidev.yaml')), 'nothing written into src/');
      ok(!fs.existsSync(path.join(fx.root, 'src', '.claude')), 'no .claude/ inside src/');
    } finally { fx.cleanup(); }
  });

  // The registry is what `aidev update` reports on; a clone that init never
  // registered would silently miss every kit update.
  test('a registered clone is listed as present while it exists', () => {
    const fx = makeRepo(BARE);
    try {
      eq(aidev(['init', '--yes'], fx.root).code, 0);
      const env = { AIDEV_HOME: HOME };
      const listed = home.listPackages(env);
      ok(listed.present.some((p) => path.resolve(p.path).toLowerCase() === path.resolve(fx.root).toLowerCase()), 'present');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}

