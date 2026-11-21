/**
 * Tests for task_loop.js (the inner-loop Stop hook)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main as taskCli } from '#utils/task/cli.js';
import { writeSession } from '#utils/task/store.js';
import { processHookInput as processSessionStart } from '../session_start.js';
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
      session: null,
      pendingAgents: [],
    });
  });

  test('should pass the running reviewer and verifier subagents to the loop', () => {
    const run = vi.fn(() => ({ action: /** @type {const} */ ('skip') }));
    const background_tasks = [
      { id: 'a1', type: 'subagent', status: 'running', agent_type: 'reviewer' },
      { id: 'a2', type: 'subagent', status: 'running', agent_type: 'Explore' },
      { id: 'b1', type: 'shell', status: 'running', command: 'sleep 9' },
    ];
    processHookInput({ background_tasks }, { rootDir: root, run });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ pendingAgents: ['a1'] })
    );
  });

  test('should format queued Codex edits before running the loop', () => {
    /** @type {string[]} */
    const order = [];
    const flush = vi.fn(() => {
      order.push('flush');
      return [];
    });
    const run = vi.fn(() => {
      order.push('run');
      return { action: /** @type {const} */ ('skip') };
    });
    processHookInput(
      { session_id: 'cx-1' },
      { rootDir: root, harness: 'codex', run, flush }
    );
    expect(order).toEqual(['flush', 'run']);
    expect(flush).toHaveBeenCalledWith('cx-1', {
      projectDir: root,
      extraRoots: [],
    });
  });

  test('should still run the loop when formatting fails', () => {
    const run = vi.fn(() => ({ action: /** @type {const} */ ('skip') }));
    const flush = vi.fn(() => {
      throw new Error('prettier gone');
    });
    processHookInput({}, { rootDir: root, harness: 'codex', run, flush });
    expect(run).toHaveBeenCalled();
  });

  test('should not format in Claude Code, where edits are formatted as they happen', () => {
    const flush = vi.fn(() => []);
    const run = vi.fn(() => ({ action: /** @type {const} */ ('skip') }));
    processHookInput({}, { rootDir: root, run, flush });
    expect(flush).not.toHaveBeenCalled();
  });

  test('should sign the notes with the harness name unless TASK_AGENT is set', () => {
    /** @type {string[]} */
    const agents = [];
    const run = vi.fn(
      (/** @type {{ deps: { env: NodeJS.ProcessEnv } }} */ { deps }) => {
        agents.push(String(deps.env.TASK_AGENT));
        return { action: /** @type {const} */ ('skip') };
      }
    );
    const flush = () => [];
    processHookInput(
      {},
      { rootDir: root, harness: 'codex', run, flush, deps: { env: {} } }
    );
    expect(agents).toEqual(['codex']);
    processHookInput(
      {},
      {
        rootDir: root,
        harness: 'dsh',
        run,
        flush,
        deps: { env: { TASK_AGENT: 'me' } },
      }
    );
    expect(agents).toEqual(['codex', 'me']);
  });

  test("should pass the hook's session id to the loop", () => {
    const run = vi.fn(() => ({ action: /** @type {const} */ ('skip') }));
    processHookInput({ session_id: 'sess-1' }, { rootDir: root, run });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'sess-1' })
    );
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

  test('should adapt Stop inputs and outputs for Antigravity', () => {
    const blockRun = vi.fn(() => ({
      action: /** @type {const} */ ('block'),
      reason: 'tests failed',
    }));
    expect(
      processHookInput(
        {
          conversationId: 'agy-1',
          terminationReason: 'NO_TOOL_CALL',
          fullyIdle: true,
        },
        { rootDir: root, harness: 'agy', run: blockRun, deps: { env: {} } }
      )
    ).toEqual({ decision: 'continue', reason: 'tests failed' });
    expect(blockRun).toHaveBeenCalledWith(
      expect.objectContaining({ session: 'agy-1', pendingAgents: [] })
    );

    const idleRun = vi.fn(() => ({ action: /** @type {const} */ ('skip') }));
    expect(
      processHookInput(
        { conversationId: 'agy-1', fullyIdle: false },
        { rootDir: root, harness: 'agy', run: idleRun, deps: { env: {} } }
      )
    ).toEqual({ decision: 'allow' });
    expect(idleRun).toHaveBeenCalledWith(
      expect.objectContaining({ pendingAgents: ['background'] })
    );

    // Non-normal termination skips the loop and allows stopping.
    const neverRun = vi.fn();
    expect(
      processHookInput(
        { conversationId: 'agy-1', terminationReason: 'USER_CANCELED' },
        { rootDir: root, harness: 'agy', run: neverRun }
      )
    ).toEqual({ decision: 'allow' });
    expect(neverRun).not.toHaveBeenCalled();

    // Errors fail open with an explicit allow.
    expect(
      processHookInput(
        { conversationId: 'agy-1' },
        {
          rootDir: root,
          harness: 'agy',
          run: () => {
            throw new Error('boom');
          },
        }
      )
    ).toEqual({ decision: 'allow' });
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

  test("should not run another session's task for a session that never worked on it", () => {
    const deps = {
      rootDir: root,
      env: { TASK_AGENT: 'tester', TASK_SESSION: 'owner' },
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
    processSessionStart({ session_id: 'bystander' }, { rootDir: root });

    expect(
      processHookInput(
        { session_id: 'bystander' },
        { rootDir: root, deps: { env: {}, git: deps.git } }
      )
    ).toBeNull();
    expect(
      processHookInput(
        { session_id: 'owner' },
        { rootDir: root, deps: { env: {}, git: deps.git } }
      )?.decision
    ).toBe('block');
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
      session: null,
    });
    processResetInput(
      { prompt: 'go on', session_id: 'sess-1' },
      { rootDir: root, reset }
    );
    expect(reset).toHaveBeenLastCalledWith(
      expect.objectContaining({ session: 'sess-1' })
    );
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

  test("should keep a working session's binding from being pruned", () => {
    fs.mkdirSync(path.join(root, 'tasks', 'demo-261117'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'demo-261117', 'NOTES.md'), '');
    writeSession(root, 'sess-1', { task: 'demo-261117', engaged: true });
    const file = path.join(root, 'tasks', '.sessions', 'sess-1.json');
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, old, old);

    processResetInput(
      { prompt: 'go on', session_id: 'sess-1' },
      { rootDir: root, reset: () => false }
    );

    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
  });

  test('should reset Antigravity loops only on invocationNum === 0', () => {
    const reset = vi.fn(() => true);
    expect(
      processResetInput(
        {
          conversationId: 'agy-1',
          lastUserInput: 'try again',
          invocationNum: 1,
        },
        { rootDir: root, harness: 'agy', reset }
      )
    ).toBe(false);
    expect(reset).not.toHaveBeenCalled();

    expect(
      processResetInput(
        {
          conversationId: 'agy-1',
          lastUserInput: 'try again',
          invocationNum: 0,
        },
        { rootDir: root, harness: 'agy', reset, deps: { env: {} } }
      )
    ).toBe(true);
    expect(reset).toHaveBeenCalledWith({
      deps: expect.objectContaining({
        rootDir: root,
        env: expect.objectContaining({ TASK_AGENT: 'agy' }),
      }),
      prompt: 'try again',
      session: 'agy-1',
    });
    processResetInput(
      {
        conversationId: 'agy-1',
        lastUserInput: 'try again',
        invocationNum: 0,
      },
      {
        rootDir: root,
        harness: 'agy',
        reset,
        deps: { env: { TASK_AGENT: 'me' } },
      }
    );
    expect(reset).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deps: expect.objectContaining({
          env: expect.objectContaining({ TASK_AGENT: 'me' }),
        }),
      })
    );
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
