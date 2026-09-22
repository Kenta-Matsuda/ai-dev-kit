'use strict';
/**
 * `aidev submit workflow <name>` — put a workflow (and the PKG agents and
 * skills it references) on its own branch as a pull request. Merging that
 * pull request is what approves it; see `./workflow`.
 */

const { AidevError } = require('../lib/errors');
const workflow = require('./workflow');

const FLAGS = { json: 'boolean', 'dry-run': 'boolean', 'no-push': 'boolean' };
const FLAG_HELP = {
  json: 'machine-readable output',
  'dry-run': 'show the branch, target and files; create no branch, commit, push or pull request',
  'no-push': 'commit on the local branch only; do not push or open a pull request',
};

async function run(ctx) {
  const what = ctx.positionals[0];
  if (what !== 'workflow') throw new AidevError('aidev submit takes "workflow <name>" (agents and skills travel with the workflow that references them)');
  if (!ctx.positionals[1]) throw new AidevError('aidev submit workflow needs a name');
  return workflow.submit({ ...ctx, positionals: ['workflow', ctx.positionals[1]] });
}

module.exports = { run, FLAGS, FLAG_HELP, summary: 'workflow をブランチと PR にして提出する（マージ = 承認）' };
