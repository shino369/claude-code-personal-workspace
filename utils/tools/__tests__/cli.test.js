import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { writeActive } from '../../task/store.js';
import {
  HELP,
  SLOW_CHECK_TIMEOUT_MS,
  checkArgv,
  defaultDeps,
  main,
  parseArgs,
  recheck,
  setupTools,
} from '../cli.js';
import { readRegistry } from '../registry.js';
import { toPosix } from '../../paths.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

/** @type {import('../catalog.js').CatalogEntry[]} */
const CATALOG = [
  {
    name: 'codex',
    kind: 'agent',
    purpose: 'Codex',
    check: ['codex', '--version'],
    headless: 'codex exec -',
    recommended: true,
  },
  {
    name: 'dsh',
    kind: 'agent',
    purpose: 'DeepSeek',
    check: ['dsh', '--version'],
    install: { any: 'npx -y @deepseek-ai/dsh' },
    env: ['DEEPSEEK_API_KEY'],
  },
  {
    name: 'gh',
    kind: 'cli',
    purpose: 'GitHub',
    check: ['gh', '--version'],
    install: { darwin: 'brew install gh' },
  },
];

/** @type {string} */
let root;
/** @type {string[]} */
let logs;

/**
 * @param {{ onPath?: string[], spawn?: import('vitest').Mock, env?: NodeJS.ProcessEnv }} [options]
 */
function probe({ onPath = ['codex', 'gh'], spawn, env = {} } = {}) {
  return {
    env: { PATH: '/bin', ...env },
    platform: /** @type {NodeJS.Platform} */ ('darwin'),
    // The probe builds native paths (\\bin\\codex on Windows); compare with /.
    isExecutable: (/** @type {string} */ file) =>
      onPath.some((name) => toPosix(file) === `/bin/${name}`) ||
      toPosix(file).endsWith('/real-tool'),
    realpath: (/** @type {string} */ file) => file,
    spawn:
      spawn ??
      vi.fn((/** @type {string} */ bin) => ({
        status: bin.includes('broken') ? 1 : 0,
        stdout: `${path.basename(bin)} 1.2.3`,
      })),
  };
}

/**
 * @param {string[]} argv
 * @param {Partial<import('../cli.js').Deps>} [deps]
 */
function run(argv, deps = {}) {
  logs = [];
  const code = main({
    argv,
    deps: {
      rootDir: root,
      now: () => NOW,
      log: (message) => logs.push(message),
      probe: probe(),
      catalog: () => CATALOG,
      ...deps,
    },
  });
  return { code, out: logs.join('\n') };
}

const names = () => readRegistry(root).tools.map((t) => t.name);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-cli-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('should read flags and positionals', () => {
    expect(
      parseArgs(['add', 'x', '--kind', 'cli', '-m', 'n', '--json', '--all'])
    ).toMatchObject({
      positionals: ['add', 'x'],
      kind: 'cli',
      notes: 'n',
      json: true,
      all: true,
      reset: false,
    });
  });

  test('should reject a missing value or an unknown option', () => {
    expect(() => parseArgs(['--kind'])).toThrow('--kind needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option --nope');
  });
});

describe('defaultDeps', () => {
  test('should load the committed catalog by default', () => {
    const deps = defaultDeps();
    expect(deps.catalog().some((t) => t.name === 'codex')).toBe(true);
    expect(deps.now()).toBeInstanceOf(Date);
  });
});

describe('help and dispatch', () => {
  test('should print help', () => {
    expect(run(['help']).out).toBe(HELP);
    expect(run(['scan', '--help']).out).toBe(HELP);
  });

  test('should explain that a source checkout requires a path', () => {
    expect(run(['help']).out).toContain(
      'A source checkout requires --path <directory>'
    );
  });

  test('should default to list and reject unknown commands', () => {
    expect(run([]).out).toContain('No tools recorded on this machine yet.');
    expect(() => run(['nope'])).toThrow('Unknown command "nope"');
  });
});

describe('scan', () => {
  test('should record catalog tools found on PATH', () => {
    const { code, out } = run(['scan']);
    expect(code).toBe(0);
    expect(names()).toEqual(['codex', 'gh']);
    expect(out).toContain('Recorded 2 tool(s) in tools/local.json: codex, gh.');
    expect(out).toContain('New: codex, gh.');
    expect(readRegistry(root).tools[0]).toMatchObject({
      path: '/bin/codex',
      version: '1.2.3',
      headless: 'codex exec -',
      source: 'scan',
    });
  });

  test('should report tools no longer found, broken ones, and keep manual entries', () => {
    run(['scan']);
    run(['add', 'dsh', '--command', 'npx -y @deepseek-ai/dsh']);
    const spawn = vi.fn(() => ({ status: 1 }));
    const { out } = run(['scan', '--json'], {
      probe: probe({ onPath: ['codex'], spawn }),
    });
    expect(JSON.parse(out)).toMatchObject({ added: [], removed: ['gh'] });
    expect(names()).toEqual(['codex', 'dsh']);
    expect(
      run(['scan'], { probe: probe({ onPath: ['codex'], spawn }) }).out
    ).toContain('codex (broken)');
  });

  test('should print the removed line and none when nothing is found', () => {
    run(['scan']);
    expect(run(['scan'], { probe: probe({ onPath: [] }) }).out).toContain(
      'Recorded 0 tool(s) in tools/local.json: none.\nNo longer found: codex, gh.'
    );
  });

  test('should start over with --reset', () => {
    run(['add', 'dsh', '--command', 'npx dsh']);
    run(['scan', '--reset']);
    expect(names()).toEqual(['codex', 'gh']);
  });
});

describe('list', () => {
  test('should list recorded tools and filter by kind', () => {
    run(['scan']);
    expect(run(['list']).out).toContain('Not installed: dsh');
    const agents = run(['list', '--kind', 'agent']).out;
    expect(agents).toContain('codex');
    expect(agents).not.toContain('gh 1.2.3');
  });

  test('should print JSON with missing tools and the sources dir', () => {
    run(['scan']);
    const parsed = JSON.parse(
      run(['list', '--json'], {
        probe: probe({ env: { AGENT_TOOLS_HOME: '/at' } }),
      }).out
    );
    expect(parsed).toMatchObject({
      missing: ['dsh'],
      sources: path.join('/at', 'src'),
    });
    expect(parsed.tools).toHaveLength(2);
  });

  test('should reject an unknown kind', () => {
    expect(() => run(['list', '--kind', 'x'])).toThrow('--kind must be one of');
  });
});

describe('check', () => {
  test('should require a recorded tool', () => {
    expect(() => run(['check'])).toThrow(
      'No tools recorded yet.\nFix: pnpm tools scan'
    );
  });

  test('should pass when everything works', () => {
    run(['scan']);
    expect(run(['check'])).toEqual({
      code: 0,
      out: '✓ codex 1.2.3\n✓ gh 1.2.3',
    });
  });

  test('should fail with fix hints for broken tools', () => {
    run(['scan']);
    run(['add', 'local', '--kind', 'cli', '--path', root]);
    const spawn = vi.fn(() => ({ status: 1 }));
    const { code, out } = run(['check'], { probe: probe({ spawn }) });
    expect(code).toBe(1);
    expect(out).toContain('✗ gh 1.2.3');
    expect(out).toContain(
      'Fix gh: brew install gh — or forget it: pnpm tools remove gh'
    );
    expect(out).toContain('Fix local: or forget it: pnpm tools remove local');
    expect(
      JSON.parse(run(['check', '--json'], { probe: probe({ spawn }) }).out).ok
    ).toBe(false);
  });
});

describe('show', () => {
  test('should show a recorded or catalog-only tool', () => {
    run(['scan']);
    expect(run(['show', 'codex']).out).toContain('status: working');
    expect(run(['show', 'dsh']).out).toContain(
      'install: npx -y @deepseek-ai/dsh'
    );
    expect(JSON.parse(run(['show', 'dsh', '--json']).out)).toMatchObject({
      name: 'dsh',
      entry: null,
      catalog: { name: 'dsh' },
    });
    expect(
      JSON.parse(run(['show', 'codex', '--json']).out).catalog
    ).toMatchObject({ name: 'codex' });
  });

  test('should explain unknown tools and a missing name', () => {
    expect(() => run(['show', 'nope'])).toThrow('Unknown tool "nope"');
    expect(() => run(['show'])).toThrow('Usage: pnpm tools show <name>');
  });
});

describe('add', () => {
  test('should record an npx-only agent with catalog defaults', () => {
    const taskDir = path.join(root, 'tasks', 'demo-261117');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'plan.md'), 'Goal: G\n');
    writeActive(root, 'demo-261117');
    const spawn = vi.fn(() => ({ status: 0, stdout: 'dsh 0.2.2' }));
    const { out } = run(
      ['add', 'dsh', '--command', ' npx -y @deepseek-ai/dsh ', '--via', 'npx'],
      { probe: probe({ spawn }) }
    );
    expect(out).toBe('Recorded dsh in tools/local.json: working (0.2.2).');
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['-y', '@deepseek-ai/dsh', '--version'],
      expect.objectContaining({ timeout: SLOW_CHECK_TIMEOUT_MS })
    );
    expect(readRegistry(root).tools[0]).toEqual({
      name: 'dsh',
      kind: 'agent',
      path: null,
      command: 'npx -y @deepseek-ai/dsh',
      version: '0.2.2',
      via: 'npx',
      source: 'manual',
      ok: true,
      checkedAt: NOW.toISOString(),
      env: ['DEEPSEEK_API_KEY'],
      task: 'demo-261117',
    });
  });

  test('should record a source checkout with its git revision', () => {
    const dir = path.join(root, 'checkout');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    const spawn = vi.fn(() => ({ status: 0, stdout: 'abc1234\n' }));
    run(
      [
        'add',
        'some-src',
        '--kind',
        'source',
        '--path',
        dir,
        '--headless',
        'read only',
        '--env',
        'A, B,',
        '-m',
        'reference',
        '--task',
        'other-261117',
      ],
      { probe: probe({ spawn }) }
    );
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['-C', dir, 'rev-parse', '--short', 'HEAD'],
      expect.any(Object)
    );
    expect(readRegistry(root).tools[0]).toMatchObject({
      kind: 'source',
      ok: true,
      version: 'abc1234',
      headless: 'read only',
      env: ['A', 'B'],
      notes: 'reference',
      task: 'other-261117',
    });
  });

  test('should keep the old version when git fails or there is no .git', () => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir);
    run(['add', 'plain-src', '--kind', 'source', '--path', dir]);
    expect(readRegistry(root).tools[0]).toMatchObject({
      ok: true,
      version: null,
    });
    fs.mkdirSync(path.join(dir, '.git'));
    run(['add', 'plain-src', '--kind', 'source', '--path', dir], {
      probe: probe({ spawn: vi.fn(() => ({ status: 128 })) }),
    });
    expect(logs[0]).toContain('Updated plain-src');
    expect(readRegistry(root).tools[0].version).toBeNull();
  });

  test('should use a custom check, and report a failed check with a fix', () => {
    const tool = path.join(root, 'real-tool');
    fs.writeFileSync(tool, '');
    const spawn = vi.fn(() => ({ status: 1 }));
    const { out } = run(
      ['add', 'mine', '--kind', 'cli', '--path', tool, '--check', 'mine  -V'],
      { probe: probe({ spawn }) }
    );
    expect(spawn).toHaveBeenCalledWith('mine', ['-V'], expect.any(Object));
    expect(out).toBe(
      'Recorded mine in tools/local.json: check failed.\nFix: verify it runs, e.g. mine -V'
    );
  });

  test('should check a path-only tool by whether it is executable', () => {
    const tool = path.join(root, 'real-tool');
    fs.writeFileSync(tool, '');
    run(['add', 'plain', '--kind', 'cli', '--path', tool]);
    expect(readRegistry(root).tools[0].ok).toBe(true);
    const other = path.join(root, 'other');
    fs.writeFileSync(other, '');
    expect(run(['add', 'other', '--kind', 'cli', '--path', other]).out).toBe(
      `Recorded other in tools/local.json: check failed.\nFix: verify it runs, e.g. ${other}`
    );
    expect(
      run(['add', 'cmd-only', '--kind', 'cli', '--command', 'npx cmd']).out
    ).toContain('check failed.\nFix: verify it runs, e.g. npx cmd');
  });

  test('should check a catalog tool through its recorded path', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: 'gh 9.9.9' }));
    run(['add', 'gh', '--path', root], { probe: probe({ spawn }) });
    expect(spawn).toHaveBeenCalledWith(root, ['--version'], expect.any(Object));
  });

  test('should inherit headless usage from the catalog and show local-only tools', () => {
    run(['add', 'codex', '--path', root]);
    expect(readRegistry(root).tools[0].headless).toBe('codex exec -');
    const tool = path.join(root, 'real-tool');
    fs.writeFileSync(tool, '');
    run(['add', 'mine', '--kind', 'cli', '--path', tool]);
    expect(JSON.parse(run(['show', 'mine', '--json']).out)).toMatchObject({
      entry: { name: 'mine' },
      catalog: null,
    });
  });

  test('should validate the name, kind, and location', () => {
    expect(() => run(['add'])).toThrow('Usage: pnpm tools add <name>');
    expect(() => run(['add', 'Bad'])).toThrow('Invalid tool name "Bad"');
    expect(() => run(['add', 'x', '--path', root])).toThrow(
      '--kind must be one of'
    );
    expect(() => run(['add', 'x', '--kind', 'nope', '--path', root])).toThrow(
      '--kind must be one of'
    );
    expect(() => run(['add', 'x', '--kind', 'cli'])).toThrow(
      'Tell me where x is'
    );
    expect(() =>
      run(['add', 'x', '--kind', 'source', '--command', 'y'], {
        probe: probe({ env: { AGENT_TOOLS_HOME: '/at' } }),
      })
    ).toThrow(`default home: ${path.join('/at', 'src')}/x`);
    expect(() =>
      run(['add', 'x', '--kind', 'cli', '--path', path.join(root, 'missing')])
    ).toThrow(/does not exist\.\nFix:/);
  });
});

describe('checkArgv', () => {
  const base = {
    name: 'gh',
    kind: /** @type {const} */ ('cli'),
    version: null,
    source: /** @type {const} */ ('manual'),
    ok: true,
    checkedAt: NOW.toISOString(),
  };

  test('should fall back to the catalog executable without a path or command', () => {
    expect(checkArgv({ ...base, path: null }, CATALOG[2])).toEqual([
      'gh',
      '--version',
    ]);
  });

  test('should return null without a check or catalog entry', () => {
    expect(checkArgv({ ...base, path: '/x' }, undefined)).toBeNull();
  });
});

describe('recheck', () => {
  test('should mark a missing source checkout as broken', () => {
    const deps = defaultDeps({ now: () => NOW, probe: probe() });
    expect(
      recheck(
        {
          name: 's',
          kind: 'source',
          path: null,
          version: 'v1',
          source: 'manual',
          ok: true,
          checkedAt: 'old',
        },
        undefined,
        deps
      )
    ).toMatchObject({ ok: false, version: 'v1', checkedAt: NOW.toISOString() });
  });
});

describe('remove and sources', () => {
  test('should forget a tool without uninstalling', () => {
    run(['scan']);
    expect(run(['remove', 'gh']).out).toBe(
      'Forgot gh (nothing was uninstalled).'
    );
    expect(names()).toEqual(['codex']);
    expect(JSON.parse(run(['remove', 'codex', '--json']).out)).toEqual({
      ok: true,
      removed: 'codex',
    });
  });

  test('should explain a tool that is not recorded', () => {
    expect(() => run(['remove', 'gh'])).toThrow(
      'gh is not recorded.\nFix: pnpm tools list'
    );
    expect(() => run(['remove'])).toThrow('Usage: pnpm tools remove <name>');
  });

  test('should print the sources directory', () => {
    const env = { AGENT_TOOLS_HOME: '/at' };
    expect(run(['sources'], { probe: probe({ env }) }).out).toBe(
      path.join('/at', 'src')
    );
    expect(
      JSON.parse(run(['sources', '--json'], { probe: probe({ env }) }).out)
    ).toEqual({ sources: path.join('/at', 'src') });
  });
});

describe('setupTools', () => {
  test('should scan quietly and read the registry and catalog', () => {
    const tools = setupTools(root, {
      now: () => NOW,
      probe: probe(),
      catalog: () => CATALOG,
    });
    tools.scan();
    expect(tools.registry().tools.map((t) => t.name)).toEqual(['codex', 'gh']);
    expect(tools.catalog()).toBe(CATALOG);
  });
});
