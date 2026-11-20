/**
 * The workspace snapshot kyoten ships and installs: the files of one git
 * commit, never the working tree, so nothing uncommitted or untracked
 * (tasks/, memory/, logs/, local files, secrets) can reach a package or a
 * home.
 *
 * In the npm package the snapshot is one gzipped bundle file (BUNDLE_FILE):
 * `npm pack` silently drops `.gitignore`, `.npmrc`, lockfiles, `*.orig`,
 * and anything a nested `.npmignore` names, and a bundle is out of its
 * reach. Format: gzip of `KYOTEN-BUNDLE 1\n`, one JSON line
 * `{"files":[{"path","mode","size"}]}`, then the files' bytes in order.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { crossSpawn } from '../spawn.js';
import { SNAPSHOT_FILE } from './home.js';

/** The bundle's name, next to the package's runtime/ folder. */
export const BUNDLE_FILE = 'snapshot.kyoten.gz';
const MAGIC = 'KYOTEN-BUNDLE 1\n';

/**
 * @typedef {import('../spawn.js').Spawn} Spawn
 * @typedef {{ path: string, mode: string, sha: string }} TreeEntry
 * @typedef {{ path: string, mode: string, data: Buffer }} SnapshotFile
 * @typedef {{ kind: 'package', bundle: string, version: string, commit: string } | { kind: 'git', repo: string, version: string, commit: string }} SnapshotSource
 */

/**
 * Run a command and return its stdout, or throw with its stderr.
 *
 * @param {Spawn} run
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [options]
 * @returns {string}
 */
export function capture(run, bin, args, options = {}) {
  const result = run(bin, args, { encoding: 'utf-8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      String(result.stderr ?? '').trim() || `exit ${result.status}`;
    throw new Error(`${bin} ${args.join(' ')} failed: ${detail}`);
  }
  return String(result.stdout ?? '');
}

/**
 * The files of `ref`: path (POSIX), mode, and blob id. Symlinks and
 * submodules are refused: a home must work on Windows without them.
 *
 * @param {{ repo: string, ref?: string, run?: Spawn }} input
 * @returns {TreeEntry[]}
 */
export function listTree({ repo, ref = 'HEAD', run = crossSpawn() }) {
  const out = capture(run, 'git', [
    '-C',
    repo,
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    ref,
  ]);
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode, type, sha] = record.slice(0, tab).split(' ');
      const file = record.slice(tab + 1);
      if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
        throw new Error(
          `${file} is a ${mode === '120000' ? 'symlink' : type} in ${ref}; a kyoten snapshot holds regular files only.\nFix: replace it with a regular file`
        );
      }
      return { path: file, mode, sha };
    });
}

/**
 * Read the blobs in one `git cat-file --batch` call, in order.
 *
 * @param {{ repo: string, shas: string[], run?: Spawn }} input
 * @returns {Buffer[]}
 */
export function readBlobs({ repo, shas, run = crossSpawn() }) {
  if (shas.length === 0) return [];
  const result = run('git', ['-C', repo, 'cat-file', '--batch'], {
    input: `${shas.join('\n')}\n`,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git cat-file --batch failed: ${String(result.stderr ?? '').trim()}`
    );
  }
  const out = /** @type {Buffer} */ (result.stdout);
  /** @type {Buffer[]} */
  const blobs = [];
  let at = 0;
  for (const sha of shas) {
    const eol = out.indexOf(0x0a, at);
    const header = out.subarray(at, eol).toString('utf-8');
    const [id, type, size] = header.split(' ');
    if (id !== sha || type !== 'blob') {
      throw new Error(`git cat-file returned "${header}" for ${sha}`);
    }
    const start = eol + 1;
    blobs.push(out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}

/**
 * The files of `ref` with their bytes.
 *
 * @param {{ repo: string, ref?: string, run?: Spawn }} input
 * @returns {SnapshotFile[]}
 */
export function treeFiles({ repo, ref = 'HEAD', run = crossSpawn() }) {
  const entries = listTree({ repo, ref, run });
  const blobs = readBlobs({ repo, shas: entries.map((e) => e.sha), run });
  return entries.map((entry, index) => ({
    path: entry.path,
    mode: entry.mode,
    data: blobs[index],
  }));
}

/**
 * Why `file` cannot be written under a destination folder, or null: only
 * plain relative POSIX paths (no `..`, no absolute or drive paths, no `\`).
 *
 * @param {string} file
 */
export function unsafePath(file) {
  if (!file || file.includes('\\') || file.includes('\0'))
    return 'has a backslash or is empty';
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return 'is absolute';
  if (
    file.split('/').some((part) => part === '..' || part === '.' || part === '')
  ) {
    return 'has an empty, . or .. segment';
  }
  return null;
}

/**
 * Write snapshot files into `dest` (created).
 *
 * @param {SnapshotFile[]} files
 * @param {string} dest
 * @returns {string[]}  the POSIX paths written
 */
export function writeFiles(files, dest) {
  return files.map((file) => {
    const problem = unsafePath(file.path);
    if (problem)
      throw new Error(
        `refusing to write snapshot path ${JSON.stringify(file.path)}: it ${problem}`
      );
    const target = path.join(dest, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data, {
      mode: file.mode === '100755' ? 0o755 : 0o644,
    });
    return file.path;
  });
}

/**
 * Write the files of `ref` into `dest` (created).
 *
 * @param {{ repo: string, dest: string, ref?: string, run?: Spawn }} input
 * @returns {string[]}  the POSIX paths written
 */
export function exportTree({ repo, dest, ref = 'HEAD', run }) {
  return writeFiles(treeFiles({ repo, ref, run }), dest);
}

/**
 * @param {SnapshotFile[]} files
 * @returns {Buffer}  the gzipped bundle
 */
export function encodeBundle(files) {
  const index = files.map((f) => ({
    path: f.path,
    mode: f.mode,
    size: f.data.length,
  }));
  const head = Buffer.from(
    `${MAGIC}${JSON.stringify({ files: index })}\n`,
    'utf-8'
  );
  return zlib.gzipSync(Buffer.concat([head, ...files.map((f) => f.data)]), {
    level: 9,
  });
}

/**
 * @param {Buffer} bundle  gzipped, as written by encodeBundle
 * @returns {SnapshotFile[]}
 */
export function decodeBundle(bundle) {
  const raw = zlib.gunzipSync(bundle);
  /** @param {string} why */
  const bad = (why) =>
    new Error(
      `the kyoten snapshot bundle is damaged (${why}).\nFix: reinstall kyoten (npx kyoten@latest)`
    );
  if (raw.subarray(0, MAGIC.length).toString('utf-8') !== MAGIC)
    throw bad('unknown format');
  const eol = raw.indexOf(0x0a, MAGIC.length);
  /** @type {{ files?: unknown }} */
  let index;
  try {
    index = JSON.parse(raw.subarray(MAGIC.length, eol).toString('utf-8'));
  } catch {
    throw bad('unreadable index');
  }
  if (!Array.isArray(index?.files)) throw bad('no file list');
  let at = eol + 1;
  const files = index.files.map(
    (/** @type {{ path: unknown, mode: unknown, size: unknown }} */ entry) => {
      const { path: file, mode, size } = entry;
      if (
        typeof file !== 'string' ||
        (mode !== '100644' && mode !== '100755') ||
        !Number.isInteger(size) ||
        Number(size) < 0
      ) {
        throw bad(`bad entry ${JSON.stringify(entry)}`);
      }
      const data = raw.subarray(at, at + Number(size));
      at += Number(size);
      return { path: file, mode, data };
    }
  );
  if (at !== raw.length) throw bad('size mismatch');
  return files;
}

/**
 * Where the snapshot to install comes from: the npm package's bundle (its
 * runtime folder holds SNAPSHOT_FILE), or the HEAD commit of the clone kyoten
 * runs from.
 *
 * @param {{ root: string, version: string, run?: Spawn }} input
 * @returns {SnapshotSource}
 */
export function snapshotSource({ root, version, run = crossSpawn() }) {
  const marker = path.join(root, SNAPSHOT_FILE);
  if (fs.existsSync(marker)) {
    const info = JSON.parse(fs.readFileSync(marker, 'utf-8'));
    return {
      kind: 'package',
      bundle: path.join(root, '..', BUNDLE_FILE),
      version: String(info.version),
      commit: String(info.commit),
    };
  }
  const commit = capture(run, 'git', ['-C', root, 'rev-parse', 'HEAD']).trim();
  return { kind: 'git', repo: root, version, commit };
}

/**
 * Write the snapshot's files into `dest`.
 *
 * @param {SnapshotSource} source
 * @param {string} dest
 * @param {{ run?: Spawn }} [spawns]
 * @returns {string[]}
 */
export function materialize(source, dest, spawns = {}) {
  if (source.kind === 'package') {
    return writeFiles(decodeBundle(fs.readFileSync(source.bundle)), dest);
  }
  return exportTree({ repo: source.repo, dest, ref: source.commit, ...spawns });
}
