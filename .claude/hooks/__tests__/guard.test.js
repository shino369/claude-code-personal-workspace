/**
 * Tests for guard.js (the PreToolUse guardrail for Codex and DSH)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { processHookInput } from '../guard.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(
    path.join(root, '.claude/settings.json'),
    JSON.stringify({
      permissions: {
        deny: ['Edit(./.env)', 'Read(./.env)', 'Bash(rm:*)'],
        ask: ['Bash(git push:*)'],
      },
    })
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * @template {import('#utils/harness/input.js').Harness} H
 * @param {Record<string, unknown>} input
 * @param {H} harness
 */
const guard = (input, harness) =>
  processHookInput(
    { hook_event_name: 'PreToolUse', cwd: root, ...input },
    { harness, rootDir: root, env: {}, home: '/home/x' }
  );

describe('guard processHookInput', () => {
  test('should deny a Codex patch that edits a protected file', () => {
    const command =
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: .env\n*** End Patch\nEOF";
    expect(
      guard({ tool_name: 'Bash', tool_input: { command } }, 'codex')
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          '.env is protected in this workspace (.claude/settings.json permissions.deny Edit(./.env); AGENTS.md §1).',
      },
    });
  });

  test('should ask before a DSH git push and deny a DSH rm', () => {
    expect(
      guard({ tool_name: 'bash', tool_input: { command: 'git push' } }, 'dsh')
        ?.hookSpecificOutput.permissionDecision
    ).toBe('ask');
    expect(
      guard({ tool_name: 'bash', tool_input: { command: 'rm -rf x' } }, 'dsh')
        ?.hookSpecificOutput.permissionDecision
    ).toBe('deny');
  });

  test('should let everything else through', () => {
    expect(
      guard({ tool_name: 'bash', tool_input: { command: 'ls' } }, 'dsh')
    ).toBeNull();
    expect(
      guard(
        { tool_name: 'read', tool_input: { file_path: 'README.md' } },
        'dsh'
      )
    ).toBeNull();
  });

  test('should return Antigravity allow, ask, and deny decisions and fail open with allow', () => {
    expect(
      guard(
        {
          toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf x' } },
        },
        'agy'
      )
    ).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('pnpm task rm'),
    });
    expect(
      guard(
        {
          toolCall: { name: 'run_command', args: { CommandLine: 'git push' } },
        },
        'agy'
      )
    ).toMatchObject({ decision: 'ask' });
    expect(
      guard({ toolCall: { name: 'read_file', args: { Path: '.env' } } }, 'agy')
    ).toMatchObject({ decision: 'deny' });
    expect(
      guard(
        {
          toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test' } },
        },
        'agy'
      )
    ).toEqual({ decision: 'allow' });
    fs.writeFileSync(path.join(root, '.claude/settings.json'), '{');
    expect(
      guard(
        { toolCall: { name: 'run_command', args: { CommandLine: 'rm x' } } },
        'agy'
      )
    ).toEqual({ decision: 'allow' });
  });

  test('should fail open when the settings cannot be read', () => {
    fs.writeFileSync(path.join(root, '.claude/settings.json'), '{');
    expect(
      guard({ tool_name: 'bash', tool_input: { command: 'rm x' } }, 'dsh')
    ).toBeNull();
  });

  test('should default to the real workspace, env, and home', () => {
    // The real settings deny rm: a DSH rm through the defaults is denied.
    expect(
      processHookInput(
        { tool_name: 'bash', tool_input: { command: 'rm -rf x' } },
        { harness: 'dsh' }
      )?.hookSpecificOutput.permissionDecision
    ).toBe('deny');
  });
});
