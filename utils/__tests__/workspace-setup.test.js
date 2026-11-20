import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  HELP,
  HOOK_FILES,
  checkNode,
  MEMORY_PATHS,
  formatResult,
  main,
  parseArgs,
  runPnpm,
  runSteps,
  stepBrowsers,
  stepDependencies,
  stepGitHooks,
  stepLinks,
  stepMemory,
  stepSkills,
  stepTools,
  stepHarness,
  stepHarnessAgents,
  codexTrustsProject,
} from '../workspace-setup.js';

/** @typedef {import('../workspace-setup.js').Deps} Deps */

/** The default link target, in this platform's separator. */
const CLAUDE_SKILLS = path.join('.claude', 'skills');

/**
 * Test doubles are loosely typed on purpose (mock return shapes).
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Deps & { logs: string[] }}
 */
function makeDeps(overrides = {}) {
  /** @type {string[]} */
  const logs = [];
  return /** @type {any} */ ({
    rootDir: '/repo',
    platform: 'darwin',
    nodeVersion: 'v24.1.0',
    spawn: vi.fn(() => ({ status: 0, stdout: '' })),
    log: (/** @type {string} */ m) => logs.push(m),
    existsSync: vi.fn(() => true),
    chmodSync: vi.fn(),
    initMemory: vi.fn(() => ({ created: [], updated: [], warnings: [] })),
    installSkills: vi.fn(async () => 0),
    checkSkills: vi.fn(async () => [{ name: 'tdd', ok: true }]),
    linkSkills: vi.fn(() => [
      { target: '.claude/skills', name: 'tdd', status: 'ok' },
    ]),
    tools: {
      scan: vi.fn(),
      registry: vi.fn(() => ({
        version: 1,
        updatedAt: null,
        tools: [{ name: 'codex', kind: 'agent', ok: true }],
      })),
      catalog: vi.fn(() => [
        { name: 'codex', kind: 'agent', recommended: true, check: ['codex'] },
      ]),
    },
    harness: vi.fn(() => 0),
    env: {},
    homedir: () => '/home/u',
    readFile: vi.fn(() => {
      throw new Error('ENOENT');
    }),
    logs,
    ...overrides,
  });
}

const opts = (/** @type {string[]} */ argv = []) => parseArgs(argv);

describe('parseArgs', () => {
  test('should default to setup mode with the Claude link target', () => {
    expect(parseArgs([])).toEqual({
      check: false,
      skipInstall: false,
      skipSkills: false,
      withBrowsers: false,
      json: false,
      help: false,
      targets: [CLAUDE_SKILLS],
    });
  });

  test('should parse every boolean flag', () => {
    expect(
      parseArgs([
        '--check',
        '--skip-install',
        '--skip-skills',
        '--with-browsers',
        '--json',
        '-h',
      ])
    ).toMatchObject({
      check: true,
      skipInstall: true,
      skipSkills: true,
      withBrowsers: true,
      json: true,
      help: true,
    });
  });

  test('should append extra targets in both forms', () => {
    expect(
      parseArgs(['--target', '.dsh/skills', '--target=x']).targets
    ).toEqual([CLAUDE_SKILLS, '.dsh/skills', 'x']);
  });

  test('should reject a target flag without a value', () => {
    expect(() => parseArgs(['--target'])).toThrow('--target needs a directory');
  });

  test('should reject unknown options', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option: --nope');
  });
});

describe('runPnpm', () => {
  test('should use a shell on Windows for the pnpm.cmd shim', () => {
    const deps = makeDeps({ platform: 'win32' });
    runPnpm(deps, ['install']);
    expect(deps.spawn).toHaveBeenCalledWith('pnpm', ['install'], {
      cwd: '/repo',
      shell: true,
    });
  });

  test('should spawn pnpm without a shell elsewhere', () => {
    const deps = makeDeps();
    runPnpm(deps, ['install'], { stdio: 'inherit' });
    expect(deps.spawn).toHaveBeenCalledWith('pnpm', ['install'], {
      cwd: '/repo',
      shell: false,
      stdio: 'inherit',
    });
  });
});

describe('checkNode', () => {
  test('should pass on a supported version', () => {
    expect(checkNode(makeDeps()).status).toBe('ok');
  });

  test('should fail with an install hint on an old version', () => {
    const result = checkNode(makeDeps({ nodeVersion: 'v20.11.0' }));
    expect(result).toMatchObject({ status: 'fail' });
    expect(result.fix).toContain('nvm install 24');
  });
});

describe('stepDependencies', () => {
  test('should pass the check when node_modules exists', () => {
    expect(stepDependencies(opts(['--check']), makeDeps()).status).toBe('ok');
  });

  test('should fail the check when node_modules is missing', () => {
    const deps = makeDeps({ existsSync: () => false });
    expect(stepDependencies(opts(['--check']), deps)).toMatchObject({
      status: 'fail',
      fix: 'pnpm install',
    });
  });

  test('should skip when install is disabled and dependencies are missing', () => {
    const deps = makeDeps({ existsSync: () => false });
    expect(stepDependencies(opts(['--skip-install']), deps).status).toBe(
      'skip'
    );
  });

  test('should report ok when install is disabled and dependencies exist', () => {
    expect(stepDependencies(opts(['--skip-install']), makeDeps()).status).toBe(
      'ok'
    );
  });

  test('should run a frozen-lockfile install', () => {
    const deps = makeDeps();
    expect(stepDependencies(opts(), deps).status).toBe('done');
    expect(deps.spawn).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  test('should fail with a corepack hint when install fails', () => {
    const deps = makeDeps({ spawn: vi.fn(() => ({ status: 1 })) });
    expect(stepDependencies(opts(), deps)).toMatchObject({
      status: 'fail',
      fix: 'corepack enable && pnpm install',
    });
  });
});

describe('stepLinks', () => {
  const problem = [{ target: '.claude/skills', name: 'a', status: 'missing' }];

  test('should fail the check with the link command', () => {
    const deps = makeDeps({ linkSkills: vi.fn(() => problem) });
    expect(stepLinks(opts(['--check']), deps)).toMatchObject({
      status: 'fail',
      fix: 'pnpm skills:link',
    });
  });

  test('should fail setup with a conflict hint', () => {
    const deps = makeDeps({ linkSkills: vi.fn(() => problem) });
    expect(stepLinks(opts(), deps).fix).toContain('resolve conflicts');
  });

  test('should report changes as done', () => {
    const deps = makeDeps({
      linkSkills: vi.fn(() => [
        { target: '.claude/skills', name: 'a', status: 'linked' },
      ]),
    });
    expect(stepLinks(opts(), deps).status).toBe('done');
  });

  test('should report ok when nothing changed', () => {
    expect(stepLinks(opts(), makeDeps()).status).toBe('ok');
  });
});

describe('stepSkills', () => {
  test('should warn when the install fails', async () => {
    const deps = makeDeps({ installSkills: vi.fn(async () => 1) });
    expect(await stepSkills(opts(), deps)).toMatchObject({
      status: 'warn',
      fix: expect.stringContaining('pnpm skills:install'),
    });
  });

  test('should report done after a successful install', async () => {
    expect((await stepSkills(opts(), makeDeps())).status).toBe('done');
  });

  test('should only verify in check mode', async () => {
    const deps = makeDeps();
    expect((await stepSkills(opts(['--check']), deps)).status).toBe('ok');
    expect(deps.installSkills).not.toHaveBeenCalled();
  });

  test('should only verify when skills are skipped', async () => {
    const deps = makeDeps();
    expect((await stepSkills(opts(['--skip-skills']), deps)).status).toBe('ok');
    expect(deps.installSkills).not.toHaveBeenCalled();
  });

  test('should warn with an install command for missing skills', async () => {
    const deps = makeDeps({
      checkSkills: vi.fn(async () => [
        { name: 'tdd', ok: false },
        { name: 'code-review', ok: false },
      ]),
    });
    expect(await stepSkills(opts(['--check']), deps)).toMatchObject({
      status: 'warn',
      fix: 'pnpm skills:install --only tdd,code-review',
    });
  });
});

describe('stepGitHooks', () => {
  const configured = () =>
    makeDeps({ spawn: vi.fn(() => ({ status: 0, stdout: '.githooks\n' })) });

  test('should pass the check when hooks are configured', () => {
    expect(stepGitHooks(opts(['--check']), configured()).status).toBe('ok');
  });

  test('should fail the check when hooks are not configured', () => {
    const deps = makeDeps({
      spawn: vi.fn(() => ({ status: 1, stdout: null })),
    });
    expect(stepGitHooks(opts(['--check']), deps).status).toBe('fail');
  });

  /**
   * git answering core.hooksPath with `value` and the common dir with `common`.
   *
   * @param {string} value
   * @param {string} [common]
   */
  const gitAnswers = (value, common = '/repo/.git') =>
    makeDeps({
      spawn: vi.fn(
        (/** @type {string} */ _cmd, /** @type {string[]} */ args) =>
          args.includes('--git-common-dir')
            ? { status: 0, stdout: `${common}\n` }
            : { status: 0, stdout: `${value}\n` }
      ),
    });

  test("should accept an absolute path to this checkout's hooks", () => {
    // Claude Code's worktree support can rewrite the shared setting this way.
    expect(
      stepGitHooks(opts(['--check']), gitAnswers('/repo/.githooks'))
    ).toEqual({
      id: 'git-hooks',
      status: 'ok',
      detail: 'core.hooksPath=/repo/.githooks',
    });
  });

  test("should accept, in a linked worktree, the main checkout's hooks", () => {
    const deps = gitAnswers('/main/.githooks', '/main/.git');
    expect(stepGitHooks(opts(['--check']), deps).status).toBe('ok');
  });

  test('should accept only this checkout when git cannot name the common dir', () => {
    const deps = makeDeps({
      spawn: vi.fn(
        (/** @type {string} */ _cmd, /** @type {string[]} */ args) =>
          args.includes('--git-common-dir')
            ? { status: 128, stdout: '' }
            : { status: 0, stdout: '/main/.githooks\n' }
      ),
    });
    expect(stepGitHooks(opts(['--check']), deps).status).toBe('fail');
  });

  test('should fail the check for hooks of another repository', () => {
    expect(
      stepGitHooks(opts(['--check']), gitAnswers('/other/.githooks')).status
    ).toBe('fail');
  });

  test('should make hooks executable and keep existing config', () => {
    const deps = configured();
    expect(stepGitHooks(opts(), deps).status).toBe('ok');
    expect(deps.chmodSync).toHaveBeenCalledTimes(HOOK_FILES.length);
  });

  test('should configure the hooks path', () => {
    const deps = makeDeps();
    expect(stepGitHooks(opts(), deps).status).toBe('done');
    expect(deps.spawn).toHaveBeenLastCalledWith(
      'git',
      ['config', 'core.hooksPath', '.githooks'],
      { cwd: '/repo' }
    );
  });

  test('should fail when git config fails', () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: '' })
      .mockReturnValueOnce({ status: 128 });
    expect(stepGitHooks(opts(), makeDeps({ spawn }))).toMatchObject({
      status: 'fail',
      detail: 'git config exited 128',
    });
  });
});

describe('stepBrowsers', () => {
  test('should skip unless requested', () => {
    expect(stepBrowsers(opts(), makeDeps()).status).toBe('skip');
  });

  test('should skip in check mode', () => {
    expect(
      stepBrowsers(opts(['--check', '--with-browsers']), makeDeps()).status
    ).toBe('skip');
  });

  test('should install both browsers', () => {
    const deps = makeDeps();
    expect(stepBrowsers(opts(['--with-browsers']), deps).status).toBe('done');
    expect(deps.spawn).toHaveBeenCalledTimes(2);
  });

  test('should warn with the failed commands', () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    expect(
      stepBrowsers(opts(['--with-browsers']), makeDeps({ spawn }))
    ).toMatchObject({
      status: 'warn',
      fix: 'pnpm exec playwright install chromium',
    });
  });
});

describe('stepTools', () => {
  /** @param {Record<string, unknown>} [tools] */
  const withTools = (tools = {}) => {
    const deps = makeDeps();
    return makeDeps({ tools: { ...deps.tools, ...tools } });
  };

  test('should scan in setup mode and report the recorded tools', () => {
    const deps = withTools();
    expect(stepTools(opts(), deps)).toEqual({
      id: 'tools',
      status: 'ok',
      detail: '1 tool(s) in tools/local.json (pnpm tools list)',
    });
    expect(deps.tools.scan).toHaveBeenCalled();
  });

  test('should only read the registry in check mode', () => {
    const deps = withTools();
    stepTools(opts(['--check']), deps);
    expect(deps.tools.scan).not.toHaveBeenCalled();
  });

  test('should warn about recommended tools that are missing or broken', () => {
    const deps = withTools({
      registry: () => ({
        version: 1,
        updatedAt: null,
        tools: [{ name: 'codex', kind: 'agent', ok: false }],
      }),
      catalog: () => [
        {
          name: 'codex',
          recommended: true,
          docs: 'https://developers.openai.com/codex/cli',
        },
        {
          name: 'gh',
          recommended: true,
          install: { darwin: 'brew install gh' },
        },
        { name: 'weird', recommended: true },
        { name: 'jq' },
      ],
    });
    const result = stepTools(opts(['--check']), deps);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(
      'recommended but missing: codex, gh, weird'
    );
    expect(result.fix).toBe(
      'codex: see https://developers.openai.com/codex/cli | gh: brew install gh | weird: see pnpm tools show'
    );
  });

  test('should point at pnpm tools scan when nothing is recorded', () => {
    const deps = withTools({
      registry: () => ({ version: 1, updatedAt: null, tools: [] }),
    });
    expect(stepTools(opts(['--check']), deps)).toMatchObject({
      status: 'warn',
      fix: 'pnpm tools scan',
    });
  });

  test('should warn with a reset fix when the registry is unreadable', () => {
    const deps = withTools({
      registry: () => {
        throw new Error('Invalid tools/local.json:\n  - version must be 1');
      },
    });
    expect(stepTools(opts(['--check']), deps)).toEqual({
      id: 'tools',
      status: 'warn',
      detail: 'tool registry unreadable: Invalid tools/local.json:',
      fix: 'pnpm tools scan --reset',
    });
  });
});

describe('stepMemory', () => {
  /**
   * git answers: `ls-files` prints `tracked`; `check-ignore` exits 1 for the
   * paths in `unignored`.
   *
   * @param {{ tracked?: string, unignored?: string[] }} [answers]
   */
  const gitSpawn = ({ tracked = '', unignored = [] } = {}) =>
    vi.fn((/** @type {string} */ _cmd, /** @type {string[]} */ args) =>
      args[0] === 'ls-files'
        ? { status: 0, stdout: tracked }
        : { status: unignored.includes(String(args.at(-1))) ? 1 : 0 }
    );

  test('should list the paths it guards', () => {
    expect(MEMORY_PATHS).toEqual([
      'AGENTS.local.md',
      'CLAUDE.local.md',
      'memory/',
    ]);
  });

  test('should fail when a memory file is tracked by git', () => {
    const deps = makeDeps({
      spawn: gitSpawn({
        tracked: 'AGENTS.local.md\nmemory/log.jsonl\nmemory/cache/notes.json\n',
      }),
    });

    expect(stepMemory(opts(['--check']), deps)).toEqual({
      id: 'memory',
      status: 'fail',
      detail:
        'personal memory is tracked by git: AGENTS.local.md, memory/log.jsonl, memory/cache/notes.json',
      fix: 'git rm -r --cached -- AGENTS.local.md memory (keeps the files), then commit',
    });
    expect(deps.initMemory).not.toHaveBeenCalled();
  });

  test('should ignore ls-files lines that are not memory paths', () => {
    const deps = makeDeps({ spawn: gitSpawn({ tracked: '.githooks\n' }) });

    expect(stepMemory(opts(['--check']), deps).status).toBe('ok');
  });

  test('should treat ls-files without output as nothing tracked', () => {
    const deps = makeDeps({
      spawn: vi.fn(() => ({ status: 0, stdout: null })),
    });

    expect(stepMemory(opts(['--check']), deps).status).toBe('ok');
  });

  test('should fail when a memory path is not gitignored', () => {
    const deps = makeDeps({ spawn: gitSpawn({ unignored: ['memory/'] }) });

    expect(stepMemory(opts(), deps)).toEqual({
      id: 'memory',
      status: 'fail',
      detail: 'not gitignored: memory/',
      fix: 'add /memory/ to .gitignore',
    });
    expect(deps.initMemory).not.toHaveBeenCalled();
  });

  test('should pass a check when the local files exist', () => {
    const deps = makeDeps({ spawn: gitSpawn() });

    expect(stepMemory(opts(['--check']), deps)).toEqual({
      id: 'memory',
      status: 'ok',
      detail: 'local and gitignored (pnpm memory status)',
    });
  });

  test('should warn in a check when memory is not set up', () => {
    const deps = makeDeps({
      spawn: gitSpawn(),
      existsSync: vi.fn(
        (/** @type {string} */ file) => !file.endsWith('CLAUDE.local.md')
      ),
    });

    expect(stepMemory(opts(['--check']), deps)).toEqual({
      id: 'memory',
      status: 'warn',
      detail: 'not set up: CLAUDE.local.md',
      fix: 'pnpm memory init',
    });
  });

  test('should create the local files during setup', () => {
    const deps = makeDeps({
      spawn: gitSpawn(),
      initMemory: vi.fn(() => ({
        created: ['memory/', 'AGENTS.local.md'],
        updated: ['CLAUDE.local.md'],
        warnings: [],
      })),
    });

    expect(stepMemory(opts(), deps)).toEqual({
      id: 'memory',
      status: 'done',
      detail: 'created memory/, AGENTS.local.md; updated CLAUDE.local.md',
    });
    expect(deps.initMemory).toHaveBeenCalledWith('/repo');
  });

  test('should report memory that is already set up', () => {
    const deps = makeDeps({ spawn: gitSpawn() });

    expect(stepMemory(opts(), deps)).toMatchObject({ status: 'ok' });
  });

  test('should warn about render warnings', () => {
    const deps = makeDeps({
      spawn: gitSpawn(),
      initMemory: vi.fn(() => ({
        created: [],
        updated: ['AGENTS.local.md'],
        warnings: ['The core block is over 3000 characters.'],
      })),
    });

    expect(stepMemory(opts(), deps)).toEqual({
      id: 'memory',
      status: 'warn',
      detail:
        'updated AGENTS.local.md; The core block is over 3000 characters.',
      fix: 'pnpm memory status',
    });
  });

  test('should set up the main checkout from a linked worktree', () => {
    const tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'setup-wt-'))
    );
    const main = path.join(tmp, 'main');
    const wtGit = path.join(main, '.git', 'worktrees', 'x');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);
    const deps = makeDeps({ rootDir: wt, spawn: gitSpawn() });

    try {
      stepMemory(opts(), deps);
      stepMemory(opts(['--check']), deps);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(deps.initMemory).toHaveBeenCalledWith(main);
    expect(deps.existsSync).toHaveBeenCalledWith(path.join(main, 'memory/'));
  });

  test('should warn when init fails', () => {
    const deps = makeDeps({
      spawn: gitSpawn(),
      initMemory: vi.fn(() => {
        throw new Error('The memory block in AGENTS.local.md is broken.\nmore');
      }),
    });

    expect(stepMemory(opts(), deps)).toEqual({
      id: 'memory',
      status: 'warn',
      detail: 'The memory block in AGENTS.local.md is broken.',
      fix: 'pnpm memory init',
    });
  });
});

/** A fake harness main that logs `lines` and returns `code`. */
const fakeHarness = (
  /** @type {number} */ code,
  /** @type {string[]} */ lines
) =>
  vi.fn(({ deps }) => {
    lines.forEach((l) => deps.log(l));
    return code;
  });

describe('stepHarness', () => {
  test('should sync in setup mode and report written files', () => {
    const deps = makeDeps({
      harness: fakeHarness(0, ['Wrote .dsh/hooks.json', 'Wrote x']),
    });
    expect(stepHarness(opts(), deps)).toEqual({
      id: 'harness',
      status: 'done',
      detail: 'wrote .dsh/hooks.json, x',
    });
    expect(deps.harness).toHaveBeenCalledWith({
      argv: ['sync'],
      deps: { rootDir: '/repo', log: expect.any(Function) },
    });
  });

  test('should hint at /hooks when the Codex hooks changed', () => {
    const deps = makeDeps({
      harness: fakeHarness(0, ['Wrote .codex/hooks.json']),
    });
    expect(stepHarness(opts(), deps).detail).toContain('/hooks');
  });

  test('should be ok when nothing needed writing', () => {
    const deps = makeDeps({
      harness: fakeHarness(0, ['✓ generated files are up to date']),
    });
    expect(stepHarness(opts(), deps).status).toBe('ok');
  });

  test('should fail setup when the Claude settings differ', () => {
    const deps = makeDeps({
      harness: fakeHarness(1, ['✗ .claude/settings.json hooks differ']),
    });
    expect(stepHarness(opts(), deps)).toMatchObject({
      status: 'fail',
      fix: 'pnpm harness check',
      detail: expect.stringContaining('settings.json'),
    });
  });

  test('should use a default detail when setup fails silently', () => {
    const deps = makeDeps({ harness: fakeHarness(1, []) });
    expect(stepHarness(opts(), deps).detail).toContain('settings.json');
  });

  test('should be ok in check mode on a pass', () => {
    const deps = makeDeps();
    expect(stepHarness(opts(['--check']), deps).status).toBe('ok');
    expect(deps.harness).toHaveBeenCalledWith(
      expect.objectContaining({ argv: ['check'] })
    );
  });

  test('should point to sync when a generated file is stale', () => {
    const deps = makeDeps({
      harness: fakeHarness(1, ['✗ .codex/hooks.json is out of date']),
    });
    expect(stepHarness(opts(['--check']), deps)).toMatchObject({
      status: 'fail',
      fix: 'pnpm harness sync',
    });
  });

  test('should point to check when only the Claude settings differ', () => {
    const deps = makeDeps({
      harness: fakeHarness(1, ['✗ .claude/settings.json hooks differ']),
    });
    expect(stepHarness(opts(['--check']), deps).fix).toBe('pnpm harness check');
  });

  test('should fail with a default detail when check prints no problem', () => {
    const deps = makeDeps({ harness: fakeHarness(1, []) });
    expect(stepHarness(opts(['--check']), deps)).toMatchObject({
      detail: 'pnpm harness check failed',
      fix: 'pnpm harness sync',
    });
  });
});

describe('codexTrustsProject', () => {
  const root = '/repo';
  test.each([
    ['[projects."/repo"]\ntrust_level = "trusted"\n', true],
    ["[projects.'/repo']\ntrust_level = 'trusted'", true],
    ['[projects."/repo"]\ntrust_level = "untrusted"', false],
    ['[projects."/other"]\ntrust_level = "trusted"', false],
    ['[projects."/repo"]\n[other]\ntrust_level = "trusted"', false],
    ['trust_level = "trusted"', false],
    ['', false],
  ])('should parse %j as %s', (text, expected) => {
    expect(codexTrustsProject(text, root)).toBe(expected);
  });

  test('should unescape Windows paths', () => {
    expect(
      codexTrustsProject(
        '[projects."C:\\\\r"]\ntrust_level = "trusted"',
        'C:\\r'
      )
    ).toBe(true);
  });
});

describe('stepHarnessAgents', () => {
  const registryOf = (/** @type {string[]} */ names) => ({
    registry: () => ({
      version: 1,
      updatedAt: null,
      tools: names.map((name) => ({ name, kind: 'agent', ok: true })),
    }),
  });

  test('should report nothing when no agent is installed', () => {
    const deps = makeDeps({ tools: registryOf([]) });
    expect(stepHarnessAgents(deps)).toEqual([]);
  });

  test('should report nothing when the registry is unreadable', () => {
    const deps = makeDeps({
      tools: {
        registry: () => {
          throw new Error('bad');
        },
      },
    });
    expect(stepHarnessAgents(deps)).toEqual([]);
  });

  test('should warn when Codex does not trust the checkout', () => {
    const readFile = vi.fn(() => '[projects."/else"]\ntrust_level = "trusted"');
    const deps = makeDeps({
      tools: registryOf(['codex']),
      env: { CODEX_HOME: '/fake/codex' },
      readFile,
    });
    const [result] = stepHarnessAgents(deps);
    expect(readFile).toHaveBeenCalledWith(
      path.join('/fake/codex', 'config.toml')
    );
    expect(result).toMatchObject({ id: 'harness-codex', status: 'warn' });
    expect(result.fix).toContain('/hooks');
    expect(JSON.stringify(result)).not.toContain('/else');
  });

  test('should warn when the Codex config is missing', () => {
    const deps = makeDeps({ tools: registryOf(['codex']) });
    expect(stepHarnessAgents(deps)[0].status).toBe('warn');
  });

  test('should be ok when Codex trusts the checkout (default home)', () => {
    const readFile = vi.fn(() => '[projects."/repo"]\ntrust_level = "trusted"');
    const deps = makeDeps({ tools: registryOf(['codex']), readFile });
    expect(stepHarnessAgents(deps)[0].status).toBe('ok');
    expect(readFile).toHaveBeenCalledWith(
      path.join('/home/u', '.codex', 'config.toml')
    );
  });

  test('should explain how to start DSH', () => {
    const deps = makeDeps({ tools: registryOf(['dsh']) });
    const [result] = stepHarnessAgents(deps);
    expect(result).toMatchObject({ id: 'harness-dsh', status: 'ok' });
    expect(result.detail).toContain(
      'dsh <profile> --patch .dsh/workspace.patch.yml'
    );
    expect(result.detail).toContain(
      'dsh plugin --profile <profile> add @deepseek-ai/dsh-hooks-claude-code@<version> @deepseek-ai/dsh-hook-protocol@<version> @deepseek-ai/dsh-llm@<version>'
    );
    expect(result.detail).toContain('dsh --version');
    expect(result.detail).not.toContain('dsh plugin add');
  });
});

describe('runSteps', () => {
  test('should stop after an unsupported Node.js version', async () => {
    const results = await runSteps(
      opts(),
      makeDeps({ nodeVersion: 'v18.0.0' })
    );
    expect(results.map((r) => r.id)).toEqual(['node']);
  });

  test('should link before and after installing skills during setup', async () => {
    const deps = makeDeps();
    const results = await runSteps(opts(), deps);
    expect(results.map((r) => r.id)).toEqual([
      'node',
      'dependencies',
      'skills',
      'skill-links',
      'git-hooks',
      'memory',
      'browsers',
      'tools',
      'harness',
      'harness-codex',
    ]);
    expect(deps.linkSkills).toHaveBeenCalledTimes(2);
  });

  test('should report a migration pass that changed links', async () => {
    const deps = makeDeps({
      linkSkills: vi
        .fn()
        .mockReturnValueOnce([
          { target: '.claude/skills', name: 'a', status: 'migrated' },
        ])
        .mockReturnValue([
          { target: '.claude/skills', name: 'a', status: 'ok' },
        ]),
    });
    const results = await runSteps(opts(), deps);
    expect(results.map((r) => r.id)).toContain('skill-migrate');
  });

  test('should link only once in check mode', async () => {
    const deps = makeDeps();
    await runSteps(opts(['--check']), deps);
    expect(deps.linkSkills).toHaveBeenCalledTimes(1);
  });
});

describe('formatResult', () => {
  test('should show the fix for actionable results', () => {
    expect(
      formatResult({ id: 'x', status: 'warn', detail: 'd', fix: 'do it' })
    ).toBe('! x: d\n    Fix: do it');
  });

  test('should hide the fix for ok and done results', () => {
    expect(formatResult({ id: 'x', status: 'ok', detail: 'd', fix: 'f' })).toBe(
      '✓ x: d'
    );
    expect(
      formatResult({ id: 'x', status: 'done', detail: 'd', fix: 'f' })
    ).toBe('✓ x: d');
  });

  test('should print plain lines without a fix', () => {
    expect(formatResult({ id: 'x', status: 'skip', detail: 'd' })).toBe(
      '- x: d'
    );
  });
});

describe('main', () => {
  test('should print help', async () => {
    const deps = makeDeps();
    expect(await main({ argv: ['--help'], deps })).toBe(0);
    expect(deps.logs).toEqual([HELP]);
  });

  test('should print a JSON report', async () => {
    const deps = makeDeps({
      spawn: vi.fn(() => ({ status: 0, stdout: '.githooks' })),
    });
    expect(await main({ argv: ['--check', '--json'], deps })).toBe(0);
    expect(JSON.parse(deps.logs[0])).toMatchObject({ ok: true });
  });

  test('should report a passed check', async () => {
    const deps = makeDeps({
      spawn: vi.fn(() => ({ status: 0, stdout: '.githooks' })),
    });
    expect(await main({ argv: ['--check'], deps })).toBe(0);
    expect(deps.logs.at(-1)).toBe('Workspace check passed.');
  });

  test('should report a ready workspace after setup', async () => {
    const deps = makeDeps();
    expect(await main({ argv: [], deps })).toBe(0);
    expect(deps.logs.at(-1)).toBe('Workspace ready.');
  });

  test('should fail with a next-step hint', async () => {
    const deps = makeDeps({ nodeVersion: 'v18.0.0' });
    expect(await main({ argv: [], deps })).toBe(1);
    expect(deps.logs.at(-1)).toContain('pnpm workspace:check');
  });

  test('should read the Codex config from disk by default', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-'));
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      '[projects."/repo"]\ntrust_level = "trusted"\n'
    );
    const deps = makeDeps({ env: { CODEX_HOME: home } });
    delete (/** @type {any} */ (deps).readFile);
    const log = vi.fn();
    await main({ argv: ['--check'], deps: { ...deps, log } });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('✓ harness-codex')
    );
    fs.rmSync(home, { recursive: true });
  });

  test('should fall back to real dependencies when none are injected', async () => {
    const log = vi.fn();
    expect(await main({ argv: ['--help'], deps: { log } })).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP);
  });
});
