/**
 * Tests for session_start.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { processHookInput } from '../session_start.js';

/** @type {string} */
let root;

/**
 * @param {string} name
 * @param {{ plan?: string, notes?: string }} [files]
 */
function makeTask(
  name,
  { plan = `# Plan — ${name}\n\nGoal: Ship it\n\n- [ ] Write it\n`, notes } = {}
) {
  const dir = path.join(root, 'tasks', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plan.md'), plan);
  if (notes) fs.writeFileSync(path.join(dir, 'NOTES.md'), notes);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('session_start processHookInput', () => {
  test('should stay silent when there are no tasks', () => {
    expect(
      processHookInput({ source: 'startup' }, { rootDir: root })
    ).toBeNull();
  });

  test('should inject the active task brief with its goal and next step', () => {
    makeTask('demo-261117', {
      notes:
        '# NOTES\n\n## 2026-11-17 10:00 — claude\n\nNext: write the parser\n',
    });
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

    const output = processHookInput({ source: 'clear' }, { rootDir: root });
    const context = output?.hookSpecificOutput.additionalContext ?? '';

    expect(output?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context).toContain('[Task] demo-261117');
    expect(context).toContain('Goal: Ship it');
    expect(context).toContain('Next step: Write it');
    expect(context).toContain('Next (last note): write the parser');
    expect(context).toContain('injected on session clear');
  });

  test('should list open tasks when none is active', () => {
    makeTask('older-261116');

    const output = processHookInput(undefined, { rootDir: root });
    const context = output?.hookSpecificOutput.additionalContext ?? '';

    expect(context).toContain('[Task] No active task');
    expect(context).toContain('older-261116');
    expect(context).toContain('Injected on session startup');
  });

  test('should report an unreadable task instead of failing', () => {
    const brief = vi.fn(() => {
      throw new Error('state.json is not valid JSON');
    });

    const output = processHookInput(
      { source: 'resume' },
      { rootDir: root, brief }
    );

    expect(output?.hookSpecificOutput.additionalContext).toContain(
      'Could not read the active task — Error: state.json is not valid JSON'
    );
  });
});
