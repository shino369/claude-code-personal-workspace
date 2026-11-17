import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LOCAL_FILE,
  REGISTRY_VERSION,
  commandFor,
  emptyRegistry,
  findTool,
  readRegistry,
  sourcesDir,
  validateEntry,
  validateRegistry,
  writeRegistry,
} from '../registry.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

/** @param {Partial<import('../registry.js').ToolEntry>} [overrides] */
export const entry = (overrides = {}) => ({
  name: 'codex',
  kind: /** @type {const} */ ('agent'),
  path: '/bin/codex',
  version: '0.155.0',
  source: /** @type {const} */ ('scan'),
  ok: true,
  checkedAt: NOW.toISOString(),
  ...overrides,
});

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-registry-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sourcesDir', () => {
  test('should default to ~/.cache/agent-tools/src', () => {
    expect(sourcesDir({})).toBe(
      path.join(os.homedir(), '.cache', 'agent-tools', 'src')
    );
  });

  test('should honor AGENT_TOOLS_HOME', () => {
    expect(sourcesDir({ AGENT_TOOLS_HOME: '/opt/at' })).toBe(
      path.join('/opt/at', 'src')
    );
  });

  test('should read process.env by default', () => {
    expect(sourcesDir()).toMatch(/src$/);
  });
});

describe('validateEntry', () => {
  test('should accept a full entry', () => {
    expect(
      validateEntry(
        entry({
          command: 'npx -y x',
          via: 'brew',
          check: ['x', '--version'],
          headless: 'x -p',
          env: ['X_KEY'],
          notes: 'n',
          task: 't',
          path: null,
          version: null,
        })
      )
    ).toEqual([]);
  });

  test('should reject a non-object', () => {
    expect(validateEntry(null)).toEqual(['tool must be an object']);
    expect(validateEntry([])).toEqual(['tool must be an object']);
  });

  test('should report every bad field', () => {
    expect(
      validateEntry({
        name: 'Bad Name',
        kind: 'x',
        path: 1,
        version: 2,
        source: 'other',
        ok: 'yes',
        checkedAt: 3,
        command: 4,
        check: [5],
        env: 'X',
      })
    ).toEqual([
      'tool.name must be lowercase (a-z, 0-9, . _ -)',
      'tool.kind must be one of agent, cli, runtime, source',
      'tool.path must be a string or null',
      'tool.version must be a string or null',
      'tool.source must be scan or manual',
      'tool.ok must be a boolean',
      'tool.checkedAt must be a string',
      'tool.command must be a string',
      'tool.check must be a string array',
      'tool.env must be a string array',
    ]);
  });
});

describe('validateRegistry', () => {
  test('should accept an empty registry', () => {
    expect(validateRegistry(emptyRegistry())).toEqual([]);
  });

  test('should reject non-objects and bad top-level fields', () => {
    expect(validateRegistry('x')).toEqual(['registry must be a JSON object']);
    expect(validateRegistry(null)).toEqual(['registry must be a JSON object']);
    expect(validateRegistry([])).toEqual(['registry must be a JSON object']);
    expect(validateRegistry({ version: 9, updatedAt: 1, tools: {} })).toEqual([
      `version must be ${REGISTRY_VERSION}`,
      'updatedAt must be a string or null',
      'tools must be an array',
    ]);
  });

  test('should flag invalid and duplicated entries', () => {
    expect(
      validateRegistry({
        ...emptyRegistry(),
        tools: [entry(), entry(), null],
      })
    ).toEqual([
      'tools[1].name "codex" is duplicated',
      'tools[2] must be an object',
    ]);
  });
});

describe('readRegistry / writeRegistry', () => {
  test('should return an empty registry when the file is missing', () => {
    expect(readRegistry(root)).toEqual(emptyRegistry());
  });

  test('should write sorted entries and read them back', () => {
    const written = writeRegistry(
      root,
      { ...emptyRegistry(), tools: [entry({ name: 'gh' }), entry()] },
      NOW
    );
    expect(written.tools.map((t) => t.name)).toEqual(['codex', 'gh']);
    expect(written.updatedAt).toBe(NOW.toISOString());
    expect(readRegistry(root)).toEqual(written);
  });

  test('should refuse to write an invalid registry', () => {
    expect(() =>
      writeRegistry(
        root,
        { ...emptyRegistry(), tools: [entry({ name: 'X' })] },
        NOW
      )
    ).toThrow(/Refusing to write tools\/local.json/);
  });

  test('should explain invalid JSON and invalid content with a fix', () => {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, LOCAL_FILE), '{oops');
    expect(() => readRegistry(root)).toThrow(
      /is not valid JSON .*\nFix: pnpm tools scan --reset/
    );
    fs.writeFileSync(path.join(root, LOCAL_FILE), '{"version":2,"tools":[]}');
    expect(() => readRegistry(root)).toThrow(
      /Invalid tools\/local.json:\n {2}- version must be 1\n {2}- updatedAt.*\nFix: pnpm tools scan --reset/
    );
  });
});

describe('findTool / commandFor', () => {
  beforeEach(() => {
    writeRegistry(
      root,
      {
        ...emptyRegistry(),
        tools: [
          entry({ path: '/Program Files/codex' }),
          entry({
            name: 'dsh',
            path: null,
            command: ' npx -y @deepseek-ai/dsh ',
          }),
          entry({ name: 'gh', ok: false }),
          entry({ name: 'src', kind: 'source', path: '/src' }),
          entry({ name: 'odd', path: null }),
        ],
      },
      NOW
    );
  });

  test('should find a tool by name', () => {
    expect(findTool(root, 'gh')?.ok).toBe(false);
    expect(findTool(root, 'nope')).toBeNull();
  });

  test('should prefer the command split into argv, else the path', () => {
    expect(commandFor(root, 'dsh')).toEqual(['npx', '-y', '@deepseek-ai/dsh']);
    expect(commandFor(root, 'codex')).toEqual(['/Program Files/codex']);
  });

  test('should return null for unknown, broken, source, or pathless tools', () => {
    expect(commandFor(root, 'nope')).toBeNull();
    expect(commandFor(root, 'gh')).toBeNull();
    expect(commandFor(root, 'src')).toBeNull();
    expect(commandFor(root, 'odd')).toBeNull();
  });
});
