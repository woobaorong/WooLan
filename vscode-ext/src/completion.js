// completion.js - Completion provider for Woolan.
//
// Provides:
//   - global completions: keywords, primitive types, builtin classes/aliases
//   - member completions after '.': builtin class methods, user-class
//     methods/fields, and `this` / `sys` members (best-effort, resilient to
//     in-progress edits)

'use strict';

const vscode = require('vscode');
const { tokenize } = require('../../src/lexer');
const { parse } = require('../../src/parser');

const KEYWORDS = [
  'int', 'float', 'bool', 'char', 'void', 'class', 'extends', 'this',
  'if', 'elseif', 'else', 'for', 'while', 'return', 'break', 'continue',
  'package', 'import', 'true', 'false', 'null',
];

const BUILTIN_TYPES = ['Object', 'String', 'List', 'Map', 'Set', 'Date', 'File', 'HttpRequest', 'obj', 'str', 'list', 'map'];

const BUILTIN_METHODS = {
  sys: ['print', 'println', 'wait', 'str2int', 'int2str', 'int2float', 'float2int', 'float2str', 'bool2str', 'is', 'exit'],
  String: ['length', 'charAt', 'substring', 'indexOf', 'equals', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'contains', 'replace', 'split', 'trim', 'toInt', 'toFloat', 'toString'],
  List: ['add', 'get', 'set', 'size', 'removeAt', 'clear', 'isEmpty', 'indexOf', 'contains', 'toString'],
  Map: ['put', 'get', 'remove', 'containsKey', 'size', 'keys', 'values', 'clear', 'toString'],
  Set: ['add', 'contains', 'remove', 'size', 'clear', 'toList', 'toString'],
  Date: ['now', 'getYear', 'getMonth', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'format', 'toString'],
  File: ['read', 'write', 'append', 'exists', 'delete', 'size'],
  HttpRequest: ['setUrl', 'setMethod', 'setHeader', 'setBody', 'send'],
};

const ALIAS_TO_CLASS = { obj: 'Object', str: 'String', list: 'List', map: 'Map' };

// strip strings & comments so regex scanning doesn't match inside them
function stripLiterals(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "''");
}

// heuristic variable-name -> type-name map from declaration patterns
function buildVarTypes(src) {
  const clean = stripLiterals(src);
  const map = {};
  const typeRe = /\b(int|float|bool|char|void|String|str|List|list|Map|map|Set|Date|File|HttpRequest|Object|obj|[A-Z]\w*)\s+([A-Za-z_]\w*)\b/g;
  let m;
  while ((m = typeRe.exec(clean)) !== null) {
    map[m[2]] = m[1];
  }
  return map;
}

// find the class name enclosing a given offset (last `class NAME` before it)
function enclosingClass(src, offset) {
  const re = /\bclass\s+([A-Za-z_]\w*)/g;
  let m, last = null;
  while ((m = re.exec(src)) !== null) {
    if (m.index <= offset) last = m[1];
    else break;
  }
  return last;
}

// best-effort parse -> class info with inherited members.
// Falls back to a regex/token scan when the document is mid-edit (incomplete).
function buildClassInfo(src) {
  let ast = null;
  try { ast = parse(tokenize(src)); } catch (e) { ast = null; }

  const info = {}; // name -> { methods:Set, fields:Set, parents:[] }
  if (ast) {
    for (const stmt of ast.body) {
      if (stmt.kind !== 'Class') continue;
      const methods = new Set();
      const fields = new Set();
      for (const mem of stmt.members) {
        if (mem.kind === 'Method') methods.add(mem.name);
        else if (mem.kind === 'Field') fields.add(mem.name);
      }
      info[stmt.name] = { methods, fields, parents: stmt.parents.map(p => (typeof p === 'string' ? p : p.name)) };
    }
  } else {
    extractClassesRegex(src, info);
  }

  // resolve inherited members
  const resolved = {};
  const collect = (name, seen) => {
    if (resolved[name] || seen.has(name)) return resolved[name] || { methods: new Set(), fields: new Set() };
    seen.add(name);
    const ci = info[name];
    if (!ci) return { methods: new Set(), fields: new Set() };
    const methods = new Set(ci.methods);
    const fields = new Set(ci.fields);
    for (const p of ci.parents) {
      const pi = collect(p, seen);
      pi.methods.forEach(x => methods.add(x));
      pi.fields.forEach(x => fields.add(x));
    }
    resolved[name] = { methods, fields };
    return resolved[name];
  };
  for (const name of Object.keys(info)) collect(name, new Set());
  // merge in Object base methods
  for (const name of Object.keys(resolved)) {
    resolved[name].methods.add('toString');
    resolved[name].methods.add('equals');
    resolved[name].methods.add('getClass');
  }
  return resolved;
}

const TYPE_ALT = 'int|float|bool|char|void|String|str|List|list|Map|map|Set|Date|File|HttpRequest|Object|obj|[A-Z]\\w*';

// regex fallback: brace-match each class body and scan for members
function extractClassesRegex(src, info) {
  const clean = stripLiterals(src);
  const headerRe = new RegExp('\\bclass\\s+([A-Za-z_]\\w*)\\s*(?:extends\\s+([A-Za-z_][\\w\\s,]*?))?\\s*\\{', 'g');
  let hm;
  while ((hm = headerRe.exec(clean)) !== null) {
    const name = hm[1];
    const parents = hm[2] ? hm[2].split(',').map(s => s.trim()).filter(Boolean) : [];
    const braceIdx = hm.index + hm[0].length - 1;
    let depth = 0, bodyEnd = clean.length, j = braceIdx;
    for (; j < clean.length; j++) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') { depth--; if (depth === 0) { bodyEnd = j; break; } }
    }
    const body = clean.slice(braceIdx + 1, bodyEnd);
    const methods = new Set();
    const fields = new Set();
    const methodRe = new RegExp('\\b(' + TYPE_ALT + ')\\s+([A-Za-z_]\\w*)\\s*\\(', 'g');
    let mm;
    while ((mm = methodRe.exec(body)) !== null) methods.add(mm[2]);
    const fieldRe = new RegExp('\\b(' + TYPE_ALT + ')\\s+([A-Za-z_]\\w*)\\b(?!\\s*\\()', 'g');
    while ((mm = fieldRe.exec(body)) !== null) fields.add(mm[2]);
    info[name] = { methods, fields, parents };
  }
}

function memberItems(names, kind) {
  return [...new Set(names)].map(n => {
    const item = new vscode.CompletionItem(n, kind);
    return item;
  });
}

class WoolanCompletionProvider {
  provideCompletionItems(document, position) {
    const src = document.getText();
    const offset = document.offsetAt(position);
    const lineText = document.lineAt(position.line).text;
    const textBefore = lineText.slice(0, position.character);

    const dotIdx = textBefore.lastIndexOf('.');
    if (dotIdx >= 0) {
      const before = textBefore.slice(0, dotIdx);
      const idMatch = before.match(/([A-Za-z_]\w*)\s*$/);
      const objName = idMatch ? idMatch[1] : '';
      return this.memberCompletions(src, offset, objName);
    }
    return this.globalCompletions();
  }

  memberCompletions(src, offset, objName) {
    if (objName === 'sys') {
      return memberItems(BUILTIN_METHODS.sys, vscode.CompletionItemKind.Method);
    }
    if (objName === 'this') {
      const cls = enclosingClass(src, offset);
      const info = buildClassInfo(src);
      if (cls && info && info[cls]) {
        return [
          ...memberItems(info[cls].methods, vscode.CompletionItemKind.Method),
          ...memberItems(info[cls].fields, vscode.CompletionItemKind.Field),
        ];
      }
      return [];
    }
    const varTypes = buildVarTypes(src);
    let type = varTypes[objName];
    if (!type) return [];
    if (ALIAS_TO_CLASS[type]) type = ALIAS_TO_CLASS[type];
    if (BUILTIN_METHODS[type]) {
      return memberItems(BUILTIN_METHODS[type], vscode.CompletionItemKind.Method);
    }
    const info = buildClassInfo(src);
    if (info && info[type]) {
      return [
        ...memberItems(info[type].methods, vscode.CompletionItemKind.Method),
        ...memberItems(info[type].fields, vscode.CompletionItemKind.Field),
      ];
    }
    return [];
  }

  globalCompletions() {
    const items = [];
    for (const kw of KEYWORDS) items.push(new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword));
    for (const t of BUILTIN_TYPES) items.push(new vscode.CompletionItem(t, vscode.CompletionItemKind.Class));
    return items;
  }
}

module.exports = { WoolanCompletionProvider };
