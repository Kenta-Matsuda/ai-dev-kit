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

// ------------------------------------------------------------------ Work Items

async function getWorkItem(config, id) {
  const n = Number.parseInt(String(id).replace(/^wi-/i, ''), 10);
  if (!Number.isInteger(n) || n <= 0) throw new AidevError(`invalid work item id: ${id}`);
  return request(config, 'GET', withApiVersion(`${baseUrl(config)}/_apis/wit/workitems/${n}?$expand=relations`));
}

/**
 * Is this Work Item opted in to AI handling?
 *
 * Opt-in is decided by repository configuration, never by anything written
 * inside the Work Item, so a Work Item cannot opt itself in.
 */
function isOptedIn(config, workItem) {
  const triage = config.azure_devops.triage || {};
  const wantLabels = triage.labels || [];
  const wantArea = triage.area_path || null;
  const fields = workItem?.fields || {};
  const tags = String(fields['System.Tags'] || '').split(';').map((s) => s.trim()).filter(Boolean);
  const area = String(fields['System.AreaPath'] || '');

  if (wantLabels.length > 0 && wantLabels.some((l) => tags.includes(l))) return { ok: true, reason: null };
  if (wantArea && area === wantArea) return { ok: true, reason: null };
  return {
    ok: false,
    reason: wantLabels.length === 0 && !wantArea
      ? 'azure_devops.triage declares no labels or area_path, so nothing is opted in'
      : `work item does not carry any of the opt-in labels [${wantLabels.join(', ')}]` +
        (wantArea ? ` and is not under area path ${wantArea}` : ''),
  };
}

// ---------------------------------------------------------------- Pull requests

async function getPullRequest(config, repositoryId, pullRequestId) {
  const id = Number.parseInt(String(pullRequestId), 10);
  if (!Number.isInteger(id) || id <= 0) throw new AidevError(`invalid pull request id: ${pullRequestId}`);
  return request(config, 'GET', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${id}`));
}

async function listPullRequests(config, repositoryId, { status = 'active', sourceBranch = null, targetBranch = null } = {}) {
  const q = [`searchCriteria.status=${encodeURIComponent(status)}`];
  if (sourceBranch) q.push(`searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${sourceBranch}`)}`);
  if (targetBranch) q.push(`searchCriteria.targetRefName=${encodeURIComponent(`refs/heads/${targetBranch}`)}`);
  const res = await request(config, 'GET', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests?${q.join('&')}`));
  return Array.isArray(res?.value) ? res.value : [];
}

/**
 * Resolve the SHA a merged PR actually produced.
 *
 * Never the agent's branch tip: squash and rebase both create a new commit,
 * reviewers push extra commits, and interleaved PRs move the branch. Only the
 * PR's own `lastMergeCommit` is authoritative.
 */
function mergeResultSha(pr) {
  if (!pr || pr.status !== 'completed' || pr.mergeStatus === 'conflicts') return null;
  const sha = pr.lastMergeCommit?.commitId || null;
  return /^[0-9a-f]{40}$/i.test(String(sha || '')) ? sha : null;
}

async function createPullRequest(config, repositoryId, { sourceBranch, targetBranch, title, description, reviewers = [] }) {
  return request(config, 'POST', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`), {
    sourceRefName: `refs/heads/${sourceBranch}`,
    targetRefName: `refs/heads/${targetBranch}`,
    title,
    description,
    reviewers: reviewers.map((id) => ({ id })),
  });
}

async function updatePullRequestDescription(config, repositoryId, pullRequestId, description) {
  return request(config, 'PATCH', withApiVersion(
    `${baseUrl(config)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${pullRequestId}`),
  { description });
}

// ------------------------------------------------------------------- comments

const MARKER = '<!-- aidev:state -->';

/**
 * Append a structured state comment to a Work Item.
 * Only ids, branch names, SHAs and states — never diffs, bodies or secrets.
 */
async function postStateComment(config, workItemId, record) {
  const safe = {
    taskId: record.taskId, state: record.state, pkgBranch: record.pkgBranch,
    pkgPullRequestId: record.pkgPullRequestId, wikiPullRequestId: record.wikiPullRequestId,
    mergedSha: record.mergedSha, operationKey: record.operationKey,
    syncStreamId: record.syncStreamId, updatedAt: record.updatedAt,
  };
  const text = `${MARKER}\n\`\`\`json\n${JSON.stringify(safe, null, 2)}\n\`\`\``;
  const n = Number.parseInt(String(workItemId), 10);
  return request(config, 'POST', withApiVersion(
    `${baseUrl(config)}/_apis/wit/workItems/${n}/comments`), { text });
}

module.exports = {
  API_VERSION, MARKER, baseUrl, request, withApiVersion,
  getWorkItem, isOptedIn,
  getPullRequest, listPullRequests, mergeResultSha, createPullRequest,
  updatePullRequestDescription, postStateComment,
};
