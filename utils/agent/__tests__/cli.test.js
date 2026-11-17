import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { writeActive } from '../../task/store.js';
import { ROOT_DIR } from '../../workspace-config.js';
import {
  DEFAULT_TIMEOUT_MIN,
  HELP,
  defaultAgentDeps,
  fence,
  answerOf,
  formatRecord,
  main,
  parseArgs,
  recordPath,
} from '../cli.js';

const NOW = new Date(2026, 10, 17, 9, 30, 5);
const TASK = 'demo-261117';

/** @typedef {Parameters<typeof import('../../loop/adapters.js').runAgent>[0]} AgentCall */

/** @type {string} */
let root;

/**
 * Fake git: `linked` makes --git-dir differ from --git-common-dir; `broken`
 * makes every git call fail (not a repository).
 *
 * @param {{ linked?: boolean, broken?: boolean }} [options]
 */
const fakeGit =
  ({ linked = false, broken = false } = {}) =>
  (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    if (broken) return { status: 128, stdout: '' };
    const common = args.includes('--git-common-dir');
    return {
      status: 0,
      stdout: linked && !common ? '/repo/.git/worktrees/x' : '/repo/.git',
    };
  };

/**
 * @param {string[]} argv
 * @param {Partial<import('../cli.js').AgentDeps>} [deps]
 */
function run(argv, deps = {}) {
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const warnings = [];
  const runAgent = vi.fn((/** @type {AgentCall} */ _call) => ({
    code: 0,
    signal: null,
    output: 'thinking…\nThe answer.\n',
    stdout: 'The answer.\n',
    durationMs: 2400,
  }));
  const code = main({
    argv,
    deps: {
      rootDir: root,
      env: { HOME: '/home/t' },
      log: (message) => logs.push(message),
      warn: (message) => warnings.push(message),
      now: () => NOW,
      spawn: fakeGit(),
      runAgent,
      readStdin: () => '',
      ...deps,
    },
  });
  return {
    code,
    out: logs.join('\n'),
    err: warnings.join('\n'),
    runAgent: /** @type {typeof runAgent} */ (deps.runAgent ?? runAgent),
  };
}

const makeTask = () => {
  fs.mkdirSync(path.join(root, 'tasks', TASK), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks', TASK, 'plan.md'), 'Goal: G\n');
};

/** @param {string} relative */
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf-8');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseArgs', () => {
  test('should apply defaults', () => {
    expect(parseArgs(['ask', 'hello', 'there'])).toEqual({
      command: 'ask',
      agent: undefined,
      write: false,
      timeoutMin: DEFAULT_TIMEOUT_MIN,
      bin: undefined,
      out: undefined,
      task: undefined,
      json: false,
      help: false,
      prompt: ['hello', 'there'],
    });
  });

  test('should read every option, with = or a separate value', () => {
    expect(
      parseArgs([
        'ask',
        '--agent=codex',
        '--write',
        '--timeout-min',
        '2.5',
        '--bin',
        'npx -y x',
        '--out',
        'a.md',
        '--task',
        'demo',
        '--json',
        '-h',
        '-',
      ])
    ).toEqual({
      command: 'ask',
      agent: 'codex',
      write: true,
      timeoutMin: 2.5,
      bin: 'npx -y x',
      out: 'a.md',
      task: 'demo',
      json: true,
      help: true,
      prompt: ['-'],
    });
  });

  test('should reject a flag without a value and unknown options', () => {
    expect(() => parseArgs(['ask', '--agent'])).toThrow(
      '--agent needs a value.\nFix: pnpm agent help'
    );
    expect(() => parseArgs(['ask', '--yolo'])).toThrow(
      'Unknown option: --yolo\nFix: pnpm agent help'
    );
  });

  test.each(['0', '-1', 'soon'])('should reject --timeout-min %s', (value) => {
    expect(() => parseArgs(['ask', '--timeout-min', value])).toThrow(
      /--timeout-min must be a positive number.*\nFix: --timeout-min 10/s
    );
  });
});

describe('fence', () => {
  test('should outgrow any backtick run in the text', () => {
    expect(fence('plain')).toBe('```');
    expect(fence('a ```js``` b `x`')).toBe('````');
    expect(fence('`````')).toBe('``````');
  });
});

describe('recordPath', () => {
  test('should honor --out relative to the root', () => {
    expect(
      recordPath({ rootDir: root, agent: 'codex', out: 'x/y.md', now: NOW })
    ).toBe(path.join(root, 'x', 'y.md'));
  });

  test('should use the named task, then the active task, then logs/', () => {
    expect(recordPath({ rootDir: root, agent: 'codex', now: NOW })).toBe(
      path.join(root, 'logs', '20261117', 'agent-codex-093005.md')
    );
    makeTask();
    expect(
      recordPath({ rootDir: root, agent: 'dsh', task: 'demo', now: NOW })
    ).toBe(
      path.join(root, 'tasks', TASK, 'tmp', 'agent-dsh-20261117093005.md')
    );
    writeActive(root, TASK);
    expect(recordPath({ rootDir: root, agent: 'claude', now: NOW })).toBe(
      path.join(root, 'tasks', TASK, 'tmp', 'agent-claude-20261117093005.md')
    );
  });
});

describe('formatRecord', () => {
  test('should record the command, result, prompt, and output', () => {
    const text = formatRecord({
      command: { agent: 'codex', bin: 'codex', args: ['exec', '-'] },
      mode: 'read',
      cwd: '/repo',
      at: NOW,
      prompt: 'Why?',
      result: {
        code: 0,
        signal: null,
        output: 'progress log\nUse ```x```',
        stdout: 'Use ```x```',
        durationMs: 1500,
      },
    });
    expect(text).toContain('# Agent call — codex (read)');
    expect(text).toContain('- When: 2026-11-17 09:30');
    expect(text).toContain('- Command: `codex exec -` (prompt on stdin)');
    expect(text).toContain('- Cwd: /repo');
    expect(text).toContain('- Result: exit 0 in 2s');
    expect(text).toContain('```\nWhy?\n```');
    expect(text).toContain('## Answer (stdout)\n\n````\nUse ```x```\n````');
    expect(text).toContain(
      '## Full output (stdout + stderr)\n\n````\nprogress log\nUse ```x```\n````'
    );
  });

  test('should fall back to the full output when stdout is empty', () => {
    expect(
      answerOf({
        code: 1,
        signal: null,
        output: 'error: boom',
        stdout: ' \n',
        durationMs: 1,
      })
    ).toBe('error: boom');
  });

  test('should show a timeout signal', () => {
    expect(
      formatRecord({
        command: { agent: 'dsh', bin: 'dsh', args: [] },
        mode: 'write',
        cwd: '/',
        at: NOW,
        prompt: 'p',
        result: {
          code: null,
          signal: 'SIGTERM',
          output: '',
          stdout: '',
          durationMs: 0,
        },
      })
    ).toContain('- Result: stopped by SIGTERM in 0s');
  });
});

describe('main', () => {
  test.each([[[]], [['help']], [['ask', '--help']]])(
    'should print help for %j',
    (argv) => {
      const { code, out } = run(argv);
      expect(code).toBe(0);
      expect(out).toBe(HELP);
      expect(HELP).toContain('pnpm tools list');
    }
  );

  test('should reject an unknown command with a Fix line', () => {
    expect(() => run(['tell'])).toThrow(
      /Unknown command "tell"\.\nFix: pnpm agent ask --agent claude\|codex\|dsh/
    );
  });

  test('should require --agent and a prompt', () => {
    expect(() => run(['ask', 'hi'])).toThrow(/--agent is required\.\nFix:/);
    expect(() => run(['ask', '--agent', 'codex'])).toThrow(
      /No prompt given\.\nFix: pnpm agent ask --agent codex/
    );
    expect(() => run(['ask', '--agent', 'codex', '-'])).toThrow(
      /stdin was empty\.\nFix:/
    );
  });

  test('should reject an unknown agent with the adapter Fix line', () => {
    expect(() => run(['ask', '--agent', 'opencode', 'hi'])).toThrow(
      /Fix: use --agent claude\|codex\|dsh/
    );
  });

  test('should run a read-only turn, print the answer, and save a record', () => {
    const { code, out, err, runAgent } = run([
      'ask',
      '--agent',
      'codex',
      'What',
      'is',
      'this?',
    ]);

    expect(code).toBe(0);
    expect(out).toBe('The answer.');
    expect(runAgent).toHaveBeenCalledWith({
      command: {
        agent: 'codex',
        bin: 'codex',
        args: ['exec', '--sandbox', 'read-only', '--ephemeral', '-'],
      },
      cwd: root,
      prompt: 'What is this?',
      timeoutMs: DEFAULT_TIMEOUT_MIN * 60 * 1000,
      env: { HOME: '/home/t', TASK_INNER_LOOP: 'off', TASK_AGENT: 'codex' },
    });
    // Shown with / on every OS; read() joins it natively.
    const record = 'logs/20261117/agent-codex-093005.md';
    expect(err).toBe(`(codex, read: exit 0; record: ${record})`);
    expect(read(record)).toContain('# Agent call — codex (read)');
    expect(read(record)).toContain('What is this?');
  });

  test('should read the prompt from stdin and save under the active task', () => {
    makeTask();
    writeActive(root, TASK);
    const { runAgent } = run(['ask', '--agent', 'claude', '-'], {
      readStdin: () => '  review utils/loop  \n',
    });
    expect(runAgent.mock.calls[0][0]).toMatchObject({
      prompt: 'review utils/loop',
    });
    expect(fs.readdirSync(path.join(root, 'tasks', TASK, 'tmp'))).toEqual([
      'agent-claude-20261117093005.md',
    ]);
  });

  test('should take the executable from the registry unless --bin is given', () => {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(
      path.join(root, 'tools', 'local.json'),
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
    const registry = run(['ask', '--agent', 'dsh', 'hi']).runAgent;
    expect(registry.mock.calls[0][0]).toMatchObject({
      command: {
        bin: 'npx',
        args: [
          '-y',
          '@deepseek-ai/dsh',
          '--profile',
          'headless',
          '--permission-mode',
          'read-only',
          '--approval-policy',
          'never',
          '-',
        ],
      },
    });
    const explicit = run([
      'ask',
      '--agent',
      'dsh',
      '--bin',
      'mydsh',
      'hi',
    ]).runAgent;
    expect(explicit.mock.calls[0][0]).toMatchObject({
      command: { bin: 'mydsh' },
    });
  });

  test('should warn about --write in the main checkout or outside git', () => {
    for (const spawn of [fakeGit(), fakeGit({ broken: true })]) {
      const { err, runAgent } = run(
        ['ask', '--agent', 'codex', '--write', 'fix it'],
        { spawn }
      );
      expect(err).toContain(
        '! --write in the main checkout: codex may edit your working tree'
      );
      expect(runAgent.mock.calls[0][0]).toMatchObject({
        command: {
          args: ['exec', '--sandbox', 'workspace-write', '--ephemeral', '-'],
        },
      });
    }
  });

  test('should not warn about --write inside a linked worktree', () => {
    const { err } = run(['ask', '--agent', 'codex', '--write', 'fix it'], {
      spawn: fakeGit({ linked: true }),
    });
    expect(err).not.toContain('--write in the main checkout');
  });

  test('should print JSON and save to --out', () => {
    const { out } = run([
      'ask',
      '--agent',
      'codex',
      '--json',
      '--out',
      'review.md',
      'hi',
    ]);
    expect(JSON.parse(out)).toEqual({
      ok: true,
      agent: 'codex',
      mode: 'read',
      code: 0,
      signal: null,
      durationMs: 2400,
      record: 'review.md',
      answer: 'The answer.\n',
      output: 'thinking…\nThe answer.\n',
    });
    expect(read('review.md')).toContain('# Agent call — codex (read)');
  });

  test('should pass the agent exit code through, and exit 1 when it was stopped', () => {
    const failed = vi.fn(() => ({
      code: 3,
      signal: null,
      output: 'no',
      stdout: '',
      durationMs: 1,
    }));
    expect(
      run(['ask', '--agent', 'codex', 'hi'], { runAgent: failed }).code
    ).toBe(3);

    const stopped = vi.fn((/** @type {AgentCall} */ _call) => ({
      code: null,
      signal: 'SIGTERM',
      output: '',
      stdout: '',
      durationMs: 1,
    }));
    const result = run(
      ['ask', '--agent', 'codex', '--json', '--timeout-min', '0.5', 'hi'],
      { runAgent: stopped }
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      ok: false,
      signal: 'SIGTERM',
    });
    expect(stopped.mock.calls[0][0]).toMatchObject({ timeoutMs: 30_000 });

    const text = run(['ask', '--agent', 'codex', 'hi'], { runAgent: stopped });
    expect(text.err).toContain('(codex, read: stopped by SIGTERM; record:');
  });
});

describe('defaultAgentDeps', () => {
  test('should default to the workspace and real processes', () => {
    const deps = defaultAgentDeps();
    expect(deps.rootDir).toBe(ROOT_DIR);
    expect(deps.env).toBe(process.env);
    expect(deps.now()).toBeInstanceOf(Date);
    expect(typeof deps.spawn).toBe('function');
    expect(typeof deps.readStdin).toBe('function');
    expect(defaultAgentDeps({ rootDir: '/x' }).rootDir).toBe('/x');
  });
});
