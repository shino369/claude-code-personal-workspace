/**
 * Quality loop state for code tasks (`state.quality`): schema, validation,
 * and summaries. Pure; no I/O.
 *
 * The loop (AGENTS.md §4.5): build with TDD → review in a clean context →
 * triage (each finding is CONFIRMED or REFUTED by another clean agent) →
 * fix only CONFIRMED must-fix and high findings → at most `maxRounds`
 * review rounds, then stop; the rest go to NOTES "Open".
 *
 * Phases:
 * - `build`    developing; no review round is open
 * - `review`   a round is open: reviewers run, findings are not recorded yet
 * - `fix`      findings recorded; CONFIRMED must-fix/high have `fix:` steps
 * - `complete` nothing left to fix, or the round limit is reached
 */

export const QUALITY_PHASES = ['build', 'review', 'fix', 'complete'];
export const SEVERITIES = ['must-fix', 'high', 'medium', 'low'];
export const VERDICTS = ['CONFIRMED', 'REFUTED'];
/** Severities that get fixed; medium and low are recorded only (decision 12). */
export const FIX_SEVERITIES = ['must-fix', 'high'];
export const DEFAULT_MAX_ROUNDS = 2;

/**
 * @typedef {'build' | 'review' | 'fix' | 'complete'} QualityPhase
 * @typedef {'must-fix' | 'high' | 'medium' | 'low'} Severity
 * @typedef {{
 *   id: string,
 *   round: number,
 *   file: string,
 *   line: number | null,
 *   severity: Severity,
 *   claim: string,
 *   scenario: string,
 *   verdict: 'CONFIRMED' | 'REFUTED',
 *   reason: string,
 *   step: string | null,
 * }} Finding
 * @typedef {{
 *   phase: QualityPhase,
 *   reviewRounds: number,
 *   maxRounds: number,
 *   reviewedDiff: string | null,
 *   base?: string | null,
 *   nudged?: string | null,
 *   findings: Finding[],
 * }} Quality
 */

/** @returns {Quality} */
export function freshQuality() {
  return {
    phase: 'build',
    reviewRounds: 0,
    maxRounds: DEFAULT_MAX_ROUNDS,
    reviewedDiff: null,
    findings: [],
  };
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
/** @param {unknown} value */
const isString = (value) => typeof value === 'string';
/** @param {unknown} value */
const isCount = (value) => Number.isInteger(value) && Number(value) >= 0;

/**
 * Problems with one finding (empty = valid).
 *
 * @param {unknown} finding
 * @param {number} index
 * @returns {string[]}
 */
function validateFinding(finding, index) {
  const at = `quality.findings[${index}]`;
  if (!isObject(finding)) return [`${at} must be an object`];
  const f = /** @type {Record<string, unknown>} */ (finding);
  /** @type {string[]} */
  const errors = [];
  for (const key of ['id', 'file', 'claim', 'scenario', 'reason']) {
    if (!isString(f[key])) errors.push(`${at}.${key} must be a string`);
  }
  if (!Number.isInteger(f.round) || Number(f.round) < 1) {
    errors.push(`${at}.round must be an int ≥ 1`);
  }
  if (f.line !== null && (!Number.isInteger(f.line) || Number(f.line) < 1)) {
    errors.push(`${at}.line must be an int ≥ 1 or null`);
  }
  if (!SEVERITIES.includes(/** @type {string} */ (f.severity))) {
    errors.push(`${at}.severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (!VERDICTS.includes(/** @type {string} */ (f.verdict))) {
    errors.push(`${at}.verdict must be one of ${VERDICTS.join(', ')}`);
  }
  if (f.step !== null && !isString(f.step)) {
    errors.push(`${at}.step must be a step id or null`);
  }
  return errors;
}

/**
 * Problems with `state.quality` (empty = valid). Step ids in findings are
 * checked against `stepIds`.
 *
 * @param {unknown} quality
 * @param {Set<string>} stepIds
 * @returns {string[]}
 */
export function validateQuality(quality, stepIds) {
  if (!isObject(quality)) return ['quality must be an object'];
  const q = /** @type {Record<string, unknown>} */ (quality);
  /** @type {string[]} */
  const errors = [];
  if (!QUALITY_PHASES.includes(/** @type {string} */ (q.phase))) {
    errors.push(`quality.phase must be one of ${QUALITY_PHASES.join(', ')}`);
  }
  if (!isCount(q.reviewRounds)) {
    errors.push('quality.reviewRounds must be an int ≥ 0');
  }
  if (!Number.isInteger(q.maxRounds) || Number(q.maxRounds) < 1) {
    errors.push('quality.maxRounds must be an int ≥ 1');
  }
  if (q.reviewedDiff !== null && !isString(q.reviewedDiff)) {
    errors.push('quality.reviewedDiff must be a string or null');
  }
  if (q.base !== undefined && q.base !== null && !isString(q.base)) {
    errors.push('quality.base must be a git ref or null');
  }
  if (q.nudged !== undefined && q.nudged !== null && !isString(q.nudged)) {
    errors.push('quality.nudged must be a string or null');
  }
  if (!Array.isArray(q.findings)) {
    errors.push('quality.findings must be an array');
    return errors;
  }
  const ids = new Set();
  q.findings.forEach((finding, index) => {
    const problems = validateFinding(finding, index);
    errors.push(...problems);
    if (problems.length > 0) return;
    const f = /** @type {Finding} */ (finding);
    if (ids.has(f.id)) errors.push(`quality.findings: duplicate id ${f.id}`);
    ids.add(f.id);
    if (f.round > Number(q.reviewRounds)) {
      errors.push(
        `quality.findings[${index}].round ${f.round} is after the last round (${q.reviewRounds})`
      );
    }
    if (f.step !== null && !stepIds.has(f.step)) {
      errors.push(`quality.findings[${index}].step ${f.step} is not a step`);
    }
  });
  return errors;
}

/**
 * CONFIRMED findings that must be fixed (must-fix or high).
 *
 * @param {Quality} quality
 * @returns {Finding[]}
 */
export function toFix(quality) {
  return quality.findings.filter(
    (f) => f.verdict === 'CONFIRMED' && FIX_SEVERITIES.includes(f.severity)
  );
}

/**
 * Counts for the brief and `--json`.
 *
 * @param {Quality} quality
 * @param {Array<{ id: string, status: string }>} steps
 * @returns {{ total: number, confirmed: number, refuted: number, toFix: number, openFixes: number, recordedOnly: number }}
 */
export function countFindings(quality, steps) {
  const done = new Set(
    steps.filter((s) => s.status === 'done').map((s) => s.id)
  );
  const confirmed = quality.findings.filter((f) => f.verdict === 'CONFIRMED');
  const fix = toFix(quality);
  return {
    total: quality.findings.length,
    confirmed: confirmed.length,
    refuted: quality.findings.length - confirmed.length,
    toFix: fix.length,
    openFixes: fix.filter((f) => f.step === null || !done.has(f.step)).length,
    recordedOnly: confirmed.length - fix.length,
  };
}

/**
 * One-line summary for the brief.
 *
 * @param {Quality} quality
 * @param {Array<{ id: string, status: string }>} steps
 * @returns {string}
 */
export function formatQuality(quality, steps) {
  const rounds = `review round ${quality.reviewRounds}/${quality.maxRounds}`;
  const c = countFindings(quality, steps);
  const findings =
    c.total === 0
      ? 'no findings yet'
      : `${c.total} finding(s): ${c.confirmed} confirmed, ${c.refuted} refuted; ${c.openFixes} of ${c.toFix} must-fix/high open; ${c.recordedOnly} medium/low recorded`;
  return `${quality.phase} — ${rounds}; ${findings}`;
}

/**
 * @typedef {{
 *   action: 'block' | 'allow',
 *   reason?: string,
 *   message?: string,
 *   quality: Quality,
 *   note?: string,
 * }} QualityDecision
 */

/**
 * What the Stop hook does about the quality loop once verify passes.
 *
 * Each reminder is given once per situation (phase, round, reviewed code,
 * open fixes): stopping again without changing anything is allowed, so an
 * agent that cannot run reviewers is never blocked forever.
 *
 * @param {{ state: import('./state.js').TaskState, fingerprint: string | null }} input
 *   fingerprint of the review scope now (null when it cannot be computed)
 * @returns {QualityDecision}
 */
export function decideQuality({ state, fingerprint }) {
  const quality = state.quality ?? freshQuality();
  const { phase, reviewRounds: rounds, maxRounds: max } = quality;
  const done = new Set(
    state.steps.filter((s) => s.status === 'done').map((s) => s.id)
  );
  const openFixes = toFix(quality).filter((f) => !f.step || !done.has(f.step));
  const allow = () => ({ action: /** @type {const} */ ('allow'), quality });
  /**
   * @param {string} situation
   * @param {string[]} lines
   * @returns {QualityDecision}
   */
  const nudge = (situation, lines) => {
    const key = `${situation}:r${rounds}:${fingerprint ?? '-'}:${openFixes.map((f) => f.id).join(',')}`;
    if (quality.nudged === key) {
      return {
        action: 'allow',
        message: `Quality loop for ${state.name}: ${situation} is still pending (reminded once already).`,
        quality,
      };
    }
    return {
      action: 'block',
      reason: [
        ...lines,
        'If that cannot be done here (no subagents, or it needs the user), say so and stop; this reminder is not repeated.',
      ].join('\n'),
      quality: { ...quality, nudged: key },
    };
  };

  if (state.steps.some((s) => s.status === 'blocked')) return allow();
  if (phase === 'review') {
    return nudge('the open review round', [
      `Review round ${rounds}/${max} for ${state.name} is open but not recorded.`,
      'Finish it before stopping: the reviewer and then the triage, in clean contexts, as `pnpm task review` printed (run it again to see the brief), then: pnpm task review record',
    ]);
  }
  if (openFixes.length > 0) {
    const steps = state.steps.filter((s) =>
      openFixes.some((f) => f.step === s.id)
    );
    return nudge('the confirmed fixes', [
      `Review round ${rounds} confirmed ${openFixes.length} must-fix/high finding(s) that are not fixed yet:`,
      ...steps.map((s) => `- ${s.id}. ${s.title}`),
      'Fix each test-first, run pnpm task verify, and mark the step done (pnpm task step <id> done).',
    ]);
  }
  // Steps waiting on someone else do not hold back a review of finished work.
  if (state.steps.some((s) => s.status !== 'done' && s.status !== 'waiting')) {
    return allow();
  }
  if (fingerprint === null) return allow();
  if (rounds < max && fingerprint !== quality.reviewedDiff) {
    return nudge(`review round ${rounds + 1}`, [
      `Verify passes and every step of ${state.name} is done. Before stopping, run review round ${rounds + 1}/${max} in clean contexts:`,
      '1. pnpm task review — writes the brief and the findings file',
      '2. the reviewer, then the triage, as its output says (not yourself: you wrote the code)',
      '3. pnpm task review record — confirmed must-fix/high findings become fix: steps',
    ]);
  }
  if (phase === 'complete') return allow();
  const c = countFindings(quality, state.steps);
  const recorded = quality.findings.filter(
    (f) => f.verdict === 'CONFIRMED' && !FIX_SEVERITIES.includes(f.severity)
  );
  return {
    action: 'allow',
    message: `✓ quality loop complete for ${state.name} (${rounds} review round(s)).`,
    quality: { ...quality, phase: 'complete', nudged: null },
    note: [
      `Quality loop complete after ${rounds}/${max} review round(s): ${c.total} finding(s), ${c.toFix} must-fix/high fixed, ${c.refuted} refuted.`,
      recorded.length > 0
        ? `Recorded, not fixed (list under Open): ${recorded.map((f) => `${f.id} ${f.severity} ${f.file}${f.line ? `:${f.line}` : ''} — ${f.claim}`).join('; ')}.`
        : 'Nothing recorded for later.',
    ].join(' '),
  };
}
