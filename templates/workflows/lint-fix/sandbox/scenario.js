'use strict';
/**
 * The sandbox scenario of the lint-fix standard workflow
 * (`npm run sandbox -- lint-fix`; see scripts/sandbox-workflow.js).
 *
 * The package under test is a small Node project with eslint 9 (flat config)
 * and three source files with real findings: src/a.js (no-var, no-unused-vars),
 * src/b.js (eqeqeq, twice), src/c.js (prefer-const). A test file passes before
 * and after the fixes. The scripted agent runs eslint for real in the plan step
 * and writes the notes from its JSON output; the fix step writes the corrected
 * file for each target, src/b.js wrong once on purpose (one finding left) so
 * the until fails, the retry prompt carries the eslint output, and the second
 * attempt fixes it; the review step changes nothing and the reviewer passes.
 *
 * Needs: network for `npm install eslint@9`.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ESLINT_CONFIG = `'use strict';
// eslint 9 flat config: a few rules as errors, so the findings are real.
module.exports = [
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-unused-vars': 'error', eqeqeq: 'error', 'prefer-const': 'error', 'no-var': 'error' },
  },
];
`;

const A_BEFORE = `'use strict';
var total = 0;
const unused = 42;

function add(a, b) {
  total = a + b;
  return total;
}

module.exports = { add };
`;
const A_AFTER = `'use strict';
let total = 0;

function add(a, b) {
  total = a + b;
  return total;
}

module.exports = { add };
`;

const B_BEFORE = `'use strict';

function isZero(n) {
  return n == 0;
}

function isEmpty(s) {
  return s == '';
}

module.exports = { isZero, isEmpty };
`;
// The first attempt fixes one of the two comparisons only.
const B_HALF = B_BEFORE.replace("n == 0", 'n === 0');
const B_AFTER = B_HALF.replace("s == ''", "s === ''");

const C_BEFORE = `'use strict';

function greet(name) {
  let greeting = 'Hello, ' + name;
  return greeting;
}

module.exports = { greet };
`;
const C_AFTER = C_BEFORE.replace('let greeting', 'const greeting');

const TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { add } = require('../src/a');
const { isZero, isEmpty } = require('../src/b');
const { greet } = require('../src/c');

test('add', () => { assert.strictEqual(add(2, 3), 5); });
test('isZero', () => { assert.strictEqual(isZero(0), true); assert.strictEqual(isZero(1), false); });
test('isEmpty', () => { assert.strictEqual(isEmpty(''), true); assert.strictEqual(isEmpty('x'), false); });
test('greet', () => { assert.strictEqual(greet('Ann'), 'Hello, Ann'); });
`;

/** What the fixer writes for each target (relative to src/), per attempt. */
const FIXED = {
  'a.js': () => A_AFTER,
  'b.js': (attempt) => (attempt === 1 ? B_HALF : B_AFTER),
  'c.js': () => C_AFTER,
};

/** What eslint reports for the files above: the fallback of the offline check (test/sandbox.test.js runs the scripted agent without node_modules). */
const KNOWN_FINDINGS = {
  'src/a.js': [{ line: 2, column: 1, ruleId: 'no-var', message: 'Unexpected var, use let or const instead.' }, { line: 3, column: 7, ruleId: 'no-unused-vars', message: "'unused' is assigned a value but never used." }],
  'src/b.js': [{ line: 4, column: 12, ruleId: 'eqeqeq', message: "Expected '===' and instead saw '=='." }, { line: 8, column: 12, ruleId: 'eqeqeq', message: "Expected '===' and instead saw '=='." }],
  'src/c.js': [{ line: 4, column: 7, ruleId: 'prefer-const', message: "'greeting' is never reassigned. Use 'const' instead." }],
};

/**
 * Run the package's eslint in the worktree and return its JSON (exit 1 means
 * findings, not failure). Without eslint installed (the offline check), the
 * known findings stand in, so the notes have the same shape.
 */
function runEslint(worktree, scope) {
  const bin = path.join(worktree, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(bin)) return Object.entries(KNOWN_FINDINGS).map(([rel, messages]) => ({ filePath: path.join(worktree, ...rel.split('/')), messages }));
  const r = spawnSync(process.execPath, [bin, scope, '-f', 'json'], { cwd: worktree, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`eslint did not run (exit ${r.status}): ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

module.exports = {
  description: 'a Node project with eslint 9, three files with real findings, one fixed wrong on its first attempt',
  workflowName: 'lint-fix',
  files: {
    'package.json': `${JSON.stringify({ name: 'sandbox-lint', private: true, version: '0.0.0', scripts: { test: 'node --test', lint: 'eslint .' } }, null, 2)}\n`,
    'eslint.config.js': ESLINT_CONFIG,
    'src/a.js': A_BEFORE,
    'src/b.js': B_BEFORE,
    'src/c.js': C_BEFORE,
    'test/all.test.js': TEST,
    '.gitignore': 'node_modules/\n',
    'README.md': '# sandbox-lint\n\nThe project the lint-fix sandbox runs against.\n',
  },
  // The linter, so `npm ci` has it and a lockfile.
  prepare() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return [{ command: npm, args: ['install', '--save-dev', '--no-audit', '--no-fund', '--loglevel=error', 'eslint@9'] }];
  },
  spec: null,
  inputs: {},
  env: {},

  /** The scripted agent: what a competent agent would leave after each step. */
  agent(ctx) {
    if (ctx.step === 'plan') {
      const results = runEslint(ctx.worktree, ctx.inputs.scope || '.');
      const withFindings = results
        .filter((r) => r.messages.length > 0)
        .map((r) => ({ rel: path.relative(ctx.worktree, r.filePath).split(path.sep).join('/'), messages: r.messages }))
        .sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
      const targets = withFindings.filter((f) => f.rel.startsWith('src/')).map((f) => f.rel.slice('src/'.length));
      const outside = withFindings.filter((f) => !f.rel.startsWith('src/')).map((f) => f.rel);
      const findings = withFindings.map((f) => `## ${f.rel}\n\n${f.messages.map((m) => `- ${m.line}:${m.column} ${m.ruleId} ${m.message}`).join('\n')}\n`).join('\n');
      const notes = {
        'findings.md': `# Findings\n\n${findings || '(none)\n'}`,
        'plan.md': `# Plan\n\n- config: eslint.config.js (flat), rules no-unused-vars / eqeqeq / prefer-const / no-var as errors, ignores node_modules\n- fixes: remove unused declarations, === with the types checked, const where never reassigned, let/const for var\n- outside src/: ${outside.length ? outside.join(', ') : 'none'}\n`,
      };
      if (targets.length) notes['targets.txt'] = `${targets.join('\n')}\n`;
      const count = withFindings.reduce((n, f) => n + f.messages.length, 0);
      return { notes, report: `${count} finding(s) in ${withFindings.length} file(s); ${targets.length} target(s) under src/: ${targets.join(', ') || 'none'}` };
    }
    if (ctx.step === 'fix') {
      const make = FIXED[ctx.item];
      if (!make) throw new Error(`no fix scripted for ${ctx.item}`);
      return { files: { [`src/${ctx.item}`]: make(ctx.attempt) }, report: `src/${ctx.item}: findings fixed${ctx.attempt > 1 ? ` (attempt ${ctx.attempt}: fixed the comparison the previous attempt left)` : ''}` };
    }
    if (ctx.step === 'review') {
      if (ctx.role === 'until') return { report: 'The diff removes an unused constant, turns var into let, == into === with the types checked, and let into const. No behaviour change, no eslint-disable, no config change.', verdict: 'PASS' };
      return { report: 'eslint . and npm test pass; nothing left outside src/. No file left out.' };
    }
    return { report: `nothing to do for step ${ctx.step}` };
  },

  /** What this scenario expects beyond the common checks. */
  expect({ record, worktree, git, calls, log }) {
    const step = (id) => record.steps.find((s) => s.id === id);
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const fix = step('fix');
    assert(fix && fix.items && fix.items.map((x) => x.item).join(',') === 'a.js,b.js,c.js', `fix ran the targets ${JSON.stringify(fix && fix.items)}`);
    const b = fix.items.find((x) => x.item === 'b.js');
    assert(b.attempts === 2, `b.js should pass on its second attempt (one comparison is left on the first), got ${b.attempts}`);
    assert(fix.items.filter((x) => x.item !== 'b.js').every((x) => x.attempts === 1), 'the other files pass first time');
    const retried = calls.find((c) => c.step === 'fix' && c.item === 'b.js' && c.attempt === 2);
    assert(retried && /## Previous attempt 1 of 4 failed/.test(retried.prompt) && /eqeqeq/.test(retried.prompt), 'the second attempt was told what failed (the eslint output names the rule)');
    const review = step('review');
    assert(review && /VERDICT: PASS/.test(review.review || ''), 'the reviewer passed the work');
    const untilRuns = log.split('\n').filter((l) => /step review: "(npx eslint \.|npm test)" exited/.test(l));
    assert(untilRuns.length === 2 && untilRuns.every((l) => / exited 0 /.test(l)), `the review until ran eslint and the tests, both passing: ${JSON.stringify(untilRuns)}`);
    const fixRuns = log.split('\n').filter((l) => /step fix: "npx eslint src\/b\.js" exited/.test(l));
    assert(fixRuns.length === 2 && / exited 1 /.test(fixRuns[0]) && / exited 0 /.test(fixRuns[1]), `b.js: eslint failed once, then passed: ${JSON.stringify(fixRuns)}`);
    const committed = git(['ls-files', 'src', 'test']).split('\n');
    for (const f of ['src/a.js', 'src/b.js', 'src/c.js', 'test/all.test.js']) assert(committed.includes(f), `${f} is committed on the trial branch`);
    assert(!git(['status', '--porcelain', '--', 'src']), 'nothing is left uncommitted under src/');
    for (const f of ['src/a.js', 'src/b.js', 'src/c.js']) {
      const text = fs.readFileSync(path.join(worktree, f), 'utf8');
      assert(!/eslint-disable/.test(text), `${f} must not silence findings`);
    }
    assert(fs.readFileSync(path.join(worktree, 'src', 'b.js'), 'utf8') === B_AFTER, 'b.js ends up fully fixed');
    assert(fs.readFileSync(path.join(worktree, 'src', 'a.js'), 'utf8') === A_AFTER && !/unused/.test(fs.readFileSync(path.join(worktree, 'src', 'a.js'), 'utf8')), 'a.js drops the unused constant and the var');
    assert(fs.readFileSync(path.join(worktree, 'eslint.config.js'), 'utf8') === ESLINT_CONFIG, 'the config is untouched');
  },
};
