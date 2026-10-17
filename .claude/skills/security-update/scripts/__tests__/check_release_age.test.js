/**
 * Tests for check_release_age.mjs
 */
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  MIN_AGE_MINUTES,
  getErrorMessage,
  usage,
  readPnpmConfig,
  getScope,
  getRegistry,
  buildPackageUrl,
  fetchPackageData,
  resolveVersion,
  extractPublishedDate,
  checkReleaseAge,
  main,
} from '../check_release_age.mjs';

function registryMock() {
  execFileSync.mockImplementation((_command, args) => {
    const key = args?.[2];
    if (key === 'registry') return 'https://registry.test/\n';
    return 'undefined\n';
  });
}

function packageData(time = {}, distTags = {}) {
  return { time, 'dist-tags': distTags };
}

function fetchData(data) {
  global.fetch.mockResolvedValue({
    ok: true,
    json: async () => data,
  });
}

describe('check_release_age', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    execFileSync.mockReset();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('getErrorMessage handles errors and non-errors', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('plain')).toBe('plain');
  });

  test('usage prints the expected lines', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    usage();

    expect(spy).toHaveBeenCalledWith(
      'Usage: check_release_age.mjs <package-name> <version>'
    );
    expect(spy).toHaveBeenCalledWith(
      'Example: check_release_age.mjs lodash 4.17.21'
    );
  });

  describe('readPnpmConfig', () => {
    test('trims output', () => {
      execFileSync.mockReturnValue('  value \n');
      expect(readPnpmConfig('registry')).toBe('value');
    });

    test('fails open on missing pnpm or empty output', () => {
      execFileSync.mockImplementation(() => {
        throw new Error('pnpm missing');
      });
      expect(readPnpmConfig('registry')).toBe('');

      execFileSync.mockReturnValue(undefined);
      expect(readPnpmConfig('registry')).toBe('');
    });
  });

  test('getScope extracts scopes', () => {
    expect(getScope('@scope/pkg')).toBe('@scope');
    expect(getScope('plain')).toBe('');
    expect(getScope('@scope')).toBe('');
  });

  test('getRegistry prefers a scoped registry, then the default', () => {
    execFileSync.mockImplementation((_command, args) => {
      const key = args?.[2];
      if (key === '@scope:registry') return 'https://scope.example/\n';
      if (key === 'registry') return 'https://registry.test/\n';
      return 'undefined\n';
    });

    expect(getRegistry('@scope/pkg')).toBe('https://scope.example/');
    expect(getRegistry('plain')).toBe('https://registry.test/');

    execFileSync.mockReturnValue('undefined\n');
    expect(getRegistry('plain')).toBe('https://registry.npmjs.org/');
  });

  test('buildPackageUrl handles trailing slashes and encoding', () => {
    expect(String(buildPackageUrl('https://registry.test/', 'lodash'))).toBe(
      'https://registry.test/lodash'
    );
    expect(String(buildPackageUrl('https://registry.test', 'lodash'))).toBe(
      'https://registry.test/lodash'
    );
    expect(
      String(buildPackageUrl('https://registry.test/', '@scope/pkg'))
    ).toBe('https://registry.test/%40scope%2Fpkg');
  });

  describe('fetchPackageData', () => {
    test('returns the registry and parsed data', async () => {
      registryMock();
      fetchData({ name: 'lodash' });

      await expect(fetchPackageData('lodash')).resolves.toEqual({
        registry: 'https://registry.test/',
        data: { name: 'lodash' },
      });
    });

    test('wraps HTTP errors', async () => {
      registryMock();
      global.fetch.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(fetchPackageData('missing')).rejects.toThrow(
        'Could not fetch package data for missing from https://registry.test/: HTTP 404 Not Found'
      );
    });

    test('wraps network errors', async () => {
      registryMock();
      global.fetch.mockRejectedValue(new Error('network down'));

      await expect(fetchPackageData('lodash')).rejects.toThrow('network down');
    });
  });

  describe('resolveVersion', () => {
    test('resolves a dist-tag and logs it', () => {
      const log = vi.fn();

      expect(
        resolveVersion(packageData({}, { latest: '1.2.3' }), 'latest', log)
      ).toBe('1.2.3');
      expect(log).toHaveBeenCalledWith("Resolved dist-tag 'latest' -> 1.2.3");
    });

    test('returns the requested version when it is not a dist-tag', () => {
      expect(resolveVersion(packageData(), '1.2.3')).toBe('1.2.3');
    });

    test('tolerates missing dist-tags', () => {
      expect(resolveVersion({}, '1.2.3')).toBe('1.2.3');
    });
  });

  describe('extractPublishedDate', () => {
    test('returns the timestamp', () => {
      expect(
        extractPublishedDate(
          packageData({ '1.2.3': '2026-01-01' }),
          'pkg',
          '1.2.3'
        )
      ).toBe('2026-01-01');
    });

    test('throws with the latest available versions when missing', () => {
      expect(() =>
        extractPublishedDate(packageData({ '1.0.0': 'x' }), 'pkg', '2.0.0')
      ).toThrow(
        'Version 2.0.0 not found in registry time map for pkg. Available versions (latest 10): 1.0.0'
      );
    });

    test('tolerates a missing time map', () => {
      expect(() => extractPublishedDate({}, 'pkg', '1.0.0')).toThrow(
        'Available versions (latest 10): '
      );
    });
  });

  describe('checkReleaseAge', () => {
    test('returns 0 for a version older than the minimum age', async () => {
      registryMock();
      fetchData(packageData({ '1.0.0': '2026-01-01T00:00:00.000Z' }));
      const log = vi.fn();

      const code = await checkReleaseAge('pkg', '1.0.0', {
        now: () => Date.parse('2026-01-15T00:00:00.000Z'),
        log,
      });

      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Result   : SAFE')
      );
      expect(MIN_AGE_MINUTES).toBe(10080);
    });

    test('returns 1 for a version younger than the minimum age', async () => {
      registryMock();
      fetchData(packageData({ '1.0.0': '2026-01-14T00:00:00.000Z' }));
      const log = vi.fn();

      const code = await checkReleaseAge('pkg', '1.0.0', {
        now: () => Date.parse('2026-01-15T00:00:00.000Z'),
        log,
      });

      expect(code).toBe(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Result   : TOO NEW')
      );
    });

    test('resolves a dist-tag before checking', async () => {
      registryMock();
      fetchData(
        packageData(
          { '1.0.0': '2026-01-01T00:00:00.000Z' },
          { latest: '1.0.0' }
        )
      );
      const log = vi.fn();

      const code = await checkReleaseAge('pkg', 'latest', {
        now: () => Date.parse('2026-01-15T00:00:00.000Z'),
        log,
      });

      expect(code).toBe(0);
      expect(log).toHaveBeenCalledWith("Resolved dist-tag 'latest' -> 1.0.0");
    });

    test('throws on an invalid publish timestamp', async () => {
      registryMock();
      fetchData(packageData({ '1.0.0': 'not-a-date' }));

      await expect(
        checkReleaseAge('pkg', '1.0.0', { log: vi.fn() })
      ).rejects.toThrow('Invalid publish timestamp for pkg@1.0.0: not-a-date');
    });
  });

  describe('main', () => {
    test('prints usage and returns 2 for the wrong argument count', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(main(['only-one'])).resolves.toBe(2);
      expect(spy).toHaveBeenCalledWith(
        'Usage: check_release_age.mjs <package-name> <version>'
      );
    });

    test('returns the check result', async () => {
      registryMock();
      fetchData(packageData({ '1.0.0': '2026-01-01T00:00:00.000Z' }));

      await expect(
        main(['pkg', '1.0.0'], {
          now: () => Date.parse('2026-01-15T00:00:00.000Z'),
          log: vi.fn(),
        })
      ).resolves.toBe(0);
    });

    test('reports errors and returns 2', async () => {
      registryMock();
      global.fetch.mockRejectedValue(new Error('network down'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(main(['pkg', '1.0.0'])).resolves.toBe(2);
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('ERROR: Could not fetch package data')
      );
    });
  });
});
