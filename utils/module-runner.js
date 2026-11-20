/**
 * Utility for running main functions only when executed directly (not imported)
 *
 * Usage:
 * ```javascript
 * import { runIfMain } from '../utils/module-runner.js';
 *
 * function main() {
 *   // Your main logic here
 * }
 *
 * runIfMain(import.meta.url, main);
 * ```
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The real path of `file` (links resolved), or `file` when it does not exist.
 *
 * @param {string} file
 */
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Runs the provided function only if the module is executed directly
 * (not when imported by another module or test file)
 *
 * @param {string} importMetaUrl - The import.meta.url of the calling module
 * @param {Function} mainFunction - The main function to execute
 */
export function runIfMain(importMetaUrl, mainFunction) {
  if (!importMetaUrl.startsWith('file:')) {
    return;
  }

  try {
    const modulePath = path.resolve(fileURLToPath(importMetaUrl));
    const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

    // Check if this file is being executed directly. Resolving both sides makes
    // this work whether the script was invoked with a relative or absolute path.
    // Node gives the main module its real path, so a script started through a
    // linked folder (macOS /var is /private/var) is compared by real path too.
    if (
      scriptPath &&
      (modulePath === realPath(scriptPath) ||
        modulePath === realPath(scriptPath + '.js'))
    ) {
      mainFunction();
    }
  } catch {
    // Invalid file URL, don't run
    /* c8 ignore next 1 -- Explicit return in catch is semantically unnecessary but kept for clarity */
    return;
  }
}
