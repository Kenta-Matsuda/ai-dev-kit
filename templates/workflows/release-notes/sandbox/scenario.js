'use strict';
/**
 * The sandbox scenario of the release-notes standard workflow
 * (`npm run sandbox -- release-notes`; see scripts/sandbox-workflow.js).
 *
 * The package under test is a tiny repository with a CHANGELOG, a tag v1.0.0
 * on its first commit and three commits after it (a feature, a fix and a
 * chore). The scripted agent collects the commits with git, writes the
 * 1.1.0 entry — wrong on purpose on its first attempt (the fix is missing),
 * so the reviewer (the until agent) sends it back with the missing commit
 * named, and complete on the second — and the reviewer passes it. So the run
 * exercises the agent-judged until: FAIL with a report, the retry with that
 * report in the prompt, PASS.
 *
 * Needs nothing but git (no network, no install).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT_ENV = { GIT_AUTHOR_NAME: 'Sandbox', GIT_AUTHOR_EMAIL: 'sandbox@example.invalid', GIT_COMMITTER_NAME: 'Sandbox', GIT_COMMITTER_EMAIL: 'sandbox@example.invalid' };

/** The commits after v1.0.0 (prepare makes them; the offline check of test/sandbox.test.js has no git and uses this list). */
const COMMITS = [
  { subject: 'feat: export items as CSV (#12)', group: 'Added', line: '商品一覧を CSV に書き出せるようになった (#12)' },
  { subject: 'fix: sign-in fails with a trailing space in the user name (#15)', group: 'Fixed', line: 'ユーザー名の末尾に空白があるとサインインに失敗する不具合を直した (#15)' },
  { subject: 'chore: bump eslint', group: null, line: null },
];

const CHANGELOG = `# Changelog

このプロジェクトの利用者から見える変更をここに書く（Keep a Changelog の形）。

## [1.0.0] - 2026-01-01

### Added

- 最初のリリース: サインインと商品一覧
`;

function gitIn(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The commits since the latest tag, from git when the worktree has a history, else the known list. */
function commitsOf(worktree) {
  const tag = gitIn(worktree, ['describe', '--tags', '--abbrev=0']);
  const out = tag == null ? null : gitIn(worktree, ['log', `${tag}..HEAD`, '--no-merges', '--format=%h%x09%s%x09%an']);
  if (out) return { since: tag, commits: out.split('\n').filter(Boolean).map((l) => { const [sha, subject, author] = l.split('\t'); return { sha, subject, author }; }) };
  return { since: 'v1.0.0', commits: COMMITS.map((c, i) => ({ sha: `000000${i}`, subject: c.subject, author: 'Sandbox' })) };
}

const known = (subject) => COMMITS.find((c) => c.subject === subject) || null;

module.exports = {
  description: 'a repository with a tag and three commits after it; the first draft misses the fix, the reviewer sends it back, the second is complete',
  workflowName: 'release-notes',
  files: {
    'CHANGELOG.md': CHANGELOG,
    'README.md': '# sandbox-app\n\nThe application the release-notes sandbox runs against.\n',
    'src/app.js': "'use strict';\nmodule.exports = { version: '1.0.0' };\n",
  },
  // The tag on the initial commit (the fixture made it), then the commits a release would gather.
  prepare() {
    return [
      { command: 'git', args: ['tag', 'v1.0.0'], env: GIT_ENV },
      ...COMMITS.map((c) => ({ command: 'git', args: ['commit', '-q', '--allow-empty', '-m', c.subject], env: GIT_ENV })),
    ];
  },
  spec: null,
  inputs: { version: '1.1.0' },

  /** The scripted agent: what a competent agent would leave after each step. */
  agent(ctx) {
    if (ctx.step === 'collect') {
      const { since, commits } = commitsOf(ctx.worktree);
      const groups = commits.map((c) => { const k = known(c.subject); return `- ${c.sha} ${c.subject}: ${k && k.group ? k.group : '外す（利用者に関係しない: 依存の更新）'}`; });
      return {
        notes: {
          'commits.md': `# Commits since ${since}\n\n${commits.map((c) => `- ${c.sha} ${c.subject} (${c.author})`).join('\n')}\n`,
          'groups.md': `# Groups\n\n${groups.join('\n')}\n`,
        },
        report: `since ${since}: ${commits.length} commit(s); ${commits.filter((c) => known(c.subject) && known(c.subject).group).length} user-visible, the rest to leave out`,
      };
    }
    if (ctx.step === 'draft' && ctx.role === 'agent') {
      const existing = fs.existsSync(path.join(ctx.worktree, 'CHANGELOG.md')) ? fs.readFileSync(path.join(ctx.worktree, 'CHANGELOG.md'), 'utf8') : '# Changelog\n';
      // The first attempt forgets the fix on purpose; the retry (told what is missing) writes everything.
      const include = COMMITS.filter((c) => c.group && (ctx.attempt > 1 || c.group !== 'Fixed'));
      const sections = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']
        .map((g) => ({ g, lines: include.filter((c) => c.group === g).map((c) => `- ${c.line}`) }))
        .filter((s) => s.lines.length)
        .map((s) => `### ${s.g}\n\n${s.lines.join('\n')}\n`).join('\n');
      const entry = `## [${ctx.inputs.version}] - ${new Date().toISOString().slice(0, 10)}\n\n${sections}`;
      const at = existing.indexOf('\n## [');
      const text = at < 0 ? `${existing.trimEnd()}\n\n${entry}` : `${existing.slice(0, at + 1)}${entry}\n${existing.slice(at + 1)}`;
      const left = COMMITS.filter((c) => !c.group).map((c) => `${c.subject}（利用者に関係しない依存の更新）`);
      return { files: { 'CHANGELOG.md': text }, report: `wrote ${include.length} line(s) under ## [${ctx.inputs.version}]; left out: ${left.join('; ')}${ctx.attempt > 1 ? ' (attempt ' + ctx.attempt + ': added what the reviewer named)' : ''}` };
    }
    if (ctx.step === 'draft' && ctx.role === 'until') {
      const text = fs.existsSync(path.join(ctx.worktree, 'CHANGELOG.md')) ? fs.readFileSync(path.join(ctx.worktree, 'CHANGELOG.md'), 'utf8') : '';
      const head = `## [${ctx.inputs.version}]`;
      const at = text.indexOf(head);
      const section = at < 0 ? '' : text.slice(at, text.indexOf('\n## [', at + 1) < 0 ? undefined : text.indexOf('\n## [', at + 1));
      const missing = COMMITS.filter((c) => c.group && !section.includes(c.line));
      if (at < 0) return { report: `CHANGELOG.md has no ${head} entry at the top.`, verdict: 'FAIL' };
      if (missing.length) return { report: `Not covered in ${head}: ${missing.map((c) => c.subject).join('; ')}. Add a line for each, or leave it out with a reason in the report.`, verdict: 'FAIL' };
      if (/eslint/i.test(section)) return { report: 'The chore commit (bump eslint) is internal work and does not belong in the entry.', verdict: 'FAIL' };
      return { report: `Every commit since the tag is covered or left out with a reason; ${head} is well-formed.`, verdict: 'PASS' };
    }
    return { report: `nothing to do for step ${ctx.step}` };
  },

  /** What this scenario expects beyond the common checks. */
  expect({ record, worktree, runDir, git, calls }) {
    const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
    const step = (id) => record.steps.find((s) => s.id === id);
    assert(fs.existsSync(path.join(runDir, 'notes', 'commits.md')), 'collect left notes/commits.md');
    const draft = step('draft');
    assert(draft && draft.attempts === 2, `draft passes on its second attempt (the first misses the fix), got ${draft && draft.attempts}`);
    const judges = calls.filter((c) => c.step === 'draft' && c.role === 'until').map((c) => c.verdict);
    assert(judges.join(',') === 'FAIL,PASS', `the reviewer failed the first draft and passed the second: ${JSON.stringify(judges)}`);
    const retried = calls.find((c) => c.step === 'draft' && c.role === 'agent' && c.attempt === 2);
    assert(retried && /## Previous attempt 1 of 3 failed/.test(retried.prompt) && /\(#15\)/.test(retried.prompt), 'the second attempt was told what the reviewer found (the missing fix commit)');
    assert(/VERDICT: PASS/.test(draft.review || ''), 'the reviewer passed the work');
    assert(git(['ls-files', 'CHANGELOG.md']) === 'CHANGELOG.md', 'CHANGELOG.md is committed on the trial branch');
    const text = fs.readFileSync(path.join(worktree, 'CHANGELOG.md'), 'utf8');
    const at = text.indexOf('## [1.1.0] - ');
    assert(at >= 0 && at < text.indexOf('## [1.0.0]'), 'the 1.1.0 entry sits above the 1.0.0 entry');
    const section = text.slice(at, text.indexOf('## [1.0.0]'));
    assert(/### Added\n\n- .*\(#12\)/.test(section) && /### Fixed\n\n- .*\(#15\)/.test(section), `the entry has the feature and the fix: ${section}`);
    assert(!/eslint/i.test(section), 'the chore is left out');
    assert(/^## \[1\.1\.0\] - \d{4}-\d{2}-\d{2}$/m.test(text), 'the heading carries an ISO date');
    assert(!git(['status', '--porcelain', '--', 'CHANGELOG.md']), 'nothing is left uncommitted');
  },
};
