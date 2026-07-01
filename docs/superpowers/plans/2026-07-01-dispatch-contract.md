# Dispatch Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalise the five orchestrator<->issue-worker handoff shapes (new task, rework, cleanup, work-complete, need-input) so a worker never trails off silently and never drifts out of scope.

**Architecture:** One new reference doc, `skills/afk-issues/dispatch-contract.md`, defines all five fixed message shapes (mirrors the existing `tracker-adapter.md` pattern: one contract doc, multiple consumers point to it instead of restating it). `afk-issues/SKILL.md`, `grab-issue/SKILL.md`, and `agents/issue-worker.md` are edited to build dispatch prompts and terminal reports against that contract instead of loose prose.

**Tech Stack:** None - this plugin has no code. The "source" is markdown (skill/agent instructions) plus two JSON manifests. There is no build/lint/test step; verification is reading the files and grepping for consistency, per this repo's `CLAUDE.md`.

## Global Constraints

- British English throughout (colour, licence, organisation - not applicable to this diff's vocabulary, but keep any new prose British).
- Conventional commit prefixes; one logical change per commit (this repo's convention: feature/docs commits first, a separate `chore(plugin): bump version to X.Y.Z in marketplace and plugin files` commit last).
- No state files. No new invariant may write tracker/issue/PR status to disk. (A `CLAUDE.md` documentation edit from learnings triage is documentation about the codebase, not tracker/PR state, and is explicitly allowed per the spec.)
- Bounded loops (5 concurrent workers, 2 rework rounds per PR) are unchanged - do not touch that logic.
- Manager/worker split is unchanged: orchestrator decides scope, worker never re-gates.
- Every edit must leave YAML frontmatter in `agents/issue-worker.md`, `skills/afk-issues/SKILL.md`, and `skills/grab-issue/SKILL.md` valid (unchanged keys, just don't break the `---` delimiters).
- Spec of record: `docs/superpowers/specs/2026-07-01-dispatch-contract-design.md`. Every field name and shape below is copied verbatim from it - if something here looks ambiguous, the spec is the tiebreaker, not improvisation.

---

## Task 1: Write `dispatch-contract.md`

**Files:**
- Create: `skills/afk-issues/dispatch-contract.md`

**Interfaces:**
- Produces: the five contract shapes (§1-§5) that Tasks 2-4 reference by section number. Nothing consumes this file's content directly - Tasks 2-4 only need to know the section headings exist: `## 1. New task (build mode)`, `## 2. Rework task`, `## 3. Cleanup task`, `## 4. Work-complete handoff`, `## 5. Need-input escalation`.

- [ ] **Step 1: Write the file**

```markdown
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
FEEDBACK: the specific PASS/NEEDS WORK points, or a link to the human review
RESULT_ACCEPTANCE: same PR updated, same Closes lines, checks green
```

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
```

- [ ] **Step 2: Verify structure**

Run:
```bash
grep -c '^## [1-5]\.' skills/afk-issues/dispatch-contract.md
```
Expected: `5`

Run:
```bash
grep -n 'TBD\|TODO\|fill in\|placeholder' skills/afk-issues/dispatch-contract.md
```
Expected: no output (exit code 1).

- [ ] **Step 3: Commit**

```bash
git add skills/afk-issues/dispatch-contract.md
git commit -m "docs(afk-issues): add dispatch-contract reference doc"
```

---

## Task 2: Point `agents/issue-worker.md` at the contract

**Files:**
- Modify: `agents/issue-worker.md`

**Interfaces:**
- Consumes: section headings from Task 1 (`## 1. New task (build mode)` etc. in `dispatch-contract.md`).
- Produces: nothing new consumed by other tasks - this task only changes the worker's own instructions.

- [ ] **Step 1: Delete the "Fetch every issue" step and renumber Build mode**

Find this block (Build mode, current steps 1-4):

```markdown
## Build mode

### 1. Fetch every issue in the batch

For each item, fetch it (GitHub default: `gh issue view <n> --json
number,title,body,labels,state,url,comments`; in adapter mode use the adapter's
view command).

If any item is **not actionable** (GitHub: state not `OPEN`; adapter: in a done
state per the adapter), exclude it and note it in your report. If that leaves
nothing actionable, stop and report - do nothing else. Take item comments into
account when implementing.

In adapter mode, transition each item you are picking up to the adapter's *in progress* state now (GitHub has no such step - skip it).

### 2. Create one isolated worktree for the whole batch
```

Replace with:

```markdown
## Build mode

Your dispatch prompt is `dispatch-contract.md` §1 (New task). The orchestrator
has already fetched every issue's title, body, comments, and state - use what
it gave you; do not re-fetch from the tracker. Check each item's given `STATE`:
if any item is **not actionable** (GitHub: state not `OPEN`; adapter: in a done
state per the adapter), exclude it and note it in your report. If that leaves
nothing actionable, stop and report - do nothing else. Take item comments into
account when implementing.

In adapter mode, transition each item you are picking up to the adapter's *in progress* state now (GitHub has no such step - skip it).

### 1. Create one isolated worktree for the whole batch
```

Then renumber the remaining Build mode headings: the old `### 3. Implement
every issue in that one worktree` becomes `### 2. Implement every issue in
that one worktree`, and the old `### 4. Push and open one PR` becomes `### 3.
Push and open one PR`. Their body text is unchanged.

- [ ] **Step 2: Point Rework mode and Cleanup mode at their contract sections**

Find:

```markdown
## Rework mode

1. `cd` into the given worktree path (it persists on disk). If it is gone, recreate it: `git worktree add <path> <branch>` then `cd` in.
```

Replace with:

```markdown
## Rework mode

Your dispatch prompt is `dispatch-contract.md` §2 (Rework task).

1. `cd` into the given worktree path (it persists on disk). If it is gone, recreate it: `git worktree add <path> <branch>` then `cd` in.
```

Find:

```markdown
## Cleanup mode

Only after the PR is merged. Never `rm -rf` a worktree.
```

Replace with:

```markdown
## Cleanup mode

Your dispatch prompt is `dispatch-contract.md` §3 (Cleanup task). Only after
the PR is merged. Never `rm -rf` a worktree.
```

- [ ] **Step 3: Replace the Reporting section with the contract's terminal shapes**

Find:

```markdown
## Reporting

End every run with a structured report for the orchestrator:

- **Build**: PR URL, branch name, worktree path, and a one-line summary per issue of how it was addressed. Note any issues excluded (not open) and why.
- **Rework**: the updated PR URL and a short note of what changed.
- **Cleanup**: confirmation the worktree was removed.
- **Blocked / stopped**: say so plainly, with the reason, and do not improvise around it.
```

Replace with:

```markdown
## Reporting

Your final message is always exactly one of the two shapes in
`dispatch-contract.md`:

- **§4 Work-complete handoff** - build, rework, or cleanup finished. Include
  the PR URL (build/rework), branch/worktree path, a one-line summary per
  issue, and `ACCEPTANCE_CHECK` evidence for each criterion you were given -
  concrete evidence (test output, a URL), never a restated claim. Note any
  issues excluded (not actionable) and why. Include `LEARNINGS` only if you
  found something worth passing to another batch this run.
- **§5 Need-input escalation** - you are blocked (ambiguous requirement,
  missing access, conflicting instructions, anything you cannot resolve
  yourself). State what you're blocked on, real options if there are any, and
  whether the branch/worktree is safe to resume. Do not improvise around a
  blocker and do not trail off without one of these two shapes.
```

- [ ] **Step 4: Add the evidence rule to "Rules"**

Find:

```markdown
## Rules

- Never work on `main`. One worktree per batch; never share a worktree with another worker.
- One PR per batch, referencing every item in it (GitHub `Closes #<n>`; otherwise the item key in the title). Never a second PR on rework.
- Editorialising the PR body is wrong - describe what the code does now.
- Don't re-gate (the orchestrator owns the ready-for-agent gate); do verify items are actionable per the tracker.
- If blocked, report it - don't retry blindly or silently drop work.
```

Replace with:

```markdown
## Rules

- Never work on `main`. One worktree per batch; never share a worktree with another worker.
- One PR per batch, referencing every item in it (GitHub `Closes #<n>`; otherwise the item key in the title). Never a second PR on rework.
- Editorialising the PR body is wrong - describe what the code does now.
- Don't re-gate (the orchestrator owns the ready-for-agent gate); do verify items are actionable against the `STATE` you were given, not a fresh fetch.
- If blocked, report it - don't retry blindly or silently drop work.
- Acceptance evidence must be concrete (test output, a URL) - never a restated claim of the criteria you were given.
```

- [ ] **Step 5: Verify consistency**

Run:
```bash
grep -n 'Fetch every issue' agents/issue-worker.md
```
Expected: no output.

Run:
```bash
grep -n 'dispatch-contract.md' agents/issue-worker.md
```
Expected: 4 matches (Build mode intro, Rework mode, Cleanup mode, Reporting section).

Run:
```bash
grep -n '^### [0-9]\.' agents/issue-worker.md
```
Expected: Build mode section shows `### 1.`, `### 2.`, `### 3.` with no gaps or duplicates.

- [ ] **Step 6: Commit**

```bash
git add agents/issue-worker.md
git commit -m "docs(issue-worker): report and take input via dispatch contract"
```

---

## Task 3: Point `afk-issues/SKILL.md` at the contract

**Files:**
- Modify: `skills/afk-issues/SKILL.md`

**Interfaces:**
- Consumes: `dispatch-contract.md` §1-§5 (Task 1); the worker's §4/§5 report shape (Task 2, no signature change - it's prose, not a function).

- [ ] **Step 1: Rewrite step 4 (Dispatch workers) to build the §1 prompt**

Find:

```markdown
### 4. Dispatch workers

Dispatch one `issue-worker` per batch (`subagent_type: issue-worker`, with your chosen model as the model override). Each `issue-worker` isolates its own worktree, so parallel workers will not collide. Each dispatch prompt needs only the inputs, not the workflow:

- The issue number(s) in the batch (the agent handles fetch, worktree, implement, test, push, and a single PR with one `Closes #<n>` line per issue (in adapter mode the worker references items per the adapter's PR-reference syntax instead)).
- Anything batch-specific worth flagging (a shared file, a linked plan).

**Cap concurrency at 5 workers in flight.** Never fan out the whole backlog at once - it blows up rate limits, token spend, and merge conflicts. Dispatch in waves of at most 5: review and bank each PR as it lands (step 5), then dispatch the next batch into the freed slot. A 30-issue backlog runs as ~6 waves, not 30 simultaneous workers.

**Hold back blocked batches.** Don't dispatch a batch whose blocker (step 2) hasn't merged yet. If the blocker's PR is only ready (not merged) by the end of the run, surface the dependent as waiting on it (step 7) rather than working it against stale `main`.

The agent reports back the PR URL, branch name, and worktree path. If it returns no PR (blocked, an issue turned out closed, batch too large to keep reviewable), note it against those issues and move on - do not retry blindly. If it reports the batch was too large, re-split and re-dispatch.
```

Replace with:

```markdown
### 4. Dispatch workers

Dispatch one `issue-worker` per batch (`subagent_type: issue-worker`, with your chosen model as the model override). Each `issue-worker` isolates its own worktree, so parallel workers will not collide. Build the dispatch prompt per `dispatch-contract.md` §1 (New task) - embed the full title/body/comments/state you already read for each issue in step 2, so the worker never re-fetches. Carry forward `LEARNINGS_FROM_PRIOR_BATCHES` from any batch already completed this run.

**Cap concurrency at 5 workers in flight.** Never fan out the whole backlog at once - it blows up rate limits, token spend, and merge conflicts. Dispatch in waves of at most 5: review and bank each PR as it lands (step 5), then dispatch the next batch into the freed slot. A 30-issue backlog runs as ~6 waves, not 30 simultaneous workers.

**Hold back blocked batches.** Don't dispatch a batch whose blocker (step 2) hasn't merged yet. If the blocker's PR is only ready (not merged) by the end of the run, surface the dependent as waiting on it (step 7) rather than working it against stale `main`.

The agent's final report is `dispatch-contract.md` §4 (Work-complete) or §5 (Need-input) - never a bare summary. On §5, decide from its `OPTIONS` and either re-dispatch (rework, step 6, with your decision as feedback) or, if you can't decide alone, park the batch and surface it at handoff (step 7). On §4 with no PR (blocked, an issue turned out closed, batch too large to keep reviewable), note it against those issues and move on - do not retry blindly. If it reports the batch was too large, re-split and re-dispatch.
```

- [ ] **Step 2: Add the acceptance-evidence check and learnings triage to step 5**

Find:

```markdown
Then record the verdict. The draft flag is the state; the comment is the rationale.
```

Replace with:

```markdown
Before judging the diff, check the worker's `ACCEPTANCE_CHECK` (§4 of `dispatch-contract.md`). If it's missing, vague, or doesn't actually support the `WORK_ACCEPTANCE`/`RESULT_ACCEPTANCE` you gave at dispatch, that's an automatic NEEDS WORK - route it into the rework loop (step 6) same as any other NEEDS WORK, under the same 2-round cap. Don't take a worker's word for "tests pass" without the evidence line; don't surface this to the human before the rework cap is hit.

**Learnings triage.** If the report includes `LEARNINGS`, decide per item: discard (noise) or keep (a durable gotcha or insight). For each kept item, pick a recommended destination - **CLAUDE.md** for a fact about the codebase any future contributor needs, **memory** for a fact about this session's preferences, corrections, or ephemeral project state. Present every kept item in one `AskUserQuestion` call (one question per item, options: your recommendation first, the other second - the tool's built-in "Other" covers a custom target like a docs file). On the human's answer, write it yourself: for `CLAUDE.md`, edit the file and commit directly to main (documentation about the codebase, not tracker/PR state, so it skips the PR flow - the human already approved content and destination); for memory or a custom target, use whatever mechanism that destination implies. `LEARNINGS` only exists in your session context for this run - if you don't triage it now, it's gone once the run ends.

Then record the verdict. The draft flag is the state; the comment is the rationale.
```

- [ ] **Step 3: Point step 6 (rework) at §2**

Find:

```markdown
### 6. Rework loop

If your verdict is NEEDS WORK, dispatch a fresh `issue-worker` in **rework mode** (the branch and worktree persist). Give it:

- The branch name and worktree path from step 4.
- Your specific feedback.
```

Replace with:

```markdown
### 6. Rework loop

If your verdict is NEEDS WORK, dispatch a fresh `issue-worker` in **rework mode** (the branch and worktree persist). Build the dispatch prompt per `dispatch-contract.md` §2 (Rework task): the branch name and worktree path from step 4, and your specific feedback (including, where relevant, the reason from an insufficient `ACCEPTANCE_CHECK`).
```

- [ ] **Step 4: Point step 8 (cleanup) at §3**

Find:

```markdown
  Then dispatch an `issue-worker` in **cleanup mode** with the branch and worktree path, or do it yourself: `git worktree remove <path>` from the main root, then `git worktree prune`. Never `rm -rf` a worktree.
```

Replace with:

```markdown
  Then dispatch an `issue-worker` in **cleanup mode** (dispatch prompt per `dispatch-contract.md` §3) with the branch and worktree path, or do it yourself: `git worktree remove <path>` from the main root, then `git worktree prune`. Never `rm -rf` a worktree.
```

- [ ] **Step 5: Add two rows to the Common Mistakes table**

Find:

```markdown
| "I'll dispatch all of these in parallel" | Check dependencies first. A dependent branched off `main` can't see its blocker's unmerged work - order the waves. |
```

Replace with:

```markdown
| "I'll dispatch all of these in parallel" | Check dependencies first. A dependent branched off `main` can't see its blocker's unmerged work - order the waves. |
| "The worker fetched the issue itself, so its numbers must be right" | You already fetched it in step 2 - the dispatch prompt carries that content forward per `dispatch-contract.md` §1. A worker re-fetching means the contract wasn't followed. |
| "It says tests pass, I'll mark it ready" | `ACCEPTANCE_CHECK` needs evidence (test output, a URL), not a restated claim. Missing or vague evidence is an automatic NEEDS WORK into the rework loop - not a pass. |
```

- [ ] **Step 6: Verify consistency**

Run:
```bash
grep -n 'dispatch-contract.md' skills/afk-issues/SKILL.md
```
Expected: 4 matches (steps 4, 5, 6, 8).

Run:
```bash
grep -c '^| "' skills/afk-issues/SKILL.md
```
Expected: 13 (11 existing rows + 2 new).

- [ ] **Step 7: Commit**

```bash
git add skills/afk-issues/SKILL.md
git commit -m "docs(afk-issues): dispatch, review, and rework via dispatch contract"
```

---

## Task 4: Point `grab-issue/SKILL.md` at the contract

**Files:**
- Modify: `skills/grab-issue/SKILL.md`

**Interfaces:**
- Consumes: `dispatch-contract.md` §1-§5 (Task 1).

- [ ] **Step 1: Rewrite step 4 (Dispatch one issue-worker) to build the §1 prompt**

Find:

```markdown
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
```

Replace with:

```markdown
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
```

- [ ] **Step 2: Point the rework/cleanup follow-up signals at §2/§3, and relay learnings**

Find:

```markdown
### 5. Hand back for review

Report to the user: the **draft** PR URL, branch name, worktree path, and the
worker's one-line summary of how it addressed the issue. Then stop. You do not
review it and you do not mark it ready - that is the user's call now.
```

Replace with:

```markdown
### 5. Hand back for review

Report to the user: the **draft** PR URL, branch name, worktree path, the
worker's one-line summary of how it addressed the issue, and its
`ACCEPTANCE_CHECK` evidence verbatim (so the user can see what the worker
claims to have verified, not just that it claims success). If the report
included `LEARNINGS`, relay it as-is - you don't triage it yourself; a human
is already in the room to judge what's worth keeping. Then stop. You do not
review it and you do not mark it ready - that is the user's call now.
```

Find:

```markdown
- **"pick it back up" / "rework it: <feedback>"**: dispatch an `issue-worker` in
  **rework mode** with the branch name, worktree path, and the user's feedback (or,
  for a human PR review left on the PR, point it at `gh pr view <url> --json
  reviews,comments`). It pushes to the same branch - never a second PR. Then hand
  back again.
- **"it's merged" / "clean up"**: dispatch an `issue-worker` in **cleanup mode**
  with the branch and worktree path (it runs `git worktree remove`, never
  `rm -rf`). In adapter mode, if the merge does not auto-close the item, ask the
  worker to also transition it to the adapter's *done* state.
```

Replace with:

```markdown
- **"pick it back up" / "rework it: <feedback>"**: dispatch an `issue-worker` in
  **rework mode** (dispatch prompt per `dispatch-contract.md` §2) with the branch
  name, worktree path, and the user's feedback (or, for a human PR review left on
  the PR, point it at `gh pr view <url> --json reviews,comments`). It pushes to
  the same branch - never a second PR. Then hand back again.
- **"it's merged" / "clean up"**: dispatch an `issue-worker` in **cleanup mode**
  (dispatch prompt per `dispatch-contract.md` §3) with the branch and worktree
  path (it runs `git worktree remove`, never `rm -rf`). In adapter mode, if the
  merge does not auto-close the item, ask the worker to also transition it to the
  adapter's *done* state.
```

- [ ] **Step 3: Add two rows to the Common Mistakes table**

Find:

```markdown
| "A quick state file will help me track this" | Never. The draft vs ready PR is the state. A file goes stale and lies. |
```

Replace with:

```markdown
| "A quick state file will help me track this" | Never. The draft vs ready PR is the state. A file goes stale and lies. |
| "The worker fetched the issue itself, so its numbers must be right" | You already fetched it in step 2 - the dispatch prompt carries that content forward per `dispatch-contract.md` §1. |
| "It says tests pass, I'll relay that as a pass" | Relay the `ACCEPTANCE_CHECK` evidence itself to the user, not your own gloss on it - they decide, you're supervised here. |
```

- [ ] **Step 4: Verify consistency**

Run:
```bash
grep -n 'dispatch-contract.md' skills/grab-issue/SKILL.md
```
Expected: 3 matches (step 4's dispatch, and the two follow-up signals for rework/cleanup).

Run:
```bash
grep -c '^| "' skills/grab-issue/SKILL.md
```
Expected: 7 (5 existing rows + 2 new).

- [ ] **Step 5: Commit**

```bash
git add skills/grab-issue/SKILL.md
git commit -m "docs(grab-issue): dispatch and rework via dispatch contract"
```

---

## Task 5: Bump plugin version

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: nothing from Tasks 1-4 beyond "the behaviour changed enough to warrant a minor version bump" (this repo's convention per its own commit history: a feature/behaviour change commit is followed by a separate `chore(plugin): bump version` commit).

- [ ] **Step 1: Bump `plugin.json`**

Find (in `.claude-plugin/plugin.json`):

```json
  "version": "0.4.0",
```

Replace with:

```json
  "version": "0.5.0",
```

- [ ] **Step 2: Bump `marketplace.json`**

Find (in `.claude-plugin/marketplace.json`):

```json
      "version": "0.4.0",
```

Replace with:

```json
      "version": "0.5.0",
```

- [ ] **Step 3: Verify both files are still valid JSON and agree**

Run:
```bash
jq -e '.version == "0.5.0"' .claude-plugin/plugin.json
jq -e '.plugins[0].version == "0.5.0"' .claude-plugin/marketplace.json
```
Expected: both print `true`.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore(plugin): bump version to 0.5.0 in marketplace and plugin files"
```

---

## Final check (run after all 5 tasks)

- [ ] Re-read `skills/afk-issues/SKILL.md`, `skills/grab-issue/SKILL.md`, and
  `agents/issue-worker.md` end to end. Confirm every dispatch/rework/cleanup
  step and every reporting section reads coherently with the new
  `dispatch-contract.md` pointers - no leftover references to the deleted
  "Fetch every issue" step, no orphaned step numbers.
- [ ] `grep -rn "Fetch every issue" .` returns nothing anywhere in the repo.
- [ ] `git log --oneline -6` shows five commits in the order: dispatch-contract
  doc, issue-worker, afk-issues SKILL.md, grab-issue SKILL.md, version bump.
