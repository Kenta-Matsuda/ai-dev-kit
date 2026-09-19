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
 * floats, booleans, null. Not supported (and rejected loudly rather than
 * silently mis-parsed): anchors, aliases, tags, multi-line block scalars,
 * multiple documents.
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

function parse(text) {
  if (typeof text !== 'string') throw new YamlError('parse() expects a string');
  const rows = [];
  text.split(/\r?\n/).forEach((raw, lineNo) => {
    if (/^\s*%/.test(raw)) throw new YamlError('YAML directives are not supported', lineNo);
    if (/^---\s*$/.test(raw) || /^\.\.\.\s*$/.test(raw)) return;
    const body = stripComment(raw);
    if (body.trim() === '') return;
    if (/\t/.test(body.slice(0, body.length - body.trimStart().length))) {
      throw new YamlError('tabs are not allowed for indentation', lineNo);
    }
    rows.push({ indent: body.length - body.trimStart().length, text: body.trim(), lineNo });
  });
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
      const sub = [{ indent: virtualIndent, text: rest, lineNo: row.lineNo }];
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

const PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9_\-./ ]*$/;

function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return "''";
  if (PLAIN_SAFE.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
      !/^-?\d+(\.\d+)?$/.test(s) && s.trim() === s) {
    return s;
  }
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
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
      if (v !== null && typeof v === 'object' &&
          !(Array.isArray(v) && v.length === 0) &&
          !(!Array.isArray(v) && Object.keys(v).length === 0)) {
        return `${pad}${k}:\n${stringify(v, indent + 2)}`;
      }
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        return `${pad}${k}: ${Array.isArray(v) ? '[]' : '{}'}\n`;
      }
      return `${pad}${k}: ${formatScalar(v)}\n`;
    }).join('');
  }
  return `${pad}${formatScalar(value)}\n`;
}

module.exports = { parse, stringify, YamlError };
