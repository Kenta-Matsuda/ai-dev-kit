'use strict';
/**
 * Azure DevOps REST client.
 *
 * Zero dependencies: node's own https module, because `npm install` is not
 * assumed to be available on a corporate network.
 *
 * Two rules are load-bearing:
 *
 *   1. The PAT is read from the environment variable named by
 *      `azure_devops.auth_env` at call time. It never enters a config file, a
 *      command line, a log line or an error message.
 *   2. Everything the API returns is DATA. Work Item titles, descriptions and
 *      comments are attacker-influenced text; they are never interpolated into
 *      instructions, and IDs/SHAs/states are re-validated before being acted
 *      on.
 */

const https = require('https');
const { URL } = require('url');
const { AidevError } = require('./errors');

const API_VERSION = '7.1';

function authHeader(config) {
  const envName = config?.azure_devops?.auth_env || 'AZURE_DEVOPS_PAT';
  const pat = process.env[envName];
  if (!pat) {
    throw new AidevError(
      `${envName} is not set. Azure DevOps operations need a PAT supplied through that ` +
      'environment variable (never a config file or a command-line argument).');
  }
  // Azure DevOps basic auth: empty username, PAT as password.
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;
}

function baseUrl(config) {
  const ado = config.azure_devops;
  return `https://dev.azure.com/${encodeURIComponent(ado.organization)}/${encodeURIComponent(ado.project)}`;
}

/**
 * Perform one request. Never logs the body of a failed auth attempt, because
 * a 401 response can echo the submitted header in some proxy configurations.
 */
function request(config, method, urlStr, body = null, { timeoutMs = 30000 } = {}) {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') throw new AidevError(`refusing a non-HTTPS Azure DevOps URL: ${url.protocol}`);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      headers: {
        Authorization: authHeader(config),
        Accept: 'application/json',
        'User-Agent': 'ai-dev-kit',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        if (status === 401 || status === 403) {
          reject(new AidevError(
            `Azure DevOps returned ${status}. The PAT is missing a required scope or has expired. ` +
            '(The token value is never printed.)'));
          return;
        }
        if (status >= 400) {
          let detail = text.slice(0, 500);
          try { detail = JSON.parse(text).message || detail; } catch { /* keep raw */ }
          reject(new AidevError(`Azure DevOps ${method} ${url.pathname} failed (${status}): ${detail}`));
          return;
        }
        if (text.trim() === '') { resolve(null); return; }
        try { resolve(JSON.parse(text)); } catch (e) {
          reject(new AidevError(`Azure DevOps returned unparsable JSON: ${e.message}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new AidevError(`Azure DevOps request timed out after ${timeoutMs}ms`)); });
    req.on('error', (e) => reject(e instanceof AidevError ? e : new AidevError(`Azure DevOps request failed: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function withApiVersion(url) {
  return url.includes('?') ? `${url}&api-version=${API_VERSION}` : `${url}?api-version=${API_VERSION}`;
}

// ---------------------------------------------------------------- Pull requests

/**
 * Azure DevOps refuses a pull request description longer than this
 * (HTTP 400, "A description for a pull request must not be longer than 4000
 * characters"). It counts UTF-16 code units, as JavaScript's `length` does:
 * an emoji is 2, a line break is 1, and exactly 4000 is accepted.
 */
const PR_DESCRIPTION_MAX = 4000;
const CUT_NOTE = `… (shortened to the ${PR_DESCRIPTION_MAX} characters Azure DevOps accepts)`;
// Room kept for closing a code fence the cut leaves open.
const FENCE_ROOM = 8;

/** The first `n` UTF-16 code units of `s`, one fewer when the last would split a surrogate pair. */
function sliceUnits(s, n) {
  if (s.length <= n) return s;
  const end = Math.max(0, n);
  const c = s.charCodeAt(end - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? end - 1 : end);
}

/** The fence (``` or ~~~, as long as it was opened) a Markdown text leaves open at its end, or null. */
function openFence(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    if (!open) open = m[1];
    else if (m[1][0] === open[0] && m[1].length >= open.length && !m[2].trim()) open = null;
  }
  return open;
}

/**
 * A pull request description Azure DevOps accepts: `text` as is when it
 * fits in `max`, otherwise cut at a line break, `note` after the cut, and
 * `keep` (a suffix of `text`, such as the line telling the reviewer what
 * merging means) after that. The cut never splits a surrogate pair and
 * closes a code fence it leaves open, so the note does not read as code.
 * A lone surrogate left by an earlier cut (a report's tail) becomes U+FFFD.
 */
function fitDescription(text, { max = PR_DESCRIPTION_MAX, note = CUT_NOTE, keep = '' } = {}) {
  const s = String(text ?? '').toWellFormed();
  if (s.length <= max) return s;
  const kept = keep && s.endsWith(keep) && keep.length <= max / 2 ? keep : '';
  const end = `\n\n${note}${kept ? `\n\n${kept.replace(/^\s+/, '')}` : ''}`;
  let head = sliceUnits(s.slice(0, s.length - kept.length), max - end.length - FENCE_ROOM);
  const nl = head.lastIndexOf('\n');
  if (nl > head.length / 2) head = head.slice(0, nl);
  head = head.trimEnd();
  const fence = openFence(head);
  if (fence && fence.length < FENCE_ROOM) head += `\n${fence}`;
  return sliceUnits(`${head}${end}`, max);
}

async function listPullRequests(config, repositoryId, { status = 'active', sourceBranch = null, targetBranch = null } = {}) {
  const q = [`searchCriteria.status=${encodeURIComponent(status)}`];
  if (sourceBranch) q.push(`searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${sourceBranch}`)}`);
  if (targetBranch) q.push(`searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${targetBranch}`)}`);
  const res = await request(config, 'GET', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?${q.join('&')}`));
  return Array.isArray(res?.value) ? res.value : [];
}

async function createPullRequest(config, repositoryId, { sourceBranch, targetBranch, title, description, reviewers = [] }) {
  return request(config, 'POST', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`), {
    sourceRefName: `refs/heads/${sourceBranch}`,
    targetRefName: `refs/heads/${targetBranch}`,
    title,
    // The callers fit their text with a note of their own; this is the last guard.
    description: fitDescription(description),
    reviewers: reviewers.map((id) => ({ id })),
  });
}

async function updatePullRequestDescription(config, repositoryId, pullRequestId, description) {
  return request(config, 'PATCH', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`),
  { description: fitDescription(description) });
}

module.exports = {
  API_VERSION, baseUrl, request, withApiVersion,
  PR_DESCRIPTION_MAX, fitDescription,
  listPullRequests, createPullRequest, updatePullRequestDescription,
};
