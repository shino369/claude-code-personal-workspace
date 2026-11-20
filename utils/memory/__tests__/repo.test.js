/**
 * Tests for utils/memory/repo.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { findGitDirs, nameFromUrl, originUrl, repoName } from '../repo.js';

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memory-repo-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A checkout at `tmp/<name>` with a .git folder and an optional config.
 *
 * @param {string} name
 * @param {string | null} [config]
 */
function checkout(name, config = null) {
  const top = path.join(tmp, name);
  fs.mkdirSync(path.join(top, '.git'), { recursive: true });
  if (config !== null)
    fs.writeFileSync(path.join(top, '.git', 'config'), config);
  return top;
}

const ORIGIN = (/** @type {string} */ url) =>
  `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/fork.git\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n`;

describe('nameFromUrl', () => {
  test.each([
    ['git@github.com:me/web.git', 'web'],
    ['https://github.com/me/web.git', 'web'],
    ['https://github.com/me/web', 'web'],
    ['https://github.com/me/web/', 'web'],
    ['ssh://git@host:22/team/api.git', 'api'],
    ['/srv/git/tools.git', 'tools'],
    ['C:\\repos\\notes.git', 'notes'],
  ])('should name %s as %s', (url, name) => {
    expect(nameFromUrl(url)).toBe(name);
  });

  test('should return null when the url has no name', () => {
    expect(nameFromUrl('.git')).toBeNull();
  });
});

describe('originUrl', () => {
  test('should read the url of the origin remote only', () => {
    expect(originUrl(ORIGIN('git@github.com:me/web.git'))).toBe(
      'git@github.com:me/web.git'
    );
  });

  test('should return null without an origin remote', () => {
    expect(
      originUrl('[remote "upstream"]\n\turl = git@github.com:o/x.git\n')
    ).toBeNull();
  });

  test('should return null when origin has no url', () => {
    expect(originUrl('[remote "origin"]\n\tfetch = x\n[core]\n')).toBeNull();
  });

  test('should accept a url line without spaces around =', () => {
    expect(originUrl('[remote "origin"]\nurl=https://h/x/y.git')).toBe(
      'https://h/x/y.git'
    );
  });
});

describe('findGitDirs', () => {
  test('should find the checkout from a folder inside it', () => {
    const top = checkout('web');
    const inner = path.join(top, 'src', 'lib');
    fs.mkdirSync(inner, { recursive: true });

    expect(findGitDirs(inner)).toEqual({
      top,
      gitDir: path.join(top, '.git'),
      commonDir: path.join(top, '.git'),
    });
  });

  test('should follow a worktree .git file to the main checkout', () => {
    const main = checkout('web');
    const wtGit = path.join(main, '.git', 'worktrees', 'feature');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'web-wt', 'feature');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);

    expect(findGitDirs(wt)).toEqual({
      top: wt,
      gitDir: wtGit,
      commonDir: path.join(main, '.git'),
    });
  });

  test('should resolve a relative gitdir from the .git file folder', () => {
    const main = checkout('lib');
    const sub = path.join(main, 'vendor', 'dep');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(main, '.git', 'modules', 'dep'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sub, '.git'),
      'gitdir: ../../.git/modules/dep\n'
    );

    expect(findGitDirs(sub)?.gitDir).toBe(
      path.join(main, '.git', 'modules', 'dep')
    );
  });

  test('should skip a .git file that is not a gitdir pointer', () => {
    const outer = checkout('outer');
    const inner = path.join(outer, 'odd');
    fs.mkdirSync(inner);
    fs.writeFileSync(path.join(inner, '.git'), 'not a pointer\n');

    expect(findGitDirs(inner)?.top).toBe(outer);
  });

  test('should return null outside any repository', () => {
    const bare = path.join(tmp, 'plain');
    fs.mkdirSync(bare);

    expect(findGitDirs(bare)).toBeNull();
  });
});

describe('repoName', () => {
  test('should use the origin remote name', () => {
    const top = checkout('local-folder', ORIGIN('git@github.com:me/web.git'));

    expect(repoName(top)).toBe('web');
  });

  test('should fall back to the checkout folder without an origin', () => {
    const top = checkout('scratch', '[core]\n\tbare = false\n');

    expect(repoName(path.join(top))).toBe('scratch');
  });

  test('should fall back to the folder when origin has no usable name', () => {
    const top = checkout('scratch', ORIGIN('.git'));

    expect(repoName(top)).toBe('scratch');
  });

  test('should name a worktree after its main checkout', () => {
    const main = checkout('web');
    const wtGit = path.join(main, '.git', 'worktrees', 'feature');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(tmp, 'web-wt', 'feature');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);

    expect(repoName(wt)).toBe('web');
  });

  test('should use the top folder when the common dir is not named .git', () => {
    const top = path.join(tmp, 'sub');
    fs.mkdirSync(path.join(tmp, 'store', 'modules', 'sub'), {
      recursive: true,
    });
    fs.mkdirSync(top);
    fs.writeFileSync(path.join(top, '.git'), 'gitdir: ../store/modules/sub');

    expect(repoName(top)).toBe('sub');
  });

  test('should return null outside any repository', () => {
    expect(repoName(tmp)).toBeNull();
  });
});
