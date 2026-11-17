/**
 * Tests for audit_logger.js
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  LOG_FILE_NAME,
  REDACTED,
  appendLogEntry,
  buildLogEntry,
  ensureLogDirectory,
  getLogRoot,
  processHookInput,
  redactSecrets,
  sanitizeForLogging,
} from '../audit_logger.js';

// Fake secrets are assembled at runtime so secret scanners don't flag this file.
const FAKE = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  ghp: 'gh' + 'p_' + 'a'.repeat(36),
  ghPat: 'github' + '_pat_' + 'b'.repeat(30),
  sk: 'sk' + '-ant-' + 'c'.repeat(30),
  slack: 'xo' + 'xb-' + '1234567890-abc',
  jwt: 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1',
  pem:
    '-----BEGIN RSA PRIVATE' +
    ' KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE' +
    ' KEY-----',
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

  describe('redactSecrets', () => {
    test.each([
      ['AWS access key', `key ${FAKE.aws} end`],
      ['GitHub token', `token ${FAKE.ghp}`],
      ['GitHub fine-grained PAT', `pat ${FAKE.ghPat}`],
      ['sk- API key', `curl -H x ${FAKE.sk}`],
      ['Slack token', `slack ${FAKE.slack}`],
      ['JWT', `jwt ${FAKE.jwt}`],
    ])('should redact %s', (_label, text) => {
      const result = redactSecrets(text);

      expect(result).toContain(REDACTED);
      for (const secret of Object.values(FAKE)) {
        expect(result).not.toContain(secret);
      }
    });

    test('should redact a Bearer token but keep the scheme', () => {
      expect(redactSecrets('Authorization: Bearer abc.def-123')).toBe(
        `Authorization: Bearer ${REDACTED}`
      );
    });

    test('should redact a whole PEM private key block', () => {
      expect(redactSecrets(`before\n${FAKE.pem}\nafter`)).toBe(
        'before\n[REDACTED PRIVATE KEY]\nafter'
      );
    });

    test('should redact an unterminated PEM block to the end', () => {
      const truncated = FAKE.pem.slice(0, 40);

      expect(redactSecrets(`x ${truncated}`)).toBe('x [REDACTED PRIVATE KEY]');
    });

    test.each([
      ['GITHUB_TOKEN=abc123 pnpm x', `GITHUB_TOKEN=${REDACTED} pnpm x`],
      ['export DB_PASSWORD="hunter 2"', `export DB_PASSWORD=${REDACTED}`],
      ["api_key: 'secret value'", `api_key: ${REDACTED}`],
      ['AWS_SECRET_ACCESS_KEY = xyz', `AWS_SECRET_ACCESS_KEY = ${REDACTED}`],
      ['deepseek_apikey=foo', `deepseek_apikey=${REDACTED}`],
    ])('should keep the name and redact the value in %s', (input, expected) => {
      expect(redactSecrets(input)).toBe(expected);
    });

    test('should leave ordinary text unchanged', () => {
      const text = 'git status && pnpm test -- --coverage';

      expect(redactSecrets(text)).toBe(text);
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

      expect(logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
      const [entry] = readLines(logFile);
      expect(entry.tool_input.command).toBe(`GH_TOKEN=${REDACTED} gh pr list`);
    });

    test('should fall back to input cwd and append across calls', () => {
      const input = { session_id: 's2', tool_name: 'Read', cwd: tmpDir };

      processHookInput(input, {});
      const logFile = processHookInput(input, {});

      expect(logFile.startsWith(path.join(tmpDir, 'logs'))).toBe(true);
      expect(readLines(logFile)).toHaveLength(2);
    });
  });
});
