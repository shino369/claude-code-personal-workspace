/**
 * kyoten end to end, through the path users take: the packed tarball run with
 * `npx --package <tgz> -- kyoten …`. Fake claude, codex, and dsh go first on
 * PATH (on Windows as .cmd shims, so the cmd.exe path is covered); they record
 * their argv, cwd, and environment and exit with $FAKE_EXIT.
 *
 * The tarball is built from HEAD (`pnpm kyoten:pack`): commit before running.
 * A second tarball, from a scratch repository whose README differs, drives a
 * real `kyoten update` merge.
 */
import { expect, test } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { crossSpawn } from '../utils/spawn.js';
import { exportTree } from '../utils/kyoten/snapshot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const run = crossSpawn();
const KEY = 'sk-e2e-token-1234567890';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

/** @type {string} */
let tmp;
/** @type {string} */
let bin;
/** @type {string} */
let tarball;
/** @type {string} */
let home;
/** The tarball of the scratch repository (the update test). */
let second = '';

/**
 * @param {string} file
 * @param {string[]} args
 * @param {object} [options]
 */
function must(file, args, options = {}) {
  const result = run(file, args, { encoding: 'utf-8', ...options });
  if (result.status !== 0) {
    throw new Error(
      `${file} ${args.join(' ')} failed (${result.status}): ${result.stderr}${result.error ?? ''}`
    );
  }
  return String(result.stdout);
}

/** @param {string} dir  a git repo with an isolated identity */
const git = (dir, /** @type {string[]} */ ...args) =>
  must('git', [
    '-C',
    dir,
    '-c',
    'user.name=e2e',
    '-c',
    'user.email=e2e@x',
    '-c',
    'commit.gpgSign=false',
    ...args,
  ]);

/**
 * Build a tarball from `root` (a kyoten repo) into `out`.
 *
 * @param {string} root
 * @param {string} out
 */
function packFrom(root, out) {
  const stdout = must(
    process.execPath,
    [path.join(root, 'utils', 'kyoten', 'pack.js'), '--out', out],
    { cwd: root }
  );
  return stdout.trim().split('\n').at(-1) ?? '';
}

/** Write the fake agents into `bin`. */
function writeFakes() {
  fs.mkdirSync(bin, { recursive: true });
  const fake = path.join(bin, 'fake.mjs');
  fs.writeFileSync(
    fake,
    `import fs from 'fs';
import path from 'path';
const name = path.basename(process.argv[2]);
const keys = ['KYOTEN_HOME', 'KYOTEN_CALLER_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SESSION_ID'];
const env = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ name, argv: process.argv.slice(3), cwd: process.cwd(), env }));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`
  );
  for (const name of ['claude', 'codex', 'dsh']) {
    if (WIN) {
      fs.writeFileSync(
        path.join(bin, `${name}.cmd`),
        `@echo off\r\nnode "%~dp0fake.mjs" ${name} %*\r\n`
      );
    } else {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\nexec node "${fake}" ${name} "$@"\n`);
      fs.chmodSync(file, 0o755);
    }
  }
}

/**
 * Run kyoten from a tarball.
 *
 * @param {string[]} args
 * @param {{ tgz?: string, env?: Record<string, string>, input?: string, cwd?: string }} [options]
 */
function kyoten(args, { tgz = tarball, env = {}, input, cwd = tmp } = {}) {
  const out = path.join(
    tmp,
    `fake-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const result = run(
    'npx',
    ['--yes', '--package', tgz, '--', 'kyoten', ...args],
    {
      cwd,
      input: input ?? '',
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        KYOTEN_HOME: home,
        XDG_CONFIG_HOME: path.join(tmp, 'cfg'),
        APPDATA: path.join(tmp, 'cfg'),
        DSCC_PROFILE: path.join(tmp, 'cfg', 'dscc.env'),
        FAKE_OUT: out,
        ...env,
      },
    }
  );
  const agent = fs.existsSync(out)
    ? JSON.parse(fs.readFileSync(out, 'utf-8'))
    : null;
  return {
    status: result.status,
    stdout: String(result.stdout),
    stderr: String(result.stderr),
    agent,
  };
}

test.beforeAll(() => {
  // The real path: on macOS the temp dir is reached through /var -> /private/var.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kyoten-e2e-')));
  bin = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  writeFakes();
  tarball = packFrom(ROOT, path.join(tmp, 'dist'));
});

test.afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('prints the version of the workspace package', () => {
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
  ).version;

  const result = kyoten(['--version']);

  expect(result.stdout.trim()).toBe(version);
});

test('init creates a clean home from the snapshot', () => {
  const result = kyoten(['init', '--no-setup']);

  expect(result.status).toBe(0);
  for (const file of [
    '.gitignore',
    'pnpm-lock.yaml',
    'AGENTS.md',
    'utils/kyoten/cli.js',
  ]) {
    expect(fs.existsSync(path.join(home, file)), file).toBe(true);
  }
  expect(
    git(home, 'branch', '--format=%(refname:short)').trim().split('\n').sort()
  ).toEqual(['kyoten/upstream', 'main']);
  expect(git(home, 'status', '--porcelain')).toBe('');
});

test('claude starts in the home with the arguments and exit code passed through', () => {
  const result = kyoten(['-p', 'hello world'], {
    env: { FAKE_EXIT: '3', CLAUDE_CODE_SESSION_ID: 'parent' },
  });

  expect(result.status).toBe(3);
  expect(result.agent.name).toBe('claude');
  expect(result.agent.argv).toEqual(['-p', 'hello world']);
  // Real paths: macOS reaches the temp dir through the /var -> /private/var link.
  expect(fs.realpathSync(result.agent.cwd)).toBe(fs.realpathSync(home));
  expect(fs.realpathSync(result.agent.env.KYOTEN_CALLER_DIR)).toBe(
    fs.realpathSync(tmp)
  );
  expect(result.agent.env.CLAUDE_CODE_SESSION_ID).toBeNull();
});

test('codex starts in the home', () => {
  const result = kyoten(['codex', 'resume']);

  expect(result.agent.name).toBe('codex');
  expect(result.agent.argv).toEqual(['resume']);
});

test('dsh starts with its profile and the workspace patch', () => {
  const result = kyoten(['dsh', 'tui']);

  expect(result.agent.name).toBe('dsh');
  expect(result.agent.argv).toEqual([
    'tui',
    '--patch',
    '.dsh/workspace.patch.yml',
  ]);
});

test('dscc saves a piped key, masks it, and starts claude on the DeepSeek profile', () => {
  const saved = kyoten(['dscc', '--set-key'], { input: `${KEY}\n` });
  const shown = kyoten(['dscc', '--show']);
  const result = kyoten(['dscc'], {
    env: { ANTHROPIC_API_KEY: 'sk-ant-inherited' },
  });

  expect(saved.status).toBe(0);
  expect(shown.stdout).toContain('ANTHROPIC_AUTH_TOKEN=sk-e...7890');
  expect(shown.stdout).not.toContain(KEY);
  expect(result.agent.name).toBe('claude');
  expect(result.agent.env.ANTHROPIC_BASE_URL).toBe(
    'https://api.deepseek.com/anthropic'
  );
  expect(result.agent.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  expect(result.agent.env.ANTHROPIC_API_KEY).toBeNull();
});

test('update merges a newer snapshot with a local commit', () => {
  // A scratch kyoten repository: HEAD's files, then a README change.
  const scratch = path.join(tmp, 'scratch');
  exportTree({ repo: ROOT, dest: scratch });
  git(scratch, 'init', '-q');
  git(scratch, 'add', '-A');
  git(scratch, 'commit', '-q', '-m', 'chore: snapshot');
  fs.appendFileSync(path.join(scratch, 'README.md'), '\nUpstream change.\n');
  git(scratch, 'commit', '-q', '-am', 'docs: upstream change');
  second = packFrom(scratch, path.join(tmp, 'dist2'));
  // A local change to another file in the home.
  fs.appendFileSync(path.join(home, 'docs', 'harness.md'), '\nLocal note.\n');
  git(home, 'commit', '-q', '-am', 'docs: local note');

  const result = kyoten(['update', '--no-setup'], { tgz: second });

  expect(result.status, `${second}\n${result.stderr}`).toBe(0);
  expect(fs.readFileSync(path.join(home, 'README.md'), 'utf-8')).toContain(
    'Upstream change.'
  );
  expect(
    fs.readFileSync(path.join(home, 'docs', 'harness.md'), 'utf-8')
  ).toContain('Local note.');
  expect(git(home, 'log', '-1', '--format=%s')).toContain(
    "Merge branch 'kyoten/upstream'"
  );
  expect(git(home, 'status', '--porcelain')).toBe('');
});

test('a second update with the same snapshot changes nothing', () => {
  const head = git(home, 'rev-parse', 'HEAD');

  const result = kyoten(['update', '--no-setup'], { tgz: second });

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('already has kyoten');
  expect(git(home, 'rev-parse', 'HEAD')).toBe(head);
});
