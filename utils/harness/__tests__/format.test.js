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
  taskRepoRoots,
} from '../format.js';
import { createState } from '../../task/state.js';
import { saveState, writeSession } from '../../task/store.js';

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

describe('taskRepoRoots', () => {
  /** @param {string} name @param {string} state */
  const task = (name, state) => {
    const dir = path.join(project, 'tasks', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), state);
    writeSession(project, 's-1', { task: name, engaged: true });
  };

  test('should give the repo of the session task when its folder exists', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-r-'));
    const dir = path.join(project, 'tasks', 'demo-261121');
    fs.mkdirSync(dir, { recursive: true });
    saveState(dir, createState({ name: 'demo-261121', goal: 'G', repo }));
    writeSession(project, 's-1', { task: 'demo-261121', engaged: true });
    expect(taskRepoRoots(project, 's-1')).toEqual([repo]);
    fs.rmSync(repo, { recursive: true, force: true });
    expect(taskRepoRoots(project, 's-1')).toEqual([]);
  });

  test('should give nothing without a session task or with a broken one', () => {
    expect(taskRepoRoots(project, 'nobody')).toEqual([]);
    task('broken-261121', '{not json');
    expect(taskRepoRoots(project, 's-1')).toEqual([]);
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

  test("should keep files in the extra roots too (a task's --repo)", () => {
    const repo = path.join(os.tmpdir(), 'fmt-repo-x');
    expect(
      formatTargets([path.join(repo, 'r.js'), '/etc/x.js'], {
        cwd: project,
        projectDir: project,
        extraRoots: [repo],
      })
    ).toEqual([path.join(repo, 'r.js')]);
  });

  test('should use the project dir when there is no cwd', () => {
    expect(formatTargets(['a.js'], { projectDir: project })).toEqual([
      path.join(project, 'a.js'),
    ]);
  });
});

describe('queue', () => {
  test('should keep one queue file per safe session id', () => {
    const owner = process.getuid?.() ?? os.userInfo().username;
    expect(queuePath('s-1', tmpDir)).toBe(
      path.join(tmpDir, `workspace-format-queue-${owner}`, 's-1.txt')
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
    expect(fs.readdirSync(tmpDir)).toEqual([]);
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
    expect(run).toHaveBeenCalledWith(a, project);
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

  test("should run Prettier in the project, so the caller's ignore files do not skip the file", () => {
    // This workspace's .gitignore has `tmp/`: run from here, Prettier would
    // match a project under /tmp/ (Linux CI) and leave the file unformatted.
    const nested = path.join(project, 'tmp', 'proj');
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, 'ugly.js');
    fs.writeFileSync(file, 'const  a=1');
    queueFiles('s-1', [file], { tmpDir });
    expect(flushFormatQueue('s-1', { tmpDir, projectDir: nested })).toEqual([
      file,
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('const a = 1;\n');
  });

  test('should format files in an extra root, with Prettier run in that root', () => {
    const repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'fmt-repo-'))
    );
    const inRepo = path.join(repo, 'r.js');
    const inProject = touch('p.js');
    fs.writeFileSync(inRepo, 'x');
    const outside = path.join(tmpDir, 'o.js');
    fs.writeFileSync(outside, 'x');
    queueFiles('s-1', [inRepo, inProject, outside], { tmpDir });
    const run = vi.fn(() => true);
    expect(
      flushFormatQueue('s-1', {
        tmpDir,
        projectDir: project,
        extraRoots: [repo],
        run,
      })
    ).toEqual([inRepo, inProject]);
    expect(run.mock.calls).toEqual([
      [inRepo, repo],
      [inProject, project],
    ]);
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test('should run Prettier in the innermost root holding the file', () => {
    const nested = path.join(project, 'sub');
    const file = touch('sub/n.js');
    queueFiles('s-1', [file], { tmpDir });
    const run = vi.fn(() => true);
    flushFormatQueue('s-1', {
      tmpDir,
      projectDir: project,
      extraRoots: [nested],
      run,
    });
    expect(run).toHaveBeenCalledWith(file, nested);
  });

  test('should do nothing when nothing is queued', () => {
    const run = vi.fn(() => true);
    expect(
      flushFormatQueue('s-1', { tmpDir, projectDir: project, run })
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
