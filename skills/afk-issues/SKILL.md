---
name: afk-issues
description: Use when the user wants to carry one or more tracker issues to reviewed pull requests - a single issue or a whole backlog - e.g. "/afk-issues 42", "/afk-issues 12 15 20", "grab issue 17", "afk-issues work all issues labelled bug", "afk all the ready-for-agent issues", "clear the backlog while I'm away".
---

# AFK Issues

Carry one or more tracker issues to reviewed pull requests. You are the
**manager**: resolve scope, group issues into batches, dispatch an
`issue-worker` per batch, review each batch by dispatching a `pr-reviewer`
subagent, act on its verdict, and loop until every in-scope issue is either
backed by a PR or explicitly flagged. You do not implement issues and you do
not read diffs yourself - both are a subagent's job. Yours is scope, dispatch,
decision, and bookkeeping.

One issue is just a batch of one. The loop is identical either way - it
reports back as soon as that single batch's review lands, so a "grab issue 42"
ask and a "clear the backlog" ask run the same machinery, just with different
list lengths.

Assumes the current directory is the target repo and `gh` is authenticated.

## Optional power-ups (check first, tell the user)

This skill works better with two `superpowers` skills but does not need them.
**Before doing any work, check whether they are in your available skills list
and tell the user once which mode you are running in:**

- `superpowers:dispatching-parallel-agents` - the disciplined way to fan out workers. **If available**, use it in step 4. **If not**, fall back: dispatch up to 5 `issue-worker` agents as parallel tool calls in a single message, bank each batch's outcome as it lands (step 5), then dispatch the next batch into the freed slot.
- `superpowers:requesting-code-review` - a deeper review for risky changes, run alongside the dispatched `pr-reviewer` rather than instead of it. **If not installed**, the dispatched `pr-reviewer`'s verdict is what you act on either way; just flag the risk to the human at handoff.

State it up front, e.g. *"Both superpowers helpers are installed, using them."*
or *"superpowers not installed - running with built-in fallbacks: parallel
dispatch capped at 5, no deeper review pass."* Then go heads-down; do not
mention them again.

## State lives in GitHub, not on disk

Never write a state file. Derive everything you need from the system:

- In-scope issues and their open/closed state: `gh issue view` / `gh issue list`.
- **Whether a batch's review has landed: the existence and draft flag of its PR.**
  No PR = not yet decided (still in the review cycle, or excluded). Non-draft
  PR = approved. Draft PR = parked (CI never settled, or the rework cap was
  hit). This inverts the old habit of opening a PR early and flipping it ready
  later: nothing here is provisional - a PR is only ever created once a
  decision has already been made, so there is no separate "mark ready" step to
  forget or to get blocked by auto-mode's self-approval check.

Hold the working list of batches in your session context for the run. If
resumed later, reconstruct it from `gh` (open issues, their linked/matching
PRs, each PR's draft status) rather than trusting memory. The one state that
doesn't survive a resume is a batch mid-review with a pushed branch and no PR
yet - treat it as not started and redo the review cycle; re-dispatching a
worker or reviewer against an existing branch is safe, it just continues it.

## Steps

### 1. Resolve scope

**First, resolve the tracker.** Look for `docs/agents/issue-tracker.md` in the
repo. If it exists, you are in **adapter mode** - that profile names a tracker
reference (`references/jira.md`, etc.) and supplies the project variables;
follow the reference's commands wherever this skill shows a `gh` command,
filling the profile's values. If it does not exist, use the built-in GitHub
reference (`references/github.md`). Announce which mode you are in once,
alongside the superpowers-mode announcement, then go heads-down. The contract
both cover is in `tracker-adapter.md`.

Turn the instruction into a concrete list of open issue numbers.

- **Explicit numbers** ("42", "12 15 20"): use them directly.
- **Query** ("all issues labelled bug", "everything ready-for-agent", "everything in epic XX-2323"): resolve via `gh`/the adapter, e.g.
  ```bash
  gh issue list --label "bug" --state open --json number,title,labels --limit 100
  ```

Then **gate**: drop any item not in the adapter's `ready-for-agent` state - the
`ready-for-agent` label for GitHub, or the equivalent status the adapter
defines. Workers would refuse them anyway. List the dropped ones at handoff.

**No mandatory check-in.** The point of this skill is not stopping - if the
list resolves cleanly (explicit numbers, or a query that returns a sane set),
go straight to work. Only stop and ask if the request is genuinely ambiguous
(you can't tell what's meant) or the query resolves to nothing.

### 2. Assess and group

Read each item (in adapter mode use the adapter's view command; the GitHub
default is `gh issue view <n> --json number,title,body,labels,comments`).
Decide batching:

- **Group together** issues that are likely to touch the same files, or that are small mechanical changes in the same area. One worker handles the group; the eventual PR closes all of them (`Closes #12`, `Closes #15`).
- **Keep separate** anything large, or that touches unrelated parts of the codebase.
- **Size limit**: a PR must stay reviewable by a human. If grouping would produce a sprawling diff, split it. When unsure, keep them separate.
- **Respect dependencies.** Check each item for blocking relationships using the adapter's *dependencies* operation (the GitHub default is `Blocked by #<n>` / `Depends on #<n>` references in the body; Jira uses `is blocked by` / `blocks` issue links). A blocked item cannot be worked until its blocker's PR is **merged** - workers branch off `main` and won't see unmerged changes. When a blocker and its dependent are small and adjacent, put them in the **same batch** (one worker, implemented blocker-first) - that's the only way both get done in one unattended run. Otherwise you cannot chain them this run: nothing merges while the human is away, so a dependent in a separate batch can't see its blocker's work. Dispatch the blocker, surface the dependent as waiting on it (step 6), and let it go in a later run once the blocker has merged. Never dispatch a dependent whose blocker is still open.

Record, per batch: the issue number(s), a one-line rationale for the grouping, and any blocker it waits on.

**Note cross-batch file overlap.** If two separate batches are likely to touch the same file (even in different regions), their parallel PRs will conflict on merge. Don't force them into one batch just to avoid that - record the overlap and call it out at handoff (step 6) so the human knows the merge order matters.

### 3. Pick a model per batch

For each batch, choose the worker's model by difficulty, and choose the reviewer's model the same way against the same batch (a mechanical batch doesn't need a strong reviewer either):

- **Well-described, simple, or mechanical** (rename, copy change, config tweak, obvious one-liner): a lesser/faster model.
- **Ambiguous, cross-cutting, or design-sensitive**: the default (stronger) model.

**Always specify the model explicitly when dispatching.** An omitted model
silently inherits your own session's model - often the most expensive one,
which defeats this entirely. Turn count matters as much as price per token: a
cheap model that takes three times the turns on a prose-driven task can cost
more overall, so use a cheap model for genuinely mechanical, single-file work
and a mid-tier floor for anything requiring judgement.

Pass this as the model override when dispatching.

### 4. Dispatch workers

Dispatch one `issue-worker` per batch (`subagent_type: issue-worker`, your
chosen model as the override, build mode). Each `issue-worker` isolates its own
worktree, so parallel workers will not collide. It pushes a branch and stops -
it never opens a PR (see `dispatch-contract.md`).

**Dispatch each worker as a plain blocking Agent/Task call - no `name`, no
`SendMessage`.** A named agent becomes a persistent teammate that idles on a
mailbox heartbeat waiting for mail this contract never sends; it will never
run the prompt. The worker's final message *is* its report
(`dispatch-contract.md` §5/§6) - you read it as the tool result, you do not
poke it via a mailbox. Build the dispatch prompt per `dispatch-contract.md` §1
(New task) - embed the full title/body/comments/state you already read for
each issue in step 2, so the worker never re-fetches. Carry forward
`LEARNINGS_FROM_PRIOR_BATCHES` from any batch already completed this run.

**Cap concurrency at 5 workers in flight.** Never fan out the whole backlog at
once - it blows up rate limits, token spend, and merge conflicts. Dispatch in
waves of at most 5: bank each batch's outcome as it lands (step 5), then
dispatch the next batch into the freed slot. A 30-issue backlog runs as ~6
waves, not 30 simultaneous workers.

**Hold back blocked batches.** Don't dispatch a batch whose blocker (step 2)
hasn't merged yet. If the blocker's PR is only approved (not merged) by the end
of the run, surface the dependent as waiting on it (step 6) rather than working
it against stale `main`.

The worker's final report is `dispatch-contract.md` §5 (Work-complete) or §6
(Need-input) - never a bare summary. On §6, decide from its `OPTIONS` and
either re-dispatch (rework, with your decision as feedback) or, if you can't
decide alone, park the batch and surface it at handoff (step 6). On §5 with
nothing actionable (every issue turned out closed, batch too large to keep
reviewable), note it against those issues and move on - do not retry blindly.
If it reports the batch was too large, re-split and re-dispatch.

### 5. Review each batch

When a worker reports done (§5), run the **review cycle** in
`references/pr-review.md` for that batch: watch CI on the pushed branch,
dispatch a `pr-reviewer` subagent, act on its verdict. That cycle already
contains its own rework loop (dispatch `issue-worker` in rework mode on `NEEDS
FIXES`, capped at 2 rounds, re-review after each) and its own PR-creation logic
(a PR appears exactly once, either non-draft on `APPROVED` or as a parked draft
if the cap is hit or CI stalls) - don't restate or duplicate that logic here,
just run it per batch and record the outcome.

**Learnings triage.** If a report (worker or reviewer) includes `LEARNINGS`,
decide per item: discard (noise) or keep (a durable gotcha or insight). For
each kept item, pick a recommended destination - **CLAUDE.md** for a fact about
the codebase any future contributor needs, **memory** for a fact about this
session's preferences, corrections, or ephemeral project state. **Do not ask
about them now.** This is an unattended run - a mid-run `AskUserQuestion` would
stall the whole loop until the human is back. Accumulate the kept items (with
your recommended destination) in your session context and carry them to
handoff (step 6).

### 6. Done condition and handoff

The run is complete when **every in-scope issue is either resolved by a
non-draft PR or has been explicitly surfaced as stuck**. You are not required
to force every issue to `APPROVED` - a PR parked after the rework cap, a
stalled-CI bail, or a batch excluded as not-actionable all count as handled, as
long as you flag them.

Present the user two lists:

```bash
gh pr list --state open --json number,title,url,isDraft,headRefName
```

- **Ready to review** (approved, non-draft): per PR show title, URL, and which issues it closes. The human reviews and merges one at a time.
- **Needs a human** (still draft, or no PR at all): PRs parked after the rework cap or because CI never settled, plus any issues that produced no PR - each with a one-line reason.

Also call out any **cross-batch file overlaps** from step 2 so the human knows which PRs to merge in order to avoid conflicts.

**Then triage the accumulated learnings** you held back from step 5. The human
is back now, so this is the moment to ask. Present every kept item in one
`AskUserQuestion` call (one question per item, options: your recommended
destination first, the other second - the tool's built-in "Other" covers a
custom target like a docs file). On the human's answer, write it yourself: for
`CLAUDE.md`, edit the file and commit directly to main (documentation about the
codebase, not tracker/PR state, so it skips the PR flow - the human already
approved content and destination); for memory or a custom target, use whatever
mechanism that destination implies. If there are no kept learnings, skip this.

### 7. Merge cleanup and human review feedback

After handing off, the human reviews PRs one by one. Respond to two signals:

- **"PR #N is merged" / "clean up merged PRs"**: detect merged PRs and clean up their worktrees. Detect, don't assume:
  ```bash
  gh pr list --state merged --json number,headRefName,url --search "<scope>"
  git worktree list   # find the path for the merged branch
  ```
  Then dispatch an `issue-worker` in **cleanup mode** (dispatch prompt per `dispatch-contract.md` §3) with the branch and worktree path, or do it yourself: `git worktree remove <path>` from the main root, then `git worktree prune`. Never `rm -rf` a worktree.

  In **adapter mode**, also transition the merged item to the adapter's *done*
  state if it does not close automatically (GitHub closes via `Closes #<n>`;
  Jira needs an explicit transition, e.g.
  `acli jira workitem transition --key <KEY> --status "Done (Complete)"`). Do
  this once per merged item, as part of cleanup.

- **"Reviewer left changes on PR #N" / "pick #N back up"**: read the human's review, then dispatch an `issue-worker` in rework mode (dispatch-contract.md §2) with the branch, worktree path, and the review feedback.
  ```bash
  gh pr view <url> --json reviews,comments
  ```

## Common Mistakes

When you catch yourself thinking the excuse, the reality is the rule.

| Excuse | Reality |
|--------|---------|
| "This issue is tiny, I'll just fix it myself" | You manage; `issue-worker` builds. Dispatch it, even the one-liners. |
| "It's one issue, I should check in before each step" | One issue is a batch of one - same loop, same lack of check-ins. Report when it's decided, not before. |
| "I'll confirm the resolved list with the human first" | Only if it's genuinely ambiguous or resolves to nothing. The whole point is not stopping - go straight to work on a clean list. |
| "I'll have the worker open the PR like before" | No. Workers push and stop. The orchestrator opens the PR itself, once, only after an `APPROVED` verdict. |
| "I'll open it draft first, then mark it ready once reviewed" | Don't. Draft-then-ready is exactly the flip auto-mode's classifier reads as self-approval. Open it non-draft the one time you create it; draft only appears for a batch you're parking as stuck. |
| "I'll eyeball the diff myself, it's quicker" | Dispatch the `pr-reviewer` subagent and act on its verdict. Reviewing it yourself keeps your context flat only if you don't - across a whole backlog that adds up fast. |
| "A quick state file will help me resume" | Never. State is `gh` - a PR's existence and draft flag, linked issues. A file goes stale and lies. |
| "The backlog is small, I'll dispatch them all at once" | Cap at 5 in flight. Even a small backlog blows up rate limits and merge conflicts when fanned out. |
| "I'll just re-poll `gh run list`/`gh pr checks` to see if CI's done" | One bounded watch, interpret the exit code once, bail at the limit. Looping burns tokens and can hang forever. |
| "One more rework round and it'll be there" | Cap at 2. A human untangling a stuck PR is cheaper than a third automated attempt. Park it and flag it. |
| "Grouping these saves PRs" | Reviewability beats fewer PRs. When the diff would sprawl, split. |
| "I'll gate the labels later" | Gate at scope time. Skipping it means finding out only when a worker refuses. |
| "The worker was blocked, I'll retry it" | Report it and move on. Don't retry a blocked issue blindly. |
| "I'll dispatch all of these in parallel" | Check dependencies first. A dependent branched off `main` can't see its blocker's unmerged work - order the waves. |
| "I'll spawn it as a named teammate and message it" | No. Blocking dispatch, no name. A named agent idles waiting for mail this contract never sends; the subagent's final message is the report. |
| "The worker fetched the issue itself, so its numbers must be right" | You already fetched it in step 2 - the dispatch prompt carries that content forward per `dispatch-contract.md` §1. A worker re-fetching means the contract wasn't followed. |
| "It says tests pass, that's an APPROVED" | The dispatched `pr-reviewer` verifies against the diff, not the worker's claim - that's the whole reason review is a separate subagent. Missing or vague `ACCEPTANCE_CHECK` evidence is an automatic rework, not a pass. |
| "I'll ask where this learning goes now" | It's an unattended run - a mid-run `AskUserQuestion` stalls the loop. Accumulate learnings and triage them in one batch at handoff (step 6). |
