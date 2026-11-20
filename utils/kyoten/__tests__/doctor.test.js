import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatCheck, runChecks, workspaceCheck } from '../doctor.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-doctor-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const okRun = () => ({ status: 0, stdout: 'v1\n' });
const failRun = () => ({ status: 1, stdout: '' });

/**
 * A minimal kyoten workspace at `dir`.
 *
 * @param {string} dir
 */
function makeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, 'utils', 'kyoten'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"kyoten"}');
  fs.writeFileSync(path.join(dir, 'utils', 'kyoten', 'cli.js'), '');
}

/**
 * @param {string} dir
 * @param {string} version
 */
function writeInfo(dir, version) {
  fs.mkdirSync(path.join(dir, '.kyoten'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.kyoten', 'home.json'),
    JSON.stringify({
      managed: true,
      version,
      sourceCommit: 'x',
      createdAt: '2026-01-01T00:00:00Z',
    })
  );
}

/**
 * @param {Partial<Parameters<typeof runChecks>[0]>} [overrides]
 */
function check(overrides = {}) {
  return runChecks({
    home: path.join(tmp, 'home'),
    homeSource: 'test',
    version: '1.0.0',
    profile: path.join(tmp, 'profile'),
    env: {},
    platform: 'linux',
    homedir: path.join(tmp, 'user'),
    run: /** @type {any} */ (okRun),
    canRun: () => false,
    registry: () => null,
    versions: /** @type {any} */ ({ node: '99.0.0' }),
    ...overrides,
  });
}

/**
 * @param {ReturnType<typeof check>} checks
 * @param {string} id
 */
const byId = (checks, id) => checks.find((c) => c.id === id);

describe('formatCheck', () => {
  test('should print an ok check without its Fix line', () => {
    expect(
      formatCheck({ id: 'git', status: 'ok', detail: 'git 2', fix: 'never' })
    ).toBe('✓ git: git 2');
  });

  test('should print the Fix line of a warning', () => {
    expect(
      formatCheck({ id: 'home', status: 'warn', detail: 'gone', fix: 'init' })
    ).toBe('! home: gone\n    Fix: init');
  });

  test('should print the Fix line of a failure', () => {
    expect(
      formatCheck({ id: 'node', status: 'fail', detail: 'old', fix: 'update' })
    ).toBe('✗ node: old\n    Fix: update');
  });

  test('should print a failure without a fix as one line', () => {
    expect(formatCheck({ id: 'x', status: 'fail', detail: 'bad' })).toBe(
      '✗ x: bad'
    );
  });
});

describe('runChecks prerequisites', () => {
  test('should pass node, git and pnpm when they work', () => {
    const checks = check();

    expect(byId(checks, 'node')).toMatchObject({
      status: 'ok',
      detail: 'Node.js 99.0.0',
    });
    expect(byId(checks, 'git')).toMatchObject({ status: 'ok', detail: 'v1' });
    expect(byId(checks, 'pnpm')).toMatchObject({
      status: 'ok',
      detail: 'pnpm v1',
    });
  });

  test('should fail each prerequisite with its fix when it is missing', () => {
    const checks = check({
      run: /** @type {any} */ (failRun),
      versions: /** @type {any} */ ({ node: '10.0.0' }),
    });

    for (const id of ['node', 'git', 'pnpm']) {
      expect(byId(checks, id)?.status).toBe('fail');
      expect(byId(checks, id)?.fix).toBeTruthy();
    }
    expect(byId(checks, 'node')?.detail).toMatch(/needs Node\.js/);
  });

  test('should read process.versions and spawn for real by default', () => {
    const checks = runChecks({
      home: path.join(tmp, 'home'),
      homeSource: 'test',
      version: '1.0.0',
      profile: path.join(tmp, 'profile'),
      env: {},
      platform: 'linux',
      homedir: tmp,
      canRun: () => false,
      registry: () => null,
    });

    expect(byId(checks, 'node')?.detail).toBe(
      `Node.js ${process.versions.node}`
    );
    expect(byId(checks, 'git')?.status).toBe('ok');
  });
});

describe('runChecks home', () => {
  test('should warn that a missing home does not exist yet', () => {
    const checks = check();

    expect(byId(checks, 'home')).toMatchObject({
      status: 'warn',
      fix: 'kyoten init',
    });
    expect(byId(checks, 'version')).toBeUndefined();
  });

  test('should fail a non-empty directory that is not a workspace', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'file.txt'), 'x');

    const checks = check({ home });

    expect(byId(checks, 'home')?.status).toBe('fail');
    expect(byId(checks, 'home')?.detail).toMatch(/not a kyoten workspace/);
    expect(byId(checks, 'version')).toBeUndefined();
  });

  test('should accept a workspace and report a clone without home.json', () => {
    const home = path.join(tmp, 'home');
    makeWorkspace(home);

    const checks = check({ home });

    expect(byId(checks, 'home')).toMatchObject({
      status: 'ok',
      detail: `${home} (test)`,
    });
    expect(byId(checks, 'version')).toMatchObject({ status: 'ok' });
    expect(byId(checks, 'version')?.detail).toMatch(/is a clone/);
  });

  test('should warn to update when the home is older than kyoten', () => {
    const home = path.join(tmp, 'home');
    makeWorkspace(home);
    writeInfo(home, '0.9.0');

    expect(byId(check({ home }), 'version')).toMatchObject({
      status: 'warn',
      fix: 'kyoten update',
      detail: 'kyoten 1.0.0; the home has 0.9.0',
    });
  });

  test('should warn when the home is newer than kyoten', () => {
    const home = path.join(tmp, 'home');
    makeWorkspace(home);
    writeInfo(home, '2.0.0');

    expect(byId(check({ home }), 'version')).toMatchObject({
      status: 'warn',
      fix: 'npx kyoten@latest doctor',
    });
    expect(byId(check({ home }), 'version')?.detail).toMatch(/newer 2\.0\.0/);
  });

  test('should pass when the home has the same version', () => {
    const home = path.join(tmp, 'home');
    makeWorkspace(home);
    writeInfo(home, '1.0.0');

    expect(byId(check({ home }), 'version')).toMatchObject({
      status: 'ok',
      detail: 'kyoten 1.0.0; the home has 1.0.0',
    });
  });
});

describe('runChecks agents', () => {
  test('should warn with an install hint for each missing agent', () => {
    const checks = check();

    for (const id of ['claude', 'codex', 'dsh']) {
      expect(byId(checks, id)).toMatchObject({
        status: 'warn',
        detail: 'not found',
      });
      expect(byId(checks, id)?.fix).toBeTruthy();
    }
    expect(byId(checks, 'codex-trust')).toBeUndefined();
    expect(byId(checks, 'dsh-hooks')).toBeUndefined();
  });

  test('should report the command found on PATH', () => {
    const checks = check({
      env: { PATH: path.join(tmp, 'bin') },
      canRun: (file) => path.basename(file) === 'claude',
    });

    expect(byId(checks, 'claude')?.status).toBe('ok');
    expect(byId(checks, 'claude')?.detail).toContain('claude');
  });

  test('should report a command from the tools registry', () => {
    const checks = check({
      registry: (_home, name) =>
        name === 'dsh' ? ['npx', '-y', '@deepseek-ai/dsh'] : null,
    });

    expect(byId(checks, 'dsh')).toMatchObject({
      status: 'ok',
      detail: 'npx -y @deepseek-ai/dsh',
    });
  });

  test('should skip the codex and dsh extras when the home is not a workspace', () => {
    const checks = check({
      registry: () => ['tool'],
    });

    expect(byId(checks, 'codex')?.status).toBe('ok');
    expect(byId(checks, 'codex-trust')).toBeUndefined();
    expect(byId(checks, 'dsh-hooks')).toBeUndefined();
  });
});

describe('runChecks codex trust', () => {
  /** @type {string} */
  let home;

  beforeEach(() => {
    home = path.join(tmp, 'home');
    makeWorkspace(home);
  });

  /**
   * @param {string} codexHome
   * @param {Partial<Parameters<typeof runChecks>[0]>} [overrides]
   */
  const codexCheck = (codexHome, overrides = {}) =>
    byId(
      check({
        home,
        registry: (_h, name) => (name === 'codex' ? ['codex'] : null),
        env: { CODEX_HOME: codexHome },
        ...overrides,
      }),
      'codex-trust'
    );

  test('should pass when CODEX_HOME config trusts the home', () => {
    const codexHome = path.join(tmp, 'codex');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      `[projects.'${home}']\ntrust_level = "trusted"\n`
    );

    expect(codexCheck(codexHome)?.status).toBe('ok');
  });

  test('should warn when the config does not mention the home', () => {
    const codexHome = path.join(tmp, 'codex');
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "x"\n');

    expect(codexCheck(codexHome)).toMatchObject({
      status: 'warn',
      fix: 'kyoten codex, accept the trust prompt, then run /hooks',
    });
  });

  test('should warn when there is no config file', () => {
    expect(codexCheck(path.join(tmp, 'absent'))?.status).toBe('warn');
  });

  test('should fall back to the .codex folder of the home directory', () => {
    const user = path.join(tmp, 'user');
    fs.mkdirSync(path.join(user, '.codex'), { recursive: true });
    fs.writeFileSync(
      path.join(user, '.codex', 'config.toml'),
      `[projects.'${home}']\ntrust_level = "trusted"\n`
    );

    expect(codexCheck('', { homedir: user })?.status).toBe('ok');
  });
});

describe('runChecks dsh hooks', () => {
  /**
   * @param {string} home
   */
  const dshCheck = (home) =>
    byId(
      check({
        home,
        platform: 'linux',
        registry: (_h, name) => (name === 'dsh' ? ['dsh'] : null),
      }),
      'dsh-hooks'
    );

  test('should fail for a path the hook commands cannot carry', () => {
    const home = path.join(tmp, 'a$b');
    makeWorkspace(home);

    const result = dshCheck(home);

    expect(result?.status).toBe('fail');
    expect(result?.detail).toMatch(/cannot run this workspace's hooks/);
    expect(result?.fix).toMatch(/move the checkout/);
  });

  test('should pass for a normal path and name the patch and bridge', () => {
    const home = path.join(tmp, 'home');
    makeWorkspace(home);

    const result = dshCheck(home);

    expect(result?.status).toBe('ok');
    expect(result?.detail).toMatch(/--patch/);
  });
});

describe('runChecks dscc profile', () => {
  const profile = () => path.join(tmp, 'profile');

  test('should warn when the profile file is missing', () => {
    expect(byId(check(), 'dscc')).toMatchObject({
      status: 'warn',
      fix: 'kyoten dscc --set-key',
    });
  });

  test('should warn when the profile has no token', () => {
    fs.writeFileSync(profile(), 'ANTHROPIC_BASE_URL=https://x\n');

    expect(byId(check(), 'dscc')?.status).toBe('warn');
  });

  test('should warn when the token is a placeholder', () => {
    fs.writeFileSync(profile(), 'ANTHROPIC_AUTH_TOKEN=<your key>\n');

    expect(byId(check(), 'dscc')?.status).toBe('warn');
  });

  test('should pass with a masked token that is never printed in full', () => {
    const token = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    fs.writeFileSync(profile(), `ANTHROPIC_AUTH_TOKEN=${token}\n`);

    const result = byId(check(), 'dscc');

    expect(result?.status).toBe('ok');
    expect(result?.detail).toContain('sk-a...6789');
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

describe('workspaceCheck', () => {
  test('should fail when dependencies are not installed', () => {
    const run = vi.fn();

    const result = workspaceCheck({ home: tmp, run, env: {} });

    expect(result).toMatchObject({
      id: 'workspace',
      status: 'fail',
      detail: 'dependencies are not installed',
      fix: `kyoten --home "${tmp}" init`,
    });
    expect(run).not.toHaveBeenCalled();
  });

  test('should pass when pnpm workspace:check succeeds', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    const run = vi.fn(() => ({ status: 0 }));

    const result = workspaceCheck({
      home: tmp,
      run: /** @type {any} */ (run),
      env: { A: '1' },
    });

    expect(result.status).toBe('ok');
    expect(run).toHaveBeenCalledWith('pnpm', ['workspace:check'], {
      cwd: tmp,
      stdio: 'inherit',
      env: { A: '1' },
    });
  });

  test('should fail when pnpm workspace:check fails', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules'));

    const result = workspaceCheck({
      home: tmp,
      run: /** @type {any} */ (() => ({ status: 1 })),
      env: {},
    });

    expect(result).toMatchObject({
      status: 'fail',
      detail: 'pnpm workspace:check failed (see above)',
    });
  });
});
