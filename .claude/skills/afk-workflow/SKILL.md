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
