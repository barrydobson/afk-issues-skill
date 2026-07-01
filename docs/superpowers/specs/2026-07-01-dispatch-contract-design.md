# Dispatch contract: formalising orchestrator <-> issue-worker handoffs

## Problem

Dispatch prompts and final reports are currently free prose. `SKILL.md`
describes what to *put in* a dispatch loosely ("issue numbers, model,
anything worth flagging") and `issue-worker.md` describes what to *report
back* just as loosely ("structured and factual", a few bullet examples).
Nothing forces either side into a fixed shape.

In practice this produces two failure modes:

- **Silent trailing-off.** A worker that gets stuck has no required last line
  telling the orchestrator "I'm done" vs "I'm stuck" - it can just stop, or
  wander into a status update that isn't actually a terminal report, leaving
  the orchestrator to prompt it.
- **Scope drift.** Nothing in a dispatch prompt says what the batch should
  *not* touch, so a worker noticing an adjacent issue can "fix it while I'm
  here" without the orchestrator ever deciding that was in scope.

A secondary problem: the worker currently re-fetches every issue from the
tracker in Build mode step 1, even though the orchestrator already read every
issue in its own step 2 (Assess and group) a few minutes earlier. That's a
duplicate fetch for no reason other than the dispatch prompt not carrying the
content forward.

## Approach

Define five fixed message shapes - a **dispatch contract** - covering both
directions of every handoff between the orchestrator and `issue-worker`:

1. New task (orchestrator -> worker, build mode)
2. Rework task (orchestrator -> worker, rework mode)
3. Cleanup task (orchestrator -> worker, cleanup mode)
4. Work-complete handoff (worker -> orchestrator, terminal on success)
5. Need-input escalation (worker -> orchestrator, terminal when stuck)

These aren't a new API - the plugin has no code, so "contract" means a fixed
set of labelled fields that must appear in the dispatch prompt / the worker's
final message, in the same spirit as the existing `tracker-adapter.md`
contract. One new file, `dispatch-contract.md`, is the single source of
truth; `afk-issues/SKILL.md`, `grab-issue/SKILL.md`, and `issue-worker.md`
each point to it instead of restating the fields.

The worker's final message must always end in exactly one of
`STATUS: COMPLETE` or `STATUS: NEED_INPUT` - that's the direct fix for
silent trailing-off. The new-task contract gains `SCOPE` / `OUT_OF_SCOPE`
fields - the direct fix for scope drift.

This stays a **terminal-report-only** change: dispatch is still a one-shot
Agent/Task call that runs to completion and returns one final message. There
is no mid-task pause/resume - a worker that needs input still ends its turn
(via `NEED_INPUT`) rather than staying alive waiting for an answer.

## The contract

New file `skills/afk-issues/dispatch-contract.md`, defining all five shapes.

### §1 New task (build mode)

The orchestrator embeds the full content it already fetched in its own "Assess
and group" step - the worker never re-fetches from the tracker. The issue
number is kept only for commit/PR references (`Closes #<n>`).

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

### §2 Rework task

```
MODE: rework
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
FEEDBACK: the specific PASS/NEEDS WORK points, or a link to the human review
RESULT_ACCEPTANCE: same PR updated, same Closes lines, checks green
```

### §3 Cleanup task

```
MODE: cleanup
BRANCH: issue-12-foo
WORKTREE: .worktrees/issue-12-foo
TRACKER_TRANSITION: none (GitHub auto-closes) | transition to <state> (adapter mode)
```

### §4 Work-complete handoff

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

### §5 Need-input escalation

```
STATUS: NEED_INPUT
BLOCKED_ON: one line - what's ambiguous/missing/broken
OPTIONS: A/B/C the orchestrator could choose, if there are real options
WORK_SO_FAR: branch/worktree state, if any exists
SAFE_TO_RESUME: yes (rework the same branch) | no (nothing salvageable)
LEARNINGS: gotchas/insights useful to other batches this run (omit if none)
```

`LEARNINGS` only carries forward within the current run (held in the
orchestrator's session context, like everything else in this skill) - it is
not a persistence mechanism by itself. See "Learnings triage" below for what
happens when something in it is actually worth keeping past the run.

## File changes

### `skills/afk-issues/SKILL.md`

- Step 4 (Dispatch workers): build the dispatch prompt per
  `dispatch-contract.md` §1, using the issue content already read in step 2.
  Carry forward any `LEARNINGS` from batches already completed this run via
  `LEARNINGS_FROM_PRIOR_BATCHES`.
- Step 5 (Review each PR) gains two checks before the existing PASS/NEEDS WORK
  judgement:
  - **Acceptance evidence check.** If `ACCEPTANCE_CHECK` is missing, vague, or
    doesn't actually support the criteria given at dispatch, treat it as
    NEEDS WORK and route into the existing rework loop (step 6) - the same
    2-round cap applies. This must not go to the human first; the rework loop
    is the "not enough evidence" path, human escalation is only after the cap
    is hit (unchanged from today).
  - **Learnings triage.** For each `LEARNINGS` entry, decide discard (noise) or
    keep (durable gotcha/insight). For each "keep" item, pick a recommended
    destination: **CLAUDE.md** for a fact about the codebase any future
    contributor needs, **memory** for a fact about this session's
    preferences/corrections/ephemeral project state. Present all "keep" items
    in one `AskUserQuestion` call (one question per item, options: recommended
    destination first, the other second - the tool's built-in "Other" covers a
    custom target like a docs file). On the human's answer, write directly
    (e.g. edit `CLAUDE.md` and commit straight to main - this is documentation
    about the codebase, not the codebase itself, so it skips the PR flow; the
    human already approved content and destination via the prompt).
  - `STATUS: NEED_INPUT` reports get explicit handling: decide from `OPTIONS`
    and either re-dispatch (rework, with the decision as feedback) or, if the
    orchestrator can't decide alone, park the batch and surface it at handoff
    (step 7) - same as an unresolved NEEDS WORK.
- Step 6 (Rework loop): build the prompt per `dispatch-contract.md` §2.
- Step 8 (Cleanup): build the prompt per `dispatch-contract.md` §3.
- "Common Mistakes" table gains two rows (see below).

### `skills/grab-issue/SKILL.md`

Same pointers as above for dispatch/rework/cleanup (§1/§2/§3). It already
fetches the single issue in its own step 2, so that becomes the embedded
`ISSUES` content. No learnings-triage step is added here - grab-issue is
supervised, so a human is already in the room to judge what's worth keeping;
it just relays the worker's `LEARNINGS` to the human as-is in its existing
hand-back-for-review step, and lets them decide whether to raise it
separately. "Common Mistakes" table gains the same two rows as afk-issues.

### `agents/issue-worker.md`

- Build mode's "1. Fetch every issue in the batch" step is deleted -
  superseded by the contract's embedded `ISSUES` content. The worker still
  checks each item's given `STATE` and excludes/reports anything not
  actionable; it does not re-fetch to double-check.
- Each mode (Build/Rework/Cleanup) gets a one-line pointer to which
  `dispatch-contract.md` section is its input.
- The "Reporting" section is replaced by a pointer to §4 (success) / §5
  (stuck), with the rule that the final message always ends in exactly one of
  `STATUS: COMPLETE` or `STATUS: NEED_INPUT` - never a bare summary with
  neither.
- "Rules" gains a line: acceptance evidence must be concrete (test output,
  URLs), not a restated claim.

### Common Mistakes additions (both SKILL.md files)

| Excuse | Reality |
|--------|---------|
| "I'll just fetch the issue again to be sure" (worker) | The dispatch already carries the full issue content - trust it, don't re-fetch. |
| "Looks done, I'll take its word for it" (orchestrator) | `ACCEPTANCE_CHECK` needs evidence (test output, a URL) - missing or vague evidence is an automatic NEEDS WORK into the rework loop, not a pass. |

## Invariant changes

- New: the worker's final message is always exactly one of
  `STATUS: COMPLETE` / `STATUS: NEED_INPUT`. No other terminal shape.
- New: acceptance criteria are checked against evidence in the report, not
  taken on trust. Insufficient evidence is NEEDS WORK, handled by the existing
  rework loop and its existing 2-round cap - it does not create a new
  escalation path to the human.
- New, narrow exception to "state lives in the system of record, never on
  disk": a human-approved `CLAUDE.md` documentation edit from learnings
  triage may be committed directly to main by the orchestrator, skipping the
  PR flow. This is documentation about the codebase, not application state or
  tracker/PR state - the existing invariant is about avoiding a stale
  tracking file that lies about issue/PR status, which this isn't.
- Unchanged: no state files, draft = unreviewed / ready = passed, bounded
  loops (5 concurrent, 2 rework rounds), one PR per batch, one worktree per
  batch.

## Out of scope

- No mid-task pause/resume. `NEED_INPUT` is a terminal report, not a live
  back-and-forth; dispatch stays a one-shot Agent/Task call.
- No new tooling for cross-session learnings persistence (e.g. no attempt to
  standardise "memory" beyond whatever the human's environment already does
  with it) - the skill just writes wherever the human says to.
- No change to the tracker-adapter contract, CI-wait mechanics, or the
  batching/dependency logic in step 2.

## Mechanical follow-ups

- Bump `version` in `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` together.
- British English, conventional commit prefixes.
