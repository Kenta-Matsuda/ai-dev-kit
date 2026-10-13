'use strict';
/**
 * `aidev modify workflow <name> --describe "<what to change>"` — change an
 * existing workflow in plain language (or `--from-run <id>`: fix what made
 * that run fail). The workflow-creator agent edits the
 * definition in place; see `./workflow` (modifyWorkflow) for what it is told
 * and how the result is checked. Like `create`, it writes and never runs.
 */

const { AidevError } = require('../lib/errors');
const workflow = require('./workflow');

const FLAGS = { json: 'boolean', 'dry-run': 'boolean', describe: 'string', 'from-run': 'string' };
const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'show which agent would edit what; start nothing, write nothing',
  describe: 'what to change, in plain language; the workflow-creator agent edits the files',
  'from-run': 'a run of this workflow (an id, or "last") whose failure the change must fix; its record goes to the agent, and to the pull request of "aidev submit"',
};

async function run(ctx) {
  const what = ctx.positionals[0];
  if (what !== 'workflow') throw new AidevError('aidev modify takes "workflow <name>"');
  if (!ctx.positionals[1]) throw new AidevError('aidev modify workflow needs a name');
  return workflow.modifyWorkflow({ ...ctx, positionals: ['workflow', ctx.positionals[1]] });
}

module.exports = { run, FLAGS, FLAG_HELP, summary: '既存の workflow を自然言語の指示で直す（書くだけで、実行はしない）' };
