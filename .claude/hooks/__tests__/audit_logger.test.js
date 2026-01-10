/**
 * Tests for audit_logger.js
 */
import fs from 'fs';
import path from 'path';
import {
  ensureLogDirectory,
  appendLogEntry,
  sanitizeForLogging,
  processHookInput,
} from '../audit_logger.js';

describe('audit_logger', () => {
  // Cleanup test logs after each test
  afterEach(() => {
    const logsDir = 'logs';
    if (fs.existsSync(logsDir)) {
      fs.rmSync(logsDir, { recursive: true, force: true });
    }
  });

  describe('ensureLogDirectory', () => {
    test('should create log directory and return log file path', () => {
      const logFile = ensureLogDirectory();

      // Check that the path is in the expected format (normalize for cross-platform)
      const normalizedPath = logFile.replace(/\\/g, '/');
      expect(normalizedPath).toMatch(/^logs\/\d{8}\/logging\.json$/);

      // Check that directory was created
      const logDir = path.dirname(logFile);
      expect(fs.existsSync(logDir)).toBe(true);
    });

    test('should return same path when called multiple times', () => {
      const logFile1 = ensureLogDirectory();
      const logFile2 = ensureLogDirectory();

      expect(logFile1).toBe(logFile2);
    });
  });

  describe('appendLogEntry', () => {
    test('should create new log file with single entry', () => {
      const logFile = 'logs/test/logging.json';
      const logDir = path.dirname(logFile);

      // Create directory
      fs.mkdirSync(logDir, { recursive: true });

      const entry = {
        timestamp: '2026-01-11T00:00:00.000Z',
        tool_name: 'Read',
        tool_input: { file_path: 'test.txt' },
      };

      appendLogEntry(logFile, entry);

      // Check file exists and contains entry
      expect(fs.existsSync(logFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      expect(content).toEqual([entry]);
    });

    test('should append entry to existing log file', () => {
      const logFile = 'logs/test/logging.json';
      const logDir = path.dirname(logFile);

      fs.mkdirSync(logDir, { recursive: true });

      const entry1 = {
        timestamp: '2026-01-11T00:00:00.000Z',
        tool_name: 'Read',
      };
      const entry2 = {
        timestamp: '2026-01-11T00:01:00.000Z',
        tool_name: 'Write',
      };

      appendLogEntry(logFile, entry1);
      appendLogEntry(logFile, entry2);

      const content = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(entry1);
      expect(content[1]).toEqual(entry2);
    });

    test('should handle corrupted log file by starting fresh', () => {
      const logFile = 'logs/test/logging.json';
      const logDir = path.dirname(logFile);

      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(logFile, 'corrupted json', 'utf-8');

      const entry = {
        timestamp: '2026-01-11T00:00:00.000Z',
        tool_name: 'Read',
      };
      appendLogEntry(logFile, entry);

      const content = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      expect(content).toEqual([entry]);
    });

    test('should convert non-array log to array', () => {
      const logFile = 'logs/test/logging.json';
      const logDir = path.dirname(logFile);

      fs.mkdirSync(logDir, { recursive: true });

      // Write a single object (not an array)
      const oldEntry = {
        timestamp: '2026-01-10T00:00:00.000Z',
        tool_name: 'Old',
      };
      fs.writeFileSync(logFile, JSON.stringify(oldEntry), 'utf-8');

      const newEntry = {
        timestamp: '2026-01-11T00:00:00.000Z',
        tool_name: 'New',
      };
      appendLogEntry(logFile, newEntry);

      const content = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual(oldEntry);
      expect(content[1]).toEqual(newEntry);
    });
  });

  describe('processHookInput', () => {
    test('should process hook input and create log entry', () => {
      const hookInput = {
        session_id: 'test-session',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: { file_path: 'test.txt' },
        tool_response: { content: 'file content' },
        cwd: '/test/dir',
        permission_mode: 'allow',
      };

      processHookInput(hookInput);

      // Verify log was created
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const logFile = path.join('logs', today, 'logging.json');
      expect(fs.existsSync(logFile)).toBe(true);

      const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      expect(logs).toHaveLength(1);
      expect(logs[0].session_id).toBe('test-session');
      expect(logs[0].tool_name).toBe('Read');
      expect(logs[0].hook_event).toBe('PostToolUse');
    });

    test('should remove undefined and null values from log entry', () => {
      const hookInput = {
        session_id: 'test-session',
        hook_event_name: 'PostToolUse',
        tool_name: 'Read',
        tool_input: null,
        tool_response: undefined,
        cwd: '/test/dir',
      };

      processHookInput(hookInput);

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const logFile = path.join('logs', today, 'logging.json');
      const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));

      expect(logs[0].tool_input).toBeUndefined();
      expect(logs[0].tool_response).toBeUndefined();
      expect(logs[0].session_id).toBe('test-session');
    });

    test('should handle empty tool_input and tool_response', () => {
      const hookInput = {
        session_id: 'test-session',
        tool_name: 'Bash',
      };

      processHookInput(hookInput);

      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const logFile = path.join('logs', today, 'logging.json');
      const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));

      expect(logs[0].session_id).toBe('test-session');
      expect(logs[0].tool_name).toBe('Bash');
    });
  });

  describe('sanitizeForLogging', () => {
    test('should truncate long content fields', () => {
      const data = {
        content: 'a'.repeat(1000),
        other: 'short',
      };

      const sanitized = sanitizeForLogging(data, 100);

      expect(sanitized.content).toMatch(/^a{100}\.\.\./);
      expect(sanitized.content).toContain('total length: 1000');
      expect(sanitized.other).toBe('short');
    });

    test('should truncate long new_source fields', () => {
      const data = {
        new_source: 'b'.repeat(600),
        file_path: 'test.js',
      };

      const sanitized = sanitizeForLogging(data, 500);

      expect(sanitized.new_source).toMatch(/^b{500}\.\.\./);
      expect(sanitized.new_source).toContain('total length: 600');
      expect(sanitized.file_path).toBe('test.js');
    });

    test('should handle nested objects', () => {
      const data = {
        tool_input: {
          content: 'c'.repeat(800),
          nested: {
            new_source: 'd'.repeat(700),
          },
        },
      };

      const sanitized = sanitizeForLogging(data, 500);

      expect(sanitized.tool_input.content).toMatch(/^c{500}\.\.\./);
      expect(sanitized.tool_input.nested.new_source).toMatch(/^d{500}\.\.\./);
    });

    test('should handle arrays', () => {
      const data = [{ content: 'e'.repeat(600) }, { content: 'short' }];

      const sanitized = sanitizeForLogging(data, 500);

      expect(sanitized[0].content).toMatch(/^e{500}\.\.\./);
      expect(sanitized[1].content).toBe('short');
    });

    test('should not modify short content', () => {
      const data = {
        content: 'short content',
        new_source: 'also short',
      };

      const sanitized = sanitizeForLogging(data, 500);

      expect(sanitized.content).toBe('short content');
      expect(sanitized.new_source).toBe('also short');
    });

    test('should handle primitive values', () => {
      expect(sanitizeForLogging('string')).toBe('string');
      expect(sanitizeForLogging(123)).toBe(123);
      expect(sanitizeForLogging(true)).toBe(true);
      expect(sanitizeForLogging(null)).toBe(null);
    });
  });
});
