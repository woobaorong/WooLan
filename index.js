#!/usr/bin/env node
// index.js - Woolan command-line entry point.
//
// Usage:
//   node index.js <file.woo>          run a Woolan script
//   node index.js -e "<source code>"  evaluate a source string

'use strict';

const fs = require('fs');
const path = require('path');
const { tokenize, LexerError } = require('./src/lexer');
const { parse, ParseError } = require('./src/parser');
const { Interpreter, WoolanError } = require('./src/interpreter');

function runSource(src, baseDir) {
  const tokens = tokenize(src);
  const ast = parse(tokens);
  const interp = new Interpreter();
  interp.run(ast, baseDir);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Woolan 0.1.0\nUsage: node index.js <file.woo>\n       node index.js -e "<source>"\n');
    process.exit(1);
  }

  let src, baseDir;
  if (args[0] === '-e') {
    src = args[1] || '';
    baseDir = process.cwd();
  } else {
    const file = path.resolve(args[0]);
    if (!fs.existsSync(file)) {
      process.stderr.write('Error: file not found: ' + file + '\n');
      process.exit(1);
    }
    src = fs.readFileSync(file, 'utf8');
    baseDir = path.dirname(file);
  }

  try {
    runSource(src, baseDir);
  } catch (e) {
    if (e instanceof LexerError || e instanceof ParseError) {
      process.stderr.write(e.message + '\n');
    } else if (e instanceof WoolanError) {
      process.stderr.write('RuntimeError: ' + e.message + '\n');
    } else if (e instanceof TypeError || e instanceof RangeError) {
      process.stderr.write('RuntimeError: ' + e.message + '\n');
    } else {
      process.stderr.write((e.stack || e.message || String(e)) + '\n');
    }
    process.exit(1);
  }
}

main();
