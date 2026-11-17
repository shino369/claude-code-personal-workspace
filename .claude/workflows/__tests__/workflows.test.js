/**
 * Smoke tests for the saved workflows. The scripts run only inside the
 * Workflow tool (top-level return, agent()/pipeline() globals), so each one is
 * evaluated here as an async function body against stubbed globals and a
 * scripted `agent`.
 */
import fs from 'fs';
import path from 'path';

const DIR = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = ['review-changes', 'implement-plan', 'research'];
const AsyncFunction = /** @type {FunctionConstructor} */ (
  Object.getPrototypeOf(async () => {}).constructor
);

/** @param {string} name */
const source = (name) => fs.readFileSync(path.join(DIR, `${name}.js`), 'utf-8');

/**
 * @param {string} name
 * @returns {{ name: string, description: string, phases: Array<{ title: string }> }}
 */
function readMeta(name) {
  const match = /^export const meta = (\{[\s\S]*?\n\});/m.exec(source(name));
  if (!match) throw new Error(`${name}: no meta literal`);
  return new Function(`return ${match[1]}`)();
}

/**
 * @typedef {{ prompt: string, opts: Record<string, any> }} Call
 * @param {string} name
 * @param {{ args?: unknown, respond: (call: Call) => unknown }} options
 */
async function runWorkflow(name, { args, respond }) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  /** @type {string[]} */
  const phases = [];
  const agent = async (/** @type {string} */ prompt, opts = {}) => {
    const call = { prompt, opts };
    calls.push(call);
    return respond(call);
  };
  const parallel = (/** @type {Array<() => Promise<unknown>>} */ thunks) =>
    Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = (
    /** @type {unknown[]} */ items,
    /** @type {Array<Function>} */ ...stages
  ) =>
    Promise.all(
      items.map(async (item, index) => {
        let value = item;
        try {
          for (const stage of stages) value = await stage(value, item, index);
          return value;
        } catch {
          return null;
        }
      })
    );
  const body = source(name).replace(/^export const meta =/m, 'const meta =');
  const fn = new AsyncFunction(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'args',
    'budget',
    'workflow',
    body
  );
  const result = await fn(
    agent,
    parallel,
    pipeline,
    (/** @type {string} */ title) => phases.push(title),
    (/** @type {string} */ message) => logs.push(message),
    args,
    { total: null, spent: () => 0, remaining: () => Infinity },
    () => {
      throw new Error('nested workflows are not stubbed');
    }
  );
  return { result, calls, logs, phases };
}

/** @param {Call[]} calls @param {string} label */
const labels = (calls, label) =>
  calls.filter((c) => c.opts.label?.startsWith(label));

describe.each(WORKFLOWS)('%s meta and runtime rules', (name) => {
  test('should have a literal meta with name, description, and phases', () => {
    const meta = readMeta(name);
    expect(meta.name).toBe(name);
    expect(meta.description).toEqual(expect.any(String));
    expect(meta.phases.length).toBeGreaterThan(0);
  });

  test('should avoid APIs the Workflow runtime forbids', () => {
    expect(source(name)).not.toMatch(
      /Date\.now\(|Math\.random\(|new Date\(\)|\brequire\(|\bimport\s/
    );
  });

  test('should only use phase titles declared in meta', () => {
    const titles = new Set(readMeta(name).phases.map((p) => p.title));
    const used = [...source(name).matchAll(/phase(?:\(|: )'([^']+)'/g)].map(
      (m) => m[1]
    );
    expect(used.length).toBeGreaterThan(0);
    for (const title of used) expect(titles).toContain(title);
  });
});

describe('review-changes', () => {
  test('should stop early when nothing changed', async () => {
    const { result, calls } = await runWorkflow('review-changes', {
      respond: () => ({ base: 'abc', summary: '', files: [] }),
    });
    expect(result).toEqual({
      base: 'main',
      summary: '',
      confirmed: [],
      rejected: 0,
    });
    expect(calls).toHaveLength(1);
  });

  test('should verify findings per dimension and sort by severity', async () => {
    const { result, calls, logs } = await runWorkflow('review-changes', {
      args: { base: 'dev', focus: 'claims' },
      respond: ({ opts }) => {
        switch (opts.label) {
          case 'scope':
            return {
              base: 'abc',
              summary: 'S',
              files: [{ path: 'a.js', change: 'c' }],
            };
          case 'review:correctness':
            return {
              findings: [
                {
                  file: 'a.js',
                  line: 1,
                  severity: 'low',
                  title: 'L',
                  failure_scenario: 'x',
                },
                {
                  file: 'a.js',
                  line: 2,
                  severity: 'high',
                  title: 'H',
                  failure_scenario: 'y',
                },
                {
                  file: 'a.js',
                  line: 3,
                  severity: 'medium',
                  title: 'gone',
                  failure_scenario: 'z',
                },
              ],
            };
          case 'verify:correctness':
            return {
              verdicts: [
                { index: 0, real: true, reason: 'r0' },
                { index: 1, real: true, reason: 'r1' },
                { index: 2, real: false, reason: 'handled' },
              ],
            };
          case 'review:security':
            return { findings: [] };
          case 'review:tests':
            return null;
          case 'review:standards':
            return {
              findings: [
                {
                  file: 'b.js',
                  line: 9,
                  severity: 'medium',
                  title: 'M',
                  failure_scenario: 'w',
                },
              ],
            };
          case 'verify:standards':
            return null;
          default:
            throw new Error(`unexpected ${opts.label}`);
        }
      },
    });
    expect(
      result.confirmed.map((/** @type {any} */ f) => [f.title, f.verdict])
    ).toEqual([
      ['H', 'r1'],
      ['L', 'r0'],
    ]);
    expect(result.rejected).toBe(2);
    expect(labels(calls, 'review:')[0].prompt).toContain('focus on: claims');
    expect(calls[0].prompt).toContain('against `dev`');
    expect(logs).toContain('2 confirmed, 2 refuted');
  });

  test('should report dimensions that did not finish', async () => {
    const { logs } = await runWorkflow('review-changes', {
      respond: ({ opts }) => {
        if (opts.label === 'scope') {
          return {
            base: 'abc',
            summary: 'S',
            files: [{ path: 'a.js', change: 'c' }],
          };
        }
        if (opts.label === 'review:security') throw new Error('died');
        return { findings: [] };
      },
    });
    expect(logs).toContain(
      '1 dimension(s) did not finish; their findings are missing.'
    );
  });
});

describe('implement-plan', () => {
  const PLAN = {
    task: 't-261117',
    root: '/repo',
    verify: ['pnpm check'],
    steps: [
      { id: 's1', title: 'One', status: 'todo', deps: [] },
      { id: 's2', title: 'Two', status: 'todo', deps: [] },
      { id: 's3', title: 'Three', status: 'todo', deps: ['s1', 's0'] },
      { id: 's0', title: 'Zero', status: 'done', deps: [] },
      { id: 's5', title: 'Five', status: 'blocked', deps: [] },
      { id: 's4', title: 'Four', status: 'todo', deps: ['s5'] },
    ],
  };
  const INTEGRATION = {
    branch: 'wf/t-261117',
    dir: '/wt',
    merged: ['wf/t-261117--s1'],
    conflicts: [],
    verifyOk: true,
  };

  /** @param {Record<string, unknown>} [overrides] */
  const responder =
    (overrides = {}) =>
    (/** @type {Call} */ { opts }) => {
      if (Object.hasOwn(overrides, opts.label)) {
        const value = overrides[opts.label];
        return typeof value === 'function' ? value() : value;
      }
      if (opts.label === 'plan') return PLAN;
      if (opts.label.startsWith('step:')) {
        const id = opts.label.slice(5);
        return { id, ok: true, branch: `wf/t-261117--${id}`, summary: 'ok' };
      }
      if (opts.label === 'integrate') return INTEGRATION;
      if (opts.label === 'verifier')
        return { pass: true, report: 'VERDICT: PASS' };
      throw new Error(`unexpected ${opts.label}`);
    };

  test('should run steps after their deps in worktrees, then integrate and verify', async () => {
    /** @type {string[]} */
    const order = [];
    const { result, calls } = await runWorkflow('implement-plan', {
      args: { task: 't' },
      respond: (call) => {
        order.push(call.opts.label);
        return responder()(call);
      },
    });
    const steps = labels(calls, 'step:');
    expect(steps.map((c) => c.opts.label)).toEqual([
      'step:s1',
      'step:s2',
      'step:s3',
    ]);
    expect(steps.every((c) => c.opts.isolation === 'worktree')).toBe(true);
    expect(order.indexOf('step:s3')).toBeGreaterThan(order.indexOf('step:s1'));
    const s3 = steps[2].prompt;
    expect(s3).toContain('git merge --no-edit wf/t-261117--s1`');
    expect(s3).toContain(
      'pnpm --dir "/repo" task claim s3 --task t-261117 --agent workflow/s3'
    );
    expect(steps[0].prompt).not.toContain('git merge');
    expect(calls[0].prompt).toContain('pnpm task status t --json');
    expect(result.skipped).toEqual([{ id: 's4', reason: 'waits on s5' }]);
    expect(result.ok).toBe(false);
    expect(result.verdict.pass).toBe(true);
  });

  test('should run a step after a dependency listed later in the plan', async () => {
    const plan = {
      ...PLAN,
      steps: [
        { id: 's1', title: 'One', status: 'todo', deps: ['s2'] },
        { id: 's2', title: 'Two', status: 'todo', deps: [] },
      ],
    };
    const { result, calls } = await runWorkflow('implement-plan', {
      respond: responder({ plan }),
    });
    expect(labels(calls, 'step:').map((c) => c.opts.label)).toEqual([
      'step:s2',
      'step:s1',
    ]);
    expect(labels(calls, 'step:')[1].prompt).toContain(
      'git merge --no-edit wf/t-261117--s2`'
    );
    expect(result.skipped).toEqual([]);
  });

  test('should be ok when every step, the merge, and the verifier pass', async () => {
    const plan = { ...PLAN, steps: PLAN.steps.slice(0, 4) };
    const { result } = await runWorkflow('implement-plan', {
      respond: responder({ plan }),
    });
    expect(result.ok).toBe(true);
  });

  test('should skip dependents of a failed step and cap the step count', async () => {
    const plan = { ...PLAN, steps: PLAN.steps.slice(0, 4) };
    const { result, calls, logs } = await runWorkflow('implement-plan', {
      args: { maxSteps: 2 },
      respond: responder({ plan, 'step:s1': null }),
    });
    expect(labels(calls, 'step:').map((c) => c.opts.label)).toEqual([
      'step:s1',
      'step:s2',
    ]);
    expect(result.skipped).toEqual([{ id: 's3', reason: 'over maxSteps (2)' }]);
    expect(result.steps[0]).toMatchObject({
      ok: false,
      summary: 'the step agent did not return',
    });
    expect(logs).toContain('1/2 step(s) finished');

    const chained = await runWorkflow('implement-plan', {
      respond: responder({
        plan,
        'step:s1': { id: 's1', ok: false, branch: 'b', summary: 'red' },
      }),
    });
    expect(chained.result.steps[2]).toMatchObject({
      id: 's3',
      ok: false,
      summary: 'not started: dependency s1 did not finish',
    });
  });

  test('should stop without a usable plan', async () => {
    const problem = await runWorkflow('implement-plan', {
      respond: responder({
        plan: { ...PLAN, problem: 'no task. Fix: pnpm task new' },
      }),
    });
    expect(problem.result).toMatchObject({
      ok: false,
      problem: 'no task. Fix: pnpm task new',
    });
    const missing = await runWorkflow('implement-plan', {
      respond: responder({ plan: null }),
    });
    expect(missing.result.problem).toBe('no plan');
    const noVerify = await runWorkflow('implement-plan', {
      respond: responder({ plan: { ...PLAN, verify: [] } }),
    });
    expect(noVerify.result.problem).toMatch(/^no verify commands/);
    const idle = await runWorkflow('implement-plan', {
      respond: responder({ plan: { ...PLAN, steps: PLAN.steps.slice(3) } }),
    });
    expect(idle.result.problem).toBe('nothing to run');
  });

  test('should stop when no step finished or integration did not return', async () => {
    const plan = { ...PLAN, steps: PLAN.steps.slice(0, 1) };
    const failed = await runWorkflow('implement-plan', {
      respond: responder({
        plan,
        'step:s1': { id: 's1', ok: false, branch: 'b', summary: 'x' },
      }),
    });
    expect(failed.result).toMatchObject({ ok: false, integration: null });
    expect(labels(failed.calls, 'integrate')).toHaveLength(0);
    const lost = await runWorkflow('implement-plan', {
      respond: responder({ plan, integrate: null }),
    });
    expect(lost.result).toMatchObject({
      ok: false,
      integration: null,
      verdict: null,
    });
  });
});

describe('research', () => {
  const SUBS = {
    subquestions: [
      { question: 'What is A?', where: 'docs' },
      { question: 'What is B?', where: 'web' },
      { question: 'What is C?', where: 'code' },
    ],
  };

  test('should require a question', async () => {
    const { result, calls } = await runWorkflow('research', {
      respond: () => null,
    });
    expect(result).toEqual({ ok: false, problem: 'no question' });
    expect(calls).toHaveLength(0);
  });

  test('should stop when the planner returns nothing', async () => {
    const { result } = await runWorkflow('research', {
      args: 'Why?',
      respond: () => null,
    });
    expect(result).toEqual({ ok: false, problem: 'no plan' });
  });

  test('should fact-check claims and pass them to the synthesis', async () => {
    const { result, calls, logs } = await runWorkflow('research', {
      args: { question: 'Why?', name: 'why-study' },
      respond: ({ opts }) => {
        if (opts.label === 'plan') return SUBS;
        if (opts.label === 'research:What is A?') {
          return {
            answer: 'A is a.',
            claims: [
              { claim: 'a1', source: 'https://a' },
              { claim: 'a2', source: 'x.js:1' },
            ],
            gaps: 'none known',
          };
        }
        if (opts.label === 'check:What is A?') {
          return { checked: [{ index: 0, supported: true, note: 'ok' }] };
        }
        if (opts.label === 'research:What is B?')
          return { answer: 'B.', claims: [] };
        if (opts.label === 'research:What is C?') return null;
        if (opts.label === 'synthesize')
          return { path: 'tasks/t/studies/S.md', summary: 's' };
        throw new Error(`unexpected ${opts.label}`);
      },
    });
    const synth = labels(calls, 'synthesize')[0].prompt;
    expect(synth).toContain('- [supported] a1 (https://a) — ok');
    expect(synth).toContain('- [UNSUPPORTED] a2 (x.js:1)');
    expect(synth).toContain('Gaps: none known');
    expect(synth).toContain('pnpm task template study --name why-study');
    expect(result).toMatchObject({ ok: true, unsupported: 1 });
    expect(logs).toContain('1 sub-question(s) returned nothing.');
  });

  test('should mark claims unchecked when the checker does not return', async () => {
    const { result } = await runWorkflow('research', {
      args: { question: 'Why?' },
      respond: ({ opts }) => {
        if (opts.label === 'plan')
          return { subquestions: SUBS.subquestions.slice(0, 1) };
        if (opts.label.startsWith('research:')) {
          return { answer: 'A.', claims: [{ claim: 'a1', source: 's' }] };
        }
        return null;
      },
    });
    expect(result.answers[0].claims[0]).toMatchObject({
      supported: false,
      note: 'not checked',
    });
    expect(result.ok).toBe(false);
  });
});
