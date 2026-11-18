import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  OWNED_SKILLS,
  ROOT_DIR,
  SKILLS_DIR,
  listThirdPartySkills,
  localGlobs,
  vendoredGlobs,
} from '../workspace-config.js';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('constants', () => {
  test('should resolve the repository root', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'package.json'))).toBe(true);
  });

  test('should keep every owned skill in the .gitignore exceptions', () => {
    const gitignore = fs.readFileSync(
      path.join(ROOT_DIR, '.gitignore'),
      'utf8'
    );
    for (const name of OWNED_SKILLS) {
      expect(gitignore).toContain(`!/.agents/skills/${name}/`);
    }
  });

  test('should keep every owned skill in the tsconfig include list', () => {
    const tsconfig = fs.readFileSync(
      path.join(ROOT_DIR, 'tsconfig.json'),
      'utf8'
    );
    for (const name of OWNED_SKILLS) {
      expect(tsconfig).toContain(`.agents/skills/${name}/`);
    }
  });
});

describe('listThirdPartySkills', () => {
  test('should return an empty list when no skills are installed', () => {
    expect(listThirdPartySkills(root)).toEqual([]);
  });

  test('should list installed skills that are not project-owned', () => {
    const dir = path.join(root, SKILLS_DIR);
    for (const name of ['tdd', 'web-browsing', 'agent-browser']) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
    }

    expect(listThirdPartySkills(root)).toEqual(['agent-browser', 'tdd']);
  });
});

describe('vendoredGlobs', () => {
  test('should exclude link directories and third-party skills', () => {
    fs.mkdirSync(path.join(root, SKILLS_DIR, 'tdd'), { recursive: true });

    expect(vendoredGlobs(root)).toEqual([
      '**/.claude/skills/**',
      '**/.github/skills/**',
      '**/.agents/skills/tdd/**',
    ]);
  });
});

describe('localGlobs', () => {
  test('should turn git-ignored directories into globs, minus handled ones', () => {
    const spawn = vi.fn(() => ({
      status: 0,
      stdout: [
        'resources/',
        'coverage/',
        'tools/local.json',
        'tasks/',
        'node_modules/',
        '.agents/skills/tdd/',
        '.claude/skills/',
        'nested/cache/',
        '',
      ].join('\0'),
    }));
    expect(localGlobs(root, spawn)).toEqual([
      'coverage/**',
      'nested/cache/**',
      'resources/**',
    ]);
    expect(spawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['--ignored', '--directory', '-z']),
      expect.objectContaining({ cwd: root })
    );
  });

  test('should be empty outside a git checkout', () => {
    expect(localGlobs(root)).toEqual([]);
    expect(localGlobs(root, () => ({ status: 0, stdout: null }))).toEqual([]);
  });

  test('should list a real ignored folder of a git checkout', () => {
    const git = (/** @type {string[]} */ ...args) =>
      spawnSync('git', args, { cwd: root, encoding: 'utf-8' });
    git('init', '-q');
    fs.writeFileSync(path.join(root, '.gitignore'), 'resources/\n');
    fs.mkdirSync(path.join(root, 'resources', 'venv'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources', 'venv', 'a.js'), '');
    expect(localGlobs(root)).toEqual(['resources/**']);
  });
});
