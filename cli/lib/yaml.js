'use strict';
/**
 * Minimal YAML subset parser/serializer.
 *
 * Zero dependencies by design: the CLI is bootstrapped inside corporate
 * networks where `npm install` may be unavailable, and `aidev.yaml` /
 * `.aidev/policy.yaml` are the only YAML we ever read.
 *
 * Supported: nested block maps (indentation), block sequences, inline flow
 * sequences/maps, `#` comments, single/double quoted scalars, integers,
 * floats, booleans, null, and block scalars (`key: |` / `key: >`, with `-`
 * to strip the final newline) for the prose in a workflow definition. Not
 * supported (and rejected loudly rather than silently mis-parsed): anchors,
 * aliases, tags, multiple documents.
 */

class YamlError extends Error {
  constructor(message, line) {
    super(line != null ? `${message} (line ${line + 1})` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/** Strip a trailing `#` comment that is not inside a quoted scalar. */
function stripComment(raw) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\' && inDouble) { i++; continue; }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      // A `#` only starts a comment at line start or after whitespace.
      if (i === 0 || /\s/.test(raw[i - 1])) return raw.slice(0, i);
    }
  }
  return raw;
}

function unquote(s, lineNo) {
  const q = s[0];
  if (s.length < 2 || s[s.length - 1] !== q) {
    throw new YamlError(`unterminated quoted scalar: ${s}`, lineNo);
  }
  const body = s.slice(1, -1);
  if (q === "'") return body.replace(/''/g, "'");
  return body.replace(/\\(["\\/nrt])/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 'r') return '\r';
    if (c === 't') return '\t';
    return c;
  });
}

/** Split a flow collection body on commas at depth 0, respecting quotes. */
function splitFlow(body, lineNo) {
  const parts = [];
  let depth = 0;
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && inDouble) { cur += c + (body[++i] || ''); continue; }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (inSingle || inDouble) throw new YamlError('unterminated quote in flow collection', lineNo);
  if (depth !== 0) throw new YamlError('unbalanced brackets in flow collection', lineNo);
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function parseScalar(token, lineNo) {
  const s = token.trim();
  if (s === '') return null;
  if (s[0] === '"' || s[0] === "'") return unquote(s, lineNo);
  if (s[0] === '[') {
    if (s[s.length - 1] !== ']') throw new YamlError('unterminated flow sequence', lineNo);
    return splitFlow(s.slice(1, -1), lineNo).map((p) => parseScalar(p, lineNo));
  }
  if (s[0] === '{') {
    if (s[s.length - 1] !== '}') throw new YamlError('unterminated flow mapping', lineNo);
    const out = {};
    for (const part of splitFlow(s.slice(1, -1), lineNo)) {
      const idx = splitKey(part);
      if (idx < 0) throw new YamlError(`expected key: value in flow mapping: ${part}`, lineNo);
      const k = part.slice(0, idx).trim();
      out[k[0] === '"' || k[0] === "'" ? unquote(k, lineNo) : k] =
        parseScalar(part.slice(idx + 1), lineNo);
    }
    return out;
  }
  if (s === 'true' || s === 'True') return true;
  if (s === 'false' || s === 'False') return false;
  if (s === 'null' || s === '~' || s === 'Null') return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

/** Index of the `:` separating key from value, ignoring quoted regions. */
function splitKey(line) {
  let inSingle = false;
  let inDouble = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && inDouble) { i++; continue; }
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) {
        if (i + 1 >= line.length || /\s/.test(line[i + 1])) return i;
      }
    }
  }
  return -1;
}

/** Fold a `>` block: lines of a paragraph join with spaces, blank lines separate paragraphs. */
function foldLines(lines) {
  const paragraphs = [];
  let cur = [];
  for (const l of lines) {
    if (l === '') { if (cur.length) { paragraphs.push(cur.join(' ')); cur = []; } }
    else cur.push(l.trim());
  }
  if (cur.length) paragraphs.push(cur.join(' '));
  return paragraphs.join('\n');
}

/**
 * Collect the lines of a block scalar that starts after `lines[start]`
 * (the `key: |` row at `indent`). Content lines are the ones indented deeper
 * than the key; blank lines belong to the block. Returns { value, next }.
 */
function readBlockScalar(lines, start, indent, style, chomp) {
  const content = [];
  let blockIndent = null;
  let j = start + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.trim() === '') { content.push(''); j++; continue; }
    const ind = l.length - l.trimStart().length;
    if (blockIndent == null) {
      if (ind <= indent) break;
      blockIndent = ind;
    }
    if (ind < blockIndent) break;
    content.push(l.slice(blockIndent));
    j++;
  }
  while (content.length && content[content.length - 1] === '') content.pop();
  let value = style === '|' ? content.join('\n') : foldLines(content);
  if (chomp !== '-' && value !== '') value += '\n';
  return { value, next: j };
}

function parse(text) {
  if (typeof text !== 'string') throw new YamlError('parse() expects a string');
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const raw = lines[lineNo];
    if (/^\s*%/.test(raw)) throw new YamlError('YAML directives are not supported', lineNo);
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) continue;
    const body = stripComment(raw);
    if (body.trim() === '') continue;
    const indent = body.length - body.trimStart().length;
    if (/\t/.test(body.slice(0, indent))) {
      throw new YamlError('tabs are not allowed for indentation', lineNo);
    }
    const trimmed = body.trim();
    // `key: |` / `key: >` (also `- key: |`): the scalar is the deeper-indented
    // lines that follow, taken verbatim — comments and blanks included.
    const block = /^((?:- )?[^\s#][^:]*:)\s*([|>])([+-]?)$/.exec(trimmed);
    if (block) {
      const { value, next } = readBlockScalar(lines, lineNo, indent, block[2], block[3]);
      rows.push({ indent, text: block[1], lineNo, block: value });
      lineNo = next - 1;
      continue;
    }
    rows.push({ indent, text: trimmed, lineNo });
  }
  if (rows.length === 0) return {};
  const [value, next] = parseBlock(rows, 0, rows[0].indent);
  if (next < rows.length) throw new YamlError('unexpected trailing content', rows[next].lineNo);
  return value;
}

function parseBlock(rows, i, indent) {
  if (rows[i].text.startsWith('- ') || rows[i].text === '-') return parseSeq(rows, i, indent);
  return parseMap(rows, i, indent);
}

function parseSeq(rows, i, indent) {
  const out = [];
  while (i < rows.length && rows[i].indent === indent) {
    const row = rows[i];
    if (row.text !== '-' && !row.text.startsWith('- ')) break;
    const rest = row.text === '-' ? '' : row.text.slice(2).trim();
    if (rest === '') {
      // Nested collection on following lines.
      if (i + 1 < rows.length && rows[i + 1].indent > indent) {
        const [v, n] = parseBlock(rows, i + 1, rows[i + 1].indent);
        out.push(v); i = n;
      } else { out.push(null); i++; }
      continue;
    }
    const keyIdx = splitKey(rest);
    if (keyIdx >= 0) {
      // `- key: value` — an inline map that may continue on deeper lines.
      const virtualIndent = indent + 2;
      const sub = [{ indent: virtualIndent, text: rest, lineNo: row.lineNo, ...(row.block !== undefined ? { block: row.block } : {}) }];
      let j = i + 1;
      while (j < rows.length && rows[j].indent >= virtualIndent) { sub.push(rows[j]); j++; }
      const [v, n] = parseMap(sub, 0, virtualIndent);
      if (n < sub.length) throw new YamlError('unexpected content in sequence item', sub[n].lineNo);
      out.push(v); i = j;
      continue;
    }
    out.push(parseScalar(rest, row.lineNo));
    i++;
  }
  return [out, i];
}

function parseMap(rows, i, indent) {
  const out = {};
  while (i < rows.length && rows[i].indent === indent) {
    const row = rows[i];
    if (row.text.startsWith('- ')) break;
    const keyIdx = splitKey(row.text);
    if (keyIdx < 0) throw new YamlError(`expected "key: value": ${row.text}`, row.lineNo);
    let key = row.text.slice(0, keyIdx).trim();
    if (key[0] === '"' || key[0] === "'") key = unquote(key, row.lineNo);
    const rest = row.text.slice(keyIdx + 1).trim();
    if (row.block !== undefined) {
      out[key] = row.block;
      i++;
      continue;
    }
    if (rest !== '') {
      out[key] = parseScalar(rest, row.lineNo);
      i++;
      continue;
    }
    if (i + 1 < rows.length && rows[i + 1].indent > indent) {
      const [v, n] = parseBlock(rows, i + 1, rows[i + 1].indent);
      out[key] = v; i = n;
    } else if (
      i + 1 < rows.length && rows[i + 1].indent === indent &&
      (rows[i + 1].text === '-' || rows[i + 1].text.startsWith('- '))
    ) {
      // Sequence written at the same indent as its parent key (common style).
      const [v, n] = parseSeq(rows, i + 1, indent);
      out[key] = v; i = n;
    } else {
      out[key] = null; i++;
    }
  }
  return [out, i];
}

/**
 * A string that reads back as itself without quotes: one line, no
 * surrounding space, no character that opens something else at its start
 * (a sequence, a flow collection, a quote, a comment, an anchor, a block),
 * no `: ` or ` #` inside, and nothing that reads as a number, a boolean or
 * null. In a flow list (`[a, b]`) the separators are not allowed either.
 */
function plainSafe(s, inFlow = false) {
  if (!s || s.trim() !== s || /[\n\r\t\0]/.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/: |:$| #/.test(s)) return false;
  if (inFlow && /[,[\]{}'"]/.test(s)) return false;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s) || /^-?\d+(\.\d+)?$/.test(s) || /^-?\d*\.\d+$/.test(s)) return false;
  return true;
}

function formatScalar(v, inFlow = false) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return "''";
  if (plainSafe(s, inFlow)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

/** A short list of scalars, written on one line: `[src/**, docs/**]`. Null when it would not fit. */
function flowList(v) {
  if (!Array.isArray(v) || !v.length || v.some((x) => x !== null && typeof x === 'object')) return null;
  const line = `[${v.map((x) => formatScalar(x, true)).join(', ')}]`;
  return line.length <= 72 ? line : null;
}

/**
 * A multi-line string that reads back the same as a `|` block: its first
 * line is not indented (that would set the block's indent), no line ends in
 * spaces, and it ends in at most one newline.
 */
function blockSafe(v) {
  return typeof v === 'string' && v.includes('\n') && !/^\s/.test(v) && !/\n\n$/.test(v)
    && !/[ \t]\n/.test(v) && !/[ \t]$/.test(v) && !/\r/.test(v);
}

function stringify(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    return value.map((v) => {
      if (v !== null && typeof v === 'object') {
        const body = stringify(v, indent + 2);
        return `${pad}-${body.slice(indent + 1)}`;
      }
      return `${pad}- ${formatScalar(v)}\n`;
    }).join('');
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}\n`;
    return keys.map((k) => {
      const v = value[k];
      const flow = flowList(v);
      if (flow) return `${pad}${k}: ${flow}\n`;
      if (v !== null && typeof v === 'object' &&
          !(Array.isArray(v) && v.length === 0) &&
          !(!Array.isArray(v) && Object.keys(v).length === 0)) {
        return `${pad}${k}:\n${stringify(v, indent + 2)}`;
      }
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        return `${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}\n`;
      }
      if (blockSafe(v)) {
        const body = v.replace(/\n$/, '').split('\n').map((l) => (l ? `${pad}  ${l}` : '')).join('\n');
        return `${pad}${k}: |${v.endsWith('\n') ? '' : '-'}\n${body}\n`;
      }
      return `${pad}${k}: ${formatScalar(v)}\n`;
    }).join('');
  }
  return `${pad}${formatScalar(value)}\n`;
}

module.exports = { parse, stringify, YamlError };
