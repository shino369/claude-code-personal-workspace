/**
 * Tests for context_monitor.js
 */
import fs from 'fs';
import { vi } from 'vitest';
import os from 'os';
import path from 'path';
import { writeSession } from '#utils/task/store.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  THRESHOLDS,
  getContextWindow,
  formatWindow,
  getUsageFromTranscript,
  buildMessage,
  getActiveTask,
  processHookInput,
  saveInstruction,
} from '../context_monitor.js';

/** @param {unknown[]} entries */
function writeTranscript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'context-monitor-'));
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join('\n'),
    'utf-8'
  );
  return { dir, file };
}

describe('context_monitor', () => {
  /** @type {string[]} */
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(/** @type {string} */ (tempDirs.pop()), {
        recursive: true,
        force: true,
      });
    }
  });

  /** @param {unknown[]} entries */
  function transcript(entries) {
    const result = writeTranscript(entries);
    tempDirs.push(result.dir);
    return result.file;
  }

  describe('getContextWindow', () => {
    test('returns the default when unset', () => {
      expect(getContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    });

    test('returns the configured value', () => {
      expect(getContextWindow({ CLAUDE_CONTEXT_WINDOW: '200000' })).toBe(
        200000
      );
    });

    test.each(['', 'not-a-number', '0', '-5'])(
      'falls back to the default for invalid value %p',
      (value) => {
        expect(getContextWindow({ CLAUDE_CONTEXT_WINDOW: value })).toBe(
          DEFAULT_CONTEXT_WINDOW
        );
      }
    );
  });

  describe('formatWindow', () => {
    test('formats millions', () => {
      expect(formatWindow(1_000_000)).toBe('1M');
      expect(formatWindow(1_500_000)).toBe('1.5M');
    });

    test('formats thousands', () => {
      expect(formatWindow(200_000)).toBe('200K');
    });

    test('formats small windows as-is', () => {
      expect(formatWindow(500)).toBe('500');
    });
  });

  describe('getUsageFromTranscript', () => {
    test('returns null without a path', () => {
      expect(getUsageFromTranscript(undefined)).toBeNull();
    });

    test('returns null when the file does not exist', () => {
      expect(getUsageFromTranscript('does-not-exist.jsonl')).toBeNull();
    });

    test('sums cached and fresh input tokens from the newest assistant entry', () => {
      const file = transcript([
        { type: 'user', message: { content: 'hi' } },
        { type: 'assistant', message: { usage: { input_tokens: 999_999 } } },
        {
          type: 'assistant',
          message: {
            usage: {
              cache_read_input_tokens: 300,
              cache_creation_input_tokens: 40,
              input_tokens: 60,
            },
          },
        },
      ]);

      expect(getUsageFromTranscript(file)).toEqual({ inputTokens: 400 });
    });

    test('treats missing usage fields as zero', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { input_tokens: 25 } },
        },
      ]);

      expect(getUsageFromTranscript(file)).toEqual({ inputTokens: 25 });
    });

    test('treats missing input_tokens as zero', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { cache_read_input_tokens: 10 } },
        },
      ]);

      expect(getUsageFromTranscript(file)).toEqual({ inputTokens: 10 });
    });

    test('skips malformed lines and entries without usage', () => {
      const file = transcript([
        { type: 'assistant', message: { usage: { input_tokens: 10 } } },
        { type: 'user', message: { content: 'no usage here' } },
      ]);
      fs.appendFileSync(file, '\n{"type":"assistant","message":');

      expect(getUsageFromTranscript(file)).toEqual({ inputTokens: 10 });
    });

    test('returns null when no assistant usage entry exists', () => {
      const file = transcript([{ type: 'user', message: { content: 'hi' } }]);

      expect(getUsageFromTranscript(file)).toBeNull();
    });

    test('returns null when reading throws', () => {
      const file = transcript([
        { type: 'assistant', message: { usage: { input_tokens: 10 } } },
      ]);
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('read failed');
      });

      try {
        expect(getUsageFromTranscript(file)).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('buildMessage', () => {
    test('is silent below the note threshold', () => {
      expect(buildMessage(0.19)).toBeNull();
    });

    test('notes at the note threshold', () => {
      expect(buildMessage(THRESHOLDS.note)).toContain('[Context Monitor]');
      expect(buildMessage(THRESHOLDS.note)).toContain('20.0%');
    });

    test('warns at the warning threshold', () => {
      const message = buildMessage(THRESHOLDS.warn);
      expect(message).toContain('[Context Monitor][WARNING]');
      expect(message).toContain('40.0%');
      expect(message).toContain('tasks/');
    });

    test('is urgent at the urgent threshold', () => {
      const message = buildMessage(THRESHOLDS.urgent);
      expect(message).toContain('[Context Monitor][URGENT]');
      expect(message).toContain('60.0%');
      expect(message).toContain('/compact');
    });

    test('uses the configured window label', () => {
      expect(buildMessage(0.5, 200_000)).toContain('200K');
    });

    test('should name the active task in the warning', () => {
      const message = buildMessage(THRESHOLDS.warn, undefined, 'demo-261117');

      expect(message).toContain('tasks/demo-261117/NOTES.md');
      expect(message).toContain('pnpm task note');
    });
  });

  describe('saveInstruction', () => {
    test('should point at pnpm task note for the active task', () => {
      expect(saveInstruction('demo-261117')).toContain('pnpm task note --done');
    });

    test('should tell the agent to switch or create a task when none is active', () => {
      const text = saveInstruction(null);

      expect(text).toContain('pnpm task switch <name>');
      expect(text).toContain('tasks/<task-name-yymmdd>/NOTES.md');
    });
  });

  describe('getActiveTask', () => {
    test('should return the task named in tasks/.active', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-active-'));
      tempDirs.push(root);
      fs.mkdirSync(path.join(root, 'tasks', 'demo-261117'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, 'tasks', 'demo-261117', 'NOTES.md'), '');
      fs.writeFileSync(path.join(root, 'tasks', '.active'), 'demo-261117\n');

      expect(getActiveTask(root)).toBe('demo-261117');
    });

    test('should name only a task the session engaged', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-session-'));
      tempDirs.push(root);
      fs.mkdirSync(path.join(root, 'tasks', 'demo-261117'), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, 'tasks', 'demo-261117', 'NOTES.md'), '');
      writeSession(root, 'dormant', { task: 'demo-261117', engaged: false });
      writeSession(root, 'engaged', { task: 'demo-261117', engaged: true });

      expect(getActiveTask(root, 'dormant')).toBeNull();
      expect(getActiveTask(root, 'engaged')).toBe('demo-261117');
    });

    test('should return null when tasks/ is unreadable', () => {
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      });
      try {
        expect(getActiveTask('/nowhere')).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('processHookInput', () => {
    test('returns null for missing input', () => {
      expect(processHookInput(undefined, {})).toBeNull();
      expect(processHookInput({}, {})).toBeNull();
    });

    test('returns null below the note threshold', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { input_tokens: 100 } },
        },
      ]);

      expect(processHookInput({ transcript_path: file }, {})).toBeNull();
    });

    test('returns additional context only at the note level', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { input_tokens: 250_000 } },
        },
      ]);

      const output = processHookInput({ transcript_path: file }, {});

      expect(output?.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(output?.hookSpecificOutput.additionalContext).toContain(
        '[Context Monitor]'
      );
      expect(output?.systemMessage).toBeUndefined();
    });

    test('also sets systemMessage at the warning level', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { input_tokens: 500_000 } },
        },
      ]);

      const output = processHookInput({ transcript_path: file }, {});

      expect(output?.systemMessage).toContain('[Context Monitor][WARNING]');
    });

    test('should look up the active task only at the warning level', () => {
      const activeTask = vi.fn(() => 'demo-261117');
      const note = transcript([
        { type: 'assistant', message: { usage: { input_tokens: 250_000 } } },
      ]);
      const warn = transcript([
        { type: 'assistant', message: { usage: { input_tokens: 500_000 } } },
      ]);

      processHookInput({ transcript_path: note }, {}, { activeTask });
      expect(activeTask).not.toHaveBeenCalled();

      const output = processHookInput(
        { transcript_path: warn },
        {},
        { activeTask }
      );
      expect(output?.systemMessage).toContain('tasks/demo-261117/NOTES.md');
      expect(activeTask).toHaveBeenCalledWith(null);
      processHookInput(
        { transcript_path: warn, session_id: 'sess-1' },
        {},
        { activeTask }
      );
      expect(activeTask).toHaveBeenLastCalledWith('sess-1');
    });

    test('respects CLAUDE_CONTEXT_WINDOW', () => {
      const file = transcript([
        {
          type: 'assistant',
          message: { usage: { input_tokens: 500 } },
        },
      ]);

      const output = processHookInput(
        { transcript_path: file },
        { CLAUDE_CONTEXT_WINDOW: '1000' }
      );

      expect(output?.systemMessage).toContain('[Context Monitor][WARNING]');
    });
  });
});
