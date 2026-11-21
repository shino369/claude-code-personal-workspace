#!/usr/bin/env node
/**
 * PreToolUse guardrail for Codex, DSH, and Antigravity (`agy`), from the rules
 * Claude Code enforces natively (`.claude/settings.json` `permissions`; see
 * utils/harness/permissions.js):
 *
 * - Codex: denies a patch that edits a protected path (its shell commands
 *   meet `.codex/rules/workspace.rules`, which `pnpm harness sync` writes).
 * - DSH & Antigravity: also deny reads of protected paths, and deny or ask
 *   for shell commands, since neither has a project-level command rules file.
 *
 * Not wired in Claude Code, whose own permissions do this. Started with
 * `--harness codex|dsh|agy`. Fails open: any error allows the tool call (for
 * Antigravity, an explicit `{"decision":"allow"}` because `{}` denies).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  normalizeHookInput,
  parseHarness,
  projectDir,
} from '#utils/harness/input.js';
import { guardDecision, readPermissions } from '#utils/harness/permissions.js';
import { runIfMain } from '#utils/module-runner.js';
import { ROOT_DIR } from '#utils/workspace-config.js';

/**
 * @typedef {{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' | 'ask', permissionDecisionReason: string } }} StandardHookOutput
 * @typedef {{ decision: 'allow' | 'deny' | 'ask', reason?: string }} AgyHookOutput
 * @typedef {StandardHookOutput | AgyHookOutput} HookOutput
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
 * @template {import('#utils/harness/input.js').Harness} H
 * @param {Record<string, any>} input
 * @param {{ harness: H, rootDir?: string, env?: NodeJS.ProcessEnv, home?: string }} options
 * @returns {H extends 'agy' ? AgyHookOutput : StandardHookOutput | null}
 */
export function processHookInput(
  input,
  { harness, rootDir = ROOT_DIR, env = process.env, home = os.homedir() }
) {
  const allow =
    harness === 'agy'
      ? /** @type {HookOutput} */ ({ decision: 'allow' })
      : null;
  let settings;
  try {
    settings = JSON.parse(
      fs.readFileSync(path.join(rootDir, '.claude/settings.json'), 'utf-8')
    );
  } catch {
    return /** @type {any} */ (allow);
  }
  const decision = guardDecision(
    normalizeHookInput(input, harness),
    readPermissions(settings),
    {
      harness,
      projectDir: projectDir({ harness, env, rootDir }),
      home,
      realpath: softRealpath,
    }
  );
  if (!decision) return /** @type {any} */ (allow);
  if (harness === 'agy') {
    return /** @type {any} */ ({
      decision: decision.decision,
      reason: decision.reason,
    });
  }
  return /** @type {any} */ ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.decision,
      permissionDecisionReason: decision.reason,
    },
  });
}

/* c8 ignore start - stdin/stdout wiring; logic is tested through processHookInput */
function main() {
  const harness = parseHarness(process.argv.slice(2));
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  const failOpen = () => {
    if (harness === 'agy') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }), () =>
        process.exit(0)
      );
      return;
    }
    process.exit(0);
  };
  process.stdin.on('end', () => {
    try {
      const output = processHookInput(JSON.parse(data || '{}'), { harness });
      if (output) {
        process.stdout.write(JSON.stringify(output), () => process.exit(0));
        return;
      }
    } catch {
      failOpen();
      return;
    }
    process.exit(0);
  });
  process.stdin.on('error', failOpen);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
