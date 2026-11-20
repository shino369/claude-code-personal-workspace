/**
 * Session transcripts → the condensed text extraction reads (design §6 path
 * B): what the user typed, the agent's final reply of each turn, and failed
 * shell commands with their errors. Everything else (tool inputs and
 * results, thinking, hook output, subagent turns) is left out.
 *
 * Secrets never reach the extraction model: a failed command whose text
 * holds a secret is dropped whole, and secrets in the rest are redacted.
 * Notes refuse secrets anyway (store.js); this keeps them out of the prompt.
 *
 * One adapter per harness transcript format; Claude Code's JSONL is the
 * first (Codex and dsh are later phases).
 */
import fs from 'fs';
import { findSecrets, redactSecrets } from '../redact.js';

/** Characters kept per item. */
export const ITEM_CHARS = { user: 2000, reply: 1500, command: 300, error: 500 };
/** Characters of condensed session one extraction reads (the newest part). */
export const SESSION_BUDGET = 24_000;
/** A session with less condensed text than this is not worth a model call. */
export const MIN_SESSION_CHARS = 200;

/** Typed text that is not a prompt: slash commands, their output, notices. */
const NOT_PROMPT_RE =
  /^(<command-name>|<command-message>|<local-command-|<task-notification>|\[Request interrupted)/;
const REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ELLIPSIS = ' … ';

/**
 * @typedef {{ kind: 'user' | 'reply', text: string }
 *   | { kind: 'failure', command: string, error: string }} Item
 * @typedef {{ items: Item[], model: string | null, cwd: string | null, dropped: number }} Condensed
 *   `dropped`: failed commands left out because they held a secret
 */

/**
 * Text within `max` characters: as it is, else its head and tail.
 *
 * @param {string} text
 * @param {number} max
 */
export function clip(text, max) {
  if (text.length <= max) return text;
  const room = max - ELLIPSIS.length;
  const head = Math.ceil(room * 0.6);
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - (room - head))}`;
}

/** @param {unknown} value */
const isObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The text of a message's content: a string, or its text blocks joined.
 *
 * @param {unknown} content
 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * What the user typed in a transcript entry, or '' when it is not a prompt.
 *
 * @param {Record<string, any>} entry
 */
function promptOf(entry) {
  if (entry.isMeta || (entry.origin && entry.origin.kind !== 'human'))
    return '';
  const text = textOf(entry.message?.content).replace(REMINDER_RE, '').trim();
  return NOT_PROMPT_RE.test(text) ? '' : text;
}

/**
 * Condense a Claude Code transcript (JSONL lines).
 *
 * @param {string} text
 * @returns {Condensed}
 */
export function condenseClaude(text) {
  /** @type {Item[]} */
  const items = [];
  /** @type {Map<string, string>} tool_use id → Bash command */
  const commands = new Map();
  let model = null;
  let cwd = null;
  let dropped = 0;
  let reply = '';
  const flushReply = () => {
    if (reply) {
      items.push({
        kind: 'reply',
        text: clip(redactSecrets(reply), ITEM_CHARS.reply),
      });
    }
    reply = '';
  };

  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.isSidechain) continue;
    if (typeof entry.cwd === 'string') cwd = entry.cwd;
    const content = entry.message?.content;

    if (entry.type === 'assistant') {
      model = entry.requestedModel ?? entry.message?.model ?? model;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          if (block.text.trim()) reply = block.text.trim();
        } else if (
          block?.type === 'tool_use' &&
          block.name === 'Bash' &&
          typeof block.input?.command === 'string'
        ) {
          commands.set(block.id, block.input.command);
        }
      }
    } else if (entry.type === 'user') {
      const results = Array.isArray(content)
        ? content.filter((block) => block?.type === 'tool_result')
        : [];
      for (const block of results) {
        const command = commands.get(block.tool_use_id);
        if (!block.is_error || command === undefined) continue;
        if (findSecrets(command).length > 0) {
          dropped += 1;
          continue;
        }
        items.push({
          kind: 'failure',
          command: clip(command.trim(), ITEM_CHARS.command),
          error: clip(
            redactSecrets(textOf(block.content).trim()),
            ITEM_CHARS.error
          ),
        });
      }
      const prompt = results.length > 0 ? '' : promptOf(entry);
      if (prompt) {
        flushReply();
        items.push({
          kind: 'user',
          text: clip(redactSecrets(prompt), ITEM_CHARS.user),
        });
      }
    }
  }
  flushReply();
  return { items, model, cwd, dropped };
}

/** Transcript adapters by harness. */
export const TRANSCRIPT_ADAPTERS = { claude: condenseClaude };

/** @param {Item} item */
function formatItem(item) {
  if (item.kind === 'failure') {
    return `[failed command] $ ${item.command}\n${item.error}`;
  }
  return `${item.kind === 'user' ? '[user]' : '[assistant]'} ${item.text}`;
}

/**
 * The items as labeled paragraphs, newest kept within `budget` characters.
 *
 * @param {Item[]} items
 * @param {number} [budget]
 * @returns {{ text: string, omitted: number }}
 */
export function formatSession(items, budget = SESSION_BUDGET) {
  /** @type {string[]} */
  const kept = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const paragraph = formatItem(items[i]);
    const cost = paragraph.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(paragraph);
    used += cost;
  }
  const omitted = items.length - kept.length;
  if (omitted > 0) {
    kept.unshift(
      `(${omitted} earlier item${omitted === 1 ? '' : 's'} omitted)`
    );
  }
  return { text: kept.join('\n\n'), omitted };
}

/**
 * Whether a session has too little to learn from: no user message, or less
 * than MIN_SESSION_CHARS of condensed text.
 *
 * @param {Item[]} items
 */
export function isTrivial(items) {
  if (!items.some((item) => item.kind === 'user')) return true;
  const size = items.reduce(
    (sum, item) =>
      sum +
      (item.kind === 'failure'
        ? item.command.length + item.error.length
        : item.text.length),
    0
  );
  return size < MIN_SESSION_CHARS;
}

/**
 * The complete lines a transcript gained since `offset` (bytes). A
 * transcript shorter than the offset was rewritten: read it from the start.
 *
 * @param {string} file
 * @param {number} offset
 * @returns {{ text: string, start: number, end: number } | null} null when missing
 */
export function readNewLines(file, offset) {
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  const start = content.length < offset ? 0 : offset;
  const last = content.lastIndexOf(0x0a);
  const end = last + 1 > start ? last + 1 : start;
  return { text: content.subarray(start, end).toString('utf-8'), start, end };
}
