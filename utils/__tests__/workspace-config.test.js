import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  OWNED_SKILLS,
  ROOT_DIR,
  SKILLS_DIR,
  listThirdPartySkills,
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
