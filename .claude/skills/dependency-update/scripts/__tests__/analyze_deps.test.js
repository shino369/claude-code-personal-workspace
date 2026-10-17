/**
 * Tests for analyze_deps.mjs
 */
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FETCH_CONCURRENCY,
  DEFAULT_REGISTRY,
  getErrorMessage,
  parseArgs,
  childBlock,
  parseEntries,
  readWorkspace,
  isPlainSemverRange,
  readManifestDeps,
  discoverEntries,
  parseVersion,
  comparePrerelease,
  compareVersions,
  baselineVersion,
  rangePrefix,
  readPnpmConfig,
  getScope,
  getRegistry,
  getAuthHeader,
  fetchPackageData,
  analyzePackage,
  mapWithConcurrency,
  renderTable,
  main,
} from '../analyze_deps.mjs';

const NOW = new Date();
const RECENT = NOW.toISOString();
const OLD = '2020-01-01T00:00:00.000Z';

function makeProject(workspaceYaml, manifest = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-deps-'));
  const workspace = path.join(dir, 'pnpm-workspace.yaml');
  const manifestPath = path.join(dir, 'package.json');
  fs.writeFileSync(workspace, workspaceYaml, 'utf-8');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return { dir, workspace, manifest: manifestPath };
}

function packageData({
  versions = ['1.2.3'],
  latest = versions[versions.length - 1],
  times = {},
  deprecated,
} = {}) {
  const versionMap = {};
  const timeMap = {};
  for (const version of versions) {
    versionMap[version] = { version };
    timeMap[version] = times[version] ?? RECENT;
  }
  if (deprecated) versionMap[latest].deprecated = deprecated;

  return {
    versions: versionMap,
    time: timeMap,
    'dist-tags': { latest },
  };
}

function registryMock() {
  execFileSync.mockImplementation((_command, args) => {
    const key = args?.[2];
    if (key === 'registry') return 'https://registry.test/\n';
    return 'undefined\n';
  });
}

function fetchMock(dataByName) {
  global.fetch.mockImplementation(async (url) => {
    const name = decodeURIComponent(url.pathname.slice(1));
    const data = dataByName[name];
    if (!data) {
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
    return { ok: true, json: async () => data };
  });
}

function captureStdout() {
  let output = '';
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk, callback) => {
      output += chunk;
      if (typeof callback === 'function') callback();
      return true;
    });

  return {
    get output() {
      return output;
    },
    restore: () => spy.mockRestore(),
  };
}

describe('analyze_deps', () => {
  const tempDirs = [];
  const originalFetch = global.fetch;

  beforeEach(() => {
    execFileSync.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  function project(yaml, manifest) {
    const result = makeProject(yaml, manifest);
    tempDirs.push(result.dir);
    return result;
  }

  test('getErrorMessage handles errors and non-errors', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });

  describe('parseArgs', () => {
    test('returns defaults', () => {
      expect(parseArgs([])).toEqual({
        package: null,
        catalog: null,
        staleMonths: 12,
        json: false,
        workspace: 'pnpm-workspace.yaml',
        manifest: 'package.json',
      });
    });

    test('parses every flag', () => {
      expect(
        parseArgs([
          'lodash',
          '--catalog',
          'dev',
          '--stale-months',
          '6',
          '--json',
          '--workspace',
          'w.yaml',
          '--manifest',
          'm.json',
        ])
      ).toEqual({
        package: 'lodash',
        catalog: 'dev',
        staleMonths: 6,
        json: true,
        workspace: 'w.yaml',
        manifest: 'm.json',
      });
    });

    test('rejects unknown flags', () => {
      expect(() => parseArgs(['--nope'])).toThrow('Unknown flag: --nope');
    });

    test.each(['0', '-1', 'not-a-number'])(
      'rejects invalid stale months %p',
      (value) => {
        expect(() => parseArgs(['--stale-months', value])).toThrow(
          '--stale-months must be a positive number'
        );
      }
    );
  });

  describe('YAML helpers', () => {
    test('childBlock returns only nested indexes', () => {
      const lines = ['catalog:', '  a: 1', '  b: 2', 'other:', '  c: 3'];
      expect(childBlock(lines, 0)).toEqual([1, 2]);
    });

    test('parseEntries reads quoted and unquoted keys', () => {
      const lines = [
        'catalog:',
        '  lodash: ^4.17.21',
        '  "@types/node": ^22.0.0',
        '  plain: 1',
        '  not-a-mapping',
        '    nested: 2',
      ];
      const entries = parseEntries(lines, childBlock(lines, 0));
      expect(entries).toEqual({
        lodash: '^4.17.21',
        '@types/node': '^22.0.0',
        plain: '1',
      });
    });

    test('parseEntries returns an empty object without a block', () => {
      expect(parseEntries([], [])).toEqual({});
    });
  });

  describe('readWorkspace', () => {
    test('returns a not-found result for a missing file', () => {
      expect(readWorkspace('does-not-exist.yaml')).toEqual({
        catalogs: {},
        minimumReleaseAge: null,
        minimumReleaseAgeExclude: [],
        found: false,
      });
    });

    test('reads the default catalog, cooldown and inline excludes', () => {
      const { workspace } = project(
        [
          'catalog:',
          '  lodash: ^4.17.21',
          'minimumReleaseAge: 10080',
          "minimumReleaseAgeExclude: [next, '@next/*']",
          '# a comment',
        ].join('\n')
      );

      expect(readWorkspace(workspace)).toEqual({
        catalogs: { default: { lodash: '^4.17.21' } },
        minimumReleaseAge: 10080,
        minimumReleaseAgeExclude: ['next', '@next/*'],
        found: true,
      });
    });

    test('reads named catalogs and list-form excludes', () => {
      const { workspace } = project(
        [
          'catalogs:',
          '  dev:',
          '    lodash: ^4.17.21',
          '    "@types/node": ^22.0.0',
          'minimumReleaseAgeExclude:',
          '  - next',
          "  - '@next/*'",
        ].join('\n')
      );

      expect(readWorkspace(workspace)).toEqual({
        catalogs: {
          dev: { lodash: '^4.17.21', '@types/node': '^22.0.0' },
        },
        minimumReleaseAge: null,
        minimumReleaseAgeExclude: ['next', '@next/*'],
        found: true,
      });
    });

    test('tolerates comments, blank lines and tabs', () => {
      const { workspace } = project(
        ['# comment', '', 'catalog:', '\tfoo: ^1.0.0'].join('\n')
      );

      expect(readWorkspace(workspace).catalogs.default).toEqual({
        foo: '^1.0.0',
      });
    });

    test('ignores empty named-catalog blocks and non-catalog children', () => {
      const { workspace } = project(
        ['catalogs:', 'minimumReleaseAge: 0', 'not-a-mapping'].join('\n')
      );

      expect(readWorkspace(workspace)).toEqual({
        catalogs: {},
        minimumReleaseAge: null,
        minimumReleaseAgeExclude: [],
        found: true,
      });
    });

    test('ignores unrelated top-level keys', () => {
      const { workspace } = project(
        ['packages:', '  - apps/*', 'nodeVersion: 22'].join('\n')
      );

      expect(readWorkspace(workspace).found).toBe(true);
    });

    test('reads a list-form exclude block', () => {
      const { workspace } = project(
        ['minimumReleaseAgeExclude:', '  - next'].join('\n')
      );

      expect(readWorkspace(workspace).minimumReleaseAgeExclude).toEqual([
        'next',
      ]);
    });

    test('keeps only matching named catalogs', () => {
      const { workspace } = project(
        ['catalogs:', '  - not-a-catalog', '  dev:', '    foo: ^1.0.0'].join(
          '\n'
        )
      );

      expect(readWorkspace(workspace).catalogs).toEqual({
        dev: { foo: '^1.0.0' },
      });
    });
  });

  describe('isPlainSemverRange', () => {
    test.each(['^1.2.3', '~1.2.3', '1.2.3', '>=1.2.3', 'v1.2.3'])(
      'accepts %s',
      (spec) => {
        expect(isPlainSemverRange(spec)).toBe(true);
      }
    );

    test.each([
      'catalog:dev',
      'workspace:*',
      'link:../x',
      'file:../x',
      'npm:other@1.0.0',
      'git+https://example.com/x.git',
      'github:user/repo',
      'https://example.com/x.tgz',
      'git:repo',
      'portal:../x',
      '',
      '*',
      'latest',
    ])('rejects %s', (spec) => {
      expect(isPlainSemverRange(spec)).toBe(false);
    });

    test('rejects non-strings', () => {
      expect(isPlainSemverRange(null)).toBe(false);
    });
  });

  describe('readManifestDeps', () => {
    test('reads plain ranges from all dependency fields', () => {
      const { manifest } = project('', {
        dependencies: { a: '^1.0.0', skipped: 'catalog:prod' },
        devDependencies: { b: '~2.0.0', skipped2: 'workspace:*' },
        optionalDependencies: { c: '3.0.0' },
      });

      expect(readManifestDeps(manifest)).toEqual({
        a: '^1.0.0',
        b: '~2.0.0',
        c: '3.0.0',
      });
    });

    test('returns an empty object for a missing manifest', () => {
      expect(readManifestDeps('does-not-exist.json')).toEqual({});
    });
  });

  describe('discoverEntries', () => {
    test('merges catalogs and manifest without duplicates', () => {
      const { workspace, manifest } = project(
        ['catalogs:', '  dev:', '    lodash: ^4.17.21'].join('\n'),
        {
          devDependencies: {
            lodash: 'catalog:dev',
            express: '^4.18.0',
          },
        }
      );

      const { entries, workspace: discovered } = discoverEntries({
        workspace,
        manifest,
      });

      expect(discovered.found).toBe(true);
      expect(entries).toEqual([
        { source: 'catalog:dev', name: 'lodash', range: '^4.17.21' },
        { source: 'package.json', name: 'express', range: '^4.18.0' },
      ]);
    });

    test('skips duplicate name/range pairs', () => {
      const { workspace, manifest } = project(
        ['catalog:', '  lodash: ^4.17.21'].join('\n'),
        { devDependencies: { lodash: '^4.17.21' } }
      );

      const { entries } = discoverEntries({ workspace, manifest });

      expect(entries).toEqual([
        { source: 'catalog:default', name: 'lodash', range: '^4.17.21' },
      ]);
    });
  });

  describe('semver helpers', () => {
    test('parseVersion handles releases, the v prefix and prereleases', () => {
      expect(parseVersion('v1.2.3')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: [],
      });
      expect(parseVersion('1.2.3-beta.1')).toEqual({
        major: 1,
        minor: 2,
        patch: 3,
        prerelease: ['beta', '1'],
      });
      expect(parseVersion('nope')).toBeNull();
    });

    test('comparePrerelease covers all branches', () => {
      expect(comparePrerelease([], [])).toBe(0);
      expect(comparePrerelease([], ['beta'])).toBe(1);
      expect(comparePrerelease(['beta'], [])).toBe(-1);
      expect(comparePrerelease(['beta'], ['beta'])).toBe(0);
      expect(comparePrerelease(['beta'], ['beta', '1'])).toBe(-1);
      expect(comparePrerelease(['beta', '1'], ['beta'])).toBe(1);
      expect(comparePrerelease(['1'], ['1'])).toBe(0);
      expect(comparePrerelease(['1'], ['2'])).toBe(-1);
      expect(comparePrerelease(['2'], ['1'])).toBe(1);
      expect(comparePrerelease(['alpha'], ['beta'])).toBe(-1);
      expect(comparePrerelease(['beta'], ['alpha'])).toBe(1);
      expect(comparePrerelease(['1'], ['alpha'])).toBe(-1);
      expect(comparePrerelease(['alpha'], ['1'])).toBe(1);
    });

    test('compareVersions compares major, minor, patch and prerelease', () => {
      expect(compareVersions('nope', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.1.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
      expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
      expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
    });

    test('baselineVersion handles prefixes and major-only ranges', () => {
      expect(baselineVersion('^1.2.3')).toBe('1.2.3');
      expect(baselineVersion('~1.2.3')).toBe('1.2.3');
      expect(baselineVersion('>=1.2.3')).toBe('1.2.3');
      expect(baselineVersion('^19')).toBe('19.0.0');
      expect(baselineVersion('1.2')).toBe('1.2.0');
      expect(baselineVersion('nope')).toBeNull();
    });

    test('rangePrefix preserves the operator style', () => {
      expect(rangePrefix('^1.2.3')).toBe('^');
      expect(rangePrefix('~1.2.3')).toBe('~');
      expect(rangePrefix('>=1.2.3')).toBe('>=');
      expect(rangePrefix('<=1.2.3')).toBe('<=');
      expect(rangePrefix('1.2.3')).toBe('');
      expect(rangePrefix('nope')).toBe('');
    });
  });

  describe('registry helpers', () => {
    test('readPnpmConfig trims output and fails open', () => {
      execFileSync.mockReturnValue('  value \n');
      expect(readPnpmConfig('registry')).toBe('value');

      execFileSync.mockImplementation(() => {
        throw new Error('pnpm missing');
      });
      expect(readPnpmConfig('registry')).toBe('');

      execFileSync.mockReturnValue(undefined);
      expect(readPnpmConfig('registry')).toBe('');
    });

    test('getScope extracts scopes', () => {
      expect(getScope('@scope/pkg')).toBe('@scope');
      expect(getScope('plain')).toBe('');
      expect(getScope('@scope')).toBe('');
    });

    test('getRegistry prefers a scoped registry, then the default', () => {
      const cache = new Map([['', 'https://cached.example/']]);
      expect(getRegistry('plain', cache)).toBe('https://cached.example/');

      registryMock();
      expect(getRegistry('plain', new Map())).toBe('https://registry.test/');

      execFileSync.mockImplementation((_command, args) => {
        const key = args?.[2];
        if (key === '@scope:registry') return 'https://scope.example/\n';
        return 'undefined\n';
      });
      expect(getRegistry('@scope/pkg', new Map())).toBe(
        'https://scope.example/'
      );

      execFileSync.mockReturnValue('undefined\n');
      expect(getRegistry('plain', new Map())).toBe(DEFAULT_REGISTRY);
    });

    test('getAuthHeader prefers a bearer token, then basic auth', () => {
      const cached = new Map([['https://cached/', 'Bearer cached']]);
      expect(getAuthHeader('https://cached/', cached)).toBe('Bearer cached');

      execFileSync.mockImplementation((_command, args) => {
        const key = args?.[2];
        if (key === '//registry.test/:_authToken') return 'token\n';
        return 'undefined\n';
      });
      expect(getAuthHeader('https://registry.test/', new Map())).toBe(
        'Bearer token'
      );

      execFileSync.mockImplementation((_command, args) => {
        const key = args?.[2];
        if (key === '//registry.test/:_auth') return 'basic\n';
        return 'undefined\n';
      });
      expect(getAuthHeader('https://registry.test/', new Map())).toBe(
        'Basic basic'
      );

      execFileSync.mockReturnValue('undefined\n');
      expect(getAuthHeader('https://registry.test/', new Map())).toBeNull();
    });

    test('adds a trailing slash to a registry without one', () => {
      execFileSync.mockImplementation((_command, args) => {
        const key = args?.[2];
        if (key === '//registry.test/:_authToken') return 'token\n';
        return 'undefined\n';
      });

      expect(getAuthHeader('https://registry.test', new Map())).toBe(
        'Bearer token'
      );
    });

    test('fetchPackageData returns data and includes auth', async () => {
      registryMock();
      execFileSync.mockImplementation((_command, args) => {
        const key = args?.[2];
        if (key === 'registry') return 'https://registry.test/\n';
        if (key === '//registry.test/:_authToken') return 'token\n';
        return 'undefined\n';
      });
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'lodash' }),
      });

      const result = await fetchPackageData('lodash', new Map(), new Map());

      expect(result).toEqual({ name: 'lodash' });
      expect(global.fetch).toHaveBeenCalledWith(expect.any(URL), {
        headers: {
          accept: 'application/json',
          authorization: 'Bearer token',
        },
      });
    });

    test('fetchPackageData adds a trailing slash to the registry', async () => {
      execFileSync.mockImplementation((_command, args) =>
        args?.[2] === 'registry' ? 'https://registry.test\n' : 'undefined\n'
      );
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ name: 'lodash' }),
      });

      await fetchPackageData('lodash', new Map(), new Map());

      expect(String(global.fetch.mock.calls[0][0])).toBe(
        'https://registry.test/lodash'
      );
    });

    test('fetchPackageData wraps HTTP errors', async () => {
      registryMock();
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        fetchPackageData('missing', new Map(), new Map())
      ).rejects.toThrow('HTTP 404 Not Found');
    });
  });

  describe('analyzePackage', () => {
    const opts = { staleMonths: 12 };
    const cooldown = { minutes: null, exclude: new Set() };

    test('labels an up-to-date package', () => {
      const result = analyzePackage(
        'pkg',
        '^1.2.3',
        packageData({ versions: ['1.2.3'] }),
        opts,
        cooldown
      );

      expect(result.status).toBe('UP_TO_DATE');
      expect(result.latestInMajor).toBe('1.2.3');
      expect(result.suggestedRange).toBeNull();
    });

    test('labels a safe minor/patch update', () => {
      const result = analyzePackage(
        'pkg',
        '^1.2.3',
        packageData({ versions: ['1.2.3', '1.3.0'] }),
        opts,
        cooldown
      );

      expect(result.status).toBe('MINOR_PATCH');
      expect(result.suggestedRange).toBe('^1.3.0');
      expect(result.targetAgeDays).toBe(0);
    });

    test('flags a major update', () => {
      const result = analyzePackage(
        'pkg',
        '^1.2.3',
        packageData({ versions: ['1.2.3', '2.0.0'] }),
        opts,
        cooldown
      );

      expect(result.status).toBe('MAJOR');
      expect(result.newerMajorLatest).toBe('2.0.0');
      expect(result.ceilingAgeDays).toBe(0);
    });

    test('flags a stale major', () => {
      const result = analyzePackage(
        'pkg',
        '^1.2.3',
        packageData({
          versions: ['1.2.3', '2.0.0'],
          times: { '1.2.3': OLD },
        }),
        opts,
        cooldown
      );

      expect(result.status).toBe('STALE_MAJOR');
      expect(result.ceilingAgeDays).toBeGreaterThan(365);
    });

    test('flags below-cooldown targets unless the package is exempt', () => {
      const data = packageData({ versions: ['1.2.3', '1.3.0'] });
      const cool = { minutes: 10080, exclude: new Set() };

      expect(
        analyzePackage('pkg', '^1.2.3', data, opts, cool).belowCooldown
      ).toBe(true);
      expect(
        analyzePackage('pkg', '^1.2.3', data, opts, {
          minutes: 10080,
          exclude: new Set(['pkg']),
        }).belowCooldown
      ).toBeNull();
    });

    test('surfaces deprecation and handles missing time data', () => {
      const data = packageData({
        versions: ['1.2.3', '1.3.0'],
        deprecated: 'use 2.x',
      });
      data.time = {};

      const result = analyzePackage('pkg', '^1.2.3', data, opts, cooldown);

      expect(result.deprecated).toBe(true);
      expect(result.targetAgeDays).toBeNull();
    });

    test('handles a range with no parseable baseline', () => {
      const result = analyzePackage(
        'pkg',
        'nope',
        packageData({ versions: ['1.2.3'] }),
        opts,
        cooldown
      );

      expect(result.status).toBe('UP_TO_DATE');
      expect(result.latestInMajor).toBe('1.2.3');
    });

    test('includes prereleases only when the range pins one', () => {
      const result = analyzePackage(
        'pkg',
        '1.2.3-beta.1',
        packageData({
          versions: ['1.2.3-beta.1', '1.2.3-beta.2', '1.2.4'],
        }),
        opts,
        cooldown
      );

      expect(result.status).toBe('MINOR_PATCH');
      expect(result.suggestedRange).toBe('1.2.4');
    });

    test('handles empty registry data', () => {
      const result = analyzePackage('pkg', '^1.2.3', {}, opts, cooldown);

      expect(result.status).toBe('UP_TO_DATE');
      expect(result.latestInMajor).toBe('1.2.3');
      expect(result.latestOverall).toBeNull();
    });

    test('ignores invalid and prerelease versions in the candidate list', () => {
      const data = packageData({ versions: ['1.2.3', '1.3.0-beta.1'] });
      data.versions['not-a-version'] = {};

      const result = analyzePackage('pkg', '^1.2.3', data, opts, cooldown);

      expect(result.status).toBe('UP_TO_DATE');
      expect(result.latestInMajor).toBe('1.2.3');
    });

    test('handles a null target age when a cooldown is configured', () => {
      const data = packageData({ versions: ['1.2.3', '1.3.0'] });
      data.time = {};

      const result = analyzePackage('pkg', '^1.2.3', data, opts, {
        minutes: 10080,
        exclude: new Set(),
      });

      expect(result.status).toBe('MINOR_PATCH');
      expect(result.targetAgeDays).toBeNull();
      expect(result.belowCooldown).toBeNull();
    });
  });

  describe('mapWithConcurrency', () => {
    test('returns an empty array for no items', async () => {
      await expect(
        mapWithConcurrency([], 2, async (item) => item)
      ).resolves.toEqual([]);
    });

    test('preserves order and caps concurrency', async () => {
      let active = 0;
      let maxActive = 0;
      const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return item * 2;
      });

      expect(result).toEqual([2, 4, 6, 8]);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(FETCH_CONCURRENCY).toBe(8);
    });
  });

  describe('renderTable', () => {
    const rows = [
      {
        name: 'a',
        status: 'UP_TO_DATE',
        currentRange: '^1.0.0',
        newerMajorLatest: null,
      },
      {
        name: 'b',
        status: 'MINOR_PATCH',
        currentRange: '^1.0.0',
        suggestedRange: '^1.1.0',
        targetAgeDays: 1,
        belowCooldown: true,
        newerMajorLatest: null,
      },
      {
        name: 'c',
        status: 'MAJOR',
        currentRange: '^1.0.0',
        ceilingAgeDays: 10,
        newerMajorLatest: '2.0.0',
      },
      {
        name: 'd',
        status: 'STALE_MAJOR',
        currentRange: '^1.0.0',
        ceilingAgeDays: 500,
        newerMajorLatest: '2.0.0',
      },
      {
        name: 'e',
        status: 'ERROR',
        error: 'HTTP 404',
      },
      {
        name: 'f',
        status: 'MINOR_PATCH',
        currentRange: '^1.0.0',
        suggestedRange: '^1.0.1',
        targetAgeDays: 10,
        belowCooldown: false,
        newerMajorLatest: null,
      },
      {
        name: 'g',
        status: 'MAJOR',
        currentRange: '^1.0.0',
        ceilingAgeDays: null,
        newerMajorLatest: '2.0.0',
      },
    ];

    test('renders every status and the cooldown', () => {
      const output = renderTable(rows, {
        minutes: 10080,
        exclude: new Set(['x']),
      });

      expect(output).toContain(
        'Release cooldown (minimumReleaseAge): 10080 min (7.0d), 1 exempt'
      );
      expect(output).toContain('UP_TO_DATE: 1');
      expect(output).toContain('MINOR_PATCH: 2');
      expect(output).toContain('MAJOR: 2');
      expect(output).toContain('STALE_MAJOR: 1');
      expect(output).toContain('ERROR: 1');
      expect(output).toContain('b  ^1.0.0 → ^1.1.0');
      expect(output).toContain('below minimumReleaseAge cooldown');
      expect(output).toContain('c  current ^1.0.0 [10d old]');
      expect(output).toContain('e  (HTTP 404)');
    });

    test('reports when no cooldown is configured', () => {
      expect(renderTable([], { minutes: null, exclude: new Set() })).toContain(
        'Release cooldown (minimumReleaseAge): not set'
      );
    });
  });

  describe('main', () => {
    const workspaceYaml = [
      'catalogs:',
      '  dev:',
      '    lodash: ^4.17.21',
      'minimumReleaseAge: 10080',
    ].join('\n');

    test('prints a table and exits 0 for a safe update', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });
      registryMock();
      fetchMock({
        lodash: packageData({ versions: ['4.17.21', '4.17.22'] }),
      });
      const stdout = captureStdout();

      try {
        const code = await main([
          '--package',
          'lodash',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(0);
        expect(stdout.output).toContain('lodash');
        expect(stdout.output).toContain('Safe minor/patch update');
      } finally {
        stdout.restore();
      }
    });

    test('prints JSON when requested', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });
      registryMock();
      fetchMock({
        lodash: packageData({ versions: ['4.17.21', '4.17.22'] }),
      });
      const stdout = captureStdout();

      try {
        const code = await main([
          '--package',
          'lodash',
          '--json',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(0);
        const parsed = JSON.parse(stdout.output);
        expect(parsed.cooldownMinutes).toBe(10080);
        expect(parsed.rows[0].name).toBe('lodash');
      } finally {
        stdout.restore();
      }
    });

    test('exits 3 when a major update is pending', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });
      registryMock();
      fetchMock({
        lodash: packageData({ versions: ['4.17.21', '5.0.0'] }),
      });
      const stdout = captureStdout();

      try {
        const code = await main([
          '--package',
          'lodash',
          '--json',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(3);
      } finally {
        stdout.restore();
      }
    });

    test('filters by catalog source', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: {
          lodash: 'catalog:dev',
          express: '^4.18.0',
        },
      });
      registryMock();
      fetchMock({
        express: packageData({ versions: ['4.18.0', '4.18.1'] }),
      });
      const stdout = captureStdout();

      try {
        const code = await main([
          '--catalog',
          'package.json',
          '--json',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(0);
        const parsed = JSON.parse(stdout.output);
        expect(parsed.rows.map((row) => row.name)).toEqual(['express']);
      } finally {
        stdout.restore();
      }
    });

    test('records a registry error as an ERROR row', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });
      registryMock();
      global.fetch.mockRejectedValue(new Error('network down'));
      const stdout = captureStdout();

      try {
        const code = await main([
          '--package',
          'lodash',
          '--json',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(0);
        const parsed = JSON.parse(stdout.output);
        expect(parsed.rows[0].status).toBe('ERROR');
        expect(parsed.rows[0].error).toContain('network down');
      } finally {
        stdout.restore();
      }
    });

    test('applies minimumReleaseAgeExclude entries to the cooldown', async () => {
      const yaml = [
        'catalogs:',
        '  dev:',
        '    lodash: ^4.17.21',
        '    "@types/node": ^22.0.0',
        'minimumReleaseAge: 10080',
        'minimumReleaseAgeExclude:',
        '  - lodash',
        "  - '@types/*'",
      ].join('\n');
      const { workspace, manifest } = project(yaml, {
        devDependencies: {
          lodash: 'catalog:dev',
          '@types/node': 'catalog:dev',
        },
      });
      registryMock();
      fetchMock({
        lodash: packageData({ versions: ['4.17.21', '4.17.22'] }),
        '@types/node': packageData({ versions: ['22.0.0', '22.0.1'] }),
      });
      const stdout = captureStdout();

      try {
        const code = await main([
          '--json',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ]);

        expect(code).toBe(0);
        const parsed = JSON.parse(stdout.output);
        expect(
          parsed.rows.find((row) => row.name === 'lodash').belowCooldown
        ).toBeNull();
        expect(
          parsed.rows.find((row) => row.name === '@types/node').belowCooldown
        ).toBeNull();
      } finally {
        stdout.restore();
      }
    });

    test('rejects when no package matches', async () => {
      const { workspace, manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });

      await expect(
        main([
          '--package',
          'missing',
          '--workspace',
          workspace,
          '--manifest',
          manifest,
        ])
      ).rejects.toThrow('No matching package "missing" found');
    });

    test('reports a missing workspace file in the error', async () => {
      const { manifest } = project(workspaceYaml, {
        devDependencies: { lodash: 'catalog:dev' },
      });
      const missing = path.join(path.dirname(manifest), 'missing.yaml');

      await expect(
        main([
          '--package',
          'lodash',
          '--workspace',
          missing,
          '--manifest',
          manifest,
        ])
      ).rejects.toThrow('(no ');
    });

    test('reports a no-dependency error without a package filter', async () => {
      const { workspace, manifest } = project('catalogs:\n', {});

      await expect(
        main(['--workspace', workspace, '--manifest', manifest])
      ).rejects.toThrow('No matching dependencies found');
    });
  });
});
