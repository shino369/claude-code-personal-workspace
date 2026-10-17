#!/usr/bin/env node
// analyze_deps.mjs — Dependabot-style dependency analysis for any pnpm workspace.
//
// Discovers the packages to analyze from the project itself (no settings are hardcoded):
//   • pnpm-workspace.yaml — the default `catalog:` and every named `catalogs.<name>:`
//   • package.json        — direct dependencies pinned with a plain semver range
//                           (entries using catalog:/workspace:/link:/file:/npm: are skipped)
// It also reads the project's release-cooldown policy (`minimumReleaseAge` /
// `minimumReleaseAgeExclude`) from pnpm-workspace.yaml when present.
//
// For each package it queries the configured registry and classifies the update:
//   UP_TO_DATE   Already on the newest release in the current major.
//   MINOR_PATCH  A newer minor/patch exists in the same major — safe, dependabot territory.
//   MAJOR        The current major is at its ceiling, but a newer major exists (breaking).
//   STALE_MAJOR  The current-major ceiling has had NO release in > --stale-months AND a newer
//                major exists — the "8.8.1 is the last 8.x and it's a year old, but 9.x shipped"
//                signal that the current major line is likely unmaintained. Evaluate migrating.
//   ERROR        Registry lookup failed.
//
// MAJOR and STALE_MAJOR are breaking changes: never apply them without explicit user permission.
//
// Usage:
//   node analyze_deps.mjs [package]              Analyze one package, or everything discovered.
//   node analyze_deps.mjs --catalog <name>       Restrict to one source: a catalog name, `default`,
//                                                or `package.json`.
//   node analyze_deps.mjs --stale-months <n>     Staleness threshold in months (default 12).
//   node analyze_deps.mjs --json                 Emit a JSON array instead of a table.
//   node analyze_deps.mjs --workspace <path>     pnpm-workspace.yaml (default ./pnpm-workspace.yaml).
//   node analyze_deps.mjs --manifest <path>      package.json to scan (default ./package.json).
//
// No dependencies — uses only Node built-ins and the global fetch.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { runIfMain } from '#utils/module-runner.js';

export const FETCH_CONCURRENCY = 8;
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {
    package: null,
    catalog: null,
    staleMonths: 12,
    json: false,
    workspace: 'pnpm-workspace.yaml',
    manifest: 'package.json',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--package') opts.package = argv[++i];
    else if (arg === '--catalog') opts.catalog = argv[++i];
    else if (arg === '--stale-months') opts.staleMonths = Number(argv[++i]);
    else if (arg === '--workspace') opts.workspace = argv[++i];
    else if (arg === '--manifest') opts.manifest = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else opts.package = arg;
  }
  if (!Number.isFinite(opts.staleMonths) || opts.staleMonths <= 0) {
    throw new Error('--stale-months must be a positive number');
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Project discovery — pnpm-workspace.yaml (catalogs + cooldown policy)
// ---------------------------------------------------------------------------

const indentOf = line => line.length - line.trimStart().length;

// Line indexes strictly nested under `lines[startIdx]` (deeper indent), up to the next sibling.
export function childBlock(lines, startIdx) {
  const base = indentOf(lines[startIdx]);
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (indentOf(lines[i]) <= base) break;
    out.push(i);
  }
  return out;
}

// Parse `<key>: <value>` entries at the shallowest indent within a block (a catalog's contents).
export function parseEntries(lines, block) {
  const out = {};
  if (!block.length) return out;
  const entryIndent = Math.min(...block.map(idx => indentOf(lines[idx])));
  for (const idx of block) {
    if (indentOf(lines[idx]) !== entryIndent) continue;
    const m = lines[idx]
      .trim()
      .match(/^(?:'([^']+)'|"([^"]+)"|([^:]+?))\s*:\s*(.+?)\s*$/);
    if (m) {
      const key = (m[1] ?? m[2] ?? m[3]).trim();
      const value = m[4].trim().replace(/^['"]|['"]$/g, '');
      out[key] = value;
    }
  }
  return out;
}

// Reads catalogs and cooldown policy without a YAML dependency. Indentation-relative, so it
// tolerates any consistent indent width and both the `catalog:` (default) and `catalogs:` forms.
export function readWorkspace(workspacePath) {
  const result = {
    catalogs: {},
    minimumReleaseAge: null,
    minimumReleaseAgeExclude: [],
    found: false,
  };
  let text;
  try {
    text = readFileSync(workspacePath, 'utf8');
  } catch {
    return result;
  }
  result.found = true;

  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/\t/g, '  '))
    .filter(l => l.trim() !== '' && !/^\s*#/.test(l));

  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) !== 0) continue;
    const m = lines[i].match(/^([A-Za-z0-9_-]+)\s*:(.*)$/);
    if (!m) continue;
    const key = m[1];
    const inline = m[2].trim();

    if (key === 'catalog') {
      result.catalogs.default = parseEntries(lines, childBlock(lines, i));
    } else if (key === 'catalogs') {
      const block = childBlock(lines, i);
      if (block.length) {
        const nameIndent = Math.min(...block.map(idx => indentOf(lines[idx])));
        for (const idx of block) {
          if (indentOf(lines[idx]) !== nameIndent) continue;
          const cm = lines[idx]
            .trim()
            .match(/^['"]?([A-Za-z0-9_@/.-]+)['"]?\s*:\s*$/);
          if (cm)
            result.catalogs[cm[1]] = parseEntries(
              lines,
              childBlock(lines, idx),
            );
        }
      }
    } else if (key === 'minimumReleaseAge') {
      const n = Number(inline);
      result.minimumReleaseAge = Number.isFinite(n) && n > 0 ? n : null;
    } else if (key === 'minimumReleaseAgeExclude') {
      // Accept both the inline-array form and the indented-list form.
      const inlineItems = inline
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(s => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
      const listItems = childBlock(lines, i)
        .map(idx => lines[idx].trim())
        .filter(l => l.startsWith('-'))
        .map(l => l.slice(1).trim().replace(/['"]/g, ''));

      result.minimumReleaseAgeExclude = inlineItems.concat(listItems);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Project discovery — package.json direct dependencies
// ---------------------------------------------------------------------------

// A plain semver range we can analyze — not a catalog:/workspace:/protocol/url/alias specifier.
export function isPlainSemverRange(spec) {
  if (typeof spec !== 'string') return false;
  if (
    /^(catalog:|workspace:|link:|file:|npm:|git\+|github:|https?:|git:|portal:)/.test(
      spec,
    )
  ) {
    return false;
  }
  if (spec === '' || spec === '*' || spec === 'latest') return false;
  return /^\s*[v^~>=<]*\s*\d/.test(spec);
}

export function readManifestDeps(manifestPath) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return {};
  }
  const out = {};
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (isPlainSemverRange(spec)) out[name] = spec;
    }
  }
  return out;
}

// Merge catalogs + manifest into a deduped list of { source, name, range }.
export function discoverEntries(opts) {
  const workspace = readWorkspace(opts.workspace);
  const sources = [];
  for (const [catalogName, packages] of Object.entries(workspace.catalogs)) {
    sources.push([`catalog:${catalogName}`, packages]);
  }
  sources.push(['package.json', readManifestDeps(opts.manifest)]);

  const entries = [];
  const seen = new Set();
  for (const [source, packages] of sources) {
    for (const [name, range] of Object.entries(packages)) {
      const dedupeKey = `${name}@${range}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push({ source, name, range });
    }
  }
  return { entries, workspace };
}

// ---------------------------------------------------------------------------
// Semver helpers (no external lib; handles X.Y.Z and prereleases per semver rules)
// ---------------------------------------------------------------------------

export function parseVersion(v) {
  const m = String(v)
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

export function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release outranks a prerelease
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (+x !== +y) return +x < +y ? -1 : 1;
    } else if (xNum)
      return -1; // numeric identifiers rank lower than alphanumeric
    else if (yNum) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

// The lowest version a range admits — its "current" baseline. Handles ^X.Y.Z, ~X.Y.Z,
// pinned X.Y.Z, prereleases, and major-only ranges like ^19.
export function baselineVersion(range) {
  const full = String(range).match(/(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?/);
  if (full) return full[0];
  const majorOnly = String(range).match(/(\d+)(?:\.(\d+))?/);
  if (majorOnly) return `${majorOnly[1]}.${majorOnly[2] ?? 0}.0`;
  return null;
}

// The operator prefix of a range (^, ~, >=, or '' for a pinned version), so a suggestion
// keeps the project's existing pinning style.
export function rangePrefix(range) {
  const prefix = String(range).match(/^(\D*)/)[1].trim();
  return /^[~^]$|^>=?$|^<=?$/.test(prefix) ? prefix : '';
}

// ---------------------------------------------------------------------------
// Registry access — resolves the project's configured (possibly private) registry
// ---------------------------------------------------------------------------

export function readPnpmConfig(key) {
  try {
    return execFileSync('pnpm', ['config', 'get', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

export function getScope(packageName) {
  if (!packageName.startsWith('@')) return '';
  const slashIndex = packageName.indexOf('/');
  return slashIndex === -1 ? '' : packageName.slice(0, slashIndex);
}

export function getRegistry(packageName, cache) {
  const scope = getScope(packageName);
  if (cache.has(scope)) return cache.get(scope);
  const scopedRegistry = scope ? readPnpmConfig(`${scope}:registry`) : '';
  const registry =
    scopedRegistry && scopedRegistry !== 'undefined'
      ? scopedRegistry
      : readPnpmConfig('registry');
  const resolved =
    registry && registry !== 'undefined' ? registry : DEFAULT_REGISTRY;
  cache.set(scope, resolved);
  return resolved;
}

// npm/pnpm store per-registry credentials keyed by the registry URL without its
// protocol, e.g. `//host/:_authToken` (bearer) or `//host/:_auth` (base64 basic).
// Best-effort: matches the registry root, which covers the common host-level setup.
// Cached per registry URL so we don't spawn a `pnpm config` subprocess per package.
export function getAuthHeader(registryUrl, authCache) {
  if (authCache.has(registryUrl)) return authCache.get(registryUrl);
  const key = registryUrl.replace(/^https?:/, '');
  const withSlash = key.endsWith('/') ? key : `${key}/`;
  let header = null;
  const token = readPnpmConfig(`${withSlash}:_authToken`);
  if (token && token !== 'undefined') {
    header = `Bearer ${token}`;
  } else {
    const basic = readPnpmConfig(`${withSlash}:_auth`);
    if (basic && basic !== 'undefined') header = `Basic ${basic}`;
  }
  authCache.set(registryUrl, header);
  return header;
}

export async function fetchPackageData(packageName, registryCache, authCache) {
  const registry = getRegistry(packageName, registryCache);
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const url = new URL(
    encodeURIComponent(packageName).replace('%40', '@'),
    base,
  );
  const headers = { accept: 'application/json' };
  const authHeader = getAuthHeader(base, authCache);
  if (authHeader) headers.authorization = authHeader;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const daysSince = iso =>
  iso ? (Date.now() - new Date(iso).getTime()) / 86_400_000 : null;

export function analyzePackage(name, range, data, opts, cooldown) {
  const versionMap = data.versions ?? {};
  const timeMap = data.time ?? {};
  const distLatest = data['dist-tags']?.latest ?? null;

  const baseline = baselineVersion(range);
  const parsedBaseline = baseline ? parseVersion(baseline) : null;
  const currentMajor = parsedBaseline ? parsedBaseline.major : null;
  const currentIsPre = parsedBaseline
    ? parsedBaseline.prerelease.length > 0
    : false;

  // Consider only real releases; skip prereleases unless the range itself pins one.
  const candidates = Object.keys(versionMap)
    .filter(v => {
      const parsed = parseVersion(v);
      if (!parsed) return false;
      if (parsed.prerelease.length > 0 && !currentIsPre) return false;
      return true;
    })
    .sort(compareVersions);

  const inMajor =
    currentMajor === null
      ? candidates
      : candidates.filter(v => parseVersion(v).major === currentMajor);
  const newerMajor =
    currentMajor === null
      ? []
      : candidates.filter(v => parseVersion(v).major > currentMajor);

  const latestInMajor = inMajor.length ? inMajor[inMajor.length - 1] : baseline;
  const newerMajorLatest = newerMajor.length
    ? newerMajor[newerMajor.length - 1]
    : null;
  const latestOverall = candidates.length
    ? candidates[candidates.length - 1]
    : distLatest;

  const ceilingAgeDays = daysSince(timeMap[latestInMajor]);
  const atCeiling = !baseline || compareVersions(latestInMajor, baseline) <= 0;
  const stale =
    atCeiling &&
    ceilingAgeDays !== null &&
    ceilingAgeDays > opts.staleMonths * 30.44;

  let status;
  if (!atCeiling) status = 'MINOR_PATCH';
  else if (newerMajorLatest && stale) status = 'STALE_MAJOR';
  else if (newerMajorLatest) status = 'MAJOR';
  else status = 'UP_TO_DATE';

  const target = status === 'MINOR_PATCH' ? latestInMajor : null;
  const targetAgeDays = target ? daysSince(timeMap[target]) : null;

  // Cooldown only matters when the project sets one and the package isn't exempt from it.
  let belowCooldown = null;
  if (target && cooldown.minutes !== null && !cooldown.exclude.has(name)) {
    belowCooldown =
      targetAgeDays === null ? null : targetAgeDays < cooldown.minutes / 1440;
  }

  return {
    name,
    status,
    currentRange: range,
    latestInMajor,
    suggestedRange: target ? `${rangePrefix(range)}${target}` : null,
    targetAgeDays: targetAgeDays === null ? null : Math.round(targetAgeDays),
    belowCooldown,
    newerMajorLatest,
    latestOverall,
    ceilingAgeDays: ceilingAgeDays === null ? null : Math.round(ceilingAgeDays),
    deprecated: Boolean(versionMap[latestInMajor]?.deprecated),
  };
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const LABELS = {
  UP_TO_DATE: '✅ Up to date',
  MINOR_PATCH: '🟢 Safe minor/patch update (dependabot territory)',
  MAJOR: '🟠 Major update available — breaking, needs review + permission',
  STALE_MAJOR:
    '🔴 Stale major — current line unmaintained, newer major exists (needs permission)',
  ERROR: '⚠️  Registry lookup failed',
};
export const ORDER = [
  'STALE_MAJOR',
  'MAJOR',
  'MINOR_PATCH',
  'ERROR',
  'UP_TO_DATE',
];

export function renderTable(rows, cooldown) {
  const grouped = new Map(ORDER.map(s => [s, []]));
  for (const row of rows) grouped.get(row.status)?.push(row);

  const cooldownDesc =
    cooldown.minutes !== null
      ? `${cooldown.minutes} min (${(cooldown.minutes / 1440).toFixed(1)}d)` +
        (cooldown.exclude.size ? `, ${cooldown.exclude.size} exempt` : '')
      : 'not set';

  const lines = [`Release cooldown (minimumReleaseAge): ${cooldownDesc}`];
  for (const status of ORDER) {
    const group = grouped.get(status);
    if (!group.length) continue;
    lines.push('');
    lines.push(`${LABELS[status]}  (${group.length})`);
    lines.push('─'.repeat(72));
    for (const r of group.sort((a, b) => a.name.localeCompare(b.name))) {
      const majorNote = r.newerMajorLatest
        ? `   (major ${r.newerMajorLatest} also available — migration is a separate, permissioned decision)`
        : '';
      if (status === 'UP_TO_DATE') {
        lines.push(`  ${r.name}  ${r.currentRange}${majorNote}`);
      } else if (status === 'MINOR_PATCH') {
        const ageNote =
          r.belowCooldown === true
            ? `  ⚠ target ${r.targetAgeDays}d old — below minimumReleaseAge cooldown`
            : '';
        lines.push(
          `  ${r.name}  ${r.currentRange} → ${r.suggestedRange}${ageNote}${majorNote}`,
        );
      } else if (status === 'ERROR') {
        lines.push(`  ${r.name}  (${r.error})`);
      } else {
        const age =
          r.ceilingAgeDays !== null ? ` [${r.ceilingAgeDays}d old]` : '';
        lines.push(
          `  ${r.name}  current ${r.currentRange}${age} → newer major ${r.newerMajorLatest}`,
        );
      }
    }
  }

  lines.push('');
  lines.push('─'.repeat(72));
  lines.push(ORDER.map(s => `${s}: ${grouped.get(s).length}`).join('  |  '));
  lines.push('');
  lines.push('Next steps:');
  lines.push(
    '  • 🟢 Apply minor/patch updates (in the catalog or package.json), then run the verification pipeline.',
  );
  lines.push(
    '  • ⚠ below-cooldown targets: pick an aged version or wait — do not bypass minimumReleaseAge.',
  );
  lines.push(
    '  • 🟠 / 🔴 Do NOT apply without explicit user permission — warn about the breaking changes first.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const { entries, workspace } = discoverEntries(opts);

  const cooldown = {
    minutes: workspace.minimumReleaseAge,
    exclude: new Set(),
  };
  // Support glob-ish exclude entries like `@next/*` by matching scope prefixes too.
  const excludeGlobs = workspace.minimumReleaseAgeExclude;

  const selected = entries.filter(e => {
    if (opts.package && e.name !== opts.package) return false;
    if (opts.catalog) {
      const src =
        e.source === 'package.json'
          ? 'package.json'
          : e.source.replace(/^catalog:/, '');
      if (src !== opts.catalog && e.source !== opts.catalog) return false;
    }
    return true;
  });

  if (selected.length === 0) {
    const where = workspace.found
      ? `${opts.workspace} catalogs and ${opts.manifest}`
      : `${opts.manifest} (no ${opts.workspace} found)`;
    throw new Error(
      `No matching ${opts.package ? `package "${opts.package}"` : 'dependencies'} found in ${where}`,
    );
  }

  const matchesExclude = name =>
    excludeGlobs.some(g =>
      g.endsWith('/*') ? name.startsWith(g.slice(0, -1)) : g === name,
    );
  for (const e of selected)
    if (matchesExclude(e.name)) cooldown.exclude.add(e.name);

  const registryCache = new Map();
  const authCache = new Map();
  const rows = await mapWithConcurrency(
    selected,
    FETCH_CONCURRENCY,
    async entry => {
      try {
        const data = await fetchPackageData(
          entry.name,
          registryCache,
          authCache,
        );
        return {
          source: entry.source,
          ...analyzePackage(entry.name, entry.range, data, opts, cooldown),
        };
      } catch (error) {
        return {
          source: entry.source,
          name: entry.name,
          currentRange: entry.range,
          status: 'ERROR',
          error: getErrorMessage(error),
        };
      }
    },
  );

  const output = opts.json
    ? JSON.stringify({ cooldownMinutes: cooldown.minutes, rows }, null, 2)
    : renderTable(rows, cooldown);

  // Non-zero exit when breaking-change decisions are pending, so callers can gate on it.
  const hasBreaking = rows.some(
    r => r.status === 'MAJOR' || r.status === 'STALE_MAJOR',
  );

  // Resolve only after stdout has flushed. Calling process.exit() directly
  // after console.log can truncate output when stdout is a pipe (writes are
  // async on pipes), which would corrupt a large --json payload downstream.
  return new Promise(resolve => {
    process.stdout.write(`${output}\n`, () => resolve(hasBreaking ? 3 : 0));
  });
}

/* istanbul ignore next - CLI entry point, exercises the tested main() */
function runCli() {
  main()
    .then(code => {
      // main() resolves after its stdout write callback, so the output is
      // already flushed; setting exitCode avoids a forced exit on Windows.
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`ERROR: ${getErrorMessage(error)}`);
      process.exitCode = 2;
    });
}

runIfMain(import.meta.url, runCli);
