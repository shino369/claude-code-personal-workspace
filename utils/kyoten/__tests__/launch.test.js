import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { DSH_PATCH } from '../../loop/adapters.js';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  DSH_DEFAULT_PROFILE,
  agentBin,
  agentInstallHint,
  buildArgv,
  buildEnv,
  exitCode,
  findAgentCommand,
  prepareLaunch,
  spawnInteractive,
} from '../launch.js';

const POSIX_ENV = { PATH: '/bin:/usr/bin' };

/** A fake child process: records kill() calls, exits on demand. */
class FakeChild extends EventEmitter {
  /** @type {(string | undefined)[]} */
  killed = [];

  /** @param {string} [signal] */
  kill(signal) {
    this.killed.push(signal);
    return true;
  }
}

/**
 * @param {FakeChild} child
 */
function fakeSpawn(child) {
  return vi.fn(
    (
      /** @type {string} */ _bin,
      /** @type {string[]} */ _args,
      /** @type {object} */ _options
    ) => child
  );
}

describe('agentBin', () => {
  test('should run dscc as claude and every other agent as itself', () => {
    expect(agentBin('dscc')).toBe('claude');
    expect(agentBin('claude')).toBe('claude');
    expect(agentBin('codex')).toBe('codex');
    expect(agentBin('dsh')).toBe('dsh');
  });
});

describe('findAgentCommand', () => {
  const base = {
    home: '/home',
    env: POSIX_ENV,
    platform: /** @type {const} */ ('linux'),
  };

  test('should use the executable on PATH first', () => {
    const registry = vi.fn(() => ['npx', 'x']);

    const command = findAgentCommand({
      ...base,
      agent: 'codex',
      canRun: (file) => file === path.posix.join('/usr/bin', 'codex'),
      registry,
    });

    expect(command).toEqual(['/usr/bin/codex']);
    expect(registry).not.toHaveBeenCalled();
  });

  test('should fall back to the tools registry of the home', () => {
    const registry = vi.fn(() => ['npx', '-y', '@deepseek-ai/dsh']);

    const command = findAgentCommand({
      ...base,
      agent: 'dsh',
      canRun: () => false,
      registry,
    });

    expect(command).toEqual(['npx', '-y', '@deepseek-ai/dsh']);
    expect(registry).toHaveBeenCalledWith('/home', 'dsh');
  });

  test.each([
    ['no entry', () => null],
    ['an empty entry', () => []],
    [
      'an unreadable registry',
      () => {
        throw new Error('bad json');
      },
    ],
  ])('should return null for %s', (_label, registry) => {
    expect(
      findAgentCommand({
        ...base,
        agent: 'claude',
        canRun: () => false,
        registry,
      })
    ).toBeNull();
  });
});

describe('agentInstallHint', () => {
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-launch-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('should give the catalog hint for this platform', () => {
    expect(agentInstallHint('dsh', ROOT_DIR, 'linux')).toContain(
      '@deepseek-ai/dsh'
    );
  });

  test('should fall back to the docs link of the catalog entry', () => {
    expect(agentInstallHint('dscc', ROOT_DIR, 'darwin')).toBe(
      'see https://code.claude.com/docs'
    );
  });

  test('should give a generic hint when the entry has no hint or docs', () => {
    fs.mkdirSync(path.join(tmp, 'tools'));
    fs.writeFileSync(
      path.join(tmp, 'tools', 'catalog.json'),
      JSON.stringify({
        version: 1,
        tools: [
          { name: 'codex', kind: 'agent', purpose: 'x', check: ['codex'] },
        ],
      })
    );

    expect(agentInstallHint('codex', tmp, 'linux')).toMatch(
      /^install codex and make sure/
    );
  });

  test('should give a generic hint when the home has no catalog', () => {
    expect(agentInstallHint('claude', tmp, 'linux')).toMatch(/^install claude/);
  });
});

describe('buildArgv', () => {
  test('should put the config defaults before the user arguments', () => {
    const argv = buildArgv({
      agent: 'dscc',
      command: ['/bin/claude'],
      args: ['-c'],
      defaults: ['--dangerously-skip-permissions'],
    });

    expect(argv).toEqual([
      '/bin/claude',
      '--dangerously-skip-permissions',
      '-c',
    ]);
  });

  test('should start dsh with the default profile and the workspace patch', () => {
    const argv = buildArgv({
      agent: 'dsh',
      command: ['npx', '-y', 'dsh'],
      args: [],
    });

    expect(argv).toEqual([
      'npx',
      '-y',
      'dsh',
      DSH_DEFAULT_PROFILE,
      '--patch',
      DSH_PATCH,
    ]);
  });

  test('should take the first dsh argument as the profile', () => {
    const argv = buildArgv({
      agent: 'dsh',
      command: ['dsh'],
      args: ['tui', '--x'],
      defaults: ['--d'],
    });

    expect(argv).toEqual(['dsh', 'tui', '--patch', DSH_PATCH, '--d', '--x']);
  });

  test('should keep the default dsh profile when the first argument is an option', () => {
    const argv = buildArgv({
      agent: 'dsh',
      command: ['dsh'],
      args: ['--no-open'],
    });

    expect(argv).toEqual(['dsh', 'web', '--patch', DSH_PATCH, '--no-open']);
  });
});

describe('buildEnv', () => {
  test('should drop the harness session ids and add the kyoten variables', () => {
    const env = buildEnv({
      env: {
        PATH: '/bin',
        CLAUDE_CODE_SESSION_ID: 's',
        CODEX_THREAD_ID: 't',
        TASK_SESSION: 'keep',
      },
      home: '/home',
      cwd: '/caller',
      platform: 'linux',
    });

    expect(env).toEqual({
      PATH: '/bin',
      TASK_SESSION: 'keep',
      KYOTEN_HOME: '/home',
      KYOTEN_CALLER_DIR: '/caller',
    });
  });

  test('should drop the listed names, then apply the set values', () => {
    const env = buildEnv({
      env: {
        ANTHROPIC_API_KEY: 'inherited',
        ANTHROPIC_AUTH_TOKEN: 'inherited',
        HOME: '/h',
      },
      home: '/home',
      cwd: '/c',
      platform: 'darwin',
      drop: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
      set: { ANTHROPIC_AUTH_TOKEN: 'profile' },
    });

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('profile');
    expect(env.HOME).toBe('/h');
  });

  test('should drop names matching a trailing-star prefix', () => {
    const env = buildEnv({
      env: {
        ANTHROPIC_BASE_URL: 'x',
        ANTHROPIC_CUSTOM_HEADERS: 'x',
        ANTHROPIC: 'kept',
        MY_ANTHROPIC_X: 'kept',
        anthropic_lower: 'kept',
      },
      home: '/h',
      cwd: '/c',
      platform: 'linux',
      drop: ['ANTHROPIC_*'],
    });

    expect(env).toEqual({
      ANTHROPIC: 'kept',
      MY_ANTHROPIC_X: 'kept',
      anthropic_lower: 'kept',
      KYOTEN_HOME: '/h',
      KYOTEN_CALLER_DIR: '/c',
    });
  });

  test('should match a prefix case-insensitively on Windows', () => {
    const env = buildEnv({
      env: { anthropic_base_url: 'x', Path: 'p' },
      home: 'H',
      cwd: 'C',
      platform: 'win32',
      drop: ['ANTHROPIC_*'],
    });

    expect(env).toEqual({
      Path: 'p',
      KYOTEN_HOME: 'H',
      KYOTEN_CALLER_DIR: 'C',
    });
  });

  test('should skip undefined values', () => {
    const env = buildEnv({
      env: { EMPTY: undefined },
      home: '/h',
      cwd: '/c',
      platform: 'linux',
    });

    expect('EMPTY' in env).toBe(false);
  });

  test('should match names case-insensitively on Windows', () => {
    const env = buildEnv({
      env: {
        Path: 'C:\\bin',
        anthropic_api_key: 'x',
        Kyoten_Home: 'old',
        claude_code_session_id: 's',
      },
      home: 'C:\\home',
      cwd: 'C:\\c',
      platform: 'win32',
      drop: ['ANTHROPIC_API_KEY'],
    });

    expect(env).toEqual({
      Path: 'C:\\bin',
      KYOTEN_HOME: 'C:\\home',
      KYOTEN_CALLER_DIR: 'C:\\c',
    });
  });

  test('should match names case-sensitively on POSIX', () => {
    const env = buildEnv({
      env: { anthropic_api_key: 'x' },
      home: '/h',
      cwd: '/c',
      platform: 'linux',
      drop: ['ANTHROPIC_API_KEY'],
    });

    expect(env.anthropic_api_key).toBe('x');
  });
});

describe('spawnInteractive', () => {
  test('should hand the terminal to the agent and resolve with its exit', async () => {
    const child = new FakeChild();
    const spawn = fakeSpawn(child);
    const signals = new EventEmitter();

    const done = spawnInteractive({
      argv: ['/bin/claude', '-c'],
      cwd: '/home',
      env: { PATH: '/bin' },
      platform: 'linux',
      spawn,
      signals,
    });
    child.emit('exit', 4, null);

    await expect(done).resolves.toEqual({ code: 4, signal: null });
    expect(spawn).toHaveBeenCalledWith('/bin/claude', ['-c'], {
      cwd: '/home',
      env: { PATH: '/bin' },
      stdio: 'inherit',
    });
  });

  test('should ignore Ctrl-C and forward SIGTERM and SIGHUP while the agent runs', async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();

    const done = spawnInteractive({
      argv: ['claude'],
      cwd: '/h',
      env: {},
      platform: 'linux',
      spawn: fakeSpawn(child),
      signals,
    });
    signals.emit('SIGINT', 'SIGINT');
    signals.emit('SIGQUIT', 'SIGQUIT');
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGHUP', 'SIGHUP');
    child.emit('exit', null, 'SIGTERM');
    await done;

    expect(child.killed).toEqual(['SIGTERM', 'SIGHUP']);
  });

  test('should remove its signal handlers when the agent exits', async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();

    const done = spawnInteractive({
      argv: ['claude'],
      cwd: '/h',
      env: {},
      platform: 'linux',
      spawn: fakeSpawn(child),
      signals,
    });
    child.emit('exit', 0, null);
    await done;

    expect(signals.eventNames()).toEqual([]);
  });

  test('should not listen for SIGQUIT on Windows', async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();

    const done = spawnInteractive({
      argv: ['claude'],
      cwd: 'C:\\h',
      env: {},
      platform: 'win32',
      spawn: fakeSpawn(child),
      signals,
    });
    const listening = signals.eventNames();
    child.emit('exit', 0, null);
    await done;

    expect(listening).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });

  test('should explain an executable that cannot be found', async () => {
    const child = new FakeChild();
    const signals = new EventEmitter();

    const done = spawnInteractive({
      argv: ['claude'],
      cwd: '/h',
      env: {},
      platform: 'linux',
      spawn: fakeSpawn(child),
      signals,
    });
    child.emit(
      'error',
      Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    );

    await expect(done).rejects.toThrow(
      'claude could not be started (not found).\nFix: kyoten doctor'
    );
    expect(signals.eventNames()).toEqual([]);
  });

  test('should pass other spawn errors through', async () => {
    const child = new FakeChild();
    const error = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });

    const done = spawnInteractive({
      argv: ['claude'],
      cwd: '/h',
      env: {},
      platform: 'linux',
      spawn: fakeSpawn(child),
      signals: new EventEmitter(),
    });
    child.emit('error', error);

    await expect(done).rejects.toBe(error);
  });

  test('should start a real process with the default spawn', async () => {
    const status = await spawnInteractive({
      argv: [process.execPath, '-e', 'process.exit(7)'],
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH ?? '' },
      platform: process.platform,
      signals: new EventEmitter(),
    });

    expect(status).toEqual({ code: 7, signal: null });
  });
});

describe('exitCode', () => {
  test.each([
    [{ code: 0, signal: null }, 0],
    [{ code: 5, signal: null }, 5],
    [
      { code: null, signal: /** @type {const} */ ('SIGINT') },
      128 + os.constants.signals.SIGINT,
    ],
    [{ code: null, signal: /** @type {NodeJS.Signals} */ ('SIGNOPE') }, 1],
    [{ code: null, signal: null }, 1],
  ])('should map %j to %i', (status, expected) => {
    expect(exitCode(status)).toBe(expected);
  });
});

describe('prepareLaunch', () => {
  test('should refuse a home path dsh cannot carry', () => {
    expect(() =>
      prepareLaunch({
        agent: 'dsh',
        args: [],
        home: '/a$b',
        env: POSIX_ENV,
        platform: 'linux',
        canRun: () => true,
      })
    ).toThrow('DSH cannot run this workspace');
  });

  test('should explain how to install a missing agent', () => {
    expect(() =>
      prepareLaunch({
        agent: 'codex',
        args: [],
        home: ROOT_DIR,
        env: POSIX_ENV,
        platform: 'linux',
        canRun: () => false,
        registry: () => null,
      })
    ).toThrow(/codex was not found \(agent codex\)\.\nFix: /);
  });

  test('should return the argv of an agent that can start', () => {
    const argv = prepareLaunch({
      agent: 'dsh',
      args: ['tui'],
      home: '/home',
      env: POSIX_ENV,
      platform: 'linux',
      defaults: ['--x'],
      canRun: (file) => file === '/bin/dsh',
    });

    expect(argv).toEqual(['/bin/dsh', 'tui', '--patch', DSH_PATCH, '--x']);
  });
});
