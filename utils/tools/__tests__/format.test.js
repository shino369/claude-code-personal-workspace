import { LINE_LIMIT, formatList, formatShow, toolsLine } from '../format.js';
import { emptyRegistry } from '../registry.js';

const AT = '2026-11-17T09:00:00.000Z';

/** @param {Partial<import('../registry.js').ToolEntry>} [overrides] */
const entry = (overrides = {}) => ({
  name: 'codex',
  kind: /** @type {const} */ ('agent'),
  path: '/bin/codex',
  version: '0.155.0',
  source: /** @type {const} */ ('scan'),
  ok: true,
  checkedAt: AT,
  ...overrides,
});

/** @type {import('../catalog.js').CatalogEntry[]} */
const catalog = [
  { name: 'codex', kind: 'agent', purpose: 'Codex', check: ['codex'] },
  {
    name: 'dsh',
    kind: 'agent',
    purpose: 'DeepSeek',
    check: ['dsh'],
    install: { any: 'npx -y @deepseek-ai/dsh' },
  },
  { name: 'weird', kind: 'cli', purpose: 'W', check: ['weird'] },
];

describe('toolsLine', () => {
  test('should ask for a scan when nothing is recorded', () => {
    expect(toolsLine(emptyRegistry())).toBe(
      'Tools: none recorded on this machine — run pnpm tools scan to list the agents and CLIs you can call'
    );
  });

  test('should group tools by kind and flag broken ones', () => {
    expect(
      toolsLine({
        ...emptyRegistry(),
        tools: [
          entry(),
          entry({ name: 'claude' }),
          entry({ name: 'gh', kind: 'cli', ok: false }),
          entry({ name: 'dsh-src', kind: 'source' }),
        ],
      })
    ).toBe(
      'Tools: agents codex, claude · cli gh (broken) · sources dsh-src (pnpm tools list; call another agent: pnpm agent ask --agent <name> "…")'
    );
  });

  test('should clip a very long line', () => {
    const tools = Array.from({ length: 60 }, (_, i) =>
      entry({ name: `tool-${i}`, kind: 'cli' })
    );
    const line = toolsLine({ ...emptyRegistry(), tools });
    expect(line).toHaveLength(LINE_LIMIT);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatList', () => {
  const base = { catalog, sources: '/src', platform: 'darwin' };

  test('should explain an empty registry', () => {
    expect(
      formatList({ ...base, registry: emptyRegistry(), all: false })
    ).toContain('Fix: pnpm tools scan');
  });

  test('should list entries with details and name missing tools', () => {
    const text = formatList({
      ...base,
      all: false,
      registry: {
        ...emptyRegistry(),
        updatedAt: AT,
        tools: [
          entry({ via: 'pnpm (global)', headless: 'codex exec -', notes: 'n' }),
          entry({
            name: 'deepseek-harness',
            kind: 'source',
            path: null,
            version: null,
            ok: false,
          }),
          entry({ name: 'x', kind: 'cli', path: null, command: 'npx x' }),
        ],
      },
    });
    expect(text.split('\n')).toEqual([
      `Tools on this machine (tools/local.json, updated ${AT}):`,
      'agents:',
      '  ✓ codex 0.155.0 — /bin/codex (pnpm (global))',
      '      headless: codex exec -',
      '      note: n',
      'cli:',
      '  ✓ x 0.155.0 — npx x',
      'sources:',
      '  ✗ deepseek-harness — ?',
      'Not installed: dsh, weird (details: pnpm tools list --all)',
      'Source checkouts go in /src/<name> (register: pnpm tools add <name> --kind source --path …).',
    ]);
  });

  test('should show install hints for missing tools with --all', () => {
    const text = formatList({
      ...base,
      all: true,
      registry: { ...emptyRegistry(), tools: [entry()] },
    });
    expect(text).toContain('updated never');
    expect(text).toContain('Not installed (from tools/catalog.json):');
    expect(text).toContain(
      '  dsh — DeepSeek; install: npx -y @deepseek-ai/dsh'
    );
    expect(text).toContain('  weird — W; install: unknown');
  });

  test('should skip the missing line when every catalog tool is recorded', () => {
    const text = formatList({
      ...base,
      catalog: [catalog[0]],
      all: false,
      registry: { ...emptyRegistry(), tools: [entry()] },
    });
    expect(text).not.toContain('Not installed');
  });
});

describe('formatShow', () => {
  test('should show a recorded tool with every detail', () => {
    const text = formatShow({
      name: 'codex',
      platform: 'darwin',
      tool: {
        ...catalog[0],
        headless: 'catalog headless',
        docs: 'https://x',
        notes: 'catalog note',
        env: ['OPENAI_API_KEY'],
      },
      entry: entry({
        command: 'npx codex',
        via: 'pnpm',
        task: 't-1',
        notes: 'local note',
      }),
    });
    expect(text.split('\n')).toEqual([
      'codex — Codex',
      `  status: working (checked ${AT})`,
      '  kind: agent; recorded by scan',
      '  path: /bin/codex',
      '  command: npx codex',
      '  version: 0.155.0',
      '  installed via: pnpm',
      '  added by task: t-1',
      '  headless: catalog headless',
      '  needs env: OPENAI_API_KEY (values never go in the registry)',
      '  note: local note',
      '  note: catalog note',
      '  docs: https://x',
    ]);
  });

  test('should show install hints for a missing or broken tool', () => {
    expect(
      formatShow({
        name: 'dsh',
        platform: 'linux',
        tool: catalog[1],
        entry: null,
      })
    ).toBe(
      'dsh — DeepSeek\n  status: not recorded on this machine\n  install: npx -y @deepseek-ai/dsh'
    );
    expect(
      formatShow({
        name: 'local',
        platform: 'linux',
        tool: undefined,
        entry: entry({
          name: 'local',
          ok: false,
          path: null,
          version: null,
          headless: 'local -p',
          env: ['K'],
        }),
      })
    ).toBe(
      [
        'local',
        `  status: broken (checked ${AT})`,
        '  kind: agent; recorded by scan',
        '  headless: local -p',
        '  needs env: K (values never go in the registry)',
        '  install: unknown — record it after installing: pnpm tools add local --kind … --path …',
      ].join('\n')
    );
  });
});
