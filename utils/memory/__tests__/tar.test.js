/**
 * Tests for utils/memory/tar.js (a minimal ustar/pax codec)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { BLOCK, TarError, gunzipLimited, packTar, unpackTar } from '../tar.js';

const MTIME = new Date('2026-11-20T12:00:00.000Z');

/**
 * A raw ustar header, for archives our writer never makes.
 *
 * @param {{ name: string, type: string, size?: number, linkname?: string, checksum?: boolean }} fields
 */
function rawHeader({ name, type, size = 0, linkname = '', checksum = true }) {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 'utf-8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write(type, 156);
  header.write(linkname, 157);
  header.write('ustar\0', 257);
  header.write('00', 263);
  header.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(
    `${(checksum ? sum : sum + 1).toString(8).padStart(6, '0')}\0 `,
    148
  );
  return header;
}

/** @param {Buffer[]} parts */
const withEnd = (...parts) =>
  Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]);

describe('packTar and unpackTar', () => {
  test('should round-trip files and folders', () => {
    const tar = packTar(
      [
        { path: 'memory', type: 'dir' },
        { path: 'memory/log.jsonl', type: 'file', data: Buffer.from('{}\n') },
        { path: 'empty.txt', type: 'file', data: Buffer.alloc(0) },
      ],
      { mtime: MTIME }
    );

    expect(tar.length % BLOCK).toBe(0);
    expect(unpackTar(tar)).toEqual([
      { path: 'memory', type: 'dir', data: Buffer.alloc(0) },
      { path: 'memory/log.jsonl', type: 'file', data: Buffer.from('{}\n') },
      { path: 'empty.txt', type: 'file', data: Buffer.alloc(0) },
    ]);
  });

  test('should keep long and non-ASCII paths through a pax header', () => {
    const long = `tasks/${'a'.repeat(120)}/メモ.md`;

    const [entry] = unpackTar(
      packTar([{ path: long, type: 'file', data: Buffer.from('x') }])
    );

    expect(entry.path).toBe(long);
  });

  test('should write an archive the system tar can read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tar-'));
    try {
      const file = path.join(dir, 'a.tar');
      fs.writeFileSync(
        file,
        packTar([
          { path: 'notes', type: 'dir' },
          {
            path: `notes/${'n'.repeat(110)}.txt`,
            type: 'file',
            data: Buffer.from('hello'),
          },
        ])
      );

      const listed = spawnSync('tar', ['-tf', file], { encoding: 'utf-8' });

      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain(`notes/${'n'.repeat(110)}.txt`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('should pack a file given without data as empty', () => {
    expect(unpackTar(packTar([{ path: 'a', type: 'file' }]))[0].data).toEqual(
      Buffer.alloc(0)
    );
  });

  test('should read an empty archive', () => {
    expect(unpackTar(Buffer.alloc(BLOCK * 2))).toEqual([]);
    expect(unpackTar(Buffer.alloc(0))).toEqual([]);
  });

  test('should take the old-style regular file type', () => {
    expect(
      unpackTar(withEnd(rawHeader({ name: 'a.txt', type: '\0' })))
    ).toEqual([{ path: 'a.txt', type: 'file', data: Buffer.alloc(0) }]);
  });

  test('should join the ustar prefix and name', () => {
    const header = rawHeader({ name: 'b.txt', type: '0' });
    header.write('deep/dir', 345);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

    expect(unpackTar(withEnd(header))[0].path).toBe('deep/dir/b.txt');
  });

  test.each([
    ['2', 'a symbolic link'],
    ['1', 'a hard link'],
    ['3', 'a device'],
    ['4', 'a device'],
    ['6', 'a FIFO'],
    ['g', 'an unsupported entry'],
    ['L', 'an unsupported entry'],
  ])('should refuse type %s as %s', (type, what) => {
    const tar = withEnd(
      rawHeader({ name: 'x', type, linkname: '/etc/passwd' })
    );

    expect(() => unpackTar(tar)).toThrow(new RegExp(`x is ${what}`));
  });

  test('should refuse a bad checksum', () => {
    expect(() =>
      unpackTar(withEnd(rawHeader({ name: 'a', type: '0', checksum: false })))
    ).toThrow(/checksum/);
  });

  test('should refuse a truncated archive', () => {
    const tar = packTar([
      { path: 'a.txt', type: 'file', data: Buffer.alloc(2000) },
    ]);

    expect(() => unpackTar(tar.subarray(0, BLOCK * 2))).toThrow(/truncated/);
    expect(() => unpackTar(tar.subarray(0, 100))).toThrow(/truncated/);
  });

  test('should refuse a bad size field', () => {
    const header = rawHeader({ name: 'a', type: '0' });
    header.write('zzzzzzzzzzz\0', 124);
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

    expect(() => unpackTar(withEnd(header))).toThrow(/size/);
  });

  test('should refuse a pax header without a path or with a bad record', () => {
    const bad = (/** @type {string} */ body) => {
      const data = Buffer.from(body);
      const pad = Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);
      return withEnd(
        rawHeader({ name: 'pax', type: 'x', size: data.length }),
        data,
        pad,
        rawHeader({ name: 'a', type: '0' })
      );
    };

    expect(unpackTar(bad('12 mtime=12\n'))[0].path).toBe('a');
    expect(() => unpackTar(bad('99 path=x\n'))).toThrow(/pax/);
    expect(() => unpackTar(bad('nonsense'))).toThrow(/pax/);
  });

  test('should refuse a pax header at the end', () => {
    const data = Buffer.from('10 path=a\n');
    const tar = withEnd(
      rawHeader({ name: 'pax', type: 'x', size: data.length }),
      Buffer.concat([data, Buffer.alloc(BLOCK - data.length)])
    );

    expect(() => unpackTar(tar)).toThrow(/pax header without an entry/);
  });

  test('should refuse an entry without a path', () => {
    expect(() =>
      packTar([{ path: '', type: 'file', data: Buffer.alloc(1) }])
    ).toThrow(TarError);
    expect(() =>
      packTar([{ path: 'a\0b', type: 'file', data: Buffer.alloc(1) }])
    ).toThrow(TarError);
  });
});

describe('gunzipLimited', () => {
  test('should inflate within the limit', () => {
    expect(gunzipLimited(zlib.gzipSync(Buffer.from('abc')), 10)).toEqual(
      Buffer.from('abc')
    );
  });

  test('should refuse output over the limit', () => {
    expect(() => gunzipLimited(zlib.gzipSync(Buffer.alloc(1000)), 100)).toThrow(
      /larger than/
    );
  });

  test('should refuse data that is not gzip', () => {
    expect(() => gunzipLimited(Buffer.from('plain'), 100)).toThrow(
      /not a gzip/
    );
  });
});
