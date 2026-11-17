/**
 * Task state model (`tasks/<task>/state.json`): schema, validation, and pure
 * transitions. No I/O here — `store.js` reads and writes the file.
 *
 * state.json is edited only through `pnpm task …`, so every field is
 * validated on read and before every write.
 */

import { freshQuality, validateQuality } from './quality.js';

export const STATE_VERSION = 1;

export const TASK_STATUSES = ['active', 'blocked', 'done'];
export const STEP_STATUSES = ['todo', 'in_progress', 'blocked', 'done'];
/** `code` tasks run the inner loop by default and get `pnpm task check`. */
export const TASK_KINDS = ['code', 'general'];
export const E2E_MODES = ['required', 'no'];

/** Kebab-case task name, optionally already suffixed with -yymmdd. */
export const TASK_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DATE_SUFFIX_RE = /-\d{6}$/;

/**
 * @typedef {'todo' | 'in_progress' | 'blocked' | 'done'} StepStatus
 * @typedef {{ id: string, title: string, status: StepStatus, deps: string[], owner: string | null, claimedAt?: string, note?: string }} Step
 * @typedef {{ at: string, ok: boolean, failed: string | null, summary: string }} VerifyResult
 * @typedef {{
 *   version: number,
 *   name: string,
 *   goal: string,
 *   status: 'active' | 'blocked' | 'done',
 *   branch: string | null,
 *   next: string | null,
 *   steps: Step[],
 *   verify: string[],
 *   verifyFast: string[],
 *   lastVerify: VerifyResult | null,
 *   loop: { enabled: boolean, iteration: number, max: number, signature?: string | null, repeats?: number, halted?: boolean },
 *   createdAt: string,
 *   updatedAt: string,
 *   lastAgent: string | null,
 *   kind?: 'code' | 'general',
 *   e2e?: 'required' | 'no',
 *   quality?: import('./quality.js').Quality,
 * }} TaskState
 */

/** @param {unknown} value */
const isString = (value) => typeof value === 'string';
/** @param {unknown} value */
const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => isString(item));
/** @param {unknown} value */
const isNullableString = (value) => value === null || isString(value);
/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Format a date as yymmdd (local time), the task directory suffix.
 *
 * @param {Date} date
 * @returns {string}
 */
export function formatYymmdd(date) {
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Turn a user-supplied name into a task directory name (`<name>-<yymmdd>`).
 *
 * @param {string} name
 * @param {Date} [date]
 * @returns {string}
 */
export function taskDirName(name, date = new Date()) {
  if (!TASK_NAME_RE.test(name)) {
    throw new Error(
      `Invalid task name "${name}": use lowercase kebab-case, e.g. translate-x-post`
    );
  }
  return DATE_SUFFIX_RE.test(name) ? name : `${name}-${formatYymmdd(date)}`;
}

/**
 * Validate a parsed state.json. Returns a list of problems (empty = valid).
 *
 * @param {unknown} state
 * @returns {string[]}
 */
export function validateState(state) {
  if (!isObject(state)) return ['state must be a JSON object'];
  const s = /** @type {Record<string, unknown>} */ (state);
  /** @type {string[]} */
  const errors = [];

  if (s.version !== STATE_VERSION) {
    errors.push(`version must be ${STATE_VERSION}`);
  }
  for (const key of ['name', 'goal', 'createdAt', 'updatedAt']) {
    if (!isString(s[key])) errors.push(`${key} must be a string`);
  }
  if (!TASK_STATUSES.includes(/** @type {string} */ (s.status))) {
    errors.push(`status must be one of ${TASK_STATUSES.join(', ')}`);
  }
  for (const key of ['branch', 'next', 'lastAgent']) {
    if (!isNullableString(s[key])) {
      errors.push(`${key} must be a string or null`);
    }
  }
  for (const key of ['verify', 'verifyFast']) {
    if (!isStringArray(s[key])) errors.push(`${key} must be a string array`);
  }
  if (
    s.kind !== undefined &&
    !TASK_KINDS.includes(/** @type {string} */ (s.kind))
  ) {
    errors.push(`kind must be one of ${TASK_KINDS.join(', ')}`);
  }
  if (
    s.e2e !== undefined &&
    !E2E_MODES.includes(/** @type {string} */ (s.e2e))
  ) {
    errors.push(`e2e must be one of ${E2E_MODES.join(', ')}`);
  }

  if (s.lastVerify !== null) {
    const v = /** @type {Record<string, unknown>} */ (s.lastVerify);
    if (
      !isObject(v) ||
      !isString(v.at) ||
      typeof v.ok !== 'boolean' ||
      !isNullableString(v.failed) ||
      !isString(v.summary)
    ) {
      errors.push('lastVerify must be null or { at, ok, failed, summary }');
    }
  }

  const loop = /** @type {Record<string, unknown>} */ (s.loop);
  if (
    !isObject(loop) ||
    typeof loop.enabled !== 'boolean' ||
    !Number.isInteger(loop.iteration) ||
    !Number.isInteger(loop.max)
  ) {
    errors.push('loop must be { enabled: boolean, iteration: int, max: int }');
  } else if (
    (loop.signature !== undefined && !isNullableString(loop.signature)) ||
    (loop.repeats !== undefined && !Number.isInteger(loop.repeats)) ||
    (loop.halted !== undefined && typeof loop.halted !== 'boolean')
  ) {
    errors.push(
      'loop.signature must be a string or null, loop.repeats an int, loop.halted a boolean'
    );
  }

  if (!Array.isArray(s.steps)) {
    errors.push('steps must be an array');
    return errors;
  }

  const ids = new Set();
  s.steps.forEach((step, index) => {
    const label = `steps[${index}]`;
    if (!isObject(step)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const st = /** @type {Record<string, unknown>} */ (step);
    if (!isString(st.id) || !st.id) errors.push(`${label}.id must be a string`);
    else if (ids.has(st.id))
      errors.push(`${label}.id "${st.id}" is duplicated`);
    else ids.add(st.id);
    if (!isString(st.title)) errors.push(`${label}.title must be a string`);
    if (!STEP_STATUSES.includes(/** @type {string} */ (st.status))) {
      errors.push(`${label}.status must be one of ${STEP_STATUSES.join(', ')}`);
    }
    if (!isStringArray(st.deps))
      errors.push(`${label}.deps must be a string array`);
    if (!isNullableString(st.owner)) {
      errors.push(`${label}.owner must be a string or null`);
    }
    if (st.note !== undefined && !isString(st.note)) {
      errors.push(`${label}.note must be a string`);
    }
    if (st.claimedAt !== undefined && !isString(st.claimedAt)) {
      errors.push(`${label}.claimedAt must be a string`);
    }
  });

  for (const step of /** @type {Step[]} */ (s.steps)) {
    for (const dep of Array.isArray(step?.deps) ? step.deps : []) {
      if (!ids.has(dep)) {
        errors.push(`step ${step.id} depends on unknown step "${dep}"`);
      }
    }
  }

  if (s.quality !== undefined) {
    errors.push(
      ...validateQuality(s.quality, /** @type {Set<string>} */ (ids))
    );
  }

  return errors;
}

/**
 * Throw when the state is invalid.
 *
 * @param {unknown} state
 * @param {string} [source]
 * @returns {TaskState}
 */
export function assertValidState(state, source = 'state.json') {
  const errors = validateState(state);
  if (errors.length > 0) {
    throw new Error(`Invalid ${source}:\n  - ${errors.join('\n  - ')}`);
  }
  return /** @type {TaskState} */ (state);
}

/**
 * Build a step list from titles (ids s1, s2, …).
 *
 * @param {Array<string | { title: string, done?: boolean }>} items
 * @returns {Step[]}
 */
export function makeSteps(items) {
  return items.map((item, index) => {
    const { title, done = false } =
      typeof item === 'string' ? { title: item } : item;
    return {
      id: `s${index + 1}`,
      title,
      status: done ? 'done' : 'todo',
      deps: [],
      owner: null,
    };
  });
}

/**
 * Create a fresh state object. `code` tasks start with the inner loop on.
 *
 * @param {{ name: string, goal: string, steps?: Step[], verify?: string[], verifyFast?: string[], branch?: string | null, agent?: string | null, now?: Date, kind?: 'code' | 'general', e2e?: 'required' | 'no' }} options
 * @returns {TaskState}
 */
export function createState({
  name,
  goal,
  steps = [],
  verify = [],
  verifyFast = [],
  branch = null,
  agent = null,
  now = new Date(),
  kind = 'general',
  e2e = 'no',
}) {
  const at = now.toISOString();
  return {
    version: STATE_VERSION,
    name,
    goal,
    status: 'active',
    branch,
    next: null,
    steps,
    verify,
    verifyFast,
    lastVerify: null,
    loop: { enabled: kind === 'code', iteration: 0, max: 5 },
    kind,
    e2e,
    ...(kind === 'code' ? { quality: freshQuality() } : {}),
    createdAt: at,
    updatedAt: at,
    lastAgent: agent,
  };
}

/**
 * @param {TaskState} state
 * @returns {Set<string>} ids of done steps
 */
const doneIds = (state) =>
  new Set(state.steps.filter((s) => s.status === 'done').map((s) => s.id));

/**
 * Todo steps whose dependencies are all done, in plan order.
 *
 * @param {TaskState} state
 * @returns {Step[]}
 */
export function readySteps(state) {
  const done = doneIds(state);
  return state.steps.filter(
    (s) => s.status === 'todo' && s.deps.every((dep) => done.has(dep))
  );
}

/**
 * The step to work on next: an in-progress step first, then the first todo
 * step whose dependencies are all done. Null when nothing is ready.
 *
 * @param {TaskState} state
 * @returns {Step | null}
 */
export function nextStep(state) {
  return (
    state.steps.find((s) => s.status === 'in_progress') ??
    readySteps(state)[0] ??
    null
  );
}

/**
 * Why no step can be claimed right now, for `pnpm task claim`.
 *
 * @param {TaskState} state
 * @returns {string}
 */
export function idleReason(state) {
  const list = (
    /** @type {Step[]} */ steps,
    /** @type {(s: Step) => string} */ show
  ) => steps.map(show).join(', ');
  const running = state.steps.filter((s) => s.status === 'in_progress');
  const blocked = state.steps.filter((s) => s.status === 'blocked');
  const todo = state.steps.filter((s) => s.status === 'todo');
  const ready = readySteps(state);
  const waiting = todo.filter((s) => !ready.includes(s));
  const done = doneIds(state);
  if (running.length + blocked.length + todo.length === 0) {
    return state.steps.length === 0
      ? 'the task has no steps (add one: pnpm task step add "…")'
      : 'every step is done (when verify passes: pnpm task done)';
  }
  return [
    running.length > 0 &&
      `in progress: ${list(running, (s) => `${s.id}${s.owner ? ` (${s.owner})` : ''}`)}`,
    blocked.length > 0 && `blocked: ${list(blocked, (s) => s.id)}`,
    ready.length > 0 && `ready: ${list(ready, (s) => s.id)}`,
    waiting.length > 0 &&
      `waiting on dependencies: ${list(waiting, (s) => `${s.id} (needs ${s.deps.filter((dep) => !done.has(dep)).join(', ')})`)}`,
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * Claim a step for `agent`: the given id, or the first ready step. Claiming
 * is the only way two agents can share a task without doing the same step,
 * so call it inside the task lock (`updateState`).
 *
 * Claiming a step you already own is a no-op; a step owned by someone else
 * is refused. `step` is null when nothing is ready (see `idleReason`).
 *
 * @param {TaskState} state
 * @param {{ agent: string, id?: string, now: Date }} options
 * @returns {{ state: TaskState, step: Step | null }}
 */
export function claimStep(state, { agent, id, now }) {
  /** @type {Step | undefined} */
  let target;
  if (id === undefined) {
    target = readySteps(state)[0];
    if (!target) return { state, step: null };
  } else {
    target = state.steps.find((s) => s.id === id);
    if (!target) {
      const known = state.steps.map((s) => s.id).join(', ') || 'none';
      throw new Error(`Unknown step "${id}" (steps: ${known})`);
    }
    if (target.status === 'in_progress') {
      if (target.owner === agent) return { state, step: target };
      throw new Error(
        `Step ${id} is already claimed by ${target.owner ?? 'someone'}${target.claimedAt ? ` (since ${target.claimedAt})` : ''}.\nFix: pnpm task claim (takes the next free step); if that agent is gone: pnpm task step ${id} todo`
      );
    }
    if (target.status !== 'todo') {
      throw new Error(
        `Step ${id} is ${target.status}; only todo steps can be claimed.\nFix: pnpm task step ${id} todo, then claim it`
      );
    }
    const done = doneIds(state);
    const pending = target.deps.filter((dep) => !done.has(dep));
    if (pending.length > 0) {
      throw new Error(
        `Step ${id} is waiting on ${pending.join(', ')}; finish those first`
      );
    }
  }
  /** @type {Step} */
  const step = {
    ...target,
    status: 'in_progress',
    owner: agent,
    claimedAt: now.toISOString(),
  };
  return {
    state: {
      ...state,
      steps: state.steps.map((s) => (s.id === step.id ? step : s)),
    },
    step,
  };
}

/**
 * @param {TaskState} state
 * @returns {{ done: number, total: number }}
 */
export function progress(state) {
  return {
    done: state.steps.filter((s) => s.status === 'done').length,
    total: state.steps.length,
  };
}

/**
 * Append a new step. Returns the new state and the added step.
 *
 * @param {TaskState} state
 * @param {{ title: string, deps?: string[] }} options
 * @returns {{ state: TaskState, step: Step }}
 */
export function addStep(state, { title, deps = [] }) {
  if (!title.trim()) throw new Error('Step title must not be empty');
  const ids = new Set(state.steps.map((s) => s.id));
  for (const dep of deps) {
    if (!ids.has(dep)) throw new Error(`Unknown dependency "${dep}"`);
  }
  let n = state.steps.length + 1;
  while (ids.has(`s${n}`)) n++;
  /** @type {Step} */
  const step = {
    id: `s${n}`,
    title: title.trim(),
    status: 'todo',
    deps,
    owner: null,
  };
  return { state: { ...state, steps: [...state.steps, step] }, step };
}

/**
 * Change a step's status. `start` also sets the owner and refuses a step
 * another agent is working on (unless `force`); `todo` releases the claim;
 * `blocked` requires a reason so the next agent knows why.
 *
 * @param {TaskState} state
 * @param {{ id: string, status: StepStatus, agent?: string | null, note?: string, force?: boolean, now?: Date }} options
 * @returns {{ state: TaskState, step: Step }}
 */
export function setStepStatus(
  state,
  { id, status, agent = null, note, force = false, now = new Date() }
) {
  if (!STEP_STATUSES.includes(status)) {
    throw new Error(
      `Unknown step status "${status}" (use ${STEP_STATUSES.join(', ')})`
    );
  }
  const current = state.steps.find((s) => s.id === id);
  if (!current) {
    const known = state.steps.map((s) => s.id).join(', ') || 'none';
    throw new Error(`Unknown step "${id}" (steps: ${known})`);
  }
  if (status === 'blocked' && !note) {
    throw new Error('A blocked step needs a reason: -m "why it is blocked"');
  }
  if (status === 'in_progress') {
    if (
      !force &&
      current.status === 'in_progress' &&
      current.owner &&
      current.owner !== agent
    ) {
      throw new Error(
        `Step ${id} is already claimed by ${current.owner}.\nFix: pnpm task claim (takes the next free step), or --force to take it over`
      );
    }
    const done = doneIds(state);
    const pending = current.deps.filter((dep) => !done.has(dep));
    if (pending.length > 0) {
      throw new Error(
        `Step ${id} is waiting on ${pending.join(', ')}; finish those first`
      );
    }
  }

  /** @type {Step} */
  const step = {
    ...current,
    status,
    owner:
      status === 'in_progress'
        ? agent
        : status === 'todo'
          ? null
          : current.owner,
  };
  if (
    status === 'in_progress' &&
    (current.status !== 'in_progress' || current.owner !== agent)
  ) {
    step.claimedAt = now.toISOString();
  } else if (status === 'todo') {
    delete step.claimedAt;
  }
  if (note) step.note = note;
  else delete step.note;

  return {
    state: {
      ...state,
      steps: state.steps.map((s) => (s.id === id ? step : s)),
    },
    step,
  };
}
