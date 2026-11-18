#!/usr/bin/env node
/**
 * Auto-formatting hook for Claude Code.
 * Runs prettier on formattable files after Edit or Write operations.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { runIfMain } from '#utils/module-runner.js';

// Extensions that prettier can format
const FORMATTABLE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.json',
  '.jsonc',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.md',
  '.mdx',
  '.yaml',
  '.yml',
  '.graphql',
  '.gql',
  '.vue',
  '.svelte',
];

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFormattable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FORMATTABLE_EXTENSIONS.includes(ext);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Prettier's CLI script in this workspace, or null when it is not installed.
 * Run with `node` directly: no pnpm and no shell, so it works the same on
 * Windows (where pnpm is a .cmd shim) and a file path never reaches a shell.
 *
 * @param {(id: string) => string} [resolve]
 * @returns {string | null}
 */
export function prettierBin(resolve = createRequire(import.meta.url).resolve) {
  try {
    const manifest = resolve('prettier/package.json');
    const { bin } = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    const script = typeof bin === 'string' ? bin : bin?.prettier;
    return script ? path.join(path.dirname(manifest), script) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {string | null} [bin] Prettier's CLI script
 * @returns {boolean}
 */
export function runPrettier(filePath, bin = prettierBin()) {
  if (!bin) {
    console.error(
      `Prettier formatting failed for ${filePath}: Prettier not available (pnpm install)`
    );
    return false;
  }
  // Arguments as an array, no shell: the path cannot inject a command.
  const result = spawnSync(process.execPath, [bin, '--write', filePath], {
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    console.error(
      `Prettier formatting failed for ${filePath}: ${result.stderr || result.error?.message || 'Prettier formatting failed'}`
    );
    return false;
  }
  return true;
}

/**
 * @param {{ tool_name: string, tool_input?: { file_path?: string } }} input
 * @returns {boolean}
 */
export function processHookInput(input) {
  const toolName = input.tool_name;
  const filePath = input.tool_input?.file_path;

  // Only process Edit and Write operations
  if (!['Edit', 'Write'].includes(toolName)) {
    return false;
  }

  // Check if file path exists
  if (!filePath) {
    return false;
  }

  // Check if file is formattable
  if (!isFormattable(filePath)) {
    return false;
  }

  // Check if file actually exists
  if (!fileExists(filePath)) {
    return false;
  }

  // Run prettier
  if (runPrettier(filePath)) {
    console.log(`✓ Formatted ${path.basename(filePath)} with prettier`);
    return true;
  }

  return false;
}

/* istanbul ignore next - stdin handling is tested via integration */
function main() {
  try {
    // Read hook input from stdin
    let inputData = '';
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      inputData += chunk;
    });

    process.stdin.on('end', () => {
      try {
        const input = JSON.parse(inputData);
        processHookInput(input);
        process.exit(0);
      } catch (err) {
        console.error(
          `Auto-format error: ${err instanceof Error ? err.message : String(err)}`
        );
        process.exit(0); // Exit 0 to not block the operation
      }
    });
  } catch (err) {
    console.error(
      `Auto-format error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(0); // Exit 0 to not block the operation
  }
}

// Run main function only if executed directly (not imported)
runIfMain(import.meta.url, main);
