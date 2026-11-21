import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { INNER_LOOP_ENV } from '../../task/loop.js';
import {
  AGENT_CALL_TIMEOUT_MS,
  CALL_AGENTS,
  callAgent,
  headlessCommand,
  jsonObjectOf,
} from '../agent-call.js';
import { EXTRACT_ENV } from '../queue.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-call-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {Partial<import('../../loop/adapters.js').AgentResult>} [result] */
const agentReturning = (result = {}) =>
  vi.fn(() => ({
    code: 0,
    signal: null,
    stdout: 'answer',
    output: 'answer',
    durationMs: 10,
    ...result,
  }));

/** @param {ReturnType<typeof agentReturning>} runAgent */
const deps = (runAgent) => ({
  env: { PATH: '/bin' },
  runAgent,
  tmpdir: () => root,
});

describe('headlessCommand', () => {
  test('should run claude read-only without tools, with the model when given', () => {
    const command = headlessCommand({
      agent: 'claude',
      model: 'opus',
      rootDir: root,
    });

    expect(command.bin).toBe('claude');
    expect(command.args).toEqual(
      expect.arrayContaining(['-p', '--permission-mode', 'plan'])
    );
    expect(command.args.slice(-4)).toEqual(['--tools', '', '--model', 'opus']);
    expect(
      headlessCommand({ agent: 'claude', rootDir: root }).args.slice(-2)
    ).toEqual(['--tools', '']);
  });

  test('should run codex and dsh in their read-only modes', () => {
    const codex = headlessCommand({ agent: 'codex', rootDir: root });
    const dsh = headlessCommand({ agent: 'dsh', rootDir: root });

    expect(codex.bin).toBe('codex');
    expect(codex.args).toContain('read-only');
    expect(codex.args).not.toContain('--tools');
    expect(dsh.bin).toBe('dsh');
    expect(dsh.args).not.toContain('--tools');
  });

  test('should refuse an agent memory jobs cannot call', () => {
    expect(() => headlessCommand({ agent: 'gemini', rootDir: root })).toThrow(
      `Memory jobs run on claude, codex, dsh (got gemini).\nFix: use --agent ${CALL_AGENTS.join('|')}`
    );
  });
});

describe('callAgent', () => {
  const command = headlessCommand({ agent: 'claude', rootDir: '/nowhere' });

  test('should call in an empty folder with the memory hooks and loop off', () => {
    const runAgent = agentReturning();

    const result = callAgent(deps(runAgent), command, 'P');

    expect(result.stdout).toBe('answer');
    const call = /** @type {any} */ (runAgent.mock.calls[0])[0];
    expect(call).toMatchObject({
      command,
      prompt: 'P',
      timeoutMs: AGENT_CALL_TIMEOUT_MS,
      env: { PATH: '/bin', [EXTRACT_ENV]: '1', [INNER_LOOP_ENV]: 'off' },
    });
    expect(path.basename(call.cwd)).toMatch(/^memory-extraction-/);
    expect(path.dirname(call.cwd)).toBe(root);
    expect(fs.existsSync(call.cwd)).toBe(false);
  });

  test('should name the job and use its timeout', () => {
    const runAgent = agentReturning();

    callAgent(deps(runAgent), command, 'P', {
      job: 'persona-audit',
      timeoutMs: 5,
    });

    const call = /** @type {any} */ (runAgent.mock.calls[0])[0];
    expect(path.basename(call.cwd)).toMatch(/^memory-persona-audit-/);
    expect(call.timeoutMs).toBe(5);
  });

  test('should throw with the exit code and the end of the output', () => {
    const runAgent = agentReturning({
      code: 1,
      output: `${'x'.repeat(400)}auth error\n`,
    });

    expect(() =>
      callAgent(deps(runAgent), command, 'P', { job: 'compaction' })
    ).toThrow(/^the compaction agent exited with code 1: x+auth error$/);
    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      /^the extraction agent exited with code 1: x{290}auth error$/
    );
  });

  test('should say which signal stopped the agent', () => {
    const runAgent = agentReturning({
      code: null,
      signal: 'SIGTERM',
      output: '(stopped)',
    });

    expect(() => callAgent(deps(runAgent), command, 'P')).toThrow(
      'the extraction agent was stopped by SIGTERM: (stopped)'
    );
  });

  test('should remove the folder when the call itself throws', () => {
    const runAgent = vi.fn(() => {
      throw new Error('spawn failed');
    });

    expect(() =>
      callAgent(deps(/** @type {any} */ (runAgent)), command, 'P')
    ).toThrow('spawn failed');
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe('jsonObjectOf', () => {
  test('should find the object inside prose or a code fence', () => {
    expect(
      jsonObjectOf('Here it is:\n```json\n{"a": [1]}\n```\nDone.')
    ).toEqual({ a: [1] });
  });

  test('should return null without a parsable object', () => {
    expect(jsonObjectOf('no json here')).toBeNull();
    expect(jsonObjectOf('} before {')).toBeNull();
    expect(jsonObjectOf('{"a": 1} and {"b": 2}')).toBeNull();
  });
});
