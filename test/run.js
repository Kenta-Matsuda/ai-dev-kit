'use strict';
/**
 * Test entry point.
 *
 * Every declared suite must load. A missing suite used to be skipped silently,
 * which let the banner report unqualified success while a whole file was absent
 * — the failure mode a test runner exists to prevent.
 */
const { suite, summary } = require('./harness');

const suites = [
  './unit.test.js',
  './policy.test.js',
  './state.test.js',
  './inventory.test.js',
  './cli.test.js',
  './eject.test.js',
  './uninstall.test.js',
  './completion.test.js',
  './knowledge-agent.test.js',
  './agent.test.js',
  // Last: this one checks the kit's own shipped files rather than a fixture,
  // so a failure here means the repository is incomplete, not that logic broke.
  './assets.test.js',
];

let loaded = 0;
const broken = [];
for (const s of suites) {
  let mod;
  try {
    mod = require(s);
  } catch (e) {
    broken.push(`${s}: ${e && e.message ? e.message : e}`);
    continue;
  }
  if (!mod || typeof mod.run !== 'function') {
    broken.push(`${s}: does not export run()`);
    continue;
  }
  mod.run();
  loaded++;
}

suite(`done (${loaded}/${suites.length} suites)`);
const passed = summary();

if (broken.length > 0) {
  console.log('\nSuites that failed to load:');
  for (const b of broken) console.log(`  - ${b}`);
  process.exit(1);
}
process.exit(passed ? 0 : 1);
