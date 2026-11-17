/**
 * Tests for task_loop.js (the inner-loop Stop hook)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main as taskCli } from '#utils/task/cli.js';
import { processHookInput, processResetInput } from '../task_loop.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-loop-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('task_loop processHookInput', () => {
  test('should return a block decision with the reason', () => {
    const run = vi.fn(() => ({
      action: /** @type {const} */ ('block'),
      reason: 'verify failed',
    }));
    expect(processHookInput({}, { rootDir: root, run })).toEqual({
      decision: 'block',
      reason: 'verify failed',
    });
    expect(run).toHaveBeenCalledWith({
      deps: expect.objectContaining({ rootDir: root }),
    });
  });

  test('should show a system message when the stop is allowed with one', () => {
    const run = () => ({
      action: /** @type {const} */ ('allow'),
      message: '✓ task verify passed',
    });
    expect(processHookInput({}, { rootDir: root, run })).toEqual({
      systemMessage: '✓ task verify passed',
    });
  });

  test('should stay silent for skip, or allow without a message', () => {
    expect(
      processHookInput(
        {},
        {
          rootDir: root,
          run: () => ({ action: /** @type {const} */ ('skip') }),
        }
      )
    ).toBeNull();
    expect(
      processHookInput(
        {},
        {
          rootDir: root,
          run: () => ({ action: /** @type {const} */ ('allow') }),
        }
      )
    ).toBeNull();
  });

  test('should fail open when the loop throws', () => {
    const run = () => {
      throw new Error('broken state.json');
    };
    expect(processHookInput({}, { rootDir: root, run })).toBeNull();
  });

  test('should skip a real workspace with no active task', () => {
    expect(processHookInput({}, { rootDir: root })).toBe(null);
  });

  test('should block a real task whose fast verify fails', () => {
    const deps = {
      rootDir: root,
      env: { TASK_AGENT: 'tester' },
      log: () => {},
      git: () => ({ branch: 'feat/x', changed: 0, diffStat: null }),
    };
    taskCli({
      argv: [
        'new',
        'demo',
        '--goal',
        'G',
        '--verify',
        'node -e "process.exit(3)"',
      ],
      deps,
    });
    taskCli({ argv: ['set', '--loop', 'on', '--loop-max', '3'], deps });

    const output = processHookInput(
      {},
      { rootDir: root, deps: { env: {}, git: deps.git } }
    );

    expect(output?.decision).toBe('block');
    expect(output?.reason).toContain('task loop iteration 1/3');
  });
});

describe('task_loop processResetInput', () => {
  test('should pass the typed prompt to the reset', () => {
    const reset = vi.fn(() => true);
    expect(
      processResetInput({ prompt: 'go on' }, { rootDir: root, reset })
    ).toBe(true);
    expect(reset).toHaveBeenCalledWith({
      deps: expect.objectContaining({ rootDir: root }),
      prompt: 'go on',
    });
  });

  test('should pass undefined without input and fail open on errors', () => {
    const reset = vi.fn(() => false);
    expect(processResetInput(undefined, { rootDir: root, reset })).toBe(false);
    expect(reset).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: undefined })
    );
    const broken = () => {
      throw new Error('bad state');
    };
    expect(
      processResetInput({ prompt: 'x' }, { rootDir: root, reset: broken })
    ).toBe(false);
  });

  test('should reset a real halted loop on a typed prompt', () => {
    const deps = {
      rootDir: root,
      env: {},
      log: () => {},
      git: () => ({ branch: 'feat/x', changed: 0, diffStat: null }),
    };
    taskCli({
      argv: [
        'new',
        'demo',
        '--goal',
        'G',
        '--verify',
        'node -e "process.exit(3)"',
      ],
      deps,
    });
    taskCli({ argv: ['set', '--loop', 'on', '--loop-max', '1'], deps });
    processHookInput({}, { rootDir: root, deps });
    expect(processHookInput({}, { rootDir: root, deps })).toMatchObject({
      systemMessage: expect.stringContaining('paused until your next prompt'),
    });

    expect(
      processResetInput({ prompt: 'try again' }, { rootDir: root, deps })
    ).toBe(true);
  });
});
