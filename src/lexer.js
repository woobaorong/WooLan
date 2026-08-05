// lexer.js - Tokenizer for Woolan (.woo)
//
// Tokens: keywords, identifiers, int/float/char/string literals,
// operators, punctuation, and NEWLINE (significant only at top/brace level).
// Newlines inside () and [] are suppressed so expressions may wrap freely.

'use strict';

const KEYWORDS = new Set([
  'int', 'float', 'bool', 'char', 'void', 'return', 'class', 'this',
  'extends', 'for', 'while', 'if', 'elseif', 'else', 'break', 'continue',
  'package', 'import', 'true', 'false', 'null',
]);

const PUNCT = new Set(['(', ')', '[', ']', '{', '}', ',', '.', ';']);

class Token {
  constructor(type, value, line, col) {
    this.type = type; // 'KEYWORD','IDENT','INT','FLOAT','CHAR','STRING','OP','PUNCT','NEWLINE','EOF'
    this.value = value;
    this.line = line;
    this.col = col;
  }
  toString() { return `Token(${this.type},${JSON.stringify(this.value)},${this.line}:${this.col})`; }
}

class LexerError extends Error {
  constructor(msg, line, col) { super(`LexerError at ${line}:${col} - ${msg}`); this.line = line; this.col = col; }
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isAlpha(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isAlphaNum(c) { return isAlpha(c) || isDigit(c); }

function tokenize(src, options = {}) {
  const emitComments = !!options.emitComments;
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = src.length;
  let bracketDepth = 0; // ( ) and [ ] suppress newlines

  function adv(count = 1) {
    for (let k = 0; k < count; k++) {
      if (src[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }
  function peek(off = 0) { return src[i + off]; }
  function emitNL() { tokens.push(new Token('NEWLINE', '\n', line, 1)); }

  while (i < n) {
    const c = src[i];

    // whitespace (non-newline)
    if (c === ' ' || c === '\t' || c === '\r') { adv(); continue; }

    // newlines: significant only outside ()/[]
    if (c === '\n') {
      if (bracketDepth === 0) emitNL();
      adv();
      continue;
    }

    // comments
    if (c === '/' && peek(1) === '/') {
      const sl = line, sc = col, start = i;
      while (i < n && src[i] !== '\n') adv();
      if (emitComments) tokens.push(new Token('COMMENT', src.slice(start, i), sl, sc));
      continue; // the trailing \n will be handled next loop
    }
    if (c === '/' && peek(1) === '*') {
      const sl = line, sc = col, start = i;
      adv(2);
      while (i < n && !(src[i] === '*' && peek(1) === '/')) adv();
      if (i < n) adv(2);
      if (emitComments) tokens.push(new Token('COMMENT', src.slice(start, i), sl, sc));
      continue;
    }

    // identifiers / keywords
    if (isAlpha(c)) {
      const start = i, sl = line, sc = col;
      while (i < n && isAlphaNum(src[i])) adv();
      const word = src.slice(start, i);
      tokens.push(new Token(KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT', word, sl, sc));
      continue;
    }

    // numbers
    if (isDigit(c)) {
      const start = i, sl = line, sc = col;
      while (i < n && isDigit(src[i])) adv();
      let isFloat = false;
      if (src[i] === '.' && isDigit(peek(1))) {
        isFloat = true;
        adv();
        while (i < n && isDigit(src[i])) adv();
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isFloat = true;
        adv();
        if (src[i] === '+' || src[i] === '-') adv();
        while (i < n && isDigit(src[i])) adv();
      }
      const text = src.slice(start, i);
      const tok = new Token(isFloat ? 'FLOAT' : 'INT', isFloat ? parseFloat(text) : parseInt(text, 10), sl, sc);
      tok.raw = text; // preserve original literal text for the formatter
      tokens.push(tok);
      continue;
    }

    // char literal
    if (c === "'") {
      const sl = line, sc = col;
      adv();
      let ch = src[i];
      if (ch === '\\') { adv(); ch = escapeChar(src[i]); adv(); }
      else { adv(); }
      if (src[i] !== "'") throw new LexerError("expected closing '", line, col);
      adv();
      tokens.push(new Token('CHAR', ch, sl, sc));
      continue;
    }

    // string literal
    if (c === '"') {
      const sl = line, sc = col;
      adv();
      let str = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') { adv(); str += escapeChar(src[i]); adv(); }
        else if (src[i] === '\n') throw new LexerError('newline in string', line, col);
        else { str += src[i]; adv(); }
      }
      if (i >= n) throw new LexerError('unterminated string', sl, sc);
      adv();
      tokens.push(new Token('STRING', str, sl, sc));
      continue;
    }

    // multi-char operators
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push(new Token('OP', two, line, col)); adv(2); continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/' || c === '%' || c === '=' || c === '<' || c === '>' || c === '!') {
      tokens.push(new Token('OP', c, line, col)); adv(); continue;
    }

    // punctuation / brackets
    if (c === '(' || c === '[') { bracketDepth++; tokens.push(new Token('PUNCT', c, line, col)); adv(); continue; }
    if (c === ')' || c === ']') { bracketDepth = Math.max(0, bracketDepth - 1); tokens.push(new Token('PUNCT', c, line, col)); adv(); continue; }
    if (PUNCT.has(c)) { tokens.push(new Token('PUNCT', c, line, col)); adv(); continue; }

    throw new LexerError(`unexpected character '${c}'`, line, col);
  }

  tokens.push(new Token('EOF', null, line, col));
  return tokens;
}

function escapeChar(c) {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '\\': return '\\';
    case "'": return "'";
    case '"': return '"';
    case '0': return '\0';
    default: return c;
  }
}

module.exports = { tokenize, Token, LexerError, KEYWORDS };
