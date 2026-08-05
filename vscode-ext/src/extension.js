// extension.js - VSCode extension entry point for Woolan.
//
// Contributes: syntax highlighting (via grammar in package.json), language
// configuration, diagnostics (syntax checking), a document formatter, and
// completion (with '.' trigger).

'use strict';

const path = require('path');
const vscode = require('vscode');
const { formatWoolan } = require('./formatter');
const { WoolanCompletionProvider } = require('./completion');
const { computeDiagnostics } = require('./diagnostics');
const { WoolanDefinitionProvider } = require('./definition');

const LANG = 'woolan';

function activate(context) {
  // ---- diagnostics (syntax checking) ----
  const diagCollection = vscode.languages.createDiagnosticCollection('woolan');
  let timer = null;

  const updateDiagnostics = (document) => {
    if (document.languageId !== LANG) return;
    diagCollection.set(document.uri, computeDiagnostics(document));
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateDiagnostics),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== LANG) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => updateDiagnostics(e.document), 300);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.languageId === LANG) diagCollection.delete(doc.uri);
    }),
  );
  // initial pass for already-open documents
  vscode.workspace.textDocuments.forEach(updateDiagnostics);

  // ---- formatter ----
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(LANG, {
      provideDocumentFormattingEdits(document) {
        const src = document.getText();
        let formatted;
        try {
          formatted = formatWoolan(src);
        } catch (e) {
          // do not format on lexical errors (would destroy user code)
          return [];
        }
        const range = new vscode.Range(
          document.positionAt(0),
          document.positionAt(src.length),
        );
        return [vscode.TextEdit.replace(range, formatted)];
      },
    }),
  );

  // ---- completion ----
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(LANG, new WoolanCompletionProvider(), '.'),
  );

  // ---- go to definition ----
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(LANG, new WoolanDefinitionProvider()),
  );

  // ---- run file command ----
  const runFileCommand = vscode.commands.registerCommand('woolan.runFile', (uri) => {
    let filePath;
    if (uri && uri.fsPath) {
      // Called from explorer context menu
      filePath = uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
      // Called from editor context menu
      filePath = vscode.window.activeTextEditor.document.uri.fsPath;
    } else {
      vscode.window.showErrorMessage('No Woolan file selected');
      return;
    }

    // Get the workspace folder containing the file
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('File is not in a workspace');
      return;
    }

    // Get relative path from workspace root
    const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

    // Create or reuse terminal
    const terminalName = 'Woolan Run';
    let terminal = vscode.window.terminals.find(t => t.name === terminalName);
    if (!terminal) {
      terminal = vscode.window.createTerminal(terminalName);
    }
    terminal.show();

    // Run the file
    terminal.sendText(`node index.js "${relativePath}"`);
  });

  context.subscriptions.push(runFileCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
