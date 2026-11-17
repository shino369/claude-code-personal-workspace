/**
 * `pnpm loop --review`: the quality loop of a code task, headless, for any
 * harness (AGENTS.md §4.5). After the build loop makes verify green:
 *
 * 1. open a review round (`pnpm task review`);
 * 2. a reviewer agent — read-only, fresh context — prints findings rows;
 * 3. a triage agent — read-only, fresh context — prints the same rows with
 *    verdicts (it tries to refute each; unsure means REFUTED);
 * 4. `pnpm task review record` turns CONFIRMED must-fix/high into `fix:` steps;
 * 5. the fixer (the write-mode agent) runs the verify loop until verify passes
 *    and every fix step is marked done;
 *
 * then again, until the round limit (2) is reached or nothing changed since
 * the last review. Reviewers never edit files: they print their rows between
 * BEGIN/END markers on stdout (stderr may echo the prompt, which has an
 * example block) and this module writes them into the findings file.
 */
import fs from 'fs';
import path from 'path';
import { formatGit } from '../task/git.js';
import { INNER_LOOP_ENV } from '../task/loop.js';
import {
  appendSeparator,
  formatLocal,
  formatNoteEntry,
} from '../task/markdown.js';
import {
  SEVERITIES,
  decideQuality,
  freshQuality,
  toFix,
} from '../task/quality.js';
import { FINDINGS_HEADER, splitRow } from '../task/review.js';
import {
  appendNotes,
  loadTask,
  tasksRoot,
  updateState,
} from '../task/store.js';
import { runLoop } from './driver.js';

export const BEGIN = 'BEGIN FINDINGS';
export const END = 'END FINDINGS';

/**
 * @typedef {import('../task/state.js').TaskState} TaskState
 * @typedef {import('./adapters.js').AgentCommand} AgentCommand
 * @typedef {import('./driver.js').LoopDeps & {
 *   runTask: (argv: string[]) => string,
 *   scopeFingerprint: (rootDir: string, taskDir: string, state: TaskState) => string | null,
 * }} ReviewDeps
 * @typedef {'complete' | 'verify' | 'fix' | 'blocked' | 'steps-open' | 'no-scope' | 'reviewer' | 'triage' | 'record' | 'timeout'} ReviewStop
 * @typedef {{ ok: boolean, reason: ReviewStop, detail: string, rounds: number, logDir: string }} ReviewResult
 */

const HEADER_ROW = `| ${FINDINGS_HEADER.join(' | ')} |`;
const SEPARATOR_ROW = `| ${FINDINGS_HEADER.map(() => '---').join(' | ')} |`;

/** @param {string} line */
const isHeader = (line) =>
  splitRow(line).join('|').toLowerCase() === FINDINGS_HEADER.join('|');
/** @param {string} line */
const isSeparator = (line) => /^\|[\s|:-]+$/.test(line);
/** @param {string} line */
const isBlank = (line) => splitRow(line).every((cell) => cell === '');

/**
 * The findings rows an agent printed in its last BEGIN/END block, without
 * the header, separator, and empty rows. Null when there is no block.
 *
 * @param {string} output
 * @returns {string[] | null}
 */
export function extractRows(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const end = lines.lastIndexOf(END);
  const begin = end === -1 ? -1 : lines.slice(0, end).lastIndexOf(BEGIN);
  if (begin === -1) return null;
  return lines
    .slice(begin + 1, end)
    .filter(
      (line) =>
        line.startsWith('|') &&
        !isHeader(line) &&
        !isSeparator(line) &&
        !isBlank(line)
    );
}

/**
 * The rows of the findings table in a findings file.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
export function tableRows(markdown) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex(
    (line) => line.startsWith('|') && isHeader(line)
  );
  if (start === -1) return [];
  /** @type {string[]} */
  const rows = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    if (!isBlank(line)) rows.push(line);
  }
  return rows;
}

/**
 * Replace the rows of the findings table (the text around it is kept).
 *
 * @param {string} markdown
 * @param {string[]} rows
 * @returns {string}
 */
export function replaceRows(markdown, rows) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex(
    (line) => line.trim().startsWith('|') && isHeader(line.trim())
  );
  if (start === -1) {
    return `${markdown.trimEnd()}\n\n${[HEADER_ROW, SEPARATOR_ROW, ...rows].join('\n')}\n`;
  }
  let end = start + 2;
  while (end < lines.length && lines[end].trim().startsWith('|')) end++;
  return [...lines.slice(0, start + 2), ...rows, ...lines.slice(end)].join(
    '\n'
  );
}

/**
 * Problems with the reviewer's rows (empty = fine): every row has all cells,
 * a known severity, a location, a claim, and a scenario, and no verdict
 * (verdicts are the triage's job). Checked before anything is written, so a
 * bad reply never sticks in the findings file.
 *
 * @param {string[]} rows
 * @returns {string[]}
 */
export function reviewerProblems(rows) {
  /** @type {string[]} */
  const problems = [];
  rows.forEach((row, i) => {
    const cells = splitRow(row);
    const at = `row ${i + 1}`;
    if (cells.length !== FINDINGS_HEADER.length) {
      problems.push(
        `${at}: ${cells.length} cells, expected ${FINDINGS_HEADER.length}`
      );
      return;
    }
    const [, location, severity, claim, scenario, verdict, reason] = cells;
    if (!SEVERITIES.includes(severity.toLowerCase())) {
      problems.push(
        `${at}: severity "${severity}" is not one of ${SEVERITIES.join(', ')}`
      );
    }
    if (!location || !claim || !scenario) {
      problems.push(`${at}: file:line, claim, or failure scenario is empty`);
    }
    if (verdict || reason) {
      problems.push(`${at}: verdict and reason must stay empty for the triage`);
    }
  });
  return problems;
}

/**
 * Problems with the triage's rows against the reviewer's (empty = fine):
 * same findings, same order; only verdict and reason may change, and severity
 * only downwards (raising one would create a fix the reviewer never claimed).
 *
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
export function triageProblems(before, after) {
  if (after.length !== before.length) {
    return [
      `the triage printed ${after.length} row(s) for ${before.length} finding(s)`,
    ];
  }
  /** @type {string[]} */
  const problems = [];
  before.forEach((row, i) => {
    const [, location, severity, claim] = splitRow(row);
    const cells = splitRow(after[i]);
    const rank = (/** @type {string | undefined} */ value) =>
      SEVERITIES.indexOf(String(value).toLowerCase());
    if (cells[1] !== location || cells[3] !== claim) {
      problems.push(
        `row ${i + 1}: the triage changed the finding (file:line or claim)`
      );
    } else if (rank(cells[2]) === -1 || rank(cells[2]) < rank(severity)) {
      problems.push(
        `row ${i + 1}: severity ${severity} → ${cells[2]}: the triage may only lower it to one of ${SEVERITIES.join(', ')}`
      );
    } else if (!cells[5] || !cells[6]) {
      problems.push(`row ${i + 1}: no verdict or no reason`);
    }
  });
  return problems;
}

/**
 * The block every reviewer and triage prompt ends with.
 *
 * @param {string[]} rows example or input rows
 * @returns {string[]}
 */
const outputBlock = (rows) => [BEGIN, HEADER_ROW, SEPARATOR_ROW, ...rows, END];

/**
 * @param {{ name: string, round: number, brief: string, findings: string }} input
 *   brief and findings: repo-relative paths
 * @returns {string}
 */
export function reviewerPrompt({ name, round, brief, findings }) {
  return [
    `You are the reviewer for review round ${round} of task ${name}. You run unattended, read-only, in a clean context: someone else wrote this code, and nobody will answer questions.`,
    '',
    'Read .claude/agents/reviewer.md and follow it, with one change: you cannot edit files, so do not add rows to the findings file — print them instead.',
    '',
    `The round's brief (read it first): ${brief}`,
    `The findings file (do not edit it): ${findings}`,
    '',
    'End your reply with your findings in exactly this form: one row per finding, id, verdict, and reason empty. No rows between the markers is a valid review.',
    ...outputBlock([
      '|  | app/src/store.js:42 | high | save() and load() race | two tabs save within 50 ms → the first write is lost |  |  |',
    ]),
  ].join('\n');
}

/**
 * @param {{ name: string, round: number, brief: string, rows: string[] }} input
 * @returns {string}
 */
export function triagePrompt({ name, round, brief, rows }) {
  return [
    `You are the triage for review round ${round} of task ${name}. You run unattended, read-only, in a clean context: you wrote neither the code nor the findings, and nobody will answer questions.`,
    '',
    'Read the "Triage mode" section of .claude/agents/verifier.md and follow it, with one change: you cannot edit files, so print the table instead of editing the findings file.',
    '',
    `The round's brief (read it first): ${brief}`,
    '',
    'The findings to triage:',
    HEADER_ROW,
    SEPARATOR_ROW,
    ...rows,
    '',
    'End your reply with every row above, in the same order, with the verdict (CONFIRMED or REFUTED) and the reason filled in. Leave id, file:line, claim, and failure scenario as they are; change severity only as the role allows:',
    ...outputBlock(['| … one row per finding above … |']),
  ].join('\n');
}

/**
 * The open `fix:` steps of the task, one prompt line each.
 *
 * @param {TaskState} state
 * @returns {string[]}
 */
export function pendingFixes(state) {
  const quality = state.quality ?? freshQuality();
  const ids = new Set(toFix(quality).map((f) => f.step));
  return state.steps
    .filter((s) => ids.has(s.id) && s.status !== 'done')
    .map(
      (s) =>
        `${s.id}. ${s.title} — when it is fixed and verify passes: pnpm task step ${s.id} done -m "<what changed>"`
    );
}

/**
 * Run the build loop, then review rounds with fixes, for one code task in
 * `rootDir` (already a worktree).
 *
 * @param {{ rootDir: string, name: string, command: AgentCommand, reviewer: AgentCommand, max: number, stall: number, timeoutMs: number, iterationTimeoutMs: number, deps: ReviewDeps }} options
 * @returns {ReviewResult}
 */
export function runReviewLoop({
  rootDir,
  name,
  command,
  reviewer,
  max,
  stall,
  timeoutMs,
  iterationTimeoutMs,
  deps,
}) {
  const started = deps.clock();
  const remaining = () => timeoutMs - (deps.clock() - started);
  const taskDir = path.join(tasksRoot(rootDir), name);
  const logDir = path.join(
    taskDir,
    'loop',
    `run-${formatLocal(deps.date(), { withTime: true }).replace(/[^0-9]/g, '')}-review`
  );
  const load = () => /** @type {TaskState} */ (loadTask(rootDir, name).state);
  /** @param {{ label?: string, pending?: (state: TaskState) => string[] }} phase */
  const loop = (phase) =>
    runLoop({
      rootDir,
      name,
      command,
      max,
      stall,
      timeoutMs: Math.max(1, remaining()),
      iterationTimeoutMs,
      deps,
      ...phase,
    });
  /**
   * @param {AgentCommand} agent
   * @param {string} prompt
   * @param {string} file log file name
   */
  const ask = (agent, prompt, file) => {
    const result = deps.runAgent({
      command: agent,
      cwd: rootDir,
      prompt,
      timeoutMs: Math.max(1, Math.min(remaining(), iterationTimeoutMs)),
      env: { ...deps.env, [INNER_LOOP_ENV]: 'off', TASK_AGENT: agent.agent },
    });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, file),
      `# ${file.replace(/\.md$/, '')} — ${agent.agent}\n\n- Exit: ${result.signal ? `stopped by ${result.signal}` : result.code}\n\n## Prompt\n\n${prompt}\n\n## Output\n\n${result.output}\n`,
      'utf-8'
    );
    return result;
  };
  let rounds = 0;
  /**
   * @param {ReviewStop} reason
   * @param {string} detail
   * @param {string} [extra] more note text
   * @returns {ReviewResult}
   */
  const finish = (reason, detail, extra) => {
    const ok = reason === 'complete';
    const state = load();
    appendNotes(
      taskDir,
      formatNoteEntry({
        at: deps.date(),
        agent: command.agent,
        label: 'auto: review loop',
        message: `pnpm loop --review --agent ${command.agent} (reviewer ${reviewer.agent}): ${ok ? 'complete' : `stopped (${reason})`} — ${detail} ${rounds} round(s) this run.${extra ? ` ${extra}` : ''}${fs.existsSync(logDir) ? ` Logs: ${path.relative(rootDir, logDir)}/` : ''}`,
        state: `${formatGit(deps.git(rootDir))}; verify ${state.lastVerify?.ok ? 'pass' : 'fail'}`,
      }),
      appendSeparator
    );
    return { ok, reason, detail, rounds, logDir };
  };

  const build = loop({});
  if (!build.ok) {
    return finish(
      'verify',
      `the build loop stopped (${build.reason}): \`${build.lastVerify.failed}\` fails.`
    );
  }

  for (;;) {
    if (remaining() <= 0) return finish('timeout', 'wall-clock cap reached.');
    const state = load();
    const quality = state.quality ?? freshQuality();
    const fixes = pendingFixes(state);
    if (fixes.length > 0) {
      deps.log(`▶ fixing ${fixes.length} confirmed finding(s)`);
      const fixed = loop({
        label: `fix-r${quality.reviewRounds}`,
        pending: pendingFixes,
      });
      if (!fixed.ok) {
        return finish(
          'fix',
          `the fix loop stopped (${fixed.reason}): ${fixed.lastVerify.ok ? `${pendingFixes(load()).length} fix step(s) still open` : `\`${fixed.lastVerify.failed}\` fails`}.`
        );
      }
      continue;
    }
    if (state.steps.some((s) => s.status === 'blocked')) {
      return finish('blocked', 'a step is blocked; the user decides.');
    }
    const open = state.steps.filter((s) => s.status !== 'done');
    if (open.length > 0) {
      return finish(
        'steps-open',
        `verify passes, but ${open.map((s) => s.id).join(', ')} not done; the review runs once every step is done.`
      );
    }
    if (quality.phase !== 'review') {
      const print =
        quality.reviewRounds >= quality.maxRounds
          ? quality.reviewedDiff
          : deps.scopeFingerprint(rootDir, taskDir, state);
      if (print === null) {
        return finish(
          'no-scope',
          'no review scope (no task code and no git merge base).'
        );
      }
      if (
        quality.reviewRounds >= quality.maxRounds ||
        print === quality.reviewedDiff
      ) {
        const decision = decideQuality({
          state: { ...state, quality: { ...quality, nudged: null } },
          fingerprint: print,
        });
        updateState(
          rootDir,
          name,
          (current) => ({ ...current, quality: decision.quality }),
          { now: deps.date(), agent: command.agent }
        );
        return finish(
          'complete',
          quality.reviewRounds >= quality.maxRounds
            ? `review round limit reached (${quality.reviewRounds}/${quality.maxRounds}).`
            : 'nothing changed since the last review.',
          decision.note
        );
      }
    }

    const opened = JSON.parse(
      deps.runTask(['review', '--task', name, '--json'])
    );
    const round = /** @type {number} */ (opened.round);
    const findingsPath = path.join(rootDir, opened.findings);
    deps.log(
      `▶ review round ${round}${opened.reopened ? ' (reopened)' : ''}: ${reviewer.agent}`
    );
    let rows = tableRows(fs.readFileSync(findingsPath, 'utf-8'));
    if (rows.length === 0) {
      const result = ask(
        reviewer,
        reviewerPrompt({
          name,
          round,
          brief: opened.brief,
          findings: opened.findings,
        }),
        `r${round}-reviewer.md`
      );
      const printed = result.code === 0 ? extractRows(result.stdout) : null;
      if (printed === null) {
        return finish(
          'reviewer',
          `the reviewer ${result.code === 0 ? `printed no ${BEGIN} … ${END} block` : `exited ${result.signal ?? result.code}`}; round ${round} stays open.`
        );
      }
      const problems = reviewerProblems(printed);
      if (problems.length > 0) {
        return finish(
          'reviewer',
          `the reviewer printed malformed rows (${problems.join('; ')}); nothing was written, round ${round} stays open.`
        );
      }
      rows = printed;
      fs.writeFileSync(
        findingsPath,
        replaceRows(fs.readFileSync(findingsPath, 'utf-8'), rows),
        'utf-8'
      );
    }
    if (rows.some((row) => !splitRow(row)[5])) {
      deps.log(`▶ triage of ${rows.length} finding(s): ${reviewer.agent}`);
      const result = ask(
        reviewer,
        triagePrompt({ name, round, brief: opened.brief, rows }),
        `r${round}-triage.md`
      );
      const printed = result.code === 0 ? extractRows(result.stdout) : null;
      const problems =
        printed === null
          ? [
              result.code === 0
                ? `printed no ${BEGIN} … ${END} block`
                : `exited ${result.signal ?? result.code}`,
            ]
          : triageProblems(rows, printed);
      if (problems.length > 0) {
        return finish(
          'triage',
          `the triage failed: ${problems.join('; ')}; round ${round} stays open.`
        );
      }
      fs.writeFileSync(
        findingsPath,
        replaceRows(
          fs.readFileSync(findingsPath, 'utf-8'),
          /** @type {string[]} */ (printed)
        ),
        'utf-8'
      );
    }
    try {
      const recorded = JSON.parse(
        deps.runTask(['review', 'record', '--task', name, '--json'])
      );
      rounds += 1;
      deps.log(
        `  round ${round}: ${recorded.findings.length} finding(s), ${recorded.fixSteps.length} fix step(s)`
      );
    } catch (error) {
      return finish(
        'record',
        `pnpm task review record failed: ${/** @type {Error} */ (error).message}`
      );
    }
  }
}
