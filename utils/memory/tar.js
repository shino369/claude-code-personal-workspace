/**
 * A minimal tar codec for memory export and import (design §12): ustar
 * headers, with a pax `path` record for long or non-ASCII paths. Only files
 * and folders exist in it: the reader refuses links, devices, FIFOs, and
 * every other entry type, before anything reaches the disk, so a crafted
 * archive cannot make import write outside its folder through a link.
 *
 * Written in JS rather than through the system tar, so that what import
 * validates is exactly what it extracts on every platform (no listing
 * format to parse, no macOS `._` metadata files). Any tar reads the result.
 */
import zlib from 'zlib';

export const BLOCK = 512;
/** Entry types refused, by what they are. */
/** @type {Record<string, string>} */
const REFUSED = {
  1: 'a hard link',
  2: 'a symbolic link',
  3: 'a device',
  4: 'a device',
  6: 'a FIFO',
};

export class TarError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TarError';
  }
}

/**
 * @typedef {{ path: string, type: 'file' | 'dir', data: Buffer }} TarEntry
 * @typedef {{ path: string, type: 'file' | 'dir', data?: Buffer }} TarInput
 */

/**
 * @param {Buffer} header
 * @param {number} value
 * @param {number} start
 * @param {number} length field length, the last byte a NUL
 */
function writeOctal(header, value, start, length) {
  header.write(
    `${value.toString(8).padStart(length - 1, '0')}\0`,
    start,
    'ascii'
  );
}

/** @param {Buffer} header */
function checksumOf(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

/**
 * @param {string} name at most 100 ASCII bytes
 * @param {string} type
 * @param {number} size
 * @param {number} mtime seconds
 */
function header(name, type, size, mtime) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 'utf-8');
  writeOctal(block, type === '5' ? 0o755 : 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, mtime, 136, 12);
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(
    `${checksumOf(block).toString(8).padStart(6, '0')}\0 `,
    148,
    'ascii'
  );
  return block;
}

/** @param {Buffer} data */
const padding = (data) => Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK);

/**
 * One pax record, `<length> path=<value>\n`, where the length counts itself.
 *
 * @param {string} value
 */
function paxRecord(value) {
  const body = Buffer.byteLength(` path=${value}\n`);
  let length = body + 1;
  while (String(length).length + body !== length) length += 1;
  return Buffer.from(`${length} path=${value}\n`);
}

/**
 * An uncompressed tar of `entries`, in order.
 *
 * @param {TarInput[]} entries
 * @param {{ mtime?: Date }} [options]
 * @returns {Buffer}
 */
export function packTar(entries, { mtime = new Date() } = {}) {
  const seconds = Math.floor(mtime.getTime() / 1000);
  /** @type {Buffer[]} */
  const parts = [];
  entries.forEach((entry, index) => {
    if (!entry.path || entry.path.includes('\0')) {
      throw new TarError(
        `Entry ${index + 1} has no usable path ${JSON.stringify(entry.path)}.`
      );
    }
    const type = entry.type === 'dir' ? '5' : '0';
    const data =
      entry.type === 'dir' ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0));
    const name = entry.type === 'dir' ? `${entry.path}/` : entry.path;
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)) {
      const record = paxRecord(name);
      parts.push(
        header(`PaxHeader/${index}`, 'x', record.length, seconds),
        record,
        padding(record)
      );
    }
    parts.push(
      header(
        name.replace(/[^\x20-\x7e]/g, '_').slice(0, 100),
        type,
        data.length,
        seconds
      ),
      data,
      padding(data)
    );
  });
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/**
 * @param {Buffer} block
 * @param {number} start
 * @param {number} length
 */
function readString(block, start, length) {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString('utf-8');
}

/**
 * The `path` of a pax extended header, or null when it has none.
 *
 * @param {Buffer} data
 * @returns {string | null}
 */
function paxPath(data) {
  let path = null;
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const length = Number(data.subarray(pos, space).toString('ascii'));
    if (
      space === -1 ||
      !Number.isInteger(length) ||
      length <= 0 ||
      pos + length > data.length ||
      data[pos + length - 1] !== 0x0a
    ) {
      throw new TarError('The archive has a bad pax record.');
    }
    const record = data.subarray(space + 1, pos + length - 1).toString('utf-8');
    const eq = record.indexOf('=');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    pos += length;
  }
  return path;
}

/**
 * The files and folders of an uncompressed tar. Throws TarError on anything
 * else (links, devices, …), a bad checksum or size, or a truncated archive.
 *
 * @param {Buffer} buffer
 * @returns {TarEntry[]}
 */
export function unpackTar(buffer) {
  /** @type {TarEntry[]} */
  const entries = [];
  let offset = 0;
  /** @type {string | null | undefined} undefined: no pax header pending */
  let pending;
  while (offset + BLOCK <= buffer.length) {
    const block = buffer.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) {
      if (pending !== undefined) {
        throw new TarError(
          'The archive ends with a pax header without an entry.'
        );
      }
      return entries;
    }
    if (
      Number.parseInt(readString(block, 148, 8).trim(), 8) !== checksumOf(block)
    ) {
      throw new TarError(
        `The archive has a header with a bad checksum (at byte ${offset}).`
      );
    }
    const sizeField = readString(block, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeField)) {
      throw new TarError(
        `The archive has a header with a bad size (at byte ${offset}).`
      );
    }
    const size = Number.parseInt(sizeField, 8);
    const type = String.fromCharCode(block[156]);
    const name = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const entryPath = pending ?? (prefix ? `${prefix}/${name}` : name);
    const start = offset + BLOCK;
    if (start + size > buffer.length) {
      throw new TarError('The archive is truncated.');
    }
    const data = buffer.subarray(start, start + size);
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      pending = paxPath(data);
      continue;
    }
    pending = undefined;
    if (type === '0' || type === '\0') {
      entries.push({ path: entryPath, type: 'file', data: Buffer.from(data) });
    } else if (type === '5') {
      entries.push({
        path: entryPath.replace(/\/+$/, ''),
        type: 'dir',
        data: Buffer.alloc(0),
      });
    } else {
      const what = REFUSED[type] ?? 'an unsupported entry';
      throw new TarError(
        `${entryPath} is ${what}; an archive may hold only files and folders.`
      );
    }
  }
  if (offset < buffer.length) throw new TarError('The archive is truncated.');
  return entries;
}

/**
 * Inflate gzip data, refusing output over `maxBytes` (a gzip bomb).
 *
 * @param {Buffer} data
 * @param {number} maxBytes
 * @returns {Buffer}
 */
export function gunzipLimited(data, maxBytes) {
  try {
    return zlib.gunzipSync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    if (
      /** @type {NodeJS.ErrnoException} */ (error).code ===
      'ERR_BUFFER_TOO_LARGE'
    ) {
      throw new TarError(
        `The archive is larger than ${maxBytes} bytes unpacked.`
      );
    }
    throw new TarError(
      `The file is not a gzip archive (${/** @type {Error} */ (error).message}).`
    );
  }
}
