/**
 * Tests for utils/memory/config.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BUDGET_RANGE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  MAX_OFF_SESSIONS,
  normalizeConfig,
  readConfig,
  savingOff,
  setSaving,
  writeConfig,
} from '../config.js';
import { MemoryError } from '../store.js';

/** @type {string} */
let dir;

beforeEach(() => {
  dir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-config-')),
    'memory'
  );
});

afterEach(() => {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

describe('normalizeConfig', () => {
  test('should fill in the defaults for an empty object', () => {
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test('should keep valid values', () => {
    const config = {
      off: true,
      offSessions: ['abc-1'],
      extractModel: 'claude-sonnet-5-5',
      budget: 4000,
    };

    expect(normalizeConfig(config)).toEqual(config);
  });

  test.each([
    [[], 'must be an object'],
    [null, 'must be an object'],
    [{ colour: 'red' }, 'Unknown setting "colour"'],
    [{ off: 'yes' }, 'off must be true or false'],
    [{ offSessions: 'abc' }, 'offSessions must be a list of session ids'],
    [{ offSessions: ['bad id'] }, 'offSessions must be a list of session ids'],
    [{ extractModel: 'two words' }, 'Invalid model name'],
    [{ extractModel: 7 }, 'Invalid model name'],
    [{ budget: 1.5 }, 'The budget must be a whole number'],
    [{ budget: BUDGET_RANGE.min - 1 }, 'The budget must be a whole number'],
    [{ budget: BUDGET_RANGE.max + 1 }, 'The budget must be a whole number'],
  ])('should refuse %j', (input, message) => {
    expect(() => normalizeConfig(input)).toThrow(message);
  });

  test('should throw a MemoryError', () => {
    expect(() => normalizeConfig({ off: 1 })).toThrow(MemoryError);
  });

  test('should keep only the newest session ids', () => {
    const ids = Array.from({ length: MAX_OFF_SESSIONS + 2 }, (_, i) => `s${i}`);

    expect(normalizeConfig({ offSessions: ids }).offSessions).toEqual(
      ids.slice(2)
    );
  });

  test('should drop repeated session ids', () => {
    expect(
      normalizeConfig({ offSessions: ['a', 'b', 'a'] }).offSessions
    ).toEqual(['b', 'a']);
  });
});

describe('readConfig / writeConfig', () => {
  test('should return the defaults without a config file', () => {
    expect(readConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  test('should round-trip a written config', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, budget: 5000 });

    expect(readConfig(dir).budget).toBe(5000);
  });

  test('should write only the settings that differ from the defaults', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, extractModel: 'm1' });

    expect(
      JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf-8'))
    ).toEqual({
      extractModel: 'm1',
    });
  });

  test('should refuse a file that is not JSON, naming the fix', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), '{oops');

    expect(() => readConfig(dir)).toThrow(/not valid JSON.*pnpm memory set/);
  });

  test('should refuse a file with an invalid setting', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), '{"budget": 3}');

    expect(() => readConfig(dir)).toThrow(MemoryError);
  });
});

describe('savingOff / setSaving', () => {
  test('should be on by default', () => {
    expect(savingOff(DEFAULT_CONFIG, 'abc')).toBeNull();
  });

  test('should report a global off first', () => {
    const config = { ...DEFAULT_CONFIG, off: true, offSessions: ['abc'] };

    expect(savingOff(config, 'abc')).toBe('global');
  });

  test('should report a session that is off', () => {
    const config = setSaving(DEFAULT_CONFIG, false, 'abc');

    expect(savingOff(config, 'abc')).toBe('session');
  });

  test('should not apply another session off to this one', () => {
    const config = setSaving(DEFAULT_CONFIG, false, 'abc');

    expect(savingOff(config, 'xyz')).toBeNull();
  });

  test('should ignore session switches without a session id', () => {
    expect(
      savingOff({ ...DEFAULT_CONFIG, offSessions: ['abc'] }, null)
    ).toBeNull();
  });

  test('should turn saving off globally without a session', () => {
    expect(setSaving(DEFAULT_CONFIG, false, null).off).toBe(true);
  });

  test('should turn on both the global switch and the session', () => {
    const off = { ...DEFAULT_CONFIG, off: true, offSessions: ['abc', 'xyz'] };

    expect(setSaving(off, true, 'abc')).toEqual({
      ...DEFAULT_CONFIG,
      offSessions: ['xyz'],
    });
  });

  test('should turn on only the session when asked', () => {
    const off = { ...DEFAULT_CONFIG, off: true, offSessions: ['abc'] };

    expect(setSaving(off, true, 'abc', { sessionOnly: true })).toEqual({
      ...DEFAULT_CONFIG,
      off: true,
    });
  });

  test('should not repeat a session that is already off', () => {
    const once = setSaving(DEFAULT_CONFIG, false, 'abc');

    expect(setSaving(once, false, 'abc').offSessions).toEqual(['abc']);
  });
});
