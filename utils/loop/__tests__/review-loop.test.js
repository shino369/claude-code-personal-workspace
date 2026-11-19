import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { main as taskMain } from '../../task/cli.js';
import { scopeFingerprint } from '../../task/loop.js';
import { createState, makeSteps } from '../../task/state.js';
import { loadTask, saveState, tasksRoot } from '../../task/store.js';
import { buildCommand } from '../adapters.js';
import {
  BEGIN,
  END,
  extractRows,
  pendingFixes,
  replaceRows,
  reviewerProblems,
  reviewerPrompt,
  runReviewLoop,
  tableRows,
  triagePrompt,
  triageProblems,
} from '../review-loop.js';

const NAME = 'demo-261118';
const NOW = new Date(2026, 10, 18, 9, 30, 5);
const FIXER = buildCommand({ agent: 'codex' });
const REVIEWER = buildCommand({ agent: 'claude', mode: 'read' });
const HEADER =
  '| id | file:line | severity | claim | failure scenario | verdict | reason |';
const SEP = '| --- | --- | --- | --- | --- | --- | --- |';
const HIGH = `|  | tasks/${NAME}/app/a.js:1 | high | Leaks handle | open twice → EMFILE |  |  |`;
const LOW = `|  | tasks/${NAME}/app/a.js | low | Odd name | reading it |  |  |`;
/** @param {string} row @param {string} verdict */
const triaged = (row, verdict) =>
  row.replace(/\|  \|  \|$/, `| ${verdict} | read the code |`);

/** @type {string} */
let root;

const taskDir = () => path.join(tasksRoot(root), NAME);
const state = () =>
  /** @type {import('../../task/state.js').TaskState} */ (
    loadTask(root, NAME).state
  );
const notes = () => fs.readFileSync(path.join(taskDir(), 'NOTES.md'), 'utf-8');

/** A code task with every step done and one code file. */
function seedTask(overrides = {}) {
  fs.mkdirSync(path.join(taskDir(), 'app'), { recursive: true });
  fs.writeFileSync(path.join(taskDir(), 'app', 'a.js'), 'export {};\n');
  fs.writeFileSync(path.join(taskDir(), 'NOTES.md'), '# Notes\n');
  const steps = makeSteps(['Build it']).map((s) => ({
    ...s,
    status: /** @type {const} */ ('done'),
  }));
  saveState(taskDir(), {
    ...createState({
      name: NAME,
      goal: 'Ship it',
      steps,
      verify: ['pnpm test'],
      kind: 'code',
      now: NOW,
    }),
    ...overrides,
  });
}

/** @param {string} out */
const block = (out) => `thinking…\n${BEGIN}\n${HEADER}\n${SEP}\n${out}${END}\n`;

/**
 * A fake agent per role, chosen from the prompt. The fixer edits the code and
 * marks every fix step in its prompt done.
 *
 * @param {{ reviewer?: string[][], triage?: string[][], fixer?: (prompt: string) => void, codes?: Record<string, number> }} script
 *   reviewer/triage: rows printed per call (in order)
 */
function fakeAgents(script) {
  const calls = { reviewer: 0, triage: 0, fixer: 0 };
  const runAgent = vi.fn(
    /** @param {{ prompt: string, cwd: string }} options */
    ({ prompt, cwd }) => {
      const role = prompt.includes('You are the reviewer')
        ? 'reviewer'
        : prompt.includes('You are the triage')
          ? 'triage'
          : 'fixer';
      const n = calls[role]++;
      const code = script.codes?.[role] ?? 0;
      if (role === 'fixer') {
        (
          script.fixer ??
          ((p) => {
            fs.appendFileSync(
              path.join(cwd, 'tasks', NAME, 'app', 'a.js'),
              `// ${n}\n`
            );
            for (const [, id] of p.matchAll(/^ {2}(s\d+)\. fix:/gm)) {
              taskMain({
                argv: ['step', id, 'done', '--task', NAME, '-m', 'fixed'],
                deps: { rootDir: cwd, now: () => NOW, log: () => {} },
              });
            }
          })
        )(prompt);
        return {
          code,
          signal: null,
          output: 'fixed',
          stdout: 'fixed',
          durationMs: 1,
        };
      }
      const rows = (script[role] ?? [])[n] ?? [];
      const stdout = block(rows.map((r) => `${r}\n`).join(''));
      return {
        code,
        signal: null,
        output: `${prompt}\n${stdout}`,
        stdout,
        durationMs: 1,
      };
    }
  );
  return { runAgent, calls };
}

/**
 * @param {import('../driver.js').LoopDeps['runAgent']} runAgent
 * @param {Partial<import('../review-loop.js').ReviewDeps>} [overrides]
 * @returns {import('../review-loop.js').ReviewDeps & { logs: string[] }}
 */
function makeDeps(runAgent, overrides = {}) {
  /** @type {string[]} */
  const logs = [];
  return {
    logs,
    clock: () => 0,
    date: () => NOW,
    env: {},
    log: (message) => logs.push(message),
    git: () => ({ branch: 'loop/demo', changed: 1, diffStat: null }),
    fingerprint: () => `fp-${Math.random()}`,
    runAgent,
    runCommands: vi.fn(({ commands }) =>
      commands.map((/** @type {string} */ command) => ({
        command,
        ok: true,
        code: 0,
        durationMs: 1,
        output: 'ok',
      }))
    ),
    runTask: (argv) => {
      /** @type {string[]} */
      const out = [];
      taskMain({
        argv,
        deps: { rootDir: root, now: () => NOW, log: (m) => out.push(m) },
      });
      return out.join('\n');
    },
    scopeFingerprint: (rootDir, dir, current) =>
      scopeFingerprint(
        /** @type {import('../../task/deps.js').Deps} */ (
          /** @type {unknown} */ ({ rootDir, runGit: () => null })
        ),
        dir,
        current
      ),
    ...overrides,
  };
}

/** @param {import('../review-loop.js').ReviewDeps} deps */
function review(deps, overrides = {}) {
  return runReviewLoop({
    rootDir: root,
    name: NAME,
    command: FIXER,
    reviewer: REVIEWER,
    max: 3,
    stall: 2,
    timeoutMs: 60 * 60 * 1000,
    iterationTimeoutMs: 20 * 60 * 1000,
    deps,
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-loop-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extractRows', () => {
  test('should take the last block and drop header, separator, and empty rows', () => {
    const output = [
      BEGIN,
      '| old | x | low | a | b | | |',
      END,
      'text',
      BEGIN,
      '```',
      HEADER,
      SEP,
      '| | | | | | | |',
      `  ${HIGH}  `,
      'not a row',
      '```',
      END,
    ].join('\n');
    expect(extractRows(output)).toEqual([HIGH]);
  });

  test('should return [] for an empty block and null without one', () => {
    expect(extractRows(`${BEGIN}\n${END}`)).toEqual([]);
    expect(extractRows('no block')).toBeNull();
    expect(extractRows(`${END}\n${BEGIN}`)).toBeNull();
  });
});

describe('tableRows / replaceRows', () => {
  const file = [
    '# R',
    '',
    HEADER,
    SEP,
    HIGH,
    '| | | | | | | |',
    LOW,
    '',
    'after',
  ].join('\n');

  test('should read the rows of the findings table', () => {
    expect(tableRows(file)).toEqual([HIGH, LOW]);
    expect(tableRows('# no table')).toEqual([]);
  });

  test('should replace the rows and keep the text around the table', () => {
    expect(replaceRows(file, ['| x |'])).toBe(
      ['# R', '', HEADER, SEP, '| x |', '', 'after'].join('\n')
    );
  });

  test('should append a table when the file has none', () => {
    expect(replaceRows('# R\n', [HIGH])).toBe(
      `# R\n\n${HEADER}\n${SEP}\n${HIGH}\n`
    );
  });
});

describe('reviewerProblems', () => {
  test('should accept well-formed rows', () => {
    expect(reviewerProblems([HIGH, LOW])).toEqual([]);
  });

  test('should flag missing cells, bad severity, empty cells, and verdicts', () => {
    expect(
      reviewerProblems([
        '| a | b |',
        HIGH.replace('| high |', '| critical |'),
        '|  | x.js | low |  | s |  |  |',
        triaged(HIGH, 'CONFIRMED'),
      ])
    ).toEqual([
      'row 1: 2 cells, expected 7',
      'row 2: severity "critical" is not one of must-fix, high, medium, low',
      'row 3: file:line, claim, or failure scenario is empty',
      'row 4: verdict and reason must stay empty for the triage',
    ]);
  });
});

describe('triageProblems', () => {
  test('should accept the same findings with verdicts', () => {
    expect(
      triageProblems(
        [HIGH, LOW],
        [triaged(HIGH, 'CONFIRMED'), triaged(LOW, 'REFUTED')]
      )
    ).toEqual([]);
  });

  test('should flag a changed count, a changed finding, and a missing verdict', () => {
    expect(triageProblems([HIGH], [])).toEqual([
      'the triage printed 0 row(s) for 1 finding(s)',
    ]);
    expect(
      triageProblems([HIGH, LOW], [triaged(LOW, 'CONFIRMED'), LOW])
    ).toEqual([
      'row 1: the triage changed the finding (file:line or claim)',
      'row 2: no verdict or no reason',
    ]);
  });

  test('should allow lowering a severity but not raising it', () => {
    const lowered = triaged(HIGH, 'CONFIRMED').replace(
      '| high |',
      '| medium |'
    );
    const raised = triaged(LOW, 'CONFIRMED').replace('| low |', '| must-fix |');
    expect(triageProblems([HIGH], [lowered])).toEqual([]);
    expect(triageProblems([LOW], [raised])).toEqual([
      'row 1: severity low → must-fix: the triage may only lower it to one of must-fix, high, medium, low',
    ]);
    expect(
      triageProblems(
        [HIGH],
        [triaged(HIGH, 'CONFIRMED').replace('| high |', '| meh |')]
      )
    ).toEqual([
      'row 1: severity high → meh: the triage may only lower it to one of must-fix, high, medium, low',
    ]);
  });
});

describe('prompts', () => {
  test('should send the reviewer to its role, the brief, and the output block', () => {
    const prompt = reviewerPrompt({
      name: NAME,
      round: 1,
      brief: 'tasks/x/reviews/BRIEF.md',
      findings: 'tasks/x/reviews/REVIEW.md',
    });
    expect(prompt).toContain('review round 1 of task demo-261118');
    expect(prompt).toContain('.claude/agents/reviewer.md');
    expect(prompt).toContain('cannot edit files');
    expect(prompt).toContain('tasks/x/reviews/BRIEF.md');
    expect(prompt.trimEnd().endsWith(END)).toBe(true);
  });

  test('should give the triage the rows to judge', () => {
    const prompt = triagePrompt({
      name: NAME,
      round: 2,
      brief: 'B.md',
      rows: [HIGH],
    });
    expect(prompt).toContain(
      '"Triage mode" section of .claude/agents/verifier.md'
    );
    expect(prompt).toContain(`${HEADER}\n${SEP}\n${HIGH}`);
    expect(prompt).toContain('in the same order');
  });
});

describe('pendingFixes', () => {
  test('should list open fix steps of confirmed must-fix/high findings', () => {
    seedTask();
    const s = state();
    const finding = {
      id: 'r1-1',
      round: 1,
      file: 'a.js',
      line: null,
      severity: /** @type {const} */ ('high'),
      claim: 'c',
      scenario: 's',
      verdict: /** @type {const} */ ('CONFIRMED'),
      reason: 'r',
      step: 's2',
    };
    const withFix = {
      ...s,
      steps: [
        ...s.steps,
        {
          ...s.steps[0],
          id: 's2',
          title: 'fix: c',
          status: /** @type {const} */ ('todo'),
        },
      ],
      quality: {
        .../** @type {import('../../task/quality.js').Quality} */ (s.quality),
        reviewRounds: 1,
        findings: [
          finding,
          {
            ...finding,
            id: 'r1-2',
            severity: /** @type {const} */ ('low'),
            step: 's1',
          },
        ],
      },
    };
    expect(pendingFixes(withFix)).toEqual([
      's2. fix: c — when it is fixed and verify passes: pnpm task step s2 done -m "<what changed>"',
    ]);
    const { quality: _quality, ...legacy } = withFix;
    expect(pendingFixes(legacy)).toEqual([]);
  });
});

describe('runReviewLoop', () => {
  test('should review, triage, fix, review again, and stop at the round limit', () => {
    seedTask();
    const { runAgent, calls } = fakeAgents({
      reviewer: [[HIGH, LOW], [HIGH.replace('Leaks handle', 'Still leaks')]],
      triage: [
        [triaged(HIGH, 'CONFIRMED'), triaged(LOW, 'CONFIRMED')],
        [triaged(HIGH.replace('Leaks handle', 'Still leaks'), 'CONFIRMED')],
      ],
    });
    const deps = makeDeps(runAgent);

    const result = review(deps);

    expect(result).toMatchObject({ ok: true, reason: 'complete', rounds: 2 });
    expect(result.detail).toBe('review round limit reached (2/2).');
    expect(calls).toEqual({ reviewer: 2, triage: 2, fixer: 2 });
    const s = state();
    expect(s.quality).toMatchObject({ phase: 'complete', reviewRounds: 2 });
    expect(s.steps.map((step) => [step.id, step.status])).toEqual([
      ['s1', 'done'],
      ['s2', 'done'],
      ['s3', 'done'],
    ]);
    const findings = fs.readFileSync(
      path.join(taskDir(), 'reviews', `REVIEW_${NAME}-r1.md`),
      'utf-8'
    );
    expect(findings).toContain('| CONFIRMED | read the code |');
    expect(fs.readdirSync(result.logDir).sort()).toEqual([
      'r1-reviewer.md',
      'r1-triage.md',
      'r2-reviewer.md',
      'r2-triage.md',
    ]);
    expect(notes()).toContain('(fix-r1): verify passed, nothing left open');
    expect(notes()).toMatch(
      /auto: review loop\)\n\npnpm loop --review --agent codex \(reviewer claude\): complete — review round limit reached \(2\/2\)\. 2 round\(s\) this run\. Quality loop complete after 2\/2 review round\(s\): 3 finding\(s\), 2 must-fix\/high fixed, 0 refuted\. Recorded, not fixed \(list under Open\): r1-2 low/
    );
    expect(deps.logs).toContain('▶ fixing 1 confirmed finding(s)');
  });

  test('should stop after one round when nothing needs fixing', () => {
    seedTask();
    const { runAgent, calls } = fakeAgents({ reviewer: [[]] });
    const result = review(makeDeps(runAgent));
    expect(result).toMatchObject({
      ok: true,
      reason: 'complete',
      rounds: 1,
      detail: 'nothing changed since the last review.',
    });
    expect(calls).toEqual({ reviewer: 1, triage: 0, fixer: 0 });
    expect(state().quality?.phase).toBe('complete');
  });

  test('should resume an open round whose rows are already triaged', () => {
    seedTask();
    const deps = makeDeps(fakeAgents({}).runAgent);
    const opened = JSON.parse(
      deps.runTask(['review', '--task', NAME, '--json', '--force'])
    );
    const file = path.join(root, opened.findings);
    fs.writeFileSync(
      file,
      replaceRows(fs.readFileSync(file, 'utf-8'), [triaged(LOW, 'REFUTED')])
    );
    const { runAgent, calls } = fakeAgents({});
    const result = review({ ...deps, runAgent });
    expect(result).toMatchObject({ ok: true, rounds: 1 });
    expect(calls).toEqual({ reviewer: 0, triage: 0, fixer: 0 });
    expect(deps.logs).toContain('▶ review round 1 (reopened): claude');
  });

  test('should stop when the build loop cannot make verify pass', () => {
    seedTask();
    const deps = makeDeps(fakeAgents({}).runAgent, {
      runCommands: vi.fn(({ commands }) => [
        {
          command: commands[0],
          ok: false,
          code: 1,
          durationMs: 1,
          output: 'boom',
        },
      ]),
    });
    const result = review(deps, { max: 1 });
    expect(result).toMatchObject({ ok: false, reason: 'verify' });
    expect(result.detail).toMatch(
      /^the build loop stopped \(max\): `.+` fails\.$/
    );
    expect(notes()).toContain('stopped (verify)');
    expect(notes()).toContain('verify fail');
  });

  test('should stop when the fixer leaves a fix step open', () => {
    seedTask();
    const { runAgent } = fakeAgents({
      reviewer: [[HIGH]],
      triage: [[triaged(HIGH, 'CONFIRMED')]],
      fixer: () => {},
    });
    const result = review(makeDeps(runAgent, { fingerprint: () => 'same' }));
    expect(result).toMatchObject({ ok: false, reason: 'fix', rounds: 1 });
    expect(result.detail).toBe(
      'the fix loop stopped (no-progress): 1 fix step(s) still open.'
    );
  });

  test('should stop when a fix breaks verify', () => {
    seedTask();
    let call = 0;
    const { runAgent } = fakeAgents({
      reviewer: [[HIGH]],
      triage: [[triaged(HIGH, 'CONFIRMED')]],
    });
    const result = review(
      makeDeps(runAgent, {
        runCommands: vi.fn(({ commands }) => {
          const ok = call++ < 2;
          return [
            {
              command: commands[0],
              ok,
              code: ok ? 0 : 1,
              durationMs: 1,
              output: 'x',
            },
          ];
        }),
      }),
      { max: 1 }
    );
    expect(result).toMatchObject({ ok: false, reason: 'fix' });
    expect(result.detail).toMatch(
      /^the fix loop stopped \(max\): `.+` fails\.$/
    );
  });

  test('should not count steps that wait on someone else as open', () => {
    seedTask({
      steps: makeSteps(['Build it', 'Upload']).map((step, i) => ({
        ...step,
        status: i === 0 ? 'done' : 'waiting',
      })),
    });
    const { runAgent } = fakeAgents({});
    expect(review(makeDeps(runAgent)).reason).not.toBe('steps-open');
  });

  test('should not review while steps are open or blocked', () => {
    seedTask({
      steps: [...makeSteps(['Build it', 'Polish'])],
    });
    const { runAgent } = fakeAgents({});
    expect(review(makeDeps(runAgent))).toMatchObject({
      ok: false,
      reason: 'steps-open',
      detail:
        'verify passes, but s1, s2 not done; the review runs once every step is done.',
    });
    const s = state();
    saveState(taskDir(), {
      ...s,
      steps: s.steps.map((step, i) => ({
        ...step,
        status: i === 0 ? 'blocked' : 'done',
      })),
    });
    expect(review(makeDeps(runAgent))).toMatchObject({ reason: 'blocked' });
  });

  test('should stop without a review scope', () => {
    seedTask();
    const { runAgent } = fakeAgents({});
    expect(
      review(makeDeps(runAgent, { scopeFingerprint: () => null }))
    ).toMatchObject({ ok: false, reason: 'no-scope' });
  });

  test('should stop with a note when the round cannot be opened', () => {
    seedTask();
    const { runAgent } = fakeAgents({});
    const result = review(
      makeDeps(runAgent, {
        runTask: () => {
          throw new Error('Nothing to review for demo: no files changed');
        },
      })
    );
    expect(result).toMatchObject({ ok: false, reason: 'open' });
    expect(result.detail).toBe(
      'pnpm task review could not open a round: Nothing to review for demo: no files changed'
    );
    expect(notes()).toContain('stopped (open)');
  });

  test('should keep the round open when the reviewer fails', () => {
    seedTask();
    const failing = fakeAgents({ codes: { reviewer: 1 } });
    expect(review(makeDeps(failing.runAgent))).toMatchObject({
      reason: 'reviewer',
      detail: 'the reviewer exited 1; round 1 stays open.',
    });
    expect(state().quality?.phase).toBe('review');
    const silent = vi.fn(() => ({
      code: 0,
      signal: null,
      output: 'no block',
      stdout: 'no block',
      durationMs: 1,
    }));
    expect(review(makeDeps(silent)).detail).toBe(
      `the reviewer printed no ${BEGIN} … ${END} block; round 1 stays open.`
    );
  });

  test('should report a reviewer stopped by its timeout', () => {
    seedTask();
    const killed = vi.fn(() => ({
      code: null,
      signal: 'SIGTERM',
      output: '(stopped by SIGTERM)',
      stdout: '',
      durationMs: 1,
    }));
    const result = review(makeDeps(killed));
    expect(result.detail).toBe(
      'the reviewer exited SIGTERM; round 1 stays open.'
    );
    expect(
      fs.readFileSync(path.join(result.logDir, 'r1-reviewer.md'), 'utf-8')
    ).toContain('- Exit: stopped by SIGTERM');
  });

  test('should run on an older code state without quality', () => {
    seedTask({ quality: undefined });
    const { runAgent } = fakeAgents({ reviewer: [[]] });
    expect(review(makeDeps(runAgent))).toMatchObject({
      ok: true,
      rounds: 1,
    });
  });

  test('should keep the round open when the triage fails or tampers', () => {
    seedTask();
    const crashed = fakeAgents({ reviewer: [[HIGH]], codes: { triage: 2 } });
    expect(review(makeDeps(crashed.runAgent))).toMatchObject({
      reason: 'triage',
      detail: 'the triage failed: exited 2; round 1 stays open.',
    });
    const tampered = fakeAgents({ triage: [[triaged(LOW, 'REFUTED')]] });
    expect(review(makeDeps(tampered.runAgent)).detail).toBe(
      'the triage failed: row 1: the triage changed the finding (file:line or claim); round 1 stays open.'
    );
    const silent = vi.fn(() => ({
      code: 0,
      signal: null,
      output: '',
      stdout: '',
      durationMs: 1,
    }));
    expect(review(makeDeps(silent)).detail).toBe(
      `the triage failed: printed no ${BEGIN} … ${END} block; round 1 stays open.`
    );
  });

  test('should refuse malformed reviewer rows without writing them', () => {
    seedTask();
    const { runAgent, calls } = fakeAgents({
      reviewer: [[HIGH.replace('| high |', '| severe |')]],
    });
    const result = review(makeDeps(runAgent));
    expect(result).toMatchObject({ ok: false, reason: 'reviewer' });
    expect(result.detail).toContain('severity "severe"');
    expect(result.detail).toContain('nothing was written, round 1 stays open.');
    expect(calls.triage).toBe(0);
    const file = path.join(taskDir(), 'reviews', `REVIEW_${NAME}-r1.md`);
    expect(tableRows(fs.readFileSync(file, 'utf-8'))).toEqual([]);
  });

  test('should report a findings table that record rejects', () => {
    seedTask();
    const { runAgent } = fakeAgents({
      reviewer: [[HIGH]],
      triage: [[triaged(HIGH, 'MAYBE')]],
    });
    const result = review(makeDeps(runAgent));
    expect(result.reason).toBe('record');
    expect(result.detail).toContain('pnpm task review record failed:');
    expect(result.detail).toContain('verdict "MAYBE"');
  });

  test('should stop at the wall-clock cap', () => {
    seedTask();
    let time = 0;
    const { runAgent } = fakeAgents({});
    const deps = makeDeps(runAgent, { clock: () => (time += 1000) });
    expect(review(deps, { timeoutMs: 1500 })).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
  });
});
