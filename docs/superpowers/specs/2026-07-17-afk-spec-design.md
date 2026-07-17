# afk-spec: one spec to one open PR, unattended

**Status:** Design
**Date:** 2026-07-17

## Problem

Carrying a whole spec to completion unattended keeps stalling. The existing
`afk-issues` skill and the `afk-workflow.js` Workflow script are both built on a
**per-batch branch, per-batch PR** model, which cannot chain dependent work in a
single run: nothing merges while the human is away, so a task whose blocker lives
on a different branch can never see the blocker's work. Dependents get parked in
a `waiting` list and the run finishes incomplete.

## Goal

Give a detailed spec to an orchestrator, walk away, and come back to a single
branch where every acceptance criterion is met, a fresh subagent has reviewed the
whole branch, and **one PR is always open**. The human still merges - the end
state is an open PR, not a merge, so the regulated merge gate stays human.

## Key realisation: the loop already exists

`superpowers:subagent-driven-development` (SDD) already implements the loop this
needs, and matches the "loop engineering" pattern (Osmani, *Loop Engineering*,
2026) point for point:

- Single accumulating branch in one worktree; commits accumulate.
- Sequential implementers (parallel implementers are an explicit Red Flag).
- Dependencies are handled as plan **order**, not as merge gates.
- Maker/checker split: fresh implementer per task, a separate task reviewer, and
  a broad whole-branch review at the end on the most capable model.
- Continuous execution with no human check-in between tasks.
- On-disk progress ledger (`.superpowers/sdd/progress.md`) that survives
  compaction - the "memory outside the conversation" the pattern depends on.

So this design does **not** reimplement any of that. It is a thin wrapper that
supplies the two things SDD does not: a spec front door, and an unattended tail
that always opens a PR.

## Non-goals

- **Reimplementing SDD.** The loop is SDD's, untouched.
- **Merging.** The human merges. The outcome is a PR, by design.
- **Parallel task execution.** Sequential only, inherited from SDD.
- **Modifying `finishing-a-development-branch`.** Its interactive menu stays for
  its normal callers. This wrapper does not call it; it runs its own fixed tail.
- **Machine-proving acceptance criteria.** "All ACs met" is only as strong as the
  spec's ACs. The spec is the quality gate; the skill surfaces this, does not fix
  it.
- **Replacing `afk-issues`.** That skill keeps its job (a backlog of independent
  tickets, each to its own PR). `afk-spec` is one-spec-to-one-PR.

## Design

New skill `afk-spec` in this repo, invoked as `/afk-spec <path-to-spec.md>`. It is
a ~40-line orchestration `SKILL.md`, not an engine. The orchestrator is the user's
own session, so git/gh run with the user's real permission mode (not the sandboxed
Workflow context that blocked `afk-workflow.js`).

### Flow

1. **Plan.** Invoke `superpowers:writing-plans` on the spec to produce a
   dependency-**ordered** task plan with per-task acceptance criteria. The plan's
   order is the dependency graph flattened.

2. **Execute.** Invoke `superpowers:subagent-driven-development` to run the plan.
   This is the whole loop - worktree isolation, sequential implementers,
   per-task review, final whole-branch review, progress ledger. The wrapper does
   not duplicate any of it. Two behaviour overrides are passed in (below).

3. **Tail (fixed, always a PR).** Do **not** invoke
   `finishing-a-development-branch`. Instead:
   - `gh pr create` **non-draft, exactly once**, with a body listing what the
     branch delivers against the spec's acceptance criteria. (Creating non-draft
     once avoids the self-approval classifier flip that `gh pr ready` triggers.)
   - Report the PR URL, then stop. CI checks are out of scope - the run does not
     watch or wait on them.
   - **Opening a PR is the mandatory terminal outcome of every run.** Even when
     the final review still has open findings, the PR is opened and those
     findings are summarised honestly in the body - the run never ends without a
     PR to hand back.

### Behaviour overrides passed to SDD

- **Unattended: subagents log, don't ask.** SDD lets an implementer ask questions
  before and during work; a question stalls an unattended run. Instruct
  subagents to make the reasonable assumption and record it in their report
  rather than asking. (Same discipline `afk-issues` uses for its workers.)
- **Halt only on a genuine plan contradiction.** SDD's pre-flight plan review and
  its plan-contradiction escalations remain valid halt points - a real
  contradiction *should* stop the run rather than guess. Everything short of that
  proceeds and is logged.

### Reused as-is (nothing new built)

- `superpowers:writing-plans` - the plan.
- `superpowers:subagent-driven-development` - the entire execution loop, its
  worktree handling, maker/checker reviews, and ledger.
- `superpowers:using-git-worktrees` - pulled in transitively by SDD for isolation.

### New in this skill

- The `SKILL.md` orchestration and its trigger/description.
- The fixed PR tail (create non-draft, bounded check-watch, report).
- The two behaviour-override paragraphs handed to SDD.

## Acceptance criteria

- A single `/afk-spec <spec>` run on a spec with dependent tasks produces one
  branch containing all tasks' work, with no task parked as waiting on an
  in-scope blocker.
- Every run ends with exactly one non-draft PR open; the run never calls
  `gh pr ready` and never ends without a PR.
- The wrapper invokes `writing-plans` then `subagent-driven-development`; it does
  not reimplement the execution loop, and does not invoke
  `finishing-a-development-branch`.
- Subagents dispatched during the run do not stall on questions - assumptions are
  logged in their reports; the run halts only on a genuine plan contradiction.
- The final whole-branch review (SDD's) runs before the PR is opened; its
  outstanding findings, if any, are summarised in the PR body.
- The run reports the PR URL, then stops without merging. It does not watch,
  wait on, or gate the outcome on CI checks.
