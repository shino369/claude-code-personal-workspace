#!/usr/bin/env node
/**
 * Auto-formatting hook for Claude Code.
 * Runs prettier on formattable files after Edit or Write operations.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Extensions that prettier can format
const FORMATTABLE_EXTENSIONS = [
  '.js',
  '.jsx',
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
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function runPrettier(filePath) {
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
        const toolName = input.tool_name;
        const filePath = input.tool_input?.file_path;

        // Only process Edit and Write operations
        if (!['Edit', 'Write'].includes(toolName)) {
          process.exit(0);
        }

        // Check if file path exists
        if (!filePath) {
          process.exit(0);
        }

        // Check if file is formattable
        if (!isFormattable(filePath)) {
          process.exit(0);
        }

        // Check if file actually exists
        if (!fileExists(filePath)) {
          process.exit(0);
        }

        // Run prettier
        if (runPrettier(filePath)) {
          console.log(`✓ Formatted ${path.basename(filePath)} with prettier`);
        }

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

main();
