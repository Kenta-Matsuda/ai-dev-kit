'use strict';
/** Ad-hoc end-to-end exercise of the CLI against a real fixture repo. */
const { makeRepo } = require('./fixtures');
const { execFileSync } = require('child_process');
const path = require('path');

const bin = path.resolve(__dirname, '..', 'cli', 'bin', 'aidev.js');
const fx = makeRepo();

function aidev(args) {
  try {
    const out = execFileSync(process.execPath, [bin, ...args], {
      cwd: fx.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

for (const args of [
  ['check', '--no-remote'],
  ['knowledge', 'status', '--no-remote'],
  ['plan', '--no-remote'],
  ['knowledge', 'build', '--dry-run'],
]) {
  const r = aidev(args);
  console.log(`\n===== aidev ${args.join(' ')} -> exit ${r.code} =====`);
  console.log(r.out.trim().split('\n').slice(0, 22).join('\n'));
}
fx.cleanup();
