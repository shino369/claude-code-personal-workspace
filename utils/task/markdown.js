/**
 * Markdown helpers for task files: template rendering, the generated steps
 * block in plan.md, reading legacy plan.md files (no state.json), and the
 * append-only NOTES.md log. Pure string functions — no I/O.
 */

export const STEPS_START = '<!-- task:steps';
export const STEPS_END = '<!-- /task:steps -->';

/**
 * @typedef {import('./state.js').Step} Step
 * @typedef {{ heading: string, body: string }} NoteEntry
 */

/**
 * Replace `{{key}}` placeholders. Unknown keys are left in place so a missing
 * value is visible instead of silently empty.
 *
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
export function renderTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    Object.hasOwn(values, key) ? values[key] : match
  );
}

/**
 * Local date as yyyy-mm-dd, and with `withTime` as yyyy-mm-dd hh:mm.
 *
 * @param {Date} date
 * @param {{ withTime?: boolean }} [options]
 * @returns {string}
 */
export function formatLocal(date, { withTime = false } = {}) {
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime
    ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    : day;
}

/**
 * Render steps as a Markdown checklist.
 *
 * @param {Step[]} steps
 * @returns {string}
 */
export function renderSteps(steps) {
  if (steps.length === 0) {
    return '- (no steps yet — add one: `pnpm task step add "…"`)';
  }
  return steps
    .map((step) => {
      const box = step.status === 'done' ? '[x]' : '[ ]';
      const deps =
        step.deps.length > 0 ? ` (after ${step.deps.join(', ')})` : '';
      let tag = '';
      if (step.status === 'in_progress') {
        tag = ` — _in progress${step.owner ? ` (${step.owner})` : ''}_`;
      } else if (step.status === 'blocked') {
        tag = ` — _blocked${step.note ? `: ${step.note}` : ''}_`;
      }
      return `- ${box} ${step.id}. ${step.title}${deps}${tag}`;
    })
    .join('\n');
}

/**
 * Replace the generated steps block in plan.md. Returns null when the plan
 * has no markers (hand-written plans are never rewritten).
 *
 * @param {string} plan
 * @param {Step[]} steps
 * @returns {string | null}
 */
export function replaceStepsBlock(plan, steps) {
  const start = plan.indexOf(STEPS_START);
  const end = plan.indexOf(STEPS_END);
  if (start === -1 || end === -1 || end < start) return null;
  const startLineEnd = plan.indexOf('\n', start);
  return `${plan.slice(0, startLineEnd + 1)}\n${renderSteps(steps)}\n\n${plan.slice(end)}`;
}

/**
 * Read the goal and checklist from a plan.md that was written by hand.
 *
 * @param {string} plan
 * @returns {{ goal: string, steps: Array<{ title: string, done: boolean }> }}
 */
export function parsePlan(plan) {
  const goalLine = plan.match(/^Goal:\s*(.+)$/m);
  const heading = plan.match(/^#\s+(?:Plan\s+—\s+)?(.+)$/m);
  const goal = (goalLine?.[1] ?? heading?.[1] ?? '').trim();

  const steps = [...plan.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)].map(
    (match) => ({
      title: match[2].trim(),
      done: match[1].toLowerCase() === 'x',
    })
  );
  return { goal, steps };
}

/**
 * Split NOTES.md into entries (each starts with a `## ` heading). The `# `
 * title and preamble are skipped.
 *
 * @param {string} notes
 * @returns {NoteEntry[]}
 */
export function parseNotes(notes) {
  /** @type {NoteEntry[]} */
  const entries = [];
  /** @type {NoteEntry | null} */
  let current = null;
  let inFence = false;

  for (const line of notes.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
      current = { heading: line.slice(3).trim(), body: '' };
      entries.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }

  return entries.map((entry) => ({ ...entry, body: entry.body.trim() }));
}

/**
 * Build one NOTES.md entry in the AGENTS.md §4.2 format.
 *
 * @param {{ at: Date, agent: string, label?: string, done?: string, state?: string, next?: string, open?: string, message?: string }} entry
 * @returns {string}
 */
export function formatNoteEntry({
  at,
  agent,
  label,
  done,
  state,
  next,
  open,
  message,
}) {
  const heading = `## ${formatLocal(at, { withTime: true })} — ${agent}${label ? ` (${label})` : ''}`;
  /** @type {string[]} */
  const lines = [];
  if (message) lines.push(message);
  if (done) lines.push(`Done: ${done}`);
  if (state) lines.push(`State: ${state}`);
  if (next) lines.push(`Next: ${next}`);
  if (open) lines.push(`Open: ${open}`);
  return `${heading}\n\n${lines.join('\n')}\n`;
}

/**
 * Text to append so the entry is separated from existing content by exactly
 * one blank line.
 *
 * @param {string} existing
 * @param {string} entry
 * @returns {string}
 */
export function appendSeparator(existing, entry) {
  if (existing === '') return entry;
  if (existing.endsWith('\n\n')) return entry;
  return existing.endsWith('\n') ? `\n${entry}` : `\n\n${entry}`;
}
