import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { vi } from 'vitest';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  COMMANDS,
  defaultDeps,
  helpText,
  main,
  packageVersion,
  parseArgs,
} from '../cli.js';

const KEY = 'sk-test-token-1234567890';
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8')
).version;

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cli-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal kyoten workspace. */
function makeHome() {
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'package.json'),
    JSON.stringify({ name: 'kyoten' })
  );
  fs.writeFileSync(path.join(home, 'utils', 'kyoten', 'cli.js'), '');
  return home;
}

class FakeChild extends EventEmitter {
  kill() {
    return true;
  }
}

/**
 * Run main() with fake I/O; the fake agent exits with `exit`.
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, exit?: number, stdin?: any, cwd?: string }} [options]
 */
async function run(argv, { env = {}, exit = 0, stdin, cwd = tmp } = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @type {string[]} */
  const tty = [];
  const spawn = vi.fn(
    (
      /** @type {string} */ _bin,
      /** @type {string[]} */ _args,
      /** @type {any} */ _options
    ) => {
      const child = new FakeChild();
      setImmediate(() => child.emit('exit', exit, null));
      return child;
    }
  );
  const code = await main(argv, {
    env: { PATH: '/bin', XDG_CONFIG_HOME: path.join(tmp, 'cfg'), ...env },
    cwd,
    platform: 'linux',
    homedir: path.join(tmp, 'user'),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stdin: stdin ?? Readable.from([]),
    tty: { write: (/** @type {string} */ text) => tty.push(text) },
    spawn,
    signals: new EventEmitter(),
    canRun: (file) => file === '/bin/claude' || file === '/bin/codex',
    registry: () => null,
  });
  return { code, out, err, tty, spawn };
}

describe('parseArgs', () => {
  test.each([
    [[], { agent: 'claude', args: [] }],
    [['-c'], { agent: 'claude', args: ['-c'] }],
    [['fix the bug'], { agent: 'claude', args: ['fix the bug'] }],
    [['codex', '--model', 'x'], { agent: 'codex', args: ['--model', 'x'] }],
    [['--dsh', 'tui'], { agent: 'dsh', args: ['tui'] }],
    [['dscc', '--set-key'], { agent: 'dscc', args: ['--set-key'] }],
    [['claude', 'update'], { agent: 'claude', args: ['update'] }],
    [['init', '--no-setup'], { command: 'init', args: ['--no-setup'] }],
    [['--init'], { agent: 'claude', args: ['--init'] }],
    [['--home', '/h', 'codex'], { home: '/h', agent: 'codex', args: [] }],
    [['--home=/h', 'where'], { home: '/h', command: 'where', args: [] }],
    [['--help'], { help: true, agent: 'claude', args: [] }],
    [['-h'], { help: true, agent: 'claude', args: [] }],
    [['--version'], { version: true, agent: 'claude', args: [] }],
    [['codex', '--help'], { agent: 'codex', args: ['--help'] }],
  ])('should parse %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual({
      help: false,
      version: false,
      ...expected,
    });
  });

  test.each([[['--home']], [['--home=']], [['--home', '']]])(
    'should require a value for %j',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow('--home needs a directory');
    }
  );
});

describe('packageVersion and helpText', () => {
  test('should read the version of the workspace package', () => {
    expect(packageVersion()).toBe(VERSION);
  });

  test('should read the version of another root', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ version: '9.9.9' })
    );

    expect(packageVersion(tmp)).toBe('9.9.9');
  });

  test('should name the version, the config file, and every command', () => {
    const help = helpText('1.2.3', '/cfg/config.json');

    expect(help).toContain('kyoten 1.2.3');
    expect(help).toContain('Config: /cfg/config.json');
    for (const command of COMMANDS) expect(help).toContain(`  ${command}`);
  });
});

describe('main', () => {
  test('should print the help', async () => {
    const { code, out } = await run(['--help']);

    expect(code).toBe(0);
    expect(out[0]).toContain(`kyoten ${VERSION}`);
    expect(out[0]).toContain(path.join(tmp, 'cfg', 'kyoten', 'config.json'));
  });

  test('should print the help for the help command', async () => {
    const { out } = await run(['help']);

    expect(out[0]).toContain('Usage');
  });

  test.each([[['--version']], [['version']]])(
    'should print the version for %j',
    async (argv) => {
      const { code, out } = await run(argv);

      expect(code).toBe(0);
      expect(out).toEqual([VERSION]);
    }
  );

  test('should print the home on stdout and the rule on stderr', async () => {
    const { code, out, err } = await run(['where'], {
      env: { KYOTEN_HOME: '/k' },
    });

    expect(code).toBe(0);
    expect(out).toEqual([path.resolve(tmp, '/k')]);
    expect(err).toEqual(['kyoten: chosen by KYOTEN_HOME']);
  });

  test('should refuse a command that is not built yet', async () => {
    const { code, err } = await run(['doctor']);

    expect(code).toBe(1);
    expect(err).toEqual(['kyoten: kyoten doctor is not available yet.']);
  });

  test('should explain a missing home', async () => {
    const { code, err } = await run([]);

    expect(code).toBe(1);
    expect(err).toEqual([
      `kyoten: no kyoten home at ${path.join(tmp, 'user', '.kyoten')}.`,
      'kyoten: Fix: kyoten init',
    ]);
  });

  test('should report an invalid config file', async () => {
    fs.mkdirSync(path.join(tmp, 'cfg', 'kyoten'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'), '{');

    const { code, err } = await run(['where']);

    expect(code).toBe(1);
    expect(err[0]).toMatch(/config\.json is not valid JSON/);
  });

  test('should start the agent in the home and return its exit code', async () => {
    const home = makeHome();

    const { code, err, spawn } = await run(['--home', home, '-c'], {
      exit: 3,
      env: { CLAUDE_CODE_SESSION_ID: 'parent' },
    });

    expect(code).toBe(3);
    expect(err).toEqual([`kyoten: claude in ${home} (--home)`]);
    const [bin, args, options] = spawn.mock.calls[0];
    expect([bin, args]).toEqual(['/bin/claude', ['-c']]);
    expect(options.cwd).toBe(home);
    expect(options.env.KYOTEN_CALLER_DIR).toBe(tmp);
    expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  test('should put the config defaults before the agent arguments', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(tmp, 'cfg', 'kyoten'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'cfg', 'kyoten', 'config.json'),
      JSON.stringify({ home, args: { codex: ['--search'] } })
    );

    const { spawn, err } = await run(['codex', 'resume']);

    expect(spawn.mock.calls[0][1]).toEqual(['--search', 'resume']);
    expect(err[0]).toContain(
      `(${path.join(tmp, 'cfg', 'kyoten', 'config.json')})`
    );
  });

  test('should start dscc with the profile instead of inherited keys', async () => {
    const home = makeHome();
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(
      profile,
      `ANTHROPIC_BASE_URL=https://ds\nANTHROPIC_AUTH_TOKEN=${KEY}\n9X=1\n`
    );

    const { spawn, err } = await run(['--home', home, 'dscc'], {
      env: { DSCC_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-inherited' },
    });

    const env = spawn.mock.calls[0][2].env;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ds');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(err[0]).toBe(
      'kyoten: dscc profile line 3 skipped: not a variable name: 9X'
    );
  });

  test('should show the dscc profile without a home', async () => {
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(profile, `ANTHROPIC_AUTH_TOKEN=${KEY}\n`);

    const { code, out } = await run(['dscc', '--show'], {
      env: { DSCC_PROFILE: profile },
    });

    expect(code).toBe(0);
    expect(out).toEqual([
      `profile: ${profile}`,
      '',
      'ANTHROPIC_AUTH_TOKEN=sk-t...7890',
    ]);
  });

  test('should save a piped key', async () => {
    const profile = path.join(tmp, 'p', 'dscc.env');

    const { code, err } = await run(['dscc', '--set-key'], {
      env: { DSCC_PROFILE: profile },
      stdin: Readable.from([`${KEY}\n`]),
    });

    expect(code).toBe(0);
    expect(err).toEqual([`kyoten: key saved to ${profile} (new profile)`]);
    expect(fs.readFileSync(profile, 'utf-8')).toContain(
      `ANTHROPIC_AUTH_TOKEN=${KEY}`
    );
  });

  test('should prompt for the key without echo in a terminal', async () => {
    const profile = path.join(tmp, 'dscc.env');
    fs.writeFileSync(profile, 'ANTHROPIC_AUTH_TOKEN=\n');
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode: () => {},
      setEncoding: () => {},
      pause: () => {},
      resume() {
        setImmediate(() => stdin.emit('data', `${KEY}\r`));
      },
    });

    const { code, err, tty } = await run(['dscc', '--set-key'], {
      env: { DSCC_PROFILE: profile },
      stdin,
    });

    expect(code).toBe(0);
    expect(tty).toEqual(['DeepSeek API key (hidden): ', '\n']);
    expect(err).toEqual([`kyoten: key saved to ${profile}`]);
  });

  test('should print a thrown value that is not an Error', async () => {
    /** @type {string[]} */
    const errors = [];

    const code = await main(['where'], {
      ...defaultDeps(),
      cwd: tmp,
      env: { XDG_CONFIG_HOME: path.join(tmp, 'cfg') },
      out: () => {
        // eslint-disable-next-line no-throw-literal -- main() must also report a thrown non-Error
        throw 'boom';
      },
      err: (text) => errors.push(text),
    });

    expect(code).toBe(1);
    expect(errors).toEqual(['kyoten: boom']);
  });
});

describe('defaultDeps', () => {
  test('should write to the process streams', () => {
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const deps = defaultDeps();

    deps.out('o');
    deps.err('e');

    expect(stdout).toHaveBeenCalledWith('o\n');
    expect(stderr).toHaveBeenCalledWith('e\n');
    expect(deps.cwd).toBe(process.cwd());
    expect(deps.platform).toBe(process.platform);
  });
});
