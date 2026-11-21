/**
 * Tests for utils/memory/hook.js (recall hooks for Claude Code and Codex)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { createState } from '../../task/state.js';
import { saveState, tasksRoot, writeActive } from '../../task/store.js';
import { DEFAULT_CONFIG, writeConfig } from '../config.js';
import {
  ERROR_CHARS,
  PERSONA_REMINDER,
  REMINDER_LANGUAGE_CHARS,
  SESSION_MAX_AGE_MS,
  failureText,
  handleHook,
  parseHarness,
  readInjected,
  runHook,
  sessionFile,
} from '../hook.js';
import {
  EXTRACT_ENV,
  IDLE_MS,
  appendJournal,
  readOpen,
  readQueue,
  registerOpen,
  tryLock,
} from '../queue.js';
import { PERSONALIZATION_FILE, writePersonalization } from '../personalize.js';
import { RECALL_HEADER } from '../recall.js';
import { AGENTS_LOCAL_FILE, CLAUDE_LOCAL_FILE, CORE_START } from '../render.js';
import {
  CACHE_DIR,
  LOG_FILE,
  USAGE_FILE,
  addNote,
  memoryDir,
} from '../store.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;

const NOW = new Date('2026-11-20T12:00:00.000Z');
const SESSION = 'sess-1';

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hook-'))
  );
  dir = memoryDir(root);
  seed();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A small store: two notes recall can tell apart, a trigger, fillers. */
function seed() {
  const add = (/** @type {any} */ input) =>
    addNote(dir, { scope: 'machine', type: 'howto', ...input }, { now: NOW });
  add({
    text: 'The company proxy blocks GitHub GraphQL; merge by fast-forwarding main and git push.',
    tags: ['github', 'graphql', 'proxy', 'merge', 'pull request'],
    triggers: ['gh pr'],
  });
  add({
    text: 'pnpm install fails with ERR_PNPM_NO_MATURE_MATCHING_VERSION for versions under 7 days old.',
    tags: ['pnpm', 'install', 'minimumReleaseAge'],
  });
  for (const word of ['tea', 'bikes', 'plants', 'chess', 'jazz', 'hiking']) {
    add({
      scope: 'user',
      type: 'preference',
      text: `Likes ${word} on weekends.`,
      tags: [word],
    });
  }
}

/** The detached worker start, replaced so tests never spawn it. */
const kick = vi.fn();

beforeEach(() => {
  kick.mockClear();
});

/**
 * @param {Record<string, unknown>} input
 * @param {{ harness?: 'claude' | 'codex' | 'dsh', env?: NodeJS.ProcessEnv }} [options]
 */
const hook = (input, { harness = 'claude', env = {} } = {}) =>
  handleHook(
    { session_id: SESSION, cwd: root, ...input },
    { harness, rootDir: root, now: NOW, env, kick }
  );

/** @param {ReturnType<typeof hook>} output */
const context = (output) => output?.hookSpecificOutput.additionalContext ?? '';

const prompt = (/** @type {string} */ text) =>
  hook({ hook_event_name: 'UserPromptSubmit', prompt: text });

describe('parseHarness', () => {
  test('should read --harness', () => {
    expect(parseHarness(['--harness', 'codex'])).toBe('codex');
  });

  test('should default to claude for no or unknown values', () => {
    expect(parseHarness([])).toBe('claude');
    expect(parseHarness(['--harness', 'vim'])).toBe('claude');
  });
});

describe('handleHook', () => {
  test('should ignore input without a known event', () => {
    expect(hook({})).toBeNull();
    expect(hook({ hook_event_name: 'Stop' })).toBeNull();
  });

  test('should stay silent before memory is set up', () => {
    fs.rmSync(dir, { recursive: true });

    expect(prompt('how do I merge this PR')).toBeNull();
  });

  test.each(['reviewer', 'verifier'])('should skip the %s role', (agent) => {
    expect(
      hook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'merge this PR',
        agent_type: agent,
      })
    ).toBeNull();
  });
});

describe('UserPromptSubmit', () => {
  test('should inject the notes that match the prompt', () => {
    const output = prompt('how do I merge this PR on github');

    expect(output?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(context(output).split('\n')).toEqual([
      RECALL_HEADER,
      '- m1 (machine, howto, 2026-11-20) The company proxy blocks GitHub GraphQL; merge by fast-forwarding main and git push.',
      expect.stringMatching(/^More: pnpm memory recall/),
    ]);
  });

  test('should count the injection and not repeat it in the session', () => {
    prompt('how do I merge this PR on github');

    expect(prompt('merge the PR on github again')).toBeNull();
    expect(readInjected(dir, SESSION)).toEqual(new Set(['m1']));
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dir, CACHE_DIR, USAGE_FILE), 'utf-8')
      ).m1.hits
    ).toBe(1);
  });

  test('should inject again in another session', () => {
    prompt('how do I merge this PR on github');

    expect(
      hook({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'merge this PR on github',
        session_id: 'sess-2',
      })
    ).not.toBeNull();
  });

  test('should recall without a session, and keep no session file', () => {
    const output = hook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'merge this PR on github',
      session_id: 'bad id!',
    });

    expect(context(output)).toMatch(/- m1 /);
    expect(fs.existsSync(path.join(dir, CACHE_DIR, 'sessions'))).toBe(false);
  });

  test('should stay silent on unrelated prompts', () => {
    expect(prompt('what a lovely morning')).toBeNull();
  });

  test.each(['', '   ', '/clear'])('should skip the prompt %j', (text) => {
    expect(prompt(text)).toBeNull();
  });

  test('should skip background task notifications', () => {
    expect(
      prompt('<task-notification>merge this PR on github</task-notification>')
    ).toBeNull();
  });

  test('should skip a prompt that is not text', () => {
    expect(
      hook({ hook_event_name: 'UserPromptSubmit', prompt: 42 })
    ).toBeNull();
  });

  test('should search with the current task goal too', () => {
    const taskDir = path.join(tasksRoot(root), 'deps-261120');
    fs.mkdirSync(taskDir, { recursive: true });
    saveState(
      taskDir,
      createState({
        name: 'deps-261120',
        goal: 'Fix pnpm install for new packages',
        now: NOW,
      })
    );
    writeActive(root, 'deps-261120');

    expect(context(prompt('keep going'))).toMatch(/- m2 /);
  });
});

describe('persona reminder', () => {
  test('should remind of the persona at a prompt that recalls nothing', () => {
    writePersonalization(dir, { persona: 'A calm senior engineer.' });

    expect(context(prompt('what a lovely morning'))).toBe(PERSONA_REMINDER);
  });

  test('should name the language when one is set', () => {
    writePersonalization(dir, { persona: 'お嬢様', language: '日本語' });

    expect(context(prompt('what a lovely morning'))).toBe(
      `${PERSONA_REMINDER} Language: 日本語`
    );
  });

  test('should keep a long language on one line and clip it', () => {
    writePersonalization(dir, {
      language: `Japanese\nalways ${'x'.repeat(REMINDER_LANGUAGE_CHARS)}`,
    });

    const language = context(prompt('what a lovely morning')).split(
      'Language: '
    )[1];

    expect(language).toBe(
      `Japanese always ${'x'.repeat(REMINDER_LANGUAGE_CHARS - 16)}…`
    );
  });

  test('should come before the recalled notes', () => {
    writePersonalization(dir, { persona: 'A calm senior engineer.' });

    const parts = context(prompt('how do I merge this PR on github')).split(
      '\n\n'
    );

    expect(parts[0]).toBe(PERSONA_REMINDER);
    expect(parts[1].split('\n')[0]).toBe(RECALL_HEADER);
  });

  test('should repeat at every prompt of a session', () => {
    writePersonalization(dir, { persona: 'A calm senior engineer.' });
    prompt('what a lovely morning');

    expect(context(prompt('what a lovely evening'))).toBe(PERSONA_REMINDER);
  });

  test.each(['/clear', '<task-notification>done</task-notification>'])(
    'should not remind at %j',
    (text) => {
      writePersonalization(dir, { persona: 'A calm senior engineer.' });

      expect(prompt(text)).toBeNull();
    }
  );

  test.each(['reviewer', 'verifier'])(
    'should not remind the %s role',
    (agent) => {
      writePersonalization(dir, { persona: 'A calm senior engineer.' });

      expect(
        hook({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'what a lovely morning',
          agent_type: agent,
        })
      ).toBeNull();
    }
  );

  test('should still recall when the settings file is broken', () => {
    fs.writeFileSync(path.join(dir, PERSONALIZATION_FILE), '{nope');

    expect(prompt('what a lovely morning')).toBeNull();
    expect(
      context(prompt('how do I merge this PR on github')).split('\n')[0]
    ).toBe(RECALL_HEADER);
  });
});

describe('PreToolUse', () => {
  const pre = (/** @type {unknown} */ command) =>
    hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    });

  test('should inject notes whose trigger is in the command', () => {
    const output = pre('gh pr create --fill');

    expect(output?.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(context(output)).toMatch(/- m1 /);
  });

  test('should read a command given as an argument list', () => {
    expect(context(pre(['gh', 'pr', 'view']))).toMatch(/- m1 /);
  });

  test('should not repeat a note already injected', () => {
    pre('gh pr create');

    expect(pre('gh pr view')).toBeNull();
  });

  test('should stay silent without a matching trigger or command', () => {
    expect(pre('ls -la')).toBeNull();
    expect(pre(undefined)).toBeNull();
  });
});

describe('failures', () => {
  test('should recall from a Claude PostToolUseFailure error', () => {
    const output = hook({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm install' },
      error:
        'Exit code 1\nERR_PNPM_NO_MATURE_MATCHING_VERSION  No matching version',
    });

    expect(output?.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(context(output)).toMatch(/- m2 /);
  });

  test('should recall from a Codex PostToolUse with a non-zero exit', () => {
    const output = hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: ['pnpm', 'install'] },
        tool_response:
          'Exit code: 1\nWall time: 2 seconds\nOutput:\nERR_PNPM_NO_MATURE_MATCHING_VERSION',
      },
      { harness: 'codex' }
    );

    expect(context(output)).toMatch(/- m2 /);
  });

  test('should stay silent after a command that worked', () => {
    expect(
      hook({
        hook_event_name: 'PostToolUse',
        tool_input: { command: 'pnpm install' },
        tool_response:
          'Exit code: 0\nOutput:\nERR_PNPM_NO_MATURE_MATCHING_VERSION was fixed',
      })
    ).toBeNull();
  });

  test('should stay silent on a failure with nothing to search', () => {
    expect(
      hook({ hook_event_name: 'PostToolUseFailure', tool_input: {} })
    ).toBeNull();
  });
});

describe('failureText', () => {
  test('should take the error of a failure event', () => {
    expect(
      failureText({ hook_event_name: 'PostToolUseFailure', error: 'boom' })
    ).toBe('boom');
  });

  test('should treat a failure event without an error as empty', () => {
    expect(failureText({ hook_event_name: 'PostToolUseFailure' })).toBe('');
  });

  test('should read an exit code field and the output fields', () => {
    expect(
      failureText({
        hook_event_name: 'PostToolUse',
        tool_response: {
          exit_code: 2,
          stderr: 'bad',
          stdout: 'half',
          output: 7,
        },
      })
    ).toBe('bad\nhalf');
  });

  test('should read exitCode', () => {
    expect(
      failureText({
        hook_event_name: 'PostToolUse',
        tool_response: { exitCode: 0, stderr: 'warn' },
      })
    ).toBeNull();
  });

  test('should find the exit code in object output text', () => {
    expect(
      failureText({
        hook_event_name: 'PostToolUse',
        tool_response: { output: 'Exit code: 127\nnot found' },
      })
    ).toBe('Exit code: 127\nnot found');
  });

  test('should not guess a failure without an exit code', () => {
    expect(
      failureText({
        hook_event_name: 'PostToolUse',
        tool_response: { stdout: 'all fine', interrupted: false },
      })
    ).toBeNull();
    expect(failureText({ hook_event_name: 'PostToolUse' })).toBeNull();
  });

  test('should cut long output', () => {
    const text = failureText({
      hook_event_name: 'PostToolUseFailure',
      error: 'x'.repeat(5000),
    });

    expect(text).toHaveLength(ERROR_CHARS);
  });
});

describe('SessionStart', () => {
  const start = (
    /** @type {string} */ source,
    harness = /** @type {'claude' | 'codex' | 'dsh'} */ ('claude')
  ) => hook({ hook_event_name: 'SessionStart', source }, { harness });

  test('should stay silent in Claude Code when CLAUDE.local.md loads the core block', () => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');

    expect(start('startup')).toBeNull();
  });

  test('should inject the core block when Claude Code does not load it', () => {
    const output = start('startup');

    expect(output?.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(context(output)).toMatch(new RegExp(`^${CORE_START}`));
  });

  test('should always inject the core block for Codex', () => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');

    expect(context(start('startup', 'codex'))).toMatch(/## Memory/);
  });

  test('should stay silent in DSH, which loads AGENTS.local.md itself', () => {
    fs.writeFileSync(path.join(root, AGENTS_LOCAL_FILE), '# AGENTS.local.md\n');

    expect(start('startup', 'dsh')).toBeNull();
  });

  test('should inject the core block in DSH when AGENTS.local.md is missing', () => {
    expect(context(start('startup', 'dsh'))).toMatch(
      new RegExp(`^${CORE_START}`)
    );
  });

  test('should say when saving is off', () => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');
    writeConfig(dir, { ...DEFAULT_CONFIG, offSessions: [SESSION] });

    expect(context(start('startup'))).toBe(
      '[Memory] Saving to memory is off for this session: do not save notes (pnpm memory add) unless the user asks; recall still works.'
    );
  });

  test('should say when saving is off everywhere', () => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');
    writeConfig(dir, { ...DEFAULT_CONFIG, off: true });

    expect(context(start('startup'))).toMatch(
      /^\[Memory\] Saving to memory is off everywhere:/
    );
  });

  test.each(['clear', 'compact'])(
    'should forget what was injected on %s',
    (source) => {
      prompt('how do I merge this PR on github');

      start(source);

      expect(readInjected(dir, SESSION)).toEqual(new Set());
    }
  );

  test('should start a session without an id', () => {
    const output = hook({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: null,
    });

    expect(context(output)).toMatch(/## Memory/);
    expect(fs.existsSync(path.join(dir, CACHE_DIR, 'sessions'))).toBe(false);
  });

  test('should keep what was injected on resume', () => {
    prompt('how do I merge this PR on github');

    start('resume');

    expect(readInjected(dir, SESSION)).toEqual(new Set(['m1']));
  });

  test('should prune the records of old sessions', () => {
    prompt('how do I merge this PR on github');
    const old = sessionFile(dir, SESSION);
    const past = new Date(NOW.getTime() - SESSION_MAX_AGE_MS - 1000);
    fs.utimesSync(old, past, past);

    hook({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-2',
    });

    expect(fs.existsSync(old)).toBe(false);
  });
});

describe('extraction hooks', () => {
  /** @type {string} */
  let transcript;

  beforeEach(() => {
    fs.writeFileSync(path.join(root, CLAUDE_LOCAL_FILE), '@AGENTS.local.md\n');
    transcript = path.join(root, `${SESSION}.jsonl`);
    fs.writeFileSync(transcript, '{}\n');
  });

  /** @param {string} event @param {object} [extra] @param {any} [options] */
  const lifecycle = (event, extra = {}, options = {}) =>
    hook(
      {
        hook_event_name: event,
        source: 'startup',
        transcript_path: transcript,
        ...extra,
      },
      options
    );

  test('should register a starting Claude session as open', () => {
    lifecycle('SessionStart');

    expect(readOpen(dir)).toEqual([
      expect.objectContaining({
        session: SESSION,
        harness: 'claude',
        transcript,
        cwd: root,
      }),
    ]);
    expect(kick).not.toHaveBeenCalled();
  });

  test('should register and queue a Codex session with its rollout', () => {
    lifecycle('SessionStart', {}, { harness: 'codex' });

    expect(readOpen(dir)).toEqual([
      expect.objectContaining({ harness: 'codex', transcript }),
    ]);

    lifecycle('SessionEnd', { reason: 'other' }, { harness: 'codex' });

    expect(readQueue(dir)).toEqual([
      expect.objectContaining({
        session: SESSION,
        harness: 'codex',
        transcript,
      }),
    ]);
    expect(kick).toHaveBeenCalled();
  });

  test('should queue an ended session and start the worker, silently', () => {
    lifecycle('SessionStart');

    const output = lifecycle('SessionEnd', { reason: 'prompt_input_exit' });

    expect(output).toBeNull();
    expect(readOpen(dir)).toEqual([]);
    expect(readQueue(dir)).toEqual([
      expect.objectContaining({ session: SESSION }),
    ]);
    expect(kick).toHaveBeenCalledWith({ rootDir: root, env: {} });
  });

  test('should not start a second worker while one runs', () => {
    const lock = tryLock(dir);

    lifecycle('SessionEnd');

    expect(readQueue(dir)).toHaveLength(1);
    expect(kick).not.toHaveBeenCalled();
    lock?.release();
  });

  test('should not queue a session that left no transcript', () => {
    // Headless runs (pnpm agent ask, pnpm loop) use --no-session-persistence.
    lifecycle('SessionEnd', { transcript_path: path.join(root, 'none.jsonl') });

    expect(readQueue(dir)).toEqual([]);
    expect(kick).not.toHaveBeenCalled();
  });

  test('should ignore a SessionEnd without a usable transcript', () => {
    lifecycle('SessionEnd', { transcript_path: 'relative.jsonl' });

    expect(readQueue(dir)).toEqual([]);
    expect(kick).not.toHaveBeenCalled();
  });

  test('should catch up on a session that ended without SessionEnd', () => {
    const crashed = path.join(root, 'crashed.jsonl');
    fs.writeFileSync(crashed, '{}\n');
    const idle = new Date(NOW.getTime() - IDLE_MS - 1000);
    fs.utimesSync(crashed, idle, idle);
    registerOpen(dir, {
      session: 'crashed',
      harness: 'claude',
      transcript: crashed,
      cwd: root,
      at: idle.toISOString(),
    });

    lifecycle('SessionStart');

    expect(readQueue(dir).map((entry) => entry.session)).toEqual(['crashed']);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  test('should start the worker when consolidation is due', () => {
    for (let i = 0; i < 20; i++) {
      addNote(
        dir,
        {
          scope: 'machine',
          type: 'fact',
          text: `Filler fact ${i} about builds.`,
          tags: [`f${i}`],
        },
        { now: NOW }
      );
    }

    lifecycle('SessionStart');

    expect(readQueue(dir)).toEqual([]);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  test('should announce what extraction saved, to the agent and the user', () => {
    appendJournal(dir, {
      at: '2026-11-20T11:00:00.000Z',
      status: 'applied',
      changes: [
        {
          action: 'added',
          id: 'm9',
          scope: 'user',
          repo: null,
          type: 'preference',
          text: 'The user wants pnpm.',
        },
      ],
    });

    const output = /** @type {any} */ (lifecycle('SessionStart'));

    expect(context(output)).toMatch(
      /^\[Memory\] Saved by automatic extraction/
    );
    expect(context(output)).toContain(
      '- Saved to memory: m9 (user, preference) The user wants pnpm.'
    );
    expect(output.systemMessage).toBe(context(output));
    expect(lifecycle('SessionStart')).toBeNull();
  });

  test('should ask Codex to pass the announcement on', () => {
    appendJournal(dir, {
      at: '2026-11-20T11:00:00.000Z',
      status: 'applied',
      changes: [
        {
          action: 'added',
          id: 'm9',
          scope: 'user',
          repo: null,
          type: 'preference',
          text: 'The user wants pnpm.',
        },
      ],
    });

    const output = /** @type {any} */ (
      lifecycle('SessionStart', {}, { harness: 'codex' })
    );

    expect(context(output)).toMatch(
      /Mention these saves to the user in one line\.$/
    );
    expect(output.systemMessage).toBeUndefined();
  });

  test('should stay silent for the extraction agent itself', () => {
    const env = { [EXTRACT_ENV]: '1' };

    expect(lifecycle('SessionStart', {}, { env })).toBeNull();
    expect(lifecycle('SessionEnd', {}, { env })).toBeNull();
    expect(
      hook(
        {
          hook_event_name: 'UserPromptSubmit',
          prompt: 'merge this PR on github',
        },
        { env }
      )
    ).toBeNull();
    expect(readOpen(dir)).toEqual([]);
    expect(readQueue(dir)).toEqual([]);
  });
});

describe('readInjected', () => {
  test('should be empty for a missing or broken record', () => {
    expect(readInjected(dir, SESSION)).toEqual(new Set());
    fs.mkdirSync(path.dirname(sessionFile(dir, SESSION)), { recursive: true });
    fs.writeFileSync(sessionFile(dir, SESSION), '{"injected": 3}');

    expect(readInjected(dir, SESSION)).toEqual(new Set());
  });
});

describe('runHook', () => {
  test('should print the output as JSON', () => {
    const out = runHook(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'merge this PR on github',
        session_id: SESSION,
      }),
      { rootDir: root, now: NOW }
    );

    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toMatch(
      /- m1 /
    );
  });

  test('should print nothing when there is nothing to inject', () => {
    expect(runHook('', { rootDir: root })).toBe('');
  });

  test('should fail open on bad input', () => {
    expect(runHook('{not json', { rootDir: root })).toBe('');
  });

  test('should fail open when the store cannot be read', () => {
    fs.rmSync(path.join(dir, CACHE_DIR), { recursive: true, force: true });
    fs.rmSync(path.join(dir, LOG_FILE));
    fs.mkdirSync(path.join(dir, LOG_FILE));

    expect(
      runHook(
        JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'merge PR',
        }),
        {
          rootDir: root,
        }
      )
    ).toBe('');
  });
});

test('a warm recall on 1,000 notes should take well under 100 ms', () => {
  const ops = [];
  for (let i = 0; i < 1000; i++) {
    ops.push(
      JSON.stringify({
        op: 'add',
        at: NOW.toISOString(),
        note: {
          id: `m${i + 100}`,
          text: `Note ${i} about topic${i % 50} and tool${i % 37} with detail${i}.`,
          scope: 'machine',
          type: 'fact',
          tags: [`topic${i % 50}`, `tool${i % 37}`],
        },
      })
    );
  }
  fs.appendFileSync(path.join(dir, LOG_FILE), `${ops.join('\n')}\n`);
  prompt('topic7 with tool3 please');

  const started = performance.now();
  hook({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'topic9 and tool5 detail',
    session_id: 'sess-9',
  });
  const elapsed = performance.now() - started;

  expect(elapsed).toBeLessThan(100);
});
