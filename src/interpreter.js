// interpreter.js - Tree-walking interpreter for Woolan.
//
// Responsibilities:
//   - register user classes (resolve parents, compute MRO)
//   - execute top-level statements
//   - evaluate expressions with strict (no auto-cast) type checking
//   - construct instances, dispatch methods (dynamic / most-derived first)

'use strict';

const fs = require('fs');
const path = require('path');
const { Val, WooInstance, defaultValue, makeInt, makeFloat, makeBool, makeChar, PRIMITIVE_TYPES } = require('./values');
const {
  registerBuiltins, toDisplay, NativeClass,
  ObjectClass, StringClass, ListClass, MapClass, SetClass, DateClass, FileClass, HttpRequestClass, ArrayClass,
} = require('./builtins');
const { resolveImport } = require('./modules');

// ---- control-flow signals ----
class ReturnSignal extends Error { constructor(v) { super('return'); this.value = v; } }
class BreakSignal extends Error { constructor() { super('break'); } }
class ContinueSignal extends Error { constructor() { super('continue'); } }
class WoolanError extends Error {
  constructor(msg) { super(msg); this.name = 'WoolanError'; }
}

// ---- user class definition ----
class ClassDef {
  constructor(ast) {
    this.name = ast.name;
    this.ast = ast;
    this.isNative = false;
    this.parentDefs = [];
    this.mro = [];
    this.ownMethods = new Map();
    this.ownFields = [];
    for (const m of ast.members) {
      if (m.kind === 'Method') this.ownMethods.set(m.name, m);
      else this.ownFields.push(m);
    }
  }
}

// ---- environment / scopes ----
class Environment {
  constructor(parent = null) { this.parent = parent; this.vars = new Map(); }
  define(name, type, value) { this.vars.set(name, { type, value }); }
  has(name) {
    if (this.vars.has(name)) return true;
    return this.parent ? this.parent.has(name) : false;
  }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name).value;
    if (this.parent) return this.parent.get(name);
    throw new WoolanError("undefined variable '" + name + "'");
  }
  assign(name, value, typeChecker) {
    if (this.vars.has(name)) {
      const slot = this.vars.get(name);
      if (slot.type !== '__any__' && typeChecker) typeChecker(slot.type, value);
      slot.value = value;
      return;
    }
    if (this.parent) return this.parent.assign(name, value, typeChecker);
    throw new WoolanError("cannot assign to undeclared variable '" + name + "'");
  }
}

class Interpreter {
  constructor() {
    this.classes = new Map();      // name -> ClassDef | NativeClass
    this.globalEnv = new Environment();
    this.loadedModules = new Set();
    this.baseDir = '.';
    this.projectRoot = '.';        // Project root (entry script directory)
    registerBuiltins(this);
    this.loadBuiltins();
  }

  defineGlobal(name, value) { this.globalEnv.define(name, '__any__', value); }

  // ---- value factories (used by builtins & literals) ----
  makeString(s) { const i = new WooInstance(StringClass); i.native = s; return i; }
  makeList(arr) { const i = new WooInstance(ListClass); i.native = arr; return i; }
  makeMap(obj) { const i = new WooInstance(MapClass); i.native = obj; return i; }
  makeSet(obj) { const i = new WooInstance(SetClass); i.native = obj; return i; }
  makeDate(d) { const i = new WooInstance(DateClass); i.native = d; return i; }
  makeFile(p) { const i = new WooInstance(FileClass); i.native = p; return i; }
  makeHttp(o) { const i = new WooInstance(HttpRequestClass); i.native = o; return i; }
  makeArray(elemType, items) { const i = new WooInstance(ArrayClass); i.native = items; i.elemType = elemType; return i; }

  // ====================================================================
  // class registration & MRO
  // ====================================================================
  linearize(cd) {
    const result = [];
    const visit = (c) => {
      if (!result.includes(c)) result.push(c);
      for (const p of c.parentDefs || []) visit(p);
    };
    visit(cd);
    if (!result.includes(ObjectClass)) result.push(ObjectClass);
    return result;
  }

  getMro(cd) {
    if (cd.isNative) return cd === ObjectClass ? [cd] : [cd, ObjectClass];
    return cd.mro;
  }

  registerClasses(program) {
    for (const stmt of program.body) {
      if (stmt.kind === 'Class') {
        if (this.classes.has(stmt.name)) throw new WoolanError("duplicate class '" + stmt.name + "'");
        this.classes.set(stmt.name, new ClassDef(stmt));
      }
    }
    for (const stmt of program.body) {
      if (stmt.kind === 'Class') {
        const cd = this.classes.get(stmt.name);
        cd.parentDefs = stmt.parents.map(p => {
          const pname = typeof p === 'string' ? p : p.name;
          const pd = this.classes.get(pname);
          if (!pd) throw new WoolanError("unknown parent class '" + pname + "' (in " + stmt.name + ")");
          return pd;
        });
      }
    }
    for (const stmt of program.body) {
      if (stmt.kind === 'Class') {
        const cd = this.classes.get(stmt.name);
        cd.mro = this.linearize(cd);
      }
    }
  }

  // ====================================================================
  // imports
  // ====================================================================
  processImports(program) {
    for (const stmt of program.body) {
      if (stmt.kind === 'Import') {
        for (const name of stmt.names) this.importModule(name);
      }
    }
  }

  importModule(name) {
    if (this.loadedModules.has(name)) return;

    // Use shared module resolver
    const parseFn = (src) => {
      const { tokenize } = require('./lexer');
      const { parse } = require('./parser');
      return parse(tokenize(src));
    };

    const result = resolveImport(name, this.baseDir, this.projectRoot, parseFn);

    if (!result) {
      const modulePath = name.replace(/\./g, path.sep);
      const candidate = path.join(this.baseDir, modulePath + '.woo');
      throw new WoolanError("cannot find module '" + name + "' (no file at " + candidate + " and no package '" + name + "' found)");
    }

    if (result.type === 'file') {
      this.loadModuleFile(name, result.path);
    } else if (result.type === 'package') {
      this.loadedModules.add(name);
      for (const filePath of result.paths) {
        this.loadModuleFile(name + ':' + filePath, filePath);
      }
    }
  }

  loadModuleFile(name, filePath) {
    if (this.loadedModules.has(name)) return;
    this.loadedModules.add(name);
    const src = fs.readFileSync(filePath, 'utf8');
    const { tokenize } = require('./lexer');
    const { parse } = require('./parser');
    const ast = parse(tokenize(src));
    // Temporarily set baseDir to the module's directory for relative imports
    const savedBaseDir = this.baseDir;
    this.baseDir = path.dirname(filePath);
    this.processImports(ast);     // nested imports first
    this.registerClasses(ast);    // register this module's classes
    this.baseDir = savedBaseDir;  // Restore baseDir
    // top-level statements of imported modules are not executed
  }

  // ====================================================================
  // builtins
  // ====================================================================
  loadBuiltins() {
    const builtinDir = path.join(this.baseDir, 'builtin');
    if (!fs.existsSync(builtinDir)) return;
    const { tokenize } = require('./lexer');
    const { parse } = require('./parser');
    for (const f of fs.readdirSync(builtinDir).filter(n => n.endsWith('.woo'))) {
      const name = f.slice(0, -4);
      if (this.classes.has(name) || this.loadedModules.has(name)) continue;
      const src = fs.readFileSync(path.join(builtinDir, f), 'utf8');
      const ast = parse(tokenize(src));
      this.processImports(ast);
      this.registerClasses(ast);
      this.loadedModules.add(name);
    }
  }

  // ====================================================================
  // run
  // ====================================================================
  run(program, baseDir) {
    this.baseDir = baseDir || this.baseDir;
    this.projectRoot = this.baseDir;  // Save project root (entry script directory)
    this.processImports(program);
    this.registerClasses(program);
    for (const stmt of program.body) {
      if (stmt.kind === 'Import' || stmt.kind === 'Package') continue;
      this.execStatement(stmt, this.globalEnv);
    }
  }

  // ====================================================================
  // statement execution
  // ====================================================================
  execStatement(node, env) {
    switch (node.kind) {
      case 'VarDecl': return this.execVarDecl(node, env);
      case 'Class': case 'Package': case 'Import': return;
      case 'ExprStmt': this.eval(node.expr, env); return;
      case 'Block': {
        const blockEnv = new Environment(env);
        for (const s of node.body) this.execStatement(s, blockEnv);
        return;
      }
      case 'If': return this.execIf(node, env);
      case 'For': return this.execFor(node, env);
      case 'While': return this.execWhile(node, env);
      case 'Return': throw new ReturnSignal(node.value ? this.eval(node.value, env) : null);
      case 'Break': throw new BreakSignal();
      case 'Continue': throw new ContinueSignal();
      default: throw new WoolanError('unknown statement kind: ' + node.kind);
    }
  }

  execVarDecl(node, env) {
    if (node.isArray) {
      const elemType = node.varType;
      const items = [];
      if (node.init) {
        if (node.init.kind === 'ArrayLit') {
          // Initialize with array literal: int[] arr = [1, 2, 3]
          for (const el of node.init.elements) {
            const v = this.eval(el, env);
            this.typeCheck(elemType, v);
            items.push(v);
          }
        } else if (node.init.kind === 'ArrayCtor') {
          // Initialize with array constructor: int[] arr = int[5]
          const sizeVal = this.eval(node.init.size, env);
          if (!(sizeVal instanceof Val) || sizeVal.type !== 'int') {
            throw new WoolanError('array size must be int');
          }
          const size = sizeVal.value;
          for (let i = 0; i < size; i++) {
            items.push(defaultValue(elemType));
          }
        } else {
          throw new WoolanError('array declaration requires array literal or constructor');
        }
      }
      // If no init, items is empty array
      env.define(node.name, elemType + '[]', this.makeArray(elemType, items));
      return;
    }
    let value;
    if (node.init) value = this.eval(node.init, env);
    else value = defaultValue(node.varType);
    this.typeCheck(node.varType, value);
    env.define(node.name, node.varType, value);
  }

  execIf(node, env) {
    if (this.truthy(this.eval(node.cond, env))) { this.execStatement(node.then, env); return; }
    for (const elif of node.elseifs) {
      if (this.truthy(this.eval(elif.cond, env))) { this.execStatement(elif.body, env); return; }
    }
    if (node.elseBody) this.execStatement(node.elseBody, env);
  }

  execFor(node, env) {
    const loopEnv = new Environment(env);
    if (node.init) this.execStatement(node.init, loopEnv);
    for (;;) {
      if (node.cond && !this.truthy(this.eval(node.cond, loopEnv))) break;
      try { this.execStatement(node.body, loopEnv); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) { /* fallthrough to update */ }
        else throw e;
      }
      if (node.update) this.eval(node.update, loopEnv);
    }
  }

  execWhile(node, env) {
    while (this.truthy(this.eval(node.cond, env))) {
      try { this.execStatement(node.body, env); }
      catch (e) {
        if (e instanceof BreakSignal) break;
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  }

  // ====================================================================
  // expression evaluation
  // ====================================================================
  eval(node, env) {
    switch (node.kind) {
      case 'IntLit': return makeInt(node.value);
      case 'FloatLit': return makeFloat(node.value);
      case 'CharLit': return makeChar(node.value);
      case 'StringLit': return this.makeString(node.value);
      case 'BoolLit': return makeBool(node.value);
      case 'NullLit': return null;
      case 'This': return env.get('this');
      case 'Ident': return this.evalIdent(node.name, env);
      case 'ArrayLit': {
        const items = node.elements.map(e => this.eval(e, env));
        return this.makeArray('Object', items);
      }
      case 'ArrayCtor': {
        // Array constructor: char[5], int[n], MyClass[size]
        const elemType = node.elemType;
        if (!node.size) throw new WoolanError('array size required');
        const sizeVal = this.eval(node.size, env);
        if (!(sizeVal instanceof Val) || sizeVal.type !== 'int') {
          throw new WoolanError('array size must be int');
        }
        const size = sizeVal.value;
        const items = [];
        for (let i = 0; i < size; i++) {
          items.push(defaultValue(elemType));
        }
        return this.makeArray(elemType, items);
      }
      case 'Field': return this.evalField(node, env);
      case 'Index': return this.evalIndex(node, env);
      case 'Call': return this.evalCall(node, env);
      case 'Unary': return this.evalUnary(node, env);
      case 'Binary': return this.evalBinary(node, env);
      case 'Assign': return this.evalAssign(node, env);
      default: throw new WoolanError('unknown expression kind: ' + node.kind);
    }
  }

  evalIdent(name, env) {
    if (env.has(name)) return env.get(name);
    if (this.classes.has(name)) return this.classes.get(name);
    throw new WoolanError("undefined identifier '" + name + "'");
  }

  evalField(node, env) {
    const obj = this.eval(node.object, env);
    if (obj === null) throw new WoolanError('NullPointerException: cannot access field ' + node.name + ' on null');
    if (obj instanceof WooInstance && !obj.classDef.isNative) {
      if (obj.fields.has(node.name)) return obj.fields.get(node.name);
      // could be a method referenced as a value -> not supported
      throw new WoolanError("no field '" + node.name + "' on " + obj.classDef.name);
    }
    throw new WoolanError('cannot access field ' + node.name + ' on ' + this.typeName(obj));
  }

  evalIndex(node, env) {
    const obj = this.eval(node.object, env);
    const idx = this.eval(node.index, env);
    if (!(idx instanceof Val) || idx.type !== 'int') throw new WoolanError('array index must be int');
    const i = idx.value;
    if (obj instanceof WooInstance) {
      const nc = obj.classDef;
      if (nc === ArrayClass) {
        if (i < 0 || i >= obj.native.length) throw new WoolanError('array index out of range: ' + i);
        return obj.native[i];
      }
      if (nc === ListClass) {
        if (i < 0 || i >= obj.native.length) throw new WoolanError('list index out of range: ' + i);
        return obj.native[i];
      }
      if (nc === StringClass) {
        if (i < 0 || i >= obj.native.length) throw new WoolanError('string index out of range: ' + i);
        return makeChar(obj.native[i]);
      }
    }
    throw new WoolanError('value is not indexable');
  }

  evalCall(node, env) {
    if (node.callee.kind === 'Field') {
      const obj = this.eval(node.callee.object, env);
      const args = node.args.map(a => this.eval(a, env));
      return this.callMethod(obj, node.callee.name, args);
    }
    const fn = this.eval(node.callee, env);
    const args = node.args.map(a => this.eval(a, env));
    if (fn instanceof ClassDef || fn instanceof NativeClass) return this.construct(fn, args);
    throw new WoolanError('value is not callable');
  }

  evalUnary(node, env) {
    const v = this.eval(node.operand, env);
    if (node.op === '-') {
      if (v instanceof Val && v.type === 'int') return makeInt(-v.value);
      if (v instanceof Val && v.type === 'float') return makeFloat(-v.value);
      throw new WoolanError("unary '-' requires int or float, got " + v.type);
    }
    if (node.op === '!') {
      if (v instanceof Val && v.type === 'bool') return makeBool(!v.value);
      throw new WoolanError("unary '!' requires bool, got " + (v ? v.type : 'null'));
    }
    throw new WoolanError('unknown unary operator ' + node.op);
  }

  evalBinary(node, env) {
    const op = node.op;
    if (op === '&&') {
      const l = this.eval(node.left, env);
      this.requireBool(l);
      if (!l.value) return makeBool(false);
      const r = this.eval(node.right, env);
      this.requireBool(r);
      return makeBool(r.value);
    }
    if (op === '||') {
      const l = this.eval(node.left, env);
      this.requireBool(l);
      if (l.value) return makeBool(true);
      const r = this.eval(node.right, env);
      this.requireBool(r);
      return makeBool(r.value);
    }

    const l = this.eval(node.left, env);
    const r = this.eval(node.right, env);

    if (op === '+' || op === '-' || op === '*' || op === '/') {
      if (l instanceof Val && r instanceof Val && l.type === 'int' && r.type === 'int') {
        let v;
        if (op === '+') v = l.value + r.value;
        else if (op === '-') v = l.value - r.value;
        else if (op === '*') v = l.value * r.value;
        else { if (r.value === 0) throw new WoolanError('division by zero'); v = Math.trunc(l.value / r.value); }
        return makeInt(Math.trunc(v));
      }
      if (l instanceof Val && r instanceof Val && l.type === 'float' && r.type === 'float') {
        let v;
        if (op === '+') v = l.value + r.value;
        else if (op === '-') v = l.value - r.value;
        else if (op === '*') v = l.value * r.value;
        else { if (r.value === 0) throw new WoolanError('division by zero'); v = l.value / r.value; }
        return makeFloat(v);
      }
      if (op === '+' && l instanceof WooInstance && l.classDef === StringClass
        && r instanceof WooInstance && r.classDef === StringClass) {
        return this.makeString(l.native + r.native);
      }
      throw new WoolanError("operator '" + op + "' not supported for types " + this.typeName(l) + ' and ' + this.typeName(r)
        + ' (no automatic type conversion)');
    }

    // modulo operator: only between ints, result is int
    if (op === '%') {
      if (l instanceof Val && r instanceof Val && l.type === 'int' && r.type === 'int') {
        if (r.value === 0) throw new WoolanError('modulo by zero');
        return makeInt(l.value % r.value);
      }
      throw new WoolanError("operator '%' requires two int operands");
    }

    if (op === '==' || op === '!=') {
      const eq = this.equals(l, r);
      return makeBool(op === '==' ? eq : !eq);
    }

    if (op === '<' || op === '>' || op === '<=' || op === '>=') {
      if (l instanceof Val && r instanceof Val && l.type === r.type && (l.type === 'int' || l.type === 'float')) {
        let res;
        if (op === '<') res = l.value < r.value;
        else if (op === '>') res = l.value > r.value;
        else if (op === '<=') res = l.value <= r.value;
        else res = l.value >= r.value;
        return makeBool(res);
      }
      throw new WoolanError("operator '" + op + "' requires two int or two float operands");
    }

    throw new WoolanError('unknown binary operator ' + op);
  }

  equals(l, r) {
    if (l === null && r === null) return true;
    if (l === null || r === null) return false;
    if (l instanceof Val && r instanceof Val) {
      if (l.type !== r.type) throw new WoolanError("cannot compare " + l.type + " with " + r.type);
      return l.value === r.value;
    }
    if (l instanceof WooInstance && l.classDef === StringClass && r instanceof WooInstance && r.classDef === StringClass) {
      return l.native === r.native;
    }
    if (l instanceof WooInstance && r instanceof WooInstance) return l === r; // reference equality
    throw new WoolanError('incomparable types ' + this.typeName(l) + ' and ' + this.typeName(r));
  }

  evalAssign(node, env) {
    const target = node.target;
    if (target.kind === 'Ident') {
      const value = this.eval(node.value, env);
      env.assign(target.name, value, (t, v) => this.typeCheck(t, v));
      return value;
    }
    if (target.kind === 'Field') {
      const obj = this.eval(target.object, env);
      if (obj === null) throw new WoolanError('NullPointerException: cannot assign field ' + target.name + ' on null');
      if (!(obj instanceof WooInstance) || obj.classDef.isNative) {
        throw new WoolanError('cannot assign field on ' + this.typeName(obj));
      }
      const value = this.eval(node.value, env);
      const ftype = this.fieldType(obj.classDef, target.name);
      if (ftype) this.typeCheck(ftype, value);
      obj.fields.set(target.name, value);
      return value;
    }
    if (target.kind === 'Index') {
      const obj = this.eval(target.object, env);
      const idx = this.eval(target.index, env);
      if (!(idx instanceof Val) || idx.type !== 'int') throw new WoolanError('array index must be int');
      const i = idx.value;
      const value = this.eval(node.value, env);
      if (obj instanceof WooInstance) {
        if (obj.classDef === ArrayClass) {
          if (i < 0 || i >= obj.native.length) throw new WoolanError('array index out of range: ' + i);
          this.typeCheck(obj.elemType, value);
          obj.native[i] = value;
          return value;
        }
        if (obj.classDef === ListClass) {
          if (i < 0 || i >= obj.native.length) throw new WoolanError('list index out of range: ' + i);
          obj.native[i] = value;
          return value;
        }
      }
      throw new WoolanError('cannot index-assign on this value');
    }
    throw new WoolanError('invalid assignment target');
  }

  // ====================================================================
  // type checking
  // ====================================================================
  typeCheck(declaredType, value) {
    if (declaredType === '__any__' || declaredType === 'void') return;
    if (declaredType.endsWith('[]')) {
      const elemType = declaredType.slice(0, -2);
      if (!(value instanceof WooInstance) || value.classDef !== ArrayClass) {
        throw new WoolanError('expected array of ' + elemType + ', got ' + this.typeName(value));
      }
      if (value.elemType !== elemType && value.elemType !== 'Object') {
        // allow Object arrays to coerce loosely; otherwise strict
      }
      return;
    }
    if (PRIMITIVE_TYPES.has(declaredType)) {
      if (value instanceof Val && value.type === declaredType) return;
      throw new WoolanError('expected ' + declaredType + ', got ' + this.typeName(value));
    }
    // class type
    if (value === null) return;
    if (value instanceof WooInstance) {
      const cls = this.classes.get(declaredType);
      if (!cls) throw new WoolanError('unknown type ' + declaredType);
      if (this.isInstanceOf(value, cls)) return;
      throw new WoolanError('expected ' + declaredType + ', got ' + value.classDef.name);
    }
    throw new WoolanError('expected ' + declaredType + ', got ' + this.typeName(value));
  }

  typeName(v) {
    if (v === null) return 'null';
    if (v instanceof Val) return v.type;
    if (v instanceof WooInstance) return v.classDef.name;
    return typeof v;
  }

  requireBool(v) {
    if (!(v instanceof Val && v.type === 'bool')) throw new WoolanError('expected bool, got ' + this.typeName(v));
  }
  truthy(v) {
    this.requireBool(v);
    return v.value;
  }

  isInstanceOf(obj, cls) {
    if (!(obj instanceof WooInstance)) return false;
    return this.getMro(obj.classDef).includes(cls);
  }

  // declared type of a field (searching the class hierarchy)
  fieldType(classDef, name) {
    for (const c of this.getMro(classDef)) {
      if (c.isNative) continue;
      const f = c.ownFields.find(f => f.name === name);
      if (f) return f.varType;
    }
    return null;
  }

  // ====================================================================
  // method lookup & invocation
  // ====================================================================
  lookupMethod(classDef, name) {
    for (const c of this.getMro(classDef)) {
      if (c.isNative) {
        if (c.methods.has(name)) return { kind: 'Native', fn: c.methods.get(name) };
      } else {
        if (c.ownMethods.has(name)) return c.ownMethods.get(name);
      }
    }
    return null;
  }

  callMethod(obj, name, args) {
    if (obj === null) throw new WoolanError('NullPointerException: cannot call ' + name + ' on null');
    if (!(obj instanceof WooInstance)) throw new WoolanError('cannot call method ' + name + ' on ' + this.typeName(obj));
    const m = this.lookupMethod(obj.classDef, name);
    if (!m) throw new WoolanError("no method '" + name + "' on " + obj.classDef.name);
    if (m.kind === 'Native') return m.fn(this, obj, args);
    if (m.body === null) throw new WoolanError("method '" + name + "' is not implemented on " + obj.classDef.name);
    return this.invokeUserMethod(m, obj, args);
  }

  invokeUserMethod(methodAst, instance, args) {
    const env = new Environment(this.globalEnv);
    env.define('this', instance.classDef.name, instance);
    for (let i = 0; i < methodAst.params.length; i++) {
      const p = methodAst.params[i];
      const v = i < args.length ? args[i] : defaultValue(p.type);
      this.typeCheck(p.type, v);
      env.define(p.name, p.type, v);
    }
    try {
      for (const stmt of methodAst.body.body) this.execStatement(stmt, env);
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value;
      throw e;
    }
    // Constructor automatically returns 'this'
    if (methodAst.isConstructor) return instance;
    return null;
  }

  // ====================================================================
  // construction
  // ====================================================================
  construct(classValue, args, constructing = new Set()) {
    if (classValue instanceof NativeClass) {
      if (classValue.construct) return classValue.construct(this, args);
      return new WooInstance(classValue);
    }
    // user class
    const inst = new WooInstance(classValue);
    const guard = new Set(constructing);
    guard.add(classValue.name);
    this.initFields(inst, classValue, guard);
    const init = this.lookupMethod(classValue, 'init');
    if (init && init.kind !== 'Native') {
      this.invokeUserMethod(init, inst, args);
    }
    return inst;
  }

  initFields(inst, classDef, constructing = new Set()) {
    const env = new Environment(this.globalEnv);
    env.define('this', classDef.name, inst);
    // base -> derived so derived initializers may reference base fields
    const chain = this.getMro(classDef).slice().reverse();
    for (const c of chain) {
      if (c.isNative) continue;
      for (const f of c.ownFields) {
        let value;
        if (f.init) {
          value = this.eval(f.init, env);
        } else if (PRIMITIVE_TYPES.has(f.varType)) {
          value = defaultValue(f.varType);
        } else {
          // class-typed field without initializer: auto-construct (C++ style),
          // so creating the object fully initializes its members.
          value = this.autoConstructField(f.varType, constructing);
        }
        this.typeCheck(f.varType, value);
        inst.fields.set(f.name, value);
      }
    }
  }

  // auto-construct a class-typed field via its no-arg constructor.
  // returns null if the type is unknown, would recurse, or construction fails.
  autoConstructField(typeName, constructing) {
    const cls = this.classes.get(typeName);
    if (!cls) return null;
    if (constructing.has(typeName)) return null; // prevent infinite recursion
    try {
      return this.construct(cls, [], constructing);
    } catch (e) {
      return null;
    }
  }

  // expose toDisplay for external use (e.g. REPL / debugging)
  display(v) { return toDisplay(this, v); }
}

module.exports = { Interpreter, WoolanError, ReturnSignal, BreakSignal, ContinueSignal, ClassDef, Environment };
