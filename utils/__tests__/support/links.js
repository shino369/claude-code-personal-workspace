/**
 * Test fixture helpers that work on every OS. Not a test file: vitest.config.js
 * excludes `__tests__/support/`.
 */
import fs from 'fs';
import path from 'path';

/**
 * Create a directory link for a fixture: a symlink on macOS/Linux, a junction
 * on Windows (junctions need no Developer Mode or admin rights). A relative
 * target is resolved against the link's folder first, because Windows resolves
 * junction targets against the working directory instead.
 *
 * @param {string} target
 * @param {string} link
 * @param {NodeJS.Platform} [platform]
 */
export function linkDir(target, link, platform = process.platform) {
  if (platform === 'win32') {
    fs.symlinkSync(path.resolve(path.dirname(link), target), link, 'junction');
  } else {
    fs.symlinkSync(target, link, 'dir');
  }
}

/** The link kinds `createLink` may return on this OS (junction only on Windows). */
export const LINK_KINDS =
  process.platform === 'win32' ? ['symlink', 'junction'] : ['symlink'];
