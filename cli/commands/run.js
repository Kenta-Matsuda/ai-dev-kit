'use strict';
/**
 * `aidev run workflow <name>` — execute an approved workflow. The one command
 * a team member types every day; see `./workflow` for what it does.
 */

const { AidevError } = require('../lib/errors');
const wfMod = require('../lib/workflow');
const workflow = require('./workflow');

const FLAGS = {
  json: 'boolean', 'dry-run': 'boolean', task: 'string', 'task-file': 'string', input: 'list', 'max-minutes': 'string', 'max-usd': 'string',
  resume: 'string', log: 'string', dated: 'boolean', trial: 'boolean',
};
const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'show the approval state, scope, agents, steps, inputs and limits; start nothing',
  task: 'instructions for this run, handed to every agent step as data',
  'task-file': 'read --task from a file',
  input: 'name=value for an input the workflow declares (inputs:); once per input',
  'max-minutes': 'a time limit for this run (below limits.max_minutes when the workflow sets one)',
  'max-usd': 'a cost limit for this run, below limits.max_usd',
  log: 'also write the whole run (every line, every tool call, each agent report, command output) and a summary to this file',
  resume: 'continue a stopped run from the step it stopped at (a run id, or "last"), in its worktree, from its last checkpoint',
  dated: 'work on a new branch aidev/<name>-<yyyymmddHHMM> (and worktree) instead of the workflow\'s own aidev/<name>',
  trial: 'try the definition as it is in this checkout, approved or not: on aidev/<name>.trial, pushing nothing and opening no pull request',
};

async function run(ctx) {
  const what = ctx.positionals[0];
  if (what !== 'workflow') throw new AidevError('aidev run takes "workflow <name>" (see "aidev list workflows")');
  if (!ctx.positionals[1]) throw new AidevError('aidev run workflow needs a name');
  return workflow.runWorkflow({ ...ctx, positionals: ['workflow', ctx.positionals[1]] });
}

module.exports = { run, FLAGS, FLAG_HELP, summary: '承認済み workflow を実行する（開発はここから）' };
