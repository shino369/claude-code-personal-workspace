import { EventEmitter } from 'events';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough, Readable } from 'stream';
import { vi } from 'vitest';
import { crossSpawn } from '../../spawn.js';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  COMMANDS,
  askLine,
  defaultDeps,
  helpText,
  main,
  packageVersion,
  parseArgs,
  parseCommandArgs,
} from '../cli.js';
import { HOME_INFO } from '../home.js';

const KEY = 'sk-test-token-1234567890';
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf-8')
).version;
const realRun = crossSpawn();

/** @type {string} */
let tmp;
/** @type {string} */
let bin;
/** A committed kyoten source repo: the snapshot `init` installs. */
let source = '';

beforeAll(() => {
  source = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cli-src-'));
  fs.mkdirSync(path.join(source, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'kyoten', version: '0.2.0' })
  );
  fs.writeFileSync(path.join(source, 'utils', 'kyoten', 'cli.js'), '// cli\n');
  fs.writeFileSync(
    path.join(source, '.gitignore'),
    '/.kyoten/\nnode_modules/\n'
  );
  const git = (/** @type {string[]} */ ...args) =>
    spawnSync(
      'git',
      ['-C', source, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
      { encoding: 'utf-8' }
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '--no-gpg-sign', '-m', 'init');
});

afterAll(() => {
  fs.rmSync(source, { recursive: true, force: true });
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-cli-'));
  bin = path.join(tmp, 'bin');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The path `which` finds for a fake agent in `bin` on this platform. */
const agentPath = (/** @type {string} */ name) =>
  path.join(bin, process.platform === 'win32' ? `${name}.EXE` : name);

/** A minimal kyoten workspace. */
function makeHome(dir = path.join(tmp, 'home')) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'kyoten' })
  );
  fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
  return dir;
}

/**
 * @param {string} home
 * @param {string} version
 */
function markManaged(home, version) {
  fs.mkdirSync(path.join(home, '.kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(home, HOME_INFO),
    JSON.stringify({
      managed: true,
      version,
      sourceCommit: 'x',
      createdAt: 'then',
    })
  );
}

class FakeChild extends EventEmitter {
  kill() {
    return true;
  }
}

/**
 * Run main() with fake I/O. The fake agent exits with `exit`; git runs for
 * real (with the real PATH), pnpm is faked with `pnpmStatus`.
 *
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, exit?: number, stdin?: any, cwd?: string, answer?: string, pnpmStatus?: number }} [options]
 */
async function run(
  argv,
  { env = {}, exit = 0, stdin, cwd = tmp, answer = '', pnpmStatus = 0 } = {}
) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  /** @type {string[]} */
  const tty = [];
  /** @type {string[]} */
  const questions = [];
  /** @type {string[][]} */
  const pnpm = [];
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
  /** @type {import('../../spawn.js').Spawn} */
  const runSpawn = (file, args, options) => {
    if (file === 'pnpm') {
      pnpm.push(args);
      return { status: pnpmStatus, stdout: '12.14.0\n' };
    }
    const opts = /** @type {{ env?: NodeJS.ProcessEnv }} */ (options);
    return realRun(file, args, {
      ...options,
      env: { ...process.env, ...opts.env, PATH: process.env.PATH },
    });
  };
  const code = await main(argv, {
    env: { PATH: bin, XDG_CONFIG_HOME: path.join(tmp, 'cfg'), ...env },
    cwd,
    platform: process.platform,
    homedir: path.join(tmp, 'user'),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stdin: stdin ?? Readable.from([]),
    tty: { write: (/** @type {string} */ text) => tty.push(text) },
    spawn,
    signals: new EventEmitter(),
    canRun: (file) =>
      path.dirname(file) === bin &&
      /^(claude|codex)(\.exe)?$/i.test(path.basename(file)),
    registry: () => null,
    run: runSpawn,
    ask: async (question) => {
      questions.push(question);
      return answer;
    },
    root: source,
  });
  return { code, out, err, tty, spawn, questions, pnpm };
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

describe('parseCommandArgs', () => {
  test.each([
    ['init', [], { setup: true }],
    ['init', ['d', '--no-setup'], { dir: 'd', setup: false }],
    ['update', ['--no-setup'], { setup: false }],
    ['doctor', [], { setup: true }],
  ])('should parse %s %j', (command, args, expected) => {
    expect(parseCommandArgs(/** @type {any} */ (command), args)).toEqual(
      expected
    );
  });

  test.each([
    ['init', ['a', 'b'], 'kyoten init [<dir>] [--no-setup]'],
    ['init', ['--yes'], 'kyoten init [<dir>] [--no-setup]'],
    ['update', ['dir'], 'kyoten update [--no-setup]'],
    ['doctor', ['--no-setup'], 'kyoten doctor'],
  ])('should refuse %s %j', (command, args, usage) => {
    expect(() => parseCommandArgs(/** @type {any} */ (command), args)).toThrow(
      `\nFix: ${usage}`
    );
  });
});

describe('packageVersion and helpText', () => {
  test('should read the version of the workspace package', () => {
    expect(packageVersion()).toBe(VERSION);
  });

  test('should read the version of another root', () => {
    expect(packageVersion(source)).toBe('0.2.0');
  });

  test('should name the version, the config file, and every command', () => {
    const help = helpText('1.2.3', '/cfg/config.json');

    expect(help).toContain('kyoten 1.2.3');
    expect(help).toContain('Config: /cfg/config.json');
    for (const command of COMMANDS) expect(help).toContain(`  ${command}`);
  });
});

describe('main: help, version, where', () => {
  test('should print the help', async () => {
    const { code, out } = await run(['--help']);

    expect(code).toBe(0);
    expect(out[0]).toContain('kyoten 0.2.0');
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
      expect(out).toEqual(['0.2.0']);
    }
  );

  test('should print the home on stdout and the rule on stderr', async () => {
    const { code, out, err } = await run(['where'], {
      env: { KYOTEN_HOME: path.join(tmp, 'k') },
    });

    expect(code).toBe(0);
    expect(out).toEqual([path.join(tmp, 'k')]);
    expect(err).toEqual(['kyoten: chosen by KYOTEN_HOME']);
  });

  test('should report an invalid config file', async () => {
    fs.mkdirSync(path.join(tmp, 'cfg', 'kyoten'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'), '{');

    const { code, err } = await run(['where']);

    expect(code).toBe(1);
    expect(err[0]).toMatch(/config\.json is not valid JSON/);
  });
});

describe('main: init and update', () => {
  test('should create a home in <dir> and make it the default', async () => {
    const home = path.join(tmp, 'new-home');

    const { code, err, pnpm } = await run(['init', home, '--no-setup']);

    const config = JSON.parse(
      fs.readFileSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'), 'utf-8')
    );
    expect(code).toBe(0);
    expect(
      fs.readFileSync(path.join(home, 'utils', 'kyoten', 'cli.js'), 'utf-8')
    ).toBe('// cli\n');
    expect(config).toEqual({ home });
    expect(err.at(-2)).toBe(
      `kyoten: ${home} is now the default home (${path.join(tmp, 'cfg', 'kyoten', 'config.json')})`
    );
    expect(pnpm).toEqual([['--version']].slice(0, 0));
  });

  test('should create the resolved home without changing the config', async () => {
    const home = path.join(tmp, 'k');

    const { code, pnpm } = await run(['init'], { env: { KYOTEN_HOME: home } });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, HOME_INFO))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'cfg', 'kyoten', 'config.json'))).toBe(
      false
    );
    expect(pnpm.slice(1).map((args) => args[0])).toEqual([
      'install',
      'workspace:setup',
    ]);
  });

  test('should update a home kyoten created', async () => {
    const home = path.join(tmp, 'k');
    await run(['init', '--no-setup'], { env: { KYOTEN_HOME: home } });

    const { code, err } = await run(['update', '--no-setup'], {
      env: { KYOTEN_HOME: home },
    });

    expect(code).toBe(0);
    expect(err.at(-1)).toBe(`kyoten: ${home} already has kyoten 0.2.0`);
  });
});

describe('main: doctor', () => {
  test('should report a missing home as a warning and pass', async () => {
    const { code, out } = await run(['doctor'], {
      env: { DSCC_PROFILE: path.join(tmp, 'none.env') },
    });

    expect(code).toBe(0);
    expect(
      out.some(
        (line) =>
          line.startsWith('! home: ') && line.includes('does not exist yet')
      )
    ).toBe(true);
    expect(out.at(-1)).toBe('kyoten is ready.');
  });

  test('should fail for a home without dependencies', async () => {
    const home = makeHome();

    const { code, out } = await run(['--home', home, 'doctor']);

    expect(code).toBe(1);
    expect(out).toContain(
      `✗ workspace: dependencies are not installed\n    Fix: kyoten --home "${home}" init`
    );
    expect(out.at(-1)).toBe('1 problem(s) need a fix (see the Fix lines).');
  });
});

describe('main: launch', () => {
  test('should start the agent in the home and return its exit code', async () => {
    const home = makeHome();

    const { code, err, spawn } = await run(['--home', home, '-c'], {
      exit: 3,
      env: { CLAUDE_CODE_SESSION_ID: 'parent' },
    });

    expect(code).toBe(3);
    expect(err).toEqual([`kyoten: claude in ${home} (--home)`]);
    const [file, args, options] = spawn.mock.calls[0];
    expect([file, args]).toEqual([agentPath('claude'), ['-c']]);
    expect(options.cwd).toBe(home);
    expect(options.env.KYOTEN_CALLER_DIR).toBe(tmp);
    expect(options.env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  test('should put the config defaults before the agent arguments', async () => {
    const home = makeHome();
    const configPath = path.join(tmp, 'cfg', 'kyoten', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ home, args: { codex: ['--search'] } })
    );

    const { spawn, err } = await run(['codex', 'resume']);

    expect(spawn.mock.calls[0][1]).toEqual(['--search', 'resume']);
    expect(err[0]).toBe(`kyoten: codex in ${home} (${configPath})`);
  });

  test('should hint at kyoten update for a home made by an older kyoten', async () => {
    const home = makeHome();
    markManaged(home, '0.1.0');

    const { err } = await run(['--home', home]);

    expect(err[0]).toBe(
      'kyoten: kyoten 0.2.0 is available for this home (it has 0.1.0): kyoten update'
    );
  });

  test('should hint at a newer kyoten for a home made by one', async () => {
    const home = makeHome();
    markManaged(home, '0.3.0');

    const { err } = await run(['--home', home]);

    expect(err[0]).toBe(
      'kyoten: this home has kyoten 0.3.0, newer than this kyoten 0.2.0: npx kyoten@latest'
    );
  });

  test('should give no hint when the versions match', async () => {
    const home = makeHome();
    markManaged(home, '0.2.0');

    const { err } = await run(['--home', home]);

    expect(err).toEqual([`kyoten: claude in ${home} (--home)`]);
  });

  test('should explain a missing home outside a terminal', async () => {
    const { code, err } = await run([]);

    expect(code).toBe(1);
    expect(err).toEqual([
      `kyoten: no kyoten home at ${path.join(tmp, 'user', '.kyoten')} yet.`,
      'kyoten: Fix: kyoten init',
    ]);
  });

  test('should refuse a home that holds something else', async () => {
    const home = path.join(tmp, 'other');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'x'), 'x');

    const { code, err } = await run(['--home', home]);

    expect(code).toBe(1);
    expect(err[0]).toBe(`kyoten: ${home} (--home) is not a kyoten workspace.`);
  });

  test('should offer to create a missing home in a terminal and stop on no', async () => {
    const { code, err, questions, spawn } = await run([], {
      stdin: { isTTY: true },
      answer: 'n',
    });

    expect(code).toBe(1);
    expect(questions).toEqual([
      `kyoten: no kyoten home at ${path.join(tmp, 'user', '.kyoten')} yet. Create it now? [Y/n] `,
    ]);
    expect(err).toEqual([
      'kyoten: nothing created; run kyoten init when you are ready',
    ]);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('should create the home on Enter, then start the agent', async () => {
    const home = path.join(tmp, 'user', '.kyoten');

    const { code, spawn, pnpm } = await run([], {
      stdin: { isTTY: true },
      answer: '',
    });

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, HOME_INFO))).toBe(true);
    expect(pnpm.map((args) => args[0])).toEqual([
      '--version',
      'install',
      'workspace:setup',
    ]);
    expect(spawn.mock.calls[0][2].cwd).toBe(home);
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
});

describe('main: dscc profile', () => {
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
});

describe('main: errors', () => {
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

describe('askLine', () => {
  test('should return one answer and stop reading', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = askLine({ input, output, question: 'Q? ' });
    input.write('yes\nmore\n');

    await expect(answer).resolves.toBe('yes');
    expect(String(output.read())).toBe('Q? ');
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

  test('should ask on stderr and read the answer from stdin', async () => {
    const input = new PassThrough();
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(
      /** @type {any} */ (input)
    );
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const answer = defaultDeps().ask('Create? ');
    input.write('y\n');

    await expect(answer).resolves.toBe('y');
    expect(stderr.mock.calls.map((call) => call[0])).toContain('Create? ');
  });
});
