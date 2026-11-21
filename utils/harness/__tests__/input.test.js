import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  HARNESSES,
  TAIL_CHUNK_BYTES,
  agyInjectOutput,
  findLastLine,
  normalizeHookInput,
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

  test('should ignore CLAUDE_PROJECT_DIR in Codex and Antigravity, which may inherit it from a parent', () => {
    for (const harness of /** @type {const} */ (['codex', 'agy'])) {
      expect(
        projectDir({
          harness,
          env: { CLAUDE_PROJECT_DIR: '/parent' },
          rootDir: '/root',
        })
      ).toBe('/root');
    }
  });

  test('should fall back to the workspace root', () => {
    expect(projectDir({ harness: 'claude', env: {}, rootDir: '/root' })).toBe(
      '/root'
    );
  });
});

describe('normalizeHookInput', () => {
  test('should pass through objects for non-Antigravity harnesses and default non-objects to empty', () => {
    const raw = { session_id: 's1', prompt: 'hi' };
    expect(normalizeHookInput(raw)).toBe(raw);
    expect(normalizeHookInput(raw, 'codex')).toBe(raw);
    expect(normalizeHookInput(null, 'claude')).toEqual({});
    expect(normalizeHookInput([], 'agy')).toEqual({});
  });

  test('should map Antigravity camelCase fields while keeping snake_case and original fields', () => {
    expect(
      normalizeHookInput(
        {
          conversationId: 'agy-1',
          transcriptPath: '/t.jsonl',
          hookEventName: 'PreToolUse',
          lastUserInput: 'hello',
          toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
          error: 'boom',
          invocationNum: 0,
        },
        'agy'
      )
    ).toMatchObject({
      session_id: 'agy-1',
      transcript_path: '/t.jsonl',
      hook_event_name: 'PreToolUse',
      prompt: 'hello',
      tool_name: 'run_command',
      tool_input: { CommandLine: 'ls' },
      tool_response: { error: 'boom' },
      invocationNum: 0,
    });
    expect(
      normalizeHookInput(
        {
          session_id: 'kept',
          conversationId: 'ignored',
          toolCall: null,
          error: '',
        },
        'agy'
      )
    ).toEqual({
      session_id: 'kept',
      conversationId: 'ignored',
      toolCall: null,
      error: '',
    });
  });
});

describe('agyInjectOutput', () => {
  test('should wrap text as an Antigravity injectSteps systemMessage with optional user_markdown', () => {
    expect(agyInjectOutput('hello')).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: 'hello' } }],
    });
    expect(agyInjectOutput('hello', '**warn**')).toEqual({
      injectSteps: [
        {
          systemMessage: {
            systemMessage: 'hello',
            metadata: { user_markdown: '**warn**' },
          },
        },
      ],
    });
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
      ['rtk apply_patch'],
      ['rtk proxy apply_patch'],
      ['rtk bypass applypatch'],
      ['rtk -vv --ultra-compact proxy apply_patch'],
      ['/opt/homebrew/bin/rtk proxy apply_patch'],
      [`rtk proxy bash -lc "apply_patch`],
      [`bash -lc "rtk proxy apply_patch`],
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
      expect(event(`cd sub && rtk proxy apply_patch ${body}`).dir).toBe('sub');
    });

    test('should read an argv-style command as one line', () => {
      const command = ['bash', '-lc', `cd sub && apply_patch ${body}`];
      expect(
        toolEvent({ tool_name: 'Bash', tool_input: { command } })
      ).toMatchObject({ kind: 'edit', dir: 'sub' });
    });

    test.each([
      [`env apply_patch ${body}`],
      [`FOO=1 apply_patch ${body}`],
      [`true && apply_patch ${body}`],
      [`cd a && cd b && apply_patch ${body}`],
      [`(cd x && apply_patch ${body})`],
      [`rtk run "apply_patch ${body}"`],
      [`bash -lc "ls && apply_patch ${body}`],
      [`echo apply_patch ${body}`],
    ])(
      'should treat any other command with apply_patch and a patch as an edit: %s',
      (command) => {
        expect(event(command)).toMatchObject({
          kind: 'edit',
          files: ['x.txt'],
        });
      }
    );

    test('should keep the cd dirs before a wrapped apply_patch', () => {
      expect(event(`cd secrets && env apply_patch ${body}`).dir).toBe(
        'secrets'
      );
      expect(event(`cd a && cd 'b c' && true && apply_patch ${body}`).dir).toBe(
        'a/b c'
      );
      expect(event(`cd a; cd /abs && env apply_patch ${body}`).dir).toBe(
        '/abs'
      );
      expect(event(`cd a && cd ~/x && env apply_patch ${body}`).dir).toBe(
        '~/x'
      );
      expect(event(`env apply_patch ${body}`).dir).toBeUndefined();
      expect(event(`env apply_patch ${body} && cd later`).dir).toBeUndefined();
    });

    test('should not treat other commands as patches', () => {
      expect(event(`bash -x apply_patch`).kind).toBe('shell');
      expect(event(`cat notes.md <<'EOF'\n*** Begin Patch\nEOF`).kind).toBe(
        'shell'
      );
      expect(event('grep -n apply_patch input.js').kind).toBe('shell');
      expect(event('rtk read apply_patch.md').kind).toBe('shell');
      expect(event('rtkx apply_patch').kind).toBe('shell');
      // With a patch these still apply it, so they are edits (no cd dir).
      expect(event(`rtk read apply_patch ${body}`).dir).toBeUndefined();
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

  test('should read Antigravity tools from normalized or raw toolCall payloads', () => {
    expect(
      toolEvent({
        toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test' } },
      })
    ).toEqual({
      kind: 'shell',
      name: 'run_command',
      command: 'pnpm test',
      files: [],
    });
    for (const [name, args] of [
      ['edit_file', { Path: 'a.js' }],
      ['write_file', { Path: 'a.js' }],
      ['write_to_file', { TargetFile: 'a.js' }],
      ['replace_file_content', { TargetFile: 'a.js' }],
      ['multi_replace_file_content', { TargetFile: 'a.js' }],
      ['sed_file', { Path: 'a.js' }],
      ['notebook_edit', { Path: 'a.js' }],
    ]) {
      expect(toolEvent({ toolCall: { name, args } })).toMatchObject({
        kind: 'edit',
        files: ['a.js'],
      });
    }
    for (const [name, args] of [
      ['read_file', { Path: '.env' }],
      ['view_file', { AbsolutePath: '.env' }],
    ]) {
      expect(toolEvent({ toolCall: { name, args } })).toMatchObject({
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

  test("should read Antigravity's newest PLANNER_RESPONSE token usage", () => {
    const file = writeLines('agy.jsonl', [
      { type: 'PLANNER_RESPONSE', input_tokens: 100, cache_read_tokens: 200 },
      { type: 'PLANNER_RESPONSE', input_tokens: 2406, cache_read_tokens: 6837 },
      { type: 'GENERIC', status: 'DONE' },
    ]);
    expect(transcriptUsage(file, 'agy')).toEqual({
      tokens: 9243,
      window: null,
    });
    const partial = writeLines('agy-partial.jsonl', [
      { type: 'PLANNER_RESPONSE', cache_read_tokens: 500 },
    ]);
    expect(transcriptUsage(partial, 'agy')).toEqual({
      tokens: 500,
      window: null,
    });
    const inputOnly = writeLines('agy-input.jsonl', [
      { type: 'PLANNER_RESPONSE', input_tokens: 300 },
    ]);
    expect(transcriptUsage(inputOnly, 'agy')).toEqual({
      tokens: 300,
      window: null,
    });
  });

  test('should return null without usage, without a transcript, and for DSH', () => {
    const file = writeLines('t.jsonl', [{ type: 'user' }]);
    expect(transcriptUsage(file, 'claude')).toBeNull();
    expect(transcriptUsage(file, 'codex')).toBeNull();
    expect(transcriptUsage(file, 'agy')).toBeNull();
    expect(transcriptUsage(undefined, 'claude')).toBeNull();
    expect(transcriptUsage('', 'codex')).toBeNull();
    expect(transcriptUsage(file, 'dsh')).toBeNull();
  });
});
