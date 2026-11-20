import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import {
  flushFormatQueue,
  formatTargets,
  isFormattable,
  queueFiles,
  queuePath,
  takeQueue,
} from '../format.js';

/** @type {string} */
let project;
/** @type {string} */
let tmpDir;

beforeEach(() => {
  project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-proj-'))
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-queue-'));
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** @param {string} rel */
const touch = (rel) => {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
};

describe('isFormattable', () => {
  test('should accept files Prettier formats, by extension', () => {
    expect(isFormattable('a/b.JS')).toBe(true);
    expect(isFormattable('notes.md')).toBe(true);
    expect(isFormattable('image.png')).toBe(false);
    expect(isFormattable('Makefile')).toBe(false);
  });
});

describe('formatTargets', () => {
  test('should resolve paths against the cwd and keep formattable ones in the project', () => {
    expect(
      formatTargets(['src/a.js', 'README.md', 'logo.png'], {
        cwd: path.join(project, 'pkg'),
        projectDir: project,
      })
    ).toEqual([
      path.join(project, 'pkg', 'src/a.js'),
      path.join(project, 'pkg', 'README.md'),
    ]);
  });

  test('should drop paths outside the project, absolute or relative', () => {
    expect(
      formatTargets(
        ['../outside.js', '/etc/x.js', path.join(project, 'in.js')],
        {
          cwd: project,
          projectDir: project,
        }
      )
    ).toEqual([path.join(project, 'in.js')]);
  });

  test('should use the project dir when there is no cwd', () => {
    expect(formatTargets(['a.js'], { projectDir: project })).toEqual([
      path.join(project, 'a.js'),
    ]);
  });
});

describe('queue', () => {
  test('should keep one queue file per safe session id', () => {
    expect(queuePath('s-1', tmpDir)).toBe(
      path.join(tmpDir, 'workspace-format-queue', 's-1.txt')
    );
    expect(queuePath('../x', tmpDir)).toBeNull();
    expect(queuePath(null, tmpDir)).toBeNull();
  });

  test('should hand back queued files once, each once', () => {
    queueFiles('s-1', ['/p/a.js', '/p/b.js'], { tmpDir });
    queueFiles('s-1', ['/p/a.js'], { tmpDir });
    expect(takeQueue('s-1', { tmpDir })).toEqual(['/p/a.js', '/p/b.js']);
    expect(takeQueue('s-1', { tmpDir })).toEqual([]);
  });

  test('should do nothing without a session or files', () => {
    queueFiles(null, ['/p/a.js'], { tmpDir });
    queueFiles('s-1', [], { tmpDir });
    expect(fs.existsSync(path.join(tmpDir, 'workspace-format-queue'))).toBe(
      false
    );
    expect(takeQueue(null, { tmpDir })).toEqual([]);
  });

  test('should keep sessions apart', () => {
    queueFiles('s-1', ['/p/a.js'], { tmpDir });
    queueFiles('s-2', ['/p/b.js'], { tmpDir });
    expect(takeQueue('s-2', { tmpDir })).toEqual(['/p/b.js']);
    expect(takeQueue('s-1', { tmpDir })).toEqual(['/p/a.js']);
  });
});

describe('flushFormatQueue', () => {
  test('should format the queued files that exist inside the project', () => {
    const a = touch('a.js');
    queueFiles('s-1', [a, path.join(project, 'gone.js')], { tmpDir });
    const run = vi.fn(() => true);
    expect(
      flushFormatQueue('s-1', { tmpDir, projectDir: project, run })
    ).toEqual([a]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(a);
    expect(takeQueue('s-1', { tmpDir })).toEqual([]);
  });

  test('should also format extra files, and leave out ones that failed', () => {
    const a = touch('a.js');
    const b = touch('b.md');
    queueFiles('s-1', [a], { tmpDir });
    const run = vi.fn((/** @type {string} */ file) => file === a);
    expect(
      flushFormatQueue('s-1', {
        tmpDir,
        projectDir: project,
        run,
        extra: [b, a],
      })
    ).toEqual([a]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('should not follow a link out of the project', () => {
    const link = touch('link.js');
    queueFiles('s-1', [link], { tmpDir });
    const run = vi.fn(() => true);
    // A symlink whose target is outside the project (injected: no real
    // symlink, so the test runs the same on Windows).
    const realpath = vi.fn((/** @type {string} */ p) =>
      p === project ? project : '/elsewhere/x.js'
    );
    expect(
      flushFormatQueue('s-1', { tmpDir, projectDir: project, run, realpath })
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  test('should run the real Prettier by default', () => {
    const file = path.join(project, 'ugly.js');
    fs.writeFileSync(file, 'const  a=1');
    queueFiles('s-1', [file], { tmpDir });
    expect(flushFormatQueue('s-1', { tmpDir, projectDir: project })).toEqual([
      file,
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('const a = 1;\n');
  });

  test('should do nothing when nothing is queued', () => {
    const run = vi.fn(() => true);
    expect(
      flushFormatQueue('s-1', { tmpDir, projectDir: project, run })
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
