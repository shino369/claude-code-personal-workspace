#!/usr/bin/env node
/**
 * Auto-formatting hook: runs Prettier on files an edit touched.
 *
 * - Claude Code: PostToolUse on Edit|Write; formats `tool_input.file_path`.
 * - DSH (bridge): PostToolUse on its edit tools; formats the edit's files.
 * - Codex: shell-run `apply_patch` sends only PreToolUse, so the patch's
 *   files are queued there and formatted at the next PostToolUse (the Stop
 *   hook flushes what is left; see utils/harness/format.js).
 *
 * Started with `--harness claude|codex|dsh`. Never blocks: exit 0 always.
 */
import fs from 'fs';
import path from 'path';
import {
  flushFormatQueue,
  formatTargets,
  isFormattable,
  prettierBin,
  queueFiles,
  runPrettier,
} from '#utils/harness/format.js';
import { parseHarness, projectDir, toolEvent } from '#utils/harness/input.js';
import { runIfMain } from '#utils/module-runner.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

export { prettierBin, runPrettier };

/**
 * Claude Code: format an Edit or Write target.
 *
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
  if (!fs.existsSync(filePath)) {
    return false;
  }

  // Run prettier
  if (runPrettier(filePath)) {
    console.log(`✓ Formatted ${path.basename(filePath)} with prettier`);
    return true;
  }

  return false;
}

/**
 * Codex and DSH: queue or format the files of an edit (see the file header).
 *
 * @param {Record<string, any>} input
 * @param {'codex' | 'dsh'} harness
 * @param {{ rootDir?: string, env?: NodeJS.ProcessEnv, tmpDir?: string }} [options]
 * @returns {string[]} the files formatted
 */
export function processOtherHarness(
  input,
  harness,
  { rootDir = ROOT_DIR, env = process.env, tmpDir } = {}
) {
  const dir = projectDir({ harness, env, rootDir });
  const event = toolEvent(input);
  const targets =
    event.kind === 'edit'
      ? formatTargets(event.files, { cwd: input.cwd, projectDir: dir })
      : [];
  if (harness === 'codex' && input.hook_event_name === 'PreToolUse') {
    queueFiles(input.session_id, targets, { tmpDir });
    return [];
  }
  return flushFormatQueue(input.session_id, {
    projectDir: dir,
    extra: targets,
    tmpDir,
  });
}

/* istanbul ignore next - stdin handling is tested via integration */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let inputData = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    inputData += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(inputData);
      // Codex and DSH get no plain stdout: Codex rejects it on some events,
      // and the DSH bridge ignores it.
      if (harness === 'claude') processHookInput(input);
      else processOtherHarness(input, harness);
    } catch (err) {
      console.error(
        `Auto-format error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    process.exit(0); // never block the edit
  });
}

runIfMain(import.meta.url, main);
