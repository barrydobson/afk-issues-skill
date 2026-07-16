# Dispatch contract

The orchestrator (`afk-issues`), the `issue-worker` agent, and the `pr-reviewer`
agent exchange task dispatch and terminal reports through fixed shapes. This
keeps every side from drifting into loose prose: a subagent's final message
must always be checkable against a known field set, and a dispatch prompt must
always carry everything the subagent needs without a re-fetch.

Like `tracker-adapter.md`, this is not code - it is the fixed set of labelled
fields the skill and both agents must use when building a dispatch prompt or a
final report. Free prose around the fields is fine; omitting a field, or
ending a report without a `STATUS`/`VERDICT` line, is not.

**No PR exists until the orchestrator decides one should.** `issue-worker`
never calls `gh pr create` in build mode - it pushes a branch and stops. The
orchestrator creates the PR itself, once, only after a `pr-reviewer` verdict of
`APPROVED`, and opens it non-draft. This is deliberate: certifying your own
dispatched work as ready (`gh pr ready` on a PR you already opened) is exactly
the pattern auto-mode's classifier blocks as self-approval. Never creating a
not-yet-approved PR sidesteps that pattern instead of fighting it - see
`references/pr-review.md`.

## 1. New task (build mode) - to issue-worker

The orchestrator embeds the full issue content it already fetched while
assessing scope - the worker never re-fetches from the tracker. The issue
reference is kept only for the PR body the orchestrator writes later
(`Closes #<n>`, or the adapter's PR-reference syntax) - the worker itself never
writes it.

```
MODE: build
ISSUES:
  - REF: #12          (for the orchestrator's eventual PR body, e.g. "Closes #12")
    TITLE / BODY / COMMENTS / STATE: <full content, pre-fetched by orchestrator>
  - REF: #15
    TITLE / BODY / COMMENTS / STATE: <full content, pre-fetched by orchestrator>
MODEL: <override, if any>
SCOPE: files/areas this batch is expected to touch
OUT_OF_SCOPE: adjacent things NOT to fix even if noticed
WORK_ACCEPTANCE: e.g. tests pass, lint clean, follows linked plan
RESULT_ACCEPTANCE: e.g. branch pushed, commits clean, nothing left uncommitted
NOTES: anything batch-specific (shared file, linked plan)
LEARNINGS_FROM_PRIOR_BATCHES: relevant gotchas from earlier batches this run, if any
```

## 2. Rework task - to issue-worker

A PR may or may not exist yet for this batch, depending on where in the review
cycle rework is happening (mid-cycle: none yet; after the rework cap parked it
as draft; or a human left feedback on an already-approved PR post-handoff).
Either way the worker only ever pushes to the branch - it never opens or
touches PR state itself.

```
MODE: rework
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
MODEL: <same override chosen for this batch at build, if any>
FEEDBACK: the reviewer's findings, or a link to the human's PR review
RESULT_ACCEPTANCE: same branch updated, checks green
```

Carry the batch's build-time model choice into rework. Without it the worker
falls back to its default model, so a batch escalated to a stronger model for
build would silently drop to the weaker default for the fix.

## 3. Cleanup task - to issue-worker

```
MODE: cleanup
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
TRACKER_TRANSITION: none (GitHub auto-closes) | transition to <state> (adapter mode)
```

## 4. Reviewer dispatch - to pr-reviewer

Built once CI is green (or has no push signal - see `references/pr-review.md`
§1). Same `ISSUES`/`SCOPE`/`OUT_OF_SCOPE` the worker was given, plus the
worker's own report and a diff package file so the reviewer never re-derives
the diff with git commands.

```
ISSUES: <same REF + TITLE/BODY/COMMENTS/STATE the worker was given>
SCOPE / OUT_OF_SCOPE: <same as given to the worker>
WORKER_REPORT: <the worker's §5 report, verbatim>
DIFF_PACKAGE: <path printed by ${CLAUDE_PLUGIN_ROOT}/scripts/review-package.sh BASE_SHA HEAD_SHA>
MODEL: <chosen the same way as the batch's build model - step 3 of SKILL.md>
```

## 5. Work-complete handoff - from issue-worker

Acceptance is evidence, not a claim - the orchestrator (and later the
reviewer) must be able to check each line without re-doing the work itself.

```
STATUS: COMPLETE
MODE: build|rework|cleanup
BASE_SHA: <git merge-base main HEAD - the batch's branch point, for the diff package>
HEAD_SHA: <git rev-parse HEAD - unchanged base, updated head after rework>
BRANCH / WORKTREE: <path>
PER_ISSUE_SUMMARY: one line per issue - what was done
ACCEPTANCE_CHECK:
  WORK_ACCEPTANCE: <evidence, e.g. "42 tests passed, 0 failed (tail of test output); lint: 0 warnings">
  RESULT_ACCEPTANCE: <evidence, e.g. "pushed issue-12-foo, 3 commits, working tree clean">
EXCLUDED: issues dropped as not-actionable, and why (if any)
LEARNINGS: gotchas/insights useful to other batches this run (omit if none)
```

`BASE_SHA`/`HEAD_SHA` are omitted for cleanup mode (no diff to package).

## 6. Need-input escalation - from issue-worker

```
STATUS: NEED_INPUT
BLOCKED_ON: one line - what's ambiguous/missing/broken
OPTIONS: A/B/C the orchestrator could choose, if there are real options
WORK_SO_FAR: branch/worktree state, if any exists
SAFE_TO_RESUME: yes (rework the same branch) | no (nothing salvageable)
LEARNINGS: gotchas/insights useful to other batches this run (omit if none)
```

## 7. Reviewer verdict - from pr-reviewer

Full detail on how to arrive at this is in `agents/pr-reviewer.md`; this is the
fixed shape the orchestrator acts on.

```
SPEC: ✅ compliant | ❌ issues found (below) | ⚠️ cannot verify: <what, and what the orchestrator should check>
STRENGTHS: <specific, brief>
ISSUES:
  CRITICAL: <file:line - what, why, fix>
  IMPORTANT: <file:line - what, why, fix>
  MINOR: <file:line - what, why, fix>
VERDICT: APPROVED | NEEDS FIXES
```

`APPROVED` requires a `✅` spec verdict and no Critical/Important issues. A `⚠️`
item does not by itself force `NEEDS FIXES` - the orchestrator resolves it
(it holds cross-batch context the reviewer doesn't); if resolving it surfaces a
real gap, that's a `NEEDS FIXES` on the next round, not a silent pass.

## Rules

- **Dispatch is a plain blocking Agent/Task call - never a named agent.** The
  skill dispatches `issue-worker` and `pr-reviewer` with no `name`; each runs
  its prompt and its final message (§5/§6, or §7) is returned as the tool
  result. Naming the agent turns it into a persistent teammate that idles on a
  mailbox heartbeat waiting for `SendMessage` mail this contract never sends -
  so it never runs the task. No `name`, no `SendMessage`.
- A worker's final message always ends in exactly one of `STATUS: COMPLETE` or
  `STATUS: NEED_INPUT`; a reviewer's always ends in `VERDICT: APPROVED` or
  `VERDICT: NEEDS FIXES` - never a bare summary, never trailing off mid-thought.
- `LEARNINGS` only carries forward within the current run (held in the
  orchestrator's session context) - it is not a persistence mechanism by
  itself. The orchestrator decides whether anything in it is worth keeping
  past the run (see `afk-issues/SKILL.md` step 5's learnings triage).
- Missing or vague `ACCEPTANCE_CHECK` evidence, or a reviewer `⚠️` the
  orchestrator can't actually resolve, is the orchestrator's problem to push
  back on via rework - not something a subagent should pad with a restated
  claim.
- The reviewer is read-only: it never runs `gh pr create`/`ready`/`comment`,
  never commits, pushes, or checks out anything. It returns a verdict; only the
  orchestrator acts on GitHub.
