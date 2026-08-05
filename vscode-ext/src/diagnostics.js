// diagnostics.js - Syntax + semantic checking for Woolan.
//
// If parsing fails, the first parse/lex error is reported. If parsing succeeds,
// the semantic analyzer runs and reports all issues (undefined identifiers,
// type mismatches, missing methods, wrong arg counts, non-bool conditions, ...).

'use strict';

const vscode = require('vscode');
const { tokenize, LexerError } = require('../../src/lexer');
const { parse, ParseError } = require('../../src/parser');
const { analyzeSemantics } = require('./semantics');

function cleanMessage(e) {
  const idx = e.message.indexOf(' - ');
  return idx >= 0 ? e.message.slice(idx + 3) : e.message;
}

function computeDiagnostics(document) {
  const src = document.getText();
  const filePath = document.uri.fsPath;
  const diags = [];

  // 1. lexical + syntax check
  let ast = null;
  try {
    ast = parse(tokenize(src));
  } catch (e) {
    if (e instanceof LexerError || e instanceof ParseError) {
      const line = Math.max(0, (e.line || 1) - 1);
      const col = Math.max(0, (e.col || 1) - 1);
      if (line >= document.lineCount) {
        diags.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), cleanMessage(e), vscode.DiagnosticSeverity.Error));
      } else {
        const lineText = document.lineAt(line).text;
        const end = Math.min(lineText.length, col + 1);
        diags.push(new vscode.Diagnostic(new vscode.Range(line, col, line, end), cleanMessage(e), vscode.DiagnosticSeverity.Error));
      }
    }
    return diags; // stop here; semantic analysis needs a valid parse
  }

  // 2. semantic analysis
  const issues = analyzeSemantics(src, filePath);
  for (const issue of issues) {
    const line = Math.max(0, (issue.line || 1) - 1);
    const col = Math.max(0, (issue.col || 1) - 1);
    const lineText = line < document.lineCount ? document.lineAt(line).text : '';
    const end = Math.min(lineText.length, col + 1);
    const sev = issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    diags.push(new vscode.Diagnostic(new vscode.Range(line, col, line, end), issue.message, sev));
  }
  return diags;
}

module.exports = { computeDiagnostics };
