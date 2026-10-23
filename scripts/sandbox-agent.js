#!/usr/bin/env node
'use strict';
/**
 * The scripted agent of `npm run sandbox` (scripts/sandbox-workflow.js).
 *
 * It stands in for the AI tool (through AIDEV_CLAUDE_BIN) while a standard
 * workflow runs in a sandbox package. It never thinks: for every start it
 * hands the step, the target, the attempt, the inputs and the prompt to the
 * scenario of the standard workflow (templates/workflows/<standard>/sandbox/
 * scenario.js, named by AIDEV_SANDBOX_SCENARIO), writes the files and notes
 * the scenario answers with, and prints the final message in the
 * stream-json shape the kit's claude adapter reads. So what a sandbox run
 * proves is the kit's side of the workflow — the YAML as shipped, the
 * commands it runs, the notes, the retries, the checkpoints, the pull-request
 * step — against real commands (npm, Playwright, …), not the quality of what
 * a real agent would write.
 *
 * Environment: AIDEV_WORKFLOW, AIDEV_WORKFLOW_STEP (`<id>` or `<id>:until`),
 * AIDEV_WORKFLOW_RUN and AIDEV_WORKFLOW_ITEM come from the runner;
 * AIDEV_SANDBOX_SCENARIO and AIDEV_SANDBOX_STATE (a JSON-lines file every
 * start appends its account to, read by the sandbox's checks) from the
 * sandbox. The prompt arrives on stdin, as it does for Claude Code.
 */

const fs = require('fs');
const path = require('path');

if (process.argv.includes('--version')) { process.stdout.write('sandbox-agent 0.0.0\n'); process.exit(0); }

function fail(message) {
  process.stderr.write(`sandbox-agent: ${message}\n`);
  process.exit(2);
}

const scenarioFile = process.env.AIDEV_SANDBOX_SCENARIO;
if (!scenarioFile) fail('AIDEV_SANDBOX_SCENARIO is not set');
let scenario;
try { scenario = require(path.resolve(scenarioFile)); } catch (e) { fail(`cannot load the scenario ${scenarioFile}: ${e.message}`); }

let prompt = '';
try { prompt = fs.readFileSync(0, 'utf8'); } catch { prompt = ''; }

/** The `## Inputs for this run` section of the prompt, as { name: value }. */
function inputsOf(text) {
  const out = {};
  const at = text.indexOf('## Inputs for this run');
  if (at < 0) return out;
  const lines = text.slice(at).split('\n').slice(1);
  let started = false;
  for (const line of lines) {
    const m = /^- ([a-z][a-z0-9_-]*): (.*)$/.exec(line);
    if (m) { out[m[1]] = m[2]; started = true; continue; }
    if (started && !line.trim()) break;
    if (line.startsWith('## ')) break;
  }
  return out;
}

const stepId = process.env.AIDEV_WORKFLOW_STEP || '';
const role = stepId.endsWith(':until') ? 'until' : 'agent';
const step = role === 'until' ? stepId.slice(0, -':until'.length) : stepId;
const previous = /## Previous attempt (\d+) of (\d+) failed/.exec(prompt);
const workflow = process.env.AIDEV_WORKFLOW || '';
const runId = process.env.AIDEV_WORKFLOW_RUN || '';
const ctx = {
  workflow, step, role, stepId,
  item: process.env.AIDEV_WORKFLOW_ITEM || null,
  attempt: previous ? Number(previous[1]) + 1 : 1,
  inputs: inputsOf(prompt),
  prompt,
  worktree: process.cwd(),
  notesDir: path.join(process.cwd(), '.aidev', 'workflows', workflow, 'runs', runId, 'notes'),
};

let answer;
try {
  answer = typeof scenario.agent === 'function' ? scenario.agent(ctx) : null;
} catch (e) {
  fail(`the scenario threw for step ${stepId}${ctx.item ? ` [${ctx.item}]` : ''} attempt ${ctx.attempt}: ${e.stack || e.message}`);
}
if (!answer || typeof answer !== 'object') fail(`the scenario answered nothing for step ${stepId}${ctx.item ? ` [${ctx.item}]` : ''} (role ${role})`);

const written = [];
const writeAll = (base, files) => {
  for (const [rel, text] of Object.entries(files || {})) {
    const full = path.join(base, ...String(rel).split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(text), 'utf8');
    written.push(path.relative(process.cwd(), full).split(path.sep).join('/'));
  }
};
writeAll(process.cwd(), answer.files);
writeAll(ctx.notesDir, answer.notes);

const report = String(answer.report == null ? `step ${step} done` : answer.report);
const result = answer.verdict ? `${report}\n\nVERDICT: ${answer.verdict}` : report;

if (process.env.AIDEV_SANDBOX_STATE) {
  const line = { stepId, step, role, item: ctx.item, attempt: ctx.attempt, written, verdict: answer.verdict || null, prompt };
  fs.appendFileSync(process.env.AIDEV_SANDBOX_STATE, `${JSON.stringify(line)}\n`, 'utf8');
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ type: 'system', subtype: 'init', session_id: 'sandbox' });
for (const rel of written) {
  out({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: `w-${written.indexOf(rel)}`, name: 'Write', input: { file_path: rel } }] } });
}
out({
  type: 'result', result, is_error: false, total_cost_usd: 0, session_id: 'sandbox', permission_denials: [],
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
