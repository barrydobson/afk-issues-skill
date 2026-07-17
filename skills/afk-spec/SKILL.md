---
name: afk-spec
description: Use when the user wants to carry a full written spec to a single open pull request unattended - plan it, build it across sequential subagent tasks on one branch, review the whole branch, then open one PR. e.g. "/afk-spec docs/specs/thing.md", "afk-spec this design doc", "work this spec to a PR while I'm away".
---

# AFK Spec

Carry one written spec to one open pull request, unattended. You are the
**orchestrator**. You do not plan, implement, or review with your own eyes -
you invoke the skills that do, in order, and then open the PR. The loop itself
is `superpowers:subagent-driven-development`; this skill is the spec front door
and the PR tail around it, nothing more.

Assumes the current directory is the target repo and `gh` is authenticated.

## Hard dependencies (check first, fail fast)

Unlike the sibling `afk-issues` skill, whose superpowers helpers are optional
power-ups, this skill is **nothing without its two dependencies**. Before doing
any work, confirm both are in your available skills list:

- `superpowers:writing-plans`
- `superpowers:subagent-driven-development`

If either is missing, **stop** and tell the user once, plainly: this skill wraps
those two skills and cannot run without them; install the superpowers plugin
(`/plugin marketplace add obra/superpowers` then
`/plugin install superpowers@superpowers-dev`) and re-run. Do not attempt a
degraded run - there is nothing to degrade to.

## The one rule

**Every run ends with exactly one open, non-draft PR.** Even when the final
whole-branch review still has open findings, you open the PR and summarise those
findings honestly in its body. You never call `gh pr ready` (creating non-draft
once is what routes around the self-approval classifier). You never merge - the
human does that.

## Steps

### 1. Resolve the spec

Take the spec path from the invocation (`/afk-spec <path>`). Read it. If no path
was given and the request is genuinely ambiguous, ask once; otherwise go
straight to work.

### 2. Plan

Invoke `superpowers:writing-plans` on the spec to produce a dependency-**ordered**
task plan with per-task acceptance criteria. The plan's order is the dependency
graph flattened - a task that depends on another simply comes later on the one
branch, so there is no blocker/waiting handling to do here.

### 3. Execute

Invoke `superpowers:subagent-driven-development` to run the plan. That skill owns
the entire loop: it isolates one worktree, dispatches a fresh implementer per
task sequentially, runs a task review after each, runs a broad whole-branch
review at the end, and tracks progress in its on-disk ledger. Do not duplicate
or second-guess any of it. Hand it two operating overrides for unattended use:

- **Subagents log, don't ask.** When you compose an implementer dispatch prompt,
  instruct the subagent to make the reasonable assumption and record it in its
  report rather than asking a question - a mid-run question stalls an unattended
  run. (Same discipline `afk-issues` workers use.)
- **Halt only on a genuine plan contradiction.** SDD's pre-flight plan review and
  its plan-contradiction escalations stay valid halt points - a real
  contradiction should stop the run, not be guessed past. Everything short of a
  contradiction proceeds and is logged, not raised to the human mid-run.

### 4. Open the PR (fixed tail)

Do **not** invoke `superpowers:finishing-a-development-branch`. Its menu is
interactive; this tail is fixed. Once SDD's final whole-branch review has run:

Run, once:

```bash
gh pr create --title "<spec title>" --body "<body>"
```

- Non-draft (omit `--draft`). Never follow with `gh pr ready`.
- The body lists what the branch delivers against the spec's acceptance criteria,
  and summarises any outstanding findings from the final review.

Then report the PR URL to the user and stop. Do not watch CI, do not merge.

## Common Mistakes

When you catch yourself thinking the excuse, the reality is the rule.

| Excuse | Reality |
|--------|---------|
| "I'll just plan and build it myself, it's a small spec" | You orchestrate. `writing-plans` plans, SDD builds and reviews. Invoke them. |
| "SDD wants to check in before Task 1, I'll relay that to the user" | Only a genuine plan contradiction halts. Pre-flight noise is logged and passed through, not raised mid-run. |
| "The implementer asked a question, I'll wait for the human" | Unattended. Tell implementers to log the assumption and proceed. A question that reaches the human mid-run has already stalled the loop. |
| "I'll open it draft, then ready it once the review passes" | Never. Draft-then-ready is the self-approval flip the classifier blocks. Open non-draft, once. |
| "The final review found issues, so I won't open a PR" | Open the PR anyway and summarise the findings in the body. A PR is the mandatory outcome - the human triages from there. |
| "Let me watch CI before I finish" | Out of scope. Open the PR, report the URL, stop. |
| "I'll call finishing-a-development-branch to wrap up" | No - its menu is interactive. Run the fixed tail: create non-draft, report, stop. |
| "superpowers isn't installed, I'll do a best-effort version" | Hard dependency. Stop and tell the user to install it. There is nothing to degrade to. |
