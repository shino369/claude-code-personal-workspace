import {
  STATE_VERSION,
  addStep,
  assertValidState,
  claimStep,
  createState,
  idleReason,
  formatYymmdd,
  makeSteps,
  nextStep,
  progress,
  readySteps,
  setStepStatus,
  taskDirName,
  validateState,
} from '../state.js';

const NOW = new Date(2026, 10, 17, 9, 5);

/** @param {Partial<import('../state.js').TaskState>} [overrides] */
function makeState(overrides = {}) {
  return {
    ...createState({
      name: 'demo-261117',
      goal: 'Goal',
      steps: makeSteps(['One', 'Two', 'Three']),
      now: NOW,
    }),
    ...overrides,
  };
}

describe('formatYymmdd', () => {
  test('should zero-pad year, month, and day', () => {
    expect(formatYymmdd(new Date(2007, 0, 3))).toBe('070103');
  });
});

describe('taskDirName', () => {
  test('should append the date suffix to a plain name', () => {
    expect(taskDirName('my-task', NOW)).toBe('my-task-261117');
  });

  test('should keep a name that already has a date suffix', () => {
    expect(taskDirName('my-task-250101', NOW)).toBe('my-task-250101');
  });

  test('should use the current date by default', () => {
    expect(taskDirName('x')).toMatch(/^x-\d{6}$/);
  });

  test('should reject names that are not kebab-case', () => {
    expect(() => taskDirName('My Task', NOW)).toThrow(/Invalid task name/);
  });
});

describe('validateState', () => {
  test('should accept a fresh state', () => {
    expect(validateState(makeState())).toEqual([]);
  });

  test('should reject a non-object', () => {
    expect(validateState([])).toEqual(['state must be a JSON object']);
  });

  test('should report every invalid top-level field', () => {
    const errors = validateState({
      version: 0,
      name: 1,
      goal: null,
      createdAt: 2,
      updatedAt: 3,
      status: 'nope',
      branch: 1,
      next: 2,
      lastAgent: 3,
      verify: [1],
      verifyFast: 'x',
      lastVerify: { at: 'x', ok: 'yes' },
      loop: { enabled: true, iteration: 1.5, max: 1 },
      steps: 'none',
    });
    expect(errors).toEqual([
      `version must be ${STATE_VERSION}`,
      'name must be a string',
      'goal must be a string',
      'createdAt must be a string',
      'updatedAt must be a string',
      'status must be one of active, blocked, done',
      'branch must be a string or null',
      'next must be a string or null',
      'lastAgent must be a string or null',
      'verify must be a string array',
      'verifyFast must be a string array',
      'lastVerify must be null or { at, ok, failed, summary }',
      'loop must be { enabled: boolean, iteration: int, max: int }',
      'steps must be an array',
    ]);
  });

  test('should accept a well-formed lastVerify', () => {
    const state = makeState({
      lastVerify: { at: 'x', ok: false, failed: 'pnpm test', summary: 's' },
    });
    expect(validateState(state)).toEqual([]);
  });

  test('should reject a non-object lastVerify and loop', () => {
    const errors = validateState({ ...makeState(), lastVerify: 'x', loop: [] });
    expect(errors).toEqual([
      'lastVerify must be null or { at, ok, failed, summary }',
      'loop must be { enabled: boolean, iteration: int, max: int }',
    ]);
  });

  test('should accept optional loop signature and repeats, and reject bad ones', () => {
    const loop = { enabled: true, iteration: 1, max: 5 };
    expect(
      validateState({
        ...makeState(),
        loop: { ...loop, signature: null, repeats: 0 },
      })
    ).toEqual([]);
    const message =
      'loop.signature must be a string or null, loop.repeats an int, loop.halted a boolean';
    expect(
      validateState({ ...makeState(), loop: { ...loop, signature: 3 } })
    ).toEqual([message]);
    expect(
      validateState({ ...makeState(), loop: { ...loop, repeats: 'x' } })
    ).toEqual([message]);
    expect(
      validateState({ ...makeState(), loop: { ...loop, halted: 'no' } })
    ).toEqual([message]);
  });

  test('should report invalid steps, duplicate ids, and unknown deps', () => {
    const errors = validateState({
      ...makeState(),
      steps: [
        'bad',
        {
          id: '',
          title: 1,
          status: 'x',
          deps: 'no',
          owner: 1,
          note: 2,
          claimedAt: 3,
        },
        { id: 'a', title: 'A', status: 'todo', deps: ['zz'], owner: null },
        {
          id: 'a',
          title: 'A2',
          status: 'done',
          deps: [],
          owner: 'me',
          note: 'n',
        },
      ],
    });
    expect(errors).toEqual([
      'steps[0] must be an object',
      'steps[1].id must be a string',
      'steps[1].title must be a string',
      'steps[1].status must be one of todo, in_progress, blocked, done',
      'steps[1].deps must be a string array',
      'steps[1].owner must be a string or null',
      'steps[1].note must be a string',
      'steps[1].claimedAt must be a string',
      'steps[3].id "a" is duplicated',
      'step a depends on unknown step "zz"',
    ]);
  });
});

describe('assertValidState', () => {
  test('should return a valid state unchanged', () => {
    const state = makeState();
    expect(assertValidState(state)).toBe(state);
  });

  test('should throw with the source name and every problem', () => {
    expect(() =>
      assertValidState({ ...makeState(), goal: 1 }, 'x.json')
    ).toThrow('Invalid x.json:\n  - goal must be a string');
  });

  test('should default the source to state.json', () => {
    expect(() => assertValidState(null)).toThrow('Invalid state.json');
  });
});

describe('makeSteps', () => {
  test('should number steps and honor done flags', () => {
    expect(
      makeSteps(['A', { title: 'B', done: true }, { title: 'C' }])
    ).toEqual([
      { id: 's1', title: 'A', status: 'todo', deps: [], owner: null },
      { id: 's2', title: 'B', status: 'done', deps: [], owner: null },
      { id: 's3', title: 'C', status: 'todo', deps: [], owner: null },
    ]);
  });
});

describe('createState', () => {
  test('should fill defaults', () => {
    const state = createState({ name: 'n', goal: 'g', now: NOW });
    expect(state).toMatchObject({
      status: 'active',
      steps: [],
      verify: [],
      verifyFast: [],
      branch: null,
      lastAgent: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  test('should default the timestamp to now', () => {
    expect(createState({ name: 'n', goal: 'g' }).createdAt).toMatch(/^\d{4}-/);
  });
});

describe('nextStep', () => {
  test('should prefer an in-progress step', () => {
    const state = makeState();
    state.steps[2].status = 'in_progress';
    expect(nextStep(state)?.id).toBe('s3');
  });

  test('should return the first todo step with satisfied deps', () => {
    const state = makeState();
    state.steps[0].deps = ['s2'];
    expect(nextStep(state)?.id).toBe('s2');
  });

  test('should return null when nothing is ready', () => {
    const state = makeState();
    for (const step of state.steps) step.status = 'done';
    expect(nextStep(state)).toBeNull();
  });
});

describe('progress', () => {
  test('should count done steps', () => {
    const state = makeState();
    state.steps[1].status = 'done';
    expect(progress(state)).toEqual({ done: 1, total: 3 });
  });
});

describe('addStep', () => {
  test('should append a trimmed step with the next free id', () => {
    const state = makeState();
    state.steps[2].id = 's4';
    const result = addStep(state, { title: '  New  ', deps: ['s1'] });
    expect(result.step).toEqual({
      id: 's5',
      title: 'New',
      status: 'todo',
      deps: ['s1'],
      owner: null,
    });
    expect(result.state.steps).toHaveLength(4);
  });

  test('should default deps to none', () => {
    expect(addStep(makeState(), { title: 'X' }).step.deps).toEqual([]);
  });

  test('should reject an empty title', () => {
    expect(() => addStep(makeState(), { title: ' ' })).toThrow(
      /must not be empty/
    );
  });

  test('should reject an unknown dependency', () => {
    expect(() => addStep(makeState(), { title: 'X', deps: ['s9'] })).toThrow(
      'Unknown dependency "s9"'
    );
  });
});

describe('setStepStatus', () => {
  test('should start a step and record the owner', () => {
    const { step } = setStepStatus(makeState(), {
      id: 's1',
      status: 'in_progress',
      agent: 'codex',
    });
    expect(step).toMatchObject({ status: 'in_progress', owner: 'codex' });
  });

  test('should keep the owner and store a note when finishing', () => {
    const state = makeState();
    state.steps[0].owner = 'claude';
    const { step, state: next } = setStepStatus(state, {
      id: 's1',
      status: 'done',
      note: 'ok',
    });
    expect(step).toMatchObject({ status: 'done', owner: 'claude', note: 'ok' });
    expect(next.steps[1]).toBe(state.steps[1]);
  });

  test('should drop an old note when no new note is given', () => {
    const state = makeState();
    state.steps[0].note = 'old';
    const { step } = setStepStatus(state, { id: 's1', status: 'todo' });
    expect(step).not.toHaveProperty('note');
  });

  test('should reject an unknown status', () => {
    expect(() =>
      setStepStatus(makeState(), {
        id: 's1',
        status: /** @type {any} */ ('later'),
      })
    ).toThrow(/Unknown step status "later"/);
  });

  test('should list known ids for an unknown step', () => {
    expect(() =>
      setStepStatus(makeState(), { id: 's9', status: 'done' })
    ).toThrow('Unknown step "s9" (steps: s1, s2, s3)');
  });

  test('should say none when there are no steps', () => {
    expect(() =>
      setStepStatus(makeState({ steps: [] }), { id: 's1', status: 'done' })
    ).toThrow('(steps: none)');
  });

  test('should require a reason for blocked', () => {
    expect(() =>
      setStepStatus(makeState(), { id: 's1', status: 'blocked' })
    ).toThrow(/needs a reason/);
  });

  test('should refuse to start a step with unfinished deps', () => {
    const state = makeState();
    state.steps[2].deps = ['s1', 's2'];
    state.steps[0].status = 'done';
    expect(() =>
      setStepStatus(state, { id: 's3', status: 'in_progress' })
    ).toThrow('Step s3 is waiting on s2; finish those first');
  });
});

describe('readySteps', () => {
  test('should list todo steps whose deps are done, in order', () => {
    const state = makeState();
    state.steps[1].deps = ['s1'];
    expect(readySteps(state).map((s) => s.id)).toEqual(['s1', 's3']);
    state.steps[0].status = 'done';
    expect(readySteps(state).map((s) => s.id)).toEqual(['s2', 's3']);
  });
});

describe('idleReason', () => {
  test('should explain an empty or finished task', () => {
    expect(idleReason(makeState({ steps: [] }))).toMatch(/has no steps/);
    const state = makeState();
    for (const step of state.steps) step.status = 'done';
    expect(idleReason(state)).toMatch(/every step is done/);
  });

  test('should list running, blocked, and waiting steps', () => {
    const state = makeState();
    state.steps[0] = { ...state.steps[0], status: 'in_progress', owner: 'w1' };
    state.steps[1].status = 'blocked';
    state.steps[2].deps = ['s1'];
    expect(idleReason(state)).toBe(
      'in progress: s1 (w1); blocked: s2; waiting on dependencies: s3 (needs s1)'
    );
    state.steps[0].owner = null;
    expect(idleReason(state)).toMatch(/^in progress: s1;/);
  });

  test('should list ready steps and only the deps still pending', () => {
    const state = makeState();
    state.steps[0].status = 'done';
    state.steps[2].deps = ['s1', 's2'];
    state.steps[1] = { ...state.steps[1], status: 'in_progress', owner: 'w' };
    expect(idleReason(state)).toBe(
      'in progress: s2 (w); waiting on dependencies: s3 (needs s2)'
    );
    state.steps[1].status = 'todo';
    expect(idleReason(state)).toBe(
      'ready: s2; waiting on dependencies: s3 (needs s2)'
    );
  });
});

describe('claimStep', () => {
  test('should claim the first ready step with owner and time', () => {
    const state = makeState();
    state.steps[0].deps = ['s2'];
    const { step, state: next } = claimStep(state, { agent: 'w1', now: NOW });
    expect(step).toMatchObject({
      id: 's2',
      status: 'in_progress',
      owner: 'w1',
      claimedAt: NOW.toISOString(),
    });
    expect(next.steps[1]).toBe(step);
    expect(state.steps[1].status).toBe('todo');
  });

  test('should never hand the same step to two agents', () => {
    let state = makeState();
    const owners = [];
    for (const agent of ['a', 'b', 'c', 'd']) {
      const result = claimStep(state, { agent, now: NOW });
      state = result.state;
      owners.push(result.step?.id ?? null);
    }
    expect(owners).toEqual(['s1', 's2', 's3', null]);
  });

  test('should claim a given id, and be a no-op for its owner', () => {
    const first = claimStep(makeState(), { agent: 'a', id: 's3', now: NOW });
    expect(first.step?.id).toBe('s3');
    const again = claimStep(first.state, { agent: 'a', id: 's3', now: NOW });
    expect(again.state).toBe(first.state);
    expect(again.step).toBe(first.step);
  });

  test('should refuse a step another agent claimed', () => {
    const { state } = claimStep(makeState(), {
      agent: 'a',
      id: 's1',
      now: NOW,
    });
    expect(() => claimStep(state, { agent: 'b', id: 's1', now: NOW })).toThrow(
      `Step s1 is already claimed by a (since ${NOW.toISOString()})`
    );
    state.steps[0] = { ...state.steps[0], owner: null };
    delete state.steps[0].claimedAt;
    expect(() => claimStep(state, { agent: 'b', id: 's1', now: NOW })).toThrow(
      /^Step s1 is already claimed by someone\.\nFix:/
    );
  });

  test('should refuse unknown, finished, and waiting steps', () => {
    const state = makeState();
    state.steps[1].status = 'done';
    state.steps[2].deps = ['s1'];
    expect(() => claimStep(state, { agent: 'a', id: 's9', now: NOW })).toThrow(
      'Unknown step "s9" (steps: s1, s2, s3)'
    );
    expect(() =>
      claimStep(makeState({ steps: [] }), { agent: 'a', id: 's1', now: NOW })
    ).toThrow('(steps: none)');
    expect(() => claimStep(state, { agent: 'a', id: 's2', now: NOW })).toThrow(
      /Step s2 is done; only todo steps/
    );
    expect(() => claimStep(state, { agent: 'a', id: 's3', now: NOW })).toThrow(
      'Step s3 is waiting on s1'
    );
  });

  test('should return no step when nothing is ready', () => {
    const state = makeState({ steps: [] });
    expect(claimStep(state, { agent: 'a', now: NOW })).toEqual({
      state,
      step: null,
    });
  });
});

describe('setStepStatus ownership', () => {
  const claimed = () =>
    claimStep(makeState(), { agent: 'a', id: 's1', now: NOW }).state;

  test('should refuse to start a step another agent owns unless forced', () => {
    expect(() =>
      setStepStatus(claimed(), { id: 's1', status: 'in_progress', agent: 'b' })
    ).toThrow(/already claimed by a\.\nFix: .*--force/);
    const { step } = setStepStatus(claimed(), {
      id: 's1',
      status: 'in_progress',
      agent: 'b',
      force: true,
      now: new Date(0),
    });
    expect(step).toMatchObject({
      owner: 'b',
      claimedAt: new Date(0).toISOString(),
    });
  });

  test('should let the owner restart its step', () => {
    expect(
      setStepStatus(claimed(), { id: 's1', status: 'in_progress', agent: 'a' })
        .step.owner
    ).toBe('a');
  });

  test('should stamp a fresh start and release the claim on todo', () => {
    const started = setStepStatus(makeState(), {
      id: 's1',
      status: 'in_progress',
      agent: 'a',
      now: NOW,
    }).step;
    expect(started.claimedAt).toBe(NOW.toISOString());
    const released = setStepStatus(claimed(), {
      id: 's1',
      status: 'todo',
    }).step;
    expect(released.owner).toBeNull();
    expect(released).not.toHaveProperty('claimedAt');
  });

  test('should keep owner and claim time when a step is done', () => {
    const { step } = setStepStatus(claimed(), { id: 's1', status: 'done' });
    expect(step).toMatchObject({ owner: 'a', claimedAt: NOW.toISOString() });
  });
});
