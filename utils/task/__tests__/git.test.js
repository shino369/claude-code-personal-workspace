import { vi } from 'vitest';
import { formatGit, gitInfo } from '../git.js';

/**
 * @param {Record<string, { status: number | null, stdout?: string | null }>} byCommand
 */
function fakeSpawn(byCommand) {
  return vi.fn((_cmd, /** @type {string[]} */ args) => {
    const result = byCommand[args[0]];
    if (!result) throw new Error('spawn failed');
    return result;
  });
}

describe('gitInfo', () => {
  test('should report branch, changed count, and diff stat', () => {
    const spawn = fakeSpawn({
      branch: { status: 0, stdout: 'feat/x\n' },
      status: { status: 0, stdout: ' M a\n?? b\n' },
      diff: { status: 0, stdout: ' 1 file changed\n' },
    });
    expect(gitInfo('/repo', spawn)).toEqual({
      branch: 'feat/x',
      changed: 2,
      diffStat: '1 file changed',
    });
    expect(spawn).toHaveBeenCalledWith(
      'git',
      ['branch', '--show-current'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  test('should report nulls outside a repository', () => {
    const spawn = fakeSpawn({
      branch: { status: 128 },
      status: { status: 128 },
    });
    expect(gitInfo('/x', spawn)).toEqual({
      branch: null,
      changed: null,
      diffStat: null,
    });
  });

  test('should treat empty or missing output as empty', () => {
    const spawn = fakeSpawn({
      branch: { status: 0, stdout: '' },
      status: { status: 0, stdout: null },
      diff: { status: 0, stdout: '' },
    });
    expect(gitInfo('/x', spawn)).toEqual({
      branch: null,
      changed: 0,
      diffStat: null,
    });
  });

  test('should use the real git by default', () => {
    expect(gitInfo(process.cwd()).changed).not.toBeUndefined();
  });
});

describe('formatGit', () => {
  test('should describe a non-repository', () => {
    expect(formatGit({ branch: null, changed: null, diffStat: null })).toBe(
      'not a git repo'
    );
  });

  test.each([
    [{ branch: 'main', changed: 0 }, 'branch main; uncommitted no'],
    [{ branch: 'main', changed: 1 }, 'branch main; uncommitted yes (1 file)'],
    [
      { branch: null, changed: 3 },
      'branch (detached); uncommitted yes (3 files)',
    ],
    [{ branch: 'main', changed: null }, 'branch main; uncommitted unknown'],
  ])('should format %j', (info, expected) => {
    expect(formatGit({ diffStat: null, ...info })).toBe(expected);
  });
});
