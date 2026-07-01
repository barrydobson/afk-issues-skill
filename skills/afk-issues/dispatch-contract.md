# Dispatch contract

The orchestrator (`afk-issues` or `grab-issue`) and the `issue-worker` agent
exchange task dispatch and terminal reports through five fixed shapes. This
keeps both sides from drifting into loose prose: a worker's final message
must always be checkable against a known field set, and a dispatch prompt
must always carry everything the worker needs without a re-fetch.

Like `tracker-adapter.md`, this is not code - it is the fixed set of labelled
fields both `SKILL.md` files and `issue-worker.md` must use when building a
dispatch prompt or a final report. Free prose around the fields is fine;
omitting a field, or ending a report without a `STATUS` line, is not.

## 1. New task (build mode)

The orchestrator embeds the full issue content it already fetched while
assessing scope - the worker never re-fetches from the tracker. The issue
reference is kept only for commit/PR references (`Closes #<n>`, or the
adapter's PR-reference syntax).

```
MODE: build
ISSUES:
  - REF: #12          (use for commits/PR references, e.g. "Closes #12")
    TITLE / BODY / COMMENTS / STATE: <full content, pre-fetched by orchestrator>
  - REF: #15
    TITLE / BODY / COMMENTS / STATE: <full content, pre-fetched by orchestrator>
MODEL: <override, if any>
SCOPE: files/areas this batch is expected to touch
OUT_OF_SCOPE: adjacent things NOT to fix even if noticed
WORK_ACCEPTANCE: e.g. tests pass, lint clean, follows linked plan
RESULT_ACCEPTANCE: e.g. one draft PR, Closes #12 + #15
NOTES: anything batch-specific (shared file, linked plan)
LEARNINGS_FROM_PRIOR_BATCHES: relevant gotchas from earlier batches this run, if any
```

## 2. Rework task

```
MODE: rework
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
MODEL: <same override chosen for this batch at build, if any>
FEEDBACK: the specific PASS/NEEDS WORK points, or a link to the human review
RESULT_ACCEPTANCE: same PR updated, same Closes lines, checks green
```

Carry the batch's build-time model choice into rework. Without it the worker
falls back to its default model, so a batch escalated to a stronger model for
build would silently drop to the weaker default for the fix.

## 3. Cleanup task

```
MODE: cleanup
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
TRACKER_TRANSITION: none (GitHub auto-closes) | transition to <state> (adapter mode)
```

## 4. Work-complete handoff

Acceptance is evidence, not a claim - the orchestrator must be able to check
each line without re-doing the work itself.

```
STATUS: COMPLETE
MODE: build|rework|cleanup
PR: <url>                              (build/rework only)
BRANCH / WORKTREE: <path>
PER_ISSUE_SUMMARY: one line per issue - what was done
ACCEPTANCE_CHECK:
  WORK_ACCEPTANCE: <evidence, e.g. "42 tests passed, 0 failed (tail of test output); lint: 0 warnings">
  RESULT_ACCEPTANCE: <evidence, e.g. "draft PR opened: <url>, body has Closes #12 and #15">
EXCLUDED: issues dropped as not-actionable, and why (if any)
LEARNINGS: gotchas/insights useful to other batches this run (omit if none)
```

## 5. Need-input escalation

```
STATUS: NEED_INPUT
BLOCKED_ON: one line - what's ambiguous/missing/broken
OPTIONS: A/B/C the orchestrator could choose, if there are real options
WORK_SO_FAR: branch/worktree state, if any exists
SAFE_TO_RESUME: yes (rework the same branch) | no (nothing salvageable)
LEARNINGS: gotchas/insights useful to other batches this run (omit if none)
```

## Rules

- A worker's final message always ends in exactly one of `STATUS: COMPLETE`
  or `STATUS: NEED_INPUT` - never a bare summary with neither, and never
  trailing off mid-thought.
- `LEARNINGS` only carries forward within the current run (held in the
  orchestrator's session context) - it is not a persistence mechanism by
  itself. The orchestrator decides whether anything in it is worth keeping
  past the run (see `afk-issues/SKILL.md` step 5's learnings triage).
- Missing or vague `ACCEPTANCE_CHECK` evidence is the orchestrator's problem
  to push back on via rework, not something a worker should pad with a
  restated claim.
