/**
 * Review rounds for code tasks: `pnpm task review` opens a round and writes
 * the brief a clean-context reviewer works from; `pnpm task review record`
 * reads the triaged findings table and turns CONFIRMED must-fix/high
 * findings into `fix:` steps.
 *
 * Scope: the task's own code (files `pnpm task check` looks at) when it has
 * any; otherwise the git changes since a base ref (default `main`), for
 * tasks that change the workspace itself.
 */
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listCodeFiles } from './check.js';
import { git } from './git.js';
import { SEVERITIES, VERDICTS, freshQuality, toFix } from './quality.js';
import { addStep } from './state.js';

export const DEFAULT_BASE = 'main';
export const STANDARDS = [
  'AGENTS.md',
  '.claude/rules/working-with-script.md',
  '.claude/rules/testing.md',
];
export const FINDINGS_HEADER = [
  'id',
  'file:line',
  'severity',
  'claim',
  'failure scenario',
  'verdict',
  'reason',
];

export const SEVERITY_RUBRIC = `- must-fix: wrong behavior, data loss, a security hole, or an acceptance criterion not met
- high: a design or architecture problem that will cause bugs or blocks the goal
- medium: a real but local problem (recorded, not fixed this task)
- low: cleanup, naming, style (recorded, not fixed this task)`;

/**
 * @typedef {import('./state.js').TaskState} TaskState
 * @typedef {import('./quality.js').Finding} Finding
 * @typedef {(args: string[], cwd: string) => string | null} RunGit
 * @typedef {{ base: string | null, mergeBase: string | null, files: string[] }} Scope
 */

/** @type {RunGit} */
export const defaultRunGit = (args, cwd) =>
  git(
    /** @type {import('./git.js').Spawn} */ (
      /** @type {unknown} */ (spawnSync)
    ),
    cwd,
    args
  );

/**
 * @param {string} name
 * @param {number} round
 */
export const reviewFiles = (name, round) => ({
  brief: path.posix.join('reviews', `BRIEF_${name}-r${round}.md`),
  findings: path.posix.join('reviews', `REVIEW_${name}-r${round}.md`),
});

/**
 * The files a review round covers, as sorted root-relative POSIX paths.
 *
 * @param {{ rootDir: string, taskDir: string, base: string | null, runGit?: RunGit }} options
 * @returns {Scope}
 */
export function reviewScope({
  rootDir,
  taskDir,
  base,
  runGit = defaultRunGit,
}) {
  if (base === null) {
    const prefix = path.relative(rootDir, taskDir).split(path.sep).join('/');
    return {
      base: null,
      mergeBase: null,
      files: listCodeFiles(taskDir).map((file) => `${prefix}/${file}`),
    };
  }
  const mergeBase = runGit(['merge-base', 'HEAD', base], rootDir);
  if (!mergeBase) {
    throw new Error(
      `Cannot find the merge base of HEAD and ${base}.\nFix: pass an existing branch or commit: pnpm task review --base <ref>`
    );
  }
  const lines = (/** @type {string | null} */ text) =>
    (text ?? '').split('\n').filter(Boolean);
  const files = new Set([
    ...lines(runGit(['diff', '--name-only', mergeBase], rootDir)),
    ...lines(runGit(['ls-files', '--others', '--exclude-standard'], rootDir)),
  ]);
  return {
    base,
    mergeBase,
    files: [...files].filter((file) => !file.startsWith('tasks/')).sort(),
  };
}

/**
 * Content hash of the files in scope; changes whenever reviewed code does.
 *
 * @param {string} rootDir
 * @param {string[]} files root-relative paths
 * @returns {string}
 */
export function fingerprint(rootDir, files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort()) {
    hash.update(`${file}\0`);
    const full = path.join(rootDir, file);
    hash.update(fs.existsSync(full) ? fs.readFileSync(full) : '\0deleted');
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * Open the next review round, or return the open one unchanged.
 *
 * @param {TaskState} state
 * @param {{ fingerprint: string, base: string | null, force?: boolean }} options
 * @returns {{ state: TaskState, round: number, reopened: boolean }}
 */
export function openRound(state, { fingerprint: print, base, force = false }) {
  if (state.kind !== 'code') {
    throw new Error(
      `${state.name} is not a code task, so it has no review loop.\nFix: pnpm task set --kind code`
    );
  }
  const quality = state.quality ?? freshQuality();
  if (quality.phase === 'review') {
    return { state, round: quality.reviewRounds, reopened: true };
  }
  if (quality.reviewRounds >= quality.maxRounds) {
    throw new Error(
      `${state.name} already had ${quality.reviewRounds}/${quality.maxRounds} review rounds (the limit). Do not review again: list what is left as Open.\nFix: pnpm task note --done "…" --next "…" --open "<remaining medium/low findings>"`
    );
  }
  const done = new Set(
    state.steps.filter((s) => s.status === 'done').map((s) => s.id)
  );
  const open = toFix(quality).filter((f) => !f.step || !done.has(f.step));
  if (open.length > 0) {
    throw new Error(
      `Fix the findings from round ${quality.reviewRounds} before the next review: ${open.map((f) => f.step ?? f.id).join(', ')}.\nFix: pnpm task next`
    );
  }
  if (!force && !state.lastVerify?.ok) {
    throw new Error(
      `Review green code: the last verify ${state.lastVerify ? 'failed' : 'has not run'}.\nFix: pnpm task verify (or pnpm task review --force if the user agrees)`
    );
  }
  const round = quality.reviewRounds + 1;
  return {
    state: {
      ...state,
      quality: {
        ...quality,
        phase: 'review',
        reviewRounds: round,
        reviewedDiff: print,
        base,
      },
    },
    round,
    reopened: false,
  };
}

/**
 * @param {Finding} f
 * @returns {string}
 */
const where = (f) => `${f.file}${f.line ? `:${f.line}` : ''}`;

/**
 * The brief a clean-context reviewer works from.
 *
 * @param {{ state: TaskState, round: number, scope: Scope, taskRel: string }} options
 * @returns {string}
 */
export function formatReviewBrief({ state, round, scope, taskRel }) {
  const quality = state.quality ?? freshQuality();
  const files = reviewFiles(state.name, round);
  const scopeLine =
    scope.base === null
      ? `the task's code under ${taskRel}/`
      : `changes since ${scope.base} (merge base ${String(scope.mergeBase).slice(0, 12)}; see them with: git diff ${String(scope.mergeBase).slice(0, 12)} -- <file>)`;
  const earlier = quality.findings.filter((f) => f.round < round);
  const refuted = earlier.filter((f) => f.verdict === 'REFUTED');
  const fixed = earlier.filter((f) => f.verdict === 'CONFIRMED' && f.step);
  const lines = [
    `# Review brief — ${state.name}, round ${round}/${quality.maxRounds}`,
    '',
    'You review in a clean context: judge the code against the plan and the standards, not',
    "the author's intentions. Read the files; do not edit anything.",
    '',
    `Goal: ${state.goal}`,
    `Plan (acceptance, steps, decisions): ${taskRel}/plan.md`,
    `Standards: ${STANDARDS.join('; ')}`,
    `E2E: ${state.e2e ?? 'no'}`,
    '',
    `## Scope — ${scope.files.length} file(s), ${scopeLine}`,
    '',
    ...(scope.files.length > 0
      ? scope.files.map((file) => `- ${file}`)
      : ['- (no files: nothing changed)']),
    '',
    '## Look for',
    '',
    '- spec gaps: acceptance criteria not met, plan steps missing or half done',
    '- bugs: wrong output, crashes, races, unhandled errors, wrong edge cases',
    '- security: injection, path traversal, secrets, unsafe input handling',
    '- design: wrong boundaries, duplication, hard-to-test structure, dead code',
    '- tests: missing branches, weakened or tautological assertions, untested failure paths',
    '- standards: anything AGENTS.md or the rules files forbid',
    '',
    '## Severity',
    '',
    SEVERITY_RUBRIC,
    '',
    'Every finding needs a concrete failure scenario (inputs or state → wrong result). No',
    'scenario, no finding. Do not pad: zero findings is a valid review.',
    '',
  ];
  if (refuted.length > 0 || fixed.length > 0) {
    lines.push('## Earlier rounds', '');
    for (const f of refuted) {
      lines.push(
        `- refuted ${f.id} (${where(f)}): ${f.claim} — ${f.reason}. Do not report it again without new evidence.`
      );
    }
    for (const f of fixed) {
      lines.push(
        `- fixed ${f.id} (${where(f)}): ${f.claim}. Check that the fix holds.`
      );
    }
    lines.push('');
  }
  lines.push(
    '## Output',
    '',
    `1. Review: add one row per finding to the table in ${taskRel}/${files.findings}.`,
    '   Leave verdict and reason empty. Escape a | inside a cell as \\|.',
    '2. Triage (a different clean-context agent): for each row, try to refute it by reading',
    '   the code. CONFIRMED only when the failure scenario really happens; REFUTED when it does',
    '   not or you are not sure. Write the verdict and a one-line reason.',
    '3. Record: pnpm task review record'
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The findings file for a round, with an empty table.
 *
 * @param {{ name: string, round: number, brief: string }} options
 * @returns {string}
 */
export function findingsTemplate({ name, round, brief }) {
  return [
    `# Review round ${round} — ${name}`,
    '',
    `Brief: ${brief}`,
    '',
    'Reviewer: one row per finding; leave verdict and reason empty.',
    'Triage: set verdict to CONFIRMED or REFUTED (REFUTED when unsure) and give the reason.',
    'severity: must-fix | high | medium | low. file:line: path relative to the repo root.',
    '',
    `| ${FINDINGS_HEADER.join(' | ')} |`,
    `| ${FINDINGS_HEADER.map(() => '---').join(' | ')} |`,
    '',
  ].join('\n');
}

/**
 * Split a Markdown table row into trimmed cells (`\|` is a literal pipe).
 *
 * @param {string} line
 * @returns {string[]}
 */
export function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

/**
 * Parse the findings table of a round.
 *
 * @param {string} markdown
 * @param {{ round: number, takenIds: Set<string> }} options
 * @returns {{ findings: Finding[], errors: string[] }}
 */
export function parseFindings(markdown, { round, takenIds }) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line) =>
      line.trim().startsWith('|') &&
      splitRow(line).join('|').toLowerCase() === FINDINGS_HEADER.join('|')
  );
  if (start === -1) {
    return {
      findings: [],
      errors: [
        `no findings table: the header must be | ${FINDINGS_HEADER.join(' | ')} |`,
      ],
    };
  }
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const errors = [];
  const ids = new Set(takenIds);
  let next = 1;
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    if (cells.every((cell) => cell === '')) continue;
    const label = `row ${i - start - 1}`;
    if (cells.length !== FINDINGS_HEADER.length) {
      errors.push(
        `${label}: ${cells.length} cells, expected ${FINDINGS_HEADER.length} (escape | inside a cell as \\|)`
      );
      continue;
    }
    const [rawId, location, severity, claim, scenario, verdict, reason] = cells;
    const problems = [];
    if (!SEVERITIES.includes(severity.toLowerCase())) {
      problems.push(
        `severity "${severity}" is not one of ${SEVERITIES.join(', ')}`
      );
    }
    if (!verdict) problems.push('no verdict yet — run the triage first');
    else if (!VERDICTS.includes(verdict.toUpperCase())) {
      problems.push(`verdict "${verdict}" is not CONFIRMED or REFUTED`);
    }
    if (verdict && !reason) problems.push('the verdict needs a reason');
    if (!claim) problems.push('claim is empty');
    if (!scenario) problems.push('failure scenario is empty');
    const loc = location.replace(/`/g, '').match(/^(.+?)(?::(\d+))?(?::\d+)?$/);
    if (!loc) problems.push('file:line is empty');
    let id = rawId.replace(/`/g, '');
    if (!id) {
      while (ids.has(`r${round}-${next}`)) next++;
      id = `r${round}-${next}`;
    } else if (ids.has(id)) {
      problems.push(`id ${id} is already used`);
    }
    if (problems.length > 0) {
      errors.push(
        `${label}${rawId ? ` (${rawId})` : ''}: ${problems.join('; ')}`
      );
      continue;
    }
    ids.add(id);
    const match = /** @type {RegExpMatchArray} */ (loc);
    findings.push({
      id,
      round,
      file: match[1].trim(),
      line: match[2] ? Number(match[2]) : null,
      severity: /** @type {Finding['severity']} */ (severity.toLowerCase()),
      claim,
      scenario,
      verdict: /** @type {Finding['verdict']} */ (verdict.toUpperCase()),
      reason,
      step: null,
    });
  }
  return { findings, errors };
}

/**
 * Close the open round with its findings: CONFIRMED must-fix/high get a
 * `fix:` step each; the phase moves to `fix`, or `complete` when nothing
 * needs fixing.
 *
 * @param {TaskState} state
 * @param {Finding[]} findings
 * @returns {{ state: TaskState, fixSteps: import('./state.js').Step[] }}
 */
export function recordFindings(state, findings) {
  const quality = state.quality ?? freshQuality();
  if (quality.phase !== 'review') {
    throw new Error(
      `${state.name} has no open review round (phase ${quality.phase}).\nFix: pnpm task review`
    );
  }
  let next = state;
  /** @type {import('./state.js').Step[]} */
  const fixSteps = [];
  const recorded = findings.map((finding) => {
    if (toFix({ ...quality, findings: [finding] }).length === 0) return finding;
    const result = addStep(next, {
      title: `fix: ${finding.claim} (${where(finding)}; ${finding.id})`,
    });
    next = result.state;
    fixSteps.push(result.step);
    return { ...finding, step: result.step.id };
  });
  return {
    state: {
      ...next,
      quality: {
        ...quality,
        phase: fixSteps.length > 0 ? 'fix' : 'complete',
        findings: [...quality.findings, ...recorded],
      },
    },
    fixSteps,
  };
}
