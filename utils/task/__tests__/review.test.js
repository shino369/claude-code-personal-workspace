import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';
import { freshQuality } from '../quality.js';
import {
  FINDINGS_HEADER,
  FOLDER_BASE,
  SEVERITY_RUBRIC,
  defaultRunGit,
  findingsTemplate,
  fingerprint,
  formatReviewBrief,
  openRound,
  parseFindings,
  recordFindings,
  defaultBranch,
  hasProductCode,
  productFiles,
  reviewBase,
  reviewFiles,
  reviewScope,
  roundBase,
  scopeRoot,
  splitRow,
  taskFolderNotes,
  taskReviewScope,
} from '../review.js';
import { createState, makeSteps } from '../state.js';

const NAME = 'demo-261117';
const GREEN = {
  at: '2026-11-18T00:00:00.000Z',
  ok: true,
  failed: null,
  summary: 'ok',
};

/** @param {Partial<import('../state.js').TaskState>} [overrides] */
function codeState(overrides = {}) {
  return {
    ...createState({
      name: NAME,
      goal: 'Ship it',
      steps: makeSteps(['Build']).map((step) => ({
        ...step,
        status: /** @type {const} */ ('done'),
      })),
      verify: ['pnpm test'],
      kind: 'code',
    }),
    lastVerify: GREEN,
    ...overrides,
  };
}

/**
 * @param {Partial<import('../quality.js').Finding>} [overrides]
 * @returns {import('../quality.js').Finding}
 */
function finding(overrides = {}) {
  return {
    id: 'r1-1',
    round: 1,
    file: 'app/a.js',
    line: 3,
    severity: 'high',
    claim: 'Loses writes',
    scenario: 'Two saves at once → one is lost',
    verdict: 'CONFIRMED',
    reason: 'No lock around save',
    step: null,
    ...overrides,
  };
}

const table = (/** @type {string[]} */ ...rows) =>
  [
    '# Review',
    '',
    `| ${FINDINGS_HEADER.join(' | ')} |`,
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Trailing text',
  ].join('\n');

/**
 * @param {string} dir
 * @param {...string} files empty files to create, relative to `dir`
 */
function touch(dir, ...files) {
  for (const rel of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }
}

/** @type {string} */
let root;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reviewFiles', () => {
  test('should name the brief and findings files by round', () => {
    expect(reviewFiles(NAME, 2)).toEqual({
      brief: `reviews/BRIEF_${NAME}-r2.md`,
      findings: `reviews/REVIEW_${NAME}-r2.md`,
    });
  });
});

describe('defaultBranch', () => {
  test('should read origin/HEAD as the remote ref', () => {
    const runGit = vi.fn(() => 'origin/develop');
    expect(defaultBranch(runGit, '/r')).toBe('origin/develop');
    expect(runGit).toHaveBeenCalledWith(
      ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
      '/r'
    );
  });

  test('should fall back to main without origin/HEAD', () => {
    expect(defaultBranch(() => null, '/r')).toBe('main');
    expect(defaultBranch(() => 'upstream/trunk', '/r')).toBe('main');
  });
});

describe('reviewBase', () => {
  const taskDir = () => path.join(root, 'tasks', NAME);
  const withCode = () => {
    fs.mkdirSync(path.join(taskDir(), 'app'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'app', 'a.js'), '');
  };

  test("should keep the open round's base", () => {
    const quality = {
      ...freshQuality(),
      phase: /** @type {const} */ ('review'),
      base: 'dev',
    };
    expect(reviewBase({ quality, taskDir: taskDir(), base: 'main' })).toBe(
      'dev'
    );
    expect(
      reviewBase({
        quality: { ...quality, base: undefined },
        taskDir: taskDir(),
      })
    ).toBeNull();
  });

  test('should prefer --base, then the base an earlier round used', () => {
    withCode();
    const recorded = {
      ...freshQuality(),
      phase: /** @type {const} */ ('fix'),
      reviewRounds: 1,
      base: 'dev',
    };
    expect(
      reviewBase({ quality: recorded, taskDir: taskDir(), base: 'x' })
    ).toBe('x');
    expect(reviewBase({ quality: recorded, taskDir: taskDir() })).toBe('dev');
  });

  test('should default to the task folder for code, else main', () => {
    fs.mkdirSync(taskDir(), { recursive: true });
    const quality = { ...freshQuality(), base: null };
    expect(reviewBase({ quality, taskDir: taskDir() })).toBe('main');
    withCode();
    expect(reviewBase({ quality, taskDir: taskDir() })).toBeNull();
  });

  test('should stay on the task folder once a round chose it with --folder', () => {
    const stored = { ...freshQuality(), reviewRounds: 1, base: FOLDER_BASE };
    expect(
      reviewBase({ quality: { ...stored, phase: 'fix' }, taskDir: taskDir() })
    ).toBeNull();
    expect(
      reviewBase({
        quality: { ...stored, phase: 'review' },
        taskDir: taskDir(),
      })
    ).toBeNull();
    expect(reviewBase({ quality: stored, taskDir: taskDir(), base: 'x' })).toBe(
      'x'
    );
  });

  test('should review a page in docs/ from the task folder, but not a design doc', () => {
    touch(taskDir(), 'docs/design.md', 'docs/shot.png', 'data.json');
    expect(reviewBase({ quality: freshQuality(), taskDir: taskDir() })).toBe(
      'main'
    );
    touch(taskDir(), 'docs/index.html');
    expect(
      reviewBase({ quality: freshQuality(), taskDir: taskDir() })
    ).toBeNull();
  });

  test('should not count task scripts as the code under review', () => {
    fs.mkdirSync(path.join(taskDir(), 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir(), 'scripts', 'build.mjs'), '');
    expect(reviewBase({ quality: freshQuality(), taskDir: taskDir() })).toBe(
      'main'
    );
  });

  test('should review the repository of a repo task, even with task code', () => {
    withCode();
    expect(
      reviewBase({
        quality: freshQuality(),
        taskDir: taskDir(),
        repo: '/work/other',
      })
    ).toBe('main');
  });
});

describe('productFiles', () => {
  test('should list nothing for a missing task folder', () => {
    expect(productFiles(path.join(root, 'missing'))).toEqual([]);
    expect(hasProductCode(path.join(root, 'missing'))).toBe(false);
  });

  test('should count code in any language as product code, not config, docs, or data', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'data.json', 'app/config.yaml', 'docs/design.md');
    expect(hasProductCode(taskDir)).toBe(false);
    touch(taskDir, 'app/main.py');
    expect(hasProductCode(taskDir)).toBe(true);
  });

  test('should list task code and its config outside scripts/, docs/ included', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(
      taskDir,
      'scripts/x.mjs',
      'app/a.js',
      'app/main.py',
      'app/config.yaml',
      'docs/index.html',
      'docs/notes.md'
    );
    expect(productFiles(taskDir)).toEqual([
      'app/a.js',
      'app/config.yaml',
      'app/main.py',
      'docs/index.html',
    ]);
  });
});

describe('taskReviewScope', () => {
  test("should fall back to a task's scripts when they are its only work", () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'scripts', 'x.mjs'), '');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/scripts/x.mjs`],
    });
  });

  test('should fall back to helper scripts in any language, with their data', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'scripts/clean.py', 'data.json');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/data.json`, `tasks/${NAME}/scripts/clean.py`],
    });
  });

  test('should keep the task folder that --folder chose, beside git changes', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    touch(taskDir, 'scripts/clean.py');
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abc' : args[0] === 'diff' ? 'utils/x.js' : ''
    );
    const state = codeState({
      quality: {
        ...freshQuality(),
        phase: 'complete',
        reviewRounds: 1,
        base: FOLDER_BASE,
      },
    });

    expect(taskReviewScope({ rootDir: root, taskDir, state, runGit })).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/scripts/clean.py`],
    });
  });

  test('should keep an empty git scope when the task folder has no code', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' && args[1] !== '--is-ancestor' ? 'abc' : null
    );

    expect(
      taskReviewScope({ rootDir: root, taskDir, state: codeState(), runGit })
    ).toEqual({ base: 'main', since: 'abc', files: [] });
  });

  test('should keep an empty git scope when an explicit base was given', () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'scripts', 'x.mjs'), '');
    const runGit = vi.fn(() => 'abc');

    expect(
      taskReviewScope({
        rootDir: root,
        taskDir,
        state: codeState(),
        base: 'dev',
        runGit: (args) =>
          args[0] === 'diff' || args[0] === 'ls-files' ? '' : runGit(),
      }).files
    ).toEqual([]);
  });
});

describe('roundBase', () => {
  const folderScope = { base: null, since: null, files: ['a.js'] };

  test("should record a git scope's base as it is", () => {
    const scope = { base: 'main', since: 'abc', files: [] };
    expect(roundBase(scope, freshQuality(), true)).toBe('main');
  });

  test('should record a folder chosen now or by an earlier round', () => {
    expect(roundBase(folderScope, freshQuality(), true)).toBe(FOLDER_BASE);
    expect(
      roundBase(folderScope, { ...freshQuality(), base: FOLDER_BASE })
    ).toBe(FOLDER_BASE);
  });

  test('should leave an automatic folder scope unrecorded', () => {
    expect(roundBase(folderScope, freshQuality())).toBeNull();
  });
});

describe('taskFolderNotes', () => {
  const taskDir = () => path.join(root, 'tasks', NAME);
  const at = (/** @type {string} */ file) => `tasks/${NAME}/${file}`;

  test('should mark scope files pnpm task check skips and list the scripts left out', () => {
    touch(taskDir(), 'app/a.js', 'app/main.py', 'docs/index.html');
    touch(taskDir(), 'scripts/gen.sh');
    const scope = reviewScope({
      rootDir: root,
      taskDir: taskDir(),
      base: null,
    });

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({
      unchecked: [at('app/main.py'), at('docs/index.html')],
      aside: [at('scripts/gen.sh')],
    });
  });

  test('should list the folder code beside a git scope, without marks', () => {
    touch(taskDir(), 'scripts/gen.py', 'docs/notes.md');
    const scope = { base: 'main', since: 'abc', files: ['utils/a.js'] };

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({ unchecked: [], aside: [at('scripts/gen.py')] });
  });

  test('should say nothing for a missing task folder', () => {
    const scope = { base: 'main', since: 'abc', files: [] };

    expect(
      taskFolderNotes({ rootDir: root, taskDir: taskDir(), scope })
    ).toEqual({ unchecked: [], aside: [] });
  });
});

describe('scopeRoot', () => {
  test("should read task code from the workspace and git scopes from the task's repo", () => {
    const state = { ...codeState(), repo: '/work/other' };
    expect(scopeRoot(root, state, { base: null, since: null, files: [] })).toBe(
      root
    );
    expect(
      scopeRoot(root, state, { base: 'main', since: 'a', files: [] })
    ).toBe('/work/other');
    expect(
      scopeRoot(root, codeState(), { base: 'main', since: 'a', files: [] })
    ).toBe(root);
  });
});

describe('reviewScope with real git', () => {
  /** @type {string} */
  let repo;
  /** @param {string[]} args */
  const git = (args) =>
    String(
      spawnSync(
        'git',
        [
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@example.com',
          '-c',
          'core.hooksPath=',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: repo, encoding: 'utf-8' }
      ).stdout
    ).trim();
  /** @param {string} file */
  const commit = (file) => {
    fs.writeFileSync(path.join(repo, file), file);
    git(['add', file]);
    git(['commit', '-q', '-m', file]);
    return git(['rev-parse', 'HEAD']);
  };
  /** @param {string | null} startCommit */
  const scope = (startCommit) =>
    reviewScope({
      rootDir: root,
      taskDir: path.join(root, 'tasks', NAME),
      base: 'main',
      startCommit,
      repoDir: repo,
    });

  beforeEach(() => {
    repo = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'scope-git-'))
    );
    git(['init', '-q', '-b', 'main']);
    commit('base.js');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("should start at the task's first commit on a branch that carries other work", () => {
    git(['switch', '-q', '-c', 'feat/shared']);
    commit('other-task.js');
    const start = git(['rev-parse', 'HEAD']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: start,
      since: start,
      files: ['this-task.js'],
    });
  });

  test('should use the branch point when the task started before it', () => {
    const start = git(['rev-parse', 'HEAD']);
    commit('merged-elsewhere.js');
    git(['switch', '-q', '-c', 'feat/late']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: 'main',
      files: ['this-task.js'],
    });
  });

  test('should use the branch point when the start commit is not in history', () => {
    git(['switch', '-q', '-c', 'feat/abandoned']);
    const start = commit('abandoned.js');
    git(['switch', '-q', 'main']);
    git(['switch', '-q', '-c', 'feat/fresh']);
    commit('this-task.js');

    expect(scope(start)).toMatchObject({
      base: 'main',
      files: ['this-task.js'],
    });
  });

  test('should keep a repo folder named tasks/ in the scope', () => {
    fs.mkdirSync(path.join(repo, 'tasks'));
    git(['switch', '-q', '-c', 'feat/x']);
    commit(path.join('tasks', 'job.js'));

    expect(scope(null).files).toEqual(['tasks/job.js']);
  });
});

describe('reviewScope', () => {
  test("should use the task's code files without a base", () => {
    const taskDir = path.join(root, 'tasks', NAME);
    fs.mkdirSync(path.join(taskDir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'app', 'a.js'), '');
    fs.writeFileSync(path.join(taskDir, 'plan.md'), '');

    expect(reviewScope({ rootDir: root, taskDir, base: null })).toEqual({
      base: null,
      since: null,
      files: [`tasks/${NAME}/app/a.js`],
    });
  });

  test('should use changed and untracked files since the merge base, minus tasks/', () => {
    /** @type {import('../review.js').RunGit} */
    const runGit = vi.fn((args) => {
      if (args[0] === 'merge-base') return 'abc123';
      if (args[0] === 'diff') return 'utils/b.js\nutils/a.js';
      return 'utils/new.js\ntasks/x/n.js\n';
    });

    expect(
      reviewScope({ rootDir: root, taskDir: root, base: 'main', runGit })
    ).toEqual({
      base: 'main',
      since: 'abc123',
      files: ['utils/a.js', 'utils/b.js', 'utils/new.js'],
    });
    expect(runGit).toHaveBeenCalledWith(['merge-base', 'HEAD', 'main'], root);
    expect(runGit).toHaveBeenCalledWith(
      ['diff', '--name-only', 'abc123'],
      root
    );
  });

  test('should treat failed listings as no files', () => {
    const runGit = vi.fn((/** @type {string[]} */ args) =>
      args[0] === 'merge-base' ? 'abc' : null
    );

    expect(
      reviewScope({ rootDir: root, taskDir: root, base: 'main', runGit }).files
    ).toEqual([]);
  });

  test('should explain a base ref git cannot resolve', () => {
    expect(() =>
      reviewScope({
        rootDir: root,
        taskDir: root,
        base: 'nope',
        runGit: () => null,
      })
    ).toThrow(/merge base of HEAD and nope[^]*--base <ref>/);
  });
});

describe('defaultRunGit', () => {
  test('should return trimmed output, or null outside a repository', () => {
    expect(defaultRunGit(['--version'], root)).toMatch(/^git version/);
    expect(defaultRunGit(['rev-parse', 'HEAD'], root)).toBeNull();
  });
});

describe('fingerprint', () => {
  test('should change with content and mark deleted files', () => {
    fs.writeFileSync(path.join(root, 'a.js'), 'one');
    const first = fingerprint(root, ['a.js', 'gone.js']);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(root, ['gone.js', 'a.js'])).toBe(first);

    fs.writeFileSync(path.join(root, 'a.js'), 'two');
    expect(fingerprint(root, ['a.js', 'gone.js'])).not.toBe(first);
  });
});

describe('openRound', () => {
  const open = (
    /** @type {import('../state.js').TaskState} */ state,
    force = false
  ) => openRound(state, { fingerprint: 'fp', base: null, force });

  test('should open round 1 with the fingerprint', () => {
    const { state, round, reopened } = open(codeState());

    expect(round).toBe(1);
    expect(reopened).toBe(false);
    expect(state.quality).toMatchObject({
      phase: 'review',
      reviewRounds: 1,
      reviewedDiff: 'fp',
      base: null,
    });
  });

  test('should return an open round unchanged', () => {
    const state = codeState({
      quality: { ...freshQuality(), phase: 'review', reviewRounds: 1 },
    });

    expect(open(state)).toEqual({ state, round: 1, reopened: true });
  });

  test('should refuse a task that is not a code task', () => {
    const state = { ...codeState(), kind: /** @type {const} */ ('general') };

    expect(() => open(state)).toThrow(/not a code task[^]*--kind code/);
  });

  test('should start from a fresh quality state when the task has none', () => {
    const { quality: _q, ...state } = codeState();

    expect(open(state).round).toBe(1);
  });

  test('should refuse a third round', () => {
    const state = codeState({
      quality: { ...freshQuality(), phase: 'complete', reviewRounds: 2 },
    });

    expect(() => open(state)).toThrow(
      /2\/2 review rounds \(the limit\)[^]*--open/
    );
  });

  test('should refuse while confirmed must-fix/high findings are open', () => {
    const state = codeState({
      steps: [
        ...makeSteps(['Build']),
        { id: 's2', title: 'fix', status: 'done', deps: [], owner: null },
        { id: 's3', title: 'fix', status: 'todo', deps: [], owner: null },
      ],
      quality: {
        ...freshQuality(),
        phase: 'fix',
        reviewRounds: 1,
        findings: [
          finding({ id: 'a', step: 's2' }),
          finding({ id: 'b', step: 's3' }),
          finding({ id: 'c', step: null }),
        ],
      },
    });

    expect(() => open(state)).toThrow(/before the next review: s3, c/);
  });

  test('should open the next round once the fixes are done', () => {
    const state = codeState({
      steps: [
        { id: 's1', title: 'fix', status: 'done', deps: [], owner: null },
      ],
      quality: {
        ...freshQuality(),
        phase: 'fix',
        reviewRounds: 1,
        findings: [finding({ step: 's1' })],
      },
    });

    expect(open(state).round).toBe(2);
  });

  test('should require a green verify unless forced', () => {
    expect(() => open(codeState({ lastVerify: null }))).toThrow(
      /has not run[^]*--force/
    );
    expect(() =>
      open(codeState({ lastVerify: { ...GREEN, ok: false, failed: 'x' } }))
    ).toThrow(/last verify failed/);
    expect(open(codeState({ lastVerify: null }), true).round).toBe(1);
  });

  test('should refuse open steps unless forced, but not count fix steps', () => {
    const todo = codeState({ steps: makeSteps(['Build', 'Polish']) });
    expect(() => open(todo)).toThrow(
      /s1, s2 not done yet\.\nFix: .*pnpm task review --force/
    );
    expect(open(todo, true).round).toBe(1);
    const fixOpen = codeState({
      steps: [...codeState().steps, { ...makeSteps(['fix: x'])[0], id: 's2' }],
    });
    expect(open(fixOpen).round).toBe(1);
  });

  test('should not wait for steps that wait on someone else', () => {
    const waiting = codeState({
      steps: [
        ...codeState().steps,
        { ...makeSteps(['Upload'])[0], id: 's2', status: 'waiting' },
      ],
    });
    expect(open(waiting).round).toBe(1);
  });
});

describe('formatReviewBrief', () => {
  const scope = { base: null, since: null, files: [`tasks/${NAME}/a.js`] };

  test('should give the goal, plan, standards, scope, rubric, and output steps', () => {
    const text = formatReviewBrief({
      state: codeState({ e2e: 'required' }),
      round: 1,
      scope,
      taskRel: `tasks/${NAME}`,
    });

    expect(text).toContain(`# Review brief — ${NAME}, round 1/2`);
    expect(text).toContain('Goal: Ship it');
    expect(text).toContain(
      `Plan (acceptance, steps, decisions): tasks/${NAME}/plan.md`
    );
    expect(text).toContain('Standards: AGENTS.md;');
    expect(text).toContain('E2E: required');
    expect(text).toContain(
      `## Scope — 1 file(s), the task's code under tasks/${NAME}/`
    );
    expect(text).toContain(`- tasks/${NAME}/a.js`);
    expect(text).toContain(SEVERITY_RUBRIC);
    expect(text).toContain(`tasks/${NAME}/reviews/REVIEW_${NAME}-r1.md`);
    expect(text).toContain('3. Record: pnpm task review record');
    expect(text).not.toContain('## Earlier rounds');
    expect(text).not.toContain('pnpm task check does not');
    expect(text).not.toContain('## Also in the task folder');
  });

  test('should mark files pnpm task check skips and list code left out of scope', () => {
    const text = formatReviewBrief({
      state: codeState(),
      round: 1,
      scope: {
        base: null,
        since: null,
        files: [`tasks/${NAME}/a.js`, `tasks/${NAME}/main.py`],
      },
      taskRel: `tasks/${NAME}`,
      folder: {
        unchecked: [`tasks/${NAME}/main.py`],
        aside: [`tasks/${NAME}/scripts/gen.sh`],
      },
    });

    expect(text).toContain(`- tasks/${NAME}/a.js\n`);
    expect(text).toContain(
      `- tasks/${NAME}/main.py — pnpm task check does not lint or format it`
    );
    expect(text).toContain(
      `## Also in the task folder (not in scope)\n\nCode the scope leaves out`
    );
    expect(text).toContain(`- tasks/${NAME}/scripts/gen.sh\n`);
  });

  test('should describe a git scope and an empty one', () => {
    const { quality: _q, e2e: _e, ...state } = codeState();
    const text = formatReviewBrief({
      state,
      round: 1,
      scope: { base: 'main', since: '0123456789abcdef', files: [] },
      taskRel: `tasks/${NAME}`,
    });

    expect(text).toContain(
      'changes since main (commit 0123456789ab; see them with: git diff 0123456789ab -- <file>)'
    );
    expect(text).toContain('- (no files: nothing changed)');
    expect(text).toContain('E2E: no');
  });

  test('should list refuted and fixed findings from earlier rounds', () => {
    const state = codeState({
      quality: {
        ...freshQuality(),
        reviewRounds: 2,
        findings: [
          finding({
            id: 'r1-1',
            verdict: 'REFUTED',
            reason: 'Guarded by lock',
          }),
          finding({ id: 'r1-2', step: 's1', line: null }),
          finding({ id: 'r1-3', severity: 'low' }),
          finding({ id: 'r2-1', round: 2, verdict: 'REFUTED' }),
        ],
      },
    });

    const text = formatReviewBrief({ state, round: 2, scope, taskRel: 't' });

    expect(text).toContain(
      '- refuted r1-1 (app/a.js:3): Loses writes — Guarded by lock. Do not report it again without new evidence.'
    );
    expect(text).toContain(
      '- fixed r1-2 (app/a.js): Loses writes. Check that the fix holds.'
    );
    expect(text).not.toContain('r1-3');
    expect(text).not.toContain('r2-1');
  });
});

describe('findingsTemplate', () => {
  test('should hold an empty table that parses to no findings', () => {
    const text = findingsTemplate({ name: NAME, round: 1, brief: 'b.md' });

    expect(text).toContain('Brief: b.md');
    expect(parseFindings(text, { round: 1, takenIds: new Set() })).toEqual({
      findings: [],
      errors: [],
    });
  });
});

describe('splitRow', () => {
  test('should split cells and keep escaped pipes', () => {
    expect(splitRow('| a | b \\| c |  |')).toEqual(['a', 'b | c', '']);
  });
});

describe('parseFindings', () => {
  const parse = (/** @type {string} */ text, taken = new Set()) =>
    parseFindings(text, { round: 1, takenIds: taken });

  test('should parse triaged rows and number rows without an id', () => {
    const result = parse(
      table(
        '| r1-1 | `app/a.js:12` | High | Loses writes | two saves → one lost | confirmed | no lock |',
        '|  |  |  |  |  |  |  |',
        '| | app/b.js | low | Typo in name | reading the log | REFUTED | not a typo |',
        '| | app/c.js:4:9 | medium | Slow loop | 10k items → 5 s | CONFIRMED | measured |'
      ),
      new Set(['r1-2'])
    );

    expect(result.errors).toEqual([]);
    expect(result.findings).toEqual([
      finding({
        file: 'app/a.js',
        line: 12,
        scenario: 'two saves → one lost',
        reason: 'no lock',
      }),
      {
        id: 'r1-3',
        round: 1,
        file: 'app/b.js',
        line: null,
        severity: 'low',
        claim: 'Typo in name',
        scenario: 'reading the log',
        verdict: 'REFUTED',
        reason: 'not a typo',
        step: null,
      },
      expect.objectContaining({ id: 'r1-4', file: 'app/c.js', line: 4 }),
    ]);
  });

  test('should explain a missing table', () => {
    expect(parse('# nothing').errors).toEqual([
      `no findings table: the header must be | ${FINDINGS_HEADER.join(' | ')} |`,
    ]);
  });

  test('should report every problem in a row', () => {
    const result = parse(
      table(
        '| a | b |',
        '| r1-1 |  | huge |  |  |  |  |',
        '| r1-2 | a.js | high | c | s | MAYBE | r |',
        '| r1-3 | a.js | high | c | s | CONFIRMED |  |',
        '| r9 | a.js | high | c | s | CONFIRMED | r |'
      ),
      new Set(['r9'])
    );

    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([
      'row 1: 2 cells, expected 7 (escape | inside a cell as \\|)',
      'row 2 (r1-1): severity "huge" is not one of must-fix, high, medium, low; no verdict yet — run the triage first; claim is empty; failure scenario is empty; file:line is empty',
      'row 3 (r1-2): verdict "MAYBE" is not CONFIRMED or REFUTED',
      'row 4 (r1-3): the verdict needs a reason',
      'row 5 (r9): id r9 is already used',
    ]);
  });

  test('should report a row without an id by its number', () => {
    expect(parse(table('| | a.js | high | c | s |  |  |')).errors).toEqual([
      'row 1: no verdict yet — run the triage first',
    ]);
  });
});

describe('recordFindings', () => {
  const open = () =>
    codeState({
      quality: { ...freshQuality(), phase: 'review', reviewRounds: 1 },
    });

  test('should add a fix step per CONFIRMED must-fix/high finding and move to fix', () => {
    const { state, fixSteps } = recordFindings(open(), [
      finding({ id: 'a', severity: 'must-fix' }),
      finding({ id: 'b', severity: 'medium' }),
      finding({ id: 'c', verdict: 'REFUTED' }),
      finding({ id: 'd', line: null }),
    ]);

    expect(fixSteps.map((s) => s.title)).toEqual([
      'fix: Loses writes (app/a.js:3; a)',
      'fix: Loses writes (app/a.js; d)',
    ]);
    expect(state.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(state.quality?.phase).toBe('fix');
    expect(state.quality?.findings.map((f) => [f.id, f.step])).toEqual([
      ['a', 's2'],
      ['b', null],
      ['c', null],
      ['d', 's3'],
    ]);
  });

  test('should complete the loop when nothing needs fixing', () => {
    const { state, fixSteps } = recordFindings(open(), [
      finding({ severity: 'low' }),
    ]);

    expect(fixSteps).toEqual([]);
    expect(state.quality?.phase).toBe('complete');
  });

  test('should refuse without an open round', () => {
    expect(() => recordFindings(codeState(), [])).toThrow(
      /no open review round \(phase build\)/
    );
    const { quality: _q, ...bare } = codeState();
    expect(() => recordFindings(bare, [])).toThrow(/phase build/);
  });
});
