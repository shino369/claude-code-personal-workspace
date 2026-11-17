import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  PROBLEM_STATUSES,
  createLink,
  formatResult,
  linkSkills,
  listSkills,
  main,
  parseArgs,
} from '../skills-link.js';

/** @type {string} */
let root;

const skillsDir = () => path.join(root, '.agents', 'skills');
const claudeDir = () => path.join(root, '.claude', 'skills');

/**
 * @param {string} dir
 * @param {string} name
 */
function makeSkill(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test\n---\n`
  );
}

/** @param {Array<{ name: string, status: string }>} results */
const statusOf = (results) =>
  Object.fromEntries(results.map((r) => [r.name, r.status]));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-link-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listSkills', () => {
  test('should return an empty list when the directory is missing', () => {
    expect(listSkills(path.join(root, 'nope'))).toEqual([]);
  });

  test('should list only directories that contain SKILL.md', () => {
    makeSkill(skillsDir(), 'beta');
    makeSkill(skillsDir(), 'alpha');
    fs.mkdirSync(path.join(skillsDir(), 'empty'));
    fs.writeFileSync(path.join(skillsDir(), 'README.md'), 'x');

    expect(listSkills(skillsDir())).toEqual(['alpha', 'beta']);
  });
});

describe('createLink', () => {
  test('should create a relative symlink', () => {
    makeSkill(skillsDir(), 'alpha');
    fs.mkdirSync(claudeDir(), { recursive: true });
    const link = path.join(claudeDir(), 'alpha');

    const kind = createLink(path.join(skillsDir(), 'alpha'), link);

    expect(kind).toBe('symlink');
    expect(fs.readlinkSync(link)).toBe(
      path.join('..', '..', '.agents', 'skills', 'alpha')
    );
  });

  test('should fall back to a junction on Windows when symlinks are not permitted', () => {
    const calls = /** @type {Array<[string, string, string]>} */ ([]);
    const fsApi = /** @type {any} */ ({
      symlinkSync: (
        /** @type {string} */ target,
        /** @type {string} */ link,
        /** @type {string} */ type
      ) => {
        calls.push([target, link, type]);
        if (type === 'dir') {
          throw Object.assign(new Error('denied'), { code: 'EPERM' });
        }
      },
    });

    const kind = createLink('/abs/skill', '/abs/link', {
      fsApi,
      platform: 'win32',
    });

    expect(kind).toBe('junction');
    expect(calls[1]).toEqual(['/abs/skill', '/abs/link', 'junction']);
  });

  test('should rethrow symlink errors on non-Windows platforms', () => {
    const fsApi = /** @type {any} */ ({
      symlinkSync: () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    });

    expect(() => createLink('/a', '/b', { fsApi, platform: 'darwin' })).toThrow(
      'denied'
    );
  });

  test('should rethrow unexpected errors on Windows', () => {
    const fsApi = /** @type {any} */ ({
      symlinkSync: () => {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      },
    });

    expect(() => createLink('/a', '/b', { fsApi, platform: 'win32' })).toThrow(
      'exists'
    );
  });

  test('should accept EACCES as a Windows fallback trigger', () => {
    let attempts = 0;
    const fsApi = /** @type {any} */ ({
      symlinkSync: () => {
        attempts++;
        if (attempts === 1) {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      },
    });

    expect(createLink('/a', '/b', { fsApi, platform: 'win32' })).toBe(
      'junction'
    );
  });
});

describe('linkSkills', () => {
  test('should link every canonical skill into the target directory', () => {
    makeSkill(skillsDir(), 'alpha');
    makeSkill(skillsDir(), 'beta');

    const results = linkSkills({ rootDir: root });

    expect(statusOf(results)).toEqual({ alpha: 'linked', beta: 'linked' });
    expect(fs.existsSync(path.join(claudeDir(), 'alpha', 'SKILL.md'))).toBe(
      true
    );
  });

  test('should report ok when links are already correct', () => {
    makeSkill(skillsDir(), 'alpha');
    linkSkills({ rootDir: root });

    expect(statusOf(linkSkills({ rootDir: root }))).toEqual({ alpha: 'ok' });
  });

  test('should report missing links in check mode without creating them', () => {
    makeSkill(skillsDir(), 'alpha');

    const results = linkSkills({ rootDir: root, check: true });

    expect(statusOf(results)).toEqual({ alpha: 'missing' });
    expect(fs.existsSync(claudeDir())).toBe(false);
  });

  test('should migrate a legacy real copy into the canonical directory', () => {
    makeSkill(claudeDir(), 'legacy');

    const results = linkSkills({ rootDir: root });

    expect(statusOf(results)).toEqual({ legacy: 'linked' });
    expect(results[0]).toMatchObject({ name: 'legacy', status: 'migrated' });
    expect(fs.existsSync(path.join(skillsDir(), 'legacy', 'SKILL.md'))).toBe(
      true
    );
    expect(
      fs.lstatSync(path.join(claudeDir(), 'legacy')).isSymbolicLink()
    ).toBe(true);
  });

  test('should report a legacy copy in check mode without moving it', () => {
    makeSkill(claudeDir(), 'legacy');

    const results = linkSkills({ rootDir: root, check: true });

    expect(statusOf(results)).toEqual({ legacy: 'legacy-copy' });
    expect(fs.existsSync(path.join(skillsDir(), 'legacy'))).toBe(false);
  });

  test('should report a conflict when a real copy shadows a canonical skill', () => {
    makeSkill(skillsDir(), 'alpha');
    makeSkill(claudeDir(), 'alpha');

    const results = linkSkills({ rootDir: root });

    expect(statusOf(results)).toEqual({ alpha: 'conflict' });
    expect(fs.lstatSync(path.join(claudeDir(), 'alpha')).isDirectory()).toBe(
      true
    );
  });

  test('should leave a same-named link to another location alone', () => {
    makeSkill(skillsDir(), 'alpha');
    makeSkill(path.join(root, 'elsewhere'), 'alpha');
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'elsewhere', 'alpha'),
      path.join(claudeDir(), 'alpha'),
      'dir'
    );

    expect(statusOf(linkSkills({ rootDir: root }))).toEqual({
      alpha: 'unmanaged',
    });
  });

  test('should treat a dangling same-named link as unmanaged', () => {
    makeSkill(skillsDir(), 'alpha');
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'gone'),
      path.join(claudeDir(), 'alpha'),
      'dir'
    );

    expect(statusOf(linkSkills({ rootDir: root }))).toEqual({
      alpha: 'unmanaged',
    });
  });

  test('should prune links that point at removed canonical skills', () => {
    makeSkill(skillsDir(), 'alpha');
    linkSkills({ rootDir: root });
    fs.rmSync(path.join(skillsDir(), 'alpha'), { recursive: true });

    const results = linkSkills({ rootDir: root });

    expect(statusOf(results)).toEqual({ alpha: 'pruned' });
    expect(fs.existsSync(path.join(claudeDir(), 'alpha'))).toBe(false);
  });

  test('should report stale links in check mode', () => {
    makeSkill(skillsDir(), 'alpha');
    linkSkills({ rootDir: root });
    fs.rmSync(path.join(skillsDir(), 'alpha'), { recursive: true });

    expect(statusOf(linkSkills({ rootDir: root, check: true }))).toEqual({
      alpha: 'stale',
    });
  });

  test('should treat a link to the skills directory itself as stale', () => {
    fs.mkdirSync(skillsDir(), { recursive: true });
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.symlinkSync(
      path.join('..', '..', '.agents', 'skills'),
      path.join(claudeDir(), 'weird'),
      'dir'
    );

    expect(statusOf(linkSkills({ rootDir: root }))).toEqual({
      weird: 'pruned',
    });
  });

  test('should report extra links outside the skills directory as unmanaged', () => {
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.symlinkSync(
      path.join(root, 'node_modules', 'pkg'),
      path.join(claudeDir(), 'pkg-skill'),
      'dir'
    );

    expect(statusOf(linkSkills({ rootDir: root }))).toEqual({
      'pkg-skill': 'unmanaged',
    });
  });

  test('should ignore plain files in the target directory', () => {
    fs.mkdirSync(claudeDir(), { recursive: true });
    fs.writeFileSync(path.join(claudeDir(), '.gitignore'), '*');

    expect(linkSkills({ rootDir: root })).toEqual([]);
  });

  test('should rethrow unexpected lstat errors', () => {
    makeSkill(skillsDir(), 'alpha');
    const fsApi = /** @type {any} */ ({
      ...fs,
      lstatSync: (/** @type {string} */ p) => {
        if (p.endsWith(path.join('.claude', 'skills', 'alpha'))) {
          throw Object.assign(new Error('io'), { code: 'EIO' });
        }
        return fs.lstatSync(p);
      },
    });

    expect(() => linkSkills({ rootDir: root, fsApi })).toThrow('io');
  });

  test('should link into every requested target', () => {
    makeSkill(skillsDir(), 'alpha');

    const results = linkSkills({
      rootDir: root,
      targets: [path.join('.claude', 'skills'), path.join('.dsh', 'skills')],
    });

    expect(results.map((r) => r.target)).toEqual([
      path.join('.claude', 'skills'),
      path.join('.dsh', 'skills'),
    ]);
  });
});

describe('parseArgs', () => {
  test('should default to the Claude target', () => {
    expect(parseArgs([])).toEqual({
      check: false,
      json: false,
      targets: [path.join('.claude', 'skills')],
    });
  });

  test('should parse flags and targets in both forms', () => {
    expect(
      parseArgs(['--check', '--json', '--target', 'a', '--target=b'])
    ).toEqual({ check: true, json: true, targets: ['a', 'b'] });
  });

  test('should reject a target flag without a value', () => {
    expect(() => parseArgs(['--target'])).toThrow('--target needs a directory');
  });

  test('should reject unknown options', () => {
    expect(() => parseArgs(['--force'])).toThrow('Unknown option: --force');
  });
});

describe('formatResult', () => {
  test('should mark problems with a cross and include details', () => {
    expect(
      formatResult({ target: 't', name: 'a', status: 'missing', detail: 'd' })
    ).toBe(`✗ ${path.join('t', 'a')} missing — d`);
  });

  test('should mark unmanaged entries with a warning', () => {
    expect(formatResult({ target: 't', name: 'a', status: 'unmanaged' })).toBe(
      `! ${path.join('t', 'a')} unmanaged`
    );
  });

  test('should mark changes with a tick', () => {
    expect(formatResult({ target: 't', name: 'a', status: 'linked' })).toBe(
      `✓ ${path.join('t', 'a')} linked`
    );
  });

  test('should expose the problem statuses', () => {
    expect([...PROBLEM_STATUSES]).toEqual([
      'missing',
      'legacy-copy',
      'stale',
      'conflict',
    ]);
  });
});

describe('main', () => {
  test('should print a JSON report', () => {
    makeSkill(skillsDir(), 'alpha');
    const lines = /** @type {string[]} */ ([]);

    const code = main({
      argv: ['--json'],
      rootDir: root,
      log: (m) => lines.push(m),
    });

    expect(code).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({
      ok: true,
      results: [{ name: 'alpha', status: 'linked' }],
    });
  });

  test('should print only changes and a summary when everything is fine', () => {
    makeSkill(skillsDir(), 'alpha');
    makeSkill(skillsDir(), 'beta');
    linkSkills({ rootDir: root });
    fs.rmSync(path.join(claudeDir(), 'beta'));
    const lines = /** @type {string[]} */ ([]);

    const code = main({ argv: [], rootDir: root, log: (m) => lines.push(m) });

    expect(code).toBe(0);
    expect(lines).toEqual([
      `✓ ${path.join('.claude', 'skills', 'beta')} linked — symlink`,
      'Skills linked: 1 changed, 1 already ok.',
    ]);
  });

  test('should fail check mode with a fix hint', () => {
    makeSkill(skillsDir(), 'alpha');
    const lines = /** @type {string[]} */ ([]);

    const code = main({
      argv: ['--check'],
      rootDir: root,
      log: (m) => lines.push(m),
    });

    expect(code).toBe(1);
    expect(lines.at(-1)).toBe('1 problem(s). Fix: pnpm skills:link');
  });

  test('should fail on conflicts with a resolve hint', () => {
    makeSkill(skillsDir(), 'alpha');
    makeSkill(claudeDir(), 'alpha');
    const lines = /** @type {string[]} */ ([]);

    const code = main({ argv: [], rootDir: root, log: (m) => lines.push(m) });

    expect(code).toBe(1);
    expect(lines.at(-1)).toBe(
      '1 problem(s). Resolve the conflicts above, then re-run pnpm skills:link.'
    );
  });
});
