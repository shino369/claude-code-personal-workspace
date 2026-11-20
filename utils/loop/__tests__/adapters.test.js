import { vi } from 'vitest';
import {
  AGENTS,
  buildCommand,
  dshDirProblem,
  installHint,
  runAgent,
} from '../adapters.js';

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

  test('should build the dsh headless command with the workspace hooks patch', () => {
    expect(buildCommand({ agent: 'dsh' }).args).toEqual([
      '--profile',
      'headless',
      '--permission-mode',
      'workspace-write',
      '--approval-policy',
      'never',
      '--patch',
      '.dsh/workspace.patch.yml',
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

  test('should build read-only commands in read mode', () => {
    expect(buildCommand({ agent: 'claude', mode: 'read' }).args).toEqual([
      '-p',
      '--permission-mode',
      'plan',
      '--output-format',
      'text',
      '--no-session-persistence',
    ]);
    expect(buildCommand({ agent: 'codex', mode: 'read' }).args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '-',
    ]);
    expect(buildCommand({ agent: 'dsh', mode: 'read' }).args).toEqual([
      '--profile',
      'headless',
      '--permission-mode',
      'read-only',
      '--approval-policy',
      'never',
      '--patch',
      '.dsh/workspace.patch.yml',
      '-',
    ]);
  });

  test('should reject an unknown mode with a Fix line', () => {
    expect(() => buildCommand({ agent: 'codex', mode: 'yolo' })).toThrow(
      /Unknown mode "yolo"\.\nFix: use mode write or read/
    );
  });

  test('should use a registry argv prefix as-is, paths with spaces included', () => {
    const command = buildCommand({
      agent: 'codex',
      argv: ['/Program Files/codex', '--profile', 'x'],
    });
    expect(command.bin).toBe('/Program Files/codex');
    expect(command.args.slice(0, 3)).toEqual(['--profile', 'x', 'exec']);
  });

  test('should prefer --bin over the registry argv, and ignore an empty argv', () => {
    expect(
      buildCommand({ agent: 'dsh', bin: 'mydsh', argv: ['npx', '-y', 'x'] }).bin
    ).toBe('mydsh');
    expect(buildCommand({ agent: 'dsh', argv: [] }).bin).toBe('dsh');
    expect(buildCommand({ agent: 'dsh', argv: null }).bin).toBe('dsh');
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

describe('dshDirProblem', () => {
  test('should accept ordinary paths, with spaces, and Windows backslashes', () => {
    expect(dshDirProblem('/Users/me/My Repo', 'darwin')).toBeNull();
    expect(dshDirProblem('C:\\Users\\me\\ws', 'win32')).toBeNull();
  });

  test.each([
    ['/home/me/a$b', 'linux'],
    ['/home/me/a`b', 'linux'],
    ['/home/me/a"b', 'linux'],
    ['/home/me/a\\b', 'linux'],
    ['/home/me/a\nb', 'linux'],
    ['C:\\Users\\me\\a$b', 'win32'],
    ['C:\\Users\\me\\a`b', 'win32'],
  ])(
    'should refuse %j on %s: the hook command reads it as shell syntax',
    (dir, platform) => {
      expect(dshDirProblem(dir, platform)).toMatch(
        /^DSH cannot run this workspace's hooks from .*\nFix: /s
      );
    }
  );
});

describe('runAgent', () => {
  const command = buildCommand({ agent: 'codex' });
  let clock = 0;
  const now = () => (clock += 1000);

  test('should refuse to start DSH from a dir its hook commands cannot carry', () => {
    const spawn = vi.fn();
    expect(() =>
      runAgent({
        command: buildCommand({ agent: 'dsh' }),
        cwd: '/wt/a$b',
        prompt: 'p',
        timeoutMs: 1,
        env: {},
        spawn,
        now,
        platform: 'linux',
      })
    ).toThrow(/DSH cannot run this workspace's hooks from \/wt\/a\$b/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should start the other agents from such a dir', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    runAgent({
      command,
      cwd: '/wt/a$b',
      prompt: 'p',
      timeoutMs: 1,
      env: {},
      spawn,
      now,
      platform: 'linux',
    });
    expect(spawn).toHaveBeenCalled();
  });

  test("should not pass the parent harness's session ids to the child agent", () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const env = {
      A: '1',
      TASK_SESSION: 'mine',
      CLAUDE_CODE_SESSION_ID: 'cc-1',
      CODEX_THREAD_ID: 'cx-1',
      CODEX_SESSION_ID: 'cx-1',
      DSH_SESSION_ID: 'dsh-1',
    };
    runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1,
      env,
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({ env: { A: '1', TASK_SESSION: 'mine' } })
    );
    expect(env.CLAUDE_CODE_SESSION_ID).toBe('cc-1');
  });

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
      stdout: 'done',
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
    expect(result.stdout).toBe('');
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
