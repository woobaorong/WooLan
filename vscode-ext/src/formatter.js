// formatter.js - Token-based formatter for Woolan.
//
// Re-emits the token stream (comments preserved) with:
//   - 4-space indentation driven by { } nesting
//   - '{' always ends a line, '}' always starts a line (so } else { stays together)
//   - normalized spacing around operators / punctuation
//   - one statement per line; up to one blank line preserved between statements

'use strict';

const { tokenize } = require('../../src/lexer');

// decide whether a space is needed between two tokens on the same line
function needSpace(prev, cur) {
  if (!prev) return false;
  const pv = prev.value, cv = cur.value;
  const pt = prev.type, ct = cur.type;

  if (pt === 'COMMENT' || ct === 'COMMENT') return true;

  // no space after openers / before closers / around dot
  if (pv === '(' || pv === '[' || pv === '.') return false;
  if (cv === ')' || cv === ']' || cv === ',' || cv === ';' || cv === '.') return false;

  // braces
  if (cv === '{') return true;
  if (pv === '{') return false;
  if (cv === '}') return false;

  // '(' : space after control keywords, none for calls
  if (cv === '(') return pt === 'KEYWORD';
  // '[' : no space after identifiers/keywords/closers (indexing or typed array)
  if (cv === '[') {
    if (pt === 'KEYWORD' || pt === 'IDENT' || pv === ')' || pv === ']') return false;
    return true;
  }

  // operators need surrounding spaces
  if (ct === 'OP' || pt === 'OP') return true;

  // after separator
  if (pv === ',' || pv === ';') return true;

  // two adjacent words / literals
  return true;
}

function tokenText(t) {
  if (t.type === 'INT' || t.type === 'FLOAT') return t.raw != null ? t.raw : String(t.value);
  if (t.type === 'STRING') return '"' + t.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/\0/g, '\\0') + '"';
  if (t.type === 'CHAR') return "'" + (t.value === '\\' ? '\\\\' : t.value) + "'";
  return t.value;
}

function formatWoolan(src) {
  const tokens = tokenize(src, { emitComments: true });

  // ---- split into logical lines (brace-aware) ----
  // null entries represent blank lines
  const lines = [];
  let cur = [];
  let parenDepth = 0;
  let braceFlushed = false;

  const flush = () => { if (cur.length) { lines.push(cur); cur = []; braceFlushed = false; } };

  for (const t of tokens) {
    if (t.type === 'EOF') break;
    if (t.type === 'NEWLINE') {
      if (cur.length) flush();
      else if (!braceFlushed) lines.push(null);
      braceFlushed = false;
      continue;
    }
    if (t.type === 'PUNCT' && t.value === ';' && parenDepth === 0) { flush(); braceFlushed = true; continue; }

    if (t.type === 'PUNCT' && (t.value === '(' || t.value === '[')) parenDepth++;
    if (t.type === 'PUNCT' && (t.value === ')' || t.value === ']')) parenDepth = Math.max(0, parenDepth - 1);

    if (t.type === 'PUNCT' && t.value === '}') {
      flush();                 // preceding content on its own line
      cur = [t];               // '}' begins a new line (may be joined by else/elseif)
      continue;
    }
    cur.push(t);
    if (t.type === 'PUNCT' && t.value === '{') { flush(); braceFlushed = true; }
  }
  flush();

  // trim leading / trailing blanks
  while (lines.length && lines[0] === null) lines.shift();
  while (lines.length && lines[lines.length - 1] === null) lines.pop();

  // ---- emit with indentation ----
  const out = [];
  let indent = 0;
  for (let li = 0; li < lines.length; li++) {
    const toks = lines[li];

    if (toks === null) {
      const prev = out[out.length - 1];
      const next = lines[li + 1];
      const nextIsClose = next && next.length && next[0].type === 'PUNCT' && next[0].value === '}';
      if (prev !== '' && prev !== undefined && !nextIsClose) out.push('');
      continue;
    }

    const startsWithClose = toks[0].type === 'PUNCT' && toks[0].value === '}';
    const lineIndent = Math.max(0, startsWithClose ? indent - 1 : indent);

    let s = ' '.repeat(lineIndent * 4);
    let prev = null;
    for (const t of toks) {
      if (prev && needSpace(prev, t)) s += ' ';
      s += tokenText(t);
      prev = t;
    }
    out.push(s.replace(/\s+$/, ''));

    let delta = 0;
    for (const t of toks) {
      if (t.type === 'PUNCT' && t.value === '{') delta++;
      else if (t.type === 'PUNCT' && t.value === '}') delta--;
    }
    indent = Math.max(0, indent + delta);
  }

  return out.join('\n') + '\n';
}

module.exports = { formatWoolan };
