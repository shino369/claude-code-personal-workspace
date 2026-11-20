/**
 * What every hook needs to know about the harness that runs it, in one
 * shape. Hook scripts are written once and run under Claude Code, Codex, and
 * DSH (its Claude hooks bridge); each is started with `--harness <name>`
 * (default `claude`) and reads its payload through these helpers.
 *
 * Payload differences this covers (see the harness-parity study):
 * - Tool names: Claude `Bash`/`Edit`/`Write`/`Read`; Codex `Bash` for shell
 *   commands *and* shell-run `apply_patch`, plus an `apply_patch` tool; DSH
 *   `bash`/`pwsh`/`read`/`edit`/`write`/`apply_patch`/`str_replace_editor`.
 * - Patch edits carry no file list: the files come from the patch headers.
 * - Transcripts: Claude JSONL with `message.usage`; Codex rollout JSONL with
 *   `token_count` events; DSH gives hooks none.
 *
 * Pure apart from reading a transcript file; fails soft (null, empty lists).
 */
import fs from 'fs';

export const HARNESSES = /** @type {const} */ (['claude', 'codex', 'dsh']);
/** Bytes read per step when scanning a transcript from its end. */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * @typedef {typeof HARNESSES[number]} Harness
 * @typedef {{ kind: 'shell' | 'edit' | 'read' | 'other', name: string, command: string, files: string[], dir?: string }} ToolEvent
 */

const SHELL_TOOLS = new Set(['Bash', 'bash', 'pwsh']);
const EDIT_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'edit',
  'write',
]);
const READ_TOOLS = new Set(['Read', 'read']);
// Linear: `[^\n]*` cannot backtrack, and the trimming is done in code.
const PATCH_HEADER_RE =
  /^[ \t]*\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\n]*)/gm;
/**
 * The shell invocations Codex treats as `apply_patch`
 * (codex-rs/apply-patch/src/invocation.rs, `maybe_parse_apply_patch`):
 * `apply_patch`/`applypatch` directly; inside `bash|zsh|sh -c|-lc`,
 * `pwsh|powershell [-NoProfile] -Command`, or `cmd /c`; with an optional
 * `cd <dir> &&` first (group 1 is that dir). Looser than Codex on quoting:
 * a guard should over-detect.
 */
const APPLY_PATCH_RE =
  /^\s*(?:(?:\S*[\\/])?(?:bash|zsh|sh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-NoProfile\s+)?(?:-lc|-c|-Command|\/c)\s+)?(?:['"]\s*)?(?:cd\s+("[^"]*"|'[^']*'|[^\s&;|'"]+)\s*&&\s*)?(?:apply_patch|applypatch)\b/i;

/**
 * The harness named by `--harness`, else `claude`.
 *
 * @param {string[]} argv
 * @returns {Harness}
 */
export function parseHarness(argv) {
  const value = argv[argv.indexOf('--harness') + 1];
  return HARNESSES.find((name) => name === value) ?? 'claude';
}

/**
 * The project the session works in. Claude Code and the DSH bridge set
 * `CLAUDE_PROJECT_DIR`; Codex sets nothing (and may inherit a parent Claude
 * session's value), so it gets the workspace root the hook script lives in.
 *
 * @param {{ harness: Harness, env: NodeJS.ProcessEnv, rootDir: string }} input
 * @returns {string}
 */
export function projectDir({ harness, env, rootDir }) {
  if (harness === 'codex') return rootDir;
  return env.CLAUDE_PROJECT_DIR || rootDir;
}

/**
 * The files a patch touches, in order, each once: `*** Add File:`,
 * `*** Update File:`, `*** Delete File:`, and `*** Move to:` headers.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function patchFiles(text) {
  if (typeof text !== 'string') return [];
  const files = [...text.matchAll(PATCH_HEADER_RE)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  return [...new Set(files)];
}

/** @param {unknown} value */
const stringOrEmpty = (value) => (typeof value === 'string' ? value : '');

/**
 * A tool call in one shape, whatever the harness called the tool.
 *
 * @param {unknown} input the hook payload (PreToolUse or PostToolUse)
 * @returns {ToolEvent}
 */
export function toolEvent(input) {
  const payload = /** @type {Record<string, any>} */ (input ?? {});
  const name = stringOrEmpty(payload.tool_name);
  const args = /** @type {Record<string, unknown>} */ (
    payload.tool_input ?? {}
  );
  const command = Array.isArray(args.command)
    ? args.command.join(' ')
    : stringOrEmpty(args.command);
  /** @param {ToolEvent['kind']} kind @param {string[]} [files] @param {string} [dir] */
  const event = (kind, files = [], dir) => ({
    kind,
    name,
    command,
    files,
    ...(dir ? { dir } : {}),
  });
  /** @param {unknown} file */
  const one = (file) => (typeof file === 'string' ? [file] : []);

  if (SHELL_TOOLS.has(name)) {
    const patch = APPLY_PATCH_RE.exec(command);
    if (!patch) return event('shell');
    return event(
      'edit',
      patchFiles(command),
      patch[1]?.replace(/^(["'])(.*)\1$/, '$2')
    );
  }
  if (name === 'apply_patch') {
    return event('edit', patchFiles(command || args.input));
  }
  if (EDIT_TOOLS.has(name)) {
    return event('edit', one(args.file_path ?? args.notebook_path));
  }
  if (READ_TOOLS.has(name)) return event('read', one(args.file_path));
  if (name === 'str_replace_editor') {
    return event(command === 'view' ? 'read' : 'edit', one(args.path));
  }
  return event('other');
}

/**
 * The newest JSON line of a file that `match` accepts, scanning from the end
 * a chunk at a time (transcripts grow to tens of MB). Lines that are not
 * JSON, such as one still being written, are skipped. Null when nothing
 * matches or the file cannot be read.
 *
 * @param {string} file
 * @param {(entry: any) => boolean} match
 * @returns {any}
 */
export function findLastLine(file, match) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let position = fs.fstatSync(fd).size;
    let rest = Buffer.alloc(0);
    while (position > 0) {
      const size = Math.min(TAIL_CHUNK_BYTES, position);
      position -= size;
      const chunk = Buffer.alloc(size);
      fs.readSync(fd, chunk, 0, size, position);
      const data = Buffer.concat([chunk, rest]);
      let start = 0;
      if (position > 0) {
        // Bytes before the first newline may be the end of a line that
        // starts in an earlier chunk: carry them over unparsed.
        const newline = data.indexOf(10);
        if (newline === -1) {
          rest = data;
          continue;
        }
        rest = data.subarray(0, newline);
        start = newline + 1;
      }
      const lines = data.subarray(start).toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const found = parse(lines[i]);
        if (found !== undefined && match(found)) return found;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * @param {string} line
 * @returns {unknown} the parsed value, or undefined
 */
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * How full the context window is, from the session transcript: `tokens` in
 * context and the model's `window` when the transcript records it (Codex),
 * else null (Claude: the window comes from config). Null without usage data,
 * and always for DSH, whose hooks get no transcript.
 *
 * - Claude: the newest assistant entry's usage (input + cache read + cache
 *   creation); accurate when prompt caching is active.
 * - Codex: the newest `token_count` event's `last_token_usage.total_tokens`,
 *   which is what Codex's own context meter counts.
 *
 * @param {string | undefined} transcriptPath
 * @param {Harness} harness
 * @returns {{ tokens: number, window: number | null } | null}
 */
export function transcriptUsage(transcriptPath, harness) {
  if (!transcriptPath || harness === 'dsh') return null;
  if (harness === 'codex') {
    const entry = findLastLine(
      transcriptPath,
      (e) =>
        e?.type === 'event_msg' &&
        e.payload?.type === 'token_count' &&
        typeof e.payload.info?.last_token_usage?.total_tokens === 'number'
    );
    if (!entry) return null;
    const { info } = entry.payload;
    const window = info.model_context_window;
    return {
      tokens: info.last_token_usage.total_tokens,
      window: typeof window === 'number' && window > 0 ? window : null,
    };
  }
  const entry = findLastLine(
    transcriptPath,
    (e) => e?.type === 'assistant' && e.message?.usage
  );
  if (!entry) return null;
  const usage = entry.message.usage;
  return {
    tokens:
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.input_tokens || 0),
    window: null,
  };
}
