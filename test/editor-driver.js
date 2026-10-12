'use strict';
/**
 * The editor server's checks, run in a process of their own because the
 * harness is synchronous: `node editor-driver.js <pkg root> <kit root>`
 * prints { results: [[name, error|null]] } as the last line.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const editor = require('../cli/lib/editor');
const yaml = require('../cli/lib/yaml');

const [root, KIT] = require.main === module ? process.argv.slice(2) : [];
const file = root ? path.join(root, '.aidev', 'workflows', 'demo', 'workflow.yaml') : null;
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'mismatch'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }

function request(port, { method = 'GET', pathName = '/', token = null, body = undefined, host = null, origin = null, type = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathName,
      headers: {
        Host: host || `127.0.0.1:${port}`,
        ...(token ? { 'x-aidev-token': token } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(data ? { 'content-type': type, 'content-length': data.length } : {}),
      },
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const WF = [
  'name: demo', 'description: a demo', '# reviewed', 'objective: |', '  Do the thing.', 'steps:',
  '  - id: work', '    agent: coder', '    writable: [src/**]', '    prompt: do it',
  '    until:', '      command: node --version', '  - id: pr', '    pull_request: {}',
  'limits:', '  max_usd: 3', '',
].join('\n');

const tests = [];
const atest = (name, fn) => tests.push([name, fn]);

atest('the page is served with a strict policy; the API wants the token, the loopback host and origin', async (ed) => {
  const page = await request(ed.port);
  eq(page.status, 200);
  ok(/aidev workflow editor/.test(page.text));
  ok(/default-src 'none'/.test(page.headers['content-security-policy']) && /frame-ancestors 'none'/.test(page.headers['content-security-policy']), page.headers['content-security-policy']);
  ok(/^http:\/\/127\.0\.0\.1:\d+\/#t=[0-9a-f]{48}$/.test(ed.url), ed.url);
  eq((await request(ed.port, { pathName: '/api/state' })).status, 403, 'no token');
  eq((await request(ed.port, { pathName: '/api/state', token: 'x'.repeat(48) })).status, 403, 'wrong token');
  eq((await request(ed.port, { pathName: '/api/state', token: ed.token, host: `evil.example:${ed.port}` })).status, 421, 'a rebound host name');
  eq((await request(ed.port, { pathName: '/api/state', token: ed.token, origin: 'http://evil.example' })).status, 403, 'another site');
  eq((await request(ed.port, { method: 'POST', pathName: '/api/check', token: ed.token, body: {}, type: 'text/plain' })).status, 415, 'only JSON');
});

atest('state: the text, its approval, the agents and the check', async (ed) => {
  const r = await request(ed.port, { pathName: '/api/state', token: ed.token });
  eq(r.status, 200, r.text);
  const s = r.json;
  eq([s.name, s.rel, s.text, s.origin, s.approval.approved, s.comments], ['demo', '.aidev/workflows/demo/workflow.yaml', WF, WF, true, true]);
  const coder = s.agents.find((a) => a.name === 'coder');
  eq([coder.source, coder.tools], ['pkg', ['Read', 'Edit']]);
  eq([s.check.ok, s.check.summary.steps.map((x) => [x.id, x.kind, x.maxRetries])], [true, [['work', 'agent', 3], ['pr', 'pull-request', null]]]);
  ok(s.check.estimate.optimistic > 0 && s.check.estimate.budget === 3, JSON.stringify(s.check.estimate));
});

atest('check: the form\'s definition becomes YAML and is validated as a run would', async (ed) => {
  const raw = yaml.parse(WF);
  raw.steps[0].until.max_retries = 5;
  raw.steps[0].prompt = 'line one\nline two: with a colon';
  const r = await request(ed.port, { method: 'POST', pathName: '/api/check', token: ed.token, body: { raw } });
  eq([r.status, r.json.ok], [200, true], r.text);
  ok(/prompt: \|-\n {6}line one\n {6}line two: with a colon\n/.test(r.json.text), r.json.text);
  ok(/writable: \[src\/\*\*\]/.test(r.json.text) && /max_retries: 5/.test(r.json.text), r.json.text);
  eq(yaml.parse(r.json.text), raw, 'what it writes reads back the same');
  const bad = await request(ed.port, { method: 'POST', pathName: '/api/check', token: ed.token, body: { text: WF.replace('pull_request: {}', 'kind: pull-request') } });
  eq(bad.json.ok, false);
  ok(/pull_request: \{ title: \.\.\. \} now/.test(bad.json.error), bad.json.error);
  const missing = await request(ed.port, { method: 'POST', pathName: '/api/check', token: ed.token, body: { text: WF.replace('agent: coder', 'agent: nobody') } });
  ok(/nobody/.test(missing.json.error), 'an agent that exists nowhere is an error, as for a run');
  const renamed = await request(ed.port, { method: 'POST', pathName: '/api/check', token: ed.token, body: { text: WF.replace('name: demo', 'name: other') } });
  ok(/the workflow is "demo"/.test(renamed.json.error), renamed.json.error);
});

atest('save: only valid text, only over the copy it loaded, only workflow.yaml', async (ed) => {
  const s = (await request(ed.port, { pathName: '/api/state', token: ed.token })).json;
  const invalid = await request(ed.port, { method: 'POST', pathName: '/api/save', token: ed.token, body: { text: 'name: demo\nsteps: []\n', base: s.base } });
  eq(invalid.status, 422);
  eq(fs.readFileSync(file, 'utf8'), WF, 'nothing written');
  const stale = await request(ed.port, { method: 'POST', pathName: '/api/save', token: ed.token, body: { text: WF, base: 'f'.repeat(64) } });
  eq(stale.status, 409, 'the file changed since it was loaded');
  const next = WF.replace('max_usd: 3', 'max_usd: 4');
  const saved = await request(ed.port, { method: 'POST', pathName: '/api/save', token: ed.token, body: { text: next, base: s.base } });
  eq(saved.status, 200, saved.text);
  eq(fs.readFileSync(file, 'utf8'), next);
  eq([saved.json.text, saved.json.approval.approved], [next, false], 'saved is not approved: it differs from origin/main');
  eq(git(['status', '--porcelain']).trim(), 'M .aidev/workflows/demo/workflow.yaml', 'one file changed, nothing committed');
  fs.writeFileSync(file, WF, 'utf8');
});


module.exports = { WF };

if (require.main === module) (async () => {
  const ed = await editor.startEditor({ repoRoot: root, installRoot: KIT, name: 'demo' });
  const results = [];
  for (const [name, fn] of tests) {
    try { await fn(ed); results.push([name, null]); } catch (e) { results.push([name, e.message]); }
  }
  try {
    const closed = await request(ed.port, { method: 'POST', pathName: '/api/close', token: ed.token, body: {} });
    eq(closed.json, { ok: true });
    await ed.closed;
    results.push(['close ends the editor', null]);
  } catch (e) { results.push(['close ends the editor', e.message]); await ed.close().catch(() => {}); }
  console.log(JSON.stringify({ results }));
})();
