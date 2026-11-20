/**
 * The hook manifest: every hook this workspace runs, once, with where it
 * goes in each harness. One script per behavior; each harness starts it with
 * `--harness <name>` and reads its payload through utils/harness/input.js.
 *
 * - Claude Code: `.claude/settings.json` stays hand-written (Claude is the
 *   first-class harness); `pnpm harness check` compares its hooks with this
 *   manifest and never rewrites it.
 * - Codex: `pnpm harness sync` writes `.codex/hooks.json` from it.
 * - DSH: its Claude hooks bridge reads a Claude-format file that
 *   `pnpm harness sync` writes from it.
 *
 * Within an event, the order of entries does not matter (Claude Code runs
 * matching hooks in parallel), so comparisons ignore it. Pure; no I/O.
 */
/** SessionStart sources every harness sends on a (re)started session. */
export const SESSION_SOURCES = 'startup|resume|clear|compact';

/**
 * @typedef {import('./input.js').Harness} Harness
 * @typedef {{ event: string, matcher?: string, timeout?: number }} Placement
 * @typedef {{ id: string, script: string, args?: string[], timeout: number } & Partial<Record<Harness, Placement[]>>} HookSpec
 *   script: path from the workspace root; timeout: seconds (a placement may
 *   override it)
 * @typedef {{ event: string, matcher: string | null, command: string, timeout: number | null }} HookEntry
 * @typedef {{ type: 'command', command: string, timeout?: number }} CommandHook
 * @typedef {{ matcher?: string, hooks: CommandHook[] }} HookGroup
 * @typedef {{ description?: string, hooks: Record<string, HookGroup[]> }} HooksConfig
 */

/** @type {HookSpec[]} */
export const HOOKS = [
  {
    id: 'task-brief',
    script: '.claude/hooks/session_start.js',
    timeout: 10,
    claude: [{ event: 'SessionStart', matcher: SESSION_SOURCES }],
  },
  {
    id: 'memory',
    script: 'utils/memory/hook.js',
    timeout: 5,
    claude: [
      { event: 'SessionStart', matcher: SESSION_SOURCES },
      { event: 'SessionEnd' },
      { event: 'UserPromptSubmit' },
      { event: 'PreToolUse', matcher: 'Bash' },
      { event: 'PostToolUseFailure', matcher: 'Bash' },
    ],
    // Codex reports a failed command as PostToolUse with its exit code.
    codex: [
      { event: 'SessionStart', matcher: SESSION_SOURCES },
      { event: 'UserPromptSubmit' },
      { event: 'PreToolUse', matcher: 'Bash' },
      { event: 'PostToolUse', matcher: 'Bash' },
    ],
  },
  {
    id: 'compact-note',
    script: '.claude/hooks/pre_compact.js',
    timeout: 10,
    claude: [{ event: 'PreCompact' }],
  },
  {
    id: 'task-loop',
    script: '.claude/hooks/task_loop.js',
    timeout: 300,
    claude: [{ event: 'Stop' }],
  },
  {
    id: 'task-loop-reset',
    script: '.claude/hooks/task_loop.js',
    args: ['--reset'],
    timeout: 5,
    claude: [{ event: 'UserPromptSubmit' }],
  },
  {
    id: 'context-monitor',
    script: '.claude/hooks/context_monitor.js',
    timeout: 5,
    claude: [{ event: 'UserPromptSubmit' }],
  },
  {
    id: 'audit',
    script: '.claude/hooks/audit_logger.js',
    timeout: 10,
    claude: [{ event: 'PostToolUse', matcher: '*' }],
  },
  {
    id: 'format',
    script: '.claude/hooks/auto_format.js',
    timeout: 30,
    claude: [{ event: 'PostToolUse', matcher: 'Edit|Write' }],
  },
];

/**
 * The shell command that runs a hook in a harness. Claude Code and the DSH
 * bridge set `$CLAUDE_PROJECT_DIR`; Codex sets no project dir and runs hooks
 * in the session's cwd, so its commands find the script from the git top
 * level (a worktree's own copy in a worktree).
 *
 * @param {Harness} harness
 * @param {Pick<HookSpec, 'script' | 'args'>} spec
 * @returns {string}
 */
export function hookCommand(harness, { script, args = [] }) {
  const program =
    harness === 'codex'
      ? `node "$(git rev-parse --show-toplevel)/${script}"`
      : `node "$CLAUDE_PROJECT_DIR"/${script}`;
  return [program, ...args, '--harness', harness].join(' ');
}

/**
 * Every hook entry a harness should have, in manifest order.
 *
 * @param {Harness} harness
 * @param {HookSpec[]} [specs]
 * @returns {HookEntry[]}
 */
export function hookEntries(harness, specs = HOOKS) {
  return specs.flatMap((spec) =>
    (spec[harness] ?? []).map((placement) => ({
      event: placement.event,
      matcher: placement.matcher ?? null,
      command: hookCommand(harness, spec),
      timeout: placement.timeout ?? spec.timeout,
    }))
  );
}

/**
 * A harness's hooks in the Claude settings format (`hooks.<Event>[].hooks[]`)
 * that Codex's hooks.json and the DSH bridge also read: events in manifest
 * order, and consecutive entries with the same matcher in one group. Null
 * when the harness has no hooks.
 *
 * @param {Harness} harness
 * @param {{ specs?: HookSpec[], description?: string }} [options]
 * @returns {HooksConfig | null}
 */
export function renderHooksConfig(
  harness,
  { specs = HOOKS, description } = {}
) {
  const entries = hookEntries(harness, specs);
  if (entries.length === 0) return null;
  /** @type {Record<string, HookGroup[]>} */
  const hooks = {};
  for (const entry of entries) {
    const groups = (hooks[entry.event] ??= []);
    const last = groups.at(-1);
    // Manifest entries always have a timeout (HookSpec.timeout is required).
    /** @type {CommandHook} */
    const hook = {
      type: 'command',
      command: entry.command,
      timeout: /** @type {number} */ (entry.timeout),
    };
    if (last && (last.matcher ?? null) === entry.matcher) {
      last.hooks.push(hook);
    } else {
      groups.push({
        ...(entry.matcher === null ? {} : { matcher: entry.matcher }),
        hooks: [hook],
      });
    }
  }
  return { ...(description === undefined ? {} : { description }), hooks };
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The command hooks in a Claude-format config (`.claude/settings.json`,
 * `.codex/hooks.json`), flattened. Malformed parts and non-command hooks are
 * skipped.
 *
 * @param {unknown} config
 * @returns {HookEntry[]}
 */
export function readHookEntries(config) {
  const hooks = isObject(config)
    ? /** @type {Record<string, unknown>} */ (config).hooks
    : null;
  if (!isObject(hooks)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (hooks)).flatMap(
    ([event, groups]) =>
      (Array.isArray(groups) ? groups : []).flatMap((group) =>
        isObject(group) && Array.isArray(group.hooks)
          ? group.hooks
              .filter(
                (/** @type {any} */ hook) =>
                  hook?.type === 'command' && typeof hook.command === 'string'
              )
              .map((/** @type {any} */ hook) => ({
                event,
                matcher:
                  typeof group.matcher === 'string' ? group.matcher : null,
                command: hook.command,
                timeout: typeof hook.timeout === 'number' ? hook.timeout : null,
              }))
          : []
      )
  );
}

/** @param {HookEntry} entry */
const entryKey = (entry) =>
  JSON.stringify([entry.event, entry.matcher, entry.command, entry.timeout]);

/**
 * Entries `expected` has that `actual` lacks, and the reverse; order does not
 * matter, duplicates count.
 *
 * @param {HookEntry[]} expected
 * @param {HookEntry[]} actual
 * @returns {{ missing: HookEntry[], extra: HookEntry[] }}
 */
export function diffEntries(expected, actual) {
  const extra = [...actual];
  const missing = expected.filter((entry) => {
    const index = extra.findIndex((e) => entryKey(e) === entryKey(entry));
    if (index === -1) return true;
    extra.splice(index, 1);
    return false;
  });
  return { missing, extra };
}
