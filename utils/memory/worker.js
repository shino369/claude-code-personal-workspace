#!/usr/bin/env node
/**
 * The detached worker that memory hooks start (queue.js kickWorker): it
 * extracts the queued sessions (extract.js), then consolidates when that is
 * due (consolidate.js), each under the worker lock, and exits.
 */
import { runIfMain } from '../module-runner.js';
import { consolidateLocked, consolidationDue } from './consolidate.js';
import { defaultExtractDeps, runWorker } from './extract.js';

/**
 * @param {import('./extract.js').ExtractDeps} deps
 * @returns {import('./extract.js').Run[] | null} null while another worker runs
 */
export function work(deps) {
  const runs = runWorker(deps);
  if (runs === null) return null;
  if (!consolidationDue(deps.rootDir, { now: deps.now() })) return runs;
  return [...runs, consolidateLocked(deps)].filter((run) => run !== null);
}

/* c8 ignore start - the detached entry point; work is tested */
function main() {
  try {
    work(defaultExtractDeps());
  } catch {
    // Detached, with nobody to tell: the queue keeps its entries for the
    // next session's catch-up.
  }
  process.exit(0);
}
/* c8 ignore stop */

runIfMain(import.meta.url, main);
