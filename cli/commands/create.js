'use strict';
/**
 * `aidev create workflow|agent|skill <name>` — the one place things get made.
 *
 * A workflow is what the team asks the AI to do; an agent is a role the
 * workflow's steps run as; a skill is a procedure inlined into those steps.
 * All three land under `.aidev/` in the PKG, are reviewed as a pull request
 * (`aidev submit workflow`), and are approved by being merged. Creating never
 * runs anything.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const agentMod = require('../lib/agent');
const layout = require('../lib/layout');
const toolsMod = require('../lib/tools');
const wfMod = require('../lib/workflow');
const workflow = require('./workflow');
const ui = require('../lib/ui');

const KINDS = ['workflow', 'agent', 'skill', 'policy'];

const FLAGS = { json: 'boolean', force: 'boolean', 'dry-run': 'boolean', describe: 'string', approve: 'boolean' };
const FLAG_HELP = {
  json: 'machine-readable output',
  force: 'workflow / agent / skill: overwrite an existing one. policy: also place a candidate that gives up a protection the current policy has',
  'dry-run': 'show what would be written; write nothing, start nothing',
  describe: 'workflow / agent: describe it in plain language; the workflow-creator / agents-creator agent writes the file',
  approve: 'policy: place .aidev/policy.yaml from the freshly generated candidate (a human decision)',
};

const AGENT_TEMPLATE = (name) => `---
name: ${name}
description: <when this agent is started and what it does, in one or two sentences>
skills: []
tools: Read, Glob, Grep, Write, Edit, Bash
mcp: []
model: inherit
---

# ${name}

<what this agent is responsible for, in one paragraph>

## 入出力契約

| | |
| --- | --- |
| 入力 | prompt の「Objective」と「Task for this run」、\`.aidev/knowledge/\` |
| 出力 | 作業ツリー上の変更と final message の報告 |
| 必要権限 | 書けるのは workflow のステップの \`writable\` だけ（hook が強制する）。使えるのは frontmatter の \`tools\` と \`mcp\` だけ |
| 前提 | 承認済み workflow から起動されている |

## 手順

1. ...

## 停止条件

- ...
`;

const SKILL_TEMPLATE = (name) => `---
name: ${name}
description: <when to use this skill, in one sentence>
---

# ${name}

<the procedure, as numbered steps an agent follows>

1. ...
`;

function assertName(kind, raw) {
  try { return toolsMod.assertAgentName(raw); } catch (e) { throw new AidevError(`${kind} name: ${e.message}`); }
}

async function describeAgent(ctx, name, rel) {
  const { repoRoot, installRoot, flags } = ctx;
  const config = cfgMod.loadConfig(repoRoot);
  const creator = wfMod.resolveAgent(repoRoot, installRoot, 'agents-creator');
  if (!creator) throw new AidevError('the agents-creator agent is missing from the kit checkout');
  const settings = cfgMod.agentSettings(config, 'agents-creator');
  const tool = agentMod.assertToolEnabled(settings.tool, config, 'tools.agent');
  const existing = toolsMod.listBundledAgents(installRoot).map((a) => `- ${a.name} (kit): ${a.description}`);
  const prompt = [
    `# Create the agent "${name}"`, '',
    `Write ${rel}: frontmatter (name: ${name}, description, skills, tools, mcp, model: inherit) and the body with 入出力契約, 手順 and 停止条件.`,
    'skills, tools and mcp are what the agent can use and nothing more: list only what its work needs (tools: the built-in tools it gets; mcp: servers from the PKG\'s .mcp.json, [] when none).',
    'Do not run it. Do not commit. Do not write anywhere else.', '',
    '## What the team wants', '', String(flags.describe).trim(), '',
    '## Agents that already exist (do not duplicate one)', '', ...existing, '',
  ].join('\n');
  if (flags['dry-run']) {
    ui.table([['agent', 'agents-creator'], ['tool', tool], ['model', settings.model || 'tool default'], ['writes', rel]]);
    ui.ok('dry run: the agent was not started.');
    return EXIT.OK;
  }
  ui.info(`starting agents-creator via ${tool}${settings.model ? ` (${settings.model})` : ''}…`);
  const res = await agentMod.runAgent({
    repoRoot, installRoot, tool, agent: 'agents-creator', definition: creator.body, prompt,
    model: settings.model, timeoutMs: agentMod.DEFAULT_TIMEOUT_MS, label: `create-agent-${name}`,
    onProgress: flags.json ? null : agentMod.progressReporter({ repoRoot }),
  });
  if (!res.ok) throw new AidevError(`agents-creator did not finish: ${res.reason}`);
  const written = wfMod.resolveAgent(repoRoot, installRoot, name);
  const problem = !written || written.source !== 'pkg' ? `${rel} was not written`
    : toolsMod.parseFrontmatter(written.text).meta.name !== name ? `${rel}: frontmatter name must be ${name}`
      : written.capabilityError ? `${rel}: ${written.capabilityError}` : null;
  if (problem) ui.warn(`the agent finished, but: ${problem}`);
  else ui.ok(`wrote ${rel}${agentMod.runSummary(res)}`);
  if (flags.json) ui.json({ ok: !problem, kind: 'agent', name, path: rel, problem, costUsd: res.costUsd ?? null });
  return problem ? EXIT.GENERAL : EXIT.OK;
}

async function createFile(ctx, kind, name) {
  const { repoRoot, flags } = ctx;
  const rel = kind === 'agent' ? wfMod.agentRel(name) : wfMod.skillRel(name);
  const full = layout.abs(repoRoot, rel);
  if (fs.existsSync(full) && !flags.force) throw new AidevError(`${rel} already exists (pass --force to overwrite)`);
  ui.heading(`aidev create ${kind} ${name}`);
  if (flags.describe != null) {
    if (kind === 'skill') throw new AidevError('--describe is not available for skills: a skill is a procedure a person writes');
    if (!String(flags.describe).trim()) throw new AidevError('--describe needs text');
    return describeAgent(ctx, name, rel);
  }
  if (flags['dry-run']) { ui.ok(`would write ${rel} from the template`); return EXIT.OK; }
  cfgMod.writeFileAtomic(full, kind === 'agent' ? AGENT_TEMPLATE(name) : SKILL_TEMPLATE(name));
  ui.ok(`wrote ${rel} from the template`);
  ui.dim(kind === 'agent'
    ? `    edit it, name it in a workflow step (agent: ${name}), then "aidev submit workflow <workflow>"`
    : `    edit it, list it in an agent's frontmatter (skills: [${name}]), then "aidev submit workflow <workflow>"`);
  if (flags.json) ui.json({ ok: true, kind, name, path: rel });
  return EXIT.OK;
}

async function run(ctx) {
  const kind = ctx.positionals[0];
  if (!KINDS.includes(kind)) throw new AidevError(`aidev create needs what to create: ${KINDS.join(', ')} (then a name)`);
  if (kind === 'policy') {
    if (ctx.positionals[1]) throw new AidevError('aidev create policy takes no name: there is one policy per package');
    return require('./permission').configure(ctx);
  }
  const name = ctx.positionals[1];
  if (!name) throw new AidevError(`aidev create ${kind} needs a name`);
  if (kind === 'workflow') return workflow.newWorkflow({ ...ctx, positionals: ['workflow', name] });
  return createFile(ctx, kind, assertName(kind, name));
}

module.exports = { run, FLAGS, FLAG_HELP, KINDS, AGENT_TEMPLATE, SKILL_TEMPLATE, summary: 'workflow / agent / skill / policy を作る（書くだけで、実行はしない）' };
