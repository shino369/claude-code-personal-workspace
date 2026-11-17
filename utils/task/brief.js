/**
 * The resume brief: a short, fixed-shape summary that lets any agent pick a
 * task up cold (goal, next step, last notes, last verify, git state). Used by
 * `pnpm task status` and the Claude SessionStart hook. Pure functions.
 */
import { formatGit } from './git.js';
import { formatLocal, parseNotes, parsePlan } from './markdown.js';
import { nextStep, progress } from './state.js';

export const NOTE_BODY_LINES = 15;
export const LINE_WIDTH = 220;

/**
 * @typedef {import('./store.js').Task} Task
 * @typedef {import('./git.js').GitInfo} GitInfo
 * @typedef {{
 *   name: string,
 *   status: string,
 *   tracked: boolean,
 *   goal: string,
 *   progress: { done: number, total: number },
 *   nextStep: { id: string | null, title: string, status: string, owner: string | null } | null,
 *   next: string | null,
 *   lastVerify: import('./state.js').VerifyResult | null,
 *   verify: string[],
 *   branch: string | null,
 *   git: GitInfo,
 *   notes: Array<{ heading: string, body: string }>,
 * }} TaskSummary
 */

/** @param {string} line */
const clip = (line) =>
  line.length > LINE_WIDTH ? `${line.slice(0, LINE_WIDTH - 1)}…` : line;

/**
 * Collect everything the brief needs from a task (state.json or, for
 * hand-written tasks, plan.md checkboxes) and the last NOTES entries.
 *
 * @param {Task} task
 * @param {GitInfo} git
 * @returns {TaskSummary}
 */
export function summarizeTask(task, git) {
  const notes = parseNotes(task.notes ?? '');
  // Search backward: mechanical entries (step done, pre-compact) have no
  // Next: line and must not hide the last session note's Next.
  const lastNext =
    notes
      .map((note) => note.body.match(/^Next:\s*(.+)$/m)?.[1].trim())
      .findLast(Boolean) ?? null;

  if (task.state) {
    const { state } = task;
    const step = nextStep(state);
    return {
      name: task.name,
      status: state.status,
      tracked: true,
      goal: state.goal,
      progress: progress(state),
      nextStep: step
        ? {
            id: step.id,
            title: step.title,
            status: step.status,
            owner: step.owner,
          }
        : null,
      next: state.next ?? lastNext,
      lastVerify: state.lastVerify,
      verify: state.verify,
      branch: state.branch,
      git,
      notes,
    };
  }

  const plan = parsePlan(task.plan ?? '');
  // Prefer the first open step not marked "(deferred)"; fall back to any open step.
  const todo = plan.steps.filter((s) => !s.done);
  const open = todo.find((s) => !/^\(deferred\)/i.test(s.title)) ?? todo[0];
  return {
    name: task.name,
    status: 'active',
    tracked: false,
    goal: plan.goal || '(no Goal: line in plan.md)',
    progress: {
      done: plan.steps.filter((s) => s.done).length,
      total: plan.steps.length,
    },
    nextStep: open
      ? { id: null, title: open.title, status: 'todo', owner: null }
      : null,
    next: lastNext,
    lastVerify: null,
    verify: [],
    branch: null,
    git,
    notes,
  };
}

/**
 * @param {TaskSummary['lastVerify']} verify
 * @param {string[]} commands
 * @returns {string}
 */
function formatVerify(verify, commands) {
  if (!verify) {
    return commands.length > 0
      ? `not run (pnpm task verify runs: ${commands.join(' && ')})`
      : 'none configured (the gate is pnpm check)';
  }
  const at = formatLocal(new Date(verify.at), { withTime: true });
  return verify.ok
    ? `pass at ${at}`
    : `FAIL at ${at} — \`${verify.failed}\` (details: pnpm task status --json)`;
}

/**
 * Render the resume brief (≤ ~40 lines).
 *
 * @param {TaskSummary} summary
 * @returns {string}
 */
export function formatBrief(summary) {
  const { name, git } = summary;
  /** @type {string[]} */
  const lines = [
    `[Task] ${name} — ${summary.status} (tasks/${name}/)`,
    `Goal: ${summary.goal}`,
    `Progress: ${summary.progress.done}/${summary.progress.total} steps done`,
  ];

  const step = summary.nextStep;
  if (summary.status === 'done') {
    lines.push('Next step: none — the task is done');
  } else if (step) {
    const id = step.id ? `${step.id}. ` : '';
    const state =
      step.status === 'in_progress'
        ? ` (in progress${step.owner ? `, ${step.owner}` : ''})`
        : '';
    lines.push(`Next step: ${id}${step.title}${state}`);
  } else {
    lines.push(
      summary.progress.total > 0 &&
        summary.progress.done < summary.progress.total
        ? 'Next step: none ready — remaining steps are blocked (pnpm task status --json)'
        : 'Next step: none listed — add one: pnpm task step add "…"'
    );
  }
  if (summary.next) lines.push(`Next (last note): ${summary.next}`);

  lines.push(
    `Last verify: ${formatVerify(summary.lastVerify, summary.verify)}`
  );
  const mismatch =
    summary.branch && git.branch && summary.branch !== git.branch
      ? ` — ! task branch is ${summary.branch}; switch or confirm with the user`
      : '';
  lines.push(`Git: ${formatGit(git)}${mismatch}`);

  const last = summary.notes.at(-1);
  if (last) {
    const body = last.body.split('\n');
    lines.push(`Last note — ${last.heading}:`);
    lines.push(...body.slice(0, NOTE_BODY_LINES).map((l) => `  ${l}`));
    if (body.length > NOTE_BODY_LINES) {
      lines.push(
        `  … ${body.length - NOTE_BODY_LINES} more line(s) in tasks/${name}/NOTES.md`
      );
    }
    const earlier = summary.notes.slice(-3, -1).map((n) => n.heading);
    if (earlier.length > 0) {
      lines.push(`Earlier notes: ${earlier.reverse().join(' · ')}`);
    }
  } else {
    lines.push('Last note: none yet');
  }

  lines.push(
    summary.tracked
      ? 'Commands: pnpm task step <id> start|done · pnpm task note --done "…" --next "…" · pnpm task verify'
      : `Commands: pnpm task init ${name} (track steps in state.json) · pnpm task note --done "…" --next "…"`
  );
  return lines.map(clip).join('\n');
}

/**
 * Brief when no task is active: the most recently updated tasks to pick from.
 *
 * @param {Array<{ name: string, status: string, updated: string }>} tasks newest first
 * @param {number} [limit]
 * @returns {string}
 */
export function formatNoActiveBrief(tasks, limit = 5) {
  const open = tasks.filter((t) => t.status !== 'done');
  if (open.length === 0) {
    return '[Task] No active task. Multi-step work: pnpm task new <name> --goal "…"';
  }
  return [
    '[Task] No active task. Open tasks (newest first):',
    ...open
      .slice(0, limit)
      .map((t) => `  - ${t.name} (${t.status}, updated ${t.updated})`),
    'Resume one: pnpm task switch <name>, then pnpm task status. New work: pnpm task new <name> --goal "…"',
  ].join('\n');
}
