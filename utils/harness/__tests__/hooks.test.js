import fs from 'fs';
import path from 'path';
import { ROOT_DIR } from '#utils/workspace-config.js';
import {
  HOOKS,
  diffEntries,
  hookCommand,
  hookEntries,
  readAgyHookEntries,
  readHookEntries,
  renderAgyHooksConfig,
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

  test('should run scripts relative to .agents/ in Antigravity', () => {
    expect(hookCommand('agy', spec)).toBe(
      'node ../.claude/hooks/x.js --harness agy'
    );
    expect(hookCommand('agy', { ...spec, args: ['--reset'] })).toBe(
      'node ../.claude/hooks/x.js --reset --harness agy'
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

describe('renderAgyHooksConfig and readAgyHookEntries', () => {
  test('should render flat lifecycle hooks and grouped tool hooks keyed by spec id', () => {
    const specs = [
      {
        id: 'a',
        script: 'a.js',
        timeout: 5,
        agy: [
          { event: 'SessionStart' },
          { event: 'PreToolUse', matcher: 'run_command', timeout: 7 },
          { event: 'PreToolUse', matcher: 'run_command' },
          { event: 'PostToolUse' },
          { event: 'PostToolUse', timeout: 9 },
        ],
      },
      { id: 'b', script: 'b.js', timeout: 3, codex: [{ event: 'Stop' }] },
    ];
    const config = renderAgyHooksConfig({ specs });
    expect(config).toEqual({
      a: {
        SessionStart: [
          {
            type: 'command',
            command: 'node ../a.js --harness agy',
            timeout: 5,
          },
        ],
        PreToolUse: [
          {
            matcher: 'run_command',
            hooks: [
              {
                type: 'command',
                command: 'node ../a.js --harness agy',
                timeout: 7,
              },
              {
                type: 'command',
                command: 'node ../a.js --harness agy',
                timeout: 5,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              {
                type: 'command',
                command: 'node ../a.js --harness agy',
                timeout: 5,
              },
              {
                type: 'command',
                command: 'node ../a.js --harness agy',
                timeout: 9,
              },
            ],
          },
        ],
      },
    });
    expect(readAgyHookEntries(config)).toEqual([
      {
        event: 'SessionStart',
        matcher: null,
        command: 'node ../a.js --harness agy',
        timeout: 5,
      },
      {
        event: 'PreToolUse',
        matcher: 'run_command',
        command: 'node ../a.js --harness agy',
        timeout: 7,
      },
      {
        event: 'PreToolUse',
        matcher: 'run_command',
        command: 'node ../a.js --harness agy',
        timeout: 5,
      },
      {
        event: 'PostToolUse',
        matcher: null,
        command: 'node ../a.js --harness agy',
        timeout: 5,
      },
      {
        event: 'PostToolUse',
        matcher: null,
        command: 'node ../a.js --harness agy',
        timeout: 9,
      },
    ]);
    expect(
      diffEntries(hookEntries('agy', specs), readAgyHookEntries(config))
    ).toEqual({
      missing: [],
      extra: [],
    });
    expect(renderAgyHooksConfig({ specs: [] })).toBeNull();
  });

  test('should skip disabled hooks, malformed sections, and non-command handlers', () => {
    expect(readAgyHookEntries(null)).toEqual([]);
    expect(
      readAgyHookEntries({
        disabled: {
          enabled: false,
          Stop: [{ command: 'node a.js' }],
        },
        broken: null,
        mixed: {
          enabled: true,
          Stop: [
            { command: 'node ok.js' },
            { type: 'http', command: 'ignored' },
          ],
          PreToolUse: [
            null,
            { hooks: [{ command: 'node no-matcher.js' }] },
            { matcher: '*', hooks: 'not-array' },
          ],
        },
      })
    ).toEqual([
      { event: 'Stop', matcher: null, command: 'node ok.js', timeout: null },
      {
        event: 'PreToolUse',
        matcher: null,
        command: 'node no-matcher.js',
        timeout: null,
      },
    ]);
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

describe('the Antigravity wiring', () => {
  const events = (/** @type {string} */ id) =>
    (HOOKS.find((spec) => spec.id === id)?.agy ?? []).map(
      (p) => `${p.event}${p.matcher ? ` [${p.matcher}]` : ''}`
    );

  test('should wire task-brief, memory, guard, loop, reset, context-monitor, audit, and format', () => {
    expect(events('task-brief')).toEqual(['SessionStart']);
    expect(events('memory')).toEqual([
      'SessionStart',
      'PreInvocation',
      'PostInvocation',
    ]);
    expect(events('task-loop')).toEqual(['Stop']);
    expect(events('task-loop-reset')).toEqual(['PreInvocation']);
    expect(events('context-monitor')).toEqual(['PreInvocation']);
    expect(events('audit')).toEqual(['PostToolUse [*]']);
    expect(events('guard')).toHaveLength(1);
    expect(events('format')).toHaveLength(1);
    expect(events('compact-note')).toEqual([]);
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

  test('should match the manifest in .agents/hooks.json (run pnpm harness sync)', () => {
    expect(
      diffEntries(
        hookEntries('agy'),
        readAgyHookEntries(readJson('.agents/hooks.json'))
      )
    ).toEqual({ missing: [], extra: [] });
  });

  test('should keep AGENTS.md within Antigravity CLI 24,000-byte per-file rule cap', () => {
    const bytes = Buffer.byteLength(
      fs.readFileSync(path.join(ROOT_DIR, 'AGENTS.md'), 'utf-8')
    );
    expect(bytes).toBeLessThanOrEqual(24_000);
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
