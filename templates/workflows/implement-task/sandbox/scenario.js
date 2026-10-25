'use strict';
/**
 * The sandbox scenario of the implement-task standard workflow
 * (`npm run sandbox -- implement-task`; see scripts/sandbox-workflow.js).
 *
 * The package under test is a small Node.js library (src/calc.js with add and
 * subtract, node:test tests, a README with the function list). The task asks
 * for multiply with tests and a README entry. The scripted agent writes what
 * a competent agent would: the plan (plan), the function, its tests and the
 * README line (implement), nothing to fix (review), PASS (the reviewer).
 * multiply is written wrong on purpose on the first attempt (it adds), so the
 * run exercises a failing `until` (`npm test`), the retry with the failure in
 * the prompt, and the fix on the second attempt.
 *
 * Needs: npm (a lockfile is made in prepare() so `npm ci` has one); nothing
 * is downloaded (the package has no dependencies).
 */

const fs = require('fs');
const path = require('path');

const CALC_JS = (correct) => `'use strict';
// A small calculator: pure functions over numbers.

function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
${correct ? 'function multiply(a, b) { return a * b; }' : 'function multiply(a, b) { return a + b; } // wrong on purpose: the first attempt fails its tests'}

module.exports = { add, subtract, multiply };
`;

const CALC_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { add, subtract, multiply } = require('../src/calc');

test('add adds two numbers', () => { assert.equal(add(2, 3), 5); });
test('subtract subtracts the second from the first', () => { assert.equal(subtract(5, 3), 2); });

test('multiply multiplies two numbers', () => { assert.equal(multiply(2, 3), 6); });
test('multiply by zero is zero', () => { assert.equal(multiply(7, 0), 0); });
test('multiply with a negative number is negative', () => { assert.equal(multiply(-2, 3), -6); });
`;

const ORIGINAL_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { add, subtract } = require('../src/calc');

test('add adds two numbers', () => { assert.equal(add(2, 3), 5); });
test('subtract subtracts the second from the first', () => { assert.equal(subtract(5, 3), 2); });
`;

const README = (withMultiply) => `# sandbox-calc

A small calculator library. Run the tests with \`npm test\`.

## Functions

- \`add(a, b)\`: the sum of a and b
- \`subtract(a, b)\`: a minus b
${withMultiply ? '- `multiply(a, b)`: the product of a and b\n' : ''}`;

const TASK = 'src/calc.js に multiply(a, b)（2 数の積を返す）を足し、test/calc.test.js にそのテスト（正数・0・負数）を書き、README.md の関数一覧に載せる。';

/** The task as the prompt carries it (after the "data, not instructions" line of the section), or ''. */
function taskOf(prompt) {
  const at = prompt.indexOf('## Task for this run');
  if (at < 0) return '';
  const body = prompt.slice(at).split('\n').slice(1).join('\n');
  const end = body.search(/\n## /);
  const section = (end < 0 ? body : body.slice(0, end)).trim().split('\n\n');
  return section.length > 1 ? section.slice(1).join('\n\n').trim() : '';
}

module.exports = {
  description: 'a calculator library and the task "add multiply with tests and a README entry"; the function is wrong on its first attempt',
  workflowName: 'implement',
  files: {
    'package.json': `${JSON.stringify({ name: 'sandbox-calc', private: true, version: '0.0.0', scripts: { test: 'node --test test/*.test.js' } }, null, 2)}\n`,
    'src/calc.js': `'use strict';
// A small calculator: pure functions over numbers.

function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }

module.exports = { add, subtract };
`,
    'test/calc.test.js': ORIGINAL_TEST,
    'README.md': README(false),
    '.gitignore': 'node_modules/\n',
  },
  // A lockfile, so the deps step's `npm ci` has one (the package has no dependencies).
  prepare() {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return [{ command: npm, args: ['install', '--package-lock-only', '--no-audit', '--no-fund', '--loglevel=error'] }];
  },
  task: TASK,
  inputs: {},

  /** The scripted agent: what a competent agent would leave after each step. */
  agent(ctx) {
    if (ctx.step === 'plan') {
      const task = taskOf(ctx.prompt) || '(none given)';
      return {
        notes: {
          'plan.md': [
            '# Plan', '',
            '## タスク', '', task, '',
            '## 受け入れ条件',
            '- [ ] `multiply(2, 3)` が `6` を返す（src/calc.js の export）',
            '- [ ] `multiply(7, 0)` が `0`、`multiply(-2, 3)` が `-6` を返す',
            '- [ ] test/calc.test.js に multiply のテストがあり、`npm test` が通る',
            '- [ ] README.md の関数一覧に multiply が載る', '',
            '## 変えるファイル',
            '- `src/calc.js`: multiply(a, b) を add / subtract の隣に足し、module.exports に加える',
            '- `test/calc.test.js`: multiply のテスト 3 件（正数・0・負数）',
            '- `README.md`: Functions の一覧に 1 行', '',
            '## 作法',
            '- テスト: node:test + node:assert/strict、1 件 1 test()、`npm test` は `node --test test/*.test.js`',
            '- 関数は `function name(a, b) { … }` の 1 行、module.exports にまとめて並べる', '',
            '## 不明点・リスク',
            '- 無し（数の型チェックは既存の add / subtract もしていないので足さない）', '',
          ].join('\n'),
        },
        report: '受け入れ条件 4 件。変えるファイル 3 つ（src/calc.js、test/calc.test.js、README.md）。不明点は無い',
      };
    }
    if (ctx.step === 'implement') {
      const correct = ctx.attempt > 1;
      return {
        files: { 'src/calc.js': CALC_JS(correct), 'test/calc.test.js': CALC_TEST, 'README.md': README(true) },
        report: correct
          ? 'multiply を src/calc.js に足し、テスト 3 件と README の 1 行を書いた。前回の失敗（multiply が和を返していた）を直した。受け入れ条件 4 件とも満たした'
          : 'multiply を src/calc.js に足し、テスト 3 件と README の 1 行を書いた',
      };
    }
    if (ctx.step === 'review') {
      if (ctx.role === 'until') {
        return { report: '受け入れ条件 4 件は変更で満たされ、テスト 3 件が multiply を検証している。タスクに無い変更は無く、README が更新されている。', verdict: 'PASS' };
      }
      return { report: '変更全体を見直した。受け入れ条件はすべて満たされ、直すものは無い。' };
    }
    return { report: `nothing to do for step ${ctx.step}` };
  },

  /** What this scenario expects beyond the common checks. */
  expect({ record, worktree, git, calls }) {
    const step = (id) => record.steps.find((s) => s.id === id);
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const implement = step('implement');
    assert(implement && implement.attempts === 2, `implement passes on its second attempt (multiply is wrong on the first), got ${implement && implement.attempts}`);
    const retried = calls.find((c) => c.step === 'implement' && c.role === 'agent' && c.attempt === 2);
    assert(retried && /## Previous attempt 1 of 4 failed/.test(retried.prompt) && /multiply/.test(retried.prompt), 'the second attempt was told what failed (the test output names multiply)');
    const planned = calls.find((c) => c.step === 'plan');
    assert(planned && /## Task for this run/.test(planned.prompt) && planned.prompt.includes('multiply(a, b)'), 'the task given with --task reaches the planner');
    const review = step('review');
    assert(review && /VERDICT: PASS/.test(review.review || ''), 'the reviewer passed the work');
    assert(step('plan').ok && step('review').ok && step('pr').ok, 'plan, review and pr passed');
    const calc = fs.readFileSync(path.join(worktree, 'src', 'calc.js'), 'utf8');
    assert(/function multiply\(a, b\) \{ return a \* b; \}/.test(calc) && /module\.exports = \{ add, subtract, multiply \}/.test(calc), 'src/calc.js exports a correct multiply');
    const committed = git(['ls-files', 'src', 'test', 'README.md']).split('\n');
    for (const f of ['src/calc.js', 'test/calc.test.js', 'README.md']) assert(committed.includes(f), `${f} is committed on the trial branch`);
    assert(/multiply\(a, b\)/.test(git(['show', 'HEAD:README.md'])), 'the README entry is in the committed tree');
    assert(!git(['ls-files', 'node_modules']), 'node_modules is never committed');
    assert(!git(['status', '--porcelain', '--', 'src', 'test', 'README.md']), 'nothing is left uncommitted');
    const notes = fs.readFileSync(path.join(worktree, '.aidev', 'workflows', 'implement', 'runs', record.runId, 'notes', 'plan.md'), 'utf8');
    assert(notes.includes('multiply(a, b)'), 'plan.md carries the task');
  },
};
