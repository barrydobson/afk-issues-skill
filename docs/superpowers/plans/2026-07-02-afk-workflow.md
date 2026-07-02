# afk-workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a personal, `Workflow`-tool-driven front-door that reuses `afk-issues`'s existing gating/batching/tracker-adapter judgement but drives it through three schema-contracted agent stages (Plan, Build, Review) instead of prose steps, sequentially, with all GitHub/tracker mutations applied by this session after the workflow returns.

**Architecture:** Two new files, both outside the plugin's auto-discovered `skills/`/`agents/` surface: `.claude/workflows/afk-workflow.js` (the `Workflow` script - schemas, prompt builders, the Plan → per-batch Build/Review/rework loop) and `.claude/skills/afk-workflow/SKILL.md` (a thin project-local wrapper that resolves the issue list, confirms it with the human, invokes the workflow, then applies every mutation and presents the handoff).

**Tech Stack:** Plain JavaScript for the workflow script (the `Workflow` tool's own runtime - no Node.js APIs, no npm packages, no test framework). Markdown+YAML frontmatter for the skill, same as every other skill in this repo. There is no build/lint/test step for either; verification is `node --check` for script syntax and grep for prose consistency, per this repo's `CLAUDE.md` and the pattern in `docs/superpowers/plans/2026-07-01-dispatch-contract.md`.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-07-02-afk-workflow-design.md`. Every schema field name and shape below is copied verbatim from it (as amended by the two spec corrections made while writing this plan: the `Workflow({ scriptPath, args })` call form, and `PLAN_SCHEMA`'s `waiting` array).
- Both new files live under `.claude/`, never `skills/` or `agents/` - those two directories are auto-discovered by `plugin.json` and shipped to every marketplace install. Nothing in this plan touches `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, or any existing file under `skills/`/`agents/`.
- Batches dispatch strictly sequentially - a plain `for` loop, no `parallel()`, no cross-batch `pipeline()`. Do not introduce concurrency in this plan.
- Only the Build stage may create GitHub state (worktree, branch, draft PR). Review never calls `gh pr ready` / `gh pr comment` - it returns a verdict and a drafted comment. All `gh`/tracker mutations after that point happen in `SKILL.md`'s prose steps, in this session, after `Workflow()` returns.
- `NEED_INPUT` is always parked to the results list, never auto-retried.
- Rework capped at 2 rounds per batch, matching `afk-issues/SKILL.md`.
- British English throughout. Conventional commit prefixes, one logical change per commit.

---

## Task 1: Write `.claude/workflows/afk-workflow.js`

**Files:**
- Create: `.claude/workflows/afk-workflow.js`

**Interfaces:**
- Consumes: `args.issues` (array of issue numbers) or `args.query` (a string description of a label/state query), passed by Task 2's `Workflow({ ..., args })` call.
- Produces: the script's return value, `{ plan, results }`, where `plan` matches `PLAN_SCHEMA` and each `results[i]` is `{ batch, build, review, rounds }` for a reviewed batch, or just `{ batch, build }` (no `review` key) for a parked `NEED_INPUT` - Task 2 reads this shape to apply mutations and build the handoff report.

- [ ] **Step 1: Write the meta block and the three schemas**

```js
export const meta = {
  name: 'afk-workflow',
  description: 'Plan, build, and review a batch of tracker issues sequentially via schema-contracted agent stages',
  phases: [
    { title: 'Plan', detail: 'resolve scope, gate, batch, pick a model and order per dependency' },
    { title: 'Build', detail: 'issue-worker implements one batch and opens a draft PR' },
    { title: 'Review', detail: 'read-only diff/CI/acceptance-evidence check, returns a verdict' },
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
```

- [ ] **Step 2: Write the prompt builders**

```js
function plannerPrompt() {
  const scopeInstruction = args.issues
    ? `Explicit issue numbers: ${args.issues.join(', ')}.`
    : `Resolve via this query: ${args.query}`

  return `You are the Plan stage of afk-workflow, a personal variant of the
afk-issues plugin in this repo. Do exactly what skills/afk-issues/SKILL.md
steps 1-3 describe, then return your decision as structured output - do not
narrate it as prose.

1. Resolve the tracker. If docs/agents/issue-tracker.md exists, read it and
   follow the named reference under skills/afk-issues/references/ for every
   command (gating state, view command, dependency syntax). Otherwise use
   skills/afk-issues/references/github.md.
2. Resolve scope: ${scopeInstruction}
3. Gate: drop anything not in the adapter's ready-for-agent state. Put each
   dropped item in "dropped" with a one-line reason.
4. For every remaining item, fetch its full title/body/comments/state - the
   worker you dispatch later will not re-fetch, so capture everything here.
5. Group into batches per skills/afk-issues/SKILL.md step 2 (same-file or
   small mechanical changes together, size-limited for reviewability, keep
   unrelated/large work separate). Check dependencies (Blocked by / Depends
   on, or the adapter's link syntax): if a blocker and its dependent are
   small and adjacent, put them in the SAME batch, blocker implemented
   first. Otherwise put the dependent in "waiting" with which issue it's
   blocked on - do NOT put it in "batches". Nothing merges during this run,
   so a dependent whose blocker isn't in the same batch can never see the
   blocker's work.
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

Follow agents/issue-worker.md Build mode exactly. Use the ISSUES content
above - do not re-fetch from the tracker. Report using the fields in your
structured-output schema instead of dispatch-contract.md's prose STATUS
line - the fields map directly: status/mode/pr_url/branch/worktree/
per_issue_summary/work_acceptance_evidence/result_acceptance_evidence/
excluded/learnings for a completed run, or status=NEED_INPUT with
blocked_on/options/safe_to_resume if you get stuck.`
}

function reworkPrompt(batch, build, review) {
  return `MODE: rework
BRANCH: ${build.branch}
WORKTREE: ${build.worktree}
FEEDBACK: ${review.summary}
FINDINGS:
${review.findings.map((f) => `  - ${f}`).join('\n')}
RESULT_ACCEPTANCE: same PR updated, same Closes lines, checks green

Follow agents/issue-worker.md Rework mode exactly - push to the existing
branch, never a second PR. Report via your structured-output schema, same
field mapping as a build-mode report.`
}

function reviewPrompt(batch, build) {
  return `You are the Review stage of afk-workflow - read-only. Do what
skills/afk-issues/SKILL.md step 5 describes, except you never call
"gh pr ready" or "gh pr comment" yourself; you only report a verdict and a
drafted comment for the calling session to post.

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
4. Draft comment_markdown following skills/afk-issues/SKILL.md step 5's
   comment format exactly (the "> *This review was generated by AI*" line,
   a ## heading with verdict and closed issue(s), a one-sentence summary,
   a bulleted findings list).

Call the structured-output tool with: verdict, summary, findings, ci_status,
acceptance_check_ok, comment_markdown.`
}
```

- [ ] **Step 3: Write the control flow**

```js
phase('Plan')
const plan = await agent(plannerPrompt(), { schema: PLAN_SCHEMA })
log(`${plan.batches.length} batches, ${plan.dropped.length} dropped, ${plan.waiting.length} waiting on a blocker`)

const results = []
for (const batch of plan.batches) {
  const modelOpt = batch.model ? { model: batch.model } : {}

  phase('Build')
  let build = await agent(buildPrompt(batch), { agentType: 'issue-worker', ...modelOpt, schema: BUILD_SCHEMA })
  if (build.status === 'NEED_INPUT') {
    results.push({ batch, build })   // no `review` key - its absence IS the NEED_INPUT signal
    continue
  }

  phase('Review')
  let review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
  let rounds = 0
  while (review.verdict === 'NEEDS_WORK' && rounds < 2) {
    phase('Build')
    build = await agent(reworkPrompt(batch, build, review), { agentType: 'issue-worker', ...modelOpt, schema: BUILD_SCHEMA })
    if (build.status === 'NEED_INPUT') break   // rework got stuck - stop reviewing a build with no PR to check
    phase('Review')
    review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
    rounds++
  }
  results.push(build.status === 'NEED_INPUT' ? { batch, build } : { batch, build, review, rounds })
}

return { plan, results }
```

- [ ] **Step 4: Verify syntax**

The `Workflow` tool's script body isn't plain top-level JS (it uses
top-level `await`/`return` and globals like `agent`/`phase`/`args` the
harness injects at runtime) - `node --check` on the raw file rejects both of
those as illegal outside a function. Strip the `export` keyword from the
`meta` line and wrap the whole file in an async function so the same
constructs are legal, then check that:

```bash
node --check <(sed 's/^export const meta/const meta/' .claude/workflows/afk-workflow.js | { echo 'async function __afk_wf_check(){'; cat; echo '}'; })
```

Expected: no output, exit code 0. This only catches syntax errors
(mismatched braces, bad literals) - it cannot catch a wrong field name or a
missing schema property, since `node --check` doesn't evaluate the code.

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/afk-workflow.js
git commit -m "feat(afk-workflow): add Plan/Build/Review workflow script"
```

---

## Task 2: Write `.claude/skills/afk-workflow/SKILL.md`

**Files:**
- Create: `.claude/skills/afk-workflow/SKILL.md`

**Interfaces:**
- Consumes: Task 1's script path (`.claude/workflows/afk-workflow.js`) and its return shape (`{ plan, results }`, `results[i]` = `{ batch, build, review, rounds }` or `{ batch, build, verdict: 'NEED_INPUT' }`).
- Produces: nothing consumed by another task - this is the user-facing entry point.

- [ ] **Step 1: Write the frontmatter and scope-resolution step**

```markdown
---
name: afk-workflow
description: Use when the user wants to run the personal Workflow-tool version of afk-issues on a set of tracker issues - e.g. "afk-workflow 12 15 20", "run afk-workflow on the ready-for-agent issues".
---

# AFK Workflow

A personal front-door onto `.claude/workflows/afk-workflow.js`. It reuses
`afk-issues`'s gating/batching/tracker-adapter judgement but drives it
through three schema-contracted agent stages (Plan, Build, Review) run
sequentially inside one backgrounded `Workflow` call, instead of the
plugin's prose steps. Not part of the distributable plugin - it lives under
`.claude/`, which is why this file and the script it calls are never
touched by a `plugin.json`/`marketplace.json` version bump.

Assumes the current directory is the target repo and `gh` (or `acli`, in
adapter mode) is authenticated.

## 1. Resolve and confirm scope

Turn the user's instruction into either an explicit issue-number list or a
query description, exactly like `skills/afk-issues/SKILL.md` step 1:

- Explicit numbers ("12 15 20"): use them directly as `args.issues`.
- A query ("all issues labelled bug", "everything ready-for-agent"): pass
  the description through as `args.query` - the Plan stage resolves it.

**Confirm with the user before dispatching anything**: state which numbers
or query you resolved and that this will run unattended once started. This
mirrors `afk-issues/SKILL.md`'s one checkpoint - the workflow runs
sequentially in the background afterwards with no further pause, so this is
the last point a human sees the plan before batches start opening PRs.
```

- [ ] **Step 2: Write the invocation and handoff steps**

```markdown
## 2. Run the workflow

```
Workflow({
  scriptPath: '.claude/workflows/afk-workflow.js',
  args: { issues: [...] }   // or { query: '...' }
})
```

This runs in the background - you get a task ID immediately and a
notification when it completes. Do not poll it; wait for the notification.

## 3. Apply mutations

The workflow never touches GitHub/tracker state beyond what a worker's own
build creates. Once it returns `{ plan, results }`, walk `results` and apply
every outcome yourself, in this session. Each item is either `{ batch,
build }` (no `review` key - parked) or `{ batch, build, review, rounds }`
(reviewed):

- **No `review` key (parked `NEED_INPUT`)**: no PR action - note
  `build.blocked_on` and `build.options` for the handoff list below.
- **`review.verdict === 'PASS'`**: `gh pr ready <build.pr_url>`, then
  `gh pr comment <build.pr_url> --body <review.comment_markdown>`. In
  adapter mode, also transition each closed item to the adapter's done
  state if merging doesn't do it automatically.
- **`review.verdict === 'NEEDS_WORK'` after the rework cap** (i.e.
  `rounds === 2` and still NEEDS_WORK): leave the PR as draft, post
  `review.comment_markdown` as-is (it already explains what's still wrong).

## 4. Triage learnings

Collect every non-null `build.learnings` across `results`. If there are
any, present them in one `AskUserQuestion` call (one question per item,
options: your recommended destination first - `CLAUDE.md` for a durable
codebase fact, memory for a session preference/correction - the other
second). Write the human's choice yourself: `CLAUDE.md` edits commit
directly to main; memory or a custom target use whatever mechanism that
destination implies. Skip this step entirely if nothing came back.

## 5. Present the handoff

Same two lists as `afk-issues/SKILL.md` step 7:

- **Ready to review**: every batch with `review.verdict === 'PASS'` - PR
  URL, title, issues closed.
- **Needs a human**: every parked NEED_INPUT (with `blocked_on`/`options`)
  and every rework-capped NEEDS_WORK (with why), plus `plan.dropped` and
  `plan.waiting` verbatim.

Also call out `plan.cross_batch_overlaps` so the human knows which PRs to
merge in order.

## Common Mistakes

| Excuse | Reality |
|--------|---------|
| "The review agent already knows the PR is good, I'll skip applying it" | Review never mutates GitHub - if you don't run `gh pr ready`/`gh pr comment` yourself, nothing happens. |
| "I'll poll the workflow to see if it's done" | It's backgrounded - wait for the completion notification, don't poll. |
| "This NEED_INPUT has an obvious answer, I'll rework it myself" | v1 never auto-resolves NEED_INPUT - park it and let the human decide at handoff. |
| "I'll dispatch batches in parallel to save time" | Sequential only in this version - the whole point of this workflow was consistency over speed; concurrency is a deliberately deferred v2. |
```

- [ ] **Step 3: Verify frontmatter and structure**

Run:
```bash
python3 -c "
import yaml, re
content = open('.claude/skills/afk-workflow/SKILL.md').read()
m = re.match(r'^---\n(.*?)\n---\n', content, re.DOTALL)
assert m, 'no frontmatter block found'
fm = yaml.safe_load(m.group(1))
assert fm['name'] == 'afk-workflow', fm
assert 'description' in fm, fm
print('frontmatter OK:', fm['name'])
"
```
Expected: `frontmatter OK: afk-workflow`, no traceback.

Run:
```bash
grep -n 'TBD\|TODO\|fill in\|placeholder' .claude/skills/afk-workflow/SKILL.md
```
Expected: no output (exit code 1).

Run:
```bash
grep -c 'afk-workflow.js' .claude/skills/afk-workflow/SKILL.md
```
Expected: at least `2` (the intro paragraph and the `Workflow()` call).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/afk-workflow/SKILL.md
git commit -m "feat(afk-workflow): add wrapper skill for scope, dispatch, and handoff"
```

---

## Manual smoke test (not automatable - do this yourself before relying on the workflow)

Both tasks above only verify syntax and prose structure - neither runs the
actual `Workflow` tool, because a real run dispatches real `issue-worker`
agents that create real branches and open real draft PRs. Before trusting
this for an unattended batch:

- [ ] Pick 1-2 genuinely `ready-for-agent` issues in a repo you don't mind
  test-driving (this repo or a throwaway one).
- [ ] Invoke the `afk-workflow` skill with those issue numbers.
- [ ] Confirm: the Plan stage's gating/batching matches what you'd expect
  by eye; Build opens a draft PR; Review posts a verdict without itself
  calling any `gh` write command (check `read_network_requests`-equivalent
  reasoning isn't needed here - just confirm via the returned `results`
  that `gh pr ready`/`gh pr comment` only ran from *this* session's own
  tool calls, not from inside the Review agent's transcript).
- [ ] Confirm a forced NEEDS_WORK (e.g. review a batch you know has a
  failing test) triggers exactly one rework round before either passing or
  hitting the cap.

If the default workflow subagent turns out not to have `gh`/`acli` shell
access (the one unverified assumption noted in the spec), Plan and Review
will fail at their first tool call - if that happens, add `agentType:
'general-purpose'` to those two `agent()` calls in Task 1 and re-run this
smoke test.

## Final check (run after both tasks)

- [ ] `node --check` (per Task 1 Step 4) passes.
- [ ] `git log --oneline -2` shows two commits in order: the workflow
  script, then the wrapper skill.
- [ ] `git status` shows `.claude/workflows/` and `.claude/skills/afk-workflow/`
  tracked, and no changes under `skills/`, `agents/`, or `.claude-plugin/`.
