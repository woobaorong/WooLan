// builtins.js - Built-in classes (Object, String, List, Map, Set, Date, File,
// HttpRequest) and the `sys` object.
//
// Native methods have signature: function(interp, inst, args) -> woolan value
// `inst` is a WooInstance whose `.native` holds the raw JS payload.

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const { Val, WooInstance, makeInt, makeFloat, makeBool, makeChar } = require('./values');

class NativeClass {
  constructor(name, methods, opts = {}) {
    this.name = name;
    this.aliases = opts.aliases || [];
    this.methods = new Map(Object.entries(methods));
    this.construct = opts.construct || null;
    this.isNative = true;
  }
}

// ---- helpers ----
function asJsString(v) {
  if (v instanceof WooInstance && v.classDef === StringClass) return v.native;
  if (v instanceof Val && v.type === 'char') return v.value;
  throw new TypeError('expected String or char, got ' + (v === null ? 'null' : (v.classDef ? v.classDef.name : v.type)));
}
function asInt(v) {
  if (v instanceof Val && v.type === 'int') return v.value;
  if (v instanceof Val && v.type === 'float') return Math.trunc(v.value);
  throw new TypeError('expected int');
}
function asFloat(v) {
  if (v instanceof Val && v.type === 'float') return v.value;
  if (v instanceof Val && v.type === 'int') return v.value;
  throw new TypeError('expected float');
}

// value-based key for Map/Set (primitives & strings by value, objects by identity)
function mapKey(v) {
  if (v === null) return '\0null';
  if (v instanceof Val) return v.type + ':' + v.value;
  if (v instanceof WooInstance && v.classDef === StringClass) return 'str:' + v.native;
  return v;
}

// asynchronous HTTP request; invokes cb.onResponse(bodyString) on completion
function httpRequestAsync(interp, cfg, cb) {
  let url;
  try { url = new URL(cfg.url); } catch (e) { throw new Error('HttpRequest.send: invalid url ' + cfg.url); }
  const lib = url.protocol === 'https:' ? https : http;
  const headers = {};
  for (const [k, v] of cfg.headers) headers[k] = v;
  const options = {
    method: cfg.method || 'GET',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers,
  };
  const fail = () => { try { interp.callMethod(cb, 'onResponse', [interp.makeString('')]); } catch (e) { /* swallow */ } };
  let req;
  try {
    req = lib.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { interp.callMethod(cb, 'onResponse', [interp.makeString(data)]); }
        catch (e) { process.stderr.write('Error in HttpCallbacker.onResponse: ' + (e && e.message || e) + '\n'); }
      });
    });
    req.on('error', fail);
    if (cfg.body != null) req.write(cfg.body);
    req.end();
  } catch (e) { fail(); }
}

// =====================================================================
// Array (internal, for fixed-length typed arrays int[3] / char[3] / ...)
// Not directly instantiable by users; created via array literals.
// native = JS array; instance.elemType holds the declared element type.
// =====================================================================
const ArrayClass = new NativeClass('Array', {
  size(interp, inst) { return makeInt(inst.native.length); },
  toString(interp, inst) {
    return interp.makeString('[' + inst.native.map(x => toDisplay(interp, x)).join(', ') + ']');
  },
});

// =====================================================================
// Object
// =====================================================================
const ObjectClass = new NativeClass('Object', {
  toString(interp, inst) { return interp.makeString(inst.classDef.name); },
  equals(interp, inst, args) { return makeBool(inst === args[0]); },
  getClass(interp, inst) { return interp.makeString(inst.classDef.name); },
});

// =====================================================================
// String (alias: str)
// =====================================================================
const StringClass = new NativeClass('String', {
  length(interp, inst) { return makeInt(inst.native.length); },
  charAt(interp, inst, args) {
    const i = asInt(args[0]);
    if (i < 0 || i >= inst.native.length) throw new RangeError('String index out of range: ' + i);
    return makeChar(inst.native[i]);
  },
  substring(interp, inst, args) {
    const s = inst.native;
    const start = asInt(args[0]);
    const end = args.length > 1 ? asInt(args[1]) : s.length;
    return interp.makeString(s.slice(start, end));
  },
  indexOf(interp, inst, args) { return makeInt(inst.native.indexOf(asJsString(args[0]))); },
  equals(interp, inst, args) {
    const o = args[0];
    return makeBool(o instanceof WooInstance && o.classDef === StringClass && o.native === inst.native);
  },
  toLowerCase(interp, inst) { return interp.makeString(inst.native.toLowerCase()); },
  toUpperCase(interp, inst) { return interp.makeString(inst.native.toUpperCase()); },
  startsWith(interp, inst, args) { return makeBool(inst.native.startsWith(asJsString(args[0]))); },
  endsWith(interp, inst, args) { return makeBool(inst.native.endsWith(asJsString(args[0]))); },
  contains(interp, inst, args) { return makeBool(inst.native.includes(asJsString(args[0]))); },
  replace(interp, inst, args) {
    return interp.makeString(inst.native.split(asJsString(args[0])).join(asJsString(args[1])));
  },
  split(interp, inst, args) {
    const parts = inst.native.split(asJsString(args[0]));
    return interp.makeList(parts.map(p => interp.makeString(p)));
  },
  trim(interp, inst) { return interp.makeString(inst.native.trim()); },
  toInt(interp, inst) { return makeInt(parseInt(inst.native, 10) || 0); },
  toFloat(interp, inst) { return makeFloat(parseFloat(inst.native) || 0); },
  toString(interp, inst) { return interp.makeString(inst.native); },
}, {
  construct(interp, args) {
    if (args.length === 0) return interp.makeString('');
    const a = args[0];
    if (a instanceof WooInstance && a.classDef === StringClass) return interp.makeString(a.native);
    if (a instanceof Val && a.type === 'char') return interp.makeString(a.value);
    throw new TypeError('String() expects String or char');
  },
});

// =====================================================================
// List (alias: list)
// =====================================================================
const ListClass = new NativeClass('List', {
  add(interp, inst, args) { inst.native.push(args[0]); return null; },
  get(interp, inst, args) {
    const i = asInt(args[0]);
    if (i < 0 || i >= inst.native.length) throw new RangeError('List index out of range: ' + i);
    return inst.native[i];
  },
  set(interp, inst, args) { inst.native[asInt(args[0])] = args[1]; return null; },
  size(interp, inst) { return makeInt(inst.native.length); },
  removeAt(interp, inst, args) { return inst.native.splice(asInt(args[0]), 1)[0]; },
  clear(interp, inst) { inst.native.length = 0; return null; },
  isEmpty(interp, inst) { return makeBool(inst.native.length === 0); },
  indexOf(interp, inst, args) {
    const k = mapKey(args[0]);
    for (let i = 0; i < inst.native.length; i++) if (mapKey(inst.native[i]) === k) return makeInt(i);
    return makeInt(-1);
  },
  contains(interp, inst, args) {
    const k = mapKey(args[0]);
    return makeBool(inst.native.some(x => mapKey(x) === k));
  },
  toString(interp, inst) {
    return interp.makeString('[' + inst.native.map(x => toDisplay(interp, x)).join(', ') + ']');
  },
}, {
  construct(interp) { return interp.makeList([]); },
});

// =====================================================================
// Map (alias: map) — parallel arrays keyed by mapKey() for value equality
// =====================================================================
const MapClass = new NativeClass('Map', {
  put(interp, inst, args) {
    const k = mapKey(args[0]);
    for (let i = 0; i < inst.native.keys.length; i++) {
      if (inst.native.keys[i] === k) { inst.native.vals[i] = args[1]; inst.native.origKeys[i] = args[0]; return null; }
    }
    inst.native.keys.push(k);
    inst.native.vals.push(args[1]);
    inst.native.origKeys.push(args[0]);
    return null;
  },
  get(interp, inst, args) {
    const k = mapKey(args[0]);
    for (let i = 0; i < inst.native.keys.length; i++) if (inst.native.keys[i] === k) return inst.native.vals[i];
    return null;
  },
  remove(interp, inst, args) {
    const k = mapKey(args[0]);
    for (let i = 0; i < inst.native.keys.length; i++) {
      if (inst.native.keys[i] === k) {
        inst.native.keys.splice(i, 1);
        const v = inst.native.vals.splice(i, 1)[0];
        inst.native.origKeys.splice(i, 1);
        return v;
      }
    }
    return null;
  },
  containsKey(interp, inst, args) {
    const k = mapKey(args[0]);
    return makeBool(inst.native.keys.some(x => x === k));
  },
  size(interp, inst) { return makeInt(inst.native.keys.length); },
  keys(interp, inst) { return interp.makeList(inst.native.origKeys.slice()); },
  values(interp, inst) { return interp.makeList(inst.native.vals.slice()); },
  clear(interp, inst) { inst.native.keys.length = 0; inst.native.vals.length = 0; inst.native.origKeys.length = 0; return null; },
  toString(interp, inst) {
    const parts = [];
    for (let i = 0; i < inst.native.keys.length; i++) {
      parts.push(toDisplay(interp, inst.native.origKeys[i]) + ': ' + toDisplay(interp, inst.native.vals[i]));
    }
    return interp.makeString('{' + parts.join(', ') + '}');
  },
}, {
  construct(interp) { return interp.makeMap({ keys: [], vals: [], origKeys: [] }); },
});

// =====================================================================
// Set
// =====================================================================
const SetClass = new NativeClass('Set', {
  add(interp, inst, args) {
    const k = mapKey(args[0]);
    if (!inst.native.set.has(k)) { inst.native.set.add(k); inst.native.items.push(args[0]); }
    return null;
  },
  contains(interp, inst, args) { return makeBool(inst.native.set.has(mapKey(args[0]))); },
  remove(interp, inst, args) {
    const k = mapKey(args[0]);
    if (inst.native.set.has(k)) {
      inst.native.set.delete(k);
      const idx = inst.native.items.findIndex(x => mapKey(x) === k);
      if (idx >= 0) inst.native.items.splice(idx, 1);
    }
    return null;
  },
  size(interp, inst) { return makeInt(inst.native.set.size); },
  clear(interp, inst) { inst.native.set.clear(); inst.native.items.length = 0; return null; },
  toList(interp, inst) { return interp.makeList(inst.native.items.slice()); },
  toString(interp, inst) {
    return interp.makeString('{' + inst.native.items.map(x => toDisplay(interp, x)).join(', ') + '}');
  },
}, {
  construct(interp) { return interp.makeSet({ set: new Set(), items: [] }); },
});

// =====================================================================
// Date
// =====================================================================
const DateClass = new NativeClass('Date', {
  now(interp, inst) { return makeInt(Date.now()); },
  getYear(interp, inst) { return makeInt(inst.native.getFullYear()); },
  getMonth(interp, inst) { return makeInt(inst.native.getMonth() + 1); },
  getDay(interp, inst) { return makeInt(inst.native.getDate()); },
  getHours(interp, inst) { return makeInt(inst.native.getHours()); },
  getMinutes(interp, inst) { return makeInt(inst.native.getMinutes()); },
  getSeconds(interp, inst) { return makeInt(inst.native.getSeconds()); },
  format(interp, inst, args) {
    const fmt = asJsString(args[0]);
    const d = inst.native;
    const pad = (n) => String(n).padStart(2, '0');
    const out = fmt
      .replace('YYYY', d.getFullYear())
      .replace('MM', pad(d.getMonth() + 1))
      .replace('DD', pad(d.getDate()))
      .replace('HH', pad(d.getHours()))
      .replace('mm', pad(d.getMinutes()))
      .replace('ss', pad(d.getSeconds()));
    return interp.makeString(out);
  },
  toString(interp, inst) { return interp.makeString(String(inst.native)); },
}, {
  construct(interp, args) {
    const d = args.length > 0 ? new Date(asInt(args[0])) : new Date();
    return interp.makeDate(d);
  },
});

// =====================================================================
// File
// =====================================================================
const FileClass = new NativeClass('File', {
  read(interp, inst) { return interp.makeString(fs.readFileSync(inst.native, 'utf8')); },
  write(interp, inst, args) { fs.writeFileSync(inst.native, asJsString(args[0]), 'utf8'); return null; },
  append(interp, inst, args) { fs.appendFileSync(inst.native, asJsString(args[0]), 'utf8'); return null; },
  exists(interp, inst) { return makeBool(fs.existsSync(inst.native)); },
  delete(interp, inst) { fs.unlinkSync(inst.native); return null; },
  size(interp, inst) { return makeInt(fs.statSync(inst.native).size); },
}, {
  construct(interp, args) {
    if (args.length === 0) throw new TypeError('File() requires a path');
    return interp.makeFile(asJsString(args[0]));
  },
});

// =====================================================================
// HttpRequest (synchronous, best-effort via curl)
// =====================================================================
const HttpRequestClass = new NativeClass('HttpRequest', {
  setUrl(interp, inst, args) { inst.native.url = asJsString(args[0]); return null; },
  setMethod(interp, inst, args) { inst.native.method = asJsString(args[0]); return null; },
  setHeader(interp, inst, args) { inst.native.headers.push([asJsString(args[0]), asJsString(args[1])]); return null; },
  setBody(interp, inst, args) { inst.native.body = asJsString(args[0]); return null; },
  send(interp, inst, args) {
    const cfg = inst.native;
    // async mode: send(HttpCallbacker) -> calls cb.onResponse(body) when done
    const cb = args && args.length > 0 && args[0] instanceof WooInstance ? args[0] : null;
    if (cb) { httpRequestAsync(interp, cfg, cb); return null; }
    // sync mode: send() -> returns body (best-effort via curl)
    const cargs = ['-s', '-X', cfg.method || 'GET'];
    for (const [k, v] of cfg.headers) cargs.push('-H', k + ': ' + v);
    if (cfg.body != null) cargs.push('-d', cfg.body);
    cargs.push(cfg.url);
    let out;
    try { out = execFileSync('curl', cargs, { encoding: 'utf8' }); }
    catch (e) { throw new Error('HttpRequest.send failed (is curl installed?): ' + e.message); }
    return interp.makeString(out);
  },
}, {
  construct(interp) { return interp.makeHttp({ url: '', method: 'GET', headers: [], body: null }); },
});

// =====================================================================
// sys object
// =====================================================================
const SysClass = new NativeClass('sys', {
  print(interp, inst, args) {
    if (args.length > 0) process.stdout.write(toDisplay(interp, args[0]));
    return null;
  },
  println(interp, inst, args) {
    process.stdout.write((args.length ? toDisplay(interp, args[0]) : '') + '\n');
    return null;
  },
  wait(interp, inst, args) {
    // sys.wait(TimeCallbacker, ms): asynchronously call cb.onTime() after ms milliseconds.
    const cb = args[0];
    const ms = args.length > 1 ? asInt(args[1]) : 0;
    setTimeout(() => {
      try { interp.callMethod(cb, 'onTime', []); }
      catch (e) { process.stderr.write('Error in TimeCallbacker.onTime: ' + (e && e.message || e) + '\n'); }
    }, ms);
    return null;
  },
  str2int(interp, inst, args) { return makeInt(parseInt(asJsString(args[0]), 10) || 0); },
  str2float(interp, inst, args) { return makeFloat(parseFloat(asJsString(args[0])) || 0); },
  char2str(interp, inst, args) {
    if (args[0] instanceof Val && args[0].type === 'char') return interp.makeString(args[0].value);
    throw new TypeError('expected char');
  },
  int2str(interp, inst, args) { return interp.makeString(String(asInt(args[0]))); },
  int2float(interp, inst, args) { return makeFloat(asInt(args[0])); },
  float2int(interp, inst, args) { return makeInt(Math.trunc(asFloat(args[0]))); },
  float2str(interp, inst, args) {
    const s = String(asFloat(args[0]));
    return interp.makeString(s.includes('.') ? s : s + '.0');
  },
  bool2str(interp, inst, args) {
    if (args[0] instanceof Val && args[0].type === 'bool') return interp.makeString(args[0].value ? 'true' : 'false');
    throw new TypeError('expected bool');
  },
  is(interp, inst, args) {
    const cls = args[0];
    const obj = args[1];
    if (obj === null || !(obj instanceof WooInstance)) return makeBool(false);
    if (!cls || !(cls.isNative || cls.name)) return makeBool(false);
    return makeBool(interp.isInstanceOf(obj, cls));
  },
  exit(interp, inst, args) { process.exit(args.length ? asInt(args[0]) : 0); return null; },

  // ---- char[] <-> String bridge (for String.woo implementation) ----
  // Convert a Woolan String to a char[] array
  strToCharArray(interp, inst, args) {
    const s = asJsString(args[0]);
    const chars = [];
    for (let i = 0; i < s.length; i++) chars.push(makeChar(s[i]));
    return interp.makeArray('char', chars);
  },
  // Convert a char[] array back to a Woolan String
  charArrayToStr(interp, inst, args) {
    const arr = args[0];
    if (arr instanceof WooInstance && arr.classDef === ArrayClass) {
      let s = '';
      for (const c of arr.native) {
        if (c instanceof Val && c.type === 'char') s += c.value;
        else s += toDisplay(interp, c);
      }
      return interp.makeString(s);
    }
    throw new TypeError('expected char[]');
  },
});

// =====================================================================
// Display a woolan value as a JS string
// =====================================================================
function toDisplay(interp, v) {
  if (v === null) return 'null';
  if (v instanceof Val) return v.toString();
  if (v instanceof WooInstance) {
    const nc = v.classDef;
    if (nc === ArrayClass) return '[' + v.native.map(x => toDisplay(interp, x)).join(', ') + ']';
    if (nc === StringClass) return v.native;
    if (nc === ListClass) return '[' + v.native.map(x => toDisplay(interp, x)).join(', ') + ']';
    if (nc === SetClass) return '{' + v.native.items.map(x => toDisplay(interp, x)).join(', ') + '}';
    if (nc === DateClass) return String(v.native);
    if (nc === MapClass) {
      const parts = [];
      for (let i = 0; i < v.native.keys.length; i++) parts.push(toDisplay(interp, v.native.origKeys[i]) + ': ' + toDisplay(interp, v.native.vals[i]));
      return '{' + parts.join(', ') + '}';
    }
    // user class: call toString() if the user defined it
    const m = interp.lookupMethod(nc, 'toString');
    if (m && m.kind === 'Method') {
      const r = interp.callMethod(v, 'toString', []);
      if (r instanceof WooInstance && r.classDef === StringClass) return r.native;
      return toDisplay(interp, r);
    }
    return nc.name;
  }
  return String(v);
}

// =====================================================================
// Registration
// =====================================================================
const ALL_CLASSES = [ObjectClass, StringClass, ListClass, MapClass, SetClass, DateClass, FileClass, HttpRequestClass];

function registerBuiltins(interp) {
  for (const nc of ALL_CLASSES) {
    interp.classes.set(nc.name, nc);
    for (const a of nc.aliases) interp.classes.set(a, nc);
  }
  interp.classes.set('sys', SysClass);
  const sys = new WooInstance(SysClass);
  interp.defineGlobal('sys', sys);
}

module.exports = {
  NativeClass,
  registerBuiltins,
  toDisplay,
  ObjectClass, StringClass, ListClass, MapClass, SetClass, DateClass, FileClass, HttpRequestClass, SysClass, ArrayClass,
  asJsString, asInt, asFloat, mapKey,
};
