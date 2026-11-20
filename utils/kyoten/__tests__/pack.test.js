import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import zlib from 'zlib';
import { vi } from 'vitest';
import { crossSpawn } from '../../spawn.js';
import { SNAPSHOT_FILE } from '../home.js';
import {
  BIN_SOURCE,
  checkTarball,
  denied,
  isRuntimeFile,
  listTarball,
  main,
  MAX_TARBALL_BYTES,
  pack,
  packageManifest,
  stage,
} from '../pack.js';
import { BUNDLE_FILE, decodeBundle } from '../snapshot.js';

const PKG = {
  name: 'kyoten',
  version: '0.3.0',
  description: 'd',
  author: 'a',
  license: 'ISC',
  repository: { type: 'git', url: 'u' },
};

/** @type {string} */
let tmp;
/** @type {string} */
let repo;
/** @type {NodeJS.ProcessEnv} */
let gitEnv;
/** @type {{ drop?: string, extra?: string, fail?: boolean, pax?: boolean }} */
let fake = {};
let counter = 0;

/**
 * @param {string} header
 * @param {number} at
 * @param {number} width
 * @param {Buffer} block
 */
const put = (header, at, width, block) =>
  block.write(header.slice(0, width), at, 'utf-8');

/**
 * One tar entry: a header block plus the body padded to 512 bytes.
 *
 * @param {{ name: string, data?: Buffer, type?: string, prefix?: string }} entry
 */
function tarEntry({ name, data = Buffer.alloc(0), type = '0', prefix = '' }) {
  const block = Buffer.alloc(512);
  put(name, 0, 100, block);
  put('0000644\0', 100, 8, block);
  put('0000000\0', 108, 8, block);
  put('0000000\0', 116, 8, block);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, block);
  put('00000000000\0', 136, 12, block);
  put('        ', 148, 8, block);
  put(type, 156, 1, block);
  put('ustar\0', 257, 6, block);
  put('00', 263, 2, block);
  put(prefix, 345, 155, block);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, block);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return Buffer.concat([block, data, pad]);
}

/**
 * A gzipped tar. `pax: true` writes the name as a PAX `path=` record.
 *
 * @param {{ name: string, data?: Buffer, type?: string, prefix?: string, pax?: boolean }[]} entries
 */
function makeTgz(entries) {
  const parts = entries.flatMap(({ pax, ...entry }) => {
    if (!pax) return [tarEntry(entry)];
    const body = `path=${entry.name}\n`;
    const record = `${String(body.length + 4)} ${body}`;
    return [
      tarEntry({
        name: 'PaxHeader',
        type: 'x',
        data: Buffer.from(record),
      }),
      tarEntry({ ...entry, name: entry.name.slice(0, 100) }),
    ];
  });
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

/** @param {string} dir @returns {string[]} */
function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

/** @type {import('../../spawn.js').Spawn} */
const run = (bin, args, options = {}) => {
  if (bin !== 'pnpm')
    return crossSpawn()(bin, args, { env: gitEnv, ...options });
  if (fake.fail) return { status: 1, stderr: 'pack exploded' };
  const staging = String(/** @type {{ cwd?: string }} */ (options).cwd);
  const out = args[2];
  const version = JSON.parse(
    fs.readFileSync(path.join(staging, 'package.json'), 'utf-8')
  ).version;
  const files = walk(staging)
    .map((rel) => rel.split(path.sep).join('/'))
    .filter((rel) => rel !== fake.drop);
  const entries = files.map((rel) => ({
    name: `package/${rel}`,
    data: fs.readFileSync(path.join(staging, ...rel.split('/'))),
    pax: fake.pax,
  }));
  if (fake.extra)
    entries.push({
      name: `package/${fake.extra}`,
      data: Buffer.from('x'),
      pax: false,
    });
  fs.writeFileSync(path.join(out, `kyoten-${version}.tgz`), makeTgz(entries));
  return { status: 0, stdout: '' };
};

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env: gitEnv, encoding: 'utf-8' }
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/**
 * @param {Record<string, string>} files
 * @returns {string}  the repository directory
 */
function makeRepo(files) {
  counter += 1;
  const dir = path.join(tmp, `repo-${counter}`);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(['init', '-q'], dir);
  git(['add', '-A', '-f'], dir);
  git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

const BASE = {
  'package.json': JSON.stringify(PKG),
  'docs/kyoten.md': '# kyoten\n',
  LICENSE: 'license\n',
  'utils/kyoten/cli.js': 'export const main = () => 0;\n',
  'utils/x/__tests__/x.test.js': 'test\n',
  'sub/.gitignore': 'x\n',
  'pnpm-lock.yaml': 'lock\n',
};

const EXPECTED = [
  'package.json',
  'README.md',
  'LICENSE',
  'bin/kyoten.js',
  BUNDLE_FILE,
  'runtime/package.json',
  'runtime/utils/kyoten/cli.js',
  `runtime/${SNAPSHOT_FILE}`,
];

/** @param {string} dir */
const leftovers = (dir) =>
  fs.readdirSync(dir).filter((name) => name.startsWith('.kyoten-pack-'));

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-pack-'));
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  repo = makeRepo(BASE);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fake = {};
});

describe('denied', () => {
  test.each([
    'tasks/x',
    'memory/x',
    'logs/x',
    'node_modules/x',
    'a/node_modules/b',
    'AGENTS.local.md',
    'CLAUDE.local.md',
    'tools/local.json',
    '.claude/settings.local.json',
    '.mcp.json',
    '.env',
    '.env.local',
    'sub/.env.production',
    'x.pem',
    'x.key',
    'credentials.json',
    'a/secrets/b',
  ])('should deny %s', (file) => {
    expect(denied(file)).toBe(true);
  });

  test.each([
    '.env.example',
    'utils/kyoten/dscc.env.example',
    'utils/memory/cli.js',
    '.mcp.json.example',
    'docs/x.md',
  ])('should allow %s', (file) => {
    expect(denied(file)).toBe(false);
  });
});

describe('isRuntimeFile', () => {
  test.each([
    ['package.json', true],
    ['utils/kyoten/cli.js', true],
    ['utils/x/__tests__/x.test.js', false],
    ['docs/kyoten.md', false],
    ['pnpm-lock.yaml', false],
  ])('should classify %s as %s', (file, expected) => {
    expect(isRuntimeFile(file)).toBe(expected);
  });
});

describe('listTarball', () => {
  test('should list plain regular files', () => {
    const tgz = makeTgz([
      { name: 'package/a.txt', data: Buffer.from('hi') },
      { name: 'package/b.txt', data: Buffer.alloc(600, 1) },
    ]);

    expect(listTarball(tgz)).toEqual(['package/a.txt', 'package/b.txt']);
  });

  test('should join the ustar prefix and the name', () => {
    const tgz = makeTgz([{ name: 'f.txt', prefix: 'package/deep/dir' }]);

    expect(listTarball(tgz)).toEqual(['package/deep/dir/f.txt']);
  });

  test('should use the PAX path for a long name', () => {
    const long = `package/${'d/'.repeat(80)}f.txt`;
    const tgz = makeTgz([
      { name: long, pax: true },
      { name: 'package/after.txt' },
    ]);

    expect(listTarball(tgz)).toEqual([long, 'package/after.txt']);
  });

  test('should skip directories and other non-file types', () => {
    const tgz = makeTgz([
      { name: 'package/dir/', type: '5' },
      { name: 'package/link', type: '2' },
      { name: 'package/f.txt' },
    ]);

    expect(listTarball(tgz)).toEqual(['package/f.txt']);
  });

  test('should forget a PAX path that precedes a non-file entry', () => {
    const tgz = makeTgz([
      { name: 'package/dir/', type: '5', pax: true },
      { name: 'package/f.txt' },
    ]);

    expect(listTarball(tgz)).toEqual(['package/f.txt']);
  });

  test('should fall back to the header name when the PAX record has no path', () => {
    const tar = Buffer.concat([
      tarEntry({
        name: 'PaxHeader',
        type: 'x',
        data: Buffer.from('13 mtime=1\n\n'),
      }),
      tarEntry({ name: 'package/f.txt' }),
      Buffer.alloc(1024),
    ]);

    expect(listTarball(zlib.gzipSync(tar))).toEqual(['package/f.txt']);
  });

  test('should treat an empty size field as zero and an empty type as a file', () => {
    const block = tarEntry({ name: 'package/f.txt' });
    block.fill(0, 124, 136);
    block.fill(0, 156, 157);
    const tar = Buffer.concat([block, Buffer.alloc(1024)]);

    expect(listTarball(zlib.gzipSync(tar))).toEqual(['package/f.txt']);
  });

  test('should stop at the end of a truncated archive', () => {
    const tar = tarEntry({ name: 'package/f.txt' });

    expect(listTarball(zlib.gzipSync(tar))).toEqual(['package/f.txt']);
  });
});

describe('checkTarball', () => {
  const expected = ['a', 'b'];

  test('should return no problems when the tarball is right', () => {
    const problems = checkTarball({
      entries: ['package/a', 'package/b'],
      expected,
      size: 10,
    });

    expect(problems).toEqual([]);
  });

  test('should report a missing file', () => {
    const problems = checkTarball({
      entries: ['package/a'],
      expected,
      size: 10,
    });

    expect(problems).toEqual(['missing from the tarball: b']);
  });

  test('should report an unexpected file', () => {
    const problems = checkTarball({
      entries: ['package/a', 'package/b', 'package/c'],
      expected,
      size: 10,
    });

    expect(problems).toEqual(['not expected in the tarball: c']);
  });

  test('should report a denied file', () => {
    const problems = checkTarball({
      entries: ['package/a', 'package/b', 'package/.env'],
      expected,
      size: 10,
    });

    expect(problems).toContain('on the deny list: .env');
  });

  test('should report a tarball over the cap', () => {
    const problems = checkTarball({
      entries: ['package/a', 'package/b'],
      expected,
      size: 11,
      max: 10,
    });

    expect(problems).toEqual(['the tarball is 11 bytes, over the 10-byte cap']);
  });

  test('should use the default cap', () => {
    const problems = checkTarball({
      entries: ['a', 'b'],
      expected,
      size: MAX_TARBALL_BYTES + 1,
    });

    expect(problems).toHaveLength(1);
  });
});

describe('packageManifest', () => {
  test('should take the metadata from HEAD package.json', () => {
    const manifest = packageManifest(PKG);

    expect(manifest).toMatchObject({
      name: 'kyoten',
      version: '0.3.0',
      description: 'd',
      author: 'a',
      license: 'ISC',
      repository: PKG.repository,
      bin: { kyoten: 'bin/kyoten.js' },
      files: ['bin', 'runtime', BUNDLE_FILE],
    });
  });
});

describe('stage', () => {
  /** @param {Record<string, string>} files */
  const filesOf = (files) =>
    Object.entries(files).map(([p, data]) => ({
      path: p,
      mode: '100644',
      data: Buffer.from(data),
    }));

  /** @type {string} */
  let staging;
  beforeEach(() => {
    staging = fs.mkdtempSync(path.join(tmp, 'stage-'));
  });

  test('should write the expected package layout', () => {
    const result = stage({
      files: filesOf(BASE),
      commit: 'abcdef1234',
      staging,
    });

    expect(result.version).toBe('0.3.0');
    expect(result.expected.sort()).toEqual([...EXPECTED].sort());
    expect(
      walk(staging)
        .map((f) => f.split(path.sep).join('/'))
        .sort()
    ).toEqual([...EXPECTED].sort());
  });

  test('should use docs/kyoten.md as README and the bin source as the launcher', () => {
    stage({ files: filesOf(BASE), commit: 'abcdef1234', staging });

    expect(fs.readFileSync(path.join(staging, 'README.md'), 'utf-8')).toBe(
      '# kyoten\n'
    );
    expect(
      fs.readFileSync(path.join(staging, 'bin', 'kyoten.js'), 'utf-8')
    ).toBe(BIN_SOURCE);
  });

  test('should write the version and commit into the runtime marker', () => {
    stage({ files: filesOf(BASE), commit: 'abcdef1234', staging });

    const marker = JSON.parse(
      fs.readFileSync(path.join(staging, 'runtime', SNAPSHOT_FILE), 'utf-8')
    );
    expect(marker).toEqual({ version: '0.3.0', commit: 'abcdef1234' });
  });

  test('should bundle every file but leave tests out of runtime', () => {
    stage({ files: filesOf(BASE), commit: 'abcdef1234', staging });

    const bundle = decodeBundle(
      fs.readFileSync(path.join(staging, BUNDLE_FILE))
    );
    expect(bundle.map((f) => f.path).sort()).toEqual(Object.keys(BASE).sort());
    expect(
      fs.existsSync(path.join(staging, 'runtime', 'utils', 'x', '__tests__'))
    ).toBe(false);
  });

  test('should throw with a Fix line when docs/kyoten.md is missing', () => {
    const { 'docs/kyoten.md': _omit, ...rest } = BASE;

    expect(() =>
      stage({ files: filesOf(rest), commit: 'abcdef1234', staging })
    ).toThrow(/docs\/kyoten\.md is not in the commit abcdef1\.\nFix: /);
  });

  test('should throw with a Fix line when LICENSE is missing', () => {
    const { LICENSE: _omit, ...rest } = BASE;

    expect(() =>
      stage({ files: filesOf(rest), commit: 'abcdef1234', staging })
    ).toThrow(/LICENSE is not in the commit.*\nFix: /s);
  });

  test('should throw when the commit holds a denied file', () => {
    const files = filesOf({ ...BASE, '.env': 'SECRET=1\n' });

    expect(() => stage({ files, commit: 'abcdef1234', staging })).toThrow(
      /must never ship: \.env\.\nFix: /
    );
  });
});

describe('pack', () => {
  test('should pack HEAD and remove the staging directory', () => {
    const out = path.join(tmp, 'out-happy');
    const log = vi.fn();

    const result = pack({ root: repo, out, run, log });

    expect(result.version).toBe('0.3.0');
    expect(result.tarball).toBe(path.join(out, 'kyoten-0.3.0.tgz'));
    expect(result.commit).toBe(git(['rev-parse', 'HEAD'], repo));
    expect(result.files).toBe(Object.keys(BASE).length);
    expect(result.size).toBe(fs.statSync(result.tarball).size);
    expect(leftovers(out)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  test('should list the bundle in the tarball', () => {
    const out = path.join(tmp, 'out-bundle');
    const { tarball } = pack({ root: repo, out, run, log: vi.fn() });

    const names = listTarball(fs.readFileSync(tarball));

    expect(names.sort()).toEqual(EXPECTED.map((f) => `package/${f}`).sort());
  });

  test('should accept PAX long names in the tarball', () => {
    fake = { pax: true };
    const out = path.join(tmp, 'out-pax');

    const result = pack({ root: repo, out, run, log: vi.fn() });

    expect(result.version).toBe('0.3.0');
  });

  test('should log uncommitted changes and leave them out', () => {
    const dirtyRepo = makeRepo(BASE);
    fs.writeFileSync(path.join(dirtyRepo, 'new.txt'), 'new\n');
    fs.writeFileSync(path.join(dirtyRepo, 'LICENSE'), 'changed\n');
    const log = vi.fn();

    const result = pack({
      root: dirtyRepo,
      out: path.join(tmp, 'out-dirty'),
      run,
      log,
    });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('2 uncommitted change(s) are not included')
    );
    expect(result.files).toBe(Object.keys(BASE).length);
  });

  test('should throw listing the problems and still remove staging', () => {
    fake = { drop: 'LICENSE', extra: 'oops.txt' };
    const out = path.join(tmp, 'out-bad');

    expect(() => pack({ root: repo, out, run, log: vi.fn() })).toThrow(
      /is not right:\n {2}- missing from the tarball: LICENSE\n {2}- not expected in the tarball: oops\.txt\nFix: /
    );
    expect(leftovers(out)).toEqual([]);
  });

  test('should throw when pnpm pack fails and still remove staging', () => {
    fake = { fail: true };
    const out = path.join(tmp, 'out-fail');

    expect(() => pack({ root: repo, out, run, log: vi.fn() })).toThrow(
      'pack exploded'
    );
    expect(leftovers(out)).toEqual([]);
  });

  test('should refuse a commit with a denied file', () => {
    const bad = makeRepo({ ...BASE, 'x.pem': 'k\n' });
    const out = path.join(tmp, 'out-denied');

    expect(() => pack({ root: bad, out, run, log: vi.fn() })).toThrow(
      /must never ship: x\.pem/
    );
    expect(leftovers(out)).toEqual([]);
  });
});

describe('main', () => {
  test('should print the tarball path and a summary', () => {
    const out = vi.fn();
    const err = vi.fn();
    const dir = path.join(tmp, 'main-out');

    const code = main(['--out', dir], { root: repo, run, out, err });

    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(path.join(dir, 'kyoten-0.3.0.tgz'));
    expect(err).toHaveBeenCalledWith(
      expect.stringMatching(
        /^kyoten:pack: kyoten 0\.3\.0 from [0-9a-f]{7}: 7 snapshot files, \d+ KiB\. Try it: npx/
      )
    );
  });

  test('should resolve --out against cwd', () => {
    const out = vi.fn();

    const code = main(['--out', 'rel-out'], {
      root: repo,
      cwd: tmp,
      run,
      out,
      err: vi.fn(),
    });

    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(
      path.join(tmp, 'rel-out', 'kyoten-0.3.0.tgz')
    );
  });

  test('should pack into dist under the root by default', () => {
    const own = makeRepo(BASE);
    const out = vi.fn();

    const code = main([], { root: own, run, out, err: vi.fn() });

    expect(code).toBe(0);
    expect(out).toHaveBeenCalledWith(
      path.join(own, 'dist', 'kyoten-0.3.0.tgz')
    );
  });

  test('should forward the uncommitted-changes log through err', () => {
    const own = makeRepo(BASE);
    fs.writeFileSync(path.join(own, 'new.txt'), 'x\n');
    const err = vi.fn();

    main(['--out', path.join(tmp, 'main-dirty')], {
      root: own,
      run,
      out: vi.fn(),
      err,
    });

    expect(err).toHaveBeenCalledWith(
      'kyoten:pack: packing HEAD ' +
        `${git(['rev-parse', 'HEAD'], own).slice(0, 7)}; 1 uncommitted change(s) are not included`
    );
  });

  test('should exit 1 with the Fix line for an unexpected argument', () => {
    const err = vi.fn();

    const code = main(['--bogus'], { root: repo, run, out: vi.fn(), err });

    expect(code).toBe(1);
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      'kyoten:pack: unexpected argument: --bogus',
      'kyoten:pack: Fix: pnpm kyoten:pack [--out <dir>]',
    ]);
  });

  test('should reject --out without a value', () => {
    const err = vi.fn();

    const code = main(['--out'], { root: repo, run, out: vi.fn(), err });

    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith('kyoten:pack: unexpected argument: --out');
  });

  test('should prefix each line of a packing error', () => {
    fake = { fail: true };
    const err = vi.fn();

    const code = main(['--out', path.join(tmp, 'main-fail')], {
      root: repo,
      run,
      out: vi.fn(),
      err,
    });

    expect(code).toBe(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringMatching(/^kyoten:pack: pnpm pack .*pack exploded/)
    );
  });

  test('should use the default dependencies', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const code = main(['--bogus']);

    expect(code).toBe(1);
    expect(spy).toHaveBeenCalledWith(
      'kyoten:pack: unexpected argument: --bogus'
    );
    spy.mockRestore();
  });
});
