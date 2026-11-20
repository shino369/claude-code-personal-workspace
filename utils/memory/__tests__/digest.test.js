/**
 * Tests for utils/memory/digest.js (task digests and --learn lines)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_FILE, DEFAULT_CONFIG, writeConfig } from '../config.js';
import {
  digestTags,
  digestText,
  formatTaskMemory,
  lastOpen,
  learnedNotes,
  repoLabel,
  saveTaskMemory,
} from '../digest.js';
import { AGENTS_LOCAL_FILE } from '../render.js';
import { MemoryError, loadNotes, memoryDir } from '../store.js';

/** @type {string} */
let root;
/** @type {string} */
let dir;

const NOW = new Date('2026-11-20T12:00:00.000Z');
const LATER = new Date('2026-11-27T12:00:00.000Z');
const ENV = { TASK_AGENT: 'claude', TASK_SESSION: 'sess-1' };
const TASK = 'cws-auto-publish-261120';
const SECRET = `ghp_${'a1B2'.repeat(8)}`;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'memory-digest-'))
  );
  dir = memoryDir(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const notes = () => loadNotes(dir).notes;

/**
 * A git checkout under `root` whose origin is `me/<name>`.
 *
 * @param {string} name
 */
function checkout(name) {
  const top = path.join(root, `${name}-checkout`);
  fs.mkdirSync(path.join(top, '.git'), { recursive: true });
  fs.writeFileSync(
    path.join(top, '.git', 'config'),
    `[remote "origin"]\n\turl = git@github.com:me/${name}.git\n`
  );
  return top;
}

const NOTES = `# Notes

## 2026-11-19 10:00 — claude

Done: first pass.
Next: tests.
Open: an old question

## 2026-11-20 09:00 — claude

Done: shipped it.
State: branch main; uncommitted no; verify pass
Next: close the task.
Open: the store review takes a week

## 2026-11-20 09:30 — claude (step s3 done)

s3. publish → done
`;

describe('lastOpen', () => {
  test('should take Open from the last session note', () => {
    expect(lastOpen(NOTES)).toBe('the store review takes a week');
  });

  test('should be null when the last session note has no Open', () => {
    expect(lastOpen('## a\n\nDone: x\nNext: y\n')).toBeNull();
  });

  test.each(['none', 'None.', 'n/a', '-', '—'])(
    'should treat Open: %s as nothing open',
    (value) => {
      expect(lastOpen(`## a\n\nDone: x\nOpen: ${value}\n`)).toBeNull();
    }
  );

  test('should be null without session notes', () => {
    expect(lastOpen('## a (step s1 done)\n\ns1 → done\n')).toBeNull();
  });

  test('should be null without notes', () => {
    expect(lastOpen(null)).toBeNull();
  });
});

describe('digestText', () => {
  test('should join the goal, repo, outcome, open items, and lessons', () => {
    expect(
      digestText({
        goal: 'Publish releases to the Chrome Web Store',
        repo: 'web',
        outcome: 'Release runs submit the zip',
        open: 'the store review takes a week',
        learned: ['The API needs a refresh token.', 'Uploads take a minute'],
      })
    ).toBe(
      'Publish releases to the Chrome Web Store. Repo: web. Outcome: Release runs submit the zip. Open: the store review takes a week. Learned: The API needs a refresh token. Uploads take a minute.'
    );
  });

  test('should leave out the parts that are empty', () => {
    expect(digestText({ goal: 'Translate the post!' })).toBe(
      'Translate the post!'
    );
  });

  test('should stay within the note limit', () => {
    const text = digestText({ goal: 'g', outcome: 'word '.repeat(400) });

    expect(text).toHaveLength(1000);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('digestTags', () => {
  test('should tag the task name without its date and the repo', () => {
    expect(digestTags(TASK, 'web')).toEqual(['cws-auto-publish', 'web']);
  });

  test('should leave out a missing repo', () => {
    expect(digestTags('notes', null)).toEqual(['notes']);
  });
});

describe('repoLabel', () => {
  test('should name a git checkout by its origin', () => {
    expect(repoLabel(checkout('web'))).toBe('web');
  });

  test('should fall back to the folder name outside git', () => {
    const plain = path.join(root, 'plain-folder');
    fs.mkdirSync(plain);

    expect(repoLabel(plain)).toBe('plain-folder');
  });
});

describe('learnedNotes', () => {
  test('should make machine facts with the task as the source', () => {
    expect(
      learnedNotes(['The proxy blocks GraphQL.'], {
        env: ENV,
        rootDir: root,
        task: TASK,
      })
    ).toEqual([
      {
        text: 'The proxy blocks GraphQL.',
        scope: 'machine',
        repo: null,
        type: 'fact',
        source: {
          via: 'agent',
          harness: 'claude',
          session: 'sess-1',
          task: TASK,
        },
      },
    ]);
  });

  test('should make repo facts for a task in another repository', () => {
    const [input] = learnedNotes(['Deploys run on tags.'], {
      env: ENV,
      rootDir: root,
      task: TASK,
      repoDir: checkout('web'),
    });

    expect(input).toMatchObject({ scope: 'repo', repo: 'web' });
  });

  test('should refuse an invalid line, naming it by number', () => {
    expect(() =>
      learnedNotes(['Fine.', '   '], { env: ENV, rootDir: root, task: TASK })
    ).toThrow('--learn line 2: The note text is empty.');
  });

  test('should refuse a secret without echoing it', () => {
    /** @type {unknown} */
    let error;
    try {
      learnedNotes([`token ${SECRET}`], {
        env: ENV,
        rootDir: root,
        task: TASK,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MemoryError);
    expect(/** @type {MemoryError} */ (error).code).toBe('secret');
    expect(String(/** @type {Error} */ (error).message)).not.toContain(SECRET);
  });
});

describe('saveTaskMemory', () => {
  const digest = {
    goal: 'Publish releases to the store',
    repoDir: null,
    notes: NOTES,
    outcome: 'Release runs submit the zip.',
  };

  test('should do nothing without a digest or lessons', () => {
    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
    });

    expect(result).toEqual({
      digest: null,
      learned: [],
      off: null,
      warnings: [],
    });
    expect(fs.existsSync(dir)).toBe(false);
  });

  test('should add a digest and the lessons, then refresh the core block', () => {
    const learned = learnedNotes(['Uploads take a minute.'], {
      env: ENV,
      rootDir: root,
      task: TASK,
    });

    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
      learned,
      digest,
    });

    expect(result.learned).toMatchObject([
      { action: 'added', note: { id: 'm1' } },
    ]);
    expect(result.digest).toMatchObject({
      action: 'added',
      note: {
        id: 't2',
        scope: 'machine',
        type: 'episode',
        tags: ['cws-auto-publish'],
        source: { via: 'digest', task: TASK },
        text: 'Publish releases to the store. Outcome: Release runs submit the zip. Open: the store review takes a week. Learned: Uploads take a minute.',
      },
    });
    expect(
      fs.readFileSync(path.join(root, AGENTS_LOCAL_FILE), 'utf-8')
    ).toMatch(/### Recent tasks/);
  });

  test('should save lessons without a digest (pnpm task note --learn)', () => {
    const learned = learnedNotes(['Uploads take a minute.'], {
      env: ENV,
      rootDir: root,
      task: TASK,
    });

    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
      learned,
    });

    expect(result.digest).toBeNull();
    expect(notes().map((note) => note.id)).toEqual(['m1']);
  });

  test('should name the repo of a task in another repository', () => {
    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
      digest: { ...digest, repoDir: checkout('web') },
    });

    expect(result.digest?.note).toMatchObject({
      tags: ['cws-auto-publish', 'web'],
      text: expect.stringContaining('Repo: web.'),
    });
  });

  test('should replace the digest when a reopened task closes again', () => {
    saveTaskMemory({ rootDir: root, env: ENV, now: NOW, task: TASK, digest });

    const again = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: LATER,
      task: TASK,
      digest: { ...digest, outcome: 'Also publishes betas.' },
    });

    expect(again.digest).toMatchObject({
      action: 'replaced',
      note: { id: 't1' },
    });
    expect(notes()).toHaveLength(1);
    expect(notes()[0].text).toMatch(/Outcome: Also publishes betas\./);
  });

  test('should keep digests of similar tasks apart', () => {
    saveTaskMemory({ rootDir: root, env: ENV, now: NOW, task: TASK, digest });

    saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: 'cws-auto-publish-261201',
      digest,
    });

    expect(notes().map((note) => note.id)).toEqual(['t1', 't2']);
  });

  test('should save nothing while saving is off', () => {
    writeConfig(dir, { ...DEFAULT_CONFIG, offSessions: ['sess-1'] });

    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
      digest,
    });

    expect(result).toMatchObject({ off: 'session', digest: null });
    expect(notes()).toEqual([]);
  });

  test('should warn instead of throwing when memory cannot be written', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CONFIG_FILE), '{oops');

    const result = saveTaskMemory({
      rootDir: root,
      env: ENV,
      now: NOW,
      task: TASK,
      digest,
    });

    expect(result.warnings).toEqual([
      expect.stringMatching(
        /^Memory not saved: memory\/config\.json is not valid JSON/
      ),
    ]);
  });

  test('should save into the main checkout from a linked worktree', () => {
    const main = path.join(root, 'main');
    const wtGit = path.join(main, '.git', 'worktrees', 'x');
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGit}\n`);

    saveTaskMemory({ rootDir: wt, env: ENV, now: NOW, task: TASK, digest });

    expect(loadNotes(memoryDir(main)).notes).toHaveLength(1);
    expect(fs.existsSync(memoryDir(wt))).toBe(false);
  });
});

describe('formatTaskMemory', () => {
  /** @type {import('../store.js').Note} */
  const note = {
    id: 't3',
    scope: 'machine',
    repo: null,
    type: 'episode',
    text: 'Publish releases.',
    tags: [],
    triggers: [],
    source: { via: 'digest', task: TASK },
    pinned: false,
    supersedes: null,
    created: '2026-11-20',
    updated: '2026-11-20',
    checked: '2026-11-20',
    status: 'active',
  };
  const lesson = {
    ...note,
    id: 'm4',
    type: 'fact',
    text: 'Uploads take a minute.',
  };

  test('should announce the lessons and the digest', () => {
    expect(
      formatTaskMemory({
        digest: { action: 'added', note },
        learned: [{ action: 'added', note: lesson }],
        off: null,
        warnings: ['The core block is over 3000 characters.'],
      })
    ).toEqual([
      'Saved to memory: m4 (machine, fact) Uploads take a minute.',
      'Saved to memory: t3 (task digest) Publish releases.',
      'Warning: The core block is over 3000 characters.',
    ]);
  });

  test('should say a digest was replaced', () => {
    expect(
      formatTaskMemory({
        digest: { action: 'replaced', note },
        learned: [],
        off: null,
        warnings: [],
      })
    ).toEqual([
      'Updated memory: t3 (task digest, replaces the earlier one) Publish releases.',
    ]);
  });

  test.each([
    ['global', 'everywhere'],
    ['session', 'for this session'],
  ])('should say saving is off (%s)', (off, where) => {
    expect(
      formatTaskMemory({
        digest: null,
        learned: [],
        off: /** @type {'global' | 'session'} */ (off),
        warnings: [],
      })
    ).toEqual([
      `Memory saving is off ${where}: nothing was saved to memory (pnpm memory on).`,
    ]);
  });

  test('should print nothing when nothing was saved', () => {
    expect(
      formatTaskMemory({ digest: null, learned: [], off: null, warnings: [] })
    ).toEqual([]);
  });
});
