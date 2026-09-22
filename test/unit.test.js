'use strict';
/** Unit tests for yaml, paths, config validation (schema v2), leases. */

const path = require('path');
const fs = require('fs');
const { suite, test, eq, ok, throws } = require('./harness');
const yaml = require('../cli/lib/yaml');
const P = require('../cli/lib/paths');
const cfg = require('../cli/lib/config');
const leases = require('../cli/lib/leases');
const { makeRepo } = require('./fixtures');

function run() {
  suite('yaml: parsing');

  test('nested maps and lists', () => {
    const v = yaml.parse([
      'version: 2',
      'package:',
      '  name: my-pkg',
      '  include: ["a/**", "b/**"]',
      '  exclude:',
      '    - "**/node_modules/**"',
      '    - "**/vendor/**"',
    ].join('\n'));
    eq(v.version, 2);
    eq(v.package.name, 'my-pkg');
    eq(v.package.include, ['a/**', 'b/**']);
    eq(v.package.exclude, ['**/node_modules/**', '**/vendor/**']);
  });

  test('comments are stripped but "#" inside quotes survives', () => {
    const v = yaml.parse([
      'a: 1   # trailing comment',
      '# whole line',
      'b: "has # hash"',
      "c: 'single # hash'",
    ].join('\n'));
    eq(v.a, 1); eq(v.b, 'has # hash'); eq(v.c, 'single # hash');
  });

  test('scalar types', () => {
    const v = yaml.parse(['i: 42', 'f: 3.5', 'tt: true', 'ff: false', 'n: null', 'e: ~', 's: plain text'].join('\n'));
    eq(v.i, 42); eq(v.f, 3.5); eq(v.tt, true); eq(v.ff, false);
    eq(v.n, null); eq(v.e, null); eq(v.s, 'plain text');
  });

  test('sequence at parent indent level', () => {
    const v = yaml.parse(['secrets_paths:', '- "a/**"', '- "b/**"'].join('\n'));
    eq(v.secrets_paths, ['a/**', 'b/**']);
  });

  test('list of maps (pipeline schedules)', () => {
    const v = yaml.parse([
      'schedules:',
      '  - cron: "0 18 * * *"',
      '    always: true',
      '    branches: { include: [main] }',
    ].join('\n'));
    eq(v.schedules.length, 1);
    eq(v.schedules[0].cron, '0 18 * * *');
    eq(v.schedules[0].always, true);
    eq(v.schedules[0].branches.include, ['main']);
  });

  test('empty document yields an empty map', () => { eq(yaml.parse(''), {}); eq(yaml.parse('# only\n'), {}); });

  test('tabs and unterminated quotes are rejected', () => {
    throws(() => yaml.parse('a:\n\tb: 1'), /tab/i, 'tabs');
    throws(() => yaml.parse('a: "unterminated'), /unterminated/i, 'quote');
  });

  test('round-trips through stringify', () => {
    const src = { version: 1, protected: ['.claude/**', 'CLAUDE.md'], read_only: ['**'], nested: { a: 1, b: 'x y' } };
    const back = yaml.parse(yaml.stringify(src));
    eq(back, src);
  });

  test('stringify quotes values that would re-parse as another type', () => {
    const back = yaml.parse(yaml.stringify({ a: 'true', b: '123', c: '' }));
    eq(back.a, 'true'); eq(back.b, '123'); eq(back.c, '');
  });

  suite('paths: normalisation');

  test('separators fold and "." drops', () => {
    eq(P.normalizeRel('a\\b\\c'), 'a/b/c');
    eq(P.normalizeRel('./a/./b'), 'a/b');
    eq(P.normalizeRel('a/b/'), 'a/b');
  });

  test('".." is resolved lexically before matching', () => {
    eq(P.normalizeRel('.aidev/knowledge/../../.claude/settings.json'), '.claude/settings.json');
    eq(P.normalizeRel('a/b/../../c'), 'c');
  });

  test('traversal out of the repo is detectable', () => {
    ok(P.escapesRoot(P.normalizeRel('../outside')), 'parent escape');
    ok(!P.escapesRoot(P.normalizeRel('a/../b')), 'contained');
  });

  suite('paths: globs');

  test('"dir/**" matches the directory itself and all descendants', () => {
    ok(P.matches('.claude/**', '.claude'), 'bare dir');
    ok(P.matches('.claude/**', '.claude/settings.json'), 'child');
    ok(P.matches('.claude/**', '.claude/agents/x/y.md'), 'deep');
    ok(!P.matches('.claude/**', '.claudex/settings.json'), 'prefix must not leak');
    ok(P.matches('.aidev/knowledge/**', '.aidev/knowledge/api/auth.md'), 'nested kit dir');
    ok(!P.matches('.aidev/knowledge/**', '.aidev/policy.yaml'), 'sibling under .aidev is not the Wiki');
  });

  test('"**" alone matches every path in the repository', () => {
    ok(P.matches('**', 'notes.md'), 'root file');
    ok(P.matches('**', 'src/api/auth.ts'), 'nested file');
  });

  test('"*" stays within one segment', () => {
    ok(P.matches('*.pat', 'token.pat'));
    ok(!P.matches('*.pat', 'dir/token.pat'));
    ok(P.matches('src/*.ts', 'src/a.ts'));
    ok(!P.matches('src/*.ts', 'src/a/b.ts'));
  });

  test('leading "**/" matches at any depth including zero', () => {
    ok(P.matches('**/*.pfx', 'a.pfx'));
    ok(P.matches('**/*.pfx', 'x/y/a.pfx'));
    ok(P.matches('**/node_modules/**', 'src/node_modules/pkg/i.js'));
    ok(P.matches('**/node_modules/**', 'node_modules'));
  });

  test('traversal is matched against the resolved path', () => {
    ok(P.matches('.claude/**', '.aidev/knowledge/../../.claude/settings.json'), 'escape caught');
  });

  test('firstMatch reports which pattern fired', () => {
    eq(P.firstMatch(['a/**', 'src/**'], 'src/x.ts'), 'src/**');
    eq(P.firstMatch(['a/**'], 'z'), null);
  });

  test('include/exclude interaction', () => {
    ok(P.isIncluded('src/a.ts', ['src/**'], ['**/vendor/**']));
    ok(!P.isIncluded('src/vendor/a.ts', ['src/**'], ['**/vendor/**']), 'exclude wins');
    ok(!P.isIncluded('other/a.ts', ['src/**'], []), 'outside include');
    ok(P.isIncluded('anything', [], []), 'empty include = no restriction');
  });

  suite('config: validation (schema v2)');

  const base = {
    version: 2,
    package: { name: 'p' },
    hosting: { type: 'azure-devops', organization: 'o', project: 'pr', repository: 'r' },
  };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  test('defaults are filled in', () => {
    const c = cfg.validateConfig(clone(base));
    eq(c.version, 2);
    eq(c.hosting.type, 'azure-devops');
    eq(c.hosting.tracking_branch, 'main');
    eq(c.hosting.auth_env, 'AZURE_DEVOPS_PAT');
    eq(c.sync.tracking_branch, 'main', 'sync.tracking_branch mirrors hosting');
    eq(c.sync.remote_check_timeout_ms, 3000);
    eq(c.sync.pr.target_branch, 'main');
    eq(c.knowledge.max_files_per_dir, 20);
    eq(c.knowledge.evidence.include, ['**']);
    eq(c.tools.default, ['claude']);
    eq(c.tools.agent, 'claude');
    eq(c.tools.agent_model, 'sonnet');
  });

  test('azure_devops and model.agent aliases are derived from hosting and tools', () => {
    const c = cfg.validateConfig(clone(base));
    eq(c.azure_devops.organization, 'o');
    eq(c.azure_devops.project, 'pr');
    eq(c.azure_devops.repository, 'r');
    eq(c.azure_devops.auth_env, 'AZURE_DEVOPS_PAT');
    eq(c.model.agent, 'sonnet', 'model.agent aliases tools.agent_model');
    const g = cfg.validateConfig({ version: 2, package: { name: 'p' }, hosting: { type: 'generic' } });
    eq(g.azure_devops, null, 'generic hosting has no Azure DevOps alias');
    eq(g.hosting.auth_env, null);
    eq(g.sync.tracking_branch, 'main');
  });

  test('hosting.type is validated and azure-devops needs its coordinates', () => {
    throws(() => cfg.validateConfig({ ...clone(base), hosting: { type: 'gitlab' } }), /hosting\.type/);
    throws(() => cfg.validateConfig({ version: 2, package: { name: 'p' }, hosting: { type: 'azure-devops', organization: 'o' } }),
      /hosting\.project/);
    throws(() => cfg.validateConfig({ version: 2, package: { name: 'p' }, hosting: { type: 'azure-devops', organization: 'o', project: 'pr' } }),
      /hosting\.repository/);
    // Omitted hosting defaults to generic, which needs nothing.
    eq(cfg.validateConfig({ version: 2, package: { name: 'p' } }).hosting.type, 'generic');
  });

  test('tools.default and tools.agent only accept supported tools', () => {
    throws(() => cfg.validateConfig({ ...clone(base), tools: { default: ['cursor'] } }), /unsupported tool/);
    throws(() => cfg.validateConfig({ ...clone(base), tools: { agent: 'cursor' } }), /tools\.agent/);
    throws(() => cfg.validateConfig({ ...clone(base), tools: { default: [] } }), /at least one tool/);
    eq(cfg.validateConfig({ ...clone(base), tools: { default: 'claude' } }).tools.default, ['claude'], 'scalar default is accepted');
  });

  test('a model identifier is validated by shape, not against a list of models', () => {
    // Every form a provider legitimately uses has to pass, or the kit would need
    // a release every time Anthropic ships a model.
    for (const good of [
      'sonnet', 'opus', 'haiku', 'inherit', 'opusplan', 'sonnet[1m]',
      'claude-opus-4-8', 'claude-sonnet-4-5-20250929',
      'anthropic/claude-opus-4-8', 'us.anthropic.claude-opus-4-8-v1:0',
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile',
      'my_foundry_deployment',
    ]) {
      const c = cfg.validateConfig({ ...clone(base), tools: { agent_model: good } });
      eq(c.tools.agent_model, good, `rejected a legitimate model: ${good}`);
      eq(c.model.agent, good, `alias out of step for: ${good}`);
    }
  });

  test('a model value that could be read as a flag or split an argv is refused', () => {
    for (const bad of [
      '--dangerously-skip-permissions', '-p', 'a b', 'x\ny', 'a;b', 'a&&b',
      'a|b', 'a$b', "a'b", 'x'.repeat(cfg.MODEL_MAX_LENGTH + 1),
    ]) {
      throws(() => cfg.validateConfig({ ...clone(base), tools: { agent_model: bad } }),
        /tools\.agent_model/, `accepted an unsafe model: ${JSON.stringify(bad)}`);
    }
    throws(() => cfg.assertModel('-p'), /model/, 'assertModel applies the same shape check');
    eq(cfg.assertModel(''), null, 'assertModel: empty means "let the tool decide"');
  });

  test('an explicitly empty model means "let Claude Code decide", not the default', () => {
    // Distinct from an absent key: absent takes the kit default, empty means the
    // CLI passes no --model at all and leaves the resolution to Claude Code.
    const empty = cfg.validateConfig({ ...clone(base), tools: { agent_model: '' } });
    eq(empty.tools.agent_model, null);
    eq(empty.model.agent, null);
    eq(cfg.validateConfig({ ...clone(base), tools: {} }).tools.agent_model, 'sonnet');
  });

  test('tools written as a scalar is refused rather than silently ignored', () => {
    // `tools: claude` is the obvious way to mis-write this; treating it as an
    // empty mapping would drop the one thing the author asked for.
    throws(() => cfg.validateConfig({ ...clone(base), tools: 'claude' }), /must be a mapping/);
    throws(() => cfg.validateConfig({ ...clone(base), tools: ['claude'] }), /must be a mapping/);
    throws(() => cfg.validateConfig({ ...clone(base), hosting: 'azure-devops' }), /must be a mapping/);
  });

  test('required fields are enforced', () => {
    throws(() => cfg.validateConfig({ version: 2, package: {} }), /package.name/);
    throws(() => cfg.validateConfig({ version: 2, package: { name: 'p' }, hosting: { type: 'azure-devops', organization: 'o' } }), /project/);
    throws(() => cfg.validateConfig({ ...clone(base), version: 1 }), /unsupported version/);
    throws(() => cfg.validateConfig({ ...clone(base), version: 3 }), /unsupported version/);
    throws(() => cfg.validateConfig(null), /must be a mapping/);
  });

  test('embedded credentials are refused', () => {
    throws(() => cfg.validateConfig({ ...clone(base), hosting: { ...base.hosting, pat: 'x' } }),
      /must not be set/, 'explicit pat key');
    throws(() => cfg.validateConfig({ ...clone(base), hosting: { ...base.hosting, token: 'y' } }),
      /must not be set/, 'token key');
    throws(() => cfg.validateConfig({ ...clone(base), hosting: { ...base.hosting, PASSWORD: 'z' } }),
      /must not be set/, 'case-insensitive');
    throws(() => cfg.validateConfig({
      ...clone(base),
      hosting: { ...base.hosting, organization: 'A'.repeat(52) },
    }), /embedded credential/, 'credential-shaped value');
    // The env var *name* is exempt from the shape check: it is not a secret.
    eq(cfg.validateConfig({ ...clone(base), hosting: { ...base.hosting, auth_env: 'A'.repeat(52) } }).hosting.auth_env, 'A'.repeat(52));
  });

  test('numeric bounds are checked', () => {
    throws(() => cfg.validateConfig({ ...clone(base), knowledge: { max_files_per_dir: 0 } }), />= 1/);
    throws(() => cfg.validateConfig({ ...clone(base), sync: { lease_ttl_minutes: -5 } }), />= 1/);
    throws(() => cfg.validateConfig({ ...clone(base), sync: { remote_check_timeout_ms: 'many' } }), /integer/);
    throws(() => cfg.validateConfig({ ...clone(base), knowledge: { agent_batch_size: 0 } }), />= 1/);
  });

  test('knowledge.evidence.exclude inherits package.exclude unless set', () => {
    const inherited = cfg.validateConfig({ ...clone(base), package: { name: 'p', exclude: ['**/vendor/**'] } });
    eq(inherited.knowledge.evidence.exclude, ['**/vendor/**']);
    const explicit = cfg.validateConfig({
      ...clone(base), package: { name: 'p', exclude: ['**/vendor/**'] },
      knowledge: { evidence: { include: ['src/**'], exclude: ['**/dist/**'] } },
    });
    eq(explicit.knowledge.evidence.include, ['src/**']);
    eq(explicit.knowledge.evidence.exclude, ['**/dist/**']);
  });

  test('quality gates are plain command strings', () => {
    const c = cfg.validateConfig({ ...clone(base), quality_gates: { lint: 'npm run lint', test: 'npm test' } });
    eq(c.quality_gates, { lint: 'npm run lint', test: 'npm test' });
    throws(() => cfg.validateConfig({ ...clone(base), quality_gates: { lint: { cmd: 'x' } } }), /quality_gates\.lint/);
  });

  test('references are repo-relative text files or directories, grouped by topic', () => {
    const c = cfg.validateConfig({ ...clone(base), references: { conventions: ['docs/guide.md', './docs/rules/'], testing: ['CONTRIBUTING.md'] } });
    eq(c.references, { conventions: ['docs/guide.md', 'docs/rules'], testing: ['CONTRIBUTING.md'] });
    eq(cfg.validateConfig(clone(base)).references, {}, 'absent means none');
    // Office formats are refused up front with the fix in the message: agents read text only.
    throws(() => cfg.validateConfig({ ...clone(base), references: { conventions: ['docs/rules.xlsx'] } }), /not a text file.*export it to Markdown/);
    throws(() => cfg.validateConfig({ ...clone(base), references: { testing: ['docs/plan.docx'] } }), /\.docx/);
    throws(() => cfg.validateConfig({ ...clone(base), references: { conventions: ['../x.md'] } }), /inside the repository/);
    throws(() => cfg.validateConfig({ ...clone(base), references: { 'Bad Topic': ['a.md'] } }), /topic names/);
    throws(() => cfg.validateConfig({ ...clone(base), references: { testing: 'a.md' } }), /references\.testing must be a list/);
  });

  suite('config: policy');

  test('policy always re-adds the protected floor', () => {
    const p = cfg.validatePolicy({ version: 1, protected: ['custom/**'] });
    for (const must of cfg.ALWAYS_PROTECTED) ok(p.protected.includes(must), `missing ${must}`);
    ok(p.protected.includes('custom/**'), 'custom kept');
  });

  test('the protected floor covers every kit control surface', () => {
    for (const must of ['.claude/**', 'CLAUDE.md', '.aidev/policy.yaml',
      '.aidev/sync.lock', '.aidev/materialized.json', '.aidev/.gitignore', '.aidev/ejected.json']) {
      ok(cfg.ALWAYS_PROTECTED.includes(must), `ALWAYS_PROTECTED lacks ${must}`);
    }
    eq(cfg.LOCK_NAME, '.aidev/materialized.json');
    eq(cfg.EJECT_MARKER_NAME, '.aidev/ejected.json');
    eq(cfg.POLICY_REL, '.aidev/policy.yaml');
    eq(cfg.SYNC_LOCK_REL, '.aidev/sync.lock');
  });

  test('a policy that omits the floor cannot unprotect the kit', () => {
    const p = cfg.validatePolicy({ version: 1, protected: [] });
    ok(p.protected.includes('.claude/**'), '.claude still protected');
    ok(p.protected.includes('.aidev/sync.lock'), 'sync lock still protected');
    ok(p.protected.includes('.aidev/materialized.json'), 'materialized record still protected');
    eq(p.writable, [], 'no writable region is invented');
  });

  test('a policy of another version is rejected', () => {
    throws(() => cfg.validatePolicy({ version: 2 }), /unsupported version/);
    throws(() => cfg.validatePolicy({ version: 1, read_only: 'src/**' }), /must be a list/);
  });

  test('a missing policy file falls back closed, not open', () => {
    const fx = makeRepo({ withPolicy: false });
    try {
      const p = cfg.loadPolicy(fx.root);
      ok(p._fallback, 'flagged as the built-in fallback');
      ok(p.protected.includes('.claude/**'), 'protected floor present');
      eq(p.read_only, ['**'], 'the whole PKG is read-only');
      eq(p.writable, ['.aidev/knowledge/**', '.aidev/workflows/**', '.aidev/agents/**', '.aidev/skills/**', '.aidev/conventions/**', 'aidev.yaml']);
      eq(p.writable_during_sync, ['.aidev/knowledge/**']);
      eq(cfg.DEFAULT_POLICY_SCOPES.read_only, ['**']);
      throws(() => cfg.loadPolicy(fx.root, { required: true }), /create policy/);
    } finally { fx.cleanup(); }
  });

  test('the fixture policy and config load with the documented scopes', () => {
    const fx = makeRepo();
    try {
      const p = cfg.loadPolicy(fx.root);
      ok(!p._fallback, 'read from disk');
      eq(p.read_only, ['**']);
      ok(p.writable.includes('.aidev/knowledge/**'));
      ok(p.writable.includes('aidev.yaml'));
      ok(p.protected.includes('config/secrets/**'), 'PKG-specific protection kept');
      const c = cfg.loadConfig(fx.root);
      eq(c.version, 2);
      eq(c.package.include, ['src/**', 'docs/**', 'mod/**']);
      eq(c.secrets_paths, ['config/secrets/**']);
      eq(c.hosting.repository, 'my-pkg');
      eq(cfg.loadConfig(path.join(fx.root, 'src'), { required: false }), null, 'absent config is null when optional');
      throws(() => cfg.loadConfig(path.join(fx.root, 'src')), /aidev init/, 'absent config names the fix');
    } finally { fx.cleanup(); }
  });

  suite('leases: lifecycle');

  test('TTL expiry is computed from acquiredAt', () => {
    const t0 = Date.now();
    const lease = { acquiredAt: new Date(t0).toISOString(), ttlMinutes: 10 };
    ok(leases.evaluateLease(lease, t0 + 5 * 60000).valid, 'still valid');
    ok(!leases.evaluateLease(lease, t0 + 11 * 60000).valid, 'expired');
    eq(leases.evaluateLease(lease, t0 + 11 * 60000).reason, 'expired');
  });

  test('malformed leases are invalid, never permissive', () => {
    ok(!leases.evaluateLease(null).valid);
    ok(!leases.evaluateLease({}).valid);
    ok(!leases.evaluateLease({ acquiredAt: 'nonsense', ttlMinutes: 10 }).valid);
    ok(!leases.evaluateLease({ acquiredAt: new Date().toISOString(), ttlMinutes: 0 }).valid);
  });

  test('a live sync lease is not stealable, and a stale one is not auto-adopted', () => {
    const fx = makeRepo();
    try {
      leases.acquireSyncLease(fx.root, { targetSha: 'a'.repeat(40), originalSha: 'b'.repeat(40), ttlMinutes: 60 });
      ok(fs.existsSync(path.join(fx.root, '.aidev', 'sync.lock')), 'lease lives at .aidev/sync.lock');
      throws(() => leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) }), /already held/);
      // Force expiry and confirm it still refuses without an explicit resume.
      const p = cfg.syncLockPath(fx.root);
      const l = JSON.parse(fs.readFileSync(p, 'utf8'));
      l.acquiredAt = new Date(Date.now() - 999 * 60000).toISOString();
      fs.writeFileSync(p, JSON.stringify(l));
      throws(() => leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) }), /stale sync lease/);
      ok(leases.releaseSyncLease(fx.root), 'released');
      const fresh = leases.acquireSyncLease(fx.root, { targetSha: 'c'.repeat(40) });
      eq(fresh.targetSha, 'c'.repeat(40));
    } finally { fx.cleanup(); }
  });

}

module.exports = { run };

if (require.main === module) {
  const { summary } = require('./harness');
  run();
  process.exit(summary() ? 0 : 1);
}
