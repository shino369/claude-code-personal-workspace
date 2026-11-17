export const meta = {
  name: 'research',
  description:
    'Research a question from several angles, fact-check each answer, and write a study',
  whenToUse:
    'Questions that need several sources (docs, web, this code). args: { question: "…", name?: "kebab-study-name" }',
  phases: [
    { title: 'Plan', detail: 'split the question into 3-4 sub-questions' },
    { title: 'Investigate', detail: 'one researcher per sub-question' },
    { title: 'Check', detail: 'one fact-checker per answer' },
    {
      title: 'Synthesize',
      detail: 'write STUDIES_<name>.md in the active task',
    },
  ],
};

const input =
  typeof args === 'string'
    ? { question: args }
    : typeof args === 'object' && args !== null
      ? args
      : {};
const question =
  typeof input.question === 'string' ? input.question.trim() : '';
if (!question) {
  log('Pass the question: args { question: "…" }');
  return { ok: false, problem: 'no question' };
}
const studyName =
  typeof input.name === 'string' && input.name ? input.name : '';

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    subquestions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          where: {
            type: 'string',
            description:
              'where to look: official docs, source code, this repo, web, papers',
          },
        },
        required: ['question', 'where'],
      },
    },
  },
  required: ['subquestions'],
};

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          source: { type: 'string', description: 'URL, or file:line' },
        },
        required: ['claim', 'source'],
      },
    },
    gaps: { type: 'string', description: 'what you could not find out' },
  },
  required: ['answer', 'claims'],
};

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    checked: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          supported: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['index', 'supported'],
      },
    },
  },
  required: ['checked'],
};

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'the study file written, or empty' },
    summary: { type: 'string' },
  },
  required: ['path', 'summary'],
};

phase('Plan');
const plan = await agent(
  [
    `Split this research question into 3-4 sub-questions that together answer it and overlap little:`,
    question,
    'For each, say where the answer most likely lives (official docs, a source repo, this workspace, the web).',
    'Check the workspace first (pnpm tools list for local source checkouts; tasks/*/studies/ for earlier studies) so researchers reuse what is here.',
  ].join('\n'),
  { label: 'plan', phase: 'Plan', schema: PLAN_SCHEMA }
);
const subs = (plan?.subquestions ?? []).slice(0, 4);
if (subs.length === 0) {
  log('The planner returned no sub-questions.');
  return { ok: false, problem: 'no plan' };
}

const checked = await pipeline(
  subs,
  (sub) =>
    agent(
      [
        `Research this sub-question of "${question}":`,
        sub.question,
        `Start with: ${sub.where}. Prefer primary sources (official docs, source code) over blog posts; read source checkouts read-only (AGENTS.md §12).`,
        'Return a direct answer, every factual claim with its source (URL or file:line), and what you could not find out.',
      ].join('\n'),
      {
        label: `research:${sub.question.slice(0, 40)}`,
        phase: 'Investigate',
        schema: ANSWER_SCHEMA,
      }
    ),
  (found, sub) => {
    if (!found) return null;
    if (found.claims.length === 0) return { sub, found, claims: [] };
    return agent(
      [
        `Fact-check these claims (answering: ${sub.question}). Open each source and check it says this.`,
        'Mark a claim unsupported when the source is missing, unreachable, outdated, or says something else. Default to unsupported when unsure.',
        '',
        ...found.claims.map(
          (c, i) => `[${i}] ${c.claim}\n    source: ${c.source}`
        ),
      ].join('\n'),
      {
        label: `check:${sub.question.slice(0, 40)}`,
        phase: 'Check',
        schema: CHECK_SCHEMA,
      }
    ).then((check) => {
      const byIndex = new Map((check?.checked ?? []).map((c) => [c.index, c]));
      return {
        sub,
        found,
        claims: found.claims.map((c, i) => ({
          ...c,
          supported: byIndex.get(i)?.supported ?? false,
          note: byIndex.get(i)?.note ?? (check ? '' : 'not checked'),
        })),
      };
    });
  }
);

const answers = checked.filter(Boolean);
if (answers.length < subs.length) {
  log(`${subs.length - answers.length} sub-question(s) returned nothing.`);
}
const material = answers
  .map((a) =>
    [
      `## ${a.sub.question}`,
      a.found.answer,
      ...a.claims.map(
        (c) =>
          `- [${c.supported ? 'supported' : 'UNSUPPORTED'}] ${c.claim} (${c.source})${c.note ? ` — ${c.note}` : ''}`
      ),
      a.found.gaps ? `Gaps: ${a.found.gaps}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  )
  .join('\n\n');

phase('Synthesize');
const report = await agent(
  [
    `Write a study answering: ${question}`,
    '',
    'Use only the material below. Drop UNSUPPORTED claims or state them as unconfirmed; keep sources inline; end with open questions.',
    `If \`pnpm task status\` shows an active task, run \`pnpm task template study${studyName ? ` --name ${studyName}` : ''}\` and fill in the file it creates (AGENTS.md §4.4); otherwise return the study in summary and an empty path.`,
    '',
    material,
  ].join('\n'),
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA }
);

const unsupported = answers
  .flatMap((a) => a.claims)
  .filter((c) => !c.supported).length;
log(
  `${answers.length} sub-question(s) answered; ${unsupported} claim(s) failed the fact-check`
);
return { ok: Boolean(report), question, report, answers, unsupported };
