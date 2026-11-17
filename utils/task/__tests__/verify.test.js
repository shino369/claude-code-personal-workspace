import { vi } from 'vitest';
import {
  DEFAULT_TIMEOUT_MS,
  runCommands,
  stripAnsi,
  summarize,
  tail,
} from '../verify.js';

describe('tail', () => {
  test('should keep the last non-empty lines', () => {
    expect(tail('a\n\nb\r\nc\n  \n', 2)).toBe('b\nc');
  });

  test('should default to 20 lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
    expect(tail(text).split('\n')).toHaveLength(20);
  });
});

describe('runCommands', () => {
  test('should run commands in order and stop at the first failure', () => {
    let clock = 0;
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: 'ok', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: 'out', stderr: 'err' })
      .mockReturnValueOnce({ status: 0 });
    const onStart = vi.fn();

    const results = runCommands({
      commands: ['a', 'b', 'c'],
      cwd: '/repo',
      spawn,
      now: () => (clock += 10),
      onStart,
    });

    expect(results).toEqual([
      { command: 'a', ok: true, code: 0, durationMs: 10, output: 'ok' },
      { command: 'b', ok: false, code: 1, durationMs: 10, output: 'out\nerr' },
    ]);
    expect(onStart.mock.calls).toEqual([['a'], ['b']]);
    expect(spawn).toHaveBeenCalledWith(
      'a',
      expect.objectContaining({ cwd: '/repo', timeout: DEFAULT_TIMEOUT_MS })
    );
  });

  test('should strip color codes and ask tools not to color', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 1,
      stdout: '\x1b[31m×\x1b[39m adds\x1b[2K',
    });
    const [result] = runCommands({ commands: ['t'], cwd: '/', spawn });
    expect(result.output).toBe('× adds');
    expect(spawn).toHaveBeenCalledWith(
      't',
      expect.objectContaining({
        env: expect.objectContaining({ FORCE_COLOR: '0', NO_COLOR: '1' }),
      })
    );
    expect(stripAnsi('plain')).toBe('plain');
  });

  test('should report a timeout signal and spawn errors', () => {
    const spawn = vi.fn().mockReturnValue({
      status: null,
      signal: 'SIGTERM',
      error: new Error('ETIMEDOUT'),
    });
    const [result] = runCommands({
      commands: ['slow'],
      cwd: '/',
      spawn,
      timeoutMs: 2000,
    });
    expect(result.ok).toBe(false);
    expect(result.output).toBe('ETIMEDOUT\n(stopped by SIGTERM; timeout 2s)');
  });

  test('should run through the real shell by default', () => {
    const [result] = runCommands({
      commands: ['node -e "console.log(42)"'],
      cwd: process.cwd(),
    });
    expect(result).toMatchObject({ ok: true, code: 0 });
    expect(result.output).toContain('42');
  });
});

describe('summarize', () => {
  const at = new Date('2026-11-17T00:00:00Z');

  test('should report a pass', () => {
    expect(
      summarize(
        [{ command: 'a', ok: true, code: 0, durationMs: 1, output: '' }],
        at
      )
    ).toEqual({
      at: at.toISOString(),
      ok: true,
      failed: null,
      summary: '1 command(s) passed',
    });
  });

  test('should report the failed command and output tail', () => {
    expect(
      summarize(
        [{ command: 'b', ok: false, code: 2, durationMs: 1, output: 'x\ny' }],
        at
      )
    ).toMatchObject({ ok: false, failed: 'b', summary: 'x\ny' });
  });
});
