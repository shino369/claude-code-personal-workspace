#!/usr/bin/env node
/**
 * Auto-formatting hook for Claude Code.
 * Runs prettier on formattable files after Edit or Write operations.
 */
import { execSync } from 'child_process';
import fs from 'fs';
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

function isFormattable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FORMATTABLE_EXTENSIONS.includes(ext);
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

export function runPrettier(filePath) {
  try {
    // Check if prettier is available (use pnpm as per workspace config)
    execSync('pnpm prettier --version', { stdio: 'ignore' });

    // Run prettier
    execSync(`pnpm prettier --write "${filePath}"`, {
      stdio: 'pipe',
      encoding: 'utf-8',
    });

    return true;
  } catch (err) {
    // Prettier might not be installed or file might have syntax errors
    console.error(`Prettier formatting failed for ${filePath}: ${err.message}`);
    return false;
  }
}

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
        console.error(`Auto-format error: ${err.message}`);
        process.exit(0); // Exit 0 to not block the operation
      }
    });
  } catch (err) {
    console.error(`Auto-format error: ${err.message}`);
    process.exit(0); // Exit 0 to not block the operation
  }
}

// Run main function only if executed directly (not imported)
runIfMain(import.meta.url, main);
