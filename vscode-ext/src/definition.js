// definition.js - "Go to Definition" provider for Woolan.
//
// Provides navigation to class/variable/method definitions when the user
// Ctrl+Clicks an identifier or uses F12.

'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { tokenize } = require('../../src/lexer');
const { parse } = require('../../src/parser');

class WoolanDefinitionProvider {
  provideDefinition(document, position, token) {
    const src = document.getText();
    const offset = document.offsetAt(position);

    // Find the identifier under cursor using text matching
    const identifierName = this.getIdentifierAtPosition(src, offset);
    if (!identifierName) return null;

    // Parse the document
    let ast;
    try {
      ast = parse(tokenize(src));
    } catch (e) {
      return null; // Cannot provide definitions for invalid syntax
    }

    // Look for the definition
    return this.findDefinition(document, ast, identifierName, offset);
  }

  getIdentifierAtPosition(src, offset) {
    // Extract identifier at the given offset
    if (offset < 0 || offset >= src.length) return null;

    // Find the start of the identifier (move backward)
    let start = offset;
    while (start > 0 && this.isIdentifierChar(src[start - 1])) {
      start--;
    }

    // Find the end of the identifier (move forward)
    let end = offset;
    while (end < src.length && this.isIdentifierChar(src[end])) {
      end++;
    }

    // Check if we're actually on an identifier
    if (start === end) return null;

    const identifier = src.substring(start, end);

    // Check if it's a keyword
    const keywords = new Set([
      'int', 'float', 'bool', 'char', 'void', 'return', 'class', 'this',
      'extends', 'for', 'while', 'if', 'elseif', 'else', 'break', 'continue',
      'package', 'import', 'true', 'false', 'null'
    ]);

    if (keywords.has(identifier)) return null;

    return identifier;
  }

  isIdentifierChar(c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_';
  }

  findDefinition(document, ast, name, fromOffset) {
    const definitions = [];

    // 1. Look in current file
    this.findDefinitionInAST(ast, name, document.uri, definitions);

    // 2. Look in imported modules
    if (definitions.length === 0) {
      this.findImportDefinitions(ast, name, document, definitions);
    }

    // 3. Look in builtin directory (for built-in classes)
    if (definitions.length === 0) {
      this.findBuiltinDefinition(name, document, definitions);
    }

    return definitions.length > 0 ? definitions[0] : null;
  }

  findDefinitionInAST(ast, name, uri, definitions) {
    // Check class definitions
    if (ast.kind === 'Program' || ast.kind === 'Class') {
      const body = ast.body || ast.members || [];
      for (const node of body) {
        if (node.kind === 'Class' && node.name === name) {
          const range = new vscode.Range(
            Math.max(0, (node.line || 1) - 1),
            Math.max(0, (node.col || 1) - 1),
            Math.max(0, (node.line || 1) - 1),
            Math.max(0, (node.col || 1) - 1) + name.length
          );
          definitions.push(new vscode.Location(uri, range));
          return;
        }
        // Check variable declarations
        if (node.kind === 'VarDecl' && node.name === name) {
          const range = new vscode.Range(
            Math.max(0, (node.line || 1) - 1),
            Math.max(0, (node.col || 1) - 1),
            Math.max(0, (node.line || 1) - 1),
            Math.max(0, (node.col || 1) - 1) + name.length
          );
          definitions.push(new vscode.Location(uri, range));
          return;
        }
      }
    }

    // Check fields and methods in classes
    if (ast.kind === 'Program') {
      for (const node of ast.body) {
        if (node.kind === 'Class') {
          for (const member of node.members) {
            if ((member.kind === 'Field' || member.kind === 'Method') && member.name === name) {
              const range = new vscode.Range(
                Math.max(0, (member.line || 1) - 1),
                Math.max(0, (member.col || 1) - 1),
                Math.max(0, (member.line || 1) - 1),
                Math.max(0, (member.col || 1) - 1) + name.length
              );
              definitions.push(new vscode.Location(uri, range));
              return;
            }
          }
        }
      }
    }
  }

  findImportDefinitions(ast, name, currentDocument, definitions) {
    if (ast.kind !== 'Program') return;

    // Find import statements
    const imports = ast.body.filter(n => n.kind === 'Import');
    if (imports.length === 0) return;

    // Get base directory for resolving imports
    const baseDir = path.dirname(currentDocument.uri.fsPath);

    for (const imp of imports) {
      // For each imported module
      for (const moduleName of imp.names) {
        // Try to find the module file
        const modulePath = path.join(baseDir, moduleName + '.woo');
        if (!fs.existsSync(modulePath)) continue;

        try {
          const moduleSrc = fs.readFileSync(modulePath, 'utf8');
          const moduleAst = parse(tokenize(moduleSrc));
          const moduleUri = vscode.Uri.file(modulePath);

          // Check if the class exists in this module
          for (const stmt of moduleAst.body) {
            if (stmt.kind === 'Class' && stmt.name === name) {
              this.findDefinitionInAST(moduleAst, name, moduleUri, definitions);
              if (definitions.length > 0) return;
            }
          }
        } catch (e) {
          // Ignore parse errors in imported modules
        }
      }
    }
  }

  findBuiltinDefinition(name, currentDocument, definitions) {
    // Get workspace root
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(currentDocument.uri);
    if (!workspaceFolder) return;

    // Check builtin directory
    const builtinPath = path.join(workspaceFolder.uri.fsPath, 'builtin', name + '.woo');
    if (!fs.existsSync(builtinPath)) return;

    try {
      const builtinSrc = fs.readFileSync(builtinPath, 'utf8');
      const builtinAst = parse(tokenize(builtinSrc));
      const builtinUri = vscode.Uri.file(builtinPath);

      this.findDefinitionInAST(builtinAst, name, builtinUri, definitions);
    } catch (e) {
      // Ignore parse errors in builtin files
    }
  }
}

module.exports = { WoolanDefinitionProvider };