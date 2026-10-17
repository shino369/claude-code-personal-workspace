#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { runIfMain } from '#utils/module-runner.js';

export const MIN_AGE_MINUTES = 10080;

/**
 * @param {unknown} error
 * @returns {string}
 */
export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function usage() {
  console.error('Usage: check_release_age.mjs <package-name> <version>');
  console.error('Example: check_release_age.mjs lodash 4.17.21');
}

/**
 * @param {string} key
 * @returns {string}
 */
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

/**
 * @param {string} packageName
 * @returns {string}
 */
export function getScope(packageName) {
  if (!packageName.startsWith('@')) {
    return '';
  }

  const slashIndex = packageName.indexOf('/');
  if (slashIndex === -1) {
    return '';
  }

  return packageName.slice(0, slashIndex);
}

/**
 * @param {string} packageName
 * @returns {string}
 */
export function getRegistry(packageName) {
  const scope = getScope(packageName);
  const scopedRegistry = scope ? readPnpmConfig(`${scope}:registry`) : '';
  const registry =
    scopedRegistry && scopedRegistry !== 'undefined'
      ? scopedRegistry
      : readPnpmConfig('registry');

  return registry && registry !== 'undefined'
    ? registry
    : 'https://registry.npmjs.org/';
}

/**
 * @param {string} registry
 * @param {string} packageName
 * @returns {URL}
 */
export function buildPackageUrl(registry, packageName) {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  return new URL(encodeURIComponent(packageName), base);
}

/**
 * @param {string} packageName
 * @returns {Promise<{ registry: string, data: object }>}
 */
export async function fetchPackageData(packageName) {
  const registry = getRegistry(packageName);
  const packageUrl = buildPackageUrl(registry, packageName);

  try {
    const response = await fetch(packageUrl, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return {
      registry,
      data: await response.json(),
    };
  } catch (error) {
    throw new Error(
      `Could not fetch package data for ${packageName} from ${registry}: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * @param {object} packageData
 * @param {string} version
 * @param {(...args: unknown[]) => void} [log]
 * @returns {string}
 */
export function resolveVersion(packageData, version, log = console.log) {
  const distTags = packageData['dist-tags'] ?? {};

  if (Object.prototype.hasOwnProperty.call(distTags, version)) {
    const resolved = distTags[version];
    log(`Resolved dist-tag '${version}' -> ${resolved}`);
    return resolved;
  }

  return version;
}

/**
 * @param {object} packageData
 * @param {string} packageName
 * @param {string} version
 * @returns {string}
 */
export function extractPublishedDate(packageData, packageName, version) {
  const timeMap = packageData.time ?? {};
  const published = timeMap[version];

  if (!published) {
    const versions = Object.keys(timeMap).slice(-10).join(', ');
    throw new Error(
      `Version ${version} not found in registry time map for ${packageName}. Available versions (latest 10): ${versions}`,
    );
  }

  return published;
}

/**
 * @param {string} packageName
 * @param {string} requestedVersion
 * @param {{ now?: () => number, log?: (...args: unknown[]) => void }} [options]
 * @returns {Promise<number>} 0 = safe, 1 = too new
 */
export async function checkReleaseAge(
  packageName,
  requestedVersion,
  { now = Date.now, log = console.log } = {},
) {
  const { registry, data } = await fetchPackageData(packageName);
  const version = resolveVersion(data, requestedVersion, log);
  const published = extractPublishedDate(data, packageName, version);
  const publishedDate = new Date(published);

  if (Number.isNaN(publishedDate.getTime())) {
    throw new Error(
      `Invalid publish timestamp for ${packageName}@${version}: ${published}`,
    );
  }

  const ageMinutes = Math.floor((now() - publishedDate.getTime()) / 60000);
  const ageDays = ageMinutes / 60 / 24;

  log(`Package : ${packageName}@${version}`);
  log(`Registry: ${registry}`);
  log(`Published: ${published}`);
  log(
    `Age      : ${ageMinutes.toLocaleString('en-US')} minutes (${ageDays.toFixed(1)} days)`,
  );
  log(
    `Minimum  : ${MIN_AGE_MINUTES.toLocaleString('en-US')} minutes (7 days)`,
  );

  if (ageMinutes >= MIN_AGE_MINUTES) {
    log(`Result   : SAFE - version is ${ageDays.toFixed(1)} days old`);
    return 0;
  }

  const remaining = MIN_AGE_MINUTES - ageMinutes;
  log(
    `Result   : TOO NEW - ${remaining.toLocaleString('en-US')} minutes (${(remaining / 60).toFixed(1)} hours) until safe`,
  );
  log('           Do not use this version. Choose an older safe release.');
  return 1;
}

/**
 * @param {string[]} [argv]
 * @param {{ now?: () => number, log?: (...args: unknown[]) => void }} [options]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), options = {}) {
  if (argv.length !== 2) {
    usage();
    return 2;
  }

  try {
    return await checkReleaseAge(argv[0], argv[1], options);
  } catch (error) {
    console.error(`ERROR: ${getErrorMessage(error)}`);
    return 2;
  }
}

/* istanbul ignore next - CLI entry point, exercises the tested main() */
runIfMain(import.meta.url, () => {
  main()
    .then(code => {
      // Let stdout flush naturally; process.exit() can truncate piped output.
      process.exitCode = code;
    })
    .catch(error => {
      console.error(`ERROR: ${getErrorMessage(error)}`);
      process.exitCode = 2;
    });
});
