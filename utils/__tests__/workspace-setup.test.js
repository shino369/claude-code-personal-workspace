import { vi } from 'vitest';
import {
  HELP,
  HOOK_FILES,
  OPTIONAL_TOOLS,
  checkNode,
  formatResult,
  main,
  parseArgs,
  runPnpm,
  runSteps,
  stepBrowsers,
  stepDependencies,
  stepGitHooks,
  stepLinks,
  stepSkills,
  stepTools,
} from '../workspace-setup.js';

/** @typedef {import('../workspace-setup.js').Deps} Deps */

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
    installSkills: vi.fn(async () => 0),
    checkSkills: vi.fn(async () => [{ name: 'tdd', ok: true }]),
    linkSkills: vi.fn(() => [
      { target: '.claude/skills', name: 'tdd', status: 'ok' },
    ]),
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
      targets: ['.claude/skills'],
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
    ).toEqual(['.claude/skills', '.dsh/skills', 'x']);
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
  test('should report all tools found', () => {
    expect(stepTools(makeDeps()).status).toBe('ok');
  });

  test('should warn about missing tools with install hints', () => {
    const spawn = vi.fn((/** @type {string} */ tool) => ({
      status: tool === 'codex' ? 1 : 0,
    }));
    const result = stepTools(makeDeps({ spawn }));
    expect(result.status).toBe('warn');
    expect(result.fix).toContain('codex: https://developers.openai.com/codex');
  });

  test('should use a shell on Windows for cmd shims', () => {
    const deps = makeDeps({ platform: 'win32' });
    stepTools(deps);
    expect(deps.spawn).toHaveBeenCalledWith(
      OPTIONAL_TOOLS[0].tool,
      ['--version'],
      { stdio: 'ignore', shell: true }
    );
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
      'browsers',
      'tools',
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

  test('should fall back to real dependencies when none are injected', async () => {
    const log = vi.fn();
    expect(await main({ argv: ['--help'], deps: { log } })).toBe(0);
    expect(log).toHaveBeenCalledWith(HELP);
  });
});
