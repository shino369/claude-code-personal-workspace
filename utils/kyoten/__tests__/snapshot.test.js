import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import zlib from 'zlib';
import { crossSpawn } from '../../spawn.js';
import { SNAPSHOT_FILE } from '../home.js';
import {
  BUNDLE_FILE,
  capture,
  decodeBundle,
  encodeBundle,
  exportTree,
  listTree,
  materialize,
  readBlobs,
  snapshotSource,
  treeFiles,
  unsafePath,
  writeFiles,
} from '../snapshot.js';

/** @type {string} */
let tmp;
/** @type {string} */
let repo;
/** @type {string} */
let commit;
/** @type {NodeJS.ProcessEnv} */
let gitEnv;

/** @type {import('../../spawn.js').Spawn} */
const run = (bin, args, options = {}) =>
  crossSpawn()(bin, args, { env: gitEnv, ...options });

/**
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [options]
 */
function git(args, { cwd = repo, env = gitEnv, input } = {}) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env, input, encoding: 'utf-8' }
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * A commit holding `base` plus one extra index entry, made without a
 * working tree (so no real symlink or submodule is needed).
 *
 * @param {string} mode
 * @param {string} sha
 * @param {string} name
 */
function commitWithEntry(mode, sha, name) {
  const index = path.join(tmp, `index-${mode}`);
  const env = { ...gitEnv, GIT_INDEX_FILE: index };
  git(['read-tree', commit], { env });
  git(['update-index', '--add', '--cacheinfo', `${mode},${sha},${name}`], {
    env,
  });
  const tree = git(['write-tree'], { env });
  return git(['commit-tree', tree, '-m', 'x']);
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-snapshot-'));
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  repo = path.join(tmp, 'source');
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'bin'));
  fs.writeFileSync(path.join(repo, '.gitignore'), '/.kyoten/\n');
  fs.writeFileSync(path.join(repo, 'sub', '.gitignore'), 'x\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'data.bin'), Buffer.from([0, 10, 255, 10]));
  fs.writeFileSync(path.join(repo, 'bin', 'run.sh'), '#!/bin/sh\n', {
    mode: 0o755,
  });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['update-index', '--chmod=+x', 'bin/run.sh']);
  git(['commit', '-q', '-m', 'init']);
  commit = git(['rev-parse', 'HEAD']);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('capture', () => {
  test('should return stdout when the command succeeds', () => {
    const result = capture(() => ({ status: 0, stdout: 'out' }), 'x', []);

    expect(result).toBe('out');
  });

  test('should return an empty string when stdout is missing', () => {
    const result = capture(() => ({ status: 0 }), 'x', []);

    expect(result).toBe('');
  });

  test('should throw the stderr when the command fails', () => {
    const fail = () => ({ status: 2, stderr: ' boom \n' });

    expect(() => capture(fail, 'git', ['a', 'b'])).toThrow(
      'git a b failed: boom'
    );
  });

  test('should throw the exit code when the command fails without stderr', () => {
    const fail = () => ({ status: 3 });

    expect(() => capture(fail, 'git', ['a'])).toThrow('git a failed: exit 3');
  });

  test('should rethrow the spawn error', () => {
    const error = new Error('ENOENT');

    expect(() => capture(() => ({ status: null, error }), 'git', [])).toThrow(
      error
    );
  });
});

describe('listTree', () => {
  test('should list regular files with their modes and blob ids', () => {
    const entries = listTree({ repo, ref: commit, run });

    expect(entries.map((e) => e.path)).toEqual([
      '.gitignore',
      'a.txt',
      'bin/run.sh',
      'data.bin',
      'sub/.gitignore',
    ]);
    expect(entries.find((e) => e.path === 'bin/run.sh')?.mode).toBe('100755');
    expect(entries.find((e) => e.path === 'a.txt')?.mode).toBe('100644');
  });

  test('should default to HEAD', () => {
    const entries = listTree({ repo, run });

    expect(entries).toHaveLength(5);
  });

  test('should refuse a symlink', () => {
    const blob = git(['hash-object', '-w', '--stdin'], { input: 'a.txt' });
    const ref = commitWithEntry('120000', blob, 'link');

    expect(() => listTree({ repo, ref, run })).toThrow(
      /link is a symlink in .*regular files only/s
    );
  });

  test('should refuse a submodule', () => {
    const ref = commitWithEntry('160000', commit, 'sub-module');

    expect(() => listTree({ repo, ref, run })).toThrow(
      /sub-module is a commit in/
    );
  });
});

describe('readBlobs', () => {
  test('should return no blobs without calling git for an empty list', () => {
    const spy = () => {
      throw new Error('must not run');
    };

    expect(readBlobs({ repo, shas: [], run: spy })).toEqual([]);
  });

  test('should return the bytes of each blob in order', () => {
    const entries = listTree({ repo, ref: commit, run });
    const shas = entries.map((e) => e.sha);

    const blobs = readBlobs({ repo, shas, run });

    expect(blobs.map((b) => b.length)).toEqual([
      '/.kyoten/\n'.length,
      6,
      '#!/bin/sh\n'.length,
      4,
      2,
    ]);
    expect([...blobs[3]]).toEqual([0, 10, 255, 10]);
  });

  test('should use the default git runner', () => {
    const sha = git(['rev-parse', `${commit}:a.txt`]);

    const blobs = readBlobs({ repo, shas: [sha] });

    expect(blobs[0].toString()).toBe('hello\n');
  });

  test('should throw when git answers with another object', () => {
    const fake = () => ({
      status: 0,
      stdout: Buffer.from('abc blob 3\nfoo\n'),
    });

    expect(() => readBlobs({ repo, shas: ['def'], run: fake })).toThrow(
      'git cat-file returned "abc blob 3" for def'
    );
  });

  test('should throw when git exits non-zero', () => {
    const fake = () => ({ status: 1, stderr: Buffer.from('bad\n') });

    expect(() => readBlobs({ repo, shas: ['def'], run: fake })).toThrow(
      'git cat-file --batch failed: bad'
    );
  });

  test('should throw when git exits non-zero without stderr', () => {
    expect(() =>
      readBlobs({ repo, shas: ['def'], run: () => ({ status: 1 }) })
    ).toThrow('git cat-file --batch failed: ');
  });

  test('should rethrow the spawn error', () => {
    const error = new Error('ENOENT');

    expect(() =>
      readBlobs({ repo, shas: ['def'], run: () => ({ status: null, error }) })
    ).toThrow(error);
  });
});

describe('exportTree', () => {
  test('should write the files of the commit and return their paths', () => {
    const dest = path.join(tmp, 'export-plain');

    const written = exportTree({ repo, dest, ref: commit, run });

    expect(written).toContain('sub/.gitignore');
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf-8')).toBe('hello\n');
    expect([...fs.readFileSync(path.join(dest, 'data.bin'))]).toEqual([
      0, 10, 255, 10,
    ]);
    expect(fs.existsSync(path.join(dest, 'sub', '.gitignore'))).toBe(true);
  });

  test('should default to HEAD and the default runner', () => {
    const dest = path.join(tmp, 'export-head');

    const written = exportTree({ repo, dest });

    expect(written).toHaveLength(5);
  });
});

describe('treeFiles', () => {
  test('should return each file with its mode and bytes', () => {
    const files = treeFiles({ repo, ref: commit, run });

    const script = files.find((f) => f.path === 'bin/run.sh');
    expect(script?.mode).toBe('100755');
    expect(script?.data.toString('utf-8')).toBe('#!/bin/sh\n');
  });
});

describe('unsafePath', () => {
  test.each([
    ['a/b.txt', null],
    ['.gitignore', null],
    ['', 'has a backslash or is empty'],
    ['a\\b', 'has a backslash or is empty'],
    ['a\0b', 'has a backslash or is empty'],
    ['/etc/passwd', 'is absolute'],
    ['C:/x', 'is absolute'],
    ['../x', 'has an empty, . or .. segment'],
    ['a/./b', 'has an empty, . or .. segment'],
    ['a//b', 'has an empty, . or .. segment'],
  ])('should judge %j', (file, expected) => {
    expect(unsafePath(file)).toBe(expected);
  });
});

describe('writeFiles', () => {
  test('should refuse a path outside the destination', () => {
    const dest = path.join(tmp, 'write-unsafe');

    expect(() =>
      writeFiles(
        [{ path: '../escape.txt', mode: '100644', data: Buffer.from('x') }],
        dest
      )
    ).toThrow('refusing to write snapshot path "../escape.txt"');
    expect(fs.existsSync(path.join(tmp, 'escape.txt'))).toBe(false);
  });
});

describe('encodeBundle and decodeBundle', () => {
  test('should round-trip files, modes, and binary content', () => {
    const files = treeFiles({ repo, ref: commit, run });

    const decoded = decodeBundle(encodeBundle(files));

    expect(decoded.map((f) => [f.path, f.mode, [...f.data]])).toEqual(
      files.map((f) => [f.path, f.mode, [...f.data]])
    );
  });

  test('should round-trip an empty snapshot', () => {
    expect(decodeBundle(encodeBundle([]))).toEqual([]);
  });

  /** @param {string} text */
  const gz = (text) => zlib.gzipSync(Buffer.from(text, 'utf-8'));

  test.each([
    ['unknown format', gz('NOT A BUNDLE\n{}\n')],
    ['unreadable index', gz('KYOTEN-BUNDLE 1\n{oops\n')],
    ['no file list', gz('KYOTEN-BUNDLE 1\n{}\n')],
    ['no file list', gz('KYOTEN-BUNDLE 1\nnull\n')],
    [
      'bad entry',
      gz('KYOTEN-BUNDLE 1\n{"files":[{"path":1,"mode":"100644","size":0}]}\n'),
    ],
    [
      'bad entry',
      gz(
        'KYOTEN-BUNDLE 1\n{"files":[{"path":"a","mode":"120000","size":0}]}\n'
      ),
    ],
    [
      'bad entry',
      gz(
        'KYOTEN-BUNDLE 1\n{"files":[{"path":"a","mode":"100644","size":-1}]}\n'
      ),
    ],
    [
      'bad entry',
      gz(
        'KYOTEN-BUNDLE 1\n{"files":[{"path":"a","mode":"100644","size":1.5}]}\n'
      ),
    ],
    [
      'size mismatch',
      gz(
        'KYOTEN-BUNDLE 1\n{"files":[{"path":"a","mode":"100644","size":1}]}\nab'
      ),
    ],
    [
      'size mismatch',
      gz(
        'KYOTEN-BUNDLE 1\n{"files":[{"path":"a","mode":"100644","size":5}]}\nab'
      ),
    ],
  ])('should reject a bundle with %s', (why, bundle) => {
    expect(() => decodeBundle(bundle)).toThrow(
      `the kyoten snapshot bundle is damaged (${why}`
    );
  });
});

describe('snapshotSource', () => {
  test('should describe the package snapshot when the marker exists', () => {
    const root = path.join(tmp, 'pkg-marker');
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, SNAPSHOT_FILE),
      JSON.stringify({ version: '1.2.3', commit: 'abc' })
    );

    const source = snapshotSource({ root, version: 'ignored' });

    expect(source).toEqual({
      kind: 'package',
      bundle: path.join(tmp, BUNDLE_FILE),
      version: '1.2.3',
      commit: 'abc',
    });
  });

  test('should describe HEAD of the clone without a marker', () => {
    const source = snapshotSource({ root: repo, version: '0.9.0', run });

    expect(source).toEqual({
      kind: 'git',
      repo,
      version: '0.9.0',
      commit,
    });
  });

  test('should use the default runner', () => {
    const source = snapshotSource({ root: repo, version: '0.9.0' });

    expect(source.commit).toBe(commit);
  });
});

describe('materialize', () => {
  test('should export a git source from its commit', () => {
    const dest = path.join(tmp, 'mat-git');

    const written = materialize(
      { kind: 'git', repo, version: '1', commit },
      dest,
      { run }
    );

    expect(written).toContain('a.txt');
    expect(fs.existsSync(path.join(dest, '.gitignore'))).toBe(true);
  });

  test('should unpack a package source from its bundle', () => {
    const bundle = path.join(tmp, 'mat.kyoten.gz');
    fs.writeFileSync(
      bundle,
      encodeBundle([
        { path: 'd/x.txt', mode: '100644', data: Buffer.from('x') },
      ])
    );
    const dest = path.join(tmp, 'mat-pkg-dest');

    const written = materialize(
      { kind: 'package', bundle, version: '1', commit: 'c' },
      dest
    );

    expect(written).toEqual(['d/x.txt']);
    expect(fs.readFileSync(path.join(dest, 'd', 'x.txt'), 'utf-8')).toBe('x');
  });
});
