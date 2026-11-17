export const meta = {
  name: 'implement-plan',
  description:
    "Implement a task's todo steps in parallel worktrees, in dependency order, then merge and verify",
  whenToUse:
    'A task with several todo steps (pnpm task status). Claude-subagent version of pnpm swarm. args: { task?: "<name>", maxSteps?: 6 }',
  phases: [
    { title: 'Plan', detail: 'read the task (plan steps if it has none)' },
    {
      title: 'Implement',
      detail: 'one worktree agent per step, after its deps',
    },
    {
      title: 'Integrate',
      detail: 'merge step branches into wf/<task>, run verify',
    },
    {
      title: 'Verify',
      detail: 'independent verifier on the integration branch',
    },
  ],
};

const input = typeof args === 'object' && args !== null ? args : {};
const taskArg = typeof input.task === 'string' && input.task ? input.task : '';
const maxSteps =
  Number.isInteger(input.maxSteps) && input.maxSteps > 0 ? input.maxSteps : 6;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: 'full task name, e.g. my-task-261117',
    },
    root: { type: 'string', description: 'absolute path of the main checkout' },
    verify: { type: 'array', items: { type: 'string' } },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'status', 'deps'],
      },
    },
    problem: { type: 'string', description: 'set when the task cannot be run' },
  },
  required: ['task', 'root', 'verify', 'steps'],
};

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    ok: { type: 'boolean' },
    branch: { type: 'string' },
    sha: { type: 'string' },
    summary: { type: 'string' },
    failed: {
      type: 'string',
      description: 'what still fails, when ok is false',
    },
  },
  required: ['id', 'ok', 'branch', 'summary'],
};

const INTEGRATE_SCHEMA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    dir: { type: 'string' },
    merged: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    verifyOk: { type: 'boolean' },
    output: {
      type: 'string',
      description: 'tail of the failing verify output',
    },
  },
  required: ['branch', 'dir', 'merged', 'conflicts', 'verifyOk'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    report: { type: 'string' },
  },
  required: ['pass', 'report'],
};

phase('Plan');
const plan = await agent(
  [
    `Read the task${taskArg ? ` ${taskArg}` : ' that is active'} in this workspace and return its steps.`,
    `Run \`pnpm task status${taskArg ? ` ${taskArg}` : ''} --json\` (and \`pnpm task help\` if unsure). The main checkout is the first entry of \`git worktree list\`.`,
    'If the task has no steps at all, plan them first by following .claude/agents/planner.md (record them with pnpm task), then return them.',
    'If there is no such task, it has no verify commands, or it has no state.json, set `problem` to the reason and the Fix: command.',
    `Then run \`pnpm swarm ${taskArg || '<task>'} --agent claude --dry-run\` (it starts nothing). If it fails because the task keeps code in its task folder, set \`problem\` to its message: tasks/ is git-ignored, so worktrees cannot pass that code between steps either.`,
  ].join('\n'),
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA }
);

if (!plan || plan.problem) {
  log(`Cannot run: ${plan?.problem ?? 'the plan agent did not return'}`);
  return { ok: false, problem: plan?.problem ?? 'no plan', steps: [] };
}
if (plan.verify.length === 0) {
  log('The task has no verify commands, so steps have no finish line.');
  return {
    ok: false,
    problem: `no verify commands. Fix: pnpm task set --task ${plan.task} --verify "pnpm check"`,
    steps: [],
  };
}

const byId = new Map(plan.steps.map((s) => [s.id, s]));
const isDone = (id) => byId.get(id)?.status === 'done';
const todo = plan.steps.filter((s) => s.status === 'todo');
// A todo step can run here only if each dependency is done already or runs
// here too. Repeat passes so the order of steps in the plan does not matter;
// `runnable` ends up in dependency order.
const inRun = (id) => runnable.some((r) => r.id === id);
const runnable = [];
let pending = todo;
for (let changed = true; changed && runnable.length < maxSteps;) {
  changed = false;
  for (const step of pending) {
    if (runnable.length >= maxSteps) break;
    if (step.deps.every((d) => isDone(d) || inRun(d))) {
      runnable.push(step);
      changed = true;
    }
  }
  pending = pending.filter((s) => !runnable.includes(s));
}
const skipped = pending.map((step) => {
  const waiting = step.deps.filter((d) => !isDone(d) && !inRun(d));
  return {
    id: step.id,
    reason:
      waiting.length > 0
        ? `waits on ${waiting.join(', ')}`
        : `over maxSteps (${maxSteps})`,
  };
});
for (const s of skipped) log(`skip ${s.id}: ${s.reason}`);
if (runnable.length === 0) {
  log('No todo step can start.');
  return { ok: false, problem: 'nothing to run', steps: [], skipped };
}
log(
  `${runnable.length} step(s) to run: ${runnable.map((s) => s.id).join(', ')}`
);

const branchOf = (id) => `wf/${plan.task}--${id}`;
const owner = (id) => `workflow/${id}`;
const taskCmd = (rest) =>
  `pnpm --dir "${plan.root}" task ${rest} --task ${plan.task}`;

const stepPrompt = (step) => {
  const deps = step.deps.filter((d) => !isDone(d));
  return [
    `Implement step ${step.id} of task ${plan.task}: ${step.title}`,
    '',
    `You are in an isolated git worktree. The main checkout is ${plan.root}; read the plan there: ${plan.root}/tasks/${plan.task}/plan.md.`,
    'Other agents implement the other steps in parallel. Do only this step.',
    '',
    'Procedure:',
    `1. Claim it: \`${taskCmd(`claim ${step.id}`)} --agent ${owner(step.id)}\`. If that fails, stop and return ok=false with the error.`,
    `2. \`git switch -c ${branchOf(step.id)}\`${deps.length > 0 ? `, then \`git merge --no-edit ${deps.map(branchOf).join(' ')}\` (your dependencies' work)` : ''}.`,
    '3. If node_modules is missing: `pnpm install --frozen-lockfile --prefer-offline`.',
    `4. Implement the step, with tests. Then run, from this worktree's root: ${plan.verify.map((c) => `\`${c}\``).join(' && ')}. Fix and re-run until it passes (at most 3 tries).`,
    `5. Commit: \`git add -A && git commit -m "chore: workflow step ${step.id}" -m "${step.id}. <title>"\`. Never --no-verify; if a hook fails, fix the cause.`,
    `6. Record it in the main checkout: on success \`${taskCmd(`step ${step.id} done`)} --agent ${owner(step.id)} -m "branch ${branchOf(step.id)}"\`; on failure \`${taskCmd(`step ${step.id} blocked`)} --agent ${owner(step.id)} -m "<what fails>"\`.`,
    '',
    'Rules: do not push, do not touch the main checkout except through the pnpm task commands above, do not weaken tests or verify commands. Nobody will answer questions.',
    'Return id, ok, branch, the commit sha, a short summary, and what still fails if not ok.',
  ].join('\n');
};

const promises = new Map();
for (const step of runnable) {
  const deps = step.deps
    .filter((d) => promises.has(d))
    .map((d) => promises.get(d));
  promises.set(
    step.id,
    Promise.all(deps).then((depResults) => {
      const failed = depResults.find((r) => !r.ok);
      if (failed) {
        log(`skip ${step.id}: dependency ${failed.id} did not finish`);
        return {
          id: step.id,
          ok: false,
          branch: branchOf(step.id),
          summary: `not started: dependency ${failed.id} did not finish`,
        };
      }
      return agent(stepPrompt(step), {
        label: `step:${step.id}`,
        phase: 'Implement',
        isolation: 'worktree',
        schema: STEP_SCHEMA,
      }).then(
        (r) =>
          r ?? {
            id: step.id,
            ok: false,
            branch: branchOf(step.id),
            summary: 'the step agent did not return',
          }
      );
    })
  );
}
const steps = await Promise.all(runnable.map((s) => promises.get(s.id)));
const good = steps.filter((s) => s.ok);
log(`${good.length}/${steps.length} step(s) finished`);
if (good.length === 0) {
  return { ok: false, steps, skipped, integration: null, verdict: null };
}

phase('Integrate');
const integration = await agent(
  [
    `Merge the finished step branches of task ${plan.task} into an integration branch, then run verify there.`,
    `Main checkout: ${plan.root}. Integration branch: wf/${plan.task}, in the worktree <parent of ${plan.root}>/<repo name>-wt/wf-${plan.task}.`,
    `1. Create it from the main checkout's HEAD if missing (\`git -C "${plan.root}" worktree add -b wf/${plan.task} <dir> HEAD\`), or reuse it.`,
    `2. In plan order, \`git merge --no-ff --no-edit <branch>\` each of: ${good.map((s) => s.branch).join(', ')}. On a conflict, \`git merge --abort\`, list the branch under conflicts, and continue.`,
    `3. Copy ${plan.root}/tasks/${plan.task} into <dir>/tasks/ if it is missing; run \`pnpm install --frozen-lockfile --prefer-offline\` if node_modules is missing.`,
    `4. Run ${plan.verify.map((c) => `\`${c}\``).join(' && ')} in <dir>. Do not fix anything.`,
    'Never push, never touch other branches, never --no-verify. Return the branch, dir, merged and conflicting branches, whether verify passed, and the failing output tail.',
  ].join('\n'),
  { label: 'integrate', phase: 'Integrate', schema: INTEGRATE_SCHEMA }
);
if (!integration) {
  return { ok: false, steps, skipped, integration: null, verdict: null };
}

phase('Verify');
const verdict = await agent(
  [
    'Follow the role in .claude/agents/verifier.md.',
    `Directory under review: ${integration.dir} (branch ${integration.branch}); diff base: the merge base with the main checkout's HEAD (${plan.root}).`,
    `Task: ${plan.task} (plan: ${plan.root}/tasks/${plan.task}/plan.md). Steps merged: ${integration.merged.join(', ') || 'none'}.`,
    'Return pass and your full report.',
  ].join('\n'),
  { label: 'verifier', phase: 'Verify', schema: VERDICT_SCHEMA }
);

const ok =
  steps.every((s) => s.ok) &&
  skipped.length === 0 &&
  integration.conflicts.length === 0 &&
  integration.verifyOk &&
  Boolean(verdict?.pass);
log(
  `${ok ? 'Done' : 'Not done'}: review ${integration.branch} in ${integration.dir}, then merge it yourself.`
);
return { ok, steps, skipped, integration, verdict };
