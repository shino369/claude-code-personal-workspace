#!/usr/bin/env node
/**
 * `pnpm kyoten:pack [--out <dir>]` — build the kyoten npm package from the
 * HEAD commit (never the working tree) and check the tarball.
 *
 *   package.json, README.md (docs/kyoten.md), LICENSE
 *   bin/kyoten.js           runs runtime/utils/kyoten/cli.js
 *   runtime/                HEAD's package.json and utils/, plus the marker
 *   snapshot.kyoten.gz      every HEAD file, bundled (see snapshot.js)
 *
 * The tarball must hold exactly those files (npm's own rules drop files
 * silently), nothing on the deny list, and stay under the size cap.
 * Publishing stays a separate, manual step.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { runIfMain } from '../module-runner.js';
import { crossSpawn } from '../spawn.js';
import { ROOT_DIR } from '../workspace-config.js';
import { SNAPSHOT_FILE } from './home.js';
import {
  BUNDLE_FILE,
  capture,
  encodeBundle,
  treeFiles,
  writeFiles,
} from './snapshot.js';

export const MAX_TARBALL_BYTES = 2 * 1024 * 1024;
/**
 * Whether a HEAD file goes to runtime/, the code the launcher runs from:
 * package.json and utils/, without tests (the bundle has everything).
 *
 * @param {string} file  POSIX path
 */
export const isRuntimeFile = (file) =>
  file === 'package.json' ||
  (file.startsWith('utils/') && !file.includes('/__tests__/'));

/**
 * Paths that must never be packed. They are git-ignored, so a snapshot of a
 * commit cannot hold them; this is the second line of defence.
 */
export const DENY = [
  /^(tasks|memory|logs|node_modules|coverage)\//,
  /(^|\/)node_modules\//,
  /^(AGENTS|CLAUDE)\.local\.md$/,
  /^tools\/local\.json$/,
  /^\.claude\/settings\.local\.json$/,
  /^\.mcp\.json$/,
  /(^|\/)\.env(\.(?!example$)[^/]*)?$/,
  /\.(pem|key|p12|pfx|crt)$/,
  /(^|\/)credentials\.json$/,
  /(^|\/)secrets\//,
];

/**
 * @typedef {import('../spawn.js').Spawn} Spawn
 * @typedef {import('./snapshot.js').SnapshotFile} SnapshotFile
 */

/** @param {string} file  POSIX path */
export const denied = (file) => DENY.some((rule) => rule.test(file));

/**
 * The paths in a `.tgz` (gzip + ustar, as npm writes them), PAX long names
 * included. Only regular files are listed.
 *
 * @param {Buffer} tgz
 * @returns {string[]}
 */
export function listTarball(tgz) {
  const tar = zlib.gunzipSync(tgz);
  /** @type {string[]} */
  const files = [];
  /** @param {number} at @param {number} length */
  const text = (at, length) =>
    tar
      .subarray(at, at + length)
      .toString('utf-8')
      .replace(/\0.*$/s, '');
  /** @type {string | null} */
  let paxPath = null;
  let at = 0;
  while (at + 512 <= tar.length) {
    if (tar.subarray(at, at + 512).every((byte) => byte === 0)) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = text(at + 156, 1) || '0';
    const prefix = text(at + 345, 155);
    const name = prefix ? `${prefix}/${text(at, 100)}` : text(at, 100);
    const body = at + 512;
    if (type === 'x') {
      const match = /\d+ path=([^\n]*)\n/.exec(
        tar.subarray(body, body + size).toString('utf-8')
      );
      paxPath = match ? match[1] : null;
    } else if (type === '0') {
      files.push(paxPath ?? name);
      paxPath = null;
    } else {
      paxPath = null;
    }
    at = body + Math.ceil(size / 512) * 512;
  }
  return files;
}

/**
 * Compare the tarball with what it must hold.
 *
 * @param {{ entries: string[], expected: string[], size: number, max?: number }} input
 * @returns {string[]}  problems; empty when the tarball is right
 */
export function checkTarball({
  entries,
  expected,
  size,
  max = MAX_TARBALL_BYTES,
}) {
  const have = new Set(entries.map((entry) => entry.replace(/^package\//, '')));
  const want = new Set(expected);
  const problems = [
    ...[...want]
      .filter((file) => !have.has(file))
      .map((file) => `missing from the tarball: ${file}`),
    ...[...have]
      .filter((file) => !want.has(file))
      .map((file) => `not expected in the tarball: ${file}`),
    ...[...have].filter(denied).map((file) => `on the deny list: ${file}`),
  ];
  if (size > max)
    problems.push(`the tarball is ${size} bytes, over the ${max}-byte cap`);
  return problems;
}

/**
 * The package's own package.json, from HEAD's.
 *
 * @param {Record<string, unknown>} pkg  HEAD's package.json
 */
export function packageManifest(pkg) {
  return {
    name: 'kyoten',
    version: pkg.version,
    description: pkg.description,
    type: 'module',
    bin: { kyoten: 'bin/kyoten.js' },
    files: ['bin', 'runtime', BUNDLE_FILE],
    engines: { node: '>=24' },
    keywords: ['claude-code', 'codex', 'deepseek', 'coding-agent', 'workspace'],
    author: pkg.author,
    license: pkg.license,
    repository: pkg.repository,
  };
}

export const BIN_SOURCE = `#!/usr/bin/env node
// kyoten: start a coding agent in your kyoten workspace. See README.md.
import { main } from '../runtime/utils/kyoten/cli.js';

process.exit(await main(process.argv.slice(2)));
`;

/**
 * Lay out the package in `staging` from HEAD's files.
 *
 * @param {{ files: SnapshotFile[], commit: string, staging: string }} input
 * @returns {{ version: string, expected: string[] }}
 */
export function stage({ files, commit, staging }) {
  /** @param {string} name */
  const get = (name) => {
    const file = files.find((f) => f.path === name);
    if (!file)
      throw new Error(
        `${name} is not in the commit ${commit.slice(0, 7)}.\nFix: commit ${name}, then pack again`
      );
    return file.data;
  };
  const deniedFiles = files.map((f) => f.path).filter(denied);
  if (deniedFiles.length > 0) {
    throw new Error(
      `the commit holds files that must never ship: ${deniedFiles.join(', ')}.\nFix: remove them from git, then pack again`
    );
  }
  const pkg = JSON.parse(get('package.json').toString('utf-8'));
  const version = String(pkg.version);
  const runtime = files.filter((f) => isRuntimeFile(f.path));
  const marker = Buffer.from(
    `${JSON.stringify({ version, commit }, null, 2)}\n`
  );
  const top = [
    {
      path: 'package.json',
      mode: '100644',
      data: Buffer.from(`${JSON.stringify(packageManifest(pkg), null, 2)}\n`),
    },
    { path: 'README.md', mode: '100644', data: get('docs/kyoten.md') },
    { path: 'LICENSE', mode: '100644', data: get('LICENSE') },
    { path: 'bin/kyoten.js', mode: '100755', data: Buffer.from(BIN_SOURCE) },
    { path: BUNDLE_FILE, mode: '100644', data: encodeBundle(files) },
  ];
  const runtimeFiles = [
    ...runtime.map((f) => ({ ...f, path: `runtime/${f.path}` })),
    { path: `runtime/${SNAPSHOT_FILE}`, mode: '100644', data: marker },
  ];
  const written = writeFiles([...top, ...runtimeFiles], staging);
  return { version, expected: written };
}

/**
 * @param {{ root?: string, out: string, run?: Spawn, log: (text: string) => void }} input
 * @returns {{ tarball: string, version: string, commit: string, files: number, size: number }}
 */
export function pack({ root = ROOT_DIR, out, run = crossSpawn(), log }) {
  const commit = capture(run, 'git', ['-C', root, 'rev-parse', 'HEAD']).trim();
  const dirty = capture(run, 'git', [
    '-C',
    root,
    'status',
    '--porcelain',
  ]).trim();
  if (dirty) {
    log(
      `packing HEAD ${commit.slice(0, 7)}; ${dirty.split('\n').length} uncommitted change(s) are not included`
    );
  }
  const files = treeFiles({ repo: root, run });
  fs.mkdirSync(out, { recursive: true });
  const staging = fs.mkdtempSync(path.join(out, '.kyoten-pack-'));
  try {
    const { version, expected } = stage({ files, commit, staging });
    capture(run, 'pnpm', ['pack', '--pack-destination', out], { cwd: staging });
    const tarball = path.join(out, `kyoten-${version}.tgz`);
    const tgz = fs.readFileSync(tarball);
    const problems = checkTarball({
      entries: listTarball(tgz),
      expected,
      size: tgz.length,
    });
    if (problems.length > 0) {
      throw new Error(
        `${tarball} is not right:\n  - ${problems.join('\n  - ')}\nFix: see the problems above; the tarball must not be published`
      );
    }
    return { tarball, version, commit, files: files.length, size: tgz.length };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, cwd?: string, run?: Spawn, out?: (text: string) => void, err?: (text: string) => void }} [deps]
 * @returns {number}
 */
export function main(argv, deps = {}) {
  const {
    root = ROOT_DIR,
    cwd = process.cwd(),
    run,
    out = console.log,
    err = console.error,
  } = deps;
  try {
    let dir = path.join(root, 'dist');
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === '--out' && argv[i + 1])
        dir = path.resolve(cwd, argv[(i += 1)]);
      else
        throw new Error(
          `unexpected argument: ${argv[i]}\nFix: pnpm kyoten:pack [--out <dir>]`
        );
    }
    const result = pack({
      root,
      out: dir,
      run,
      log: (text) => err(`kyoten:pack: ${text}`),
    });
    out(result.tarball);
    err(
      `kyoten:pack: kyoten ${result.version} from ${result.commit.slice(0, 7)}: ${result.files} snapshot files, ${Math.round(result.size / 1024)} KiB. Try it: npx --yes --package "${result.tarball}" -- kyoten doctor`
    );
    return 0;
  } catch (error) {
    for (const line of /** @type {Error} */ (error).message.split('\n'))
      err(`kyoten:pack: ${line}`);
    return 1;
  }
}

/* c8 ignore next 3 - CLI entry point; main() is tested directly */
runIfMain(import.meta.url, () => {
  process.exit(main(process.argv.slice(2)));
});
