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

import { fileURLToPath } from 'url';

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
    const modulePath = fileURLToPath(importMetaUrl);
    const scriptPath = process.argv[1];

    // Check if this file is being executed directly
    if (modulePath === scriptPath || modulePath === scriptPath + '.js') {
      mainFunction();
    }
  } catch {
    // Invalid file URL, don't run
    return;
  }
}
