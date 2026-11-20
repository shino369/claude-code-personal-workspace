#!/usr/bin/env node
/**
 * PreToolUse guardrail for Codex and DSH, from the rules Claude Code
 * enforces natively (`.claude/settings.json` `permissions`; see
 * utils/harness/permissions.js):
 *
 * - Codex: denies a patch that edits a protected path (its shell commands
 *   meet `.codex/rules/workspace.rules`, which `pnpm harness sync` writes).
 * - DSH: also denies reads of protected paths, and denies or asks for shell
 *   commands; DSH has no command rules of its own.
 *
 * Not wired in Claude Code, whose own permissions do this. Started with
 * `--harness codex|dsh`. Fails open: any error means no output and exit 0.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseHarness, projectDir } from '#utils/harness/input.js';
import { guardDecision, readPermissions } from '#utils/harness/permissions.js';
import { runIfMain } from '#utils/module-runner.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' | 'ask', permissionDecisionReason: string } }} HookOutput
 */

/** @param {string} file */
function softRealpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * @param {Record<string, any>} input
 * @param {{ harness: import('#utils/harness/input.js').Harness, rootDir?: string, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {HookOutput | null}
 */
export function processHookInput(
  input,
  { harness, rootDir = ROOT_DIR, env = process.env, home = os.homedir() }
) {
  let settings;
  try {
    settings = JSON.parse(
      fs.readFileSync(path.join(rootDir, '.claude/settings.json'), 'utf-8')
    );
  } catch {
    return null;
  }
  const decision = guardDecision(input, readPermissions(settings), {
    harness,
    projectDir: projectDir({ harness, env, rootDir }),
    home,
    realpath: softRealpath,
  });
  return decision
    ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision.decision,
          permissionDecisionReason: decision.reason,
        },
      }
    : null;
}

/* c8 ignore start - stdin/stdout wiring; logic is tested through processHookInput */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const output = processHookInput(JSON.parse(data || '{}'), { harness });
      if (output) {
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
        return;
      }
    } catch {
      // Fail open.
    }
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
