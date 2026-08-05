// parser.js - Recursive-descent parser for Woolan.
//
// Produces an AST of plain objects tagged with `kind`. Every node carries
// `line` / `col` (1-based) of its first token, for diagnostics.

'use strict';

const { Token } = require('./lexer');

class ParseError extends Error {
  constructor(msg, tok) {
    super(`ParseError at ${tok ? tok.line + ':' + tok.col : '?'} - ${msg}`);
    this.tok = tok;
    this.line = tok ? tok.line : undefined;
    this.col = tok ? tok.col : undefined;
  }
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }

  // ---- token helpers ----
  peek(off = 0) { return this.tokens[this.pos + off]; }
  at(type, value) {
    const t = this.tokens[this.pos];
    if (!t || t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  atKw(kw) { return this.at('KEYWORD', kw); }
  atPunct(p) { return this.at('PUNCT', p); }
  atOp(o) { return this.at('OP', o); }
  advance() { return this.tokens[this.pos++]; }
  here() { const t = this.peek(); return { line: t ? t.line : 1, col: t ? t.col : 1 }; }
  eat(type, value) {
    const t = this.tokens[this.pos];
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError(`expected ${type}${value !== undefined ? ' ' + JSON.stringify(value) : ''} but got ${t ? t.type + ' ' + JSON.stringify(t.value) : 'EOF'}`, t);
    }
    return this.tokens[this.pos++];
  }
  eatKw(kw) { return this.eat('KEYWORD', kw); }
  eatPunct(p) { return this.eat('PUNCT', p); }
  skipNL() { while (this.at('NEWLINE')) this.advance(); }
  skipNLAndSemi() { while (this.at('NEWLINE') || this.atPunct(';')) this.advance(); }

  // attach position then return the node
  loc(node, tok) { node.line = tok ? tok.line : 1; node.col = tok ? tok.col : 1; return node; }

  // ---- entry ----
  parse() {
    const body = [];
    this.skipNL();
    while (!this.at('EOF')) {
      body.push(this.parseStatement());
      this.skipNLAndSemi();
    }
    return { kind: 'Program', body, line: 1, col: 1 };
  }

  // ---- statements ----
  parseStatement() {
    this.skipNL();
    if (this.atKw('package')) return this.parsePackage();
    if (this.atKw('import')) return this.parseImport();
    if (this.atKw('class')) return this.parseClass();
    if (this.atKw('if')) return this.parseIf();
    if (this.atKw('for')) return this.parseFor();
    if (this.atKw('while')) return this.parseWhile();
    if (this.atKw('return')) return this.parseReturn();
    if (this.atKw('break')) { const t = this.advance(); return this.loc({ kind: 'Break' }, t); }
    if (this.atKw('continue')) { const t = this.advance(); return this.loc({ kind: 'Continue' }, t); }
    if (this.atPunct('{')) return this.parseBlock();
    if (this.looksLikeVarDecl()) return this.parseVarDecl();
    const p = this.here();
    return this.loc({ kind: 'ExprStmt', expr: this.parseExpression() }, p);
  }

  parsePackage() {
    const t = this.eatKw('package');
    const name = this.eat('IDENT').value;
    return this.loc({ kind: 'Package', name }, t);
  }
  parseImport() {
    const t = this.eatKw('import');
    const names = [this.eat('IDENT').value];
    while (this.atPunct(',')) { this.advance(); names.push(this.eat('IDENT').value); }
    return this.loc({ kind: 'Import', names }, t);
  }

  // A var decl begins with: a type keyword; or IDENT IDENT; or IDENT '[' INT ']' IDENT
  looksLikeVarDecl() {
    const t0 = this.peek(0);
    if (!t0) return false;
    if (t0.type === 'KEYWORD' && ['int', 'float', 'bool', 'char', 'void'].includes(t0.value)) return true;
    if (t0.type === 'IDENT') {
      const t1 = this.peek(1);
      if (t1 && t1.type === 'IDENT') return true;
      if (t1 && t1.type === 'PUNCT' && t1.value === '[') {
        const t2 = this.peek(2), t3 = this.peek(3), t4 = this.peek(4);
        if (t2 && t2.type === 'INT' && t3 && t3.type === 'PUNCT' && t3.value === ']' && t4 && t4.type === 'IDENT') return true;
      }
    }
    return false;
  }

  parseType() {
    const t = this.peek();
    if (t && t.type === 'KEYWORD' && ['int', 'float', 'bool', 'char', 'void'].includes(t.value)) {
      this.advance();
      return { name: t.value, line: t.line, col: t.col };
    }
    if (t && t.type === 'IDENT') { this.advance(); return { name: t.value, line: t.line, col: t.col }; }
    throw new ParseError('expected a type', t);
  }

  parseVarDecl() {
    const start = this.here();
    const varType = this.parseType();
    let isArray = false, arraySize = null;
    if (this.atPunct('[')) {
      this.advance();
      arraySize = this.eat('INT').value;
      this.eatPunct(']');
      isArray = true;
    }
    const name = this.eat('IDENT').value;
    let init = null;
    if (this.atOp('=')) {
      this.advance();
      init = this.parseExpression();
    }
    return this.loc({ kind: 'VarDecl', varType: varType.name, varTypeLine: varType.line, varTypeCol: varType.col, name, isArray, arraySize, init }, { line: start.line, col: start.col });
  }

  parseClass() {
    const t = this.eatKw('class');
    const name = this.eat('IDENT').value;
    const parents = [];
    if (this.atKw('extends')) {
      this.advance();
      const pt = this.peek();
      parents.push({ name: this.eat('IDENT').value, line: pt.line, col: pt.col });
      while (this.atPunct(',')) { this.advance(); const pt2 = this.peek(); parents.push({ name: this.eat('IDENT').value, line: pt2.line, col: pt2.col }); }
    }
    this.eatPunct('{');
    this.skipNL();
    const members = [];
    while (!this.atPunct('}')) {
      this.skipNL();
      if (this.atPunct('}')) break;
      members.push(this.parseClassMember());
      this.skipNL();
    }
    this.eatPunct('}');
    return this.loc({ kind: 'Class', name, parents, members }, t);
  }

  parseClassMember() {
    const start = this.here();
    const retType = this.parseType();
    const name = this.eat('IDENT').value;
    if (this.atPunct('(')) {
      this.eatPunct('(');
      const params = [];
      if (!this.atPunct(')')) {
        do {
          const pt = this.parseType();
          const pname = this.eat('IDENT').value;
          params.push({ type: pt.name, name: pname, line: pt.line, col: pt.col });
        } while (this.atPunct(',') && (this.advance(), true) && !this.atPunct(')'));
      }
      this.eatPunct(')');
      let body = null;
      if (this.atPunct('{')) body = this.parseBlock();
      else if (this.atPunct(';')) this.advance();
      return this.loc({ kind: 'Method', returnType: retType.name, name, params, body }, { line: start.line, col: start.col });
    }
    let init = null;
    if (this.atOp('=')) { this.advance(); init = this.parseExpression(); }
    return this.loc({ kind: 'Field', varType: retType.name, varTypeLine: retType.line, varTypeCol: retType.col, name, init }, { line: start.line, col: start.col });
  }

  parseBlock() {
    const t = this.eatPunct('{');
    this.skipNL();
    const body = [];
    while (!this.atPunct('}')) {
      if (this.at('EOF')) throw new ParseError('unterminated block', this.peek());
      body.push(this.parseStatement());
      this.skipNLAndSemi();
    }
    this.eatPunct('}');
    return this.loc({ kind: 'Block', body }, t);
  }

  parseIf() {
    const t = this.eatKw('if');
    this.eatPunct('(');
    const cond = this.parseExpression();
    this.eatPunct(')');
    const then = this.parseBlock();
    const elseifs = [];
    while (this.atKw('elseif')) {
      this.advance();
      this.eatPunct('(');
      const c = this.parseExpression();
      this.eatPunct(')');
      elseifs.push({ cond: c, body: this.parseBlock() });
    }
    let elseBody = null;
    if (this.atKw('else')) { this.advance(); elseBody = this.parseBlock(); }
    return this.loc({ kind: 'If', cond, then, elseifs, elseBody }, t);
  }

  parseFor() {
    const t = this.eatKw('for');
    this.eatPunct('(');
    let init = null;
    if (!this.atPunct(';')) {
      if (this.looksLikeVarDecl()) init = this.parseVarDecl();
      else init = this.loc({ kind: 'ExprStmt', expr: this.parseExpression() }, this.here());
    }
    this.eatPunct(';');
    let cond = null;
    if (!this.atPunct(';')) cond = this.parseExpression();
    this.eatPunct(';');
    let update = null;
    if (!this.atPunct(')')) update = this.parseExpression();
    this.eatPunct(')');
    const body = this.parseBlock();
    return this.loc({ kind: 'For', init, cond, update, body }, t);
  }

  parseWhile() {
    const t = this.eatKw('while');
    this.eatPunct('(');
    const cond = this.parseExpression();
    this.eatPunct(')');
    const body = this.parseBlock();
    return this.loc({ kind: 'While', cond, body }, t);
  }

  parseReturn() {
    const t = this.eatKw('return');
    if (this.at('NEWLINE') || this.atPunct('}') || this.at('EOF') || this.atPunct(';')) {
      return this.loc({ kind: 'Return', value: null }, t);
    }
    return this.loc({ kind: 'Return', value: this.parseExpression() }, t);
  }

  // ---- expressions ----
  parseExpression() { return this.parseAssign(); }

  parseAssign() {
    const p = this.here();
    const left = this.parseLogicOr();
    if (this.atOp('=')) {
      this.advance();
      const value = this.parseAssign();
      if (left.kind !== 'Ident' && left.kind !== 'Index' && left.kind !== 'Field') {
        throw new ParseError('invalid assignment target', this.peek());
      }
      return this.loc({ kind: 'Assign', target: left, value }, p);
    }
    return left;
  }

  parseLogicOr() {
    let left = this.parseLogicAnd();
    while (this.atOp('||')) { this.advance(); const right = this.parseLogicAnd(); left = this.loc({ kind: 'Binary', op: '||', left, right }, left); }
    return left;
  }
  parseLogicAnd() {
    let left = this.parseEquality();
    while (this.atOp('&&')) { this.advance(); const right = this.parseEquality(); left = this.loc({ kind: 'Binary', op: '&&', left, right }, left); }
    return left;
  }
  parseEquality() {
    let left = this.parseComparison();
    while (this.atOp('==') || this.atOp('!=')) { const op = this.advance().value; const right = this.parseComparison(); left = this.loc({ kind: 'Binary', op, left, right }, left); }
    return left;
  }
  parseComparison() {
    let left = this.parseAddition();
    while (this.atOp('<') || this.atOp('>') || this.atOp('<=') || this.atOp('>=')) { const op = this.advance().value; const right = this.parseAddition(); left = this.loc({ kind: 'Binary', op, left, right }, left); }
    return left;
  }
  parseAddition() {
    let left = this.parseMultiplication();
    while (this.atOp('+') || this.atOp('-')) { const op = this.advance().value; const right = this.parseMultiplication(); left = this.loc({ kind: 'Binary', op, left, right }, left); }
    return left;
  }
  parseMultiplication() {
    let left = this.parseUnary();
    while (this.atOp('*') || this.atOp('/') || this.atOp('%')) { const op = this.advance().value; const right = this.parseUnary(); left = this.loc({ kind: 'Binary', op, left, right }, left); }
    return left;
  }
  parseUnary() {
    if (this.atOp('!') || this.atOp('-')) { const op = this.advance(); const operand = this.parseUnary(); return this.loc({ kind: 'Unary', op: op.value, operand }, op); }
    return this.parsePostfix();
  }
  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.atPunct('(')) {
        this.advance();
        const args = [];
        if (!this.atPunct(')')) {
          args.push(this.parseExpression());
          while (this.atPunct(',')) { this.advance(); args.push(this.parseExpression()); }
        }
        this.eatPunct(')');
        expr = this.loc({ kind: 'Call', callee: expr, args }, expr);
      } else if (this.atPunct('[')) {
        this.advance();
        const index = this.parseExpression();
        this.eatPunct(']');
        expr = this.loc({ kind: 'Index', object: expr, index }, expr);
      } else if (this.atPunct('.')) {
        this.advance();
        const nameTok = this.eat('IDENT');
        expr = this.loc({ kind: 'Field', object: expr, name: nameTok.value, nameLine: nameTok.line, nameCol: nameTok.col }, expr);
      } else break;
    }
    return expr;
  }
  parsePrimary() {
    const t = this.peek();
    if (!t) throw new ParseError('unexpected EOF', t);
    switch (t.type) {
      case 'INT': this.advance(); return this.loc({ kind: 'IntLit', value: t.value }, t);
      case 'FLOAT': this.advance(); return this.loc({ kind: 'FloatLit', value: t.value }, t);
      case 'CHAR': this.advance(); return this.loc({ kind: 'CharLit', value: t.value }, t);
      case 'STRING': this.advance(); return this.loc({ kind: 'StringLit', value: t.value }, t);
      case 'KEYWORD':
        if (t.value === 'true') { this.advance(); return this.loc({ kind: 'BoolLit', value: true }, t); }
        if (t.value === 'false') { this.advance(); return this.loc({ kind: 'BoolLit', value: false }, t); }
        if (t.value === 'null') { this.advance(); return this.loc({ kind: 'NullLit' }, t); }
        if (t.value === 'this') { this.advance(); return this.loc({ kind: 'This' }, t); }
        throw new ParseError(`unexpected keyword '${t.value}'`, t);
      case 'IDENT': this.advance(); return this.loc({ kind: 'Ident', name: t.value }, t);
      case 'PUNCT':
        if (t.value === '(') { this.advance(); const e = this.parseExpression(); this.eatPunct(')'); return e; }
        if (t.value === '[') {
          this.advance();
          const elements = [];
          if (!this.atPunct(']')) {
            elements.push(this.parseExpression());
            while (this.atPunct(',')) { this.advance(); if (this.atPunct(']')) break; elements.push(this.parseExpression()); }
          }
          this.eatPunct(']');
          return this.loc({ kind: 'ArrayLit', elements }, t);
        }
        throw new ParseError(`unexpected '${t.value}'`, t);
      default:
        throw new ParseError(`unexpected token ${t.type}`, t);
    }
  }
}

function parse(tokens) { return new Parser(tokens).parse(); }

module.exports = { Parser, parse, ParseError };
