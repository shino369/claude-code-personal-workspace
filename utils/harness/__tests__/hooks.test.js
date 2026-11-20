import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '#utils/workspace-config.js';
import {
  HOOKS,
  diffEntries,
  hookCommand,
  hookEntries,
  readHookEntries,
  renderHooksConfig,
} from '../hooks.js';

/** @param {string} file */
const readJson = (file) =>
  JSON.parse(fs.readFileSync(path.join(ROOT_DIR, file), 'utf-8'));

describe('hookCommand', () => {
  const spec = { id: 'x', script: '.claude/hooks/x.js', timeout: 5 };

  test('should run the script from the project dir in Claude Code', () => {
    expect(hookCommand('claude', spec)).toBe(
      'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.js --harness claude'
    );
  });

  test('should give DSH the braced token its bridge replaces, inside one quoted path (pwsh on Windows reads no env var as $NAME)', () => {
    expect(hookCommand('dsh', spec)).toBe(
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.js" --harness dsh'
    );
    expect(hookCommand('dsh', { ...spec, args: ['--reset'] })).toBe(
      'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.js" --reset --harness dsh'
    );
  });

  test('should find the script from the git top level in Codex, which sets no project dir', () => {
    expect(hookCommand('codex', spec)).toBe(
      'node "$(git rev-parse --show-toplevel)/.claude/hooks/x.js" --harness codex'
    );
  });

  test('should put script arguments before the harness flag', () => {
    expect(hookCommand('claude', { ...spec, args: ['--reset'] })).toBe(
      'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.js --reset --harness claude'
    );
  });
});

describe('hookEntries', () => {
  test('should list one entry per placement, with the spec timeout unless overridden', () => {
    const specs = [
      {
        id: 'a',
        script: 'a.js',
        timeout: 5,
        claude: [
          { event: 'Stop' },
          { event: 'PreToolUse', matcher: 'Bash', timeout: 9 },
        ],
      },
      { id: 'b', script: 'b.js', timeout: 7, codex: [{ event: 'Stop' }] },
    ];
    expect(hookEntries('claude', specs)).toEqual([
      {
        event: 'Stop',
        matcher: null,
        command: 'node "$CLAUDE_PROJECT_DIR"/a.js --harness claude',
        timeout: 5,
      },
      {
        event: 'PreToolUse',
        matcher: 'Bash',
        command: 'node "$CLAUDE_PROJECT_DIR"/a.js --harness claude',
        timeout: 9,
      },
    ]);
    expect(hookEntries('dsh', specs)).toEqual([]);
  });

  test('should give every spec a unique id and a script that exists', () => {
    const ids = HOOKS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of HOOKS) {
      expect(fs.existsSync(path.join(ROOT_DIR, spec.script))).toBe(true);
    }
  });
});

describe('renderHooksConfig', () => {
  const specs = [
    {
      id: 'a',
      script: 'a.js',
      timeout: 5,
      codex: [{ event: 'SessionStart', matcher: 'startup' }, { event: 'Stop' }],
    },
    {
      id: 'b',
      script: 'b.js',
      timeout: 6,
      codex: [
        { event: 'SessionStart', matcher: 'startup' },
        { event: 'PreToolUse', matcher: 'Bash' },
      ],
    },
  ];

  test('should group entries by event, in manifest order, and by matcher', () => {
    expect(renderHooksConfig('codex', { specs, description: 'D' })).toEqual({
      description: 'D',
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              {
                type: 'command',
                command:
                  'node "$(git rev-parse --show-toplevel)/a.js" --harness codex',
                timeout: 5,
              },
              {
                type: 'command',
                command:
                  'node "$(git rev-parse --show-toplevel)/b.js" --harness codex',
                timeout: 6,
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node "$(git rev-parse --show-toplevel)/a.js" --harness codex',
                timeout: 5,
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command:
                  'node "$(git rev-parse --show-toplevel)/b.js" --harness codex',
                timeout: 6,
              },
            ],
          },
        ],
      },
    });
  });

  test('should start a new group when the matcher changes', () => {
    const config = renderHooksConfig('claude', {
      specs: [
        {
          id: 'a',
          script: 'a.js',
          timeout: 1,
          claude: [
            { event: 'PostToolUse', matcher: '*' },
            { event: 'PostToolUse', matcher: 'Edit|Write' },
          ],
        },
      ],
    });
    expect(config?.hooks.PostToolUse.map((g) => g.matcher)).toEqual([
      '*',
      'Edit|Write',
    ]);
    expect(config).not.toHaveProperty('description');
  });

  test('should return null for a harness with no hooks', () => {
    expect(renderHooksConfig('dsh', { specs })).toBeNull();
  });
});

describe('readHookEntries', () => {
  test('should flatten a Claude-format hooks config', () => {
    const config = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'a', timeout: 3 }] }],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'b' }] },
        ],
      },
    };
    expect(readHookEntries(config)).toEqual([
      { event: 'Stop', matcher: null, command: 'a', timeout: 3 },
      { event: 'PreToolUse', matcher: 'Bash', command: 'b', timeout: null },
    ]);
  });

  test('should skip malformed parts and non-command hooks', () => {
    const config = {
      hooks: {
        Stop: [
          null,
          { hooks: 'x' },
          { hooks: [{ type: 'prompt', prompt: 'p' }, { type: 'command' }] },
        ],
        SessionEnd: 'x',
      },
    };
    expect(readHookEntries(config)).toEqual([]);
    expect(readHookEntries(null)).toEqual([]);
    expect(readHookEntries({ hooks: [] })).toEqual([]);
  });
});

describe('diffEntries', () => {
  /**
   * @param {string} command
   * @param {string | null} [matcher]
   */
  const entry = (command, matcher = null) => ({
    event: 'Stop',
    matcher,
    command,
    timeout: 5,
  });

  test('should find entries missing from or extra in a config, ignoring order', () => {
    expect(
      diffEntries([entry('a'), entry('b')], [entry('b'), entry('c')])
    ).toEqual({ missing: [entry('a')], extra: [entry('c')] });
    expect(
      diffEntries([entry('a'), entry('b')], [entry('b'), entry('a')])
    ).toEqual({
      missing: [],
      extra: [],
    });
  });

  test('should count duplicates', () => {
    expect(diffEntries([entry('a'), entry('a')], [entry('a')])).toEqual({
      missing: [entry('a')],
      extra: [],
    });
  });

  test('should tell entries apart by matcher and timeout', () => {
    expect(
      diffEntries([entry('a', 'Bash')], [{ ...entry('a', 'Bash'), timeout: 9 }])
    ).toEqual({
      missing: [entry('a', 'Bash')],
      extra: [{ ...entry('a', 'Bash'), timeout: 9 }],
    });
  });
});

describe('the Codex wiring', () => {
  const events = (/** @type {string} */ id) =>
    (HOOKS.find((spec) => spec.id === id)?.codex ?? []).map(
      (p) => `${p.event}${p.matcher ? ` [${p.matcher}]` : ''}`
    );

  test('should run the task brief, loop, reset, checkpoint, and context monitor', () => {
    expect(events('task-brief')).toEqual([
      'SessionStart [startup|resume|clear|compact]',
    ]);
    expect(events('task-loop')).toEqual(['Stop']);
    expect(events('task-loop-reset')).toEqual(['UserPromptSubmit']);
    expect(events('compact-note')).toEqual(['PreCompact']);
    expect(events('context-monitor')).toEqual(['UserPromptSubmit']);
  });

  test('should see patch edits at PreToolUse, where Codex reports them', () => {
    for (const id of ['audit', 'format']) {
      expect(events(id)).toEqual([
        'PreToolUse [Bash|apply_patch]',
        'PostToolUse [*]',
      ]);
    }
  });
});

describe('the DSH wiring', () => {
  const events = (/** @type {string} */ id) =>
    (HOOKS.find((spec) => spec.id === id)?.dsh ?? []).map(
      (p) => `${p.event}${p.matcher ? ` [${p.matcher}]` : ''}`
    );

  test('should run the brief, the loop, the reset, memory, audit, format, and the guard', () => {
    expect(events('task-brief')).toEqual([
      'SessionStart [startup|resume|clear|compact]',
    ]);
    expect(events('task-loop')).toEqual(['Stop']);
    expect(events('task-loop-reset')).toEqual(['UserPromptSubmit']);
    expect(events('memory')).toEqual([
      'SessionStart [startup|resume|clear|compact]',
      'UserPromptSubmit',
      'PreToolUse [bash|pwsh]',
      'PostToolUse [bash|pwsh]',
    ]);
    expect(events('audit')).toEqual(['PostToolUse [*]']);
    expect(events('format')).toEqual([
      'PostToolUse [edit|write|apply_patch|str_replace_editor]',
    ]);
    expect(events('guard')).toHaveLength(1);
  });

  test('should leave out what the bridge cannot run: PreCompact, and the context monitor', () => {
    expect(events('compact-note')).toEqual([]);
    expect(events('context-monitor')).toEqual([]);
  });

  test("should name DSH's own lowercase tools, since the bridge has no aliases", () => {
    const matchers = HOOKS.flatMap((spec) => spec.dsh ?? []).flatMap((p) =>
      p.matcher && p.matcher !== '*' && !p.matcher.includes('startup')
        ? p.matcher.split('|')
        : []
    );
    for (const name of matchers) expect(name).toMatch(/^[a-z_]+$/);
  });
});

describe('the committed configs', () => {
  test('should match the manifest in .codex/hooks.json (run pnpm harness sync)', () => {
    expect(
      diffEntries(
        hookEntries('codex'),
        readHookEntries(readJson('.codex/hooks.json'))
      )
    ).toEqual({ missing: [], extra: [] });
  });

  test('should match the manifest in .dsh/hooks.json (run pnpm harness sync)', () => {
    expect(
      diffEntries(
        hookEntries('dsh'),
        readHookEntries(readJson('.dsh/hooks.json'))
      )
    ).toEqual({ missing: [], extra: [] });
  });

  test('should keep every .dsh/hooks.json command in the form the bridge substitutes', () => {
    const commands = readHookEntries(readJson('.dsh/hooks.json')).map(
      (entry) => entry.command
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/^node "\$\{CLAUDE_PROJECT_DIR\}\/[^"]+\.js" /);
      expect(command).not.toContain('"$CLAUDE_PROJECT_DIR"/');
    }
  });

  test('should match the manifest in .claude/settings.json', () => {
    expect(
      diffEntries(
        hookEntries('claude'),
        readHookEntries(readJson('.claude/settings.json'))
      )
    ).toEqual({ missing: [], extra: [] });
  });
});
