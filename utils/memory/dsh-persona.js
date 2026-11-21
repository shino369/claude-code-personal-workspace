/** Cordis plugin loaded only by the persona job's DSH profile overlay. */
export const name = 'memory-persona-isolation';
export const inject = ['tools'];

/**
 * @param {{
 *   tools: { guard: (check: () => string) => void },
 *   on: (event: 'agent/created', listener: (payload: { agent: { ctx: { tools: { restrict: (filter: { allow: string[] }) => void } } } }) => void) => void,
 *   provide: (key: string, ready: boolean) => void,
 * }} ctx
 */
export function apply(ctx) {
  ctx.tools.guard(() => 'Tools are disabled for persona jobs.');
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [] });
  });
  // The runner waits for this service before it reads the prompt.
  ctx.provide('personaIsolation', true);
}
