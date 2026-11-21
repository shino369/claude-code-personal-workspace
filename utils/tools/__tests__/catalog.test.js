import fs from 'fs';
import os from 'os';
import path from 'path';
import { installHint, loadCatalog, validateCatalog } from '../catalog.js';

const tool = {
  name: 'gh',
  kind: 'cli',
  purpose: 'GitHub',
  check: ['gh', '--version'],
};

describe('validateCatalog', () => {
  test('should accept a valid catalog', () => {
    expect(
      validateCatalog({ version: 1, tools: [{ ...tool, recommended: true }] })
    ).toEqual([]);
  });

  test('should reject the wrong shape', () => {
    const message = ['catalog must be { version: 1, tools: [...] }'];
    expect(validateCatalog(null)).toEqual(message);
    expect(validateCatalog({ version: 2, tools: [] })).toEqual(message);
    expect(validateCatalog({ version: 1, tools: {} })).toEqual(message);
  });

  test('should report bad and duplicated entries', () => {
    expect(
      validateCatalog({
        version: 1,
        tools: [
          tool,
          tool,
          {
            name: 'X',
            kind: 'source',
            purpose: 1,
            check: [],
            recommended: 'yes',
          },
          null,
          { ...tool, name: 'y', check: [1] },
        ],
      })
    ).toEqual([
      'tools[1].name "gh" is duplicated',
      'tools[2].name must be lowercase (a-z, 0-9, . _ -)',
      'tools[2].kind must be agent, cli, or runtime',
      'tools[2].recommended must be a boolean',
      'tools[2].purpose must be a string',
      'tools[2].check must be a non-empty argv array',
      'tools[3].name must be lowercase (a-z, 0-9, . _ -)',
      'tools[3].kind must be agent, cli, or runtime',
      'tools[3].purpose must be a string',
      'tools[3].check must be a non-empty argv array',
      'tools[4].check must be a non-empty argv array',
    ]);
  });
});

describe('loadCatalog', () => {
  test('should load the committed catalog', () => {
    const catalog = loadCatalog();
    expect(catalog.map((t) => t.name)).toEqual(
      expect.arrayContaining(['claude', 'codex', 'dsh', 'agy', 'gh', 'node'])
    );
  });

  test('should throw on an invalid catalog', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-catalog-'));
    try {
      fs.mkdirSync(path.join(root, 'tools'));
      fs.writeFileSync(
        path.join(root, 'tools', 'catalog.json'),
        '{"version":1,"tools":[{}]}'
      );
      expect(() => loadCatalog(root)).toThrow(/Invalid tools\/catalog.json/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('installHint', () => {
  const full = {
    ...tool,
    kind: /** @type {const} */ ('cli'),
    install: { darwin: 'brew install gh', any: 'see any' },
    docs: 'https://cli.github.com',
  };

  test('should prefer the platform, then any, then the docs', () => {
    expect(installHint(full, 'darwin')).toBe('brew install gh');
    expect(installHint(full, 'linux')).toBe('see any');
    expect(installHint({ ...full, install: undefined }, 'linux')).toBe(
      'see https://cli.github.com'
    );
  });

  test('should return null with nothing to suggest', () => {
    expect(installHint(undefined, 'darwin')).toBeNull();
    expect(
      installHint(
        { ...tool, kind: /** @type {const} */ ('cli'), install: {} },
        'win32'
      )
    ).toBeNull();
  });
});
