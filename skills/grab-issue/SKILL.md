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
**adapter mode** - that doc (and `docs/agents/triage-labels.md`) defines how to
view an item, check it is gated, and transition it; follow it wherever this skill
shows a `gh` command. If it does not exist, use the built-in GitHub (`gh`)
commands below. Announce which mode you are in once, then go heads-down.

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
your chosen model as the override). The dispatch prompt needs only the inputs, not
the workflow - the worker fetches, isolates a worktree, implements, tests, pushes,
and opens **one draft PR** that closes the issue:

- The issue number.
- Anything worth flagging (a linked plan, a known tricky file).

The worker reports back the PR URL, branch name, and worktree path. If it returns
no PR (the issue turned out closed, or it was too large to keep reviewable), relay
that and stop - do not retry blindly.

### 5. Hand back for review

Report to the user: the **draft** PR URL, branch name, worktree path, and the
worker's one-line summary of how it addressed the issue. Then stop. You do not
review it and you do not mark it ready - that is the user's call now.

## Follow-up signals

The user reviews the PR, then tells you what to do next. Respond to three signals;
reuse the worker's modes, never re-implement them here.

- **"mark it ready" / "it passes"**: `gh pr ready <url>`. This is the only path to
  ready, and only on the user's say-so.
- **"pick it back up" / "rework it: <feedback>"**: dispatch an `issue-worker` in
  **rework mode** with the branch name, worktree path, and the user's feedback (or,
  for a human PR review left on the PR, point it at `gh pr view <url> --json
  reviews,comments`). It pushes to the same branch - never a second PR. Then hand
  back again.
- **"it's merged" / "clean up"**: dispatch an `issue-worker` in **cleanup mode**
  with the branch and worktree path (it runs `git worktree remove`, never
  `rm -rf`). In adapter mode, if the merge does not auto-close the item, ask the
  worker to also transition it to the adapter's *done* state.

## Common Mistakes

When you catch yourself thinking the excuse, the reality is the rule.

| Excuse | Reality |
|--------|---------|
| "This issue is tiny, I'll just fix it myself" | You dispatch; the `issue-worker` builds. Hand it the number, even the one-liners. |
| "It looks ready, I'll mark it ready now" | Ready is the signal the human merges on. Stay draft until the user has reviewed and says so. |
| "No `ready-for-agent` label, but it's obviously fine" | The gate is the point. No label, no dispatch - recommend `triage` and stop. |
| "Rework needs a fresh PR" | Dispatch rework against the existing branch. A second PR orphans the first. |
| "A quick state file will help me track this" | Never. The draft vs ready PR is the state. A file goes stale and lies. |
