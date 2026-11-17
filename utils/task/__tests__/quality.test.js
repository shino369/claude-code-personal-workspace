import {
  DEFAULT_MAX_ROUNDS,
  countFindings,
  formatQuality,
  freshQuality,
  toFix,
  validateQuality,
} from '../quality.js';

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
