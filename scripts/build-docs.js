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
  'review',
  'maintain',
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

/**
 * Developer guide: the Markdown under docs/developer-guide becomes one HTML
 * page shaped like the Asciidoctor output (header, left TOC, sect0 per file,
 * sect1.. per heading), so the user guide stylesheet applies unchanged.
 * Links between the files (`architecture.md#…`) turn into in-page anchors;
 * a link whose target is missing fails the build.
 */
const DEV_SOURCE_ROOT = path.join(ROOT, 'docs', 'developer-guide');
const DEV_GUIDE = {
  lang: 'ja',
  output: path.join(OUTPUT_DIR, 'ai-dev-kit-developer-guide.html'),
  title: 'ai-dev-kit Developer Guide',
  files: [
    'README.md',
    'architecture.md',
    'cli-reference.md',
    'configuration-reference.md',
    'design-decisions.md',
    'implementation-status.md',
  ],
  proposalsDir: 'proposals',
};

function slugify(text) {
  // GitHub's heading anchors, so `file.md#fragment` links written for GitHub resolve here too.
  return text.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
}

function plainText(tokens) {
  return (tokens || []).map((t) => (t.tokens ? plainText(t.tokens) : t.text || '')).join('');
}

function developerSources() {
  const files = DEV_GUIDE.files.map((f) => path.join(DEV_SOURCE_ROOT, f));
  const dir = path.join(DEV_SOURCE_ROOT, DEV_GUIDE.proposalsDir);
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) files.push(path.join(dir, f));
  }
  for (const file of files) {
    if (!fs.existsSync(file)) fail(`developer guide file does not exist: ${relative(file)}`);
  }
  return files;
}

function docId(file) {
  const rel = path.relative(DEV_SOURCE_ROOT, file).split(path.sep).join('/').replace(/\.md$/, '');
  return slugify(rel.replace(/\//g, '-'));
}

async function convertDeveloperGuide(version) {
  const { Marked } = await import('marked');
  const files = developerSources();
  const ids = new Set();
  const links = [];
  let current = null;

  function uniqueId(base) {
    let id = base;
    for (let n = 1; ids.has(id); n += 1) id = `${base}-${n}`;
    ids.add(id);
    return id;
  }

  function rewriteHref(href) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href; // http:, mailto:, …
    const m = /^([^#]*)(?:#(.*))?$/.exec(href);
    const [, target, fragment] = m;
    let file = current;
    if (target) {
      if (!target.endsWith('.md')) return href;
      file = path.resolve(path.dirname(current), decodeURIComponent(target));
    }
    const rel = path.relative(DEV_SOURCE_ROOT, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return href;
    const anchor = fragment ? `${docId(file)}-${slugify(decodeURIComponent(fragment))}` : docId(file);
    links.push({ anchor, href, file: current });
    return `#${anchor}`;
  }

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      link(token) {
        const href = rewriteHref(token.href);
        if (href === token.href) return false;
        return `<a href="${href}">${this.parser.parseInline(token.tokens)}</a>`;
      },
      code(token) {
        if (token.lang !== 'mermaid') return false;
        const source = token.text.trim();
        if (!source) fail(`an empty mermaid block was found in ${relative(current)}`);
        return `<div class="mermaid-figure"><pre class="mermaid">${escapeHtml(source)}</pre></div>\n`;
      },
    },
  });

  const toc = [];
  const body = [];
  let mermaidBlocks = 0;

  for (const file of files) {
    current = file;
    const source = fs.readFileSync(file, 'utf8');
    mermaidBlocks += (source.match(/^```mermaid\s*$/gm) || []).length;
    const tokens = marked.lexer(source);
    const base = docId(file);
    const open = []; // heading depths of the open sect divs
    let pending = [];
    let part = null;

    const flush = () => {
      if (pending.length === 0) return;
      pending.links = tokens.links;
      body.push(marked.parser(pending));
      pending = [];
    };
    const closeTo = (depth) => {
      while (open.length > 0 && open[open.length - 1] >= depth) {
        const d = open.pop();
        body.push(d === 2 ? '</div>\n</div>\n' : '</div>\n');
      }
    };

    for (const token of tokens) {
      if (token.type !== 'heading') {
        pending.push(token);
        continue;
      }
      flush();
      const html = marked.parseInline(token.text);
      if (token.depth === 1 && !part) {
        if (ids.has(base)) fail(`duplicate document ID ${base} (${relative(file)})`);
        ids.add(base);
        part = { id: base, html, children: [] };
        toc.push(part);
        body.push(`<h1 id="${base}" class="sect0"><a class="anchor" href="#${base}"></a><a class="link" href="#${base}">${html}</a></h1>\n`);
        continue;
      }
      if (!part) fail(`${relative(file)} must start with a "# " title`);
      const depth = Math.max(2, Math.min(token.depth, 6));
      closeTo(depth);
      const id = uniqueId(`${base}-${slugify(plainText(token.tokens))}`);
      const level = depth - 1;
      body.push(`<div class="sect${level}">\n<h${depth} id="${id}"><a class="anchor" href="#${id}"></a><a class="link" href="#${id}">${html}</a></h${depth}>\n`);
      if (depth === 2) body.push('<div class="sectionbody">\n');
      open.push(depth);
      if (depth === 2) part.children.push({ id, html, children: [] });
      else if (depth === 3 && part.children.length > 0) part.children[part.children.length - 1].children.push({ id, html });
    }
    flush();
    closeTo(0);
    if (!part) fail(`${relative(file)} has no "# " title`);
  }

  for (const link of links) {
    if (!ids.has(link.anchor)) fail(`unresolved link "${link.href}" in ${relative(link.file)}`);
  }

  const tocHtml = ['<ul class="sectlevel0">'];
  for (const p of toc) {
    tocHtml.push(`<li><a href="#${p.id}">${p.html}</a>`);
    if (p.children.length > 0) {
      tocHtml.push('<ul class="sectlevel1">');
      for (const c of p.children) {
        tocHtml.push(`<li><a href="#${c.id}">${c.html}</a>`);
        if (c.children.length > 0) {
          tocHtml.push('<ul class="sectlevel2">');
          for (const g of c.children) tocHtml.push(`<li><a href="#${g.id}">${g.html}</a></li>`);
          tocHtml.push('</ul>');
        }
        tocHtml.push('</li>');
      }
      tocHtml.push('</ul>');
    }
    tocHtml.push('</li>');
  }
  tocHtml.push('</ul>');

  const content = body.join('')
    .replace(/<table>/g, '<table class="tableblock frame-ends grid-rows stripes-even stretch">');
  const css = fs.readFileSync(path.join(STYLES_DIR, 'user-guide.css'), 'utf8');
  let html = `<!DOCTYPE html>
<html lang="${DEV_GUIDE.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="ai-dev-kit 本体（CLI・template・同梱 Agents / Skills）を設計・実装・レビューする人のための資料">
<title>${DEV_GUIDE.title}</title>
<style>
${css}
</style>
</head>
<body class="book toc2 toc-left">
<div id="header">
<h1>${DEV_GUIDE.title}</h1>
<div class="details">
<span id="revnumber">version ${escapeHtml(version)}</span>
</div>
<div id="toc" class="toc2">
<div id="toctitle">目次</div>
${tocHtml.join('\n')}
</div>
</div>
<div id="content">
${content}
</div>
<div id="footer">
<div id="footer-text">
Version ${escapeHtml(version)}<br>
</div>
</div>
</body>
</html>
`;
  if (html.includes('<pre class="mermaid">')) {
    const at = html.lastIndexOf('</body>');
    html = `${html.slice(0, at)}${mermaidScript()}${html.slice(at)}`;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(DEV_GUIDE.output, html);
  return { files, ids, mermaidBlocks, html };
}

function validateDeveloperHtml({ ids, mermaidBlocks, html }) {
  const rendered = (html.match(/<pre class="mermaid">/g) || []).length;
  if (rendered !== mermaidBlocks) {
    fail(`developer guide: ${mermaidBlocks} mermaid block(s) in the sources but ${rendered} rendered`);
  }
  for (const f of DEV_GUIDE.files) {
    const id = docId(path.join(DEV_SOURCE_ROOT, f));
    if (!html.includes(`id="${id}"`)) fail(`developer guide: generated HTML is missing ${f}`);
  }
  if (/<(?:link|script)\b[^>]+(?:href|src)=["']https?:/i.test(html)) {
    fail('developer guide: generated HTML depends on an external stylesheet or script');
  }
  if (ids.size < DEV_GUIDE.files.length) fail(`developer guide: only ${ids.size} IDs were found`);
  return Buffer.byteLength(html);
}

async function main() {
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

  // The developer guide is Japanese only, so --lang en skips it.
  if (!ONLY_LANG || ONLY_LANG === DEV_GUIDE.lang) {
    const result = await convertDeveloperGuide(packageJson.version);
    const bytes = validateDeveloperHtml(result);
    process.stdout.write(
      `${action} ${relative(DEV_GUIDE.output)} (developer: ${result.files.length} Markdown files, ${result.ids.size} IDs, ${bytes} bytes)\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : String(error)}\n`);
  process.exitCode = 1;
});



