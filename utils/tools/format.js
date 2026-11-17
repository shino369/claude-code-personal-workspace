/**
 * Text output for `pnpm tools` and the one-line summary in the session brief.
 */
import { installHint } from './catalog.js';
import { KINDS } from './registry.js';

export const LINE_LIMIT = 300;

/** @type {Record<string, string>} */
const KIND_LABELS = {
  agent: 'agents',
  cli: 'cli',
  runtime: 'runtimes',
  source: 'sources',
};

/**
 * @typedef {import('./registry.js').ToolEntry} ToolEntry
 * @typedef {import('./registry.js').Registry} Registry
 * @typedef {import('./catalog.js').CatalogEntry} CatalogEntry
 */

/**
 * One line for the SessionStart brief, so every session knows which agents
 * and tools it can call. Null when the registry cannot be read.
 *
 * @param {Registry} registry
 * @returns {string}
 */
export function toolsLine(registry) {
  if (registry.tools.length === 0) {
    return 'Tools: none recorded on this machine — run pnpm tools scan to list the agents and CLIs you can call';
  }
  const groups = KINDS.map((kind) => {
    const names = registry.tools
      .filter((t) => t.kind === kind)
      .map((t) => `${t.name}${t.ok ? '' : ' (broken)'}`);
    return names.length > 0 ? `${KIND_LABELS[kind]} ${names.join(', ')}` : '';
  }).filter(Boolean);
  const line = `Tools: ${groups.join(' · ')} (pnpm tools list; call another agent: pnpm agent ask --agent <name> "…")`;
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT - 1)}…` : line;
}

/**
 * @param {ToolEntry} entry
 * @returns {string}
 */
function describe(entry) {
  const where = entry.command ?? entry.path ?? '?';
  const parts = [
    `${entry.ok ? '✓' : '✗'} ${entry.name}${entry.version ? ` ${entry.version}` : ''}`,
    `— ${where}`,
  ];
  if (entry.via) parts.push(`(${entry.via})`);
  return parts.join(' ');
}

/**
 * The `pnpm tools list` text.
 *
 * @param {{ registry: Registry, catalog: CatalogEntry[], all: boolean, sources: string, platform: string }} input
 * @returns {string}
 */
export function formatList({ registry, catalog, all, sources, platform }) {
  if (registry.tools.length === 0) {
    return [
      'No tools recorded on this machine yet.',
      'Fix: pnpm tools scan  (checks the tools in tools/catalog.json; add others with pnpm tools add)',
    ].join('\n');
  }
  const lines = [
    `Tools on this machine (tools/local.json, updated ${registry.updatedAt ?? 'never'}):`,
  ];
  for (const kind of KINDS) {
    const entries = registry.tools.filter((t) => t.kind === kind);
    if (entries.length === 0) continue;
    lines.push(`${KIND_LABELS[kind]}:`);
    for (const entry of entries) {
      lines.push(`  ${describe(entry)}`);
      if (entry.headless) lines.push(`      headless: ${entry.headless}`);
      if (entry.notes) lines.push(`      note: ${entry.notes}`);
    }
  }
  const known = new Set(registry.tools.map((t) => t.name));
  const missing = catalog.filter((t) => !known.has(t.name));
  if (missing.length > 0) {
    lines.push(
      all
        ? 'Not installed (from tools/catalog.json):'
        : `Not installed: ${missing.map((t) => t.name).join(', ')} (details: pnpm tools list --all)`
    );
    if (all) {
      for (const tool of missing) {
        lines.push(
          `  ${tool.name} — ${tool.purpose}; install: ${installHint(tool, platform) ?? 'unknown'}`
        );
      }
    }
  }
  lines.push(
    `Source checkouts go in ${sources}/<name> (register: pnpm tools add <name> --kind source --path …).`
  );
  return lines.join('\n');
}

/**
 * The `pnpm tools show <name>` text.
 *
 * @param {{ name: string, entry: ToolEntry | null, tool: CatalogEntry | undefined, platform: string }} input
 * @returns {string}
 */
export function formatShow({ name, entry, tool, platform }) {
  const lines = [`${name}${tool ? ` — ${tool.purpose}` : ''}`];
  if (entry) {
    lines.push(
      `  status: ${entry.ok ? 'working' : 'broken'} (checked ${entry.checkedAt})`
    );
    lines.push(`  kind: ${entry.kind}; recorded by ${entry.source}`);
    if (entry.path) lines.push(`  path: ${entry.path}`);
    if (entry.command) lines.push(`  command: ${entry.command}`);
    if (entry.version) lines.push(`  version: ${entry.version}`);
    if (entry.via) lines.push(`  installed via: ${entry.via}`);
    if (entry.task) lines.push(`  added by task: ${entry.task}`);
  } else {
    lines.push('  status: not recorded on this machine');
  }
  const headless = entry?.headless ?? tool?.headless;
  if (headless) lines.push(`  headless: ${headless}`);
  const env = entry?.env ?? tool?.env;
  if (env)
    lines.push(
      `  needs env: ${env.join(', ')} (values never go in the registry)`
    );
  const notes = [entry?.notes, tool?.notes].filter(Boolean);
  for (const note of notes) lines.push(`  note: ${note}`);
  if (tool?.docs) lines.push(`  docs: ${tool.docs}`);
  if (!entry?.ok) {
    const hint = installHint(tool, platform);
    lines.push(
      hint
        ? `  install: ${hint}`
        : `  install: unknown — record it after installing: pnpm tools add ${name} --kind … --path …`
    );
  }
  return lines.join('\n');
}
