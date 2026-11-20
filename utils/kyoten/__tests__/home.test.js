import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  HOME_INFO,
  SNAPSHOT_FILE,
  configDir,
  configFile,
  configPath,
  defaultHome,
  expandHome,
  findWorkspace,
  homeState,
  isWorkspace,
  readConfig,
  readHomeInfo,
  resolveHome,
  validateConfig,
  writeConfig,
  writeHomeInfo,
} from '../home.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-home-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A minimal kyoten workspace in `dir`.
 *
 * @param {string} dir
 * @param {{ name?: string, cli?: boolean, snapshot?: boolean }} [options]
 */
function makeWorkspace(
  dir,
  { name = 'kyoten', cli = true, snapshot = false } = {}
) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  if (cli) fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
  if (snapshot) fs.writeFileSync(path.join(dir, SNAPSHOT_FILE), '{}');
  return dir;
}

describe('configDir', () => {
  test('should use APPDATA on Windows', () => {
    const dir = configDir({
      env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' },
      platform: 'win32',
      homedir: 'C:\\Users\\a',
    });

    expect(dir).toBe('C:\\Users\\a\\AppData\\Roaming\\kyoten');
  });

  test('should fall back to the roaming profile when APPDATA is unset', () => {
    const dir = configDir({
      env: {},
      platform: 'win32',
      homedir: 'C:\\Users\\a',
    });

    expect(dir).toBe('C:\\Users\\a\\AppData\\Roaming\\kyoten');
  });

  test('should use an absolute XDG_CONFIG_HOME on POSIX', () => {
    const dir = configDir({
      env: { XDG_CONFIG_HOME: '/xdg' },
      platform: 'linux',
      homedir: '/home/a',
    });

    expect(dir).toBe('/xdg/kyoten');
  });

  test('should ignore a relative XDG_CONFIG_HOME', () => {
    const dir = configDir({
      env: { XDG_CONFIG_HOME: 'rel' },
      platform: 'darwin',
      homedir: '/Users/a',
    });

    expect(dir).toBe('/Users/a/.config/kyoten');
  });

  test('should put config.json and other files in the config dir', () => {
    const dirs = {
      env: {},
      platform: /** @type {const} */ ('linux'),
      homedir: '/home/a',
    };

    expect(configFile(dirs)).toBe('/home/a/.config/kyoten/config.json');
    expect(configPath(dirs, 'dscc.env')).toBe(
      '/home/a/.config/kyoten/dscc.env'
    );
  });
});

describe('defaultHome', () => {
  test('should be ~/.kyoten on every platform', () => {
    expect(defaultHome({ platform: 'linux', homedir: '/home/a' })).toBe(
      '/home/a/.kyoten'
    );
    expect(defaultHome({ platform: 'win32', homedir: 'C:\\Users\\a' })).toBe(
      'C:\\Users\\a\\.kyoten'
    );
  });
});

describe('expandHome', () => {
  test.each([
    ['~', '/h'],
    ['~/x/y', path.join('/h', 'x/y')],
    ['~\\x', path.join('/h', 'x')],
    ['/abs', '/abs'],
    ['rel/~', 'rel/~'],
  ])('should expand %s', (input, expected) => {
    expect(expandHome(input, '/h')).toBe(expected);
  });
});

describe('validateConfig', () => {
  const abs = path.resolve('/abs/home');

  test('should accept a home and per-agent args', () => {
    const config = validateConfig(
      { home: abs, args: { dscc: ['--dangerously-skip-permissions'] } },
      'config.json'
    );

    expect(config).toEqual({
      home: abs,
      args: { dscc: ['--dangerously-skip-permissions'] },
    });
  });

  test.each([
    [[], 'expected a JSON object'],
    [null, 'expected a JSON object'],
    ['x', 'expected a JSON object'],
    [{ home: 'relative' }, '"home" must be an absolute path'],
    [{ home: 3 }, '"home" must be an absolute path'],
    [{ args: [] }, '"args" must map an agent'],
    [{ args: { cursor: [] } }, 'unknown agent "cursor"'],
    [{ args: { claude: '--x' } }, '"args.claude" must be a list of strings'],
    [{ args: { claude: [1] } }, '"args.claude" must be a list of strings'],
    [{ hme: abs }, 'unknown key "hme"'],
  ])('should reject %j', (data, message) => {
    expect(() => validateConfig(data, 'c.json')).toThrow(message);
  });

  test('should name the file and the fix in the error', () => {
    expect(() => validateConfig([], '/x/config.json')).toThrow(
      /^\/x\/config\.json: .*\nFix: /s
    );
  });
});

describe('readConfig and writeConfig', () => {
  test('should return an empty config when the file is missing', () => {
    expect(readConfig(path.join(tmp, 'none.json'))).toEqual({});
  });

  test('should reject a file that is not JSON', () => {
    const file = path.join(tmp, 'config.json');
    fs.writeFileSync(file, '{');

    expect(() => readConfig(file)).toThrow(`${file} is not valid JSON`);
  });

  test('should write the config, creating its folder, and read it back', () => {
    const file = path.join(tmp, 'a', 'b', 'config.json');
    const config = { home: path.resolve(tmp, 'home') };

    writeConfig(file, config);

    expect(readConfig(file)).toEqual(config);
    expect(fs.readFileSync(file, 'utf-8').endsWith('}\n')).toBe(true);
  });
});

describe('isWorkspace', () => {
  test('should accept a folder with the kyoten package and CLI', () => {
    expect(isWorkspace(makeWorkspace(tmp))).toBe(true);
  });

  test('should reject another package', () => {
    expect(isWorkspace(makeWorkspace(tmp, { name: 'other' }))).toBe(false);
  });

  test('should reject a kyoten package without the CLI', () => {
    expect(isWorkspace(makeWorkspace(tmp, { cli: false }))).toBe(false);
  });

  test('should reject the snapshot inside the npm package', () => {
    expect(isWorkspace(makeWorkspace(tmp, { snapshot: true }))).toBe(false);
  });

  test('should reject a folder without package.json', () => {
    expect(isWorkspace(tmp)).toBe(false);
  });

  test('should reject a package.json that is JSON null', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), 'null');

    expect(isWorkspace(tmp)).toBe(false);
  });
});

describe('findWorkspace', () => {
  test('should find the workspace above a nested folder', () => {
    makeWorkspace(tmp);
    const nested = path.join(tmp, 'tasks', 'x');
    fs.mkdirSync(nested, { recursive: true });

    expect(findWorkspace(nested)).toBe(path.resolve(tmp));
  });

  test('should return null outside any workspace', () => {
    expect(findWorkspace(tmp)).toBeNull();
  });
});

describe('resolveHome', () => {
  const base = {
    env: {},
    config: {},
    configPath: '/c/config.json',
    homedir: '/h',
    platform: /** @type {const} */ ('linux'),
  };

  test('should prefer --home, resolved against the cwd', () => {
    const home = resolveHome({
      ...base,
      flag: 'rel',
      cwd: tmp,
      env: { KYOTEN_HOME: '/e' },
    });

    expect(home).toEqual({ dir: path.resolve(tmp, 'rel'), source: '--home' });
  });

  test('should expand ~ in --home', () => {
    const home = resolveHome({ ...base, flag: '~/k', cwd: tmp });

    expect(home.dir).toBe(path.resolve(tmp, path.join('/h', 'k')));
  });

  test('should use KYOTEN_HOME next', () => {
    const home = resolveHome({
      ...base,
      cwd: tmp,
      env: { KYOTEN_HOME: '~/e' },
    });

    expect(home).toEqual({
      dir: path.resolve(tmp, path.join('/h', 'e')),
      source: 'KYOTEN_HOME',
    });
  });

  test('should use the workspace containing the cwd next', () => {
    makeWorkspace(tmp);

    const home = resolveHome({ ...base, cwd: tmp, config: { home: '/cfg' } });

    expect(home).toEqual({
      dir: path.resolve(tmp),
      source: 'the current directory',
    });
  });

  test('should use the config home next', () => {
    const home = resolveHome({ ...base, cwd: tmp, config: { home: '/cfg' } });

    expect(home).toEqual({ dir: '/cfg', source: '/c/config.json' });
  });

  test('should default to ~/.kyoten', () => {
    const home = resolveHome({ ...base, cwd: tmp });

    expect(home).toEqual({ dir: '/h/.kyoten', source: 'default' });
  });
});

describe('homeState', () => {
  test('should report a missing folder', () => {
    expect(homeState(path.join(tmp, 'none'))).toBe('missing');
  });

  test('should report an empty folder', () => {
    expect(homeState(tmp)).toBe('empty');
  });

  test('should report a kyoten workspace', () => {
    expect(homeState(makeWorkspace(tmp))).toBe('workspace');
  });

  test('should report a folder holding something else', () => {
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x');

    expect(homeState(tmp)).toBe('other');
  });

  test('should report a file as something else', () => {
    const file = path.join(tmp, 'file');
    fs.writeFileSync(file, 'x');

    expect(homeState(file)).toBe('other');
  });

  test('should rethrow other errors', () => {
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });

    expect(() => homeState(tmp)).toThrow('denied');
  });
});

describe('readHomeInfo and writeHomeInfo', () => {
  const info = /** @type {const} */ ({
    managed: true,
    version: '0.1.0',
    sourceCommit: 'abc',
    createdAt: '2026-11-21T00:00:00.000Z',
  });

  test('should round-trip the record', () => {
    writeHomeInfo(tmp, info);

    expect(readHomeInfo(tmp)).toEqual(info);
  });

  test('should return null without a record (a clone)', () => {
    expect(readHomeInfo(tmp)).toBeNull();
  });

  test.each([
    ['not JSON', '{'],
    ['not managed', JSON.stringify({ ...info, managed: false })],
    ['an array', '[]'],
    ['no version', JSON.stringify({ managed: true })],
  ])('should return null for a record that is %s', (_label, text) => {
    fs.mkdirSync(path.join(tmp, '.kyoten'));
    fs.writeFileSync(path.join(tmp, HOME_INFO), text);

    expect(readHomeInfo(tmp)).toBeNull();
  });
});
