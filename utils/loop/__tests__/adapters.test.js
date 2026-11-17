import { vi } from 'vitest';
import { AGENTS, buildCommand, installHint, runAgent } from '../adapters.js';

describe('buildCommand', () => {
  test('should build the claude command with the prompt on stdin', () => {
    expect(buildCommand({ agent: 'claude' })).toEqual({
      agent: 'claude',
      bin: 'claude',
      args: [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'text',
        '--no-session-persistence',
      ],
    });
  });

  test('should build the codex command reading stdin', () => {
    expect(buildCommand({ agent: 'codex' })).toEqual({
      agent: 'codex',
      bin: 'codex',
      args: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
    });
  });

  test('should build the dsh headless command', () => {
    expect(buildCommand({ agent: 'dsh' }).args).toEqual([
      '--profile',
      'headless',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '-',
    ]);
  });

  test('should split --bin on whitespace and keep the adapter args', () => {
    const command = buildCommand({
      agent: 'dsh',
      bin: '  npx -y @deepseek-ai/dsh ',
    });
    expect(command.bin).toBe('npx');
    expect(command.args.slice(0, 4)).toEqual([
      '-y',
      '@deepseek-ai/dsh',
      '--profile',
      'headless',
    ]);
  });

  test('should ignore a blank --bin', () => {
    expect(buildCommand({ agent: 'codex', bin: '  ' }).bin).toBe('codex');
  });

  test('should append the spend cap for claude', () => {
    expect(
      buildCommand({ agent: 'claude', maxBudgetUsd: 2.5 }).args.slice(-2)
    ).toEqual(['--max-budget-usd', '2.5']);
  });

  test('should reject a spend cap for other agents', () => {
    expect(() => buildCommand({ agent: 'codex', maxBudgetUsd: 1 })).toThrow(
      /only supported by --agent claude/
    );
  });

  test('should reject an unknown agent with a Fix line', () => {
    expect(() => buildCommand({ agent: 'opencode' })).toThrow(
      /Fix: use --agent claude\|codex\|dsh/
    );
  });
});

describe('installHint', () => {
  test('should give a hint for every agent', () => {
    for (const agent of AGENTS) expect(installHint(agent)).toBeTruthy();
  });
});

describe('runAgent', () => {
  const command = buildCommand({ agent: 'codex' });
  let clock = 0;
  const now = () => (clock += 1000);

  test('should pass the prompt on stdin and join stdout and stderr', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: 'done',
      stderr: 'note',
    }));
    const result = runAgent({
      command,
      cwd: '/wt',
      prompt: 'fix it',
      timeoutMs: 5000,
      env: { A: '1' },
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({
        cwd: '/wt',
        input: 'fix it',
        timeout: 5000,
        env: { A: '1' },
      })
    );
    expect(result).toEqual({
      code: 0,
      signal: null,
      output: 'done\nnote',
      durationMs: 1000,
    });
  });

  test('should report a timeout kill', () => {
    const result = runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 60000,
      env: {},
      spawn: () => ({
        status: null,
        signal: 'SIGTERM',
        stdout: null,
        error: new Error('spawnSync codex ETIMEDOUT'),
      }),
      now,
    });
    expect(result.signal).toBe('SIGTERM');
    expect(result.output).toContain('ETIMEDOUT');
    expect(result.output).toContain('(stopped by SIGTERM; timeout 60s)');
  });

  test('should throw a Fix line when the executable is missing', () => {
    const error = Object.assign(new Error('spawnSync dsh ENOENT'), {
      code: 'ENOENT',
    });
    expect(() =>
      runAgent({
        command: buildCommand({ agent: 'dsh' }),
        cwd: '/wt',
        prompt: 'p',
        timeoutMs: 1,
        env: {},
        spawn: () => ({ status: null, error }),
      })
    ).toThrow(/dsh was not found.*\nFix: pass --bin/s);
  });
});
