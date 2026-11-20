/**
 * Tests for utils/memory/transcript.js (session transcripts → condensed text)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { REDACTED } from '../../redact.js';
import {
  ITEM_CHARS,
  MIN_SESSION_CHARS,
  SESSION_BUDGET,
  TRANSCRIPT_ADAPTERS,
  clip,
  condenseClaude,
  condenseCodex,
  formatSession,
  isTrivial,
  readNewLines,
} from '../transcript.js';

const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

/** @param {object[]} entries */
const jsonl = (entries) => entries.map((e) => JSON.stringify(e)).join('\n');

/** @param {string} text @param {object} [extra] */
const typed = (text, extra = {}) => ({
  type: 'user',
  origin: { kind: 'human' },
  cwd: '/work/web',
  message: { role: 'user', content: text },
  ...extra,
});

/** @param {object[]} content @param {object} [extra] */
const assistant = (content, extra = {}) => ({
  type: 'assistant',
  requestedModel: 'us.anthropic.claude-opus-5-5',
  message: { role: 'assistant', model: 'claude-opus-5-5', content },
  ...extra,
});

/** @param {string} id @param {string} command */
const bash = (id, command) => ({
  type: 'tool_use',
  id,
  name: 'Bash',
  input: { command },
});

/** @param {string} id @param {unknown} content @param {boolean} [isError] */
const result = (id, content, isError = true) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: id, content, is_error: isError },
    ],
  },
});

describe('clip', () => {
  test('should keep text within the limit as it is', () => {
    expect(clip('short', 10)).toBe('short');
  });

  test('should keep the head and the tail of longer text', () => {
    const text = `${'a'.repeat(50)}${'b'.repeat(50)}`;
    const clipped = clip(text, 20);
    expect(clipped.length).toBeLessThanOrEqual(20);
    expect(clipped.startsWith('aaaa')).toBe(true);
    expect(clipped.endsWith('bbbb')).toBe(true);
    expect(clipped).toContain('…');
  });
});

describe('condenseClaude', () => {
  test('should keep typed user messages and the final reply of each turn', () => {
    const text = jsonl([
      typed('Please use pnpm, never npm.'),
      assistant([{ type: 'text', text: 'Checking the setup.' }]),
      assistant([{ type: 'text', text: 'Done: switched to pnpm.' }]),
      typed('Thanks'),
      assistant([{ type: 'text', text: 'You are welcome.' }]),
    ]);

    const { items } = condenseClaude(text);

    expect(items).toEqual([
      { kind: 'user', text: 'Please use pnpm, never npm.' },
      { kind: 'reply', text: 'Done: switched to pnpm.' },
      { kind: 'user', text: 'Thanks' },
      { kind: 'reply', text: 'You are welcome.' },
    ]);
  });

  test('should report the session model and working directory', () => {
    const text = jsonl([
      typed('hi'),
      assistant([{ type: 'text', text: 'ok' }]),
    ]);

    const { model, cwd } = condenseClaude(text);

    expect(model).toBe('us.anthropic.claude-opus-5-5');
    expect(cwd).toBe('/work/web');
  });

  test('should fall back to the message model without a requested model', () => {
    const text = jsonl([
      assistant([{ type: 'text', text: 'ok' }], { requestedModel: undefined }),
    ]);

    expect(condenseClaude(text).model).toBe('claude-opus-5-5');
  });

  test('should report no model or directory when the transcript has none', () => {
    const text = jsonl([
      { type: 'user', message: { role: 'user', content: 'x' } },
      { type: 'assistant', message: { content: [] } },
    ]);

    expect(condenseClaude(text)).toMatchObject({ model: null, cwd: null });
  });

  test('should skip meta, sidechain, notification, and command messages', () => {
    const text = jsonl([
      typed('hook feedback', { isMeta: true }),
      typed('from a subagent', { isSidechain: true }),
      typed('<task-notification>\nbackground done', {
        origin: { kind: 'task-notification' },
      }),
      typed('<command-name>/clear</command-name>', { origin: undefined }),
      typed('<local-command-stdout></local-command-stdout>'),
      typed('[Request interrupted by user]'),
      assistant([{ type: 'text', text: 'sub reply' }], { isSidechain: true }),
      typed('real prompt'),
    ]);

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'real prompt' },
    ]);
  });

  test('should strip system reminders from user text', () => {
    const text = jsonl([
      typed('<system-reminder>\nrules\n</system-reminder>\nfix the build'),
      typed('<system-reminder>only a reminder</system-reminder>'),
    ]);

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'fix the build' },
    ]);
  });

  test('should read user text blocks and ignore images', () => {
    const text = jsonl([
      {
        type: 'user',
        origin: { kind: 'human' },
        message: {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: 'what is in this screenshot?' },
          ],
        },
      },
    ]);

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'what is in this screenshot?' },
    ]);
  });

  test('should keep failed Bash commands with their error', () => {
    const text = jsonl([
      typed('install it'),
      assistant([bash('t1', 'pnpm add -D left-pad')]),
      result('t1', 'Exit code 1\nERR_PNPM_NO_MATURE_MATCHING_VERSION'),
      assistant([{ type: 'text', text: 'Pinned an older version.' }]),
    ]);

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'install it' },
      {
        kind: 'failure',
        command: 'pnpm add -D left-pad',
        error: 'Exit code 1\nERR_PNPM_NO_MATURE_MATCHING_VERSION',
      },
      { kind: 'reply', text: 'Pinned an older version.' },
    ]);
  });

  test('should read an error given as text blocks', () => {
    const text = jsonl([
      assistant([bash('t1', 'gh pr view')]),
      result('t1', [
        { type: 'text', text: 'HTTP 403' },
        { type: 'image' },
        { type: 'text', text: 'Noncompliant action' },
      ]),
    ]);

    expect(condenseClaude(text).items).toEqual([
      {
        kind: 'failure',
        command: 'gh pr view',
        error: 'HTTP 403\nNoncompliant action',
      },
    ]);
  });

  test('should ignore successful commands, other tools, and unknown results', () => {
    const text = jsonl([
      assistant([
        bash('t1', 'ls'),
        { type: 'tool_use', id: 't2', name: 'Read', input: { file: 'x' } },
        { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
        { type: 'thinking', thinking: 'hmm' },
      ]),
      result('t1', 'a b c', false),
      result('t2', 'File does not exist'),
      result('t3', 'Exit code 2'),
      result('t9', 'Exit code 1'),
    ]);

    expect(condenseClaude(text).items).toEqual([]);
  });

  test('should drop a failed command that carries a secret', () => {
    const text = jsonl([
      assistant([bash('t1', `GH_TOKEN=${TOKEN} gh api user`)]),
      result('t1', 'Exit code 1\nBad credentials'),
    ]);

    const { items, dropped } = condenseClaude(text);

    expect(items).toEqual([]);
    expect(dropped).toBe(1);
  });

  test('should redact secrets in user text, replies, and errors', () => {
    const text = jsonl([
      typed(`my token is ${TOKEN}`),
      assistant([bash('t1', 'gh auth status')]),
      result('t1', `Exit code 1\ntoken ${TOKEN} expired`),
      assistant([{ type: 'text', text: `Do not paste ${TOKEN} here.` }]),
    ]);

    const serialized = JSON.stringify(condenseClaude(text).items);

    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain(REDACTED);
  });

  test('should clip long items', () => {
    const text = jsonl([
      typed('u'.repeat(ITEM_CHARS.user + 100)),
      assistant([bash('t1', `echo ${'c'.repeat(ITEM_CHARS.command)}`)]),
      result('t1', `Exit code 1\n${'e'.repeat(ITEM_CHARS.error)}`),
      assistant([{ type: 'text', text: 'r'.repeat(ITEM_CHARS.reply + 100) }]),
    ]);

    const [user, failure, reply] = /** @type {any[]} */ (
      condenseClaude(text).items
    );

    expect(user.text?.length).toBeLessThanOrEqual(ITEM_CHARS.user);
    expect(failure.command?.length).toBeLessThanOrEqual(ITEM_CHARS.command);
    expect(failure.error?.length).toBeLessThanOrEqual(ITEM_CHARS.error);
    expect(reply.text?.length).toBeLessThanOrEqual(ITEM_CHARS.reply);
  });

  test('should skip lines that are not JSON objects', () => {
    const text = ['not json', '42', 'null', JSON.stringify(typed('kept'))].join(
      '\n'
    );

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'kept' },
    ]);
  });

  test('should skip entries with missing or malformed content', () => {
    const text = jsonl([
      { type: 'user', origin: { kind: 'human' } },
      { type: 'attachment', cwd: '/work/web' },
      { type: 'assistant', message: { content: 'not blocks' } },
      { type: 'assistant', message: { content: [null] } },
      { type: 'user', message: { role: 'user', content: [null] } },
      typed('kept'),
    ]);

    expect(condenseClaude(text).items).toEqual([
      { kind: 'user', text: 'kept' },
    ]);
  });

  test('should skip an empty reply', () => {
    const text = jsonl([
      typed('go'),
      assistant([{ type: 'text', text: '   ' }]),
      assistant([{ type: 'text' }]),
    ]);

    expect(condenseClaude(text).items).toEqual([{ kind: 'user', text: 'go' }]);
  });

  test('should be the Claude transcript adapter', () => {
    expect(TRANSCRIPT_ADAPTERS.claude).toBe(condenseClaude);
  });
});

describe('condenseCodex', () => {
  /** @param {string} type @param {object} payload */
  const line = (type, payload) => ({
    timestamp: '2026-11-20T10:00:00Z',
    type,
    payload,
  });
  /** @param {string} role @param {any} content @param {object} [extra] */
  const message = (role, content, extra = {}) =>
    line('response_item', { type: 'message', role, content, ...extra });
  /** @param {string} text @param {string[]} [kinds] */
  const user = (text, kinds = ['user.text']) =>
    message('user', [{ type: 'input_text', text }], {
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: kinds,
      },
    });
  /** @param {string} text @param {string} [phase] */
  const agent = (text, phase = 'final_answer') =>
    message('assistant', [{ type: 'output_text', text }], { phase });
  /** @param {string} id @param {any} args @param {string} [name] */
  const call = (id, args, name = 'exec_command') =>
    line('response_item', {
      type: 'function_call',
      name,
      call_id: id,
      arguments: JSON.stringify(args),
    });
  /** @param {string} id @param {unknown} output */
  const result = (id, output) =>
    line('response_item', {
      type: 'function_call_output',
      call_id: id,
      output,
    });
  /** @param {number} code @param {string} out */
  const unified = (code, out) =>
    `Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code ${code}\nOriginal token count: 4\nOutput:\n${out}`;

  test('should keep typed prompts and the final reply of each turn', () => {
    const { items } = condenseCodex(
      jsonl([
        user('use pnpm here'),
        agent('Looking.', 'commentary'),
        agent('Switched to pnpm.'),
        agent('And updated CI.'),
        user('thanks'),
      ])
    );

    expect(items).toEqual([
      { kind: 'user', text: 'use pnpm here' },
      { kind: 'reply', text: 'And updated CI.' },
      { kind: 'user', text: 'thanks' },
    ]);
  });

  test('should treat an assistant message without a phase as a reply', () => {
    const { items } = condenseCodex(
      jsonl([
        message('assistant', [{ type: 'output_text', text: 'plain reply' }]),
      ])
    );

    expect(items).toEqual([{ kind: 'reply', text: 'plain reply' }]);
  });

  test('should leave out injected context, using the content kinds', () => {
    const { items } = condenseCodex(
      jsonl([
        message(
          'user',
          [
            { type: 'input_text', text: '# AGENTS.md instructions for /w' },
            { type: 'input_text', text: 'env' },
            { type: 'input_text', text: 'hook says do x' },
            { type: 'input_text', text: 'typed' },
          ],
          {
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: [
                'agents_md.instructions',
                'environments.environment_context',
                'hook.additional_context',
                'user.text',
              ],
            },
          }
        ),
      ])
    );

    expect(items).toEqual([{ kind: 'user', text: 'typed' }]);
  });

  test('should fall back to text markers when there are no content kinds', () => {
    const plain = (/** @type {string} */ text) =>
      message('user', [{ type: 'input_text', text }]);
    const { items } = condenseCodex(
      jsonl([
        plain('# AGENTS.md instructions for /work\n\n<INSTRUCTIONS>x'),
        plain('<environment_context>\n<cwd>/w</cwd>\n</environment_context>'),
        plain('<user_instructions>x</user_instructions>'),
        plain('<subagent_notification>{}</subagent_notification>'),
        plain('<turn_aborted>x</turn_aborted>'),
        plain('<task-notification>done</task-notification>'),
        plain('[Request interrupted by user]'),
        plain('<system-reminder>r</system-reminder>'),
        plain('<system-reminder>r</system-reminder>\nreal prompt'),
        plain('<div> why is this broken?'),
      ])
    );

    expect(items).toEqual([
      { kind: 'user', text: 'real prompt' },
      { kind: 'user', text: '<div> why is this broken?' },
    ]);
  });

  test('should ignore a kinds list that does not match the content', () => {
    const { items } = condenseCodex(
      jsonl([user('typed text', ['user.text', 'user.image'])])
    );

    expect(items).toEqual([{ kind: 'user', text: 'typed text' }]);
  });

  test('should skip developer messages, non-text blocks, and empty text', () => {
    const { items } = condenseCodex(
      jsonl([
        message('developer', [{ type: 'input_text', text: 'rules' }]),
        message('user', [
          { type: 'input_image', image_url: 'x' },
          { type: 'input_text', text: '  ' },
        ]),
        message('user', 'not an array'),
        message('assistant', 'not an array'),
        line('response_item', { type: 'local_shell_call', call_id: 'x' }),
        message('assistant', [{ type: 'output_text', text: '' }]),
      ])
    );

    expect(items).toEqual([]);
  });

  test('should report a failed command with its error output', () => {
    const { items } = condenseCodex(
      jsonl([
        user('install'),
        call('c1', { cmd: 'npm install' }),
        result('c1', unified(1, 'npm ERR! boom\n')),
      ])
    );

    expect(items[1]).toEqual({
      kind: 'failure',
      command: 'npm install',
      error: 'npm ERR! boom',
    });
  });

  test('should read the shell tool output formats and command forms', () => {
    const { items } = condenseCodex(
      jsonl([
        call('a', { command: ['bash', '-lc', 'false'] }, 'shell'),
        result('a', 'Exit code: 2\nWall time: 0.1 seconds\nOutput:\nnope'),
        call('b', { command: 'ls /missing' }, 'shell_command'),
        result('b', 'Exit code: 1\nWall time: 0 seconds\nOutput:\nls: no'),
        line('response_item', {
          type: 'local_shell_call',
          call_id: 'c',
          action: { type: 'exec', command: ['cat', 'x'] },
        }),
        result(
          'c',
          JSON.stringify({ output: 'cat: x', metadata: { exit_code: 1 } })
        ),
      ])
    );

    expect(items).toEqual([
      { kind: 'failure', command: 'bash -lc false', error: 'nope' },
      { kind: 'failure', command: 'ls /missing', error: 'ls: no' },
      { kind: 'failure', command: 'cat x', error: 'cat: x' },
    ]);
  });

  test('should read output given as content items', () => {
    const { items } = condenseCodex(
      jsonl([
        call('a', { cmd: 'false' }),
        result('a', [
          { type: 'input_image', image_url: 'x' },
          { type: 'input_text', text: unified(3, 'bad') },
        ]),
      ])
    );

    expect(items).toEqual([
      { kind: 'failure', command: 'false', error: 'bad' },
    ]);
  });

  test('should report no failure for success, running, or unknown calls', () => {
    const { items, dropped } = condenseCodex(
      jsonl([
        call('ok', { cmd: 'true' }),
        result('ok', unified(0, 'fine')),
        call('run', { cmd: 'sleep 99' }),
        result('run', 'Chunk ID: a\nProcess running\nOutput:\n'),
        call('other', { path: 'x' }, 'view_image'),
        result('other', unified(1, 'x')),
        result('unknown', unified(1, 'x')),
        {
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'z',
            name: 'exec_command',
            arguments: '{oops',
          },
        },
        result('z', unified(1, 'x')),
        call('nul', null),
        result('nul', unified(1, 'x')),
        call('empty', {}),
        result('empty', unified(1, 'x')),
        call('empty2', { cmd: 'x' }),
        result('empty2', 42),
        result('empty2', JSON.stringify({ metadata: {} })),
        result('empty2', '{"broken'),
        result('empty2', '{"metadata":null}'),
        result('empty2', '[1]'),
      ])
    );

    expect(items).toEqual([]);
    expect(dropped).toBe(0);
  });

  test('should use an empty error when the output has no text', () => {
    const { items } = condenseCodex(
      jsonl([
        call('a', { cmd: 'false' }),
        result('a', 'Process exited with code 1'),
      ])
    );

    expect(items).toEqual([{ kind: 'failure', command: 'false', error: '' }]);
  });

  test('should drop a failed command that holds a secret and redact errors', () => {
    const { items, dropped } = condenseCodex(
      jsonl([
        call('a', { cmd: `curl -H "Authorization: ${TOKEN}" x` }),
        result('a', unified(1, 'denied')),
        call('b', { cmd: 'gh auth status' }),
        result('b', unified(1, `token ${TOKEN} is invalid`)),
      ])
    );

    expect(dropped).toBe(1);
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
    expect(JSON.stringify(items)).toContain(REDACTED);
  });

  test('should redact secrets in prompts and replies', () => {
    const { items } = condenseCodex(
      jsonl([user(`key ${TOKEN}`), agent(`saw ${TOKEN}`)])
    );

    expect(JSON.stringify(items)).not.toContain(TOKEN);
  });

  test('should cut long items to the character limits', () => {
    const { items } = condenseCodex(
      jsonl([
        user('u'.repeat(5000)),
        call('a', { cmd: 'c'.repeat(1000) }),
        result('a', unified(1, 'e'.repeat(2000))),
        agent('r'.repeat(5000)),
      ])
    );

    expect(/** @type {any} */ (items[0]).text).toHaveLength(ITEM_CHARS.user);
    expect(/** @type {any} */ (items[1]).command).toHaveLength(
      ITEM_CHARS.command
    );
    expect(/** @type {any} */ (items[1]).error).toHaveLength(ITEM_CHARS.error);
    expect(/** @type {any} */ (items[2]).text).toHaveLength(ITEM_CHARS.reply);
  });

  test('should take the model and folder from the turn context', () => {
    const condensed = condenseCodex(
      jsonl([
        line('session_meta', { cwd: '/work/a' }),
        line('turn_context', { model: 'gpt-5.5', cwd: '/work/b' }),
        line('turn_context', { model: 'gpt-5.6' }),
        line('turn_context', { model: 7, cwd: 3 }),
      ])
    );

    expect(condensed).toEqual({
      items: [],
      model: 'gpt-5.6',
      cwd: '/work/b',
      dropped: 0,
    });
  });

  test('should take the folder from session_meta when no turn gives one', () => {
    const condensed = condenseCodex(
      jsonl([line('session_meta', { cwd: '/work/a' })])
    );

    expect(condensed.cwd).toBe('/work/a');
  });

  test('should skip bad lines and other line types', () => {
    const { items } = condenseCodex(
      [
        'not json',
        '42',
        '{"type":"response_item"}',
        JSON.stringify(line('event_msg', { type: 'token_count' })),
        JSON.stringify(line('response_item', { type: 'reasoning' })),
        JSON.stringify(user('kept')),
      ].join('\n')
    );

    expect(items).toEqual([{ kind: 'user', text: 'kept' }]);
  });

  test('should be the Codex transcript adapter', () => {
    expect(TRANSCRIPT_ADAPTERS.codex).toBe(condenseCodex);
  });
});

describe('formatSession', () => {
  test('should label each item', () => {
    const { text, omitted } = formatSession([
      { kind: 'user', text: 'use pnpm' },
      { kind: 'failure', command: 'npm i', error: 'Exit code 1' },
      { kind: 'reply', text: 'Switched.' },
    ]);

    expect(text).toBe(
      '[user] use pnpm\n\n[failed command] $ npm i\nExit code 1\n\n[assistant] Switched.'
    );
    expect(omitted).toBe(0);
  });

  test('should drop the oldest items over the budget and say so', () => {
    const items = [
      { kind: 'user', text: 'first message' },
      { kind: 'user', text: 'second message' },
      { kind: 'user', text: 'third message' },
    ];

    const { text, omitted } = formatSession(
      /** @type {any} */ (items),
      '[user] third message'.length + '[user] second message'.length + 2
    );

    expect(omitted).toBe(1);
    expect(text).toBe(
      '(1 earlier item omitted)\n\n[user] second message\n\n[user] third message'
    );
  });

  test('should use the session budget by default', () => {
    const items = Array.from({ length: 40 }, () => ({
      kind: /** @type {const} */ ('user'),
      text: 'x'.repeat(1000),
    }));

    const { text, omitted } = formatSession(items);

    expect(omitted).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(SESSION_BUDGET + 40);
  });
});

describe('isTrivial', () => {
  test('should call a session without user messages trivial', () => {
    expect(isTrivial([{ kind: 'reply', text: 'x'.repeat(500) }])).toBe(true);
  });

  test('should call a very short session trivial', () => {
    expect(isTrivial([{ kind: 'user', text: 'hi' }])).toBe(true);
  });

  test('should not call a session with enough content trivial', () => {
    expect(
      isTrivial([
        { kind: 'user', text: 'use pnpm' },
        { kind: 'reply', text: 'r'.repeat(MIN_SESSION_CHARS) },
      ])
    ).toBe(false);
  });

  test('should count failed commands', () => {
    expect(
      isTrivial([
        { kind: 'user', text: 'go' },
        { kind: 'failure', command: 'c', error: 'e'.repeat(MIN_SESSION_CHARS) },
      ])
    ).toBe(false);
  });
});

describe('readNewLines', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-transcript-'));
    file = path.join(dir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('should return null when the transcript is missing', () => {
    expect(readNewLines(file, 0)).toBeNull();
  });

  test('should read complete lines from the offset', () => {
    fs.writeFileSync(file, 'one\ntwo\nthr');

    expect(readNewLines(file, 4)).toEqual({ text: 'two\n', start: 4, end: 8 });
  });

  test('should read nothing new when no line is complete', () => {
    fs.writeFileSync(file, 'one\ntw');

    expect(readNewLines(file, 4)).toEqual({ text: '', start: 4, end: 4 });
  });

  test('should start over when the transcript is shorter than the offset', () => {
    fs.writeFileSync(file, 'new\n');

    expect(readNewLines(file, 100)).toEqual({
      text: 'new\n',
      start: 0,
      end: 4,
    });
  });

  test('should count bytes, not characters', () => {
    fs.writeFileSync(file, 'マージ\nnext\n');
    const first = Buffer.byteLength('マージ\n');

    expect(readNewLines(file, 0)?.end).toBe(first + 5);
    expect(readNewLines(file, first)).toEqual({
      text: 'next\n',
      start: first,
      end: first + 5,
    });
  });
});
