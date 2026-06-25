---
name: afk-issues
description: Use when the user wants to autonomously work through several GitHub issues without supervision - e.g. "/afk-issues 12 15 20", "afk-issues work all issues labelled bug", "afk all the ready-for-agent issues", "clear the backlog while I'm away".
---

# AFK Issues

Orchestrate a batch of GitHub issues to reviewed pull requests, autonomously. You are the **manager**: you find and scope the work, group it, dispatch worker subagents that each carry issues to a PR, review their output against the original issues, and loop until every in-scope issue has an open PR that passes your review.

You do NOT implement issues yourself. You dispatch the **`issue-worker` agent** (Agent/Task tool, `subagent_type: issue-worker`). That agent already knows how to gate, isolate a worktree, implement one or more issues, and open a PR - you hand it the issue numbers and the model to use, you don't teach it the workflow. Your job is scope, dispatch, review, and bookkeeping.

Assumes the current directory is the target repo and `gh` is authenticated.

## Optional power-ups (check first, tell the user)

This skill works better with two `superpowers` skills but does not need them. **Before doing any work, check whether they are in your available skills list and tell the user once which mode you are running in:**

- `superpowers:dispatching-parallel-agents` - the disciplined way to fan out workers. **If available**, use it in step 4. **If not**, fall back: dispatch up to 5 `issue-worker` agents as parallel tool calls in a single message, bank each PR as it lands (step 5), then dispatch the next wave into the freed slot.
- `superpowers:requesting-code-review` - a deeper review for risky changes. **If available**, use it in step 5 on risky PRs. **If not**, do the quick manual review described in step 5 and flag the risk to the human at handoff.

State it up front, e.g. *"Both superpowers helpers are installed, using them."* or *"superpowers not installed - running with built-in fallbacks: parallel dispatch capped at 5, manual review."* Then go heads-down; do not mention them again.

## State lives in GitHub, not on disk

Never write a state file. Derive everything you need from the system:

- In-scope issues and their open/closed state: `gh issue view` / `gh issue list`.
- Whether an issue has a PR: `gh pr list --search "<number> in:body"` or the issue's `Development`/linked PRs.
- **Whether a PR has passed your review: its draft status.** Workers open PRs as **draft**. You mark a PR **ready** (`gh pr ready`) only when it passes review. So `draft = not yet reviewed / needs work`, `ready = passed`. This survives a resumed session and stops the human merging un-reviewed work - they should only ever merge ready PRs. The PASS/NEEDS WORK comment is the human-readable rationale; the draft flag is the state.

Hold the working list in your session context for the run. If resumed later, reconstruct it from `gh` (open issues, their linked PRs, and each PR's draft status) rather than trusting memory.

## Steps

### 1. Resolve scope

**First, resolve the tracker.** Look for `docs/agents/issue-tracker.md` in the
repo. If it exists, you are in **adapter mode** - that doc (and
`docs/agents/triage-labels.md`) defines the commands for listing, viewing,
gating, and transitioning items; follow it wherever this skill shows a `gh`
command. If it does not exist, use the built-in GitHub (`gh`) commands shown
below. Announce which mode you are in once, alongside the superpowers-mode
announcement, then go heads-down. The operations an adapter doc must cover are
listed in `tracker-adapter.md`.

Turn the instruction into a concrete list of open issue numbers.

- **Explicit numbers** ("12 15 20"): use them directly.
- **Query** ("all issues labelled bug", "everything ready-for-agent"): resolve via `gh`, e.g.
  ```bash
  gh issue list --label "bug" --state open --json number,title,labels --limit 100
  ```

Then **gate**: drop any item not in the adapter's `ready-for-agent` state - the
`ready-for-agent` label for GitHub, or the equivalent status the adapter
defines (e.g. a board column for Jira). Workers would refuse them anyway. List
the dropped ones for the user.

**Confirm the resolved list with the user before doing any work**, then go heads-down. This is the one checkpoint: they approve *what* gets worked, not each step.

### 2. Assess and group

Read each item (in adapter mode use the adapter's view command; the GitHub
default is `gh issue view <n> --json number,title,body,labels,comments`).
Decide batching:

- **Group together** issues that are likely to touch the same files, or that are small mechanical changes in the same area. One worker handles the group and opens **one PR that closes all of them** (`Closes #12`, `Closes #15`).
- **Keep separate** anything large, or that touches unrelated parts of the codebase.
- **Size limit**: a PR must stay reviewable by a human. If grouping would produce a sprawling diff, split it. When unsure, keep them separate.
- **Respect dependencies.** Check each item for blocking relationships using the adapter's *dependencies* operation (the GitHub default is `Blocked by #<n>` / `Depends on #<n>` references in the body; Jira uses `is blocked by` / `blocks` issue links). A blocked item cannot be worked until its blocker's PR is **merged** - workers branch off `main` and won't see unmerged changes. So either put a blocker and its dependent in the **same batch** (one PR, one worktree, implemented blocker-first) when they're small and adjacent, or **split them across waves**: dispatch the blocker first and hold the dependent until that PR merges (step 8). Never dispatch a dependent whose blocker is still open.

Record, per batch: the issue number(s), a one-line rationale for the grouping, and any blocker it waits on.

**Note cross-batch file overlap.** If two separate batches are likely to touch the same file (even in different regions), their parallel PRs will conflict on merge. Don't force them into one batch just to avoid that - instead record the overlap and call it out at handoff (step 7) so the human knows the merge order matters.

### 3. Pick a model per batch

For each batch, choose the worker's model by difficulty:

- **Well-described, simple, or mechanical** (rename, copy change, config tweak, obvious one-liner): a lesser/faster model.
- **Ambiguous, cross-cutting, or design-sensitive**: the default (stronger) model.

Pass this as the model override when dispatching.

### 4. Dispatch workers

Dispatch one `issue-worker` per batch (`subagent_type: issue-worker`, with your chosen model as the model override). Each `issue-worker` isolates its own worktree, so parallel workers will not collide. Each dispatch prompt needs only the inputs, not the workflow:

- The issue number(s) in the batch (the agent handles fetch, worktree, implement, test, push, and a single PR with one `Closes #<n>` line per issue (in adapter mode the worker references items per the adapter's PR-reference syntax instead)).
- Anything batch-specific worth flagging (a shared file, a linked plan).

**Cap concurrency at 5 workers in flight.** Never fan out the whole backlog at once - it blows up rate limits, token spend, and merge conflicts. Dispatch in waves of at most 5: review and bank each PR as it lands (step 5), then dispatch the next batch into the freed slot. A 30-issue backlog runs as ~6 waves, not 30 simultaneous workers.

**Hold back blocked batches.** Don't dispatch a batch whose blocker (step 2) hasn't merged yet. If the blocker's PR is only ready (not merged) by the end of the run, surface the dependent as waiting on it (step 7) rather than working it against stale `main`.

The agent reports back the PR URL, branch name, and worktree path. If it returns no PR (blocked, an issue turned out closed, batch too large to keep reviewable), note it against those issues and move on - do not retry blindly. If it reports the batch was too large, re-split and re-dispatch.

### 5. Review each PR

Workers open PRs as **draft**. When a worker reports a PR, do a **quick** review against the original issue(s) - not a full audit:

- Does the diff actually resolve what the issue asked for?
- Is it a sane size and scoped to the issue (no unrelated churn)?
- Are there tests, and do the PR's checks pass?

**Wait for CI without burning tokens, and bail if it stalls.** Don't loop re-polling `gh pr checks` with the model - that spends tokens and can hang forever on a queued pipeline. Use a single blocking watch with a hard wall-clock timeout (the shell waits, you don't):

```bash
timeout 900 gh pr checks <url> --watch --interval 30 --fail-fast; echo "checks_exit=$?"
# macOS without GNU coreutils: use `gtimeout` in place of `timeout`.
```

Interpret the exit code once:
- **0** - all checks green. Proceed to the verdict.
- **non-zero from `gh`** (a check failed) - that's a NEEDS WORK; cite the failing check.
- **124** - the `timeout` fired: CI is still queued/running after 15 min. **Do not keep waiting.** Leave the PR as draft, comment that CI never settled, and surface it to the human at handoff. Move on to other batches - a stuck pipeline must not block the run.

Then record the verdict. The draft flag is the state; the comment is the rationale:

```bash
# PASS: mark ready (this is the durable "passed review" signal) and explain.
gh pr ready <url>
gh pr comment <url> --body "afk-review: PASS - resolves #<n>, scoped, checks green."

# NEEDS WORK or CI stalled: leave it draft, explain.
gh pr comment <url> --body "afk-review: NEEDS WORK - <specific, actionable notes>"
```

For a deeper look on a risky change, use `superpowers:requesting-code-review` instead of eyeballing - if it is not installed, do the quick manual review above and flag the risk at handoff.

### 6. Rework loop

If your verdict is NEEDS WORK, dispatch a fresh `issue-worker` in **rework mode** (the branch and worktree persist). Give it:

- The branch name and worktree path from step 4.
- Your specific feedback.

It fixes the work in that worktree and pushes to the same branch, updating the existing PR. Re-review (step 5). Don't open a second PR for the same issues.

**Cap rework at 2 rounds per PR.** If a PR is still NEEDS WORK after two rework attempts, stop - do not keep dispatching workers at it. Leave it as draft with a comment summarising what's still wrong, and surface it to the human at handoff. Endless rework loops are the main way this skill burns tokens (especially on a stronger model); a human untangling a stuck PR is cheaper than a third and fourth automated attempt.

### 7. Done condition

The run is complete when **every in-scope issue is either resolved by a ready (non-draft) PR or has been explicitly surfaced as stuck**. You are not required to force every issue to PASS - a PR parked after the rework cap or a stalled-CI bail counts as handled, as long as you flag it.

Present the user two lists:

```bash
gh pr list --state open --json number,title,url,isDraft,headRefName
```

- **Ready to review** (passed, non-draft): per PR show title, URL, and which issues it closes. The human reviews and merges one at a time.
- **Needs a human** (still draft): PRs parked after the rework cap or because CI never settled, plus any issues that produced no PR - each with a one-line reason.

Also call out any **cross-batch file overlaps** from step 2 so the human knows which PRs to merge in order to avoid conflicts.

### 8. Merge cleanup and human review feedback

After handing off, the human reviews PRs one by one. Respond to two signals:

- **"PR #N is merged" / "clean up merged PRs"**: detect merged PRs and clean up their worktrees. Detect, don't assume:
  ```bash
  gh pr list --state merged --json number,headRefName,url --search "<scope>"
  git worktree list   # find the path for the merged branch
  ```
  Then dispatch an `issue-worker` in **cleanup mode** with the branch and worktree path, or do it yourself: `git worktree remove <path>` from the main root, then `git worktree prune`. Never `rm -rf` a worktree.

  In **adapter mode**, also transition the merged item to the adapter's *done*
  state if it does not close automatically (GitHub closes via `Closes #<n>`;
  Jira needs an explicit transition, e.g.
  `acli jira workitem transition --key <KEY> --status "Done (Complete)"`). Do
  this once per merged item, as part of cleanup.

- **"Reviewer left changes on PR #N" / "pick #N back up"**: read the human's review, then dispatch an `issue-worker` in rework mode (step 6) with the branch, worktree path, and the review feedback.
  ```bash
  gh pr view <url> --json reviews,comments
  ```

## Common Mistakes

When you catch yourself thinking the excuse, the reality is the rule.

| Excuse | Reality |
|--------|---------|
| "This issue is tiny, I'll just fix it myself" | You manage; `issue-worker` agents build. Dispatch it, even the one-liners. |
| "A quick state file will help me resume" | Never. State is `gh` - draft vs ready PRs, linked issues. A file goes stale and lies. |
| "It clearly passes, I'll mark it ready now" | Ready is the signal the human merges on. Draft until you have actually reviewed it against the issue. |
| "The backlog is small, I'll dispatch them all at once" | Cap at 5 in flight. Even a small backlog blows up rate limits and merge conflicts when fanned out. |
| "I'll just re-poll `gh pr checks` to see if CI's done" | One `timeout ... --watch` call, interpret the exit code once, bail at the limit. Looping burns tokens and can hang forever. |
| "One more rework round and it'll be there" | Cap at 2. A human untangling a stuck PR is cheaper than a third automated attempt. Park it and flag it. |
| "Grouping these saves PRs" | Reviewability beats fewer PRs. When the diff would sprawl, split. |
| "I'll gate the labels later" | Gate at scope time. Skipping it means finding out only when a worker refuses. |
| "Rework needs a fresh PR" | Push to the existing branch. A second PR on rework orphans the first. |
| "The worker was blocked, I'll retry it" | Report it and move on. Don't retry a blocked issue blindly. |
| "I'll dispatch all of these in parallel" | Check dependencies first. A dependent branched off `main` can't see its blocker's unmerged work - order the waves. |
