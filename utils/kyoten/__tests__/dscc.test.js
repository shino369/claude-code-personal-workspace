import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { vi } from 'vitest';
import {
  TEMPLATE_FILE,
  TOKEN_KEYS,
  dsccEnv,
  mask,
  parseLine,
  parseProfile,
  profilePath,
  readFirstLine,
  readHidden,
  setKey,
  showProfile,
  tokenUnset,
} from '../dscc.js';

const KEY = 'sk-test-token-1234567890';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-dscc-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {string} text
 */
function write(name, text) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text);
  return file;
}

/** A fake TTY stdin for readHidden. */
class FakeInput extends EventEmitter {
  isRaw = false;
  /** @type {boolean[]} */
  rawModes = [];
  paused = false;

  /** @param {boolean} mode */
  setRawMode(mode) {
    this.rawModes.push(mode);
    this.isRaw = mode;
  }

  setEncoding() {}

  resume() {
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }
}

function fakeOutput() {
  /** @type {string[]} */
  const written = [];
  return { written, write: (/** @type {string} */ text) => written.push(text) };
}

describe('profilePath', () => {
  test('should use DSCC_PROFILE, with ~ expanded', () => {
    const file = profilePath({
      env: { DSCC_PROFILE: '~/p.env' },
      platform: 'linux',
      homedir: tmp,
    });

    expect(file).toBe(path.resolve(tmp, 'p.env'));
  });

  test('should default to dscc.env in the config dir', () => {
    const file = profilePath({
      env: {},
      platform: 'linux',
      homedir: '/home/a',
    });

    expect(file).toBe('/home/a/.config/kyoten/dscc.env');
  });
});

describe('parseLine', () => {
  test.each([
    ['', null],
    ['   ', null],
    ['# comment', null],
    ['no assignment', null],
    ['KEY=value', { key: 'KEY', value: 'value' }],
    ['  export  KEY = spaced value  ', { key: 'KEY', value: 'spaced value' }],
    ['KEY=$(touch x)', { key: 'KEY', value: '$(touch x)' }],
    ['KEY=a=b', { key: 'KEY', value: 'a=b' }],
    ['1BAD=x', { key: '1BAD', value: 'x', invalid: true }],
    ['=x', { key: '', value: 'x', invalid: true }],
  ])('should parse %j', (line, expected) => {
    expect(parseLine(line)).toEqual(expected);
  });
});

describe('parseProfile', () => {
  test('should keep the last value of each name and report bad names by line', () => {
    const profile = parseProfile('A=1\r\n# c\r\nbad-name=2\r\nA=3\r\n');

    expect([...profile.pairs]).toEqual([['A', '3']]);
    expect(profile.warnings).toEqual([
      'line 3 skipped: not a variable name: bad-name',
    ]);
  });
});

describe('mask', () => {
  test.each([
    [undefined, '<not set>'],
    ['', '<not set>'],
    ['ninechars', '****'],
    ['123456789012345', '****'],
    [KEY, 'sk-t...7890'],
  ])('should mask %j as %j', (value, expected) => {
    expect(mask(value)).toBe(expected);
  });
});

describe('tokenUnset', () => {
  test.each([
    [undefined, true],
    ['', true],
    ['  ', true],
    ['<your key>', true],
    [KEY, false],
  ])('should treat %j as unset: %s', (value, expected) => {
    expect(tokenUnset(value)).toBe(expected);
  });
});

describe('showProfile', () => {
  test('should print the profile with both key names masked', () => {
    const file = write(
      'p.env',
      `ANTHROPIC_BASE_URL=https://x\nANTHROPIC_AUTH_TOKEN=${KEY}\nANTHROPIC_API_KEY=short\n`
    );

    const lines = showProfile(file);

    expect(lines).toEqual([
      `profile: ${file}`,
      '',
      'ANTHROPIC_BASE_URL=https://x',
      'ANTHROPIC_AUTH_TOKEN=sk-t...7890',
      'ANTHROPIC_API_KEY=****',
    ]);
  });

  test('should list the skipped lines', () => {
    const file = write('p.env', 'bad-name=1\n');

    expect(showProfile(file).at(-1)).toBe(
      'warning: line 1 skipped: not a variable name: bad-name'
    );
  });

  test('should explain a missing profile', () => {
    expect(() => showProfile(path.join(tmp, 'none.env'))).toThrow(
      /no dscc profile at .*\nFix: kyoten dscc --set-key/s
    );
  });
});

describe('setKey', () => {
  test('should create the profile from the template, folders included', () => {
    const file = path.join(tmp, 'cfg', 'kyoten', 'dscc.env');

    const result = setKey({ file, key: `  ${KEY}\n` });

    const text = fs.readFileSync(file, 'utf-8');
    expect(result).toEqual({ created: true });
    expect(text).toContain(`\nANTHROPIC_AUTH_TOKEN=${KEY}\n`);
    expect(text).toContain(
      'ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic'
    );
  });

  test('should replace the token line and keep every other line', () => {
    const file = write(
      'p.env',
      '# mine\nexport ANTHROPIC_AUTH_TOKEN=old\nX=1\n'
    );

    const result = setKey({ file, key: KEY });

    expect(result).toEqual({ created: false });
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      `# mine\nANTHROPIC_AUTH_TOKEN=${KEY}\nX=1\n`
    );
  });

  test('should add the token before the final newline when there is none', () => {
    const file = write('p.env', 'X=1\n');

    setKey({ file, key: KEY });

    expect(fs.readFileSync(file, 'utf-8')).toBe(
      `X=1\nANTHROPIC_AUTH_TOKEN=${KEY}\n`
    );
  });

  test('should append the token to a file without a final newline', () => {
    const file = write('p.env', 'X=1');

    setKey({ file, key: KEY });

    expect(fs.readFileSync(file, 'utf-8')).toBe(
      `X=1\nANTHROPIC_AUTH_TOKEN=${KEY}`
    );
  });

  test('should keep CRLF line endings', () => {
    const file = write('p.env', 'ANTHROPIC_AUTH_TOKEN=\r\nX=1\r\n');

    setKey({ file, key: KEY });

    expect(fs.readFileSync(file, 'utf-8')).toBe(
      `ANTHROPIC_AUTH_TOKEN=${KEY}\r\nX=1\r\n`
    );
  });

  test('should leave no temporary file behind', () => {
    const file = write('p.env', 'X=1\n');

    setKey({ file, key: KEY });

    expect(fs.readdirSync(tmp)).toEqual(['p.env']);
  });

  test('should still save the key where chmod is not supported', () => {
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw new Error('EPERM');
    });
    const file = write('p.env', 'X=1\n');

    setKey({ file, key: KEY });

    expect(fs.readFileSync(file, 'utf-8')).toContain(KEY);
  });

  test.each([
    ['', 'no key entered; nothing changed'],
    [' \n', 'no key entered; nothing changed'],
    ['two words', 'the key contains spaces or line breaks; nothing changed'],
  ])('should refuse the key %j', (key, message) => {
    const file = write('p.env', 'X=1\n');

    expect(() => setKey({ file, key })).toThrow(message);
    expect(fs.readFileSync(file, 'utf-8')).toBe('X=1\n');
  });

  test('should explain a missing template', () => {
    const template = path.join(tmp, 'none.example');

    expect(() =>
      setKey({ file: path.join(tmp, 'p.env'), key: KEY, template })
    ).toThrow(`the profile template ${template} is missing`);
  });

  test('should ship a template that has an empty token', () => {
    const { pairs } = parseProfile(fs.readFileSync(TEMPLATE_FILE, 'utf-8'));

    expect(tokenUnset(pairs.get('ANTHROPIC_AUTH_TOKEN'))).toBe(true);
  });
});

describe('dsccEnv', () => {
  test('should drop the inherited keys and set the profile', () => {
    const file = write('p.env', `ANTHROPIC_AUTH_TOKEN=${KEY}\nA=1\n2B=x\n`);

    const env = dsccEnv(file);

    expect(env).toEqual({
      drop: TOKEN_KEYS,
      set: { ANTHROPIC_AUTH_TOKEN: KEY, A: '1' },
      warnings: ['line 3 skipped: not a variable name: 2B'],
    });
  });

  test('should refuse a profile without a token', () => {
    const file = write('p.env', 'ANTHROPIC_AUTH_TOKEN=<paste here>\n');

    expect(() => dsccEnv(file)).toThrow(
      `ANTHROPIC_AUTH_TOKEN is not set in ${file}`
    );
  });

  test('should explain a missing profile', () => {
    expect(() => dsccEnv(path.join(tmp, 'none.env'))).toThrow(
      'no dscc profile at'
    );
  });
});

describe('readHidden', () => {
  test('should read until Enter without echo, with Backspace', async () => {
    const input = new FakeInput();
    const output = fakeOutput();

    const key = readHidden({ input, output, prompt: 'Key: ' });
    input.emit('data', 'abx\u007fc');
    input.emit('data', '\bd\u0001\r ignored');

    await expect(key).resolves.toBe('abd');
    expect(output.written).toEqual(['Key: ', '\n']);
  });

  test('should restore the terminal mode and stop reading', async () => {
    const input = new FakeInput();

    const key = readHidden({ input, output: fakeOutput(), prompt: '' });
    input.emit('data', 'x\n');
    await key;

    expect(input.rawModes).toEqual([true, false]);
    expect(input.paused).toBe(true);
    expect(input.listenerCount('data')).toBe(0);
  });

  test('should end at Ctrl-D', async () => {
    const input = new FakeInput();

    const key = readHidden({ input, output: fakeOutput(), prompt: '' });
    input.emit('data', 'k1\u0004');

    await expect(key).resolves.toBe('k1');
  });

  test('should skip escape sequences such as arrow keys', async () => {
    const input = new FakeInput();

    const key = readHidden({ input, output: fakeOutput(), prompt: '' });
    input.emit('data', 'a\u001b[A\u001b[3~b\r');

    await expect(key).resolves.toBe('ab');
  });

  test('should cancel at Ctrl-C', async () => {
    const input = new FakeInput();

    const key = readHidden({ input, output: fakeOutput(), prompt: '' });
    input.emit('data', 'abc\u0003');

    await expect(key).rejects.toThrow('cancelled; nothing changed');
  });

  test('should work on an input without raw mode', async () => {
    const input = new FakeInput();
    const plain = Object.assign(new EventEmitter(), {
      setEncoding: () => {},
      resume: () => {},
      pause: () => {},
    });

    const key = readHidden({ input: plain, output: fakeOutput(), prompt: '' });
    plain.emit('data', 'z\r');

    await expect(key).resolves.toBe('z');
    expect(input.rawModes).toEqual([]);
  });
});

describe('readFirstLine', () => {
  test.each([
    [['ab', 'c\nrest'], 'abc'],
    [['k\r\n'], 'k'],
    [['no newline'], 'no newline'],
    [[], ''],
  ])('should read the first line of %j', async (chunks, expected) => {
    await expect(readFirstLine(Readable.from(chunks))).resolves.toBe(expected);
  });

  test('should accept Buffer chunks', async () => {
    await expect(
      readFirstLine(Readable.from([Buffer.from('buf\n')]))
    ).resolves.toBe('buf');
  });
});
