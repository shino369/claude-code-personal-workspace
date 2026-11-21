import {
  LINE_WIDTH,
  NOTE_BODY_LINES,
  formatBrief,
  formatNoActiveBrief,
  summarizeTask,
} from '../brief.js';
import { createState, makeSteps } from '../state.js';

const GIT = { branch: 'feat/x', changed: 0, diffStat: null };

/**
 * @param {Partial<import('../store.js').Task>} [overrides]
 * @returns {import('../store.js').Task}
 */
function makeTask(overrides = {}) {
  return {
    name: 'demo-261117',
    dir: '/tmp/demo',
    state: createState({
      name: 'demo-261117',
      goal: 'Ship it',
      steps: makeSteps(['One', 'Two']),
      branch: 'feat/x',
      now: new Date(2026, 10, 17),
    }),
    plan: null,
    notes: null,
    ...overrides,
  };
}

const notes = (/** @type {string[]} */ ...entries) =>
  `# NOTES\n\n${entries.join('\n\n')}\n`;

describe('summarizeTask', () => {
  test('should summarize a tracked task', () => {
    const summary = summarizeTask(makeTask(), GIT);
    expect(summary).toMatchObject({
      tracked: true,
      status: 'active',
      goal: 'Ship it',
      progress: { done: 0, total: 2 },
      nextStep: { id: 's1', title: 'One', status: 'todo', owner: null },
      next: null,
      branch: 'feat/x',
    });
  });

  test('should take the expected branch from the last note with a State line', () => {
    const task = makeTask({
      notes: notes(
        '## a — x\n\nState: branch feat/old; uncommitted no; verify pass',
        '## b — x\n\nState: branch feat/new; uncommitted yes (2 files); verify fail',
        '## c — x (step s1 done)\n\ns1. One → done'
      ),
    });
    expect(summarizeTask(task, GIT).branch).toBe('feat/new');
  });

  test('should fall back to the recorded branch without a usable State line', () => {
    const detached = makeTask({
      notes: notes('## a — x\n\nState: branch (detached); uncommitted no'),
    });
    const none = makeTask({
      notes: notes('## a — x\n\nState: not a git repo'),
    });
    expect(summarizeTask(detached, GIT).branch).toBe('feat/x');
    expect(summarizeTask(none, GIT).branch).toBe('feat/x');
  });

  test('should carry the task repo, or null', () => {
    const task = makeTask();
    const state = /** @type {import('../state.js').TaskState} */ (task.state);
    expect(summarizeTask(task, GIT).repo).toBeNull();
    expect(
      summarizeTask({ ...task, state: { ...state, repo: '/w/r' } }, GIT).repo
    ).toBe('/w/r');
  });

  test('should treat a state.json written before kinds existed as general', () => {
    const task = makeTask();
    const {
      kind: _k,
      e2e: _e,
      ...legacy
    } = /** @type {import('../state.js').TaskState} */ (task.state);
    expect(summarizeTask({ ...task, state: legacy }, GIT)).toMatchObject({
      kind: 'general',
      e2e: 'no',
    });
  });

  test('should prefer state.next over the notes', () => {
    const task = makeTask({ notes: notes('## a\n\nNext: from note') });
    /** @type {import('../state.js').TaskState} */ (task.state).next =
      'from state';
    expect(summarizeTask(task, GIT).next).toBe('from state');
  });

  test('should take Next from the newest note that has one', () => {
    const task = makeTask({
      notes: notes(
        '## a\n\nNext: older',
        '## b\n\nNext: newer',
        '## c\n\nstep done'
      ),
    });
    expect(summarizeTask(task, GIT).next).toBe('newer');
  });

  test('should report no next step when every step is done', () => {
    const task = makeTask();
    const state = /** @type {import('../state.js').TaskState} */ (task.state);
    for (const step of state.steps) step.status = 'done';
    expect(summarizeTask(task, GIT).nextStep).toBeNull();
  });

  test('should read a hand-written plan when there is no state', () => {
    const summary = summarizeTask(
      makeTask({ state: null, plan: 'Goal: Legacy\n- [x] a\n- [ ] b\n' }),
      GIT
    );
    expect(summary).toMatchObject({
      tracked: false,
      goal: 'Legacy',
      progress: { done: 1, total: 2 },
      nextStep: { id: null, title: 'b', status: 'todo', owner: null },
      lastVerify: null,
      verify: [],
      branch: null,
    });
  });

  test('should skip deferred plan steps unless only deferred steps remain', () => {
    const plan = 'Goal: G\n- [ ] (deferred) later\n- [ ] now\n';
    expect(
      summarizeTask(makeTask({ state: null, plan }), GIT).nextStep?.title
    ).toBe('now');
    expect(
      summarizeTask(
        makeTask({ state: null, plan: '- [x] a\n- [ ] (Deferred) later\n' }),
        GIT
      ).nextStep?.title
    ).toBe('(Deferred) later');
  });

  test('should handle a legacy task with no plan and all steps done', () => {
    expect(
      summarizeTask(makeTask({ state: null, plan: null }), GIT)
    ).toMatchObject({ goal: '(no Goal: line in plan.md)', nextStep: null });
    expect(
      summarizeTask(makeTask({ state: null, plan: '- [x] a\n' }), GIT).nextStep
    ).toBeNull();
  });
});

describe('formatBrief', () => {
  /** @param {Partial<import('../brief.js').TaskSummary>} overrides */
  const brief = (overrides = {}) =>
    formatBrief({ ...summarizeTask(makeTask(), GIT), ...overrides });

  test('should render the core lines for a fresh task', () => {
    expect(brief().split('\n')).toEqual([
      '[Task] demo-261117 — open (tasks/demo-261117/)',
      'Goal: Ship it',
      'Progress: 0/2 steps done',
      'Next step: s1. One',
      'Last verify: none configured (the gate is pnpm check)',
      'Git: branch feat/x; uncommitted no',
      'Last note: none yet',
      'Commands: pnpm task step <id> start|done · pnpm task note --done "…" --next "…" · pnpm task verify',
    ]);
  });

  test('should summarize the quality state of a code task', () => {
    const task = makeTask();
    const state = /** @type {import('../state.js').TaskState} */ (task.state);
    const code = {
      ...task,
      state: { ...state, kind: /** @type {const} */ ('code') },
    };
    expect(summarizeTask(code, GIT)).toMatchObject({
      quality: { phase: 'build', reviewRounds: 0 },
      qualityLine: 'build — review round 0/2; no findings yet',
    });
    expect(summarizeTask(task, GIT)).toMatchObject({
      quality: null,
      qualityLine: null,
    });
  });

  test('should show the quality line only when there is one', () => {
    expect(brief({ qualityLine: 'build — review round 0/2' })).toContain(
      'Quality: build — review round 0/2'
    );
    expect(brief({ qualityLine: null })).not.toContain('Quality:');
  });

  test('should show the kind line only for code tasks', () => {
    expect(brief({ kind: 'code', e2e: 'required' })).toContain(
      'Kind: code — test-first; pnpm task check runs before verify; e2e required'
    );
    expect(brief({ kind: 'general' })).not.toContain('Kind:');
  });

  test('should show the inner loop only when it is on', () => {
    const loop = { enabled: true, iteration: 2, max: 5 };
    expect(brief({ loop })).toContain(
      'Loop: on — iteration 2/5; each stop re-runs the fast verify (off: pnpm task set --loop off)'
    );
    expect(brief({ loop: { ...loop, enabled: false } })).not.toContain('Loop:');
    expect(brief({ loop: null })).not.toContain('Loop:');
  });

  test('should say the task is done', () => {
    expect(brief({ status: 'done' })).toContain(
      'Next step: none — the task is done'
    );
  });

  test('should show an in-progress step with and without an owner', () => {
    const step = {
      id: 's2',
      title: 'Two',
      status: 'in_progress',
      owner: 'codex',
    };
    expect(brief({ nextStep: step })).toContain(
      'Next step: s2. Two (in progress, codex)'
    );
    expect(brief({ nextStep: { ...step, owner: null } })).toContain(
      'Next step: s2. Two (in progress)'
    );
  });

  test('should omit the id for a legacy step', () => {
    expect(
      brief({ nextStep: { id: null, title: 'b', status: 'todo', owner: null } })
    ).toContain('Next step: b');
  });

  test('should explain blocked and empty step lists', () => {
    expect(
      brief({ nextStep: null, progress: { done: 1, total: 2 } })
    ).toContain('remaining steps are blocked');
    expect(
      brief({ nextStep: null, progress: { done: 0, total: 0 } })
    ).toContain('none listed');
    expect(
      brief({ nextStep: null, progress: { done: 2, total: 2 } })
    ).toContain('none listed');
  });

  test('should show the next action from notes', () => {
    expect(brief({ next: 'write tests' })).toContain(
      'Next (last note): write tests'
    );
  });

  test('should describe verify states', () => {
    const at = new Date(2026, 10, 17, 8, 9).toISOString();
    expect(brief({ verify: ['pnpm check', 'pnpm x'] })).toContain(
      'Last verify: not run (pnpm task verify runs: pnpm check && pnpm x)'
    );
    expect(
      brief({ lastVerify: { at, ok: true, failed: null, summary: '' } })
    ).toContain('Last verify: pass at 2026-11-17 08:09');
    expect(
      brief({ lastVerify: { at, ok: false, failed: 'pnpm x', summary: '' } })
    ).toContain('Last verify: FAIL at 2026-11-17 08:09 — `pnpm x`');
  });

  test('should flag a branch that differs from the last note', () => {
    expect(brief({ branch: 'feat/other' })).toContain(
      'Git: branch feat/x; uncommitted no — ! the last note was on feat/other; switch or confirm with the user'
    );
    expect(brief({ git: { ...GIT, branch: null } })).not.toContain('!');
  });

  test('should list steps waiting on someone else, and say none is for the agent', () => {
    const task = makeTask();
    const state = /** @type {import('../state.js').TaskState} */ (task.state);
    const steps = state.steps.map((s, i) => ({
      ...s,
      status:
        i === 0
          ? /** @type {const} */ ('done')
          : /** @type {const} */ ('waiting'),
      ...(i === 1 ? { note: 'the user submits it' } : {}),
    }));
    const text = formatBrief(
      summarizeTask({ ...task, state: { ...state, steps } }, GIT)
    );
    expect(text).toContain(
      'Next step: none for you — the rest waits on someone else'
    );
    expect(text).toContain('Waiting: s2. Two — the user submits it');
    const gated = steps.map((s, i) =>
      i === 1 ? { ...s, gate: /** @type {const} */ (true) } : s
    );
    expect(
      formatBrief(
        summarizeTask({ ...task, state: { ...state, steps: gated } }, GIT)
      )
    ).toContain(
      'Waiting: s2. Two (gate: holds the review) — the user submits it'
    );
    const bare = steps.map(({ note: _n, ...s }) => s);
    expect(
      formatBrief(
        summarizeTask({ ...task, state: { ...state, steps: bare } }, GIT)
      )
    ).toContain('Waiting: s2. Two\n');
  });

  test('should name the repo the task works in', () => {
    expect(brief({ repo: '/work/other-repo' })).toContain(
      'Repo: /work/other-repo (git state, State lines, and review scope come from it)'
    );
    expect(brief({})).not.toContain('Repo:');
  });

  test('should show the last note, truncation, and earlier headings', () => {
    const body = Array.from({ length: NOTE_BODY_LINES + 2 }, (_, i) => `l${i}`);
    const text = brief({
      notes: [
        { heading: 'h1', body: 'x' },
        { heading: 'h2', body: 'y' },
        { heading: 'h3', body: 'z' },
        { heading: 'h4', body: body.join('\n') },
      ],
    });
    expect(text).toContain('Last note — h4:\n  l0');
    expect(text).not.toContain(`l${NOTE_BODY_LINES}\n`);
    expect(text).toContain('  … 2 more line(s) in tasks/demo-261117/NOTES.md');
    expect(text).toContain('Earlier notes: h3 · h2');
  });

  test('should skip the earlier line when there is one note', () => {
    expect(brief({ notes: [{ heading: 'only', body: 'b' }] })).not.toContain(
      'Earlier notes'
    );
  });

  test('should point legacy tasks at init', () => {
    expect(brief({ tracked: false })).toContain(
      'Commands: pnpm task init demo-261117'
    );
  });

  test('should clip long lines', () => {
    const line = brief({ goal: 'g'.repeat(LINE_WIDTH * 2) }).split('\n')[1];
    expect(line).toHaveLength(LINE_WIDTH);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatNoActiveBrief', () => {
  test('should suggest creating a task when none are open', () => {
    expect(
      formatNoActiveBrief([
        { name: 'a', status: 'done', tracked: true, updated: 'x' },
      ])
    ).toMatch(/^\[Task\] No active task\. Multi-step work/);
  });

  test('should list open tasks up to the limit', () => {
    const tasks = ['a', 'b', 'c'].map((name) => ({
      name,
      status: 'active',
      tracked: name !== 'b',
      updated: '2026-11-17 10:00',
    }));
    // No task is "active" here: that word means the active pointer.
    expect(formatNoActiveBrief(tasks, 2).split('\n')).toEqual([
      '[Task] No active task. Open tasks (newest first):',
      '  - a (open, updated 2026-11-17 10:00)',
      '  - b (open, untracked, updated 2026-11-17 10:00)',
      'Resume one: pnpm task switch <name>, then pnpm task status. New work: pnpm task new <name> --goal "…"',
    ]);
  });

  test('should default to five tasks', () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({
      name: `t${i}`,
      status: 'blocked',
      tracked: true,
      updated: 'x',
    }));
    expect(formatNoActiveBrief(tasks).split('\n')).toHaveLength(7);
  });
});
