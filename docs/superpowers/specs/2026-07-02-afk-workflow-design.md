# afk-workflow: a personal Workflow-tool orchestrator for afk-issues

## Problem

`afk-issues` (the plugin) is prose - the orchestrator's "decide order, pick a
model, dispatch, review" logic lives in `SKILL.md` as steps a human-shaped
agent follows turn by turn, and the orchestrator <-> worker handoff is a fixed
prose shape (`dispatch-contract.md`). That's the right design for something
distributed via a marketplace plugin: it has to run correctly in any Claude
Code session, with no assumption the `Workflow` tool is even available or
opted into.

For personal use in this repo, that constraint doesn't apply. The `Workflow`
tool's `agent()` function takes a JSON `schema` and forces the response into
it - a literal contract, not a prose convention a worker might drift from -
and its `pipeline()`/loop primitives replace the orchestrator manually
re-reading its own step list every batch. This was parked before because
mixing that into the distributable plugin would make the plugin depend on a
tool most installs won't opt into. The fix isn't to change the plugin - it's
to keep this as a second, personal front-door that reuses the plugin's
existing judgement (gating, batching, tracker adapter, caps) but drives it
with `Workflow` instead of prose steps.

## Approach

One workflow script, `afk-workflow`, with three agent stages and a plain JS
loop over batches - sequential, not `parallel()`/cross-batch `pipeline()`,
per the decision to get consistent results before trying concurrency:

1. **Plan** (one agent call, read-only) - does what `SKILL.md` steps 1-3 do by
   hand today: resolve scope, gate on the adapter's `ready-for-agent`
   equivalent, group into batches, pick a model per batch, order by
   dependency, flag cross-batch file overlaps. Returns `PLAN_SCHEMA` instead
   of a list a human-shaped agent would just remember.
2. **Build** (per batch, `agentType: 'issue-worker'`, the only stage that
   writes) - the existing worker agent, unchanged, dispatched with the
   `schema` option so its terminal report is `BUILD_SCHEMA` instead of the
   `STATUS: COMPLETE` prose convention. Still creates the worktree, branch,
   and opens the draft PR - nothing else can, it's the only stage with the
   diff.
3. **Review** (per batch, fresh prompt, read-only) - takes over what the
   orchestrator eyeballs in `SKILL.md` step 5: check the diff against the
   issue(s), watch CI with the existing single blocking
   `timeout ... --watch`, verify the worker's acceptance evidence. Returns
   `REVIEW_SCHEMA`: a verdict and a ready-to-post comment body - it never
   calls `gh pr ready` / `gh pr comment` itself.
4. **Rework loop** - plain JS: while `verdict === 'NEEDS_WORK'` and
   `rounds < 2`, re-dispatch Build in rework mode (reuses `BUILD_SCHEMA`),
   re-run Review. Same cap as today, same "push to the existing branch"
   rule.

`Workflow()` runs in the background and returns once, with every batch's
final Plan/Build/Review result. **All GitHub/tracker mutations beyond the
worker's own PR creation happen after that return, in this session** -
`gh pr ready` / `gh pr comment` for a PASS, a parked-reason comment for a
capped NEEDS_WORK or a NEED_INPUT, and any tracker "done" transition. This is
the same invariant `SKILL.md` already has ("only the orchestrator marks
ready") - it just relocates "the orchestrator" from a turn-by-turn prose loop
to the session that reads the workflow's structured output, because a
backgrounded `Workflow` call was never going to offer turn-by-turn visibility
anyway. It also means every write happens in one of two visible places: a
worker's own worktree, or this session's own tool calls - never buried inside
a subagent none of us are watching.

Anything else that needs a human mid-run - `NEED_INPUT` reports, learnings
worth keeping - can't be resolved inside the script either (no
`AskUserQuestion` from a backgrounded workflow). Both are parked into the
returned results and triaged in this session at the same point the gh
mutations happen, matching `SKILL.md`'s existing "don't ask mid-run, batch it
at handoff" rule. `NEED_INPUT` is not auto-retried in v1 - it's parked
every time, same as an unresolved NEEDS WORK; deciding from a worker's
`OPTIONS` without a human is a v2 concern, not a day-one requirement.

## The contracts

Three JSON schemas, one per agent stage. Rework reuses `BUILD_SCHEMA`.

### `PLAN_SCHEMA`

```js
{
  type: "object",
  properties: {
    batches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          issues: { type: "array", items: { type: "integer" } },
          rationale: { type: "string" },
          model: { enum: ["sonnet", "opus", "haiku", "fable", null] },  // null = inherit session default
          scope: { type: "string" },
          out_of_scope: { type: "string" },
          work_acceptance: { type: "string" },
          result_acceptance: { type: "string" },
          blocked_on: { type: "array", items: { type: "integer" } },
          issue_content: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ref: { type: "string" },
                title: { type: "string" },
                body: { type: "string" },
                comments: { type: "string" },
                state: { type: "string" }
              },
              required: ["ref", "title", "body", "state"]
            }
          }
        },
        required: ["issues", "rationale", "scope", "work_acceptance", "result_acceptance", "issue_content"]
      }
    },
    dropped: {
      type: "array",
      items: {
        type: "object",
        properties: { ref: { type: "string" }, reason: { type: "string" } },
        required: ["ref", "reason"]
      }
    },
    cross_batch_overlaps: { type: "array", items: { type: "string" } }
  },
  required: ["batches", "dropped"]
}
```

### `BUILD_SCHEMA`

```js
{
  type: "object",
  properties: {
    status: { enum: ["COMPLETE", "NEED_INPUT"] },
    mode: { enum: ["build", "rework"] },
    pr_url: { type: ["string", "null"] },
    branch: { type: "string" },
    worktree: { type: "string" },
    per_issue_summary: { type: "array", items: { type: "string" } },
    work_acceptance_evidence: { type: "string" },
    result_acceptance_evidence: { type: "string" },
    excluded: { type: "array", items: { type: "string" } },
    blocked_on: { type: ["string", "null"] },
    options: { type: ["string", "null"] },
    safe_to_resume: { type: ["boolean", "null"] },
    learnings: { type: ["string", "null"] }
  },
  required: ["status", "mode", "branch", "worktree"]
}
```

### `REVIEW_SCHEMA`

```js
{
  type: "object",
  properties: {
    verdict: { enum: ["PASS", "NEEDS_WORK"] },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    ci_status: { enum: ["green", "failed", "stalled", "unknown"] },
    acceptance_check_ok: { type: "boolean" },
    comment_markdown: { type: "string" }
  },
  required: ["verdict", "summary", "ci_status", "acceptance_check_ok", "comment_markdown"]
}
```

## Control flow (script shape)

```js
phase('Plan')
const plan = await agent(plannerPrompt, { schema: PLAN_SCHEMA })
log(`${plan.batches.length} batches, ${plan.dropped.length} dropped`)

const results = []
for (const batch of plan.batches) {
  const modelOpt = batch.model ? { model: batch.model } : {}  // omit key entirely to inherit session default - `model: null` is not the same as omitting it

  phase('Build')
  let build = await agent(buildPrompt(batch), {
    agentType: 'issue-worker', ...modelOpt, schema: BUILD_SCHEMA
  })
  if (build.status === 'NEED_INPUT') {
    results.push({ batch, build, verdict: 'NEED_INPUT' })
    continue
  }

  phase('Review')
  let review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
  let rounds = 0
  while (review.verdict === 'NEEDS_WORK' && rounds < 2) {
    build = await agent(reworkPrompt(batch, build, review), {
      agentType: 'issue-worker', ...modelOpt, schema: BUILD_SCHEMA
    })
    review = await agent(reviewPrompt(batch, build), { schema: REVIEW_SCHEMA })
    rounds++
  }
  results.push({ batch, build, review, rounds })
}
return { plan, results }
```

No `pipeline()`, no `parallel()` - a plain `for` loop, so batch 2 never
starts until batch 1's build/review/rework chain is fully resolved.

## File changes

### New: `.claude/workflows/afk-workflow.js`

The script above, in full. Lives under `.claude/`, not `skills/`/`agents/`,
because `plugin.json` doesn't enumerate skills or agents - it auto-discovers
everything under those two directories as the plugin's distributable
surface. Putting a `Workflow`-tool-dependent script there would ship it to
every marketplace install, which is the exact outcome this design exists to
avoid.

### New: `.claude/skills/afk-workflow/SKILL.md`

A thin wrapper, project-local (not plugin-discovered, for the same reason as
above): resolves the issue list from the user's instruction (same rule as
`afk-issues/SKILL.md` step 1 - explicit numbers or a `gh`/adapter query),
then calls `Workflow({ scriptPath: '.claude/workflows/afk-workflow.js' },
{ issues: [...] })`. After the workflow returns, it:

- Applies mutations: `gh pr ready` + `gh pr comment` (built from
  `comment_markdown`) for each PASS; a parked-reason `gh pr comment` for each
  capped NEEDS_WORK or NEED_INPUT; the adapter's tracker-done transition
  where the reference requires one.
- Triages any `learnings` fields via one `AskUserQuestion` call, same
  destination choices (`CLAUDE.md` vs memory) as `SKILL.md` step 7.
- Presents the same two lists `SKILL.md` step 7 does today: ready-to-review
  PRs, and needs-a-human (parked NEEDS_WORK/NEED_INPUT), plus cross-batch
  overlaps from `plan.cross_batch_overlaps`.

### Unchanged

`skills/afk-issues/`, `skills/grab-issue/`, `agents/issue-worker.md`,
`tracker-adapter.md`, `dispatch-contract.md`, both tracker references. The
worker agent is dispatched exactly as it is today - the `schema` option
composes with its existing prompt (the workflow's own docs: a custom
`agentType` "composes with schema - the custom agent's system prompt gets a
StructuredOutput instruction appended"), so `issue-worker.md` needs no edits
for this to work. If that composition doesn't hold up once this is actually
run, that's a build-time finding, not a design change - noting it here as
the one assumption in this design that's unverified until implementation.

## Invariant changes (relative to `afk-issues`)

- **New**: within a single `Workflow` run, batches are strictly sequential -
  no concurrent builds. Revisit once results are consistent enough to trust
  concurrency; the existing plugin's 5-in-flight cap is a ceiling for a
  future version of this script, not a v1 requirement.
- **New**: Review never mutates GitHub state. It returns a verdict and a
  drafted comment; the wrapper skill is the only thing that runs
  `gh pr ready` / `gh pr comment`.
- **New**: `NEED_INPUT` is always parked, never auto-resolved from its
  `OPTIONS` - the existing plugin lets the orchestrator decide alone when it
  can; this version always defers to the human at handoff. Simpler, and the
  only sane default with no orchestrator alive to decide mid-run.
- **Unchanged**: no state files (the workflow's return value plus GitHub is
  the only state); draft = unreviewed / ready = passed; 2-round rework cap;
  one PR per batch, one worktree per batch; rework pushes to the existing
  branch.

## Out of scope

- Cleanup mode (merge cleanup, tracker done-transition on merge) stays the
  existing manual trigger - "PR #N is merged" still gets handled by dispatching
  `issue-worker` in cleanup mode directly, outside this workflow.
- Concurrency (parallel/pipelined batches) - explicitly deferred until
  sequential results are proven consistent.
- Jira/adapter-mode is not excluded, but also not specifically verified -
  Plan and Review's prompts should follow `tracker-adapter.md` the same way
  `SKILL.md` does today (check for `docs/agents/issue-tracker.md`), inheriting
  whatever adapter support already exists rather than reimplementing it.
- No changes to the distributable plugin (`skills/`, `agents/`,
  `dispatch-contract.md`, `tracker-adapter.md`).

## Mechanical follow-ups

- No `plugin.json`/`marketplace.json` version bump - nothing under
  `skills/`/`agents/` changes.
- British English, conventional commit prefixes for the new files.
