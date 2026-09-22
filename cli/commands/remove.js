'use strict';
/**
 * `aidev remove workflow|agent|skill <name>` — delete one of the things
 * `aidev create` makes. Files only; the commit (and the pull request that
 * un-approves the workflow) is the person's.
 *
 * An agent or skill that a workflow in this PKG still references is not
 * removed: the workflow would become invalid, and `aidev check` would say so
 * to everyone. Remove the reference first.
 */

const fs = require('fs');
const { EXIT, AidevError } = require('../lib/errors');
const layout = require('../lib/layout');
const toolsMod = require('../lib/tools');
const wfMod = require('../lib/workflow');
const ui = require('../lib/ui');

const KINDS = ['workflow', 'agent', 'skill'];
const FLAGS = { json: 'boolean', 'dry-run': 'boolean' };
const FLAG_HELP = { json: 'machine-readable output', 'dry-run': 'show what would be deleted; delete nothing' };

/** Workflows in this PKG whose definition names the agent or skill. */
function referencing(repoRoot, kind, name) {
  const out = [];
  for (const wf of wfMod.listWorkflows(repoRoot)) {
    let def;
    try { def = wfMod.loadDefinition(repoRoot, wf); } catch { continue; }
    if ((kind === 'agent' ? def.agents : def.skills).includes(name)) out.push(wf);
  }
  return out;
}

function run(ctx) {
  const { repoRoot, flags, positionals } = ctx;
  const kind = positionals[0];
  if (!KINDS.includes(kind)) throw new AidevError(`aidev remove needs what to remove: ${KINDS.join(', ')} (then a name)`);
  if (!positionals[1]) throw new AidevError(`aidev remove ${kind} needs a name`);

  let rel;
  let target;
  if (kind === 'workflow') {
    const name = wfMod.sanitizeName(positionals[1]);
    rel = wfMod.workflowRel(name);
    target = wfMod.workflowDir(repoRoot, name);
  } else {
    let name;
    try { name = toolsMod.assertAgentName(positionals[1]); } catch (e) { throw new AidevError(`${kind} name: ${e.message}`); }
    rel = kind === 'agent' ? wfMod.agentRel(name) : `${layout.SKILLS_REL}/${name}`;
    target = layout.abs(repoRoot, rel);
    const users = referencing(repoRoot, kind, name);
    if (users.length) {
      throw new AidevError(`${kind} ${name} is referenced by workflow(s) ${users.join(', ')}; remove the reference (and submit) first`);
    }
  }
  if (!fs.existsSync(target)) throw new AidevError(`no such ${kind}: ${rel}`);

  if (flags['dry-run']) {
    ui.ok(`would delete ${rel}${kind === 'workflow' ? ' (including its runs/ records)' : ''}`);
    return EXIT.OK;
  }
  fs.rmSync(target, { recursive: true, force: true });
  ui.heading(`aidev remove ${kind} ${positionals[1]}`);
  ui.ok(`deleted ${rel}`);
  ui.dim('    commit the deletion and open a pull request; the change reaches the team through the merge');
  if (flags.json) ui.json({ ok: true, kind, name: positionals[1], path: rel });
  return EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, referencing, summary: 'workflow / agent / skill を削除する（参照されている agent / skill は拒否）' };
