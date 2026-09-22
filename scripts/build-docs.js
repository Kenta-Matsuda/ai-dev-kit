#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const createAsciidoctor = require('@asciidoctor/core');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'docs', 'user-guide');
const OUTPUT_DIR = path.join(ROOT, 'build', 'docs');
const STYLES_DIR = path.join(SOURCE_ROOT, 'assets');

const ARGS = process.argv.slice(2);
const CHECK_MODE = ARGS.includes('--check');
const LANG_INDEX = ARGS.indexOf('--lang');
const ONLY_LANG = LANG_INDEX === -1 ? null : ARGS[LANG_INDEX + 1];
const UNKNOWN_ARGS = ARGS.filter((arg, i) => arg !== '--check' && arg !== '--lang' && i !== LANG_INDEX + 1);

/**
 * One guide per language. Both share the stylesheet, the chapter IDs and the
 * layout, so the same validation runs on each.
 */
const LANGUAGES = [
  {
    lang: 'ja',
    entry: path.join(SOURCE_ROOT, 'index.adoc'),
    output: path.join(OUTPUT_DIR, 'ai-dev-kit-user-guide.html'),
    fragments: ['ai-dev-kit とは', 'コマンドリファレンス'],
  },
  {
    lang: 'en',
    entry: path.join(SOURCE_ROOT, 'index-en.adoc'),
    output: path.join(OUTPUT_DIR, 'ai-dev-kit-user-guide.en.html'),
    fragments: ['What ai-dev-kit is', 'Command Reference'],
  },
];

const REQUIRED_IDS = [
  // User Guide
  'overview',
  'install',
  'setup-owner',
  'setup-member',
  'daily',
  'knowledge',
  'configuration',
  'permissions',
  'automation',
  'troubleshooting',
  'workflows',
  // Command Reference: one page per command
  'cli-reference',
  'cli-init',
  'cli-check',
  'cli-run',
  'cli-create',
  'cli-submit',
  'cli-list',
  'cli-remove',
  'cli-sync',
  'cli-sync-tools',
  'cli-sync-wiki',
  'cli-sync-wiki-publish',
  'cli-update',
  'cli-doctor',
  'cli-uninstall',
  'cli-hook',
  // Appendices
  'environment-reference',
  'files-and-state',
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
  // Asciidoctor.js hands over either a string or an object {text, source_location}.
  const raw = entry.message ?? (typeof entry.getMessage === 'function' ? entry.getMessage() : entry);
  let message;
  if (typeof raw === 'string') message = raw;
  else if (raw && typeof raw === 'object') {
    const text = raw.text || raw.message || JSON.stringify(raw);
    const where = raw.source_location ? ` (${String(raw.source_location)})` : '';
    message = `${text}${where}`;
  } else message = String(raw);
  return `${severity}: ${message}`;
}

/**
 * Diagrams are written as Mermaid source in the AsciiDoc:
 *
 *   [mermaid]
 *   ----
 *   flowchart LR
 *     a --> b
 *   ----
 *
 * The block becomes `<pre class="mermaid">` and the generated HTML carries
 * mermaid.min.js inline (from the dev dependency), so the page renders the
 * diagrams offline without any external script — the same single-file rule
 * the stylesheet follows. The block counts on both sides are compared in
 * validateHtml so a block that failed to convert does not pass silently.
 */
const MERMAID_BUNDLE = path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js');
const MERMAID_BLOCK = /^\[mermaid(?:,[^\]]*)?\]\s*$/gm;

function escapeHtml(text) {
  // `>` stays: Mermaid arrows need it and it is legal in HTML text. `<` and `&`
  // would start a tag or an entity, so those two are escaped.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function mermaidExtensions(asciidoctor) {
  const registry = asciidoctor.Extensions.create();
  registry.block(function block() {
    this.named('mermaid');
    this.onContexts(['listing', 'literal', 'open', 'paragraph']);
    this.parseContentAs('raw');
    this.process((parent, reader, attrs) => {
      const source = reader.getLines().join('\n').trim();
      if (!source) fail('an empty [mermaid] block was found');
      const title = attrs.title ? `<div class="title">${escapeHtml(String(attrs.title))}</div>` : '';
      const html = `<div class="mermaid-figure">${title}<pre class="mermaid">${escapeHtml(source)}</pre></div>`;
      return this.createBlock(parent, 'pass', html, { role: 'mermaid-figure' });
    });
  });
  return registry;
}

function mermaidScript() {
  if (!fs.existsSync(MERMAID_BUNDLE)) {
    fail(`mermaid bundle is missing: ${relative(MERMAID_BUNDLE)} (run "npm ci")`);
  }
  const bundle = fs.readFileSync(MERMAID_BUNDLE, 'utf8');
  if (bundle.includes('</script')) fail('the mermaid bundle cannot be inlined as-is');
  const init = 'mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "strict", '
    + 'fontFamily: "inherit", flowchart: { htmlLabels: true, curve: "basis", wrappingWidth: 320 }, '
    + 'sequence: { mirrorActors: false, wrap: true, width: 200 } });';
  return `\n<script>${bundle}</script>\n<script>${init}</script>\n`;
}

function countMermaidBlocks(files) {
  let n = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    n += (source.match(MERMAID_BLOCK) || []).length;
  }
  return n;
}

function convert(guide, version) {
  const asciidoctor = createAsciidoctor();
  let memoryLogger = null;

  if (asciidoctor.MemoryLogger && asciidoctor.LoggerManager) {
    memoryLogger = asciidoctor.MemoryLogger.create();
    asciidoctor.LoggerManager.setLogger(memoryLogger);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  asciidoctor.convertFile(guide.entry, {
    backend: 'html5',
    doctype: 'book',
    safe: 'safe',
    // No base_dir on purpose: safe mode then confines reads to the entry file's
    // directory (docs/user-guide), which holds both languages and assets/.
    standalone: true,
    mkdirs: true,
    to_file: guide.output,
    extension_registry: mermaidExtensions(asciidoctor),
    attributes: {
      'aidev-version': version,
      revnumber: version,
      reproducible: '',
      stylesdir: STYLES_DIR,
      stylesheet: 'user-guide.css',
    },
  });

  // Inline the renderer only when the guide has a diagram.
  const html = fs.readFileSync(guide.output, 'utf8');
  if (html.includes('<pre class="mermaid">')) {
    const at = html.lastIndexOf('</body>');
    if (at === -1) fail(`${guide.lang}: generated HTML has no </body>`);
    fs.writeFileSync(guide.output, `${html.slice(0, at)}${mermaidScript()}${html.slice(at)}`);
  }

  if (memoryLogger) {
    const diagnostics = memoryLogger.getMessages()
      .map(formatLogMessage)
      .filter((message) => /^(?:WARN|ERROR|FATAL):/i.test(message));
    if (diagnostics.length > 0) {
      fail(`Asciidoctor reported diagnostics for ${guide.lang}:\n${diagnostics.join('\n')}`);
    }
  }
}

function validateHtml(guide, ids, files) {
  if (!fs.existsSync(guide.output)) fail(`output was not created: ${relative(guide.output)}`);
  const stat = fs.statSync(guide.output);
  const html = fs.readFileSync(guide.output, 'utf8');

  const expectedDiagrams = countMermaidBlocks(files);
  const renderedDiagrams = (html.match(/<pre class="mermaid">/g) || []).length;
  if (expectedDiagrams !== renderedDiagrams) {
    fail(`${guide.lang}: ${expectedDiagrams} [mermaid] block(s) in the sources but ${renderedDiagrams} rendered`);
  }
  if (expectedDiagrams > 0 && !html.includes('mermaid.initialize(')) {
    fail(`${guide.lang}: diagrams are present but the Mermaid renderer was not inlined`);
  }

  if (stat.size < 100000) {
    fail(`${guide.lang}: output is unexpectedly small (${stat.size} bytes)`);
  }

  const requiredFragments = [
    '<title>ai-dev-kit User Guide</title>',
    'id="toc" class="toc2"',
    '--nav-width:',
    ...guide.fragments,
  ];
  for (const fragment of requiredFragments) {
    if (!html.includes(fragment)) fail(`${guide.lang}: generated HTML is missing: ${fragment}`);
  }

  for (const id of ids.keys()) {
    if (!html.includes(`id="${id}"`)) fail(`${guide.lang}: generated HTML is missing explicit section ID: ${id}`);
  }

  if (html.includes('include::chapters/') || html.includes('include::appendices/')) {
    fail(`${guide.lang}: generated HTML contains an unexpanded include directive`);
  }
  if (/<(?:link|script)\b[^>]+(?:href|src)=["']https?:/i.test(html)) {
    fail(`${guide.lang}: generated HTML depends on an external stylesheet or script`);
  }
  if (ids.size < REQUIRED_IDS.length) {
    fail(`${guide.lang}: only ${ids.size} explicit IDs were found`);
  }

  return stat.size;
}

function main() {
  if (UNKNOWN_ARGS.length > 0) fail(`unknown argument(s): ${UNKNOWN_ARGS.join(', ')}`);
  const guides = ONLY_LANG ? LANGUAGES.filter((g) => g.lang === ONLY_LANG) : LANGUAGES;
  if (guides.length === 0) fail(`unknown language: ${ONLY_LANG} (expected: ${LANGUAGES.map((g) => g.lang).join(', ')})`);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const action = CHECK_MODE ? 'Validated' : 'Built';

  for (const guide of guides) {
    const files = collectSources(guide.entry);
    const ids = validateSources(files);
    convert(guide, packageJson.version);
    const bytes = validateHtml(guide, ids, files);
    process.stdout.write(
      `${action} ${relative(guide.output)} (${guide.lang}: ${files.length} AsciiDoc files, ${ids.size} IDs, ${bytes} bytes)\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
}



