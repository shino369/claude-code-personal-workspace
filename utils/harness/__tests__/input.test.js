import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HARNESSES,
  TAIL_CHUNK_BYTES,
  findLastLine,
  parseHarness,
  patchFiles,
  projectDir,
  toolEvent,
  transcriptUsage,
} from '../input.js';

/** @type {string} */
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-input-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {string} name
 * @param {unknown[]} entries JSON values, or raw strings written as they are
 */
function writeLines(name, entries) {
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    entries
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .join('\n')
  );
  return file;
}

describe('parseHarness', () => {
  test('should read --harness for each known harness', () => {
    for (const harness of HARNESSES) {
      expect(parseHarness(['node', 'x.js', '--harness', harness])).toBe(
        harness
      );
    }
  });

  test('should default to claude when the flag is missing or unknown', () => {
    expect(parseHarness(['node', 'x.js'])).toBe('claude');
    expect(parseHarness(['node', 'x.js', '--harness'])).toBe('claude');
    expect(parseHarness(['node', 'x.js', '--harness', 'vim'])).toBe('claude');
  });
});

describe('projectDir', () => {
  test('should use CLAUDE_PROJECT_DIR in Claude Code and DSH (the bridge sets it)', () => {
    const env = { CLAUDE_PROJECT_DIR: '/proj' };
    expect(projectDir({ harness: 'claude', env, rootDir: '/root' })).toBe(
      '/proj'
    );
    expect(projectDir({ harness: 'dsh', env, rootDir: '/root' })).toBe('/proj');
  });

  test('should ignore CLAUDE_PROJECT_DIR in Codex, which may inherit it from a parent', () => {
    expect(
      projectDir({
        harness: 'codex',
        env: { CLAUDE_PROJECT_DIR: '/parent' },
        rootDir: '/root',
      })
    ).toBe('/root');
  });

  test('should fall back to the workspace root', () => {
    expect(projectDir({ harness: 'claude', env: {}, rootDir: '/root' })).toBe(
      '/root'
    );
  });
});

describe('patchFiles', () => {
  test('should list the files a patch adds, updates, deletes, and moves to', () => {
    const patch = [
      "apply_patch <<'EOF'",
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+hello',
      '*** Update File: src/a.js',
      '*** Move to: src/b.js',
      '@@',
      '-x',
      '+y',
      '*** Delete File: old.txt',
      '*** Update File: src/a.js',
      '*** End Patch',
      'EOF',
    ].join('\n');
    expect(patchFiles(patch)).toEqual([
      'docs/new.md',
      'src/a.js',
      'src/b.js',
      'old.txt',
    ]);
  });

  test('should handle CRLF line ends and trailing spaces', () => {
    expect(patchFiles('*** Update File: a.js  \r\n*** End Patch\r\n')).toEqual([
      'a.js',
    ]);
  });

  test('should accept indented headers and skip empty ones', () => {
    expect(
      patchFiles(
        '  *** Add File: a.js\n\t*** Update File:   b.js \n*** Add File: '
      )
    ).toEqual(['a.js', 'b.js']);
  });

  test('should parse a 200k-character decoy line in linear time', () => {
    const decoy = `*** Add File: a${' '.repeat(200_000)}b`;
    const start = performance.now();
    expect(patchFiles(decoy)).toEqual([`a${' '.repeat(200_000)}b`]);
    expect(patchFiles(`*** Add File: a${' '.repeat(200_000)}`)).toEqual(['a']);
    expect(performance.now() - start).toBeLessThan(100);
  });

  test('should return nothing for text that is not a patch', () => {
    expect(patchFiles('echo hi')).toEqual([]);
    expect(patchFiles(undefined)).toEqual([]);
  });
});

describe('toolEvent', () => {
  test('should read a Claude or Codex Bash call as a shell command', () => {
    expect(
      toolEvent({ tool_name: 'Bash', tool_input: { command: 'ls -la' } })
    ).toEqual({ kind: 'shell', name: 'Bash', command: 'ls -la', files: [] });
  });

  test('should read DSH shell tools as shell commands', () => {
    for (const name of ['bash', 'pwsh']) {
      expect(
        toolEvent({ tool_name: name, tool_input: { command: 'ls' } })
      ).toMatchObject({ kind: 'shell', command: 'ls' });
    }
  });

  test('should join an argv-style command', () => {
    expect(
      toolEvent({
        tool_name: 'Bash',
        tool_input: { command: ['git', 'status'] },
      })
    ).toMatchObject({ kind: 'shell', command: 'git status' });
  });

  test("should read Codex's shell-run apply_patch as an edit of the patch's files", () => {
    const command =
      "apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\nEOF";
    expect(toolEvent({ tool_name: 'Bash', tool_input: { command } })).toEqual({
      kind: 'edit',
      name: 'Bash',
      command,
      files: ['hello.txt'],
    });
  });

  describe('Codex apply_patch forms (codex-rs/apply-patch invocation.rs)', () => {
    const body =
      "<<'EOF'\n*** Begin Patch\n*** Add File: x.txt\n+hi\n*** End Patch\nEOF";
    /** @param {string} command */
    const event = (command) =>
      toolEvent({ tool_name: 'Bash', tool_input: { command } });

    test.each([
      ['apply_patch'],
      ['applypatch'],
      ['  APPLY_PATCH'],
      [`bash -lc "apply_patch`],
      [`bash -c 'applypatch`],
      [`zsh -lc "apply_patch`],
      [`/bin/sh -c "apply_patch`],
      [`C:\\Git\\bin\\bash.exe -lc "apply_patch`],
      [`pwsh -NoProfile -Command "apply_patch`],
      [`powershell -Command apply_patch`],
      [`cmd /c apply_patch`],
    ])('should treat %s as an edit', (prefix) => {
      expect(event(`${prefix} ${body}`)).toMatchObject({
        kind: 'edit',
        files: ['x.txt'],
      });
      expect(event(`${prefix} ${body}`).dir).toBeUndefined();
    });

    test('should read a leading cd as the directory the paths are relative to', () => {
      expect(event(`cd sub && apply_patch ${body}`)).toMatchObject({
        kind: 'edit',
        files: ['x.txt'],
        dir: 'sub',
      });
      expect(event(`bash -lc "cd 'my dir' && applypatch ${body}`).dir).toBe(
        'my dir'
      );
      expect(event(`bash -lc 'cd "../up"&&apply_patch ${body}`).dir).toBe(
        '../up'
      );
    });

    test('should read an argv-style command as one line', () => {
      const command = ['bash', '-lc', `cd sub && apply_patch ${body}`];
      expect(
        toolEvent({ tool_name: 'Bash', tool_input: { command } })
      ).toMatchObject({ kind: 'edit', dir: 'sub' });
    });

    test('should not treat other commands as patches', () => {
      expect(event(`echo apply_patch ${body}`).kind).toBe('shell');
      expect(event(`bash -lc "ls && apply_patch ${body}`).kind).toBe('shell');
      expect(event(`bash -x apply_patch`).kind).toBe('shell');
    });
  });

  test('should read the apply_patch tool of Codex (command) and DSH (input)', () => {
    const patch = '*** Begin Patch\n*** Update File: a.js\n*** End Patch';
    expect(
      toolEvent({ tool_name: 'apply_patch', tool_input: { command: patch } })
    ).toMatchObject({ kind: 'edit', files: ['a.js'] });
    expect(
      toolEvent({ tool_name: 'apply_patch', tool_input: { input: patch } })
    ).toMatchObject({ kind: 'edit', files: ['a.js'] });
  });

  test('should read file edits by their path in each harness', () => {
    const cases = [
      ['Edit', { file_path: 'a.js' }],
      ['Write', { file_path: 'a.js' }],
      ['MultiEdit', { file_path: 'a.js' }],
      ['NotebookEdit', { notebook_path: 'a.js' }],
      ['edit', { file_path: 'a.js' }],
      ['write', { file_path: 'a.js' }],
      ['str_replace_editor', { command: 'str_replace', path: 'a.js' }],
    ];
    for (const [name, input] of cases) {
      expect(toolEvent({ tool_name: name, tool_input: input })).toMatchObject({
        kind: 'edit',
        files: ['a.js'],
      });
    }
  });

  test('should read file reads by their path', () => {
    for (const [name, input] of [
      ['Read', { file_path: '.env' }],
      ['read', { file_path: '.env' }],
      ['str_replace_editor', { command: 'view', path: '.env' }],
    ]) {
      expect(toolEvent({ tool_name: name, tool_input: input })).toMatchObject({
        kind: 'read',
        files: ['.env'],
      });
    }
  });

  test('should read other tools, and malformed input, as other', () => {
    expect(toolEvent({ tool_name: 'WebFetch', tool_input: {} })).toEqual({
      kind: 'other',
      name: 'WebFetch',
      command: '',
      files: [],
    });
    expect(
      toolEvent({ tool_name: 'Edit', tool_input: { file_path: 3 } })
    ).toMatchObject({ kind: 'edit', files: [] });
    expect(toolEvent({})).toMatchObject({ kind: 'other', name: '' });
    expect(toolEvent(null)).toMatchObject({ kind: 'other', name: '' });
  });
});

describe('findLastLine', () => {
  test('should return the newest line that matches', () => {
    const file = writeLines('t.jsonl', [
      { n: 1, ok: true },
      { n: 2, ok: true },
      { n: 3 },
    ]);
    expect(findLastLine(file, (e) => e.ok === true)).toEqual({
      n: 2,
      ok: true,
    });
  });

  test('should skip lines that are not JSON, such as a half-written last line', () => {
    const file = writeLines('t.jsonl', [{ ok: true }, '{"ok": tr']);
    expect(findLastLine(file, (e) => e.ok === true)).toEqual({ ok: true });
  });

  test('should find a line across chunk boundaries, with multi-byte text', () => {
    const big = 'é'.repeat(TAIL_CHUNK_BYTES);
    const file = writeLines('t.jsonl', [
      { ok: true, text: `日本語 ${big}` },
      { text: big },
      { text: big },
    ]);
    expect(findLastLine(file, (e) => e.ok === true)?.text).toBe(
      `日本語 ${big}`
    );
  });

  test('should return null when nothing matches, or the file is missing', () => {
    const file = writeLines('t.jsonl', [{ n: 1 }]);
    expect(findLastLine(file, (e) => e.ok === true)).toBeNull();
    expect(findLastLine(path.join(dir, 'none.jsonl'), () => true)).toBeNull();
    expect(findLastLine(writeLines('empty.jsonl', []), () => true)).toBeNull();
  });
});

describe('transcriptUsage', () => {
  test('should sum the newest Claude assistant usage and leave the window to config', () => {
    const file = writeLines('claude.jsonl', [
      { type: 'assistant', message: { usage: { input_tokens: 1 } } },
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 30,
          },
        },
      },
      { type: 'user', message: { content: 'hi' } },
    ]);
    expect(transcriptUsage(file, 'claude')).toEqual({
      tokens: 240,
      window: null,
    });
  });

  test('should count missing Claude usage fields as zero', () => {
    const file = writeLines('claude.jsonl', [
      { type: 'assistant', message: { usage: { output_tokens: 5 } } },
    ]);
    expect(transcriptUsage(file, 'claude')).toEqual({
      tokens: 0,
      window: null,
    });
  });

  test("should read Codex's newest token_count with its context window", () => {
    const file = writeLines('rollout.jsonl', [
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 100 },
            model_context_window: 258400,
          },
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { total_tokens: 18669 },
            model_context_window: 258400,
          },
        },
      },
      { type: 'event_msg', payload: { type: 'token_count', info: null } },
      { type: 'response_item', payload: { type: 'message' } },
    ]);
    expect(transcriptUsage(file, 'codex')).toEqual({
      tokens: 18669,
      window: 258400,
    });
  });

  test('should report no Codex window when the rollout lacks one', () => {
    const file = writeLines('rollout.jsonl', [
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { total_tokens: 7 } },
        },
      },
    ]);
    expect(transcriptUsage(file, 'codex')).toEqual({ tokens: 7, window: null });
  });

  test('should return null without usage, without a transcript, and for DSH', () => {
    const file = writeLines('t.jsonl', [{ type: 'user' }]);
    expect(transcriptUsage(file, 'claude')).toBeNull();
    expect(transcriptUsage(file, 'codex')).toBeNull();
    expect(transcriptUsage(undefined, 'claude')).toBeNull();
    expect(transcriptUsage('', 'codex')).toBeNull();
    expect(transcriptUsage(file, 'dsh')).toBeNull();
  });
});
