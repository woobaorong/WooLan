// semantics.js - Semantic analyzer (linter) for Woolan.
//
// Runs after a successful parse. Walks the AST with scope + type tracking and
// reports many issues at their source positions:
//   - undefined identifiers / unknown types
//   - type mismatches in assignments, returns, arithmetic, comparisons
//   - calling non-existent methods / wrong argument count
//   - accessing non-existent fields
//   - non-bool conditions
//
// Returns an array of { line, col, message, severity }.

'use strict';

const { tokenize } = require('../../src/lexer');
const { parse } = require('../../src/parser');
const path = require('path');
const fs = require('fs');

const PRIMITIVES = new Set(['int', 'float', 'bool', 'char', 'void']);
const CONSTRUCTABLE = new Set(['Object', 'String', 'List', 'Map', 'Set', 'Date', 'File', 'HttpRequest']);
const BUILTIN_INTERFACES = new Set(['TimeCallbacker', 'HttpCallbacker']);

// builtin methods: class -> { name -> { params: [types]|null, ret } }
// params === null means variadic / any (no count or type check)
const BUILTIN_METHODS = {
  sys: {
    print: { params: null, ret: 'void' }, println: { params: null, ret: 'void' },
    wait: { params: ['TimeCallbacker', 'int'], ret: 'void' }, str2int: { params: ['String'], ret: 'int' },
    str2float: { params: ['String'], ret: 'float' },
    char2str: { params: ['char'], ret: 'String' },
    int2str: { params: ['int'], ret: 'String' }, int2float: { params: ['int'], ret: 'float' },
    float2int: { params: ['float'], ret: 'int' }, float2str: { params: ['float'], ret: 'String' },
    bool2str: { params: ['bool'], ret: 'String' }, is: { params: null, ret: 'bool' },
    exit: { params: null, ret: 'void' },
    strToCharArray: { params: ['String'], ret: 'Object' },
    charArrayToStr: { params: null, ret: 'String' },
  },
  String: {
    length: { params: [], ret: 'int' }, charAt: { params: ['int'], ret: 'char' },
    substring: { params: ['int', 'int'], ret: 'String' }, indexOf: { params: ['String'], ret: 'int' },
    equals: { params: ['String'], ret: 'bool' }, toLowerCase: { params: [], ret: 'String' },
    toUpperCase: { params: [], ret: 'String' }, startsWith: { params: ['String'], ret: 'bool' },
    endsWith: { params: ['String'], ret: 'bool' }, contains: { params: ['String'], ret: 'bool' },
    replace: { params: ['String', 'String'], ret: 'String' }, split: { params: ['String'], ret: 'List' },
    trim: { params: [], ret: 'String' }, toInt: { params: [], ret: 'int' },
    toFloat: { params: [], ret: 'float' }, toString: { params: [], ret: 'String' },
  },
  List: {
    add: { params: null, ret: 'void' }, get: { params: ['int'], ret: 'Object' },
    set: { params: ['int', 'Object'], ret: 'void' }, size: { params: [], ret: 'int' },
    removeAt: { params: ['int'], ret: 'Object' }, clear: { params: [], ret: 'void' },
    isEmpty: { params: [], ret: 'bool' }, indexOf: { params: null, ret: 'int' },
    contains: { params: null, ret: 'bool' }, toString: { params: [], ret: 'String' },
  },
  Map: {
    put: { params: null, ret: 'void' }, get: { params: null, ret: 'Object' },
    remove: { params: null, ret: 'Object' }, containsKey: { params: null, ret: 'bool' },
    size: { params: [], ret: 'int' }, keys: { params: [], ret: 'List' },
    values: { params: [], ret: 'List' }, clear: { params: [], ret: 'void' },
    toString: { params: [], ret: 'String' },
  },
  Set: {
    add: { params: null, ret: 'void' }, contains: { params: null, ret: 'bool' },
    remove: { params: null, ret: 'void' }, size: { params: [], ret: 'int' },
    clear: { params: [], ret: 'void' }, toList: { params: [], ret: 'List' },
    toString: { params: [], ret: 'String' },
  },
  Date: {
    now: { params: [], ret: 'int' }, getYear: { params: [], ret: 'int' },
    getMonth: { params: [], ret: 'int' }, getDay: { params: [], ret: 'int' },
    getHours: { params: [], ret: 'int' }, getMinutes: { params: [], ret: 'int' },
    getSeconds: { params: [], ret: 'int' }, format: { params: ['String'], ret: 'String' },
    toString: { params: [], ret: 'String' },
  },
  File: {
    read: { params: [], ret: 'String' }, write: { params: ['String'], ret: 'void' },
    append: { params: ['String'], ret: 'void' }, exists: { params: [], ret: 'bool' },
    delete: { params: [], ret: 'void' }, size: { params: [], ret: 'int' },
  },
  HttpRequest: {
    setUrl: { params: ['String'], ret: 'void' }, setMethod: { params: ['String'], ret: 'void' },
    setHeader: { params: ['String', 'String'], ret: 'void' }, setBody: { params: ['String'], ret: 'void' },
    send: { params: [], ret: 'String' },
  },
  Object: {
    toString: { params: [], ret: 'String' }, equals: { params: null, ret: 'bool' },
    getClass: { params: [], ret: 'String' },
  },
};

function canonical(type) { return type; }

function buildClasses(ast) {
  const classes = {};
  for (const stmt of ast.body) {
    if (stmt.kind !== 'Class') continue;
    const parents = stmt.parents.map(p => (typeof p === 'string' ? p : p.name));
    classes[stmt.name] = { name: stmt.name, parents, methods: {}, fields: {} };
    for (const m of stmt.members) {
      if (m.kind === 'Method') classes[stmt.name].methods[m.name] = m;
      else classes[stmt.name].fields[m.name] = m;
    }
  }
  // MRO (depth-first, dedup)
  const mro = (name, seen = new Set()) => {
    if (!classes[name]) return [];
    const out = [];
    const visit = (n) => { if (classes[n] && !out.includes(n)) { out.push(n); for (const p of classes[n].parents) visit(p); } };
    visit(name);
    return out;
  };
  for (const name of Object.keys(classes)) classes[name].mro = mro(name);
  return classes;
}

class Analyzer {
  constructor(ast) {
    this.ast = ast;
    this.classes = buildClasses(ast);
    this.diags = [];
    this.scopes = [new Map()];
    this.scopes[0].set('sys', 'sys'); // global sys object
    this.thisType = null;
    this.returnType = null;
  }

  diag(node, msg) { if (node && node.line) this.diags.push({ line: node.line, col: node.col, message: msg, severity: 'error' }); }

  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }
  declare(name, type) { this.scopes[this.scopes.length - 1].set(name, type); }
  lookup(name) { for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i].get(name); return undefined; }

  isClassName(name) { return !!this.classes[name] || CONSTRUCTABLE.has(name) || BUILTIN_INTERFACES.has(name); }
  isKnownType(name) {
    if (PRIMITIVES.has(name) || name === 'null' || name === 'unknown') return true;
    if (BUILTIN_METHODS[name]) return true;
    if (CONSTRUCTABLE.has(name) || BUILTIN_INTERFACES.has(name)) return true;
    return !!this.classes[name];
  }

  // method signature on a type, or null
  lookupMethod(type, name) {
    type = canonical(type);
    if (BUILTIN_METHODS[type]) return BUILTIN_METHODS[type][name] || null;
    if (this.classes[type]) {
      for (const c of this.classes[type].mro) {
        if (this.classes[c].methods[name]) {
          const m = this.classes[c].methods[name];
          return { params: m.params.map(p => p.type), ret: m.returnType, body: m.body };
        }
      }
      return BUILTIN_METHODS.Object[name] || null;
    }
    return null;
  }
  lookupField(type, name) {
    type = canonical(type);
    if (this.classes[type]) {
      for (const c of this.classes[type].mro) {
        if (this.classes[c].fields[name]) return this.classes[c].fields[name].varType;
      }
    }
    return null;
  }

  isSubclass(a, b) {
    a = canonical(a); b = canonical(b);
    if (a === b) return true;
    if (b === 'Object' && (this.classes[a] || CONSTRUCTABLE.has(a))) return true;
    if (this.classes[a] && this.classes[a].mro.includes(b)) return true;
    return false;
  }

  // can a value of `valueType` be assigned to a slot of `declaredType`?
  assignable(valueType, declaredType) {
    if (declaredType === 'unknown' || valueType === 'unknown') return true;
    if (declaredType === 'Object' || valueType === 'Object') return true; // containers hold Object; flows freely
    if (valueType === 'null') return !PRIMITIVES.has(declaredType); // null -> any class type
    if (PRIMITIVES.has(declaredType)) return valueType === declaredType;
    // class type
    if (PRIMITIVES.has(valueType)) return false;
    return this.isSubclass(valueType, declaredType);
  }

  // ---- run ----
  run() {
    for (const stmt of this.ast.body) this.stmt(stmt);
    return this.diags;
  }

  stmt(node) {
    if (!node) return;
    switch (node.kind) {
      case 'Class': this.analyzeClass(node); return;
      case 'VarDecl': this.varDecl(node); return;
      case 'ExprStmt': this.infer(node.expr); return;
      case 'Block': this.push(); for (const s of node.body) this.stmt(s); this.pop(); return;
      case 'If':
        this.checkBool(node.cond, 'if condition');
        this.stmt(node.then);
        for (const e of node.elseifs) { this.checkBool(e.cond, 'elseif condition'); this.stmt(e.body); }
        if (node.elseBody) this.stmt(node.elseBody);
        return;
      case 'For': {
        this.push();
        if (node.init) this.stmt(node.init);
        this.checkBool(node.cond, 'for condition');
        if (node.update) this.infer(node.update);
        this.stmt(node.body);
        this.pop();
        return;
      }
      case 'While': this.checkBool(node.cond, 'while condition'); this.stmt(node.body); return;
      case 'Return': {
        if (this.returnType) {
          if (node.value === null) {
            if (this.returnType !== 'void') this.diag(node, `missing return value (expected ${this.returnType})`);
          } else {
            const vt = this.infer(node.value);
            if (vt !== 'unknown' && !this.assignable(vt, this.returnType)) {
              this.diag(node.value, `cannot return ${this.typeName(vt)} from method (expected ${this.returnType})`);
            }
          }
        }
        return;
      }
      case 'Break': case 'Continue': case 'Package': case 'Import': return;
      default: return;
    }
  }

  checkBool(cond, label) {
    if (!cond) return;
    const t = this.infer(cond);
    if (t !== 'unknown' && t !== 'bool') this.diag(cond, `${label} must be bool, got ${this.typeName(t)}`);
  }

  typeName(t) { return t === 'null' ? 'null' : t; }

  varDecl(node) {
    if (node.isArray) {
      if (!this.isKnownType(node.varType)) this.diag({ line: node.varTypeLine, col: node.varTypeCol }, `unknown type '${node.varType}'`);
      if (node.init && node.init.kind === 'ArrayLit') {
        node.init.elements.forEach((e, i) => {
          const et = this.infer(e);
          if (et !== 'unknown' && !this.assignable(et, node.varType)) this.diag(e, `array element ${i}: cannot assign ${this.typeName(et)} to ${node.varType}`);
        });
      }
      this.declare(node.name, node.varType + '[]');
      return;
    }
    if (!this.isKnownType(node.varType)) this.diag({ line: node.varTypeLine, col: node.varTypeCol }, `unknown type '${node.varType}'`);
    if (node.init) {
      const vt = this.infer(node.init);
      if (vt !== 'unknown' && !this.assignable(vt, node.varType)) {
        this.diag(node.init, `cannot assign ${this.typeName(vt)} to ${node.varType}`);
      }
    }
    this.declare(node.name, node.varType);
  }

  analyzeClass(node) {
    // check parents exist
    for (const p of node.parents) {
      const pn = typeof p === 'string' ? p : p.name;
      if (!this.classes[pn] && !CONSTRUCTABLE.has(pn)) this.diag(p, `unknown parent class '${pn}'`);
    }
    const savedThis = this.thisType;
    this.thisType = node.name;
    // field initializers
    for (const m of node.members) {
      if (m.kind === 'Field') {
        if (!this.isKnownType(m.varType)) this.diag({ line: m.varTypeLine, col: m.varTypeCol }, `unknown type '${m.varType}'`);
        if (m.init) {
          this.push();
          const vt = this.infer(m.init);
          this.pop();
          if (vt !== 'unknown' && !this.assignable(vt, m.varType)) this.diag(m.init, `cannot assign ${this.typeName(vt)} to ${m.varType}`);
        }
      }
    }
    // methods
    for (const m of node.members) {
      if (m.kind === 'Method') this.analyzeMethod(m);
    }
    this.thisType = savedThis;
  }

  analyzeMethod(node) {
    if (!this.isKnownType(node.returnType)) this.diag(node, `unknown return type '${node.returnType}'`);
    const savedRet = this.returnType;
    this.returnType = node.returnType;
    this.push();
    for (const p of node.params) {
      if (!this.isKnownType(p.type)) this.diag(p, `unknown type '${p.type}'`);
      this.declare(p.name, p.type);
    }
    if (node.body) for (const s of node.body.body) this.stmt(s);
    this.pop();
    this.returnType = savedRet;
  }

  // ---- expression type inference ----
  infer(node) {
    if (!node) return 'unknown';
    switch (node.kind) {
      case 'IntLit': return 'int';
      case 'FloatLit': return 'float';
      case 'CharLit': return 'char';
      case 'StringLit': return 'String';
      case 'BoolLit': return 'bool';
      case 'NullLit': return 'null';
      case 'This': return this.thisType || 'unknown';
      case 'Ident': return this.inferIdent(node);
      case 'ArrayLit': return 'Object[]';
      case 'Field': return this.inferField(node);
      case 'Index': return this.inferIndex(node);
      case 'Call': return this.inferCall(node);
      case 'Unary': return this.inferUnary(node);
      case 'Binary': return this.inferBinary(node);
      case 'Assign': return this.inferAssign(node);
      default: return 'unknown';
    }
  }

  inferIdent(node) {
    const t = this.lookup(node.name);
    if (t !== undefined) return t;
    if (this.isClassName(node.name)) return node.name; // class used as value (constructor / is())
    this.diag(node, `undefined identifier '${node.name}'`);
    return 'unknown';
  }

  inferField(node) {
    const objType = this.infer(node.object);
    if (objType === 'unknown') return 'unknown';
    const ft = this.lookupField(objType, node.name);
    if (ft) return ft;
    // could be a method referenced as a value
    const mt = this.lookupMethod(objType, node.name);
    if (mt) return 'unknown';
    this.diag({ line: node.nameLine, col: node.nameCol }, `no field '${node.name}' on ${this.typeName(objType)}`);
    return 'unknown';
  }

  inferIndex(node) {
    const objType = this.infer(node.object);
    const idxType = this.infer(node.index);
    if (idxType !== 'unknown' && idxType !== 'int') this.diag(node.index, `index must be int, got ${this.typeName(idxType)}`);
    if (objType === 'unknown') return 'unknown';
    if (objType.endsWith('[]')) return objType.slice(0, -2);
    if (objType === 'List' || canonical(objType) === 'List') return 'Object';
    if (objType === 'String' || canonical(objType) === 'String') return 'char';
    this.diag(node, `value of type ${this.typeName(objType)} is not indexable`);
    return 'unknown';
  }

  inferCall(node) {
    const callee = node.callee;
    // constructor: Ident naming a class
    if (callee.kind === 'Ident' && this.isClassName(callee.name) && this.lookup(callee.name) === undefined) {
      const argTypes = node.args.map(a => this.infer(a));
      // check against init() if present
      const init = this.lookupMethod(callee.name, 'init');
      if (init && init.params !== null) {
        if (argTypes.length !== init.params.length) this.diag(callee, `constructor ${callee.name} expects ${init.params.length} args, got ${argTypes.length}`);
      }
      return callee.name;
    }
    if (callee.kind === 'Field') {
      const objType = this.infer(callee.object);
      const argTypes = node.args.map(a => this.infer(a));
      if (objType === 'unknown') return 'unknown';
      const m = this.lookupMethod(objType, callee.name);
      if (!m) { this.diag({ line: callee.nameLine, col: callee.nameCol }, `no method '${callee.name}' on ${this.typeName(objType)}`); return 'unknown'; }
      if (m.params !== null) {
        if (argTypes.length !== m.params.length) {
          this.diag(callee, `method '${callee.name}' expects ${m.params.length} argument(s), got ${argTypes.length}`);
        } else {
          for (let i = 0; i < m.params.length; i++) {
            if (m.params[i] === 'Object') continue;
            if (argTypes[i] !== 'unknown' && !this.assignable(argTypes[i], m.params[i])) {
              this.diag(node.args[i], `argument ${i + 1}: cannot pass ${this.typeName(argTypes[i])} to ${m.params[i]}`);
            }
          }
        }
      }
      return m.ret;
    }
    const t = this.infer(callee);
    if (t !== 'unknown') this.diag(callee, `value of type ${this.typeName(t)} is not callable`);
    return 'unknown';
  }

  inferUnary(node) {
    const t = this.infer(node.operand);
    if (node.op === '!') {
      if (t !== 'unknown' && t !== 'bool') this.diag(node, `operator '!' requires bool, got ${this.typeName(t)}`);
      return 'bool';
    }
    if (node.op === '-') {
      if (t !== 'unknown' && t !== 'int' && t !== 'float') this.diag(node, `operator '-' requires int or float, got ${this.typeName(t)}`);
      return t;
    }
    return 'unknown';
  }

  inferBinary(node) {
    const op = node.op;
    if (op === '&&' || op === '||') {
      const l = this.infer(node.left), r = this.infer(node.right);
      if (l !== 'unknown' && l !== 'bool') this.diag(node.left, `operator '${op}' requires bool, got ${this.typeName(l)}`);
      if (r !== 'unknown' && r !== 'bool') this.diag(node.right, `operator '${op}' requires bool, got ${this.typeName(r)}`);
      return 'bool';
    }
    const l = this.infer(node.left), r = this.infer(node.right);
    if (op === '+' || op === '-' || op === '*' || op === '/') {
      if (l === 'int' && r === 'int') return 'int';
      if (l === 'float' && r === 'float') return 'float';
      if (op === '+' && canonical(l) === 'String' && canonical(r) === 'String') return 'String';
      if (l === 'unknown' || r === 'unknown') return 'unknown';
      this.diag(node, `operator '${op}' not supported for ${this.typeName(l)} and ${this.typeName(r)} (no automatic conversion)`);
      return 'unknown';
    }
    if (op === '==' || op === '!=') {
      // comparable: both null, same primitive, both class, or one null with class
      if (l === 'unknown' || r === 'unknown') return 'bool';
      const ok = (l === 'null' && r === 'null') ||
        (PRIMITIVES.has(l) && l === r) ||
        (l === 'null' && !PRIMITIVES.has(r)) ||
        (r === 'null' && !PRIMITIVES.has(l)) ||
        (!PRIMITIVES.has(l) && !PRIMITIVES.has(r) && (this.isSubclass(l, r) || this.isSubclass(r, l)));
      if (!ok) this.diag(node, `cannot compare ${this.typeName(l)} with ${this.typeName(r)}`);
      return 'bool';
    }
    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      if ((l === 'int' && r === 'int') || (l === 'float' && r === 'float')) return 'bool';
      if (l === 'unknown' || r === 'unknown') return 'bool';
      this.diag(node, `operator '${op}' requires two int or two float, got ${this.typeName(l)} and ${this.typeName(r)}`);
      return 'bool';
    }
    return 'unknown';
  }

  inferAssign(node) {
    const vt = this.infer(node.value);
    const target = node.target;
    if (target.kind === 'Ident') {
      const tt = this.lookup(target.name);
      if (tt === undefined) { this.diag(target, `cannot assign to undeclared variable '${target.name}'`); return vt; }
      if (vt !== 'unknown' && !this.assignable(vt, tt)) this.diag(node.value, `cannot assign ${this.typeName(vt)} to ${tt}`);
      return vt;
    }
    if (target.kind === 'Field') {
      const objType = this.infer(target.object);
      if (objType === 'unknown') return vt;
      const ft = this.lookupField(objType, target.name);
      if (!ft) { this.diag({ line: target.nameLine, col: target.nameCol }, `no field '${target.name}' on ${this.typeName(objType)}`); return vt; }
      if (vt !== 'unknown' && !this.assignable(vt, ft)) this.diag(node.value, `cannot assign ${this.typeName(vt)} to ${ft}`);
      return vt;
    }
    if (target.kind === 'Index') {
      this.infer(target.object);
      this.infer(target.index);
      return vt;
    }
    return vt;
  }
}

function analyzeSemantics(src, filePath) {
  let ast;
  try { ast = parse(tokenize(src)); } catch (e) { return []; } // parse errors handled elsewhere

  // First, collect all available classes (builtins + imports + current file)
  const allClasses = {};

  // 1. Load builtin interfaces first (they are the base for inheritance)
  if (filePath) {
    const builtinClasses = loadBuiltinInterfaces(filePath);
    for (const [name, classInfo] of Object.entries(builtinClasses)) {
      allClasses[name] = classInfo;
    }

    // 2. Load imported classes
    const importedClasses = processImports(ast, filePath);
    for (const [name, classInfo] of Object.entries(importedClasses)) {
      if (!allClasses[name]) {
        allClasses[name] = classInfo;
      }
    }
  }

  // 3. Build classes from current file
  const currentFileClasses = buildClasses(ast);

  // Merge current file classes into allClasses
  for (const [name, classInfo] of Object.entries(currentFileClasses)) {
    allClasses[name] = classInfo;
  }

  // 4. Recalculate MRO for all classes (now that all dependencies are available)
  for (const name of Object.keys(allClasses)) {
    allClasses[name].mro = calculateMRO(allClasses, name);
  }

  // 5. Create analyzer with complete class hierarchy
  const analyzer = new Analyzer(ast);
  analyzer.classes = allClasses;

  return analyzer.run();
}

function calculateMRO(allClasses, className) {
  const out = [];
  const visit = (n) => {
    if (allClasses[n] && !out.includes(n)) {
      out.push(n);
      for (const p of allClasses[n].parents) visit(p);
    }
  };
  visit(className);
  return out;
}

function loadBuiltinInterfaces(filePath) {
  const builtinClasses = {};

  // Try to find builtin directory from workspace root
  const workspaceFolder = filePath ? path.dirname(filePath) : '.';
  let builtinDir = path.join(workspaceFolder, 'builtin');

  // If not found, try going up to find workspace root
  if (!fs.existsSync(builtinDir)) {
    builtinDir = path.join(path.dirname(workspaceFolder), 'builtin');
  }

  if (!fs.existsSync(builtinDir)) return builtinClasses;

  try {
    for (const file of fs.readdirSync(builtinDir).filter(f => f.endsWith('.woo'))) {
      const name = file.slice(0, -4);
      const modulePath = path.join(builtinDir, file);

      try {
        const moduleSrc = fs.readFileSync(modulePath, 'utf8');
        const moduleAst = parse(tokenize(moduleSrc));
        const moduleClasses = buildClasses(moduleAst);

        for (const [className, classInfo] of Object.entries(moduleClasses)) {
          if (!builtinClasses[className]) {
            builtinClasses[className] = classInfo;
          }
        }
      } catch (e) {
        // Ignore parse errors in builtin files
      }
    }
  } catch (e) {
    // Ignore errors
  }

  return builtinClasses;
}

function processImports(ast, filePath) {
  const importedClasses = {};
  const baseDir = path.dirname(filePath);

  for (const stmt of ast.body) {
    if (stmt.kind !== 'Import') continue;

    for (const name of stmt.names) {
      const modulePath = path.join(baseDir, name + '.woo');

      try {
        if (!fs.existsSync(modulePath)) continue;
        const moduleSrc = fs.readFileSync(modulePath, 'utf8');
        const moduleAst = parse(tokenize(moduleSrc));

        // Use buildClasses to properly process the module with MRO
        const moduleClasses = buildClasses(moduleAst);
        for (const [className, classInfo] of Object.entries(moduleClasses)) {
          if (!importedClasses[className]) {
            importedClasses[className] = classInfo;
          }
        }
      } catch (e) {
        // Ignore parse errors in imported modules during semantic analysis
      }
    }
  }

  return importedClasses;
}

module.exports = { analyzeSemantics, Analyzer };
