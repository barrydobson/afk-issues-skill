export const meta = {
  name: 'afk-workflow',
  description: 'Plan, build, review, and apply a batch of tracker issues sequentially via schema-contracted agent stages',
  phases: [
    { title: 'Plan', detail: 'resolve scope, gate, batch, pick a model and order per dependency' },
    { title: 'Build', detail: 'issue-worker implements one batch and opens a draft PR' },
    { title: 'Review', detail: 'read-only diff/CI/acceptance-evidence check, returns a verdict' },
    { title: 'Apply', detail: 'the only stage that mutates the PR - gh pr ready and/or comment' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    batches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          issues: { type: 'array', items: { type: 'integer' } },
          rationale: { type: 'string' },
          model: { enum: ['sonnet', 'opus', 'haiku', 'fable', null] },
          scope: { type: 'string' },
          out_of_scope: { type: 'string' },
          work_acceptance: { type: 'string' },
          result_acceptance: { type: 'string' },
          issue_content: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                title: { type: 'string' },
                body: { type: 'string' },
                comments: { type: 'string' },
                state: { type: 'string' },
              },
              required: ['ref', 'title', 'body', 'state'],
            },
          },
        },
        required: ['issues', 'rationale', 'scope', 'work_acceptance', 'result_acceptance', 'issue_content'],
      },
    },
    dropped: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, reason: { type: 'string' } },
        required: ['ref', 'reason'],
      },
    },
    waiting: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, blocked_on: { type: 'string' } },
        required: ['ref', 'blocked_on'],
      },
    },
    cross_batch_overlaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['batches', 'dropped', 'waiting'],
}

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    status: { enum: ['COMPLETE', 'NEED_INPUT'] },
    mode: { enum: ['build', 'rework'] },
    pr_url: { type: ['string', 'null'] },
    branch: { type: 'string' },
    worktree: { type: 'string' },
    per_issue_summary: { type: 'array', items: { type: 'string' } },
    work_acceptance_evidence: { type: 'string' },
    result_acceptance_evidence: { type: 'string' },
    excluded: { type: 'array', items: { type: 'string' } },
    blocked_on: { type: ['string', 'null'] },
    options: { type: ['string', 'null'] },
    safe_to_resume: { type: ['boolean', 'null'] },
    learnings: { type: ['string', 'null'] },
  },
  required: ['status', 'mode', 'branch', 'worktree'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['PASS', 'NEEDS_WORK'] },
    summary: { type: 'string' },
    findings: { type: 'array', items: { type: 'string' } },
    ci_status: { enum: ['green', 'failed', 'stalled', 'unknown'] },
    acceptance_check_ok: { type: 'boolean' },
    comment_markdown: { type: 'string' },
  },
  required: ['verdict', 'summary', 'ci_status', 'acceptance_check_ok', 'comment_markdown'],
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    action: { enum: ['readied', 'commented_only'] },
    pr_url: { type: 'string' },
  },
  required: ['action', 'pr_url'],
}

function plannerPrompt() {
  const scopeInstruction = args.issues
    ? `Explicit issue numbers: ${args.issues.join(', ')}.`
    : `Resolve via this query: ${args.query}`

  return `You are the Plan stage of afk-workflow, a personal variant of the
afk-issues plugin. Resolve scope, gate, batch, and pick a model, then return
your decision as structured output - do not narrate it as prose.

1. Resolve the tracker. If docs/agents/issue-tracker.md exists in this repo,
   read it - it names a tracker (e.g. Jira via acli) and this project's own
   variables (board, project key, states). Use those variables plus your own
   knowledge of that tracker's CLI to run the equivalent of the GitHub
   commands below. If you cannot determine a confident equivalent for one of
   them, do not guess - drop the affected issue into "dropped" with that
   reason instead of risking a wrong command.
   Otherwise (no adapter doc), this repo uses GitHub directly:
     - List ready items: gh issue list --label ready-for-agent --state open --json number,title,labels
     - The gate: "ready-for-agent" label present
     - View one item: gh issue view <n> --json number,title,body,labels,state,url,comments
     - Dependencies: "Blocked by #<n>" / "Depends on #<n>" in the issue body
     - Verify actionable: issue state is OPEN
     - PR reference syntax: "Closes #<n>" in the PR body, one per issue
2. Resolve scope: ${scopeInstruction}
3. Gate: drop anything not in the ready-for-agent (or adapter-equivalent)
   state. Put each dropped item in "dropped" with a one-line reason.
4. For every remaining item, fetch its full title/body/comments/state - the
   worker you dispatch later will not re-fetch, so capture everything here.
5. Group into batches: same-file or small mechanical changes together,
   size-limited for reviewability, keep unrelated/large work separate. Check
   dependencies: if a blocker and its dependent are small and adjacent, put
   them in the SAME batch, blocker implemented first. Otherwise put the
   dependent in "waiting" with which issue it's blocked on - do NOT put it
   in "batches". Nothing merges during this run, so a dependent whose
   blocker isn't in the same batch can never see the blocker's work.
6. For each batch, pick a model: "haiku" for well-described/mechanical work,
   null (inherit default) for ambiguous or design-sensitive work. Write
   work_acceptance (e.g. tests pass, lint clean) and result_acceptance (e.g.
   one draft PR, Closes #N) criteria.
7. Note any cross_batch_overlaps - two separate batches likely to touch the
   same file.

Call the structured-output tool with: batches, dropped, waiting,
cross_batch_overlaps.`
}

function buildPrompt(batch) {
  const issues = batch.issue_content
    .map((i) => `  - REF: ${i.ref}\n    TITLE: ${i.title}\n    BODY: ${i.body}\n    COMMENTS: ${i.comments || '(none)'}\n    STATE: ${i.state}`)
    .join('\n')

  return `MODE: build
ISSUES:
${issues}
SCOPE: ${batch.scope}
OUT_OF_SCOPE: ${batch.out_of_scope || '(none noted)'}
WORK_ACCEPTANCE: ${batch.work_acceptance}
RESULT_ACCEPTANCE: ${batch.result_acceptance}

Follow your Build mode instructions exactly. Use the ISSUES content above -
do not re-fetch from the tracker. Report using the fields in your
structured-output schema instead of your usual prose STATUS line - the
fields map directly: status/mode/pr_url/branch/worktree/per_issue_summary/
work_acceptance_evidence/result_acceptance_evidence/excluded/learnings for a
completed run, or status=NEED_INPUT with blocked_on/options/safe_to_resume
if you get stuck.`
}

function reworkPrompt(batch, build, review) {
  return `MODE: rework
BRANCH: ${build.branch}
WORKTREE: ${build.worktree}
FEEDBACK: ${review.summary}
FINDINGS:
${review.findings.map((f) => `  - ${f}`).join('\n')}
RESULT_ACCEPTANCE: same PR updated, same Closes lines, checks green

Follow your Rework mode instructions exactly - push to the existing branch,
never a second PR. Report via your structured-output schema, same field
mapping as a build-mode report.`
}

function reviewPrompt(batch, build) {
  return `You are the Review stage of afk-workflow - read-only. Check the
diff, CI, and acceptance evidence for one draft PR, except you never call
"gh pr ready" or "gh pr comment" yourself; you only report a verdict and a
drafted comment for the Apply stage to post.

PR: ${build.pr_url}
ISSUES CLOSED: ${batch.issues.join(', ')}
WORK_ACCEPTANCE (given at dispatch): ${batch.work_acceptance}
RESULT_ACCEPTANCE (given at dispatch): ${batch.result_acceptance}
WORKER'S ACCEPTANCE EVIDENCE: ${build.work_acceptance_evidence} / ${build.result_acceptance_evidence}

1. Check the diff against the issue(s): does it resolve what was asked, is
   it scoped to the issue, no unrelated churn.
2. Watch CI with a single blocking call, never a polling loop:
   "timeout 900 gh pr checks ${build.pr_url} --watch --interval 30 --fail-fast".
   Exit 0 = green. Non-zero from gh = a failing check, cite it. Exit 124 =
   still queued/running after 15 minutes - report ci_status "stalled" and
   verdict NEEDS_WORK; do not wait longer.
3. Check the worker's acceptance evidence is concrete (test output, a URL),
   not a restated claim. Vague or missing evidence is automatic
   acceptance_check_ok=false and verdict NEEDS_WORK.
4. Draft comment_markdown in this exact format: a "> *This review was
   generated by AI*" line, then a blank line, then a "##" heading stating
   the verdict and which issue(s) it resolves (e.g. "## PASS - resolves
   #12"), a one-sentence summary, then a bulleted findings list with
   **bold** lead-ins per bullet.

Call the structured-output tool with: verdict, summary, findings, ci_status,
acceptance_check_ok, comment_markdown.`
}

function applyPrompt(build, review) {
  const readyMode = review.verdict === 'PASS'

  return `You are the Apply stage of afk-workflow - the only stage that
mutates this PR. Apply exactly this review's outcome, nothing else.

PR: ${build.pr_url}
VERDICT: ${review.verdict}

${readyMode
    ? `Run: gh pr ready ${build.pr_url}\nThen: gh pr comment ${build.pr_url} --body "<comment below>"`
    : `Run only: gh pr comment ${build.pr_url} --body "<comment below>" - do NOT run gh pr ready, this PR stays draft.`}

Comment body to post verbatim:
${review.comment_markdown}

Do not transition any tracker item to a "done" state here, even in adapter
mode - nothing has merged yet. That transition is a separate, manual,
post-merge step outside this workflow.

Call the structured-output tool with: action ("readied" if you ran
gh pr ready, "commented_only" if you only commented), pr_url.`
}

phase('Plan')
const plan = await agent(plannerPrompt(), { schema: PLAN_SCHEMA })
log(`${plan.batches.length} batches, ${plan.dropped.length} dropped, ${plan.waiting.length} waiting on a blocker`)

const results = []
for (const batch of plan.batches) {
  const modelOpt = batch.model ? { model: batch.model } : {}

  phase('Build')
  let build = await agent(buildPrompt(batch), { agentType: 'afk-issues:issue-worker', ...modelOpt, schema: BUILD_SCHEMA })
  if (build.status === 'NEED_INPUT') {
    results.push({ batch, build })   // no `review` key - its absence IS the NEED_INPUT signal
    continue
  }

  phase('Review')
  let review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
  let rounds = 0
  while (review.verdict === 'NEEDS_WORK' && rounds < 2) {
    phase('Build')
    build = await agent(reworkPrompt(batch, build, review), { agentType: 'afk-issues:issue-worker', ...modelOpt, schema: BUILD_SCHEMA })
    if (build.status === 'NEED_INPUT') break   // rework got stuck - stop reviewing a build with no PR to check
    phase('Review')
    review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
    rounds++
  }
  if (build.status === 'NEED_INPUT') {
    results.push({ batch, build })
    continue
  }

  phase('Apply')
  const applied = await agent(applyPrompt(build, review), { schema: APPLY_SCHEMA })
  results.push({ batch, build, review, rounds, applied })
}

return { plan, results }
