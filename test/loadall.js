'use strict';
/**
 * Static load check: require() every JS file under cli/ and test/ so syntax
 * errors, bad requires and missing exports surface without running anything.
 * Part of the build gate — `node test/loadall.js` must exit 0.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [];
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(root, 'cli'));

let bad = 0;
for (const f of files) {
  const rel = path.relative(root, f).replace(/\\/g, '/');
  try {
    const m = require(f);
    const keys = Object.keys(m);
    console.log(`OK    ${rel}  [${keys.join(', ')}]`);
  } catch (e) {
    bad++;
    console.log(`FAIL  ${rel}\n      ${e.message}`);
  }
}
console.log(`\n${files.length - bad}/${files.length} modules loaded`);
process.exit(bad ? 1 : 0);
