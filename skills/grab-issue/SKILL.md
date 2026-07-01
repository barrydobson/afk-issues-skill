---
name: grab-issue
description: Use when the user wants to pick up, grab, take, claim, or start work on a single tracker issue while supervising - e.g. "/grab-issue 42", "grab issue 42", "work on issue 17", "pick up #23". For an unattended batch, use afk-issues instead.
---

# Grab Issue

Carry a single triaged issue to a pull request while you watch. This is the
supervised, one-issue front-door to the same machinery `afk-issues` runs
unattended: you resolve and gate the issue, dispatch one `issue-worker` to build
it, then hand the PR back for you to review. You do NOT implement it yourself and
you do NOT re-derive the worktree/PR mechanics - the `issue-worker` agent
(Agent/Task tool, `subagent_type: issue-worker`) already owns all of that.

Assumes the current directory is the target repo and `gh` is authenticated.

For several issues without supervision, use `afk-issues`, not this.

## State lives in the system of record, not on disk

Never write a state file. The draft PR *is* the review state: the worker opens it
**draft**, and it stays draft until **you** have reviewed it and tell this skill
to mark it ready. `draft = not yet reviewed by you`, `ready = you passed it`. This
skill never marks a PR ready on its own - a human is in the room, so the human is
the review.

## Steps

### 1. Resolve the tracker

Look for `docs/agents/issue-tracker.md` in the repo. If it exists, you are in
**adapter mode** - that profile names a tracker reference (the afk-issues skill's
`references/jira.md`, etc.) and supplies the project variables; follow the
reference's commands - view an item, check it is gated, transition it - wherever
this skill shows a `gh` command, filling the profile's values. If it does not
exist, use the built-in GitHub reference (the afk-issues skill's
`references/github.md`). Announce which
mode you are in once, then go heads-down.

### 2. Fetch and gate the one issue

```bash
gh issue view <number> --json number,title,body,labels,state,url,comments
```

(In adapter mode, use the adapter's view command.)

- **Not open** (GitHub: `state` not `OPEN`; adapter: a done state) - stop and tell
  the user it is closed. Do nothing else.
- **Not gated** - check for the `ready-for-agent` state (the label on GitHub, the
  equivalent status the adapter defines). **If absent, STOP.** Do not dispatch a
  worker. Tell the user the issue is not triaged for agents and recommend running
  the `triage` skill first to bring it to `ready-for-agent`. End here.

This skill owns the gate - the worker trusts it and will not re-gate.

### 3. Pick a model

Judge the single issue's difficulty and choose the worker's model:

- **Well-described, simple, or mechanical** (rename, copy change, config tweak,
  obvious one-liner): a lesser/faster model.
- **Ambiguous, cross-cutting, or design-sensitive**: the default (stronger) model.

Pass this as the model override when dispatching.

### 4. Dispatch one issue-worker

Dispatch a single `issue-worker` (`subagent_type: issue-worker`, build mode, with
your chosen model as the override). Build the dispatch prompt per
`dispatch-contract.md` §1 (New task) - embed the title/body/comments/state you
already read in step 2, so the worker never re-fetches from the tracker.

The worker's final report is `dispatch-contract.md` §4 (Work-complete) or §5
(Need-input). On §4 with no PR (the issue turned out closed, or it was too large
to keep reviewable), relay that and stop - do not retry blindly. On §5, relay the
`BLOCKED_ON` and `OPTIONS` to the user - this skill is supervised, so the human
decides, not you.

### 5. Hand back for review

Report to the user: the **draft** PR URL, branch name, worktree path, the
worker's one-line summary of how it addressed the issue, and its
`ACCEPTANCE_CHECK` evidence verbatim (so the user can see what the worker
claims to have verified, not just that it claims success). If the report
included `LEARNINGS`, relay it as-is - you don't triage it yourself; a human
is already in the room to judge what's worth keeping. Then stop. You do not
review it and you do not mark it ready - that is the user's call now.

## Follow-up signals

The user reviews the PR, then tells you what to do next. Respond to three signals;
reuse the worker's modes, never re-implement them here.

- **"mark it ready" / "it passes"**: `gh pr ready <url>`. This is the only path to
  ready, and only on the user's say-so.
- **"pick it back up" / "rework it: <feedback>"**: dispatch an `issue-worker` in
  **rework mode** (dispatch prompt per `dispatch-contract.md` §2) with the branch
  name, worktree path, the same model you chose in step 3, and the user's feedback
  (or, for a human PR review left on the PR, point it at
  `gh pr view <url> --json reviews,comments`). It pushes to
  the same branch - never a second PR. Then hand back again.
- **"it's merged" / "clean up"**: dispatch an `issue-worker` in **cleanup mode**
  (dispatch prompt per `dispatch-contract.md` §3) with the branch and worktree
  path (it runs `git worktree remove`, never `rm -rf`). In adapter mode, if the
  merge does not auto-close the item, ask the worker to also transition it to the
  adapter's *done* state.

## Common Mistakes

When you catch yourself thinking the excuse, the reality is the rule.

| Excuse | Reality |
|--------|---------|
| "This issue is tiny, I'll just fix it myself" | You dispatch; the `issue-worker` builds. Hand it the number, even the one-liners. |
| "It looks ready, I'll mark it ready now" | Ready is the signal the human merges on. Stay draft until the user has reviewed and says so. |
| "No `ready-for-agent` label, but it's obviously fine" | The gate is the point. No label, no dispatch - recommend `triage` and stop. |
| "Rework needs a fresh PR" | Dispatch rework against the existing branch. A second PR orphans the first. |
| "A quick state file will help me track this" | Never. The draft vs ready PR is the state. A file goes stale and lies. |
| "The worker fetched the issue itself, so its numbers must be right" | You already fetched it in step 2 - the dispatch prompt carries that content forward per `dispatch-contract.md` §1. |
| "It says tests pass, I'll relay that as a pass" | Relay the `ACCEPTANCE_CHECK` evidence itself to the user, not your own gloss on it - they decide, you're supervised here. |
