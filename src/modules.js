// modules.js - Shared module system for Woolan.
//
// Provides package/import resolution logic used by both the interpreter
// and the VSCode extension's semantic analyzer.

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Find all .woo files in the project that declare the given package.
 * @param {string} projectRoot - Project root directory
 * @param {string} packageName - Package name to search for
 * @param {function} parseFn - Function to parse source and return AST
 * @returns {string[]} - Array of file paths
 */
function findPackageFiles(projectRoot, packageName, parseFn) {
  const results = [];
  const seen = new Set();

  const scanDir = (dir) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        // Skip node_modules and hidden directories
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith('.woo')) {
          const pkg = parsePackageDecl(fullPath, parseFn);
          if (pkg === packageName) {
            results.push(fullPath);
          }
        }
      }
    } catch (e) {
      // Ignore permission errors etc.
    }
  };

  scanDir(projectRoot);
  return results;
}

/**
 * Quick parse to extract package declaration from a file.
 * @param {string} filePath - File path
 * @param {function} parseFn - Function to parse source and return AST
 * @returns {string|null} - Package name or null
 */
function parsePackageDecl(filePath, parseFn) {
  try {
    const src = fs.readFileSync(filePath, 'utf8');
    const ast = parseFn(src);
    for (const stmt of ast.body) {
      if (stmt.kind === 'Package') return stmt.name;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Resolve an import name to file path(s).
 * @param {string} name - Import name (e.g., "examples" or "examples.hello")
 * @param {string} baseDir - Base directory for relative path imports
 * @param {string} projectRoot - Project root for package imports
 * @param {function} parseFn - Function to parse source and return AST
 * @returns {{type: 'file', path: string} | {type: 'package', paths: string[]} | null}
 */
function resolveImport(name, baseDir, projectRoot, parseFn) {
  // Try path import first: import examples.hello -> examples/hello.woo
  const modulePath = name.replace(/\./g, path.sep);
  const candidate = path.join(baseDir, modulePath + '.woo');

  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return { type: 'file', path: candidate };
  }

  // Try package import: import examples -> find all files with "package examples"
  const packageFiles = findPackageFiles(projectRoot, name, parseFn);
  if (packageFiles.length > 0) {
    return { type: 'package', paths: packageFiles };
  }

  return null;
}

module.exports = {
  findPackageFiles,
  parsePackageDecl,
  resolveImport
};