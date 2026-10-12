'use strict';
/**
 * The workflow editor behind `aidev edit workflow <name>`: a small HTTP
 * server on 127.0.0.1 that serves one page (cli/editor/index.html) and a
 * JSON API the page calls to check and save the definition.
 *
 * What it may touch is narrow on purpose: it reads the PKG (the definition,
 * its agents, the approval state, the estimate records) and writes exactly
 * one file, `.aidev/workflows/<name>/workflow.yaml`, and only text that
 * passes the same validation `aidev run workflow` applies. It never writes an
 * agent, a policy file or anything outside the PKG, runs no agent and no
 * command, and commits nothing: what it saves is an unapproved change until
 * `aidev submit workflow` and a reviewed pull request make it the approved one.
 *
 * The server answers only on the loopback interface, only to a request whose
 * Host is that interface and port (a page on another site that resolves its
 * own name to 127.0.0.1 cannot reach it), and the API only with the random
 * token in the page's address (another local program that finds the port
 * still cannot read or write). The token is in the fragment of the URL, so
 * the browser never sends it in a request line or a Referer.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { AidevError } = require('./errors');
const layout = require('./layout');
const cfgMod = require('./config');
const gitMod = require('./git');
const toolsMod = require('./tools');
const wfMod = require('./workflow');
const yaml = require('./yaml');
const estimateMod = require('./estimate');

const PAGE_REL = 'cli/editor/index.html';
const MAX_BODY = 1024 * 1024;

const sha = (text) => crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex');

/** The agents a step can name: the PKG's own, then the kit's (by name, PKG first). */
function agentCatalogue(repoRoot, installRoot) {
  const names = new Set();
  try { for (const f of fs.readdirSync(layout.abs(repoRoot, layout.AGENTS_REL))) if (f.endsWith('.md')) names.add(f.replace(/\.md$/, '')); } catch { /* none */ }
  for (const a of toolsMod.listBundledAgents(installRoot)) names.add(a.name);
  const out = [];
  for (const n of [...names].sort()) {
    let a = null;
    try { a = wfMod.resolveAgent(repoRoot, installRoot, n); } catch { a = null; }
    if (!a) continue;
    out.push({
      name: n, source: a.source, rel: a.rel, description: a.description,
      tools: a.capabilities ? a.capabilities.tools : null, mcp: a.capabilities ? a.capabilities.mcp : [],
      skills: a.capabilities ? a.capabilities.skills : [], error: a.capabilityError || null,
    });
  }
  return out;
}

/** Does the text carry YAML comments? Saving from the form drops them. */
function hasComments(text) {
  return String(text || '').split(/\r?\n/).some((l) => /^\s*#/.test(l) || /\s#\s/.test(l.replace(/"[^"]*"|'[^']*'/g, '')));
}

/**
 * Check a definition the way the runner does, and say what it would cost:
 * { ok, error, raw, summary, estimate }. Never throws.
 */
function checkText(ctx, text) {
  const { repoRoot, installRoot, name } = ctx;
  const out = { ok: false, error: null, raw: null, summary: null, estimate: null };
  try { out.raw = yaml.parse(String(text)); } catch (e) { out.error = `YAML: ${e.message}`; return out; }
  let def;
  try {
    def = wfMod.validateDefinition(out.raw, wfMod.defRel(name));
    if (def.name !== name) throw new AidevError(`name is "${def.name}" but the workflow is "${name}" (the directory name)`);
  } catch (e) { out.error = e.message; return out; }
  out.summary = {
    agents: def.agents, writable: def.writable, limits: def.limits,
    steps: def.steps.map((s) => ({ id: s.id, kind: s.kind, agent: s.agent || null, maxRetries: s.max_retries == null ? null : s.max_retries })),
  };
  // Every agent and skill it names must exist, as for a run.
  try { wfMod.resolveDependencies(repoRoot, installRoot, def); } catch (e) { out.error = e.message; return out; }
  out.ok = true;
  try {
    const config = cfgMod.loadConfig(repoRoot);
    const models = {};
    let reports = true;
    for (const a of def.agents) {
      const settings = cfgMod.agentSettings(config, a);
      const tool = def.tool || settings.tool;
      models[a] = (def.model !== undefined ? def.model : settings.model) || null;
      if (tool !== 'claude') reports = false;
    }
    const history = estimateMod.collectHistory(repoRoot);
    const est = estimateMod.estimateDefinition(def, {
      history, ai: estimateMod.readJudgment(repoRoot, name, wfMod.contentHash(text)), reportsCost: reports, models, priors: estimateMod.readPriors(repoRoot),
    });
    out.estimate = { optimistic: est.optimistic, pessimistic: est.pessimistic, budget: est.budget, steps: est.steps.map((s) => ({ id: s.id, usd: s.usd, basis: s.basis || null })) };
  } catch (e) { out.estimate = { error: e.message }; }
  return out;
}

function state(ctx) {
  const { repoRoot, installRoot, name } = ctx;
  const rel = wfMod.defRel(name);
  const text = cfgMod.readTextIfExists(layout.abs(repoRoot, rel));
  if (text == null) throw new AidevError(`no such workflow: ${name} (expected ${rel})`);
  const config = cfgMod.loadConfig(repoRoot, { required: false });
  const ref = wfMod.trackingRef(config);
  const inspected = wfMod.inspect(repoRoot, installRoot, config, name);
  let origin = null;
  try { origin = gitMod.showFile(repoRoot, ref, rel); } catch { origin = null; }
  return {
    name, rel, text, base: sha(text), ref, origin,
    approval: { approved: inspected.approval.approved, reason: inspected.approval.reason || null, files: (inspected.approval.files || []).map((f) => ({ rel: f.rel, state: f.state })) },
    agents: agentCatalogue(repoRoot, installRoot),
    kinds: estimateMod.KINDS, limits: wfMod.LIMITS, comments: hasComments(text),
    check: checkText(ctx, text),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('the body is not JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function tokenMatches(given, token) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(token, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Start the editor for one workflow. Resolves to { url, port, token, close,
 * closed } once it is listening; `closed` resolves when the page says it is
 * done (or close() is called).
 */
function startEditor({ repoRoot, installRoot, name, port = 0, onSave = null }) {
  wfMod.sanitizeName(name);
  if (cfgMod.readTextIfExists(wfMod.defPath(repoRoot, name)) == null) {
    return Promise.reject(new AidevError(`no such workflow: ${name} (expected ${wfMod.defRel(name)}); create it first ("aidev create workflow ${name}")`));
  }
  const page = cfgMod.readTextIfExists(path.join(installRoot, ...PAGE_REL.split('/')));
  if (page == null) return Promise.reject(new AidevError(`the editor page is missing from the kit checkout (${PAGE_REL})`));
  const token = crypto.randomBytes(24).toString('hex');
  const ctx = { repoRoot, installRoot, name };
  let actualPort = null;
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });

  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      ...(type.startsWith('text/html') ? {
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      } : {}),
    });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };

  const server = http.createServer(async (req, res) => {
    // Only this interface and port: a DNS-rebinding page sends its own host name.
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) { send(res, 421, { error: 'wrong host' }); return; }
    const origin = req.headers.origin;
    if (origin && origin !== `http://127.0.0.1:${actualPort}` && origin !== `http://localhost:${actualPort}`) { send(res, 403, { error: 'wrong origin' }); return; }
    const url = new URL(req.url, `http://${host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { send(res, 200, page, 'text/html; charset=utf-8'); return; }
    if (!url.pathname.startsWith('/api/')) { send(res, 404, { error: 'not found' }); return; }
    if (!tokenMatches(req.headers['x-aidev-token'], token)) { send(res, 403, { error: 'missing or wrong token' }); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') { send(res, 200, state(ctx)); return; }
      if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
      if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) { send(res, 415, { error: 'send JSON' }); return; }
      const body = await readBody(req);
      if (url.pathname === '/api/check') {
        // From the form: the parsed definition, written back as YAML here.
        const text = body.raw !== undefined ? yaml.stringify(body.raw) : String(body.text == null ? '' : body.text);
        send(res, 200, { text, ...checkText(ctx, text) });
        return;
      }
      if (url.pathname === '/api/save') {
        const file = wfMod.defPath(repoRoot, name);
        const current = cfgMod.readTextIfExists(file);
        if (current == null) { send(res, 409, { error: `${wfMod.defRel(name)} no longer exists` }); return; }
        if (body.base !== sha(current)) { send(res, 409, { error: `${wfMod.defRel(name)} changed on disk since the editor loaded it; reload to see it`, text: current }); return; }
        const text = String(body.text == null ? '' : body.text);
        const check = checkText(ctx, text);
        if (!check.ok) { send(res, 422, { error: check.error, check }); return; }
        cfgMod.writeFileAtomic(file, text.endsWith('\n') ? text : `${text}\n`);
        if (onSave) onSave(wfMod.defRel(name));
        send(res, 200, state(ctx));
        return;
      }
      if (url.pathname === '/api/close') {
        send(res, 200, { ok: true });
        setImmediate(() => close());
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
  });
  server.keepAliveTimeout = 1000;

  const close = () => new Promise((r) => {
    server.close(() => { resolveClosed(); r(); });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new AidevError(`the editor could not listen on 127.0.0.1:${port}: ${e.message}`)));
    server.listen(port, '127.0.0.1', () => {
      actualPort = server.address().port;
      resolve({ url: `http://127.0.0.1:${actualPort}/#t=${token}`, port: actualPort, token, close, closed });
    });
  });
}

module.exports = { startEditor, checkText, state, hasComments, agentCatalogue, PAGE_REL };
