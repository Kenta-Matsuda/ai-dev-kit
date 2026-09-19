'use strict';
/** Tiny zero-dependency test harness (node --test is avoided for Node 18 parity). */

const results = { pass: 0, fail: 0, failures: [] };
let currentSuite = '';

function suite(name) { currentSuite = name; console.log(`\n── ${name}`); }

function test(name, fn) {
  try {
    fn();
    results.pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    results.fail++;
    results.failures.push({ suite: currentSuite, name, error: e });
    console.log(`  FAIL ${name}`);
    console.log(`       ${e && e.message ? e.message : e}`);
  }
}

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg || 'mismatch'}: expected ${b}, got ${a}`);
}

function ok(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy');
}

function throws(fn, re, msg) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (re && !re.test(String(e.message))) {
      throw new Error(`${msg || 'wrong error'}: ${e.message}`);
    }
  }
  if (!threw) throw new Error(msg || 'expected a throw');
}

function summary() {
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  passed: ${results.pass}   failed: ${results.fail}`);
  if (results.fail > 0) {
    console.log('\nFailures:');
    for (const f of results.failures) {
      console.log(`  - [${f.suite}] ${f.name}\n    ${f.error && f.error.stack ? f.error.stack.split('\n').slice(0, 3).join('\n    ') : f.error}`);
    }
  }
  return results.fail === 0;
}

module.exports = { suite, test, eq, ok, throws, summary, results };
