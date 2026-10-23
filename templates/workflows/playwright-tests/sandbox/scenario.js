'use strict';
/**
 * The sandbox scenario of the playwright-tests standard workflow
 * (`npm run sandbox -- playwright-tests`; see scripts/sandbox-workflow.js).
 *
 * The package under test is a small web application (app/server.js: a sign-in
 * form, a home page, a list of items you can add to, a log-out link) with
 * Playwright installed and configured. The specification lists five cases on
 * three screens. The scripted agent writes, for every step, what a competent
 * agent would: the batches and notes (plan), the support helpers and a smoke
 * test (scaffold), one spec per case (generate), nothing to fix (review),
 * PASS (the reviewer). One case is written wrong on purpose on its first
 * attempt, so the run exercises a failing `until`, the retry with the failure
 * in the prompt, and the fix on the second attempt.
 *
 * Needs: network for `npm install @playwright/test` (the version the machine
 * already has browsers for, else the latest), and a Chromium that Playwright
 * can start (`npx playwright install chromium` when the run says so).
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const USER = 'qa';
const PASSWORD = 'sandbox-pw-7f3a';

const SERVER = `'use strict';
// The application under test: in memory, no dependencies. node app/server.js [port]
const http = require('http');
const USER = process.env.APP_USER || 'qa';
const PASSWORD = process.env.APP_PASSWORD || 'sandbox-pw-7f3a';
const items = ['Apple', 'Banana'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const page = (title, body) => \`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>\${title}</title></head><body><main>\${body}</main></body></html>\`;
const nav = '<nav><a href="/home">Home</a> <a href="/items">Items</a> <a href="/logout">Log out</a></nav>';
const signIn = (error) => page('Sign in', \`<h1>Sign in</h1>\${error ? '<p role="alert">Invalid credentials</p>' : ''}<form method="post" action="/login"><label>Username <input name="username"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>\`);
const itemList = () => page('Items', \`\${nav}<h1>Items</h1><ul>\${items.map((i) => \`<li>\${esc(i)}</li>\`).join('')}</ul><a href="/items/new">Add item</a>\`);
const loggedIn = (req) => /(^|;\\s*)session=ok(;|$)/.test(req.headers.cookie || '');
const form = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b)))); });
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') return send(res, 200, signIn(false));
  if (req.method === 'POST' && url.pathname === '/login') {
    const f = await form(req);
    if (f.username === USER && f.password === PASSWORD) return send(res, 302, '', { location: '/home', 'set-cookie': 'session=ok; Path=/' });
    return send(res, 200, signIn(true));
  }
  if (url.pathname === '/logout') return send(res, 302, '', { location: '/', 'set-cookie': 'session=; Path=/; Max-Age=0' });
  if (!loggedIn(req)) return send(res, 302, '', { location: '/' });
  if (req.method === 'GET' && url.pathname === '/home') return send(res, 200, page('Home', \`\${nav}<h1>Welcome, \${esc(USER)}</h1><p>You are signed in.</p>\`));
  if (req.method === 'GET' && url.pathname === '/items') return send(res, 200, itemList());
  if (req.method === 'GET' && url.pathname === '/items/new') return send(res, 200, page('Add item', \`\${nav}<h1>Add item</h1><form method="post" action="/items"><label>Name <input name="name"></label><button type="submit">Add</button></form>\`));
  if (req.method === 'POST' && url.pathname === '/items') { const f = await form(req); if (f.name) items.push(f.name); return send(res, 302, '', { location: '/items' }); }
  send(res, 404, page('Not found', '<h1>Not found</h1>'));
});
server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => { process.stdout.write(\`listening on \${server.address().port}\\n\`); });
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
`;

const SPEC = [
  'id,screen,title,precondition,steps,expected',
  'TC-001,login,正しいユーザーでログインできる,ログアウト済み,1. / を開く 2. ユーザー名とパスワードを入力 3. Sign in を押す,Welcome の見出しが表示され URL が /home になる',
  'TC-002,login,誤ったパスワードではログインできない,ログアウト済み,1. / を開く 2. ユーザー名と誤ったパスワードを入力 3. Sign in を押す,Invalid credentials の警告が表示される',
  'TC-003,items,一覧に初期の商品が表示される,ログイン済み,1. Items を開く,Apple と Banana が一覧にある',
  'TC-004,items,商品を追加すると一覧に出る,ログイン済み,1. Items を開く 2. Add item を押す 3. 名前を入力して Add を押す,追加した名前が一覧にある',
  'TC-005,session,ログアウトするとサインイン画面に戻る,ログイン済み,1. Log out を押す,Sign in のボタンが表示される',
  '',
].join('\n');

const ENV_TS = `// Settings of the environment under test, from the environment: the values are never written down.
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(\`\${name} is not set\`);
  return value;
};

export const env = {
  baseUrl: need('E2E_BASE_URL'),
  user: need('E2E_USER'),
  password: need('E2E_PASSWORD'),
};

export const url = (p: string): string => new URL(p, env.baseUrl).toString();
`;

const LOGIN_TS = `import { expect, type Page } from '@playwright/test';
import { env, url } from './env';

/** Sign in as the test user and wait for the home page. */
export async function login(page: Page): Promise<void> {
  await page.goto(url('/'));
  await page.getByLabel('Username').fill(env.user);
  await page.getByLabel('Password').fill(env.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: \`Welcome, \${env.user}\` })).toBeVisible();
}
`;

/** The reference implementation the skill carries: the sandbox runs exactly what the agents are told to write. */
function referenceEvidence() {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'playwright-testing', 'SKILL.md'), 'utf8');
  const m = /```ts\n(\/\/ tests\/e2e\/support\/evidence\.ts[^\n]*\n[\s\S]*?)```/.exec(skill);
  if (!m) throw new Error('the playwright-testing skill has no reference implementation of tests/e2e/support/evidence.ts (a ```ts block starting with "// tests/e2e/support/evidence.ts")');
  return m[1];
}
const EVIDENCE_TS = referenceEvidence();

const SMOKE_TS = `import { expect, test } from '../support/evidence';
import { login } from '../support/login';
import { url } from '../support/env';

test('smoke: the environment answers and the test user can sign in', async ({ page, evidence }) => {
  await page.goto(url('/'));
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await evidence.capture('sign-in-page');
  await login(page);
  await expect(page).toHaveURL(/\\/home$/);
  await evidence.capture('after-login');
});
`;

const header = (c) => `// ${c.id}: ${c.title}\n// 前提: ${c.precondition}\n// 手順: ${c.steps}\n// 期待結果: ${c.expected}\n`;

/** One spec per case; `attempt` lets a case be wrong once (TC-004) so the retry path runs. */
const CASES = {
  'TC-001': () => `import { expect, test } from '../../support/evidence';
import { login } from '../../support/login';

test.describe('TC-001', () => {
  test('正しいユーザーでログインできる', async ({ page, evidence }) => {
    await test.step('ログインする', async () => { await login(page); await evidence.capture('ログイン後'); });
    await test.step('ホームにいる', async () => { await expect(page).toHaveURL(/\\/home$/); await evidence.capture('home'); });
  });
});
`,
  'TC-002': () => `import { expect, test } from '../../support/evidence';
import { env, url } from '../../support/env';

test.describe('TC-002', () => {
  test('誤ったパスワードではログインできない', async ({ page, evidence }) => {
    await test.step('誤ったパスワードで送信する', async () => {
      await page.goto(url('/'));
      await page.getByLabel('Username').fill(env.user);
      await page.getByLabel('Password').fill('not-the-password');
      await evidence.capture('filled-in');
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
    await test.step('警告が出る', async () => { await expect(page.getByRole('alert')).toHaveText('Invalid credentials'); await evidence.capture('warning'); });
  });
});
`,
  'TC-003': () => `import { expect, test } from '../../support/evidence';
import { login } from '../../support/login';

test.describe('TC-003', () => {
  test('一覧に初期の商品が表示される', async ({ page, evidence }) => {
    await login(page);
    await test.step('Items を開く', async () => { await page.getByRole('link', { name: 'Items' }).click(); await evidence.capture('items'); });
    await test.step('初期の商品がある', async () => {
      await expect(page.getByRole('listitem').filter({ hasText: 'Apple' })).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: 'Banana' })).toBeVisible();
      await evidence.capture('initial-items');
    });
  });
});
`,
  'TC-004': (attempt) => `import { expect, test } from '../../support/evidence';
import { login } from '../../support/login';

test.describe('TC-004', () => {
  test('商品を追加すると一覧に出る', async ({ page, evidence }) => {
    const name = \`Cherry-\${Date.now()}\`;
    await login(page);
    await test.step('Items から Add item を開く', async () => {
      await page.getByRole('link', { name: 'Items' }).click();
      await page.getByRole('link', { name: 'Add item' }).click();
      await evidence.capture('add-item-form');
    });
    await test.step('名前を入れて Add を押す', async () => {
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Add' }).click();
      await evidence.capture('after-add');
    });
    await test.step('一覧にある', async () => {
      ${attempt === 1
    ? "await expect(page.getByRole('listitem').filter({ hasText: 'Durian' })).toBeVisible(); // wrong on purpose: the first attempt fails"
    : "await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();"}
      await evidence.capture('items-with-new-one');
    });
  });
});
`,
  'TC-005': () => `import { expect, test } from '../../support/evidence';
import { login } from '../../support/login';

test.describe('TC-005', () => {
  test('ログアウトするとサインイン画面に戻る', async ({ page, evidence }) => {
    await login(page);
    await test.step('Log out を押す', async () => { await page.getByRole('link', { name: 'Log out' }).click(); await evidence.capture('after-logout'); });
    await test.step('サインイン画面', async () => { await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible(); await evidence.capture('sign-in-page'); });
  });
});
`,
};

function parseCsv(text) {
  const [head, ...rows] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(',');
  return rows.map((r) => Object.fromEntries(r.split(',').map((v, i) => [cols[i], v])));
}

function detectPlaywrightVersion() {
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--no-install', 'playwright', '--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(`${r.stdout || ''}\n${r.stderr || ''}`);
  return r.status === 0 && m ? m[1] : null;
}

module.exports = {
  description: 'a sign-in / items application, five cases on three screens, one case wrong on its first attempt',
  workflowName: 'e2e-tests',
  files: {
    'package.json': `${JSON.stringify({ name: 'sandbox-app', private: true, version: '0.0.0', scripts: { start: 'node app/server.js' } }, null, 2)}\n`,
    'playwright.config.ts': PLAYWRIGHT_CONFIG,
    'app/server.js': SERVER,
    '.gitignore': 'node_modules/\ntest-results/\nplaywright-report/\n',
    'README.md': '# sandbox-app\n\nThe application the playwright-tests sandbox runs against.\n',
  },
  // The test runner, at the version this machine has browsers for; the browsers themselves when it has none.
  prepare() {
    const version = detectPlaywrightVersion();
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return [
      { command: npm, args: ['install', '--save-dev', '--no-audit', '--no-fund', '--loglevel=error', `@playwright/test@${version || 'latest'}`] },
      { command: process.execPath, args: ['node_modules/@playwright/test/cli.js', 'install', 'chromium'] },
    ];
  },
  spec: SPEC,
  fileInput: 'spec',
  // base_url is a placeholder here (the offline check of test/sandbox.test.js uses it); start() replaces it with the application's address.
  inputs: { base_url: 'http://127.0.0.1:0', test_user: USER, batch_size: '2' },
  env: { E2E_PASSWORD: PASSWORD },

  /** Start the application on a free port; base_url points at it. */
  start({ pkgRoot }) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(pkgRoot, 'app', 'server.js'), '0'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, APP_USER: USER, APP_PASSWORD: PASSWORD } });
      let out = '';
      child.stdout.on('data', (c) => {
        out += c;
        const m = /listening on (\d+)/.exec(out);
        if (m) resolve({ inputs: { base_url: `http://127.0.0.1:${m[1]}` }, stop: () => new Promise((done) => { child.once('exit', () => done()); child.kill(); }) });
      });
      child.once('exit', (code) => reject(new Error(`the application exited with ${code} before it listened`)));
    });
  },

  /** The scripted agent: what a competent agent would leave after each step. */
  agent(ctx) {
    if (ctx.step === 'plan') {
      const cases = parseCsv(fs.readFileSync(path.join(ctx.worktree, ctx.inputs.spec), 'utf8'));
      const size = Math.max(1, Number(ctx.inputs.batch_size) || 10);
      const byScreen = new Map();
      for (const c of cases) { if (!byScreen.has(c.screen)) byScreen.set(c.screen, []); byScreen.get(c.screen).push(c); }
      const batches = [];
      for (const [screen, list] of byScreen) {
        for (let i = 0; i < list.length; i += size) batches.push({ name: `${screen}-${String(Math.floor(i / size) + 1).padStart(2, '0')}`, cases: list.slice(i, i + size) });
      }
      const notes = { 'batches.txt': `${batches.map((b) => b.name).join('\n')}\n`, 'plan.md': '# Plan\n\n- app/server.js: sign-in at /, home at /home, items at /items (+ /items/new), log-out at /logout\n- locators: labels (Username, Password, Name), roles (button Sign in / Add, link Items / Add item / Log out, heading Welcome)\n- Playwright: testDir ./tests, one chromium project, no webServer (the target is E2E_BASE_URL)\n' };
      for (const b of batches) notes[`batches/${b.name}.md`] = `# ${b.name}\n\n${b.cases.map((c) => `## ${c.id}: ${c.title}\n\n- 前提: ${c.precondition}\n- 手順: ${c.steps}\n- 期待結果: ${c.expected}\n`).join('\n')}`;
      return { notes, report: `${cases.length} cases in ${batches.length} batches: ${batches.map((b) => `${b.name} (${b.cases.map((c) => c.id).join(', ')})`).join('; ')}` };
    }
    if (ctx.step === 'scaffold') {
      return { files: { 'tests/e2e/support/env.ts': ENV_TS, 'tests/e2e/support/login.ts': LOGIN_TS, 'tests/e2e/support/evidence.ts': EVIDENCE_TS, 'tests/e2e/smoke/login.spec.ts': SMOKE_TS }, report: 'support/env.ts, support/login.ts, support/evidence.ts and smoke/login.spec.ts written; the smoke test signs in as the test user' };
    }
    if (ctx.step === 'generate') {
      const md = fs.readFileSync(path.join(ctx.notesDir, 'batches', `${ctx.item}.md`), 'utf8');
      const cases = parseCsv(fs.readFileSync(path.join(ctx.worktree, ctx.inputs.spec), 'utf8'));
      const ids = [...md.matchAll(/^## (TC-\d+)/gm)].map((m) => m[1]);
      const files = {};
      for (const id of ids) {
        const c = cases.find((x) => x.id === id);
        files[`tests/e2e/cases/${ctx.item}/${id.toLowerCase()}.spec.ts`] = header(c) + CASES[id](ctx.attempt);
      }
      return { files, report: `batch ${ctx.item}: ${ids.join(', ')} written${ctx.attempt > 1 ? ` (attempt ${ctx.attempt}: fixed the failing expectation the previous attempt reported)` : ''}` };
    }
    if (ctx.step === 'review') {
      if (ctx.role === 'until') return { report: 'Every case of the specification has its spec file; the steps and expectations match; no skip, only, waitForTimeout or credential value.', verdict: 'PASS' };
      return { report: 'The whole suite passes; nothing to consolidate. No case was left out.' };
    }
    return { report: `nothing to do for step ${ctx.step}` };
  },

  /** What this scenario expects beyond the common checks. */
  expect({ record, worktree, git, calls }) {
    const step = (id) => record.steps.find((s) => s.id === id);
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const gen = step('generate');
    assert(gen && gen.items && gen.items.map((x) => x.item).join(',') === 'login-01,items-01,session-01', `generate ran the batches ${JSON.stringify(gen && gen.items)}`);
    const items01 = gen.items.find((x) => x.item === 'items-01');
    assert(items01.attempts === 2, `items-01 should pass on its second attempt (TC-004 is wrong on the first), got ${items01.attempts}`);
    assert(gen.items.filter((x) => x.item !== 'items-01').every((x) => x.attempts === 1), 'the other batches pass first time');
    const retried = calls.find((c) => c.step === 'generate' && c.item === 'items-01' && c.attempt === 2);
    assert(retried && /## Previous attempt 1 of 4 failed/.test(retried.prompt) && /Durian/.test(retried.prompt), 'the second attempt was told what failed (the Playwright output names the wrong expectation)');
    const review = step('review');
    assert(review && /VERDICT: PASS/.test(review.review || ''), 'the reviewer passed the work');
    const committed = git(['ls-files', 'tests']).split('\n');
    for (const f of ['tests/e2e/support/env.ts', 'tests/e2e/support/login.ts', 'tests/e2e/support/evidence.ts', 'tests/e2e/smoke/login.spec.ts', 'tests/e2e/cases/login-01/tc-001.spec.ts', 'tests/e2e/cases/login-01/tc-002.spec.ts', 'tests/e2e/cases/items-01/tc-003.spec.ts', 'tests/e2e/cases/items-01/tc-004.spec.ts', 'tests/e2e/cases/session-01/tc-005.spec.ts']) {
      assert(committed.includes(f), `${f} is committed on the trial branch`);
    }
    assert(!git(['ls-files', 'test-results', 'node_modules']), 'Playwright output and node_modules are never committed');
    assert(!git(['status', '--porcelain', '--', 'tests']), 'nothing is left uncommitted under tests/');
    assert(fs.existsSync(path.join(worktree, 'test-results', 'items-01')), 'the until ran Playwright with the per-batch output directory');
    // The evidence of the final run: one directory per case, the captures in order, the final one last.
    for (const id of ['login', 'tc-001', 'tc-002', 'tc-003', 'tc-004', 'tc-005']) {
      const dir = path.join(worktree, 'test-results', 'evidence', id);
      const pngs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
      assert(pngs.length >= 3 && pngs[0].startsWith('01-') && /-final\.png$/.test(pngs[pngs.length - 1]), `${id}: the evidence captures of the final run (${JSON.stringify(pngs)})`);
    }
  },
};
