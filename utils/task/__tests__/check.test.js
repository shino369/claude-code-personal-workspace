import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  CHECK_COMMAND,
  CHROME_STUB_FILE,
  UNIGNORE_TASKS,
  TSCONFIG_FILE,
  browserRoots,
  canResolve,
  collectTaskCode,
  fileEnv,
  formatCheck,
  globalsFor,
  hasTaskCode,
  isSourceFile,
  lintOverrides,
  listCodeFiles,
  listReviewFiles,
  runEslint,
  runPrettier,
  runTaskCheck,
  runTsc,
  tsconfigFor,
  withCheck,
} from '../check.js';
import { linkDir } from '../../__tests__/support/links.js';

/** @type {string} */
let root;
/** @type {string} */
let taskDir;

/**
 * @param {Record<string, string>} files paths relative to the task dir
 */
function write(files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(taskDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
  }
}

const MANIFEST = JSON.stringify({ manifest_version: 3, name: 'x' });

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-check-')));
  taskDir = path.join(root, 'tasks', 'demo-261117');
  fs.mkdirSync(taskDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('listCodeFiles', () => {
  test('should skip task bookkeeping, top-level output folders, dependencies, and dotfiles', () => {
    write({
      'state.json': '{}',
      'plan.md': '#',
      'NOTES.md': '#',
      'tmp/a.js': '',
      'reviews/r.js': '',
      'studies/s.js': '',
      'app/node_modules/m.js': '',
      'app/coverage/c.js': '',
      'app/venv/lib/v.js': '',
      'app/__pycache__/p.js': '',
      'app/.cache/x.js': '',
      '.hidden.js': '',
      'app/README.md': '#',
      'app/data/state.json': '{}',
      'app/tmp/kept.js': '',
      'scripts/run.mjs': '',
      'app/src/a.ts': '',
      'app/src/style.css': '',
    });

    expect(listCodeFiles(taskDir)).toEqual([
      'app/data/state.json',
      'app/src/a.ts',
      'app/src/style.css',
      'app/tmp/kept.js',
      'scripts/run.mjs',
    ]);
  });

  test('should ignore entries that are neither files nor folders', () => {
    write({ 'real/a.js': '' });
    // A directory link (a junction on Windows, which needs no symlink rights)
    linkDir(path.join(taskDir, 'real'), path.join(taskDir, 'linked'));

    expect(listCodeFiles(taskDir)).toEqual(['real/a.js']);
  });
});

describe('isSourceFile', () => {
  test('should take code in any language and build files', () => {
    for (const file of [
      'a.py',
      'run.sh',
      'stats.R',
      'app/main.go',
      'docs/index.html',
      'ui/App.tsx',
      'nb.ipynb',
      'Dockerfile',
      'sub/Makefile',
    ]) {
      expect(isSourceFile(file), file).toBe(true);
    }
  });

  test('should leave out prose, data, config, media, and outputs', () => {
    for (const file of [
      'README.md',
      'data.json',
      'conf.yaml',
      'shot.png',
      'notes.txt',
      'model.pkl',
      'run.log',
      'LICENSE',
    ]) {
      expect(isSourceFile(file), file).toBe(false);
    }
  });
});

describe('listReviewFiles', () => {
  test('should list source in any language and config, docs/ included', () => {
    write({
      'state.json': '{}',
      'plan.md': '#',
      'NOTES.md': '#',
      'tmp/a.py': '',
      'reviews/r.js': '',
      'studies/s.py': '',
      'translated/t.html': '',
      'loop/l.js': '',
      'swarm/w.js': '',
      'docs/index.html': '',
      'docs/design.md': '#',
      'docs/shot.png': '',
      'app/main.py': '',
      'app/pyproject.toml': '',
      'app/data.json': '{}',
      'app/__pycache__/main.cpython-312.pyc': '',
      'venv/lib/site.py': '',
      '.venv/lib/site.py': '',
      'scripts/gen.sh': '',
    });

    expect(listReviewFiles(taskDir)).toEqual([
      'app/data.json',
      'app/main.py',
      'app/pyproject.toml',
      'docs/index.html',
      'scripts/gen.sh',
    ]);
  });
});

describe('listReviewFiles secrets', () => {
  test('should keep config files named like credentials out, but not code or look-alikes', () => {
    write({
      'app/credentials.json': '{}',
      'app/client_secret_123.json': '{}',
      'config/secrets.yaml': '',
      'gcp-service-account.json': '{}',
      'app/token.json': '{}',
      'app/api-keys.toml': '',
      'app/tokenizer.json': '{}',
      'app/secrets.py': '',
    });

    expect(listReviewFiles(taskDir)).toEqual([
      'app/secrets.py',
      'app/tokenizer.json',
    ]);
  });
});

describe('browserRoots', () => {
  test('should mark extension folders and page folders', () => {
    write({
      'ext/manifest.json': MANIFEST,
      'ext/popup.html': '',
      'site/index.html': '',
      'pwa/manifest.json': '{"name":"web app"}',
      'bad/manifest.json': '{oops',
      'nul/manifest.json': 'null',
    });
    const roots = browserRoots(taskDir, listCodeFiles(taskDir));

    expect(Object.fromEntries(roots)).toEqual({
      ext: 'webextension',
      site: 'browser',
    });
  });

  test('should keep an extension folder marked when a page sorts after its manifest', () => {
    write({ 'ext/manifest.json': MANIFEST, 'ext/zz.html': '' });

    expect(browserRoots(taskDir, listCodeFiles(taskDir)).get('ext')).toBe(
      'webextension'
    );
  });
});

describe('fileEnv', () => {
  const roots = new Map(
    /** @type {Array<[string, import('../check.js').FileEnv]>} */ ([
      ['ext', 'webextension'],
      ['ext/src', 'browser'],
      ['site', 'browser'],
    ])
  );

  test.each([
    ['scripts/run.js', 'node'],
    ['lib/util.js', 'node'],
    ['site/app.js', 'browser'],
    ['site/app.test.js', 'node'],
    ['site/e2e/flow.js', 'node'],
    ['ext/src/background.js', 'webextension'],
    ['ext/test/lib.test.js', 'extension-node'],
    ['ext/vitest.config.js', 'extension-node'],
    ['ext/scripts/icons.mjs', 'extension-node'],
  ])('should treat %s as %s', (file, env) => {
    expect(fileEnv(file, roots)).toBe(env);
  });

  test('should use a browser root at the task top level', () => {
    expect(fileEnv('app.js', new Map([['.', 'browser']]))).toBe('browser');
  });
});

describe('collectTaskCode', () => {
  test('should group files by tool and find DOM test pragmas', () => {
    write({
      'ext/manifest.json': MANIFEST,
      'ext/src/bg.js': '',
      'ext/test/dom.test.js': '// @vitest-environment jsdom\n',
      'ext/test/plain.test.js': '',
      'ext/types.ts': '',
    });

    expect(collectTaskCode(taskDir)).toEqual({
      lint: ['ext/src/bg.js', 'ext/test/dom.test.js', 'ext/test/plain.test.js'],
      format: [
        'ext/manifest.json',
        'ext/src/bg.js',
        'ext/test/dom.test.js',
        'ext/test/plain.test.js',
        'ext/types.ts',
      ],
      types: [
        'ext/src/bg.js',
        'ext/test/dom.test.js',
        'ext/test/plain.test.js',
        'ext/types.ts',
      ],
      env: {
        'ext/src/bg.js': 'webextension',
        'ext/test/dom.test.js': 'extension-node',
        'ext/test/plain.test.js': 'extension-node',
        'ext/types.ts': 'webextension',
      },
      dom: ['ext/test/dom.test.js'],
    });
  });
});

describe('hasTaskCode', () => {
  test('should be false for a missing folder', () => {
    expect(hasTaskCode(path.join(root, 'nope'))).toBe(false);
  });

  test('should be false when only data files exist', () => {
    write({ 'data/x.json': '{}', 'notes.md': '#' });

    expect(hasTaskCode(taskDir)).toBe(false);
  });

  test('should be true for scripts', () => {
    write({ 'scripts/a.js': '' });

    expect(hasTaskCode(taskDir)).toBe(true);
  });
});

describe('globalsFor', () => {
  test('should add nothing for Node code', () => {
    expect(globalsFor('node')).toEqual({});
  });

  test('should add chrome on top of Node for extension tests', () => {
    const result = globalsFor('extension-node');

    expect(result.chrome).toBeDefined();
    expect(result.process).toBeUndefined();
  });

  test('should switch Node globals off and add browser ones for pages', () => {
    const result = globalsFor('browser');

    expect(result.process).toBe('off');
    expect(result.window).toBeDefined();
    expect(result.console).not.toBe('off');
    expect(result.chrome).toBeUndefined();
  });

  test('should add extension and service worker globals for extension code', () => {
    const result = globalsFor('webextension');

    expect(result.process).toBe('off');
    expect(result.chrome).toBeDefined();
    expect(result.clients).toBeDefined();
  });
});

describe('lintOverrides', () => {
  test('should only lift the tasks ignore for Node-only code', () => {
    expect(lintOverrides({ 'a.js': 'node' })).toEqual([UNIGNORE_TASKS]);
  });

  test('should add one globals block per runtime and one for DOM tests', () => {
    const config = lintOverrides(
      {
        'a.js': 'node',
        'b.js': 'browser',
        'c.js': 'webextension',
        'd.test.js': 'extension-node',
      },
      ['d.test.js']
    );

    expect(
      config.map((block) => /** @type {{ files?: string[] }} */ (block).files)
    ).toEqual([undefined, ['b.js'], ['c.js'], ['d.test.js'], ['d.test.js']]);
  });
});

describe('runEslint', () => {
  /**
   * A workspace-like config: ignores tasks/, like the real one. `.mjs`, so
   * Node never guesses its module type from a package.json above the temp
   * dir (MODULE_TYPELESS_PACKAGE_JSON under a Windows home).
   */
  const config = (/** @type {string} */ level) =>
    fs.writeFileSync(
      path.join(root, 'eslint.config.mjs'),
      `export default [{ ignores: ['**/tasks/**'] }, { files: ['**/*.js'], rules: { 'prefer-const': '${level}', 'no-undef': 'error' } }];\n`
    );
  const lint = (
    /** @type {Partial<Parameters<typeof runEslint>[0]>} */ o = {}
  ) =>
    runEslint({
      rootDir: root,
      files: ['tasks/demo-261117/a.js'],
      env: {},
      ...o,
    });

  test('should lint files under tasks/ and pass when there are no problems', async () => {
    config('error');
    write({ 'a.js': 'const a = 1;\nexport { a };\n' });

    expect(await lint()).toEqual({ ok: true, output: '1 file(s) lint clean' });
  });

  test('should fail and report errors', async () => {
    config('error');
    write({ 'a.js': 'let a = 1;\nexport { a };\n' });

    const result = await lint();

    expect(result.ok).toBe(false);
    expect(result.output).toContain('prefer-const');
  });

  test('should pass but show warnings', async () => {
    config('warn');
    write({ 'a.js': 'let a = 1;\nexport { a };\n' });

    const result = await lint();

    expect(result.ok).toBe(true);
    expect(result.output).toContain('warning');
  });

  test('should write fixes with fix', async () => {
    config('error');
    write({ 'a.js': 'let a = 1;\nexport { a };\n' });

    const result = await lint({ fix: true });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, 'a.js'), 'utf-8')).toBe(
      'const a = 1;\nexport { a };\n'
    );
  });

  test('should apply runtime and DOM globals', async () => {
    config('error');
    write({
      'a.js': 'window.x = document.title;\n',
      'b.test.js': 'export const p = new DOMParser();\n',
    });

    const result = await lint({
      files: ['tasks/demo-261117/a.js', 'tasks/demo-261117/b.test.js'],
      env: { 'tasks/demo-261117/a.js': 'browser' },
      dom: ['tasks/demo-261117/b.test.js'],
    });

    expect(result).toEqual({ ok: true, output: '2 file(s) lint clean' });
  });
});

describe('runPrettier', () => {
  test('should pass when every file is formatted', async () => {
    write({ 'a.js': 'export const a = 1;\n' });

    const result = await runPrettier({
      rootDir: root,
      files: [path.join(taskDir, 'a.js')],
    });

    expect(result).toEqual({ ok: true, output: '1 file(s) formatted' });
  });

  test('should list unformatted files with a fix hint', async () => {
    write({ 'a.js': 'export const a   =  1\n' });

    const result = await runPrettier({
      rootDir: root,
      files: [path.join(taskDir, 'a.js')],
    });

    expect(result).toEqual({
      ok: false,
      output:
        'not formatted: tasks/demo-261117/a.js\nFix: pnpm task check --fix',
    });
  });

  test('should rewrite unformatted files with fix and leave formatted ones alone', async () => {
    write({
      'a.js': 'export const a   =  1\n',
      'b.js': 'export const b = 2;\n',
    });
    const before = fs.statSync(path.join(taskDir, 'b.js')).mtimeMs;
    const spy = vi.spyOn(fs, 'writeFileSync');

    const result = await runPrettier({
      rootDir: root,
      files: [path.join(taskDir, 'a.js'), path.join(taskDir, 'b.js')],
      fix: true,
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(taskDir, 'a.js'), 'utf-8')).toBe(
      'export const a = 1;\n'
    );
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fs.statSync(path.join(taskDir, 'b.js')).mtimeMs).toBe(before);
    spy.mockRestore();
  });

  test('should report files Prettier cannot parse without a fix hint', async () => {
    write({ 'bad.json': '{ "a": ' });

    const result = await runPrettier({
      rootDir: root,
      files: [path.join(taskDir, 'bad.json')],
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /^cannot format: tasks\/demo-261117\/bad\.json: /
    );
    expect(result.output).not.toContain('Fix:');
  });

  test('should report non-Error throws as text', async () => {
    write({ 'a.js': '' });
    const read = vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal -- covers non-Error throws
      throw 'boom';
    });

    const result = await runPrettier({
      rootDir: root,
      files: [path.join(taskDir, 'a.js')],
    });

    expect(result.output).toBe('cannot format: tasks/demo-261117/a.js: boom');
    read.mockRestore();
  });
});

describe('tsconfigFor', () => {
  test('should target Node only for plain code', () => {
    const config = /** @type {any} */ (
      tsconfigFor({
        files: ['../a.js'],
        browser: false,
        extension: false,
        chromeTypes: false,
      })
    );

    expect(config.compilerOptions.lib).toEqual(['ES2023']);
    expect(config.compilerOptions.types).toEqual(['node', 'vitest/globals']);
    expect(config.compilerOptions.strict).toBe(true);
    expect(config.files).toEqual(['../a.js']);
  });

  test('should add the DOM lib and the chrome stub for an extension without @types/chrome', () => {
    const config = /** @type {any} */ (
      tsconfigFor({
        files: ['../a.js'],
        browser: true,
        extension: true,
        chromeTypes: false,
      })
    );

    expect(config.compilerOptions.lib).toContain('DOM');
    expect(config.files).toEqual(['../a.js', CHROME_STUB_FILE]);
  });

  test('should use @types/chrome when it is installed', () => {
    const config = /** @type {any} */ (
      tsconfigFor({
        files: ['../a.js'],
        browser: true,
        extension: true,
        chromeTypes: true,
      })
    );

    expect(config.compilerOptions.types).toContain('chrome');
    expect(config.files).toEqual(['../a.js']);
  });
});

describe('canResolve', () => {
  test('should find installed packages from the root', () => {
    expect(canResolve(process.cwd(), 'typescript/package.json')).toBe(true);
  });

  test('should be false for missing packages', () => {
    expect(canResolve(process.cwd(), 'no-such-package-xyz/package.json')).toBe(
      false
    );
  });
});

describe('runTsc', () => {
  const rootDir = process.cwd();

  test('should write the tsconfig in tmp/ and pass on exit 0', () => {
    const spawn = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

    const result = runTsc({
      rootDir,
      taskDir,
      files: ['a.js'],
      env: { 'a.js': 'node' },
      spawn,
    });

    const configPath = path.join(taskDir, 'tmp', TSCONFIG_FILE);
    expect(result).toEqual({ ok: true, output: '1 file(s) typecheck clean' });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).files).toEqual([
      '../a.js',
    ]);
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/typescript[\\/]bin[\\/]tsc$/),
        '-p',
        configPath,
        '--pretty',
        'false',
      ],
      expect.objectContaining({ cwd: rootDir })
    );
  });

  test('should write the chrome stub and say so when @types/chrome is missing', () => {
    const spawn = vi.fn(() => ({ status: 1, stdout: 'a.js(1,1): error TS1' }));

    const result = runTsc({
      rootDir,
      taskDir,
      files: ['a.js', 'b.test.js'],
      env: { 'a.js': 'webextension', 'b.test.js': 'extension-node' },
      spawn,
      chromeTypes: false,
    });

    expect(result.ok).toBe(false);
    expect(result.output).toBe(
      'a.js(1,1): error TS1\n(chrome.* is typed as any: @types/chrome is not installed)'
    );
    expect(fs.existsSync(path.join(taskDir, 'tmp', CHROME_STUB_FILE))).toBe(
      true
    );
  });

  test('should use the DOM lib for DOM tests and skip the stub with @types/chrome', () => {
    const spawn = vi.fn(() => ({ status: 0, error: new Error('') }));

    runTsc({
      rootDir,
      taskDir,
      files: ['dom.test.js'],
      env: { 'dom.test.js': 'node' },
      dom: ['dom.test.js'],
      spawn,
      chromeTypes: true,
    });

    const config = JSON.parse(
      fs.readFileSync(path.join(taskDir, 'tmp', TSCONFIG_FILE), 'utf-8')
    );
    expect(config.compilerOptions.lib).toContain('DOM');
    expect(fs.existsSync(path.join(taskDir, 'tmp', CHROME_STUB_FILE))).toBe(
      false
    );
  });

  test('should report real tsc errors', () => {
    write({ 'a.ts': 'export const a: number = "x";\n' });

    const result = runTsc({
      rootDir,
      taskDir,
      files: ['a.ts'],
      env: { 'a.ts': 'node' },
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('error TS');
  });
});

describe('runTaskCheck', () => {
  const pass = { ok: true, output: 'fine' };

  test('should skip a task with no code', async () => {
    write({ 'notes.md': '#' });
    const tools = { eslint: vi.fn(), prettier: vi.fn(), tsc: vi.fn() };

    const result = await runTaskCheck({ rootDir: root, taskDir, tools });

    expect(result).toEqual({ ok: true, skipped: true, parts: [] });
    expect(tools.eslint).not.toHaveBeenCalled();
  });

  test('should run every tool and fail when one fails', async () => {
    write({
      'ext/manifest.json': MANIFEST,
      'ext/src/bg.js': '',
      'ext/test/dom.test.js': '// @vitest-environment happy-dom\n',
      'ext/types.ts': '// @vitest-environment jsdom\n',
    });
    const tools = {
      eslint: vi.fn(async () => pass),
      prettier: vi.fn(async (/** @type {{ files: string[] }} */ _o) => pass),
      tsc: vi.fn((/** @type {{ dom?: string[] }} */ _o) => ({
        ok: false,
        output: 'TS2304',
      })),
    };

    const result = await runTaskCheck({
      rootDir: root,
      taskDir,
      fix: true,
      tools,
    });

    expect(result).toEqual({
      ok: false,
      skipped: false,
      parts: [
        { name: 'eslint', ...pass },
        { name: 'prettier', ...pass },
        { name: 'tsc', ok: false, output: 'TS2304' },
      ],
    });
    expect(tools.eslint).toHaveBeenCalledWith({
      rootDir: root,
      files: [
        'tasks/demo-261117/ext/src/bg.js',
        'tasks/demo-261117/ext/test/dom.test.js',
      ],
      env: {
        'tasks/demo-261117/ext/src/bg.js': 'webextension',
        'tasks/demo-261117/ext/test/dom.test.js': 'extension-node',
      },
      dom: ['tasks/demo-261117/ext/test/dom.test.js'],
      fix: true,
    });
    expect(tools.prettier.mock.calls[0][0].files).toHaveLength(4);
    expect(tools.tsc.mock.calls[0][0].dom).toEqual([
      'ext/test/dom.test.js',
      'ext/types.ts',
    ]);
  });

  test('should only format-check data files', async () => {
    write({ 'data/x.json': '{}' });
    const tools = {
      eslint: vi.fn(),
      prettier: vi.fn(async () => pass),
      tsc: vi.fn(),
    };

    const result = await runTaskCheck({ rootDir: root, taskDir, tools });

    expect(result.parts.map((p) => p.name)).toEqual(['prettier']);
    expect(tools.tsc).not.toHaveBeenCalled();
  });

  test('should use the real tools by default', async () => {
    write({ 'notes.md': '#' });

    expect((await runTaskCheck({ rootDir: root, taskDir })).skipped).toBe(true);
  });
});

describe('formatCheck', () => {
  test('should explain a skipped check', () => {
    expect(formatCheck({ ok: true, skipped: true, parts: [] }, 'demo')).toMatch(
      /^demo has no code to check/
    );
  });

  test('should show every part and the pass line', () => {
    const text = formatCheck(
      {
        ok: true,
        skipped: false,
        parts: [{ name: 'eslint', ok: true, output: 'clean' }],
      },
      'demo'
    );

    expect(text).toBe('✓ eslint\nclean\n\n✓ check passed');
  });

  test('should point at --fix when ESLint or Prettier failed', () => {
    const text = formatCheck(
      {
        ok: false,
        skipped: false,
        parts: [
          { name: 'prettier', ok: false, output: 'not formatted: a.js' },
          { name: 'tsc', ok: false, output: 'TS1' },
        ],
      },
      'demo'
    );

    expect(text).toContain('✗ check failed: prettier, tsc');
    expect(text).toContain('pnpm task check --fix');
  });

  test('should not suggest --fix when only tsc failed', () => {
    const text = formatCheck(
      {
        ok: false,
        skipped: false,
        parts: [{ name: 'tsc', ok: false, output: 'TS1' }],
      },
      'demo'
    );

    expect(text).not.toContain('--fix');
    expect(text).toContain('then re-run: pnpm task check');
  });
});

describe('withCheck', () => {
  test('should leave an empty list empty', () => {
    write({ 'a.js': '' });

    expect(withCheck([], { name: 'demo', taskDir })).toEqual([]);
  });

  test('should not add the check twice', () => {
    write({ 'a.js': '' });
    const commands = [`  ${CHECK_COMMAND} --fix`, 'pnpm test'];

    expect(withCheck(commands, { name: 'demo', taskDir })).toBe(commands);
  });

  test('should not add the check for a task without code', () => {
    expect(withCheck(['pnpm test'], { name: 'demo', taskDir })).toEqual([
      'pnpm test',
    ]);
  });

  test('should prepend the check for a task with code', () => {
    write({ 'scripts/a.js': '' });

    expect(withCheck(['pnpm test'], { name: 'demo', taskDir })).toEqual([
      'pnpm task check --task demo',
      'pnpm test',
    ]);
  });
});
