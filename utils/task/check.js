/**
 * `pnpm task check` — lint, format-check, and typecheck the code inside a task.
 *
 * `tasks/` is git-ignored and excluded from the workspace ESLint, Prettier,
 * and tsc configs, so task code would otherwise never be checked. This runs
 * the same tools with the workspace rules on the task's code files only:
 *
 * - ESLint through its Node API with the workspace flat config, the `tasks/`
 *   ignore lifted, and globals picked per file (Node by default; browser for
 *   files under a folder with an .html page; browser + webextensions +
 *   service worker under a folder whose manifest.json has `manifest_version`).
 *   Tests, e2e specs, scripts, and *.config.* files always get Node globals.
 * - Prettier through its API (the CLI would skip the files: `.prettierignore`
 *   lists `tasks/`).
 * - `tsc --noEmit` with checkJs + strict through a tsconfig generated in the
 *   task's `tmp/` (lib DOM when there is browser code). Without
 *   `@types/chrome`, extension code gets a stub that types `chrome` as `any`.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import globals from 'globals';
import { relPosix } from '../paths.js';

/** Folders skipped at the task's top level: notes, outputs, and scratch. */
export const TOP_LEVEL_SKIP = new Set([
  'tmp',
  'reviews',
  'studies',
  'docs',
  'translated',
  'loop',
  'swarm',
]);
/** Folders skipped at any depth: dependencies and generated output. */
export const ANY_LEVEL_SKIP = new Set([
  'node_modules',
  'coverage',
  'dist',
  'build',
  'test-results',
  'playwright-report',
  'blob-report',
  'venv',
  '__pycache__',
]);
/** Task bookkeeping files written by `pnpm task`, never checked. */
export const TASK_FILES = new Set(['state.json', 'plan.md', 'NOTES.md']);

const LINT_EXT = ['.js', '.mjs', '.cjs', '.jsx'];
const TYPE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const FORMAT_EXT = [...new Set([...LINT_EXT, ...TYPE_EXT])].concat([
  '.json',
  '.css',
  '.html',
]);

/**
 * Code in any language, by extension: what a review reads as the work
 * itself. An allowlist on purpose: an unknown kind of file (a model, a log,
 * an export) must not count as product code (see `hasProductCode`).
 */
const SOURCE_EXT = new Set(
  [
    ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'],
    ['.html', '.htm', '.css', '.scss', '.sass', '.less'],
    ['.vue', '.svelte', '.astro'],
    ['.py', '.pyi', '.ipynb', '.r', '.jl'],
    ['.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.bat', '.cmd'],
    ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.m', '.mm'],
    ['.cs', '.fs', '.vb', '.java', '.kt', '.kts', '.scala', '.groovy'],
    ['.go', '.rs', '.swift', '.dart', '.zig', '.nim'],
    ['.rb', '.php', '.pl', '.pm', '.lua'],
    ['.ex', '.exs', '.erl', '.hs', '.ml', '.clj'],
    ['.sql', '.tf', '.glsl', '.wgsl'],
  ].flat()
);
/** Code files known by name rather than extension. */
const SOURCE_NAMES = new Set([
  'Dockerfile',
  'Containerfile',
  'Makefile',
  'GNUmakefile',
  'Justfile',
  'Rakefile',
]);
/** Config text that belongs with the code it configures. */
const CONFIG_EXT = new Set([
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
]);
/** The review reads `docs/` (a page can be the deliverable); check does not. */
const REVIEW_TOP_SKIP = new Set(
  [...TOP_LEVEL_SKIP].filter((name) => name !== 'docs')
);
/**
 * Config files named like a credential store (`credentials.json`,
 * `client_secret_….json`, `secrets.yaml`, a service-account key): never in a
 * review, whose agents read every file in scope (AGENTS.md: never read
 * secrets).
 */
const SECRET_NAME_RE =
  /(^|[._-])(credentials?|secrets?|service[-_]?account|api[-_]?keys?|private[-_]?key|tokens?|passwords?)([._-]|$)/i;

const NODE_SEGMENTS = new Set(['test', 'tests', '__tests__', 'e2e', 'scripts']);
const NODE_FILE_RE = /\.(test|spec|e2e|config)\.[cm]?[jt]sx?$/;
/** A test that runs in a DOM implementation: Node globals plus browser ones. */
const DOM_PRAGMA_RE = /@(vitest|jest)-environment\s+(jsdom|happy-dom)\b/;

export const TSCONFIG_FILE = 'tsconfig.check.json';
export const CHROME_STUB_FILE = 'chrome-stub.d.ts';

/**
 * @typedef {'node' | 'browser' | 'webextension' | 'extension-node'} FileEnv
 * @typedef {{ lint: string[], format: string[], types: string[], env: Record<string, FileEnv>, dom: string[] }} TaskCode
 * @typedef {{ ok: boolean, output: string }} ToolResult
 * @typedef {{ name: 'eslint' | 'prettier' | 'tsc', ok: boolean, output: string }} CheckPart
 * @typedef {{ ok: boolean, skipped: boolean, parts: CheckPart[] }} CheckResult
 */

/**
 * @param {string} file
 * @param {string[]} extensions
 */
const hasExt = (file, extensions) => extensions.includes(path.extname(file));

/**
 * @param {string} file
 * @returns {boolean} whether `pnpm task check` formats `file` (task code)
 */
export const isCodeFile = (file) => hasExt(file, FORMAT_EXT);

/**
 * @param {string} file
 * @returns {boolean} whether `file` is code in any language (SOURCE_EXT)
 */
export const isSourceFile = (file) =>
  SOURCE_NAMES.has(path.posix.basename(file)) ||
  SOURCE_EXT.has(path.extname(file).toLowerCase());

/**
 * Every regular file under the task, as sorted POSIX paths relative to the
 * task directory. Skips dot-entries, ANY_LEVEL_SKIP folders, `topSkip`
 * folders and TASK_FILES at the top level; links are not followed.
 *
 * @param {string} taskDir
 * @param {Set<string>} topSkip
 * @returns {string[]}
 */
function listTaskFiles(taskDir, topSkip) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} rel */
  const walk = (rel) => {
    const entries = fs.readdirSync(path.join(taskDir, rel), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (ANY_LEVEL_SKIP.has(entry.name)) continue;
        if (!rel && topSkip.has(entry.name)) continue;
        walk(child);
      } else if (entry.isFile()) {
        if (!rel && TASK_FILES.has(entry.name)) continue;
        found.push(child);
      }
    }
  };
  walk('');
  return found.sort();
}

/**
 * Every file under the task that `check` looks at, as sorted POSIX paths
 * relative to the task directory.
 *
 * @param {string} taskDir
 * @returns {string[]}
 */
export function listCodeFiles(taskDir) {
  return listTaskFiles(taskDir, TOP_LEVEL_SKIP).filter(isCodeFile);
}

/**
 * Every file under the task a review reads: code in any language and its
 * config (minus files named like credentials, SECRET_NAME_RE), `docs/`
 * included (unlike `listCodeFiles`), as sorted POSIX paths relative to the
 * task directory.
 *
 * @param {string} taskDir
 * @returns {string[]}
 */
export function listReviewFiles(taskDir) {
  return listTaskFiles(taskDir, REVIEW_TOP_SKIP).filter(
    (file) =>
      isSourceFile(file) ||
      (CONFIG_EXT.has(path.extname(file).toLowerCase()) &&
        !SECRET_NAME_RE.test(path.posix.basename(file)))
  );
}

/**
 * Folders whose code runs in a browser: `webextension` for a folder with an
 * extension manifest, `browser` for a folder with an .html page.
 *
 * @param {string} taskDir
 * @param {string[]} files
 * @returns {Map<string, FileEnv>}
 */
export function browserRoots(taskDir, files) {
  /** @type {Map<string, FileEnv>} */
  const roots = new Map();
  for (const file of files) {
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file);
    if (base === 'manifest.json' && isExtensionManifest(taskDir, file)) {
      roots.set(dir, 'webextension');
    } else if (base.endsWith('.html') && !roots.has(dir)) {
      roots.set(dir, 'browser');
    }
  }
  return roots;
}

/**
 * @param {string} taskDir
 * @param {string} file
 * @returns {boolean}
 */
function isExtensionManifest(taskDir, file) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(taskDir, file), 'utf-8'));
    return (
      Boolean(json) && typeof json === 'object' && 'manifest_version' in json
    );
  } catch {
    return false;
  }
}

/**
 * The runtime a file runs in. Everything under an extension folder is
 * extension code (an .html page inside it, such as an offscreen document,
 * does not change that); under a page folder it is browser code. Tests, e2e
 * specs, scripts, and config files run in Node wherever they are; inside an
 * extension they are `extension-node` (Node plus `chrome`, which tests stub
 * and e2e specs read inside `page.evaluate`).
 *
 * @param {string} file
 * @param {Map<string, FileEnv>} roots
 * @returns {FileEnv}
 */
export function fileEnv(file, roots) {
  const segments = file.split('/');
  const kinds = segments
    .slice(0, -1)
    .map((_, i) => segments.slice(0, i + 1).join('/'))
    .concat('.')
    .map((dir) => roots.get(dir));
  const inExtension = kinds.includes('webextension');
  const runsInNode =
    NODE_FILE_RE.test(segments[segments.length - 1]) ||
    segments.slice(0, -1).some((segment) => NODE_SEGMENTS.has(segment));
  if (runsInNode) return inExtension ? 'extension-node' : 'node';
  if (inExtension) return 'webextension';
  return kinds.includes('browser') ? 'browser' : 'node';
}

/**
 * Group a task's files by tool.
 *
 * @param {string} taskDir
 * @returns {TaskCode}
 */
export function collectTaskCode(taskDir) {
  const files = listCodeFiles(taskDir);
  const roots = browserRoots(taskDir, files);
  /** @type {Record<string, FileEnv>} */
  const env = {};
  /** @type {string[]} */
  const dom = [];
  for (const file of files) {
    if (hasExt(file, LINT_EXT) || hasExt(file, TYPE_EXT)) {
      env[file] = fileEnv(file, roots);
      const head = fs
        .readFileSync(path.join(taskDir, file), 'utf-8')
        .slice(0, 2048);
      if (DOM_PRAGMA_RE.test(head)) dom.push(file);
    }
  }
  return {
    lint: files.filter((file) => hasExt(file, LINT_EXT)),
    format: files,
    types: files.filter((file) => hasExt(file, TYPE_EXT)),
    env,
    dom,
  };
}

/**
 * True when the task has code `check` would lint or typecheck.
 *
 * @param {string} taskDir
 * @returns {boolean}
 */
export function hasTaskCode(taskDir) {
  if (!fs.existsSync(taskDir)) return false;
  const code = collectTaskCode(taskDir);
  return code.lint.length > 0 || code.types.length > 0;
}

/**
 * Globals added on top of the workspace's Node globals. For browser-side
 * files Node globals are switched off (`'off'` removes a global that an
 * earlier config block added), then the browser ones are added back.
 *
 * @param {FileEnv} env
 * @returns {Record<string, 'readonly' | 'writable' | 'off' | boolean>}
 */
export function globalsFor(env) {
  if (env === 'node') return {};
  if (env === 'extension-node') return { ...globals.webextensions };
  const off = Object.fromEntries(
    Object.keys(globals.node).map((name) => [
      name,
      /** @type {'off'} */ ('off'),
    ])
  );
  return {
    ...off,
    ...globals.browser,
    ...(env === 'webextension'
      ? { ...globals.serviceworker, ...globals.webextensions }
      : {}),
  };
}

/** Lifts the workspace's global ignore of the tasks folder (a negated pattern un-ignores). */
export const UNIGNORE_TASKS = { ignores: ['!**/tasks/**'] };

/**
 * Config blocks layered over the workspace eslint.config.js: the `tasks/`
 * ignore lifted, one block per runtime with that runtime's globals, and
 * browser globals for tests that run in a DOM implementation.
 *
 * @param {Record<string, FileEnv>} env file → runtime (paths relative to the ESLint cwd)
 * @param {string[]} [dom] tests with a jsdom/happy-dom environment pragma
 * @returns {object[]}
 */
export function lintOverrides(env, dom = []) {
  /** @type {object[]} */
  const config = [UNIGNORE_TASKS];
  for (const kind of /** @type {FileEnv[]} */ ([
    'browser',
    'webextension',
    'extension-node',
  ])) {
    const files = Object.keys(env).filter((file) => env[file] === kind);
    if (files.length > 0) {
      config.push({ files, languageOptions: { globals: globalsFor(kind) } });
    }
  }
  if (dom.length > 0) {
    config.push({ files: dom, languageOptions: { globals: globals.browser } });
  }
  return config;
}

/**
 * Run ESLint on `files` (relative to `rootDir`) with the eslint.config.js
 * found from `rootDir`, plus `lintOverrides`.
 *
 * @param {{ rootDir: string, files: string[], env: Record<string, FileEnv>, dom?: string[], fix?: boolean }} options
 * @returns {Promise<ToolResult>}
 */
export async function runEslint({
  rootDir,
  files,
  env,
  dom = [],
  fix = false,
}) {
  const { ESLint } = await import('eslint');
  const eslint = new ESLint({
    cwd: rootDir,
    overrideConfig: lintOverrides(env, dom),
    fix,
  });
  const results = await eslint.lintFiles(files);
  if (fix) await ESLint.outputFixes(results);
  const errors = results.reduce((sum, r) => sum + r.errorCount, 0);
  const formatter = await eslint.loadFormatter('stylish');
  const output = String(await formatter.format(results)).trim();
  return {
    ok: errors === 0,
    output: output || `${files.length} file(s) lint clean`,
  };
}

/**
 * Check (or, with `fix`, rewrite) the formatting of `files` (absolute paths).
 *
 * @param {{ files: string[], rootDir: string, fix?: boolean }} options
 * @returns {Promise<ToolResult>}
 */
export async function runPrettier({ files, rootDir, fix = false }) {
  const prettier = await import('prettier');
  /** @type {string[]} */
  const unformatted = [];
  /** @type {string[]} */
  const failures = [];
  for (const file of files) {
    const rel = relPosix(rootDir, file);
    try {
      const source = fs.readFileSync(file, 'utf-8');
      const options = {
        ...(await prettier.resolveConfig(file)),
        filepath: file,
      };
      if (fix) {
        const formatted = await prettier.format(source, options);
        if (formatted !== source) fs.writeFileSync(file, formatted, 'utf-8');
      } else if (!(await prettier.check(source, options))) {
        unformatted.push(rel);
      }
    } catch (error) {
      failures.push(
        `${rel}: ${error instanceof Error ? error.message.split('\n')[0] : error}`
      );
    }
  }
  const lines = [
    ...unformatted.map((rel) => `not formatted: ${rel}`),
    ...failures.map((line) => `cannot format: ${line}`),
  ];
  return {
    ok: lines.length === 0,
    output:
      lines.length === 0
        ? `${files.length} file(s) formatted`
        : `${lines.join('\n')}${unformatted.length > 0 ? '\nFix: pnpm task check --fix' : ''}`,
  };
}

/**
 * The tsconfig for a task's code.
 *
 * @param {{ files: string[], browser: boolean, extension: boolean, chromeTypes: boolean }} options
 *   files are relative to the tsconfig's folder
 * @returns {object}
 */
export function tsconfigFor({ files, browser, extension, chromeTypes }) {
  const types = ['node', 'vitest/globals'];
  if (extension && chromeTypes) types.push('chrome');
  return {
    compilerOptions: {
      target: 'ES2022',
      lib: browser ? ['ES2023', 'DOM', 'DOM.Iterable'] : ['ES2023'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      allowJs: true,
      checkJs: true,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
      types,
    },
    files:
      extension && !chromeTypes ? [...files, CHROME_STUB_FILE] : [...files],
  };
}

/**
 * @param {string} rootDir
 * @param {string} request
 * @returns {boolean}
 */
export function canResolve(rootDir, request) {
  try {
    createRequire(path.join(rootDir, 'package.json')).resolve(request);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {(command: string, args: string[], options: object) => { status: number | null, stdout?: string | null, stderr?: string | null, error?: Error }} Spawn
 */

/** @type {Spawn} */
const defaultSpawn = (command, args, options) =>
  /** @type {ReturnType<Spawn>} */ (
    /** @type {unknown} */ (spawnSync(command, args, options))
  );

/**
 * Typecheck `files` (relative to `taskDir`) with a generated tsconfig in
 * the task's tmp/.
 *
 * @param {{ rootDir: string, taskDir: string, files: string[], env: Record<string, FileEnv>, dom?: string[], spawn?: Spawn, chromeTypes?: boolean }} options
 * @returns {ToolResult}
 */
export function runTsc({
  rootDir,
  taskDir,
  files,
  env,
  dom = [],
  spawn = defaultSpawn,
  chromeTypes = canResolve(rootDir, '@types/chrome/package.json'),
}) {
  const tmpDir = path.join(taskDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const kinds = new Set(files.map((file) => env[file]));
  const extension = kinds.has('webextension') || kinds.has('extension-node');
  const config = tsconfigFor({
    files: files.map((file) => path.posix.join('..', file)),
    browser: extension || kinds.has('browser') || dom.length > 0,
    extension,
    chromeTypes,
  });
  const configPath = path.join(tmpDir, TSCONFIG_FILE);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  if (extension && !chromeTypes) {
    fs.writeFileSync(
      path.join(tmpDir, CHROME_STUB_FILE),
      '// Written by pnpm task check: @types/chrome is not installed, so chrome.* is untyped.\ndeclare const chrome: any;\n',
      'utf-8'
    );
  }
  const tsc = path.join(
    path.dirname(
      createRequire(path.join(rootDir, 'package.json')).resolve(
        'typescript/package.json'
      )
    ),
    'bin',
    'tsc'
  );
  const result = spawn(
    process.execPath,
    [tsc, '-p', configPath, '--pretty', 'false'],
    { cwd: rootDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }
  );
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join('\n')
    .trim();
  const note =
    extension && !chromeTypes
      ? '\n(chrome.* is typed as any: @types/chrome is not installed)'
      : '';
  return {
    ok: result.status === 0,
    output: `${output || `${files.length} file(s) typecheck clean`}${note}`,
  };
}

/**
 * @typedef {{
 *   eslint: typeof runEslint,
 *   prettier: typeof runPrettier,
 *   tsc: typeof runTsc,
 * }} CheckTools
 */

/** @type {CheckTools} */
export const DEFAULT_TOOLS = {
  eslint: runEslint,
  prettier: runPrettier,
  tsc: runTsc,
};

/**
 * Run every check on a task's code. All three run even when one fails, so
 * one pass shows everything to fix.
 *
 * @param {{ rootDir: string, taskDir: string, fix?: boolean, tools?: CheckTools }} options
 * @returns {Promise<CheckResult>}
 */
export async function runTaskCheck({
  rootDir,
  taskDir,
  fix = false,
  tools = DEFAULT_TOOLS,
}) {
  const code = collectTaskCode(taskDir);
  const prefix = relPosix(rootDir, taskDir);
  /** @param {string} file */
  const fromRoot = (file) => `${prefix}/${file}`;
  /** @type {CheckPart[]} */
  const parts = [];

  if (code.lint.length > 0) {
    const env = Object.fromEntries(
      code.lint.map((file) => [fromRoot(file), code.env[file]])
    );
    const result = await tools.eslint({
      rootDir,
      files: code.lint.map(fromRoot),
      env,
      dom: code.dom.filter((file) => code.lint.includes(file)).map(fromRoot),
      fix,
    });
    parts.push({ name: 'eslint', ...result });
  }
  if (code.format.length > 0) {
    const result = await tools.prettier({
      rootDir,
      files: code.format.map((file) => path.join(taskDir, file)),
      fix,
    });
    parts.push({ name: 'prettier', ...result });
  }
  if (code.types.length > 0) {
    const result = tools.tsc({
      rootDir,
      taskDir,
      files: code.types,
      env: code.env,
      dom: code.dom,
    });
    parts.push({ name: 'tsc', ...result });
  }
  return {
    ok: parts.every((part) => part.ok),
    skipped: parts.length === 0,
    parts,
  };
}

/**
 * Human-readable report of a check run.
 *
 * @param {CheckResult} result
 * @param {string} name task name
 * @returns {string}
 */
export function formatCheck(result, name) {
  if (result.skipped) {
    return `${name} has no code to check (looked outside tmp/, reviews/, studies/, docs/, translated/).`;
  }
  const sections = result.parts.map(
    (part) => `${part.ok ? '✓' : '✗'} ${part.name}\n${part.output}`
  );
  const failed = result.parts.filter((part) => !part.ok).map((p) => p.name);
  sections.push(
    result.ok
      ? '✓ check passed'
      : `✗ check failed: ${failed.join(', ')}\nFix the problems above${failed.some((n) => n !== 'tsc') ? ' (pnpm task check --fix rewrites what ESLint and Prettier can fix)' : ''}, then re-run: pnpm task check`
  );
  return sections.join('\n\n');
}

/** The command `verify` prepends for tasks with code. */
export const CHECK_COMMAND = 'pnpm task check';

/**
 * Verify commands with `pnpm task check` in front when the task has code
 * and the list does not run it already. An empty list stays empty (no
 * verify configured is reported elsewhere).
 *
 * @param {string[]} commands
 * @param {{ name: string, taskDir: string }} task
 * @returns {string[]}
 */
export function withCheck(commands, { name, taskDir }) {
  if (commands.length === 0) return commands;
  if (commands.some((command) => command.trim().startsWith(CHECK_COMMAND))) {
    return commands;
  }
  if (!hasTaskCode(taskDir)) return commands;
  return [`${CHECK_COMMAND} --task ${name}`, ...commands];
}
