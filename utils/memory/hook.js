#!/usr/bin/env node
/**
 * Memory hook: one script for Claude Code (`.claude/settings.json`) and
 * Codex (`.codex/hooks.json`), run as `node utils/memory/hook.js --harness
 * claude|codex` (design §7, §8). It reads the hook's JSON on stdin and may
 * print `{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`:
 *
 * - SessionStart: Codex gets the core block (it does not load
 *   AGENTS.local.md natively); Claude Code only when CLAUDE.local.md is
 *   missing. Both hear when saving is off. /clear and compaction forget what
 *   this session was shown.
 * - UserPromptSubmit: a one-line persona reminder when personalization is
 *   set (the core block loads once; this keeps it near each turn), then the
 *   notes recalled for the prompt and the task's goal (not for slash
 *   commands or background-task notifications).
 * - PreToolUse: notes whose triggers are in the command (no scoring).
 * - PostToolUseFailure (Claude) or PostToolUse with a non-zero exit (Codex):
 *   notes recalled for the command and its error output.
 * - Extraction (path B, harnesses with a transcript adapter: Claude Code
 *   and Codex; DSH has no SessionEnd and gives hooks no transcript):
 *   SessionStart records the session as open, queues sessions that ended
 *   without a SessionEnd, and starts the worker (also when consolidation is
 *   due); SessionEnd queues the
 *   session and starts the worker (detached, so nothing waits). SessionStart
 *   also announces what extraction saved since the last session.
 *
 * Silence is the default: nothing is printed when nothing matches, before
 * memory is set up, for the reviewer and verifier roles (clean-context
 * reviews), for the extraction agent (EXTRACT_ENV), or on any error (fail
 * open). A note is injected once per session. Reads only the caches on the
 * warm path, so it stays fast.
 */
import fs from 'fs';
import path from 'path';
import { runIfMain } from '../module-runner.js';
import { SESSION_ID_RE } from '../task/store.js';
import { ROOT_DIR } from '../workspace-config.js';
import { readConfig, savingOff } from './config.js';
import { consolidationDue } from './consolidate.js';
import { taskContext } from './context.js';
import { announcement } from './extract.js';
import {
  EXTRACT_ENV,
  catchUp,
  enqueue,
  kickWorker,
  readQueue,
  registerOpen,
  workerRunning,
} from './queue.js';
import {
  RECALL_LIMIT,
  formatRecall,
  loadIndex,
  matchTriggers,
  recall,
} from './recall.js';
import {
  AGENTS_LOCAL_FILE,
  CLAUDE_LOCAL_FILE,
  renderStored,
} from './render.js';
import { readPersonalization } from './personalize.js';
import { mainCheckout } from './repo.js';
import {
  CACHE_DIR,
  memoryDir,
  readJsonOrNull,
  readUsage,
  recordHits,
} from './store.js';

/** Roles that must review in a clean context. */
export const SKIP_AGENTS = ['reviewer', 'verifier'];
export const SESSIONS_DIR = 'sessions';
/** Session records older than this are pruned at SessionStart. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Characters of a failed command's output used in the query. */
export const ERROR_CHARS = 600;
const HARNESSES = ['claude', 'codex', 'dsh'];
const EXIT_CODE_RE = /\bexit code:?\s*(-?\d+)/i;
const NOTE_ID_RE = /^- ([mt][1-9]\d*) \(/;
/** Repeated at every typed prompt, so progress notes keep the persona. */
export const PERSONA_REMINDER =
  '[Persona] Every message to the user, progress notes between tool calls included, follows the Personalization section.';
/** Characters of the language setting quoted in the reminder. */
export const REMINDER_LANGUAGE_CHARS = 200;

/**
 * @typedef {'claude' | 'codex' | 'dsh'} Harness
 * @typedef {Record<string, any>} HookInput
 * @typedef {{ hookSpecificOutput: { hookEventName: string, additionalContext: string }, systemMessage?: string }} HookOutput
 * @typedef {{ harness?: Harness, rootDir?: string, now?: Date, env?: NodeJS.ProcessEnv, kick?: typeof kickWorker }} HookOptions
 */

/**
 * @param {string[]} argv
 * @returns {Harness}
 */
export function parseHarness(argv) {
  const value = argv[argv.indexOf('--harness') + 1];
  return HARNESSES.includes(value) ? /** @type {Harness} */ (value) : 'claude';
}

/**
 * @param {string} dir the memory directory
 * @param {string} session
 */
export const sessionFile = (dir, session) =>
  path.join(dir, CACHE_DIR, SESSIONS_DIR, `${session}.json`);

/**
 * The note ids this session was already shown.
 *
 * @param {string} dir
 * @param {string | null} session
 * @returns {Set<string>}
 */
export function readInjected(dir, session) {
  if (!session) return new Set();
  const data = /** @type {any} */ (readJsonOrNull(sessionFile(dir, session)));
  return new Set(Array.isArray(data?.injected) ? data.injected : []);
}

/**
 * @param {string} dir
 * @param {string | null} session
 * @param {Set<string>} injected
 */
function writeInjected(dir, session, injected) {
  if (!session) return;
  const file = sessionFile(dir, session);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ injected: [...injected] }));
}

/**
 * Remove the records of sessions untouched for SESSION_MAX_AGE_MS.
 *
 * @param {string} dir
 * @param {Date} now
 */
function pruneSessions(dir, now) {
  const sessions = path.join(dir, CACHE_DIR, SESSIONS_DIR);
  if (!fs.existsSync(sessions)) return;
  for (const name of fs.readdirSync(sessions)) {
    const file = path.join(sessions, name);
    if (now.getTime() - fs.statSync(file).mtimeMs > SESSION_MAX_AGE_MS) {
      fs.rmSync(file, { force: true });
    }
  }
}

/**
 * @param {string} event
 * @param {string} text
 * @returns {HookOutput | null}
 */
const contextOutput = (event, text) =>
  text
    ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } }
    : null;

/**
 * The shell command of a tool event, as one string.
 *
 * @param {HookInput} input
 */
function commandOf(input) {
  const command = input.tool_input?.command;
  if (Array.isArray(command)) return command.join(' ');
  return typeof command === 'string' ? command : '';
}

/**
 * The error output of a failed command (at most ERROR_CHARS), or null when
 * the event is not a failure. Claude Code reports failures as
 * PostToolUseFailure with an `error`; Codex as PostToolUse, whose response
 * holds the exit code (a field, or an "Exit code: N" line).
 *
 * @param {HookInput} input
 * @returns {string | null}
 */
export function failureText(input) {
  if (input.hook_event_name === 'PostToolUseFailure') {
    return String(input.error ?? '').slice(0, ERROR_CHARS);
  }
  const response = input.tool_response;
  const text =
    typeof response === 'string'
      ? response
      : ['stderr', 'stdout', 'output']
          .map((key) => response?.[key])
          .filter((value) => typeof value === 'string')
          .join('\n');
  const field = response?.exit_code ?? response?.exitCode;
  const exit =
    typeof field === 'number'
      ? field
      : Number(EXIT_CODE_RE.exec(text)?.[1] ?? 0);
  return exit === 0 ? null : text.slice(0, ERROR_CHARS);
}

/**
 * The persona reminder for the user's settings, or '' without any (or with
 * a broken settings file: the reminder is optional, recall must still run).
 *
 * @param {string} dir the memory directory
 */
function personaReminder(dir) {
  let settings;
  try {
    settings = readPersonalization(dir);
  } catch {
    return '';
  }
  if (Object.keys(settings).length === 0) return '';
  if (!settings.language) return PERSONA_REMINDER;
  const language = settings.language.replace(/\s+/g, ' ');
  return `${PERSONA_REMINDER} Language: ${
    language.length > REMINDER_LANGUAGE_CHARS
      ? `${language.slice(0, REMINDER_LANGUAGE_CHARS)}…`
      : language
  }`;
}

/**
 * Recall for `query`, skipping what the session was shown; record the
 * injection (usage and the session's record).
 *
 * @param {{ dir: string, session: string | null, now: Date }} store
 * @param {string} event
 * @param {(notes: import('./store.js').Note[], index: import('./recall.js').Index) => import('./recall.js').RecallResult[] | { note: import('./store.js').Note }[]} pick
 * @returns {HookOutput | null}
 */
function inject({ dir, session, now }, event, pick) {
  const { notes, index } = loadIndex(dir);
  const injected = readInjected(dir, session);
  const text = formatRecall(
    pick(
      notes.filter((note) => !injected.has(note.id)),
      index
    ),
    { now }
  );
  if (!text) return null;
  const ids = text
    .split('\n')
    .map((line) => NOTE_ID_RE.exec(line)?.[1])
    .filter((id) => id !== undefined);
  recordHits(dir, ids, now);
  writeInjected(dir, session, new Set([...injected, ...ids]));
  return contextOutput(event, text);
}

/**
 * @param {HookInput} input
 * @param {HookOptions} [options]
 * @returns {HookOutput | null}
 */
export function handleHook(
  input,
  {
    harness = 'claude',
    rootDir = ROOT_DIR,
    now = new Date(),
    env = process.env,
    kick = kickWorker,
  } = {}
) {
  const event = input.hook_event_name;
  if (env[EXTRACT_ENV] === '1' || SKIP_AGENTS.includes(input.agent_type)) {
    return null;
  }
  const home = mainCheckout(rootDir);
  const dir = memoryDir(home);
  if (!fs.existsSync(dir)) return null;
  const session =
    typeof input.session_id === 'string' && SESSION_ID_RE.test(input.session_id)
      ? input.session_id
      : null;
  const store = { dir, session, now };
  const context = () =>
    taskContext({
      rootDir,
      session,
      cwd: typeof input.cwd === 'string' ? input.cwd : rootDir,
    });

  const entry = {
    session,
    harness,
    transcript: input.transcript_path,
    cwd: input.cwd,
    at: now.toISOString(),
  };
  const startWorker = (/** @type {boolean} */ orConsolidate) => {
    const work =
      readQueue(dir).length > 0 ||
      (orConsolidate && consolidationDue(home, { now }) !== null);
    if (work && !workerRunning(dir)) kick({ rootDir: home, env });
  };

  if (event === 'SessionEnd') {
    // Headless runs (--no-session-persistence) leave no transcript to read.
    const saved =
      typeof entry.transcript === 'string' && fs.existsSync(entry.transcript);
    if (saved && enqueue(dir, entry)) startWorker(false);
    return null;
  }
  if (event === 'SessionStart') {
    if (input.source !== 'resume') writeInjected(dir, session, new Set());
    pruneSessions(dir, now);
    registerOpen(dir, entry);
    catchUp(dir, { current: session, now });
    startWorker(true);
    const news = announcement(dir);
    const off = savingOff(readConfig(dir), session);
    const parts = [
      // The core block, unless the harness loads it from a local file:
      // Claude Code through CLAUDE.local.md, DSH AGENTS.local.md itself.
      ...(harness === 'codex' ||
      !fs.existsSync(
        path.join(
          home,
          harness === 'dsh' ? AGENTS_LOCAL_FILE : CLAUDE_LOCAL_FILE
        )
      )
        ? [renderStored(home).block]
        : []),
      ...(off
        ? [
            `[Memory] Saving to memory is off ${off === 'global' ? 'everywhere' : 'for this session'}: do not save notes (pnpm memory add) unless the user asks; recall still works.`,
          ]
        : []),
      // Claude Code shows the user a systemMessage; Codex relies on the agent.
      ...(news
        ? [
            harness === 'claude'
              ? news
              : `${news}\nMention these saves to the user in one line.`,
          ]
        : []),
    ];
    const output = contextOutput(event, parts.join('\n\n'));
    return output && news && harness === 'claude'
      ? { ...output, systemMessage: news }
      : output;
  }
  if (event === 'UserPromptSubmit') {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    // Slash commands, and queued background-task notifications (not typed).
    if (
      !prompt ||
      prompt.startsWith('/') ||
      prompt.startsWith('<task-notification>')
    ) {
      return null;
    }
    const { goal, repo } = context();
    const query = [prompt, goal].filter(Boolean).join('\n');
    const recalled = inject(store, event, (notes, index) =>
      recall(notes, query, { index, repo, usage: readUsage(dir), now })
    );
    return contextOutput(
      event,
      [personaReminder(dir), recalled?.hookSpecificOutput.additionalContext]
        .filter(Boolean)
        .join('\n\n')
    );
  }
  if (event === 'PreToolUse') {
    const command = commandOf(input);
    if (!command) return null;
    return inject(store, event, (notes) =>
      matchTriggers(notes, command)
        .slice(0, RECALL_LIMIT)
        .map((note) => ({ note }))
    );
  }
  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const error = failureText(input);
    const query = [commandOf(input), error ?? ''].join('\n').trim();
    if (error === null || !query) return null;
    const { repo } = context();
    return inject(store, event, (notes, index) =>
      recall(notes, query, {
        index,
        repo,
        failure: true,
        usage: readUsage(dir),
        now,
      })
    );
  }
  return null;
}

/**
 * Parse the hook's stdin and answer it; '' when there is nothing to say or
 * anything goes wrong (a hook must never break the session).
 *
 * @param {string} raw stdin
 * @param {HookOptions} [options]
 * @returns {string}
 */
export function runHook(raw, options = {}) {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = handleHook(input, options);
    return output ? JSON.stringify(output) : '';
  } catch {
    return '';
  }
}

/* c8 ignore start - stdin/stdout wiring; the logic is tested through runHook */
function main() {
  let data = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    data += chunk;
  });
  process.stdin.on('end', () => {
    const out = runHook(data, { harness: parseHarness(process.argv.slice(2)) });
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
