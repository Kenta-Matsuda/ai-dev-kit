'use strict';
/**
 * `aidev run workflow <name>` — execute an approved workflow. The one command
 * a team member types every day; see `./workflow` for what it does.
 */

const { AidevError } = require('../lib/errors');
const wfMod = require('../lib/workflow');
const workflow = require('./workflow');

const FLAGS = { json: 'boolean', 'dry-run': 'boolean', task: 'string', 'task-file': 'string', 'max-minutes': 'string' };
const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'show the approval state, scope, agents, steps and limits; start nothing',
  task: 'instructions for this run, handed to every agent step as data',
  'task-file': 'read --task from a file',
  'max-minutes': `lower the time ceiling for this run (never above ${wfMod.LIMITS.maxMinutes})`,
};

async function run(ctx) {
  const what = ctx.positionals[0];
  if (what !== 'workflow') throw new AidevError('aidev run takes "workflow <name>" (see "aidev list workflows")');
  if (!ctx.positionals[1]) throw new AidevError('aidev run workflow needs a name');
  return workflow.runWorkflow({ ...ctx, positionals: ['workflow', ctx.positionals[1]] });
}

module.exports = { run, FLAGS, FLAG_HELP, summary: '承認済み workflow を実行する（開発はここから）' };
