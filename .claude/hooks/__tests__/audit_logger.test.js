/**
 * Tests for audit_logger.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LOG_FILE_NAME,
  appendLogEntry,
  buildLogEntry,
  ensureLogDirectory,
  getLogRoot,
  processHookInput,
  sanitizeForLogging,
} from '../audit_logger.js';
import { REDACTED } from '#utils/redact.js';

// Fake secrets are assembled at runtime so secret scanners don't flag this file.
// The rules themselves are tested in utils/__tests__/redact.test.js.
const FAKE = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'gh' + 'p_' + 'a'.repeat(36),
};

/** @param {string} file */
const readLines = (file) =>
  fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

describe('audit_logger', () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-logger-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getLogRoot', () => {
    test('should prefer CLAUDE_PROJECT_DIR', () => {
      expect(getLogRoot({ cwd: '/cwd' }, { CLAUDE_PROJECT_DIR: '/proj' })).toBe(
        '/proj'
      );
    });

    test('should fall back to input cwd', () => {
      expect(getLogRoot({ cwd: '/cwd' }, {})).toBe('/cwd');
    });

    test('should fall back to process.cwd() with no input', () => {
      expect(getLogRoot(undefined, {})).toBe(process.cwd());
    });

    test('should use the workspace root in Codex, ignoring an inherited CLAUDE_PROJECT_DIR', () => {
      expect(
        getLogRoot(
          { cwd: '/cwd' },
          { CLAUDE_PROJECT_DIR: '/p' },
          {
            harness: 'codex',
            rootDir: '/root',
          }
        )
      ).toBe('/root');
    });
  });

  describe('ensureLogDirectory', () => {
    test('should create the dated directory and return the JSONL path', () => {
      const now = new Date('2026-11-17T10:00:00.000Z');

      const logFile = ensureLogDirectory(tmpDir, now);

      expect(logFile).toBe(
        path.join(tmpDir, 'logs', '20261117', LOG_FILE_NAME)
      );
      expect(fs.existsSync(path.dirname(logFile))).toBe(true);
    });

    test('should default to today and be idempotent', () => {
      const first = ensureLogDirectory(tmpDir);
      const second = ensureLogDirectory(tmpDir);

      expect(first).toBe(second);
      expect(path.basename(path.dirname(first))).toMatch(/^\d{8}$/);
    });
  });

  describe('appendLogEntry', () => {
    test('should write one JSON line per entry', () => {
      const logFile = path.join(tmpDir, LOG_FILE_NAME);
      const entry1 = { tool_name: 'Read' };
      const entry2 = { tool_name: 'Write' };

      appendLogEntry(logFile, entry1);
      appendLogEntry(logFile, entry2);

      expect(readLines(logFile)).toEqual([entry1, entry2]);
    });

    test('should keep every entry across many appends', () => {
      const logFile = path.join(tmpDir, LOG_FILE_NAME);

      for (let i = 0; i < 200; i++) appendLogEntry(logFile, { i });

      const lines = readLines(logFile);
      expect(lines).toHaveLength(200);
      expect(lines.map((line) => line.i)).toEqual([...Array(200).keys()]);
    });

    test('should not disturb existing non-JSON content', () => {
      const logFile = path.join(tmpDir, LOG_FILE_NAME);
      fs.writeFileSync(logFile, 'legacy line\n', 'utf-8');

      appendLogEntry(logFile, { tool_name: 'Read' });

      const raw = fs.readFileSync(logFile, 'utf-8').split('\n');
      expect(raw[0]).toBe('legacy line');
      expect(JSON.parse(raw[1])).toEqual({ tool_name: 'Read' });
    });
  });

  describe('sanitizeForLogging', () => {
    test('should truncate long content fields', () => {
      const sanitized = /** @type {Record<string, any>} */ (
        sanitizeForLogging({ content: 'a'.repeat(1000), other: 'short' }, 100)
      );

      expect(sanitized.content).toMatch(/^a{100}\.\.\./);
      expect(sanitized.content).toContain('total length: 1000');
      expect(sanitized.other).toBe('short');
    });

    test('should truncate long new_source fields with the default limit', () => {
      const sanitized = /** @type {Record<string, any>} */ (
        sanitizeForLogging({ new_source: 'b'.repeat(600), file_path: 'x.js' })
      );

      expect(sanitized.new_source).toMatch(/^b{500}\.\.\./);
      expect(sanitized.file_path).toBe('x.js');
    });

    test('should redact before truncating', () => {
      const content = `${FAKE.ghp} ${'z'.repeat(600)}`;

      const sanitized = /** @type {Record<string, any>} */ (
        sanitizeForLogging({ content }, 50)
      );

      expect(sanitized.content.startsWith(REDACTED)).toBe(true);
      expect(sanitized.content).not.toContain(FAKE.ghp);
    });

    test('should redact secrets in nested objects and arrays', () => {
      const data = {
        tool_input: {
          command: `curl -H "Authorization: Bearer tok123" x`,
          nested: [{ note: FAKE.aws }, 'plain', 42],
        },
      };

      const sanitized = /** @type {Record<string, any>} */ (
        sanitizeForLogging(data)
      );

      expect(sanitized.tool_input.command).toBe(
        `curl -H "Authorization: Bearer ${REDACTED}" x`
      );
      expect(sanitized.tool_input.nested).toEqual([
        { note: REDACTED },
        'plain',
        42,
      ]);
    });

    test('should redact string values under secret-looking keys', () => {
      const sanitized = /** @type {Record<string, any>} */ (
        sanitizeForLogging({
          env: { DEEPSEEK_API_KEY: 'abc', Password: 'p', max_tokens: 1000 },
        })
      );

      expect(sanitized.env).toEqual({
        DEEPSEEK_API_KEY: REDACTED,
        Password: REDACTED,
        max_tokens: 1000,
      });
    });

    test('should keep null values inside objects', () => {
      expect(sanitizeForLogging({ a: null })).toEqual({ a: null });
    });

    test('should handle primitive values', () => {
      expect(sanitizeForLogging('string')).toBe('string');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(true)).toBe(true);
      expect(sanitizeForLogging(null)).toBe(null);
    });
  });

  describe('buildLogEntry', () => {
    test('should map hook fields and use the given time', () => {
      const entry = buildLogEntry(
        {
          session_id: 's1',
          hook_event_name: 'PostToolUse',
          tool_name: 'Read',
          tool_input: { file_path: 'a.txt' },
          tool_response: { content: 'ok' },
          cwd: '/dir',
          permission_mode: 'default',
        },
        new Date('2026-11-17T00:00:00.000Z')
      );

      expect(entry).toEqual({
        timestamp: '2026-11-17T00:00:00.000Z',
        session_id: 's1',
        hook_event: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'a.txt' },
        tool_response: { content: 'ok' },
        cwd: '/dir',
        permission_mode: 'default',
      });
    });

    test('should drop undefined, null, and empty-object fields', () => {
      const entry = buildLogEntry(
        /** @type {any} */ ({
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: null,
          tool_response: undefined,
          cwd: null,
        })
      );

      expect(Object.keys(entry).sort()).toEqual([
        'session_id',
        'timestamp',
        'tool_name',
      ]);
    });

    test('should add the harness only when it is not Claude Code', () => {
      expect(buildLogEntry({}, new Date(), 'dsh').harness).toBe('dsh');
      expect(buildLogEntry({}, new Date())).not.toHaveProperty('harness');
    });

    test('should keep array tool responses', () => {
      const entry = buildLogEntry({ tool_response: [] });

      expect(entry.tool_response).toEqual([]);
    });
  });

  describe('processHookInput', () => {
    test('should append a redacted entry under CLAUDE_PROJECT_DIR', () => {
      const logFile = processHookInput(
        {
          session_id: 's1',
          tool_name: 'Bash',
          tool_input: { command: `GH_TOKEN=${FAKE.ghp} gh pr list` },
          cwd: '/elsewhere',
        },
        { CLAUDE_PROJECT_DIR: tmpDir }
      );

      if (logFile === null) throw new Error('expected a log file');
      expect(logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
      const [entry] = readLines(logFile);
      expect(entry.tool_input.command).toBe(`GH_TOKEN=${REDACTED} gh pr list`);
    });

    test('should log Codex calls under the workspace root, marked with the harness', () => {
      const logFile = /** @type {string} */ (
        processHookInput(
          {
            session_id: 'cx',
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            cwd: '/elsewhere',
          },
          { CLAUDE_PROJECT_DIR: '/parent-claude' },
          { harness: 'codex', rootDir: tmpDir }
        )
      );
      expect(logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
      expect(readLines(logFile)[0].harness).toBe('codex');
    });

    test("should log Codex's patch edits at PreToolUse, and skip its other PreToolUse calls", () => {
      const options = {
        harness: /** @type {const} */ ('codex'),
        rootDir: tmpDir,
      };
      expect(
        processHookInput(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: { command: 'ls' },
          },
          {},
          options
        )
      ).toBeNull();
      const logFile = /** @type {string} */ (
        processHookInput(
          {
            hook_event_name: 'PreToolUse',
            tool_name: 'Bash',
            tool_input: {
              command:
                "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: a.md\n*** End Patch\nEOF",
            },
          },
          {},
          options
        )
      );
      const [entry] = readLines(logFile);
      expect(entry).toMatchObject({
        hook_event: 'PreToolUse',
        harness: 'codex',
      });
    });

    test('should fall back to input cwd and append across calls', () => {
      const input = { session_id: 's2', tool_name: 'Read', cwd: tmpDir };

      processHookInput(input, {});
      const logFile = processHookInput(input, {});

      if (logFile === null) throw new Error('expected a log file');
      expect(logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
      expect(readLines(logFile)).toHaveLength(2);
    });
  });
});
