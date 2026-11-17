export const meta = {
  name: 'review-changes',
  description:
    'Review the current branch: find issues per dimension, then adversarially verify each',
  whenToUse:
    'Before committing or opening a PR. args: { base?: "main", focus?: "what to look at" }',
  phases: [
    { title: 'Scope', detail: 'list changed files against the base' },
    {
      title: 'Review',
      detail: 'correctness, security, tests, standards (one agent each)',
    },
    { title: 'Verify', detail: 'one skeptic per dimension tries to refute' },
  ],
};

const input = typeof args === 'object' && args !== null ? args : {};
const base = typeof input.base === 'string' && input.base ? input.base : 'main';
const focus = typeof input.focus === 'string' ? input.focus : '';

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string', description: 'the resolved base commit or ref' },
    summary: {
      type: 'string',
      description: 'what the change does, 1-3 sentences',
    },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, change: { type: 'string' } },
        required: ['path', 'change'],
      },
    },
  },
  required: ['base', 'summary', 'files'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          failure_scenario: {
            type: 'string',
            description: 'concrete input or state, and the wrong result',
          },
          fix: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'title', 'failure_scenario'],
      },
    },
  },
  required: ['findings'],
};

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          real: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'real', 'reason'],
      },
    },
  },
  required: ['verdicts'],
};

const DIMENSIONS = [
  {
    key: 'correctness',
    prompt:
      'Find bugs: wrong logic, unhandled edge cases (empty, missing, concurrent, Windows paths), broken error paths, and behavior that contradicts the docs or help text.',
  },
  {
    key: 'security',
    prompt:
      'Find security problems: command injection (shell strings, user text in argv), path traversal, secrets read/logged/committed (AGENTS.md §1), unsafe file writes, and anything that runs downloaded code.',
  },
  {
    key: 'tests',
    prompt:
      'Review the tests against .claude/rules/testing.md: untested branches, tests that would pass with the bug present, weakened or skipped tests, new coverage ignores, and missing tests for new behavior.',
  },
  {
    key: 'standards',
    prompt:
      'Check repo standards: AGENTS.md rules, .claude/rules/working-with-script.md (runIfMain, input validation, errors with a Fix: line), docs and help text updated for changed behavior, and no stale references.',
  },
];

phase('Scope');
const scope = await agent(
  [
    `Scope a code review of this repository's current branch against \`${base}\`.`,
    `Run \`git merge-base HEAD ${base}\` (fall back to \`${base}\` itself), then \`git diff --stat <base>\` and \`git status --porcelain\`; include uncommitted changes.`,
    'Skip generated and git-ignored files (tasks/, logs/, coverage/).',
    'Return the base you used, a short summary of the change, and every changed file with a one-line description.',
  ].join('\n'),
  { label: 'scope', phase: 'Scope', schema: SCOPE_SCHEMA }
);

if (!scope || scope.files.length === 0) {
  log(`No changes against ${base}; nothing to review.`);
  return { base, summary: scope?.summary ?? '', confirmed: [], rejected: 0 };
}
log(`${scope.files.length} changed file(s) against ${scope.base}`);

const fileList = scope.files.map((f) => `- ${f.path}: ${f.change}`).join('\n');

const results = await pipeline(
  DIMENSIONS,
  (d) =>
    agent(
      [
        `You are reviewing a change for **${d.key}** only. Other reviewers cover the other dimensions.`,
        `Change: ${scope.summary}`,
        `Diff base: ${scope.base} (read the diff with \`git diff ${scope.base} -- <file>\`, and the surrounding code).`,
        focus ? `The user asked you to focus on: ${focus}` : '',
        'Changed files:',
        fileList,
        '',
        d.prompt,
        'Report only issues in or caused by this change, each with a file, line, and a concrete failure scenario. No style nits. An empty list is a fine answer.',
      ]
        .filter(Boolean)
        .join('\n'),
      { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS_SCHEMA }
    ),
  (review, d) => {
    const findings = review?.findings ?? [];
    if (findings.length === 0)
      return { key: d.key, confirmed: [], rejected: 0 };
    return agent(
      [
        `Adversarially verify these ${d.key} findings from a code review (diff base ${scope.base}).`,
        'For each one, read the code and try to refute it: is the failure scenario actually reachable? Is it already handled elsewhere? Default to real=false when you cannot show the failure.',
        '',
        ...findings.map(
          (f, i) =>
            `[${i}] ${f.file}:${f.line} (${f.severity}) ${f.title}\n    scenario: ${f.failure_scenario}`
        ),
      ].join('\n'),
      { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICTS_SCHEMA }
    ).then((v) => {
      const real = new Map((v?.verdicts ?? []).map((x) => [x.index, x]));
      const confirmed = findings
        .map((f, i) => ({ ...f, dimension: d.key, verdict: real.get(i) }))
        .filter((f) => f.verdict?.real)
        .map((f) => ({ ...f, verdict: f.verdict.reason }));
      return {
        key: d.key,
        confirmed,
        rejected: findings.length - confirmed.length,
      };
    });
  }
);

const ORDER = { high: 0, medium: 1, low: 2 };
const done = results.filter(Boolean);
const confirmed = done
  .flatMap((r) => r.confirmed)
  .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
const rejected = done.reduce((n, r) => n + r.rejected, 0);
if (done.length < DIMENSIONS.length) {
  log(
    `${DIMENSIONS.length - done.length} dimension(s) did not finish; their findings are missing.`
  );
}
log(`${confirmed.length} confirmed, ${rejected} refuted`);
return { base: scope.base, summary: scope.summary, confirmed, rejected };
