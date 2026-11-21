import { vi } from 'vitest';
import {
  AGENTS,
  AGY_READ_SETTINGS,
  AGY_WRITE_SETTINGS,
  buildCommand,
  dshDirProblem,
  installHint,
  parseAgyStreamJson,
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

  test('should build the agy headless command with stream-json and write settings', () => {
    expect(buildCommand({ agent: 'agy' })).toEqual({
      agent: 'agy',
      bin: 'agy',
      args: [
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--disable-slash-commands',
        '--mode',
        'accept-edits',
        '--settings',
        AGY_WRITE_SETTINGS,
      ],
    });
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
    expect(buildCommand({ agent: 'agy', mode: 'read' }).args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--settings',
      AGY_READ_SETTINGS,
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
      /Fix: use --agent claude\|codex\|dsh\|agy/
    );
  });
});

describe('AGY permission settings', () => {
  /** @param {string[]} rules @param {string} cmd */
  function matchesCommand(rules, cmd) {
    return rules.some((rule) => {
      if (rule === `command(${cmd})`) return true;
      const m = /^command\(regex:(.*)\)$/.exec(rule);
      return m ? new RegExp(m[1]).test(cmd) : false;
    });
  }

  /** @param {string} raw @param {string} cmd */
  function allowedCommand(raw, cmd) {
    const { permissions } = JSON.parse(raw);
    return (
      matchesCommand(permissions.allow, cmd) &&
      !matchesCommand(permissions.deny, cmd)
    );
  }

  test('should grant workspace commands and include protected-path denies in write settings', () => {
    const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
    expect(permissions.allow).not.toContain('write_file(*)');
    expect(permissions.allow).not.toContain('read_file(*)');
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'read_file(.env)',
        'read_file(.env.local)',
        'read_file(secrets/)',
        'read_file(credentials.json)',
        'read_file(~/.ssh)',
        'read_file(~/.aws)',
        'write_file(.git/)',
      ])
    );
    for (const cmd of [
      'pnpm check',
      'pnpm test',
      'pnpm test:coverage',
      'pnpm test utils/task/__tests__/store.test.js',
      'pnpm add -D foo --save-catalog-name=dev',
      'pnpm task step s1 done -m "fix(agy): verified"',
      'pnpm task verify',
      'pnpm harness check',
      'pnpm docs:cli --check',
      'pnpm workspace:check',
      'git status --short',
      'git branch --show-current',
      'git commit -m "feat(agy): add support"',
      'node utils/task/cli.js status',
      'mkdir -p src/new-dir',
      'pwd',
    ]) {
      expect(allowedCommand(AGY_WRITE_SETTINGS, cmd)).toBe(true);
    }
    for (const cmd of [
      'pnpm publish',
      'pnpm -s publish',
      'pnpm add -g foo',
      'pnpm add --global foo',
      'pnpm -g add foo',
      'pnpm install -g pkg',
      'pnpm exec rm -rf .',
      'pnpm -r exec rm -rf ../main',
      'pnpm -C . exec cat .env',
      'pnpm dlx evil',
      'pnpm --dir ../main check',
      'pnpm --dir /abs/main format',
      'pnpm format --dir /abs/main',
      'pnpm check -C /abs/main',
      'git branch -D main',
      'git branch --delete main',
      'git commit --no-verify -m x',
      'git commit -nm x',
      'git commit (Remove-Item README.md)',
      'git commit -m "a\\" (Remove-Item x)"',
      'git add -f .env',
      'git diff --output=../main/AGENTS.md',
      'git diff --no-index .env /dev/null',
      'git push origin main',
      'git status (Remove-Item README.md)',
      'rm README.md',
      'type .env',
      'node utils/../../outside.js',
      'git status && rm -rf .',
      'echo bad > ../main/AGENTS.md',
      'echo (Get-Content .env)',
      'echo (Remove-Item -Force ../main/AGENTS.md)',
      'mkdir ../outside',
      'mkdir /abs/outside',
      'mkdir C:\\outside',
      'mkdir ~/outside',
    ]) {
      expect(allowedCommand(AGY_WRITE_SETTINGS, cmd)).toBe(false);
    }
  });

  test.each(['pnpm workspace:setup', 'pnpm memory', 'pnpm memory export'])(
    'should omit shared setup and memory grants in write settings (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      expect(matchesCommand(permissions.allow, cmd)).toBe(false);
    }
  );

  test.each([
    'node utils/workspace-setup.js',
    'node utils/memory/cli.js export',
    'node utils/WORKSPACE-SETUP.js',
    'node utils/MEMORY/CLI.js export',
  ])(
    'should deny the direct Node entries for shared setup and memory (%s)',
    (cmd) => {
      const { permissions } = JSON.parse(AGY_WRITE_SETTINGS);
      expect(matchesCommand(permissions.deny, cmd)).toBe(true);
    }
  );

  test('should include inspection grants and file write and protected-path denies in read settings', () => {
    const { permissions } = JSON.parse(AGY_READ_SETTINGS);
    expect(permissions.allow).not.toContain('write_file(*)');
    expect(permissions.allow).not.toContain('read_file(*)');
    expect(permissions.deny).toEqual(
      expect.arrayContaining([
        'write_file(*)',
        'read_file(.env)',
        'read_file(secrets/)',
        'read_file(credentials.json)',
        'read_file(~/.ssh)',
        'read_file(~/.aws)',
      ])
    );
    for (const cmd of [
      'git status --short',
      'git diff main...HEAD',
      'git log -n 5 --oneline',
      'git show HEAD:package.json',
      'git branch --show-current',
      'ls utils',
      'pwd',
      'node -v',
    ]) {
      expect(allowedCommand(AGY_READ_SETTINGS, cmd)).toBe(true);
    }
    for (const cmd of [
      'git diff --output=AGENTS.md',
      'git diff --no-index .env /dev/null',
      'git diff -O .env',
      'git branch -D main',
      'pnpm lint -- --fix',
      'pnpm test -- --outputFile=AGENTS.md',
      'pnpm test -u',
      'pnpm test --coverage',
      'pnpm check',
      'pnpm format',
      'ls > AGENTS.md',
      "git status && node -e \"require('fs').writeFileSync('x','1')\"",
      'git status $(whoami)',
      'git status (rm x)',
    ]) {
      expect(allowedCommand(AGY_READ_SETTINGS, cmd)).toBe(false);
    }
  });

  test.each([
    'pnpm test',
    'pnpm test utils/loop/__tests__/adapters.test.js',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm format:check',
    'pnpm workspace:check',
    'pnpm harness check',
    'pnpm docs:cli --check',
    'pnpm skills:check',
    'pnpm task status --json',
    'pnpm tools show agy',
  ])('should omit checkout script grants in read settings (%s)', (cmd) => {
    const { permissions } = JSON.parse(AGY_READ_SETTINGS);
    expect(matchesCommand(permissions.allow, cmd)).toBe(false);
  });
});

describe('parseAgyStreamJson', () => {
  test('should extract the last result response on success', () => {
    const raw = [
      'not json',
      JSON.stringify({ event: 'init' }),
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'final answer' },
      }),
      '',
    ].join('\n');
    expect(parseAgyStreamJson(raw)).toEqual({
      stdout: 'final answer',
      failed: false,
    });
  });

  test('should flag non-SUCCESS results and empty responses with denied_actions', () => {
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: { status: 'ERROR', response: 'boom' },
        })
      )
    ).toEqual({ stdout: 'boom', failed: true });
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: '',
            denied_actions: [{ action: 'command' }],
          },
        })
      )
    ).toEqual({ stdout: '', failed: true });
    expect(
      parseAgyStreamJson(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS' },
        })
      )
    ).toEqual({ stdout: '', failed: false });
  });

  test('should fall back to raw output when there is no result event', () => {
    expect(parseAgyStreamJson('plain error text')).toEqual({
      stdout: 'plain error text',
      failed: false,
    });
    const nullResult = JSON.stringify({ event: 'result', result: null });
    expect(parseAgyStreamJson(nullResult)).toEqual({
      stdout: nullResult,
      failed: false,
    });
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
      ANTIGRAVITY_CONVERSATION_ID: 'agy-1',
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

  test('should not open a console window for the child agent', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    runAgent({
      command,
      cwd: '/wt',
      prompt: 'p',
      timeoutMs: 1,
      env: {},
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      command.args,
      expect.objectContaining({ windowsHide: true })
    );
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

  test('should encode prompts and decode stream-json responses for agy', () => {
    const agyCmd = buildCommand({ agent: 'agy', mode: 'read' });
    const ndjson = `${JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok answer' } })}\n`;
    const spawn = vi.fn(() => ({ status: 0, stdout: ndjson, stderr: '' }));
    const ok = runAgent({
      command: agyCmd,
      cwd: '/wt',
      prompt: 'review this',
      timeoutMs: 5000,
      env: {},
      spawn,
      now,
    });
    expect(spawn).toHaveBeenCalledWith(
      'agy',
      agyCmd.args,
      expect.objectContaining({
        input: `${JSON.stringify({ event: 'user', message: { content: 'review this' } })}\n`,
      })
    );
    expect(ok).toMatchObject({ code: 0, stdout: 'ok answer' });

    const denied = runAgent({
      command: agyCmd,
      cwd: '/wt',
      prompt: 'run cmd',
      timeoutMs: 5000,
      env: {},
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: '',
            denied_actions: [{ action: 'command' }],
          },
        }),
        stderr: 'auto-denied',
      }),
      now,
    });
    expect(denied.code).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.output).toContain('auto-denied');
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
