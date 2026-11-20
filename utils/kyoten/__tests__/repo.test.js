import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  KYOTEN_IDENTITY,
  TOOL_FIXES,
  UPSTREAM,
  checkNode,
  checkTool,
  commitTree,
  compareVersions,
  initRepo,
  mergeEnv,
  snapshotMessage,
  updateBlocker,
  writeTree,
} from '../repo.js';

/** @type {string} */
let tmp;
/** @type {string} */
let home;
/** @type {NodeJS.ProcessEnv} */
let env;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-repo-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(home, 'b.txt'), 'beta\n');
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_INDEX_FILE',
    'GIT_DIR',
    'GIT_WORK_TREE',
  ]) {
    delete env[key];
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [useEnv]
 */
function git(args, useEnv = env) {
  const result = spawnSync('git', ['-C', home, ...args], {
    encoding: 'utf-8',
    env: useEnv,
  });
  return result.stdout.trim();
}

describe('snapshotMessage', () => {
  test('should name the version in a conventional commit header', () => {
    expect(snapshotMessage('1.2.3')).toBe('chore: kyoten 1.2.3 snapshot');
  });
});

describe('initRepo', () => {
  test('should point main and the upstream branch at one snapshot commit', () => {
    const commit = initRepo({ home, version: '0.1.0', env });

    expect(git(['rev-parse', 'refs/heads/main'])).toBe(commit);
    expect(git(['rev-parse', `refs/heads/${UPSTREAM}`])).toBe(commit);
    expect(git(['rev-parse', 'HEAD'])).toBe(commit);
  });

  test('should commit the files with kyoten as author and the snapshot message', () => {
    initRepo({ home, version: '0.1.0', env });

    expect(git(['log', '-1', '--format=%s'])).toBe(
      'chore: kyoten 0.1.0 snapshot'
    );
    expect(git(['log', '-1', '--format=%an <%ae>'])).toBe(
      'kyoten <kyoten@localhost>'
    );
    expect(
      git(['ls-tree', '-r', '--name-only', 'HEAD']).split(/\r?\n/)
    ).toEqual(['a.txt', 'b.txt']);
  });

  test('should work without any git identity configured', () => {
    expect(() => initRepo({ home, version: '0.1.0', env })).not.toThrow();
    expect(git(['config', 'user.email'])).toBe('');
  });

  test('should not be broken by a global commit.gpgSign=true', () => {
    fs.writeFileSync(
      env.GIT_CONFIG_GLOBAL ?? '',
      '[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n'
    );

    expect(() => initRepo({ home, version: '0.1.0', env })).not.toThrow();
    expect(git(['log', '-1', '--format=%G?'])).toBe('N');
  });

  test('should throw with the git error when git fails', () => {
    const missing = path.join(home, 'a.txt');

    expect(() => initRepo({ home: missing, version: '0.1.0', env })).toThrow(
      /failed/
    );
  });
});

describe('writeTree', () => {
  test('should leave the home index alone when given a separate index and work tree', () => {
    initRepo({ home, version: '0.1.0', env });
    const before = git(['ls-files', '-s']);
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'c.txt'), 'gamma\n');
    const index = path.join(tmp, 'scratch-index');

    const tree = writeTree({ home, workTree: other, index, env });

    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    expect(git(['ls-tree', '--name-only', tree])).toBe('c.txt');
    expect(git(['ls-files', '-s'])).toBe(before);
  });

  test('should include files a global gitignore would drop', () => {
    const ignore = path.join(tmp, 'ignore');
    fs.writeFileSync(ignore, 'a.txt\n');
    fs.writeFileSync(
      env.GIT_CONFIG_GLOBAL ?? '',
      `[core]\n\texcludesFile = ${ignore.replace(/\\/g, '/')}\n`
    );
    spawnSync('git', ['init', '-q', home], { env });

    const tree = writeTree({ home, env });

    expect(git(['ls-tree', '--name-only', tree]).split(/\r?\n/)).toContain(
      'a.txt'
    );
  });
});

describe('commitTree', () => {
  test('should chain a commit onto its parent', () => {
    const first = initRepo({ home, version: '0.1.0', env });
    fs.writeFileSync(path.join(home, 'a.txt'), 'changed\n');
    const tree = writeTree({ home, index: path.join(tmp, 'idx'), env });

    const second = commitTree({
      home,
      tree,
      version: '0.2.0',
      parent: first,
      env,
    });

    expect(git(['rev-parse', `${second}^`])).toBe(first);
    expect(git(['log', '-1', '--format=%s', second])).toBe(
      snapshotMessage('0.2.0')
    );
  });

  test('should make a root commit without a parent', () => {
    spawnSync('git', ['init', '-q', home], { env });
    const tree = writeTree({ home, env });

    const commit = commitTree({ home, tree, version: '0.1.0', env });

    expect(git(['rev-list', '--parents', '-n', '1', commit])).toBe(commit);
  });

  test('should use the kyoten identity', () => {
    expect(KYOTEN_IDENTITY.GIT_COMMITTER_NAME).toBe('kyoten');
    spawnSync('git', ['init', '-q', home], { env });
    const tree = writeTree({ home, env });

    const commit = commitTree({ home, tree, version: '0.1.0', env });

    expect(git(['log', '-1', '--format=%cn', commit])).toBe('kyoten');
  });
});

describe('updateBlocker', () => {
  beforeEach(() => {
    initRepo({ home, version: '0.1.0', env });
  });

  test('should be null for a clean branch', () => {
    expect(updateBlocker({ home })).toBeNull();
  });

  test('should name uncommitted changes to a tracked file', () => {
    fs.writeFileSync(path.join(home, 'a.txt'), 'edited\n');

    expect(updateBlocker({ home })).toMatch(/uncommitted changes/);
  });

  test('should ignore untracked files', () => {
    fs.writeFileSync(path.join(home, 'new.txt'), 'x\n');

    expect(updateBlocker({ home })).toBeNull();
  });

  test('should name a detached HEAD', () => {
    git(['checkout', '-q', '--detach']);

    expect(updateBlocker({ home })).toMatch(/detached HEAD/);
  });

  test.each([
    ['MERGE_HEAD', /a merge is in progress/],
    ['rebase-merge', /a rebase is in progress/],
    ['rebase-apply', /a rebase is in progress/],
  ])('should name an unfinished %s', (name, pattern) => {
    fs.mkdirSync(path.join(home, '.git', name));

    expect(updateBlocker({ home })).toMatch(pattern);
  });
});

describe('mergeEnv', () => {
  beforeEach(() => {
    initRepo({ home, version: '0.1.0', env });
  });

  test('should keep the environment when the repo has a user.email', () => {
    git(['config', 'user.email', 'me@example.com']);

    expect(mergeEnv({ home, env })).toBe(env);
  });

  test('should add the kyoten identity when no user.email is set', () => {
    const merged = mergeEnv({ home, env });

    expect(merged).toMatchObject(KYOTEN_IDENTITY);
    expect(merged.HOME).toBe(env.HOME);
  });

  test('should add the kyoten identity when user.email is blank', () => {
    git(['config', 'user.email', ' ']);

    expect(mergeEnv({ home, env })).toMatchObject(KYOTEN_IDENTITY);
  });
});

describe('checkNode', () => {
  test('should accept a new enough Node.js', () => {
    expect(() =>
      checkNode({ versions: /** @type {any} */ ({ node: '99.0.0' }) })
    ).not.toThrow();
  });

  test('should throw with a Fix line for an old Node.js', () => {
    expect(() =>
      checkNode({ versions: /** @type {any} */ ({ node: '10.1.0' }) })
    ).toThrow(/needs Node\.js \d+ or newer \(this is 10\.1\.0\)\.\nFix: /);
  });

  test('should read process.versions by default', () => {
    expect(() => checkNode()).not.toThrow();
  });
});

describe('checkTool', () => {
  test('should return the trimmed version line', () => {
    const run = vi.fn(() => ({ status: 0, stdout: 'git version 2.4\n' }));

    expect(checkTool({ run: /** @type {any} */ (run), bin: 'git' })).toBe(
      'git version 2.4'
    );
    expect(run).toHaveBeenCalledWith('git', ['--version'], {
      encoding: 'utf-8',
    });
  });

  test('should throw with the fix when the tool exits non-zero', () => {
    const run = () => ({ status: 1, stdout: '' });

    expect(() =>
      checkTool({ run: /** @type {any} */ (run), bin: 'pnpm' })
    ).toThrow(`pnpm was not found.\nFix: ${TOOL_FIXES.pnpm}`);
  });

  test('should throw with the fix when the tool cannot be spawned', () => {
    const run = () => ({ error: new Error('ENOENT'), status: null });

    expect(() =>
      checkTool({ run: /** @type {any} */ (run), bin: 'git' })
    ).toThrow(`git was not found.\nFix: ${TOOL_FIXES.git}`);
  });

  test('should run the real tool by default', () => {
    expect(checkTool({ bin: 'git' })).toMatch(/git version/);
  });
});

describe('compareVersions', () => {
  test.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.2.3', '1.2.4', -1],
    ['2.0.0', '1.9.9', 1],
    ['1.10.0', '1.9.0', 1],
    ['1.0.0-beta.1', '1.0.0', 0],
    ['1.0.1-rc.1', '1.0.0', 1],
    ['1.2', '1.2.0', 0],
    ['1', '1.0.1', -1],
    ['1.2.3', '1.2', 1],
    ['x.y.z', '0.0.0', 0],
  ])('should compare %s with %s as %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
