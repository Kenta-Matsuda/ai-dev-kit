'use strict';
/**
 * `aidev list workflows|agents|skills` — what this PKG can run and what it
 * is made of. Workflows carry their approval state; agents and skills say
 * whether they come from this PKG (`.aidev/`) or are bundled with the kit.
 */

const fs = require('fs');
const path = require('path');
const { EXIT, AidevError } = require('../lib/errors');
const layout = require('../lib/layout');
const toolsMod = require('../lib/tools');
const workflow = require('./workflow');
const ui = require('../lib/ui');

const KINDS = ['workflows', 'agents', 'skills'];
const FLAGS = { json: 'boolean' };
const FLAG_HELP = { json: 'machine-readable output' };

function pkgAgents(repoRoot) {
  const dir = layout.abs(repoRoot, layout.AGENTS_REL);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
  return files.map((f) => {
    const { meta } = toolsMod.parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const name = f.replace(/\.md$/, '');
    return { name, description: meta.description || '', source: 'pkg', path: `${layout.AGENTS_REL}/${f}`, nameMismatch: meta.name && meta.name !== name ? meta.name : null };
  });
}

function skillDirs(base) {
  try { return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

function skillEntry(base, name, source, rel) {
  const file = path.join(base, name, 'SKILL.md');
  let description = '';
  try { description = toolsMod.parseFrontmatter(fs.readFileSync(file, 'utf8')).meta.description || ''; } catch { description = '(SKILL.md missing)'; }
  return { name, description, source, path: rel };
}

function listAgents(ctx) {
  const { repoRoot, installRoot, flags } = ctx;
  const pkg = pkgAgents(repoRoot);
  const kit = toolsMod.listBundledAgents(installRoot).map((a) => ({ name: a.name, description: a.description, source: 'kit', path: a.file }));
  const rows = [...pkg, ...kit.filter((k) => !pkg.some((p) => p.name === k.name))];
  if (flags.json) { ui.json({ agents: rows }); return EXIT.OK; }
  ui.heading('aidev list agents');
  ui.table(rows.map((r) => [r.name, r.source === 'pkg' ? 'this PKG' : 'kit', r.description.slice(0, 90) + (r.nameMismatch ? `  ⚠ frontmatter name is ${r.nameMismatch}` : '')]));
  ui.dim(`    a PKG agent in ${layout.AGENTS_REL}/ takes precedence over a kit agent of the same name`);
  return EXIT.OK;
}

function listSkills(ctx) {
  const { repoRoot, installRoot, flags } = ctx;
  const pkgBase = layout.abs(repoRoot, layout.SKILLS_REL);
  const kitBase = path.join(installRoot, 'templates', 'claude', '.claude', 'skills');
  const pkg = skillDirs(pkgBase).map((n) => skillEntry(pkgBase, n, 'pkg', `${layout.SKILLS_REL}/${n}/SKILL.md`));
  const kit = skillDirs(kitBase).filter((n) => !pkg.some((p) => p.name === n)).map((n) => skillEntry(kitBase, n, 'kit', `templates/claude/.claude/skills/${n}/SKILL.md`));
  const rows = [...pkg, ...kit];
  if (flags.json) { ui.json({ skills: rows }); return EXIT.OK; }
  ui.heading('aidev list skills');
  ui.table(rows.map((r) => [r.name, r.source === 'pkg' ? 'this PKG' : 'kit', r.description.slice(0, 90)]));
  return EXIT.OK;
}

function run(ctx) {
  const what = ctx.positionals[0];
  if (what === 'workflows') return workflow.list(ctx);
  if (what === 'agents') return listAgents(ctx);
  if (what === 'skills') return listSkills(ctx);
  throw new AidevError(`aidev list needs what to list: ${KINDS.join(', ')}`);
}

module.exports = { run, FLAGS, FLAG_HELP, KINDS, pkgAgents, summary: 'workflow（承認状態）/ agent / skill の一覧' };
