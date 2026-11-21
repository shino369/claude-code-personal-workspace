import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { main } from '../cli-docs.js';
import { ROOT_DIR } from '../workspace-config.js';

const PACKAGE_FILE = 'package.json';
const DOC = 'docs/cli.md';
const HELP = 'Usage: sample\r\n\r\n  --example <value>\r\n';

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-docs-'));
  fs.copyFileSync(
    path.join(ROOT_DIR, PACKAGE_FILE),
    path.join(root, PACKAGE_FILE)
  );
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string[]} [argv] @param {Partial<import('../cli-docs.js').Deps>} [overrides] */
function run(argv = [], overrides = {}) {
  /** @type {string[]} */
  const lines = [];
  const code = main({
    argv,
    deps: {
      rootDir: root,
      runHelp: () => ({ status: 0, stdout: HELP }),
      log: (line) => lines.push(line),
      ...overrides,
    },
  });
  return { code, out: lines.join('\n') };
}

const read = () => fs.readFileSync(path.join(root, DOC), 'utf8');

/** @param {Record<string, string>} updates */
function changeScripts(updates) {
  const file = path.join(root, PACKAGE_FILE);
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(pkg.scripts, updates);
  fs.writeFileSync(file, JSON.stringify(pkg));
}

test('should generate a reference from the CLI help sources and package scripts', () => {
  const result = run([], {
    runHelp: (entry, arg) => ({
      status: 0,
      stdout: HELP.replace('sample', `${entry} ${arg}`),
    }),
  });

  expect(result).toEqual({ code: 0, out: 'Wrote docs/cli.md' });
  const document = read();
  expect(document).toContain('[`pnpm memory`](#pnpm-memory)');
  expect(document).toContain(
    'Usage: utils/memory/cli.js --help\n\n  --example <value>\n'
  );
  expect(document).toContain('Usage: utils/harness/cli.js help');
  expect(document).toContain('Usage: utils/skills-install.js --help');
  expect(document).toContain('Usage: utils/skills-link.js --help');
  expect(document).toContain(
    '## `pnpm workspace:setup` and `pnpm workspace:check`'
  );
  expect(document).toContain('- `pnpm skills:update`');
  expect(document).not.toContain('\r');
});

test('should report a missing reference in check mode and create it in update mode', () => {
  const result = run(['--check']);

  expect(result.code).toBe(1);
  expect(result.out).toMatch(
    /docs\/cli\.md is missing[\s\S]*Fix: pnpm docs:cli/
  );
  expect(fs.existsSync(path.join(root, DOC))).toBe(false);
  expect(run().code).toBe(0);
  expect(run(['--check']).code).toBe(0);
});

test('should detect stale documentation without editing it', () => {
  run();
  const file = path.join(root, DOC);
  fs.appendFileSync(file, 'Old content\n');

  const result = run(['--check']);

  expect(result.code).toBe(1);
  expect(result.out).toMatch(
    /docs\/cli\.md is out of date[\s\S]*Fix: pnpm docs:cli/
  );
  expect(read()).toContain('Old content');
  expect(run().code).toBe(0);
  expect(read()).not.toContain('Old content');
});

test('should keep a current reference on repeated generation and accept Windows line endings', () => {
  run();
  const document = read().replaceAll('\n', '\r\n');
  fs.writeFileSync(path.join(root, DOC), document);

  expect(run()).toEqual({ code: 0, out: '✓ docs/cli.md is up to date' });
  expect(run(['--check']).code).toBe(0);
  expect(read()).toBe(document);
});

test.each([
  { status: 1, stdout: '' },
  { status: null, stdout: null },
  { status: 0, stdout: '' },
])(
  'should preserve the existing document when a help source fails (%j)',
  (failure) => {
    run();
    const previous = read();

    expect(() => run([], { runHelp: () => failure })).toThrow(
      /help for pnpm agent/
    );
    expect(read()).toBe(previous);
  }
);

test.each([
  'node utils/example/cli.js',
  'node ./utils/example/cli.js',
  'node "utils/example/cli.js"',
  'node --enable-source-maps utils/example/cli.js',
])('should require a help source for an additional CLI under %s', (script) => {
  changeScripts({ example: script });

  expect(() => run()).toThrow(/Missing help source for pnpm example/);
});

test('should read registered scripts with an explicit relative path', () => {
  changeScripts({
    agent: 'node "./utils/agent/cli.js"',
    'workspace:check': 'node ./utils/workspace-setup.js --check',
  });

  expect(run().code).toBe(0);
});

test.each([
  'node utils/workspace-setup.js',
  'pnpm other',
  'node utils/agent/cli.js --check',
])('should reject a changed workspace check alias (%s)', (script) => {
  changeScripts({ 'workspace:check': script });

  expect(() => run()).toThrow(/pnpm workspace:check has changed/);
});

test('should reject a missing workspace setup entry point', () => {
  changeScripts({ 'workspace:setup': 'pnpm other' });

  expect(() => run()).toThrow(/pnpm workspace:check has changed/);
});

test.each([
  'pnpm other',
  'node utils/agent/cli.js ask',
  'node --enable-source-maps utils/agent/cli.js',
])('should reject a changed source script (%s)', (script) => {
  changeScripts({ agent: script });

  expect(() => run()).toThrow(
    /Cannot locate the Node entry point for pnpm agent/
  );
});

test.each(['--help', '-h'])('should show usage for %s', (flag) => {
  const { code, out } = run([flag]);

  expect(code).toBe(0);
  expect(out).toContain('Usage: pnpm docs:cli [--check]');
  expect(fs.existsSync(path.join(root, DOC))).toBe(false);
});

test.each([[['--unknown']], [['--check', '--help']]])(
  'should reject unsupported arguments %j',
  (argv) => {
    expect(() => run(argv)).toThrow(/Usage: pnpm docs:cli/);
  }
);

test('should use the process arguments when called with no options', () => {
  const previous = process.argv;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    process.argv = ['node', 'utils/cli-docs.js', '--help'];

    expect(main()).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('Usage: pnpm docs:cli')
    );
  } finally {
    process.argv = previous;
    log.mockRestore();
  }
});

test('should keep the checked-in reference in sync with the live CLI help', () => {
  const lines = /** @type {string[]} */ ([]);
  const code = main({
    argv: ['--check'],
    deps: { log: (line) => lines.push(line) },
  });

  expect(code, lines.join('\n')).toBe(0);
}, 30_000);

test('should return a nonzero process exit code when the reference is stale', () => {
  // Simulate stale content in the CLI process without editing the checkout.
  const staleRead = `import fs from 'node:fs';
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) =>
      file === ${JSON.stringify(path.join(ROOT_DIR, DOC))} ? 'Stale reference\\n' : read(file, ...args);`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(staleRead)}`,
      'utils/cli-docs.js',
      '--check',
    ],
    { cwd: ROOT_DIR, encoding: 'utf8', timeout: 25_000 }
  );

  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toContain('docs/cli.md is out of date');
  expect(result.stdout).toContain('Fix: pnpm docs:cli');
}, 30_000);
