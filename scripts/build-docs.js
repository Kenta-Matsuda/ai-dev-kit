#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createAsciidoctor = require('@asciidoctor/core');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'docs', 'user-guide');
const ENTRY = path.join(SOURCE_ROOT, 'index.adoc');
const OUTPUT_DIR = path.join(ROOT, 'build', 'docs');
const OUTPUT = path.join(OUTPUT_DIR, 'ai-dev-kit-user-guide.html');
const CHECK_MODE = process.argv.includes('--check');
const UNKNOWN_ARGS = process.argv.slice(2).filter((arg) => arg !== '--check');

const REQUIRED_IDS = [
  'overview',
  'concepts',
  'getting-started',
  'configuration',
  'operations',
  'knowledge',
  'security',
  'integrations',
  'cli-reference',
  'automation',
  'files-and-state',
  'troubleshooting',
  'maintenance',
  'environment-reference',
  'implementation-status',
  'document-build',
];

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function fail(message) {
  throw new Error(`documentation build failed: ${message}`);
}

function assertInsideSourceRoot(file, referencedBy) {
  const rel = path.relative(SOURCE_ROOT, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail(`${relative(referencedBy)} includes a file outside docs/user-guide: ${file}`);
  }
}

function collectSources(entry) {
  const files = [];
  const visited = new Set();
  const active = new Set();

  function visit(file) {
    const resolved = path.resolve(file);
    assertInsideSourceRoot(resolved, file);
    if (active.has(resolved)) fail(`circular include detected at ${relative(resolved)}`);
    if (visited.has(resolved)) return;
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      fail(`included file does not exist: ${relative(resolved)}`);
    }

    visited.add(resolved);
    active.add(resolved);
    files.push(resolved);

    const source = fs.readFileSync(resolved, 'utf8');
    const includePattern = /^\s*include::([^\[]+)\[[^\]]*\]\s*$/gm;
    let match;
    while ((match = includePattern.exec(source)) !== null) {
      const target = match[1].trim();
      if (target.includes('{') || target.includes('}')) {
        fail(`dynamic include paths are not allowed: ${target} in ${relative(resolved)}`);
      }
      const included = path.resolve(path.dirname(resolved), target);
      assertInsideSourceRoot(included, resolved);
      visit(included);
    }

    active.delete(resolved);
  }

  visit(entry);
  return files;
}

function validateSources(files) {
  const ids = new Map();
  const xrefs = [];
  const unfinishedLine = /^\s*(?:TODO|TBD|FIXME)(?:\s*[:：-].*)?\s*$/i;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (unfinishedLine.test(line)) {
        fail(`unfinished placeholder in ${relative(file)}:${index + 1}`);
      }
    });

    const idPattern = /^\s*\[\[([A-Za-z0-9_.:-]+)\]\]\s*$/gm;
    let idMatch;
    while ((idMatch = idPattern.exec(source)) !== null) {
      const id = idMatch[1];
      if (ids.has(id)) {
        fail(`duplicate explicit ID "${id}" in ${relative(ids.get(id))} and ${relative(file)}`);
      }
      ids.set(id, file);
    }

    const xrefPattern = /xref:([A-Za-z0-9_.:-]+)\[[^\]]*\]/g;
    let xrefMatch;
    while ((xrefMatch = xrefPattern.exec(source)) !== null) {
      xrefs.push({ id: xrefMatch[1], file });
    }
  }

  for (const required of REQUIRED_IDS) {
    if (!ids.has(required)) fail(`required chapter ID is missing: ${required}`);
  }
  for (const xref of xrefs) {
    if (!ids.has(xref.id)) {
      fail(`unresolved xref "${xref.id}" in ${relative(xref.file)}`);
    }
  }

  return ids;
}

function formatLogMessage(entry) {
  const severity = String(
    entry.severity || (typeof entry.getSeverity === 'function' ? entry.getSeverity() : 'WARN'),
  );
  const message = String(
    entry.message || (typeof entry.getMessage === 'function' ? entry.getMessage() : entry),
  );
  return `${severity}: ${message}`;
}

function convert() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const asciidoctor = createAsciidoctor();
  let memoryLogger = null;

  if (asciidoctor.MemoryLogger && asciidoctor.LoggerManager) {
    memoryLogger = asciidoctor.MemoryLogger.create();
    asciidoctor.LoggerManager.setLogger(memoryLogger);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  asciidoctor.convertFile(ENTRY, {
    backend: 'html5',
    doctype: 'book',
    safe: 'safe',
    standalone: true,
    mkdirs: true,
    to_file: OUTPUT,
    attributes: {
      'aidev-version': packageJson.version,
      revnumber: packageJson.version,
      reproducible: '',
    },
  });

  if (memoryLogger) {
    const diagnostics = memoryLogger.getMessages()
      .map(formatLogMessage)
      .filter((message) => /^(?:WARN|ERROR|FATAL):/i.test(message));
    if (diagnostics.length > 0) {
      fail(`Asciidoctor reported diagnostics:\n${diagnostics.join('\n')}`);
    }
  }
}

function validateHtml(ids) {
  if (!fs.existsSync(OUTPUT)) fail(`output was not created: ${relative(OUTPUT)}`);
  const stat = fs.statSync(OUTPUT);
  const html = fs.readFileSync(OUTPUT, 'utf8');

  if (stat.size < 100000) {
    fail(`output is unexpectedly small (${stat.size} bytes)`);
  }

  const requiredFragments = [
    '<title>ai-dev-kit User Guide</title>',
    'id="toc" class="toc2"',
    '--nav-width:',
    '導入によって得られるもの',
  ];
  for (const fragment of requiredFragments) {
    if (!html.includes(fragment)) fail(`generated HTML is missing: ${fragment}`);
  }

  for (const id of ids.keys()) {
    if (!html.includes(`id="${id}"`)) fail(`generated HTML is missing explicit section ID: ${id}`);
  }

  if (html.includes('include::chapters/') || html.includes('include::appendices/')) {
    fail('generated HTML contains an unexpanded include directive');
  }
  if (/<(?:link|script)\b[^>]+(?:href|src)=["']https?:/i.test(html)) {
    fail('generated HTML depends on an external stylesheet or script');
  }
  if (ids.size < REQUIRED_IDS.length) {
    fail(`only ${ids.size} explicit IDs were found`);
  }

  return stat.size;
}

function main() {
  if (UNKNOWN_ARGS.length > 0) fail(`unknown argument(s): ${UNKNOWN_ARGS.join(', ')}`);
  const files = collectSources(ENTRY);
  const ids = validateSources(files);
  convert();
  const bytes = validateHtml(ids);
  const action = CHECK_MODE ? 'Validated' : 'Built';
  process.stdout.write(
    `${action} ${relative(OUTPUT)} (${files.length} AsciiDoc files, ${ids.size} IDs, ${bytes} bytes)\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
