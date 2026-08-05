// values.js - Woolan value model & type system
//
// Runtime values:
//   - null                          -> null reference
//   - WooInstance                   -> object instance (user or builtin class)
//   - Val                           -> tagged primitive { type, value }
//
// Primitive types: 'int', 'float', 'bool', 'char'
// Reference types: class instances (default null)

'use strict';

const PRIMITIVE_TYPES = new Set(['int', 'float', 'bool', 'char', 'void']);

// Default value for a declared type (fields / uninitialized vars)
function defaultValue(typeName) {
  switch (typeName) {
    case 'int': return new Val('int', 0);
    case 'float': return new Val('float', 0);
    case 'bool': return new Val('bool', false);
    case 'char': return new Val('char', '');
    case 'void': return null;
    default: return null; // reference types default to null
  }
}

// Tagged primitive value
class Val {
  constructor(type, value) {
    this.type = type; // 'int' | 'float' | 'bool' | 'char'
    this.value = value;
  }
  toString() {
    if (this.type === 'char') return this.value;
    if (this.type === 'bool') return this.value ? 'true' : 'false';
    if (this.type === 'float') {
      // keep a visible fractional form like 13.5 / 13.0
      const s = String(this.value);
      return s.includes('.') ? s : s + '.0';
    }
    return String(this.value);
  }
}

// An object instance. classDef is a ClassDef (user class) or NativeClass.
class WooInstance {
  constructor(classDef) {
    this.classDef = classDef;
    this.fields = new Map();   // name -> value (user fields)
    this.native = null;        // raw JS payload for builtin classes (String/List/...)
  }
}

// ---- factories ----
const makeInt = (v) => new Val('int', Math.trunc(v));
const makeFloat = (v) => new Val('float', v);
const makeBool = (v) => new Val('bool', !!v);
const makeChar = (v) => new Val('char', v);

// Get the runtime type name of a value.
function valType(v) {
  if (v === null) return 'null';
  if (v instanceof WooInstance) return v.classDef.name;
  if (v instanceof Val) return v.type;
  return 'unknown';
}

function isPrimitive(v, t) { return v instanceof Val && v.type === t; }
function isObject(v) { return v instanceof WooInstance; }

// Unwrap a value to a JS primitive (for native interop / printing)
function unwrap(v) {
  if (v === null) return null;
  if (v instanceof Val) return v.value;
  if (v instanceof WooInstance) return v.native;
  return v;
}

module.exports = {
  PRIMITIVE_TYPES,
  defaultValue,
  Val,
  WooInstance,
  makeInt, makeFloat, makeBool, makeChar,
  valType, isPrimitive, isObject, unwrap,
};
