'use strict';
/**
 * `aidev estimate workflow <name>` — what a run is likely to cost, as an
 * optimistic and a pessimistic figure, before anything starts. See
 * `../lib/estimate` for how the figures are made and `./workflow`
 * (estimateWorkflow) for the optional estimator agent.
 */

const { AidevError } = require('../lib/errors');
const workflow = require('./workflow');

const FLAGS = { json: 'boolean', task: 'string', 'task-file': 'string', input: 'list', ai: 'boolean', review: 'boolean' };
const FLAG_HELP = {
  json: 'machine-readable output',
  task: 'the task you would run it with (the estimator agent reads it)',
  'task-file': 'read --task from a file',
  input: 'name=value for an input you would run it with (the estimator agent reads it); once per input',
  ai: 'first have the cost-estimator agent size the work for this task (it reads the code; it costs a little); its judgment is kept for later runs',
  review: 'run the estimate reviewer now on the records it has not seen (normally it starts by itself after runs miss their estimate)',
};

async function run(ctx) {
  const what = ctx.positionals[0];
  if (what !== 'workflow') throw new AidevError('aidev estimate takes "workflow <name>" (see "aidev list workflows")');
  if (!ctx.positionals[1]) throw new AidevError('aidev estimate workflow needs a name');
  return workflow.estimateWorkflow({ ...ctx, positionals: ['workflow', ctx.positionals[1]] });
}

module.exports = { run, FLAGS, FLAG_HELP, summary: 'workflow を実行する前に費用を見積もる（楽観〜悲観）' };
