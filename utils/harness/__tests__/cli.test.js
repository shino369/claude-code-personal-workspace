import fs from 'fs';
import { vi } from 'vitest';
import os from 'os';
import path from 'path';
import { generatedFiles, main } from '../cli.js';
import { hookEntries, renderHooksConfig } from '../hooks.js';

/** @type {string} */
let root;
/** @type {string[]} */
let lines;

/** @param {string[]} argv */
const run = (argv) =>
  main({
    argv,
    deps: {
      rootDir: root,
      log: (/** @type {string} */ line) => lines.push(line),
    },
  });

/** @param {string} file */
const read = (file) => fs.readFileSync(path.join(root, file), 'utf-8');

/**
 * @param {string} file
 * @param {unknown} value
 */
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2));
};

/**
 * Claude settings whose hooks match the manifest.
 *
 * @returns {any}
 */
const claudeSettings = () => ({
  permissions: { deny: [] },
  ...renderHooksConfig('claude'),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cli-'));
  lines = [];
  writeJson('.claude/settings.json', claudeSettings());
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generatedFiles', () => {
  test('should generate nothing for a harness with no hooks', () => {
    expect(generatedFiles({ specs: [] })).toEqual([]);
  });

  test('should render the Codex hooks config as formatted JSON', () => {
    const files = generatedFiles();
    const codex = files.find((f) => f.file === '.codex/hooks.json');
    expect(codex?.content.endsWith('}\n')).toBe(true);
    expect(JSON.parse(String(codex?.content))).toEqual(
      renderHooksConfig('codex', {
        description: expect.stringContaining('pnpm harness sync'),
      })
    );
  });
});

describe('pnpm harness sync', () => {
  test('should write missing generated files and say how to trust Codex hooks', () => {
    expect(run(['sync'])).toBe(0);
    expect(JSON.parse(read('.codex/hooks.json')).hooks).toEqual(
      renderHooksConfig('codex')?.hooks
    );
    expect(lines).toContain('Wrote .codex/hooks.json');
    expect(lines.join('\n')).toContain('/hooks');
  });

  test('should leave files that are already current alone', () => {
    run(['sync']);
    const file = path.join(root, '.codex/hooks.json');
    // Same content, different formatting (as Prettier might leave it).
    fs.writeFileSync(
      file,
      JSON.stringify(JSON.parse(read('.codex/hooks.json')))
    );
    const before = fs.statSync(file).mtimeMs;
    lines = [];
    expect(run(['sync'])).toBe(0);
    expect(fs.statSync(file).mtimeMs).toBe(before);
    expect(lines).toEqual(['✓ generated files are up to date']);
  });

  test('should not ask to trust Codex hooks again when only the description changed', () => {
    run(['sync']);
    const config = JSON.parse(read('.codex/hooks.json'));
    writeJson('.codex/hooks.json', { ...config, description: 'old' });
    lines = [];
    expect(run(['sync'])).toBe(0);
    expect(lines).toEqual(['Wrote .codex/hooks.json']);
  });

  test('should rewrite a stale or unreadable generated file', () => {
    writeJson('.codex/hooks.json', { hooks: {} });
    expect(run(['sync'])).toBe(0);
    expect(lines).toContain('Wrote .codex/hooks.json');
    fs.writeFileSync(path.join(root, '.codex/hooks.json'), '{ not json');
    lines = [];
    run(['sync']);
    expect(lines).toContain('Wrote .codex/hooks.json');
  });

  test('should never rewrite .claude/settings.json, and fail when it differs', () => {
    const settings = claudeSettings();
    settings.hooks.Stop = [];
    writeJson('.claude/settings.json', settings);
    const before = read('.claude/settings.json');
    expect(run(['sync'])).toBe(1);
    expect(read('.claude/settings.json')).toBe(before);
    expect(lines.join('\n')).toContain('.claude/settings.json');
  });
});

describe('pnpm harness check', () => {
  test('should pass when every config matches the manifest', () => {
    run(['sync']);
    lines = [];
    expect(run(['check'])).toBe(0);
    expect(lines).toEqual([
      '✓ .claude/settings.json hooks match utils/harness/hooks.js',
      '✓ .codex/hooks.json',
    ]);
  });

  test('should fail on a missing or stale generated file, without writing it', () => {
    expect(run(['check'])).toBe(1);
    expect(lines).toContain('✗ .codex/hooks.json is missing');
    expect(lines).toContain('Fix: pnpm harness sync');
    expect(fs.existsSync(path.join(root, '.codex/hooks.json'))).toBe(false);
    writeJson('.codex/hooks.json', { hooks: {} });
    lines = [];
    expect(run(['check'])).toBe(1);
    expect(lines).toContain('✗ .codex/hooks.json is out of date');
  });

  test('should list Claude hook entries that are missing or extra', () => {
    run(['sync']);
    const settings = claudeSettings();
    const stop = hookEntries('claude').find((e) => e.event === 'Stop');
    settings.hooks.Stop = [
      { hooks: [{ type: 'command', command: 'node extra.js', timeout: 1 }] },
    ];
    writeJson('.claude/settings.json', settings);
    lines = [];
    expect(run(['check'])).toBe(1);
    const out = lines.join('\n');
    expect(out).toContain(
      '✗ .claude/settings.json hooks differ from utils/harness/hooks.js'
    );
    expect(out).toContain(
      `  missing: Stop: ${stop?.command} (timeout ${stop?.timeout})`
    );
    expect(out).toContain('  extra: Stop: node extra.js (timeout 1)');
    expect(out).toContain(
      'Fix: make .claude/settings.json hooks and utils/harness/hooks.js agree, then pnpm harness sync'
    );
  });

  test('should show the matcher of a differing entry', () => {
    const settings = claudeSettings();
    settings.hooks.PreToolUse = [
      {
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node r.js' }],
      },
    ];
    writeJson('.claude/settings.json', settings);
    run(['check']);
    expect(lines.join('\n')).toContain('  extra: PreToolUse [Read]: node r.js');
  });

  test('should explain an unreadable .claude/settings.json', () => {
    fs.writeFileSync(path.join(root, '.claude/settings.json'), '{');
    expect(run(['check'])).toBe(1);
    expect(lines.join('\n')).toContain(
      '✗ .claude/settings.json cannot be read'
    );
  });
});

describe('main', () => {
  test('should print help', () => {
    expect(run(['help'])).toBe(0);
    expect(lines.join('\n')).toContain('pnpm harness sync');
    lines = [];
    expect(run([])).toBe(0);
    expect(lines.join('\n')).toContain('pnpm harness check');
  });

  test('should reject an unknown command', () => {
    expect(() => run(['nope'])).toThrow(
      'Unknown command "nope". Run: pnpm harness help'
    );
  });

  test('should log to the console by default', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(main({ argv: ['help'] })).toBe(0);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('pnpm harness sync')
    );
    spy.mockRestore();
  });
});
