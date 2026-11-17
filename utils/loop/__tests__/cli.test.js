import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createState } from '../../task/state.js';
import { saveState, tasksRoot, writeActive } from '../../task/store.js';
import { ROOT_DIR } from '../../workspace-config.js';
import { HELP, defaultCliDeps, main, parseArgs } from '../cli.js';
import { worktreePath } from '../worktree.js';

const NAME = 'demo-261117';
const NOW = new Date(2026, 10, 17, 9, 30);

/** @type {string} */
let base;
/** @type {string} */
let repo;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args],
    { cwd, encoding: 'utf-8' }
  );
  if (result.status !== 0) throw new Error(result.stderr);
}

/**
 * @param {string} root
 * @param {string[]} [verify]
 */
function seedTask(root, verify = ['pnpm test']) {
  const dir = path.join(tasksRoot(root), NAME);
  fs.mkdirSync(dir, { recursive: true });
  saveState(dir, createState({ name: NAME, goal: 'G', verify, now: NOW }));
  writeActive(root, NAME);
}

/** @param {Array<boolean>} outcomes */
function verifySequence(outcomes) {
  let call = 0;
  return vi.fn(
    /** @param {{ commands: string[] }} options */
    ({ commands }) => {
      const ok = outcomes[Math.min(call++, outcomes.length - 1)];
      return [
        {
          command: commands[0],
          ok,
          code: ok ? 0 : 1,
          durationMs: 1,
          output: ok ? 'ok' : 'boom',
        },
      ];
    }
  );
}

/**
 * @param {string[]} argv
 * @param {Partial<import('../cli.js').CliDeps>} [deps]
 */
function run(argv, deps = {}) {
  /** @type {string[]} */
  const logs = [];
  const runAgent = vi.fn((/** @type {{ cwd: string }} */ { cwd }) => {
    fs.appendFileSync(path.join(cwd, 'touched.txt'), 'x');
    return { code: 0, signal: null, output: 'ok', stdout: 'ok', durationMs: 1 };
  });
  const code = main({
    argv,
    deps: {
      rootDir: repo,
      env: {},
      log: (message) => logs.push(message),
      clock: () => 0,
      date: () => NOW,
      spawn: spawnSync,
      install: () => ({ status: 0 }),
      runAgent,
      runCommands: verifySequence([false, true]),
      ...deps,
    },
  });
  return { code, out: logs.join('\n'), runAgent };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cli-'));
  repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'tasks/\nnode_modules/\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'init']);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('should apply defaults', () => {
    expect(parseArgs(['--agent', 'claude'])).toEqual({
      task: undefined,
      agent: 'claude',
      bin: undefined,
      max: 5,
      stall: 2,
      timeoutMin: 60,
      iterationTimeoutMin: 20,
      maxBudgetUsd: undefined,
      dryRun: false,
      help: false,
    });
  });

  test('should read every option, with = or a separate value', () => {
    expect(
      parseArgs([
        'demo',
        '--agent=dsh',
        '--max',
        '3',
        '--stall=1',
        '--timeout-min',
        '30',
        '--iteration-timeout-min',
        '0.5',
        '--bin',
        'npx -y @deepseek-ai/dsh',
        '--max-budget-usd',
        '2',
        '--dry-run',
        '-h',
      ])
    ).toEqual({
      task: 'demo',
      agent: 'dsh',
      bin: 'npx -y @deepseek-ai/dsh',
      max: 3,
      stall: 1,
      timeoutMin: 30,
      iterationTimeoutMin: 0.5,
      maxBudgetUsd: 2,
      dryRun: true,
      help: true,
    });
  });

  test('should reject a flag without a value', () => {
    expect(() => parseArgs(['--agent'])).toThrow('--agent needs a value');
  });

  test('should reject unknown options and extra positionals', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown option: --nope');
    expect(() => parseArgs(['a', 'b'])).toThrow('one task name');
  });

  test('should reject bad numbers', () => {
    expect(() => parseArgs(['--max', '0'])).toThrow(/--max must be/);
    expect(() => parseArgs(['--timeout-min', 'x'])).toThrow(
      '--timeout-min must be a positive number (got "x")'
    );
    expect(() => parseArgs(['--iteration-timeout-min', '-1'])).toThrow(
      /--iteration-timeout-min/
    );
    expect(() => parseArgs(['--max-budget-usd', '0'])).toThrow(
      /--max-budget-usd/
    );
  });
});

describe('main', () => {
  test('should print help', () => {
    expect(run(['--help'])).toMatchObject({ code: 0, out: HELP });
  });

  test('should require --agent with a Fix line', () => {
    expect(() => run([NAME])).toThrow(
      `--agent is required.\nFix: pnpm loop ${NAME} --agent claude|codex|dsh`
    );
    expect(() => run([])).toThrow('pnpm loop <task> --agent');
  });

  test('should reject a task without state.json', () => {
    fs.mkdirSync(path.join(tasksRoot(repo), NAME), { recursive: true });
    fs.writeFileSync(path.join(tasksRoot(repo), NAME, 'plan.md'), 'Goal: G\n');
    expect(() => run([NAME, '--agent', 'codex'])).toThrow(
      /no state\.json.*\nFix: pnpm task init/s
    );
  });

  test('should reject a task without verify commands', () => {
    seedTask(repo, []);
    expect(() => run([NAME, '--agent', 'codex'])).toThrow(
      /no verify commands.*\nFix: pnpm task set/s
    );
  });

  test('should print the plan on a dry run and start nothing', () => {
    seedTask(repo);
    const { code, out, runAgent } = run(['--agent', 'dsh', '--dry-run']);
    expect(code).toBe(0);
    expect(out).toContain(
      'Agent: dsh --profile headless --permission-mode workspace-write --approval-policy never - (prompt on stdin)'
    );
    expect(out).toContain('Verify: pnpm test');
    expect(out).toContain(`Worktree: ${worktreePath(repo, NAME)}`);
    expect(runAgent).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreePath(repo, NAME))).toBe(false);
  });

  test('should take the executable from the tool registry unless --bin is given', () => {
    seedTask(repo);
    fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tools', 'local.json'),
      JSON.stringify({
        version: 1,
        updatedAt: null,
        tools: [
          {
            name: 'dsh',
            kind: 'agent',
            path: null,
            command: 'npx -y @deepseek-ai/dsh',
            version: null,
            source: 'manual',
            ok: true,
            checkedAt: NOW.toISOString(),
          },
        ],
      })
    );
    expect(run(['--agent', 'dsh', '--dry-run']).out).toContain(
      'Agent: npx -y @deepseek-ai/dsh --profile headless'
    );
    expect(
      run(['--agent', 'dsh', '--dry-run', '--bin', 'mydsh']).out
    ).toContain('Agent: mydsh --profile headless');
  });

  test('should run in place inside a linked worktree', () => {
    const linked = path.join(base, 'linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'x', linked]);
    seedTask(linked);

    const { code, out } = run([NAME, '--agent', 'codex'], {
      rootDir: linked,
      install: undefined,
    });

    expect(code).toBe(0);
    expect(out).toContain(`Running in this worktree: ${linked}`);
    expect(out).toContain(
      '✓ demo-261117: verify passed after 1 agent iteration(s).'
    );
    expect(out).toContain('Review the diff here');
  });

  test('should create a worktree from the main checkout and warn about local changes', () => {
    seedTask(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), 'local\n');

    const { code, out } = run([NAME, '--agent', 'claude']);

    const dir = worktreePath(repo, NAME);
    expect(code).toBe(0);
    expect(out).toContain('! The main checkout has uncommitted changes');
    expect(out).toContain(`Worktree: ${dir} (created)`);
    expect(out).toContain(`Review: cd ${dir} && git diff`);
    expect(fs.existsSync(path.join(dir, 'touched.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repo, 'touched.txt'))).toBe(false);
  });

  test('should reuse the worktree and exit 1 with no progress', () => {
    seedTask(repo);
    run([NAME, '--agent', 'codex', '--dry-run']);
    run([NAME, '--agent', 'codex']);

    const { code, out } = run([NAME, '--agent', 'codex'], {
      runCommands: verifySequence([false]),
    });

    expect(code).toBe(1);
    expect(out).toContain('(reused)');
    expect(out).toContain('✗ demo-261117: no progress — `pnpm test` fails.');
  });

  test('should report the wall-clock cap', () => {
    seedTask(repo);
    let time = 0;
    const { code, out } = run(
      [NAME, '--agent', 'codex', '--timeout-min', '1'],
      { clock: () => (time += 61 * 1000), runCommands: verifySequence([false]) }
    );
    expect(code).toBe(1);
    expect(out).toContain('wall-clock cap reached');
  });

  test('should report a run that is still failing at the cap', () => {
    seedTask(repo);
    let call = 0;
    const { code, out } = run([NAME, '--agent', 'codex', '--max', '1'], {
      runCommands: vi.fn(({ commands }) => [
        {
          command: commands[0],
          ok: false,
          code: 1,
          durationMs: 1,
          output: `failure ${call++}`,
        },
      ]),
    });
    expect(code).toBe(1);
    expect(out).toContain('still failing after 1 iteration(s)');
  });
});

describe('defaultCliDeps', () => {
  test('should default to the workspace and real processes', () => {
    const deps = defaultCliDeps();
    expect(deps.rootDir).toBe(ROOT_DIR);
    expect(deps.spawn).toBe(spawnSync);
    expect(deps.date()).toBeInstanceOf(Date);
    expect(deps.install).toBeUndefined();
  });
});
