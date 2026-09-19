'use strict';
/**
 * End-to-end check of the kit's own shipped assets.
 *
 * The unit suites build their static files from fixtures, so they would keep
 * passing even if the kit shipped none. This script exercises the real files in
 * this repository against the code that consumes them:
 *
 *   - .mcp.json          must route to an implemented `aidev mcp` server
 *   - settings.json      its hooks must name implemented `aidev hook` names,
 *                        and its deny list must cover the protected floor
 *   - CLAUDE.md          must exist and be tracked as a kit-owned static file
 *   - agents / skills    frontmatter must parse and declare name + description
 *
 * `.claude/` is generated, so the contract has two halves and both are checked
 * here: the templates under `templates/claude-assets/` must be valid, and
 * `aidev init` must turn them into a `.claude/` whose hooks are really wired.
 * Validating only the templates would pass on a repo where init silently wrote
 * nothing at all.
 *
 * Run: node test/assets.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { suite, test, ok, eq } = require('./harness');
const { makeRepo, copyTemplates } = require('./fixtures');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'cli', 'bin', 'aidev.js');
const hookMod = require('../cli/commands/hook');
const mcpMod = require('../cli/commands/mcp');
const assets = require('../cli/lib/assets');
const { ALWAYS_PROTECTED } = require('../cli/lib/config');

/** Run the real CLI the way a pipeline does, capturing code and output. */
function aidev(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AIDEV_NO_COLOR: '1' },
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
 * A bare directory holding only the kit's templates.
 *
 * Materialisation needs no git, no config and no submodule, so the fixture is
 * deliberately smaller than makeRepo(): anything else in the directory could
 * only obscure which file the code under test actually wrote.
 */
function withTempKit(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-assets-'));
  try {
    copyTemplates(root);
    return fn(root);
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const readIfExists = (rel) => {
  const p = path.join(ROOT, rel);
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
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith('.md')).sort();
}

function run() {
  // ---------------------------------------------------------------- .mcp.json
  suite('assets: .mcp.json');

  const mcpRaw = readIfExists('.mcp.json');

  test('.mcp.json ships with the kit', () => {
    ok(mcpRaw !== null, '.mcp.json is missing; the static-asset contract requires it');
  });

  if (mcpRaw !== null) {
    const doc = JSON.parse(mcpRaw);

    test('every server is launched through the aidev CLI', () => {
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

  const settingsRaw = readIfExists(`${assets.TEMPLATE_ROOT}/settings.json`);

  test('the settings.json template ships with the kit', () => {
    ok(settingsRaw !== null,
      `${assets.TEMPLATE_ROOT}/settings.json is missing; without it aidev init cannot wire any hook`);
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
            const m = /aidev\s+hook\s+([\w-]+)/.exec(h.command || '');
            ok(m, `${event}: "${h.command}" is not an "aidev hook <name>" invocation`);
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
        .find((m) => (m.hooks || []).some((h) => /guard-write/.test(h.command || '')));
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
        // `.aidev-ejected` is covered, but the floor is what must be reachable.
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
        ok(edits.has(p), `permissions.deny lacks Edit(${p})`);
      }
    });

    test('hooks invoke the CLI with no shell syntax', () => {
      for (const matchers of Object.values(settings.hooks || {})) {
        for (const matcher of matchers) {
          for (const h of matcher.hooks || []) {
            ok(!/[|&;><$`]/.test(h.command || ''),
              `"${h.command}" contains shell syntax; hooks must run on Windows and POSIX alike`);
          }
        }
      }
    });
  }

  // ----------------------------------------------------------------- CLAUDE.md
  suite('assets: CLAUDE.md');

  test('CLAUDE.md ships with the kit', () => {
    ok(readIfExists('CLAUDE.md') !== null, 'CLAUDE.md is missing');
  });

  test('kit-owned files are tracked for drift detection', () => {
    const tracked = assets.listStaticFiles(ROOT);
    for (const rel of ['CLAUDE.md', '.mcp.json']) {
      if (fs.existsSync(path.join(ROOT, rel))) {
        ok(tracked.includes(rel), `${rel} exists but is not tracked as a static asset`);
      }
    }
  });

  test('personal settings are never tracked', () => {
    ok(!assets.listStaticFiles(ROOT).includes('.claude/settings.local.json'),
      'settings.local.json is personal and must stay out of the lock');
  });

  // ------------------------------------------------------------------- agents
  suite('assets: bundled agents');

  const AGENTS = [
    'agents-creator', 'issue-to-pr', 'knowledge-builder',
    'workflow-creator', 'permission-setting',
  ];
  const AGENT_DIR = `${assets.TEMPLATE_ROOT}/agents`;
  const agentFiles = listMd(AGENT_DIR);

  test('all five documented agents ship', () => {
    const missing = AGENTS.filter((a) => !agentFiles.includes(`${a}.md`));
    ok(missing.length === 0, `missing agents: ${missing.join(', ') || '(none)'}`);
  });

  for (const file of agentFiles) {
    const fm = frontmatter(fs.readFileSync(path.join(ROOT, AGENT_DIR, file), 'utf8'));
    test(`${file}: frontmatter declares name and description`, () => {
      ok(fm, 'no frontmatter block');
      eq(fm.name, file.replace(/\.md$/, ''), 'name must match the filename');
      ok(fm.description && fm.description.length > 10, 'description is missing or too short');
    });

    test(`${file}: frontmatter does not pin a model`, () => {
      // Claude Code gives a subagent's frontmatter `model` precedence over the
      // session model with no way to override it from above. A name here would
      // silently defeat .claude/settings.json, settings.local.json,
      // aidev.yaml's model.agent and --agent-model all at once.
      eq(fm.model, 'inherit',
        'a bundled agent must inherit the session model, not pin one');
    });
  }

  // ------------------------------------------------------------------- skills
  suite('assets: bundled skills');

  const SKILLS = [
    'repository-discovery', 'knowledge-usage', 'test-and-verify', 'secure-coding',
    'azure-devops', 'change-planning', 'code-review', 'commit-and-pr',
    'submodule-sync', 'failure-triage',
  ];

  const SKILL_DIR = path.join(ROOT, ...assets.TEMPLATE_ROOT.split('/'), 'skills');

  test('all ten documented skills ship', () => {
    const present = fs.existsSync(SKILL_DIR)
      ? fs.readdirSync(SKILL_DIR).filter((d) => fs.existsSync(path.join(SKILL_DIR, d, 'SKILL.md')))
      : [];
    const missing = SKILLS.filter((s) => !present.includes(s));
    ok(missing.length === 0, `missing skills: ${missing.join(', ') || '(none)'}`);
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
    test('.gitignore excludes every credential-bearing and local-state path', () => {
      for (const p of [
        '.claude/settings.local.json', '.env', '.aidev/cache/', '.aidev/tasks/',
        '.aidev/leases/', '.aidev/sync.lock', 'knowledge/.cache/', 'workflows/*/runs/',
      ]) {
        ok(ignore.includes(p), `.gitignore does not list ${p}`);
      }
    });

    // policy.yaml is reviewed and shared; ignoring it would silently unshare
    // the one file the whole approval flow exists to distribute.
    test('.gitignore does not exclude the shared policy', () => {
      ok(!/^\.aidev\/policy\.yaml\s*$/m.test(ignore),
        '.aidev/policy.yaml must be committed, not ignored');
    });
  }

  const attrs = readIfExists('.gitattributes');
  if (attrs) {
    // CRLF on checkout would change every hash and make `aidev check` report
    // drift on Windows for files nobody edited.
    test('.gitattributes pins LF so hashes match across platforms', () => {
      ok(/^\*\s+text=auto\s+eol=lf/m.test(attrs), 'missing "* text=auto eol=lf"');
    });
  }

  // ------------------------------------------------------ materialising .claude
  // The templates above are only a promise; these tests are the delivery. Every
  // assertion in this suite is about the tree `aidev init` actually produces,
  // because that is the copy the hooks and the guard read.
  suite('assets: .claude/ materialisation');

  const templatePairs = assets.listTemplateFiles(ROOT);

  test('every template maps to a path under .claude/', () => {
    ok(templatePairs.length > 0, 'no templates were discovered');
    for (const { dest } of templatePairs) {
      ok(dest.startsWith('.claude/'), `${dest} escapes .claude/`);
    }
  });

  test('the templates cover settings, all agents and all skills', () => {
    const dests = templatePairs.map((p) => p.dest);
    ok(dests.includes('.claude/settings.json'), 'settings.json is not materialised');
    for (const a of AGENTS) {
      ok(dests.includes(`.claude/agents/${a}.md`), `agent ${a} is not materialised`);
    }
    for (const s of SKILLS) {
      ok(dests.includes(`.claude/skills/${s}/SKILL.md`), `skill ${s} is not materialised`);
    }
  });

  test('materialising a fresh repo writes .claude/ byte-identically', () => {
    withTempKit((root) => {
      const r = assets.materializeStaticAssets(root);
      ok(r.ok, `materialisation reported conflicts: ${JSON.stringify(r.conflicts)}`);
      eq(r.unchanged.length, 0, 'a fresh repo should have nothing already current');
      ok(r.created.length >= 16, `expected at least 16 files, got ${r.created.length}`);

      for (const { src, dest } of assets.listTemplateFiles(root)) {
        const want = fs.readFileSync(path.join(root, src));
        const got = fs.readFileSync(path.join(root, dest));
        ok(want.equals(got), `${dest} does not match its template`);
      }
    });
  });

  test('materialising twice changes nothing the second time', () => {
    withTempKit((root) => {
      const first = assets.materializeStaticAssets(root);
      const second = assets.materializeStaticAssets(root);
      eq(second.created.length, 0, 'the second run created files');
      eq(second.updated.length, 0, 'the second run rewrote files');
      eq(second.unchanged.length, first.created.length, 'not every file was recognised as current');
    });
  });

  // Overwriting silently would destroy the only copy of the edit; the design
  // routes kit-owned changes through a PR to the kit instead.
  test('a hand-edited kit file is a conflict, not an overwrite', () => {
    withTempKit((root) => {
      assets.materializeStaticAssets(root);
      const target = path.join(root, '.claude', 'settings.json');
      fs.writeFileSync(target, '{"hooks":{}}\n');

      const r = assets.materializeStaticAssets(root);
      ok(!r.ok, 'a divergent file was accepted');
      eq(r.conflicts.length, 1, JSON.stringify(r.conflicts));
      eq(r.conflicts[0].path, '.claude/settings.json');
      eq(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n', 'the local edit was destroyed anyway');

      const forced = assets.materializeStaticAssets(root, { force: true });
      ok(forced.ok, 'force did not resolve the conflict');
      eq(forced.updated.length, 1, 'force did not rewrite the file');
      const want = fs.readFileSync(path.join(root, ...assets.TEMPLATE_ROOT.split('/'), 'settings.json'));
      ok(want.equals(fs.readFileSync(target)), 'force left the file unlike the template');
    });
  });

  test('--dry-run writes nothing', () => {
    withTempKit((root) => {
      const r = assets.materializeStaticAssets(root, { dryRun: true });
      ok(r.created.length > 0, 'dry run reported no work');
      ok(!fs.existsSync(path.join(root, '.claude', 'settings.json')), 'a dry run wrote a file');
    });
  });

  // This is the `aidev update` path. After a newer kit lands, the generated file
  // differs from the new template simply because it is the previous generation.
  // Treating that as a conflict would make every routine update demand --force,
  // which trains people to pass it and defeats the check entirely.
  test('the untouched previous generation is replaced without --force', () => {
    withTempKit((root) => {
      assets.materializeStaticAssets(root);
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));

      // The kit ships a new version of the file; nobody touched the copy on disk.
      const tpl = path.join(root, ...assets.TEMPLATE_ROOT.split('/'), 'settings.json');
      const bumped = `${fs.readFileSync(tpl, 'utf8').trimEnd()}\n`.replace('"deny"', '"deny" ');
      fs.writeFileSync(tpl, bumped);

      const r = assets.materializeStaticAssets(root);
      ok(r.ok, `a routine update was reported as a conflict: ${JSON.stringify(r.conflicts)}`);
      eq(r.updated, ['.claude/settings.json']);
      eq(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), bumped);
    });
  });

  test('a local edit is still a conflict even when the kit also moved', () => {
    withTempKit((root) => {
      assets.materializeStaticAssets(root);
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));

      // Both sides changed: the lock no longer matches what is on disk.
      const tpl = path.join(root, ...assets.TEMPLATE_ROOT.split('/'), 'settings.json');
      fs.writeFileSync(tpl, `${fs.readFileSync(tpl, 'utf8').trimEnd()}\n\n`);
      const dest = path.join(root, '.claude', 'settings.json');
      fs.writeFileSync(dest, '{"hooks":{}}\n');

      const r = assets.materializeStaticAssets(root);
      ok(!r.ok, 'a local edit was silently overwritten');
      eq(r.conflicts.length, 1, JSON.stringify(r.conflicts));
      eq(r.conflicts[0].reason, 'has been edited locally');
      eq(fs.readFileSync(dest, 'utf8'), '{"hooks":{}}\n', 'the edit was destroyed');
    });
  });

  // A file the kit stops shipping has to disappear, or it lingers as `extra` in
  // every later drift check. Only lock-known files qualify: the lock is the
  // evidence that the file was ours to delete.
  test('a file the kit no longer ships is pruned; a team file is not', () => {
    withTempKit((root) => {
      assets.materializeStaticAssets(root);
      const retired = path.join(root, '.claude', 'agents', 'retired.md');
      const teamOwned = path.join(root, '.claude', 'agents', 'team-owned.md');

      // Order is the whole test: only what exists when the lock is written is
      // recorded as kit-generated, so the team file added afterwards is not.
      fs.writeFileSync(retired, '# was shipped once\n');
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
      fs.writeFileSync(teamOwned, '# never shipped\n');

      const r = assets.materializeStaticAssets(root);
      ok(r.pruned.includes('.claude/agents/retired.md'), `retired.md was not pruned: ${r.pruned}`);
      ok(!fs.existsSync(retired), 'retired.md is still on disk');
      ok(fs.existsSync(teamOwned), 'a team-owned file was deleted');
    });
  });

  test('personal settings are never overwritten or pruned', () => {
    withTempKit((root) => {
      const local = path.join(root, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, '{"mine":true}\n');
      assets.materializeStaticAssets(root);
      assets.writeLock(root, assets.buildLock(root, { kitCommit: null }));
      assets.materializeStaticAssets(root);
      eq(fs.readFileSync(local, 'utf8'), '{"mine":true}\n', 'settings.local.json was touched');
    });
  });

  // ------------------------------------------------------------- init end-to-end
  suite('assets: aidev init materialises .claude/');

  test('init on a fresh clone leaves the hooks wired', () => {
    const fx = makeRepo({ withTemplates: true, withLock: false });
    try {
      ok(!fs.existsSync(path.join(fx.root, '.claude', 'settings.json')),
        'the fixture already had settings.json; the test would prove nothing');

      const r = aidev(['init', '--yes'], fx.root);
      eq(r.code, 0, `init failed: ${r.out}`);

      const settingsPath = path.join(fx.root, '.claude', 'settings.json');
      ok(fs.existsSync(settingsPath), `init did not create settings.json: ${r.out}`);

      // The whole point: the file that lands must wire real hooks.
      const doc = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      eq(Object.keys(doc.hooks || {}).sort(),
        ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort());

      for (const a of AGENTS) {
        ok(fs.existsSync(path.join(fx.root, '.claude', 'agents', `${a}.md`)), `missing agent ${a}`);
      }
      for (const s of SKILLS) {
        ok(fs.existsSync(path.join(fx.root, '.claude', 'skills', s, 'SKILL.md')), `missing skill ${s}`);
      }

      // Drift detection is only meaningful if the generated tree is in the lock.
      const lock = JSON.parse(fs.readFileSync(path.join(fx.root, '.aidev-lock'), 'utf8'));
      ok(lock.files['.claude/settings.json'], 'settings.json is absent from .aidev-lock');
      ok(assets.detectDrift(fx.root).ok, 'a freshly initialised repo already reports drift');
    } finally { fx.cleanup(); }
  });

  test('init is idempotent and reports nothing to do the second time', () => {
    const fx = makeRepo({ withTemplates: true, withLock: false });
    try {
      eq(aidev(['init', '--yes'], fx.root).code, 0);
      const r = aidev(['init', '--yes', '--json'], fx.root);
      eq(r.code, 0, r.out);

      // The stdout contract every other command keeps: human lines may precede
      // it, but there is exactly one JSON document.
      const docs = String(r.out).trim().split(/\n(?=\{)/).filter(Boolean);
      eq(docs.length, 1, `expected 1 JSON document, got ${docs.length}: ${r.out}`);

      const j = lastJson(r.out);
      ok(j, `no JSON in output: ${r.out}`);
      const step = j.steps.find((s) => s.step === '.claude');
      ok(step, `no .claude step reported: ${r.out}`);
      eq(step.created, 0, 'the second init recreated files');
      eq(step.updated, 0, 'the second init rewrote files');
      ok(step.unchanged > 0, 'the second init saw no current files');
    } finally { fx.cleanup(); }
  });

  // init must not be a way to launder an edit to a kit-owned file.
  test('init refuses to overwrite a divergent kit file without --force', () => {
    const fx = makeRepo({ withTemplates: true, withLock: false });
    try {
      eq(aidev(['init', '--yes'], fx.root).code, 0);
      const target = path.join(fx.root, '.claude', 'settings.json');
      fs.writeFileSync(target, '{"hooks":{}}\n');

      const r = aidev(['init', '--yes'], fx.root);
      eq(r.code, 2, `expected exit 2 (drift), got ${r.code}: ${r.out}`);
      eq(fs.readFileSync(target, 'utf8'), '{"hooks":{}}\n', 'init overwrote the edit anyway');

      eq(aidev(['init', '--yes', '--force'], fx.root).code, 0, 'init --force did not recover');
      ok(JSON.parse(fs.readFileSync(target, 'utf8')).hooks.PreToolUse, '--force did not restore the hooks');
    } finally { fx.cleanup(); }
  });
}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
