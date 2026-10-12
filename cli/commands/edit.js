'use strict';
/**
 * `aidev edit workflow <name>` — review and change a workflow in the browser.
 *
 * Starts the editor (`../lib/editor`) on 127.0.0.1, opens its page and waits
 * until the page is closed or Ctrl-C. The page draws the steps as a flow,
 * edits them in a form or as YAML, checks every change the way
 * `aidev run workflow` would, shows the estimate and what differs from the
 * approved copy, and saves only `.aidev/workflows/<name>/workflow.yaml`.
 * Saving does not approve: submit the change and have it merged.
 */

const { spawn } = require('child_process');
const { EXIT, AidevError } = require('../lib/errors');
const editor = require('../lib/editor');
const wfMod = require('../lib/workflow');
const ui = require('../lib/ui');

const FLAGS = { json: 'boolean', port: 'string', 'no-open': 'boolean' };
const FLAG_HELP = {
  json: 'print the address as JSON when the editor is listening (and when it stops)',
  port: 'listen on this port of 127.0.0.1 (default: any free port)',
  'no-open': 'do not open a browser; print the address to open by hand',
};

/** Open the address in the person's browser. The address has no characters a shell would read. */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => { /* printed below anyway */ });
    child.unref();
    return true;
  } catch { return false; }
}

async function run(ctx) {
  const { repoRoot, installRoot, flags, positionals } = ctx;
  if (positionals[0] !== 'workflow') throw new AidevError('aidev edit takes "workflow <name>"');
  if (!positionals[1]) throw new AidevError('aidev edit workflow needs a name');
  const name = wfMod.sanitizeName(positionals[1]);
  let port = 0;
  if (flags.port != null) {
    port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AidevError('--port must be a port number (1–65535)');
  }
  const saved = [];
  const ed = await editor.startEditor({ repoRoot, installRoot, name, port, onSave: (rel) => { saved.push(rel); if (!flags.json) ui.ok(`saved ${rel}`); } });
  const open = !flags['no-open'] && !process.env.AIDEV_NO_BROWSER;
  if (flags.json) ui.json({ ok: true, name, url: ed.url, port: ed.port, listening: true });
  else {
    ui.heading(`aidev edit workflow ${name}`);
    ui.info(`editor: ${ed.url}`);
    ui.dim(open ? '    opening it in your browser; if nothing opens, paste the address above' : '    open the address above in your browser');
    ui.dim('    the address carries a one-time key: do not share it. Ctrl-C (or "Close" on the page) stops the editor.');
  }
  if (open) openBrowser(ed.url);
  const stop = () => { ed.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await ed.closed;
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  if (flags.json) ui.json({ ok: true, name, listening: false, saved });
  else if (saved.length) {
    ui.ok(`editor closed; ${wfMod.defRel(name)} was saved`);
    ui.dim(`    next: git diff -- ${wfMod.defRel(name)}, then "aidev submit workflow ${name}" (it runs once the pull request is merged)`);
  } else ui.dim('    editor closed; nothing was saved');
  return EXIT.OK;
}

module.exports = { run, FLAGS, FLAG_HELP, openBrowser, summary: 'workflow をブラウザで図として確認・編集する（保存するのは workflow.yaml だけ）' };
