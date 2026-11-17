/**
 * Tests for session_start.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { processHookInput, registryLine } from '../session_start.js';

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
  test('should stay silent with no tasks and no tools line', () => {
    expect(
      processHookInput(
        { source: 'startup' },
        { rootDir: root, tools: () => null }
      )
    ).toBeNull();
  });

  test('should nudge a scan when no tools are recorded', () => {
    expect(
      processHookInput({ source: 'startup' }, { rootDir: root })
        ?.hookSpecificOutput.additionalContext
    ).toBe(
      'Tools: none recorded on this machine — run pnpm tools scan to list the agents and CLIs you can call'
    );
  });

  test('should append the tools line after the task brief', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(
      path.join(root, 'tools', 'local.json'),
      JSON.stringify({
        version: 1,
        updatedAt: null,
        tools: [
          {
            name: 'codex',
            kind: 'agent',
            path: '/bin/codex',
            version: '1',
            source: 'scan',
            ok: true,
            checkedAt: 'x',
          },
        ],
      })
    );
    const context =
      processHookInput({ source: 'clear' }, { rootDir: root })
        ?.hookSpecificOutput.additionalContext ?? '';
    expect(context.split('\n').at(-1)).toMatch(
      /^Tools: agents codex \(pnpm tools list;/
    );
    expect(context).toContain('[Task] demo-261117');
  });

  test('should send the task brief alone when there is no tools line', () => {
    makeTask('demo-261117');
    fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');
    const context =
      processHookInput({}, { rootDir: root, tools: () => null })
        ?.hookSpecificOutput.additionalContext ?? '';
    expect(context).not.toContain('Tools:');
    expect(context).toContain('[Task] demo-261117');
  });

  test('should skip the tools line when the registry is unreadable', () => {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools', 'local.json'), '{oops');
    expect(registryLine(root)).toBeNull();
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
