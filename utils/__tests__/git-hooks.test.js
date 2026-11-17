import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  COMMIT_TYPES,
  filterByExtension,
  getStagedFiles,
  main,
  resolveBin,
  runCommitMsg,
  runPreCommit,
  validateCommitMessage,
} from '../git-hooks.js';

/** @type {string[]} */
let tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

/**
 * @param {string} content
 * @returns {Promise<string>}
 */
async function writeMessage(content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'git-hooks-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'COMMIT_EDITMSG');
  await writeFile(file, content);
  return file;
}

/**
 * Build a fake spawn. `staged` is the git diff output; `statuses` maps the
 * resolved bin basename (prettier/eslint, see `fakeResolve`) to an exit status.
 *
 * @param {{ staged?: string[], gitStatus?: number | null, stdout?: string | null, statuses?: Record<string, number | null> }} [options]
 */
function makeSpawn({ staged = [], gitStatus = 0, stdout, statuses = {} } = {}) {
  /** @type {Array<{ command: string, args: string[], options: any }>} */
  const calls = [];
  const spawn = (
    /** @type {string} */ command,
    /** @type {string[]} */ args,
    /** @type {any} */ options
  ) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      return {
        status: gitStatus,
        stdout: stdout === undefined ? staged.join('\0') + '\0' : stdout,
      };
    }
    return { status: statuses[path.basename(args[0])] ?? 0 };
  };
  return { calls, spawn };
}

/** Fake bin resolver: `/fake/bin/<pkg>`. */
const fakeResolve = (/** @type {string} */ pkgName) =>
  path.join('/fake/bin', pkgName);

const fakeNode = '/fake/node';

function makeLog() {
  /** @type {string[]} */
  const lines = [];
  return { lines, log: (/** @type {string} */ line) => lines.push(line) };
}

/**
 * Validate a message that must fail and return the typed failure.
 *
 * @param {string} message
 */
function fail(message) {
  const result = validateCommitMessage(message);
  if (result.ok) throw new Error(`Expected "${message}" to fail validation`);
  return result;
}

describe('validateCommitMessage', () => {
  test.each(COMMIT_TYPES)('accepts type %s', (type) => {
    expect(validateCommitMessage(`${type}: do the thing`)).toEqual({
      ok: true,
    });
  });

  test('accepts scope, breaking marker, body, and comments', () => {
    expect(
      validateCommitMessage(
        '# Please enter the commit message\n\nfeat(hooks)!: add context monitor  \n\nWhy it matters.\n'
      )
    ).toEqual({ ok: true });
  });

  test('accepts a description starting with a digit', () => {
    expect(validateCommitMessage('chore(deps): 2 bumps')).toEqual({
      ok: true,
    });
  });

  test.each([
    'Merge branch x',
    'Revert "feat: x"',
    'fixup! a',
    'squash! a',
    'amend! a',
  ])('skips validation for %s', (message) => {
    expect(validateCommitMessage(message)).toEqual({ ok: true });
  });

  test('rejects an empty message', () => {
    const result = fail('# only comments\n\n');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Commit message is empty.');
    expect(result.hint).toContain('fix(hooks): handle missing transcript');
  });

  test('rejects a non-conventional header', () => {
    const result = fail('Added feature.');
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      'Commit header "Added feature." is not in Conventional Commits format.'
    );
  });

  test('rejects an unknown type', () => {
    const result = fail('feature: add thing');
    expect(result.error).toContain('Unknown commit type "feature"');
  });

  test('rejects an invalid scope', () => {
    expect(fail('fix(Hooks): x').error).toContain('Invalid scope "Hooks"');
    expect(fail('fix(): x').error).toContain('Invalid scope ""');
  });

  test('rejects a header with no description', () => {
    expect(fail('fix: ').error).toBe(
      'Commit header "fix:" is not in Conventional Commits format.'
    );
  });

  test('rejects an uppercase description with a corrected example', () => {
    const scoped = fail('fix(hooks): Handle it');
    expect(scoped.error).toContain('lowercase');
    expect(scoped.hint).toBe('e.g. "fix(hooks): handle it"');
    expect(fail('fix: Handle it').hint).toBe('e.g. "fix: handle it"');
  });

  test('rejects a trailing period with a corrected example', () => {
    expect(fail('docs(docs): explain it.').hint).toBe(
      'e.g. "docs(docs): explain it"'
    );
    expect(fail('docs: explain it...').hint).toBe('e.g. "docs: explain it"');
  });

  test('rejects a description over 50 characters', () => {
    const result = fail(`feat: ${'a'.repeat(51)}`);
    expect(result.error).toBe('Description is 51 characters; the limit is 50.');
    expect(validateCommitMessage(`feat: ${'a'.repeat(50)}`).ok).toBe(true);
  });
});

describe('resolveBin', () => {
  test('resolves a string bin relative to the package directory', () => {
    const resolve = (/** @type {string} */ request) => {
      expect(request).toBe('prettier/package.json');
      return path.join('/nm', 'prettier', 'package.json');
    };
    const readJson = () => ({ bin: './bin/prettier.cjs' });
    expect(resolveBin('prettier', { resolve, readJson })).toBe(
      path.join('/nm', 'prettier', 'bin', 'prettier.cjs')
    );
  });

  test('resolves an object bin keyed by the package name', () => {
    const resolve = () => path.join('/nm', 'eslint', 'package.json');
    const readJson = () => ({ bin: { eslint: './bin/eslint.js' } });
    expect(resolveBin('eslint', { resolve, readJson })).toBe(
      path.join('/nm', 'eslint', 'bin', 'eslint.js')
    );
  });

  test.each([[{}], [{ bin: { other: './x.js' } }], [{ bin: '' }], [null]])(
    'throws when the manifest has no usable bin (%j)',
    (manifest) => {
      const resolve = () => '/nm/pkg/package.json';
      expect(() =>
        resolveBin('pkg', { resolve, readJson: () => manifest })
      ).toThrow('pkg has no "bin" entry in its package.json');
    }
  );

  test('resolves the real installed prettier and eslint by default', () => {
    expect(resolveBin('prettier')).toMatch(/prettier/);
    expect(resolveBin('eslint')).toMatch(/eslint/);
  });

  test('propagates resolution errors for missing packages', () => {
    expect(() => resolveBin('definitely-not-installed-pkg-xyz')).toThrow();
  });
});

describe('getStagedFiles', () => {
  test('parses NUL-separated output without a shell', () => {
    const { calls, spawn } = makeSpawn({ staged: ['a.js', 'dir/b c.md'] });
    expect(getStagedFiles(spawn)).toEqual(['a.js', 'dir/b c.md']);
    expect(calls[0].args).toEqual([
      'diff',
      '--cached',
      '--name-only',
      '--diff-filter=ACMR',
      '-z',
    ]);
    expect(calls[0].options.shell).toBe(false);
  });

  test('treats missing stdout as no files', () => {
    const { spawn } = makeSpawn({ stdout: null });
    expect(getStagedFiles(spawn)).toEqual([]);
  });

  test('throws when git fails', () => {
    const { spawn } = makeSpawn({ gitStatus: 128 });
    expect(() => getStagedFiles(spawn)).toThrow('Could not list staged files');
  });
});

describe('filterByExtension', () => {
  test('matches extensions case-insensitively', () => {
    expect(
      filterByExtension(['A.JS', 'b.png', 'c.md'], ['.js', '.md'])
    ).toEqual(['A.JS', 'c.md']);
  });
});

describe('runPreCommit', () => {
  const deps = { execPath: fakeNode, resolveBinPath: fakeResolve };

  test('exits quietly when no formattable files are staged', () => {
    const { calls, spawn } = makeSpawn({ staged: ['image.png'] });
    const { lines, log } = makeLog();
    expect(runPreCommit({ spawn, log, ...deps })).toBe(0);
    expect(calls).toHaveLength(1);
    expect(lines).toEqual([]);
  });

  test('runs prettier and eslint through node with argument arrays', () => {
    const { calls, spawn } = makeSpawn({
      staged: ['a.js', 'README.md', 'x.png'],
    });
    const { lines, log } = makeLog();
    expect(runPreCommit({ spawn, log, ...deps })).toBe(0);
    expect(calls[1]).toEqual({
      command: fakeNode,
      args: [
        fakeResolve('prettier'),
        '--check',
        '--ignore-unknown',
        'a.js',
        'README.md',
      ],
      options: { stdio: 'inherit', shell: false },
    });
    expect(calls[2]).toEqual({
      command: fakeNode,
      args: [fakeResolve('eslint'), '--no-warn-ignored', 'a.js'],
      options: { stdio: 'inherit', shell: false },
    });
    expect(lines).toEqual([]);
  });

  test('skips eslint (and its resolution) when no lintable files are staged', () => {
    const { calls, spawn } = makeSpawn({ staged: ['README.md'] });
    /** @type {string[]} */
    const resolved = [];
    const resolveBinPath = (/** @type {string} */ pkgName) => {
      resolved.push(pkgName);
      return fakeResolve(pkgName);
    };
    expect(
      runPreCommit({ spawn, log: () => {}, execPath: fakeNode, resolveBinPath })
    ).toBe(0);
    expect(calls).toHaveLength(2);
    expect(resolved).toEqual(['prettier']);
  });

  test('tells the user to install dependencies when a tool is missing', () => {
    const { calls, spawn } = makeSpawn({ staged: ['a.js'] });
    const { lines, log } = makeLog();
    const resolveBinPath = (/** @type {string} */ pkgName) => {
      if (pkgName === 'eslint') throw new Error('Cannot find module');
      return fakeResolve(pkgName);
    };
    expect(
      runPreCommit({ spawn, log, execPath: fakeNode, resolveBinPath })
    ).toBe(1);
    expect(lines).toEqual(['✗ Could not find eslint. Fix: pnpm install']);
    expect(calls).toHaveLength(1);
  });

  test('reports the prettier fix command', () => {
    const { spawn } = makeSpawn({
      staged: ['a b.md'],
      statuses: { prettier: 1 },
    });
    const { lines, log } = makeLog();
    expect(runPreCommit({ spawn, log, ...deps })).toBe(1);
    expect(lines).toContain(
      'Fix: pnpm exec prettier --write "a b.md" && git add "a b.md"'
    );
    expect(lines.at(-1)).toContain('git commit --no-verify');
  });

  test('reports the eslint fix command', () => {
    const { spawn } = makeSpawn({
      staged: ['a.ts'],
      statuses: { eslint: 1 },
    });
    const { lines, log } = makeLog();
    expect(runPreCommit({ spawn, log, ...deps })).toBe(1);
    expect(lines).toContain('✗ ESLint: staged files have lint errors.');
    expect(lines).toContain(
      'Fix: pnpm exec eslint --fix "a.ts", fix the rest by hand, then git add "a.ts"'
    );
  });

  test('defaults to process.execPath and the real bin resolver', () => {
    const { calls, spawn } = makeSpawn({ staged: ['a.js'] });
    expect(runPreCommit({ spawn, log: () => {} })).toBe(0);
    expect(calls[1].command).toBe(process.execPath);
    expect(calls[1].args[0]).toBe(resolveBin('prettier'));
    expect(calls[2].args[0]).toBe(resolveBin('eslint'));
  });

  test('uses the default logger', () => {
    const { spawn } = makeSpawn();
    expect(runPreCommit({ spawn })).toBe(0);
  });
});

describe('runCommitMsg', () => {
  test('accepts a valid message file', async () => {
    const file = await writeMessage('fix(hooks): handle missing transcript\n');
    expect(runCommitMsg(file, { log: () => {} })).toBe(0);
  });

  test('prints the error, hint, and escape hatch for an invalid message', async () => {
    const file = await writeMessage('Added feature.\n');
    const { lines, log } = makeLog();
    expect(runCommitMsg(file, { log })).toBe(1);
    expect(lines).toEqual([
      '✗ Commit header "Added feature." is not in Conventional Commits format.',
      'Expected "<type>(<scope>): <description>", e.g. "fix(hooks): handle missing transcript"',
      'Rules: AGENTS.md → Git conventions.',
      'Humans only, in an emergency: git commit --no-verify skips these checks.',
    ]);
  });

  test('prints the corrected example as the hint', () => {
    const { lines, log } = makeLog();
    const readFile = () => 'fix: Bad';
    expect(runCommitMsg('msg', { readFile, log })).toBe(1);
    expect(lines[1]).toBe('e.g. "fix: bad"');
  });

  test('requires a message path', () => {
    const { lines, log } = makeLog();
    expect(runCommitMsg(undefined, { log })).toBe(2);
    expect(lines[0]).toContain('Usage');
  });

  test('uses the default logger', async () => {
    const file = await writeMessage('feat: ok');
    expect(runCommitMsg(file)).toBe(0);
  });
});

describe('main', () => {
  test('dispatches pre-commit with the injected node and resolver', () => {
    const { calls, spawn } = makeSpawn({ staged: ['a.md'] });
    expect(
      main({
        argv: ['pre-commit'],
        spawn,
        log: () => {},
        execPath: fakeNode,
        resolveBinPath: fakeResolve,
      })
    ).toBe(0);
    expect(calls[1].command).toBe(fakeNode);
    expect(calls[1].args[0]).toBe(fakeResolve('prettier'));
  });

  test('dispatches commit-msg', () => {
    const readFile = () => 'Added feature.';
    expect(main({ argv: ['commit-msg', 'f'], readFile, log: () => {} })).toBe(
      1
    );
  });

  test('prints usage for unknown commands', () => {
    const { lines, log } = makeLog();
    expect(main({ argv: ['nope'], log })).toBe(2);
    expect(lines[0]).toContain('Usage');
  });

  test('defaults argv and log', () => {
    const original = process.argv;
    process.argv = ['node', 'git-hooks.js'];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(main()).toBe(2);
    } finally {
      process.argv = original;
      errorSpy.mockRestore();
    }
  });
});
