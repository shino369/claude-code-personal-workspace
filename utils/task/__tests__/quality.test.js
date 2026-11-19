import {
  DEFAULT_MAX_ROUNDS,
  countFindings,
  decideQuality,
  formatQuality,
  freshQuality,
  toFix,
  validateQuality,
} from '../quality.js';
import { createState } from '../state.js';

/**
 * @param {Partial<import('../quality.js').Finding>} [overrides]
 * @returns {import('../quality.js').Finding}
 */
function finding(overrides = {}) {
  return {
    id: 'r1-1',
    round: 1,
    file: 'app/src/a.js',
    line: 12,
    severity: 'high',
    claim: 'Race between save and load',
    scenario: 'Two tabs save at once → one write is lost',
    verdict: 'CONFIRMED',
    reason: 'Reproduced with two concurrent calls',
    step: null,
    ...overrides,
  };
}

/** @param {Partial<import('../quality.js').Quality>} [overrides] */
const quality = (overrides = {}) => ({
  ...freshQuality(),
  reviewRounds: 1,
  ...overrides,
});

const STEPS = new Set(['s1', 's2']);

describe('freshQuality', () => {
  test('should start in build with no rounds and the default cap', () => {
    expect(freshQuality()).toEqual({
      phase: 'build',
      reviewRounds: 0,
      maxRounds: DEFAULT_MAX_ROUNDS,
      reviewedDiff: null,
      findings: [],
    });
    expect(DEFAULT_MAX_ROUNDS).toBe(2);
  });
});

describe('validateQuality', () => {
  test('should accept a fresh state and well-formed findings', () => {
    expect(validateQuality(freshQuality(), STEPS)).toEqual([]);
    expect(
      validateQuality(
        quality({
          reviewedDiff: 'abc',
          findings: [
            finding(),
            finding({ id: 'r1-2', line: null, step: 's2' }),
          ],
        }),
        STEPS
      )
    ).toEqual([]);
  });

  test('should reject a non-object', () => {
    expect(validateQuality([], STEPS)).toEqual(['quality must be an object']);
  });

  test('should report every invalid top-level field', () => {
    expect(
      validateQuality(
        {
          phase: 'done',
          reviewRounds: -1,
          maxRounds: 0,
          reviewedDiff: 3,
          base: 4,
          nudged: 5,
          findings: {},
        },
        STEPS
      )
    ).toEqual([
      'quality.phase must be one of build, review, fix, complete',
      'quality.reviewRounds must be an int ≥ 0',
      'quality.maxRounds must be an int ≥ 1',
      'quality.reviewedDiff must be a string or null',
      'quality.base must be a git ref or null',
      'quality.nudged must be a string or null',
      'quality.findings must be an array',
    ]);
  });

  test('should report every invalid finding field', () => {
    expect(
      validateQuality(
        quality({
          findings: [
            /** @type {any} */ ('x'),
            /** @type {any} */ ({
              id: 1,
              round: 0,
              file: 'a',
              line: 0,
              severity: 'critical',
              claim: 'c',
              scenario: 's',
              verdict: 'MAYBE',
              reason: 'r',
              step: 2,
            }),
          ],
        }),
        STEPS
      )
    ).toEqual([
      'quality.findings[0] must be an object',
      'quality.findings[1].id must be a string',
      'quality.findings[1].round must be an int ≥ 1',
      'quality.findings[1].line must be an int ≥ 1 or null',
      'quality.findings[1].severity must be one of must-fix, high, medium, low',
      'quality.findings[1].verdict must be one of CONFIRMED, REFUTED',
      'quality.findings[1].step must be a step id or null',
    ]);
  });

  test('should report duplicate ids, future rounds, and unknown steps', () => {
    expect(
      validateQuality(
        quality({
          findings: [
            finding(),
            finding({ round: 2 }),
            finding({ id: 'r1-3', step: 's9' }),
          ],
        }),
        STEPS
      )
    ).toEqual([
      'quality.findings: duplicate id r1-1',
      'quality.findings[1].round 2 is after the last round (1)',
      'quality.findings[2].step s9 is not a step',
    ]);
  });
});

describe('toFix and countFindings', () => {
  const q = quality({
    findings: [
      finding({ id: 'a', severity: 'must-fix', step: 's1' }),
      finding({ id: 'b', severity: 'high', step: 's2' }),
      finding({ id: 'c', severity: 'high' }),
      finding({ id: 'd', severity: 'medium' }),
      finding({ id: 'e', severity: 'must-fix', verdict: 'REFUTED' }),
    ],
  });
  const steps = [
    { id: 's1', status: 'done' },
    { id: 's2', status: 'in_progress' },
  ];

  test('should pick CONFIRMED must-fix and high findings only', () => {
    expect(toFix(q).map((f) => f.id)).toEqual(['a', 'b', 'c']);
  });

  test('should count open fixes by their step status', () => {
    expect(countFindings(q, steps)).toEqual({
      total: 5,
      confirmed: 4,
      refuted: 1,
      toFix: 3,
      openFixes: 2,
      recordedOnly: 1,
    });
  });

  test('should format the brief line', () => {
    expect(formatQuality(q, steps)).toBe(
      'build — review round 1/2; 5 finding(s): 4 confirmed, 1 refuted; 2 of 3 must-fix/high open; 1 medium/low recorded'
    );
    expect(formatQuality(freshQuality(), [])).toBe(
      'build — review round 0/2; no findings yet'
    );
  });
});

describe('decideQuality', () => {
  /**
   * @param {Partial<import('../quality.js').Quality>} [q]
   * @param {Array<{ id: string, status: import('../state.js').StepStatus }>} [steps]
   * @returns {import('../state.js').TaskState}
   */
  const code = (q = {}, steps = [{ id: 's1', status: 'done' }]) => ({
    ...createState({ name: 'demo', goal: 'G', verify: ['t'], kind: 'code' }),
    steps: steps.map((s) => ({
      ...s,
      title: `${s.id} title`,
      deps: [],
      owner: null,
    })),
    quality: { ...freshQuality(), ...q },
  });
  const decide = (
    /** @type {import('../state.js').TaskState} */ state,
    fingerprint = /** @type {string | null} */ ('fp2')
  ) => decideQuality({ state, fingerprint });

  test('should ask for the first review once every step is done', () => {
    const result = decide(code());
    expect(result.action).toBe('block');
    expect(result.reason).toContain('run review round 1/2 in clean contexts');
    expect(result.reason).toContain('1. pnpm task review');
    expect(result.reason).toContain('this reminder is not repeated');
    expect(result.quality.nudged).toBe('review round 1:r0:fp2:');
  });

  test('should remind only once per situation', () => {
    const first = decide(code());
    const again = decide({ ...code(), quality: first.quality });
    expect(again).toEqual({
      action: 'allow',
      message:
        'Quality loop for demo: review round 1 is still pending (reminded once already).',
      quality: first.quality,
    });
    expect(decide({ ...code(), quality: first.quality }, 'fp3').action).toBe(
      'block'
    );
  });

  test('should ask for the review when only steps waiting on someone else are left', () => {
    const result = decide(
      code({}, [
        { id: 's1', status: 'done' },
        { id: 's2', status: 'waiting' },
      ])
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain('run review round 1/2');
  });

  test('should allow a stop while a step is blocked or work is open', () => {
    expect(decide(code({}, [{ id: 's1', status: 'blocked' }])).action).toBe(
      'allow'
    );
    expect(decide(code({}, [{ id: 's1', status: 'in_progress' }]))).toEqual({
      action: 'allow',
      quality: code().quality,
    });
  });

  test('should ask to finish an open round', () => {
    const result = decide(code({ phase: 'review', reviewRounds: 1 }));
    expect(result.action).toBe('block');
    expect(result.reason).toContain(
      'Review round 1/2 for demo is open but not recorded.'
    );
  });

  test('should still remind about an open round when there is no fingerprint', () => {
    const result = decide(code({ phase: 'review', reviewRounds: 1 }), null);
    expect(result.quality.nudged).toBe('the open review round:r1:-:');
  });

  test('should ask to finish confirmed fixes and list their steps', () => {
    const result = decide(
      code(
        {
          phase: 'fix',
          reviewRounds: 1,
          findings: [finding({ step: 's2' }), finding({ id: 'b', step: null })],
        },
        [
          { id: 's1', status: 'done' },
          { id: 's2', status: 'todo' },
        ]
      )
    );
    expect(result.action).toBe('block');
    expect(result.reason).toContain(
      'Review round 1 confirmed 2 must-fix/high finding(s) that are not fixed yet:\n- s2. s2 title'
    );
  });

  test('should ask for round 2 after the fixes changed the code', () => {
    const result = decide(
      code({
        phase: 'fix',
        reviewRounds: 1,
        reviewedDiff: 'fp1',
        findings: [finding({ step: 's1' })],
      })
    );
    expect(result.reason).toContain('run review round 2/2');
  });

  test('should let the stop through when the scope cannot be fingerprinted', () => {
    expect(decide(code(), null)).toEqual({
      action: 'allow',
      quality: code().quality,
    });
  });

  test('should allow quietly once complete and nothing changed', () => {
    const state = code({
      phase: 'complete',
      reviewRounds: 1,
      reviewedDiff: 'fp2',
    });
    expect(decide(state)).toEqual({ action: 'allow', quality: state.quality });
  });

  test('should complete the loop after the last round and note what is left', () => {
    const result = decide(
      code({
        phase: 'fix',
        reviewRounds: 2,
        nudged: 'x',
        findings: [
          finding({ step: 's1' }),
          finding({ id: 'm', severity: 'medium' }),
          finding({ id: 'l', severity: 'low', line: null }),
          finding({ id: 'r', verdict: 'REFUTED' }),
        ],
      })
    );
    expect(result).toMatchObject({
      action: 'allow',
      message: '✓ quality loop complete for demo (2 review round(s)).',
      quality: { phase: 'complete', nudged: null },
    });
    expect(result.note).toBe(
      'Quality loop complete after 2/2 review round(s): 4 finding(s), 1 must-fix/high fixed, 1 refuted. Recorded, not fixed (list under Open): m medium app/src/a.js:12 — Race between save and load; l low app/src/a.js — Race between save and load.'
    );
  });

  test('should complete without leftovers when the code is unchanged since review', () => {
    const result = decide(
      code({ phase: 'build', reviewRounds: 1, reviewedDiff: 'fp2' })
    );
    expect(result.note).toContain('Nothing recorded for later.');
  });

  test('should treat a code state without quality as fresh', () => {
    const { quality: _q, ...state } = code();
    expect(decide(state).action).toBe('block');
  });
});
