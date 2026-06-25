# Tracker Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make afk-issues source work from any tracker the repo describes via an adapter doc, defaulting to GitHub, while still producing GitHub PRs reviewed exactly as today.

**Architecture:** The plugin defines an adapter *contract* (operations it needs) in a new reference doc. At runtime the orchestrator (`SKILL.md`) and worker (`issue-worker.md`) each look for the repo's `docs/agents/issue-tracker.md`; if present they follow it, otherwise they use the inline GitHub defaults. The worker reads the repo's adapter doc itself, so the manager/worker split is untouched.

**Tech Stack:** Markdown prose (skill + agent instructions), JSON manifests. No build/test toolchain - this is a Claude Code plugin. Verification is JSON parsing, frontmatter validity, and re-reading prose against the plugin's invariants.

## Global Constraints

- British English; conventional commit prefixes (`feat:`, `fix:`, `docs:`).
- Manager/worker split is load-bearing: orchestrator never writes code, worker never makes scope decisions. Workflow knowledge lives in the worker; what-to-work-on judgement in the orchestrator. Do not duplicate one into the other.
- State lives in the system of record (GitHub PR draft/ready for review state; the tracker for issue lifecycle), never on disk. No state files.
- GitHub stays the default and reference adapter; its commands remain inline in both files. No invocation flag, no autodetect, no shipped Jira adapter, no `acli`/MCP wrapper.
- Draft = unreviewed, ready = passed. Bounded loops (5 workers, 2 rework rounds, single CI watch). One PR per batch, one worktree per batch. All unchanged.
- Adapter doc path convention: `docs/agents/issue-tracker.md` (+ `docs/agents/triage-labels.md` for the state map).
- Spec: `docs/superpowers/specs/2026-06-25-tracker-adapter-design.md`.

---

### Task 1: Adapter contract reference doc

Defines what a repo's adapter doc must answer. Shared vocabulary the other tasks point at. Self-contained, no dependencies.

**Files:**
- Create: `skills/afk-issues/tracker-adapter.md`

**Interfaces:**
- Produces: the operation names later tasks reference - *list ready items*, *the gate*, *view one item*, *verify actionable*, *on pickup → in progress*, *PR reference syntax*, *branch identifier*, *on merge → done*. Tasks 2 and 3 must use these exact names.

- [ ] **Step 1: Write the contract doc**

Create `skills/afk-issues/tracker-adapter.md` with this exact content:

```markdown
# Tracker adapter

afk-issues sources work from a tracker. By default that tracker is GitHub and
the commands are baked into `SKILL.md` and `issue-worker.md`. To use a
different tracker (e.g. Jira), the **repo** describes it in an adapter doc and
both the orchestrator and the worker follow that instead of the GitHub
defaults.

## Discovery

- Adapter doc path: `docs/agents/issue-tracker.md`, with
  `docs/agents/triage-labels.md` alongside for the triage-state map.
- If `docs/agents/issue-tracker.md` exists, the skill is in **adapter mode** -
  follow it. If it does not, the skill is in **built-in GitHub mode**.
- The orchestrator and the worker each resolve this independently and announce
  it once at start, e.g. *"Adapter doc found - driving Jira via acli."* or
  *"No adapter doc - using built-in GitHub (gh)."*

## The contract

A repo's adapter doc must let an agent answer each operation below. The GitHub
column is the built-in default; the Jira column shows the convention used in
`tote/platform-ex/dev-metrics` as a worked example.

| Operation | Used by | GitHub default | Jira example |
|---|---|---|---|
| List ready items | orchestrator (scope) | `gh issue list --label ready-for-agent --state open --json number,title,labels` | `acli jira workitem search --jql "project = PI AND labels = development-metrics AND status = 'Ready For Agent'" --json` |
| The gate | orchestrator | `ready-for-agent` label present | status = `Ready For Agent` |
| View one item | both | `gh issue view <n> --json number,title,body,labels,state,url,comments` | `acli jira workitem view <KEY> --fields "*all" --json` |
| Verify actionable | worker | issue state is `OPEN` | status not in a `Done` category |
| On pickup → in progress | worker | none (no-op; an open issue plus a draft PR is the signal) | `acli jira workitem transition --key <KEY> --status "In Progress"` |
| PR reference syntax | worker | `Closes #<n>` in the body (auto-closes on merge) | `<KEY>` in the PR **title** (e.g. `PI-1288: ...`) and body; no auto-close, so the title carries the link the tracker's VCS integration follows |
| Branch identifier | worker | `issue-<n>-<slug>` | `<KEY>-<slug>` (e.g. `PI-1288-add-foo`) |
| On merge → done | orchestrator (cleanup) | automatic via `Closes` | `acli jira workitem transition --key <KEY> --status "Done (Complete)"` |

The repo's adapter doc is the runtime artefact the agents read. This file
exists so a human knows what their adapter doc must cover.

## Ownership of transitions

- The **worker** transitions an item to *in progress* on pickup (build mode
  only; never on rework).
- The **orchestrator** transitions an item to *done* on merge (cleanup).
- For GitHub both are automatic/implicit, so the worker and orchestrator do
  nothing extra.
```

- [ ] **Step 2: Verify frontmatter-free reference doc renders and contains every operation**

Run:
```bash
cd skills/afk-issues
grep -c -e "List ready items" -e "The gate" -e "View one item" -e "Verify actionable" -e "On pickup" -e "PR reference syntax" -e "Branch identifier" -e "On merge" tracker-adapter.md
```
Expected: `8` (one line per operation).

- [ ] **Step 3: Commit**

```bash
git add skills/afk-issues/tracker-adapter.md
git commit -m "docs: add tracker adapter contract reference"
```

---

### Task 2: Make the orchestrator tracker-aware (`SKILL.md`)

**Files:**
- Modify: `skills/afk-issues/SKILL.md`

**Interfaces:**
- Consumes: operation names from Task 1 (*list ready items*, *the gate*, *on merge → done*).
- Produces: an orchestrator that resolves the tracker at scope time and gates/lists/closes via the adapter, GitHub as default.

- [ ] **Step 1: Add a discovery preamble to step 1 (Resolve scope)**

In `skills/afk-issues/SKILL.md`, at the very start of the `### 1. Resolve scope` section (before "Turn the instruction into a concrete list..."), insert:

```markdown
**First, resolve the tracker.** Look for `docs/agents/issue-tracker.md` in the
repo. If it exists, you are in **adapter mode** - that doc (and
`docs/agents/triage-labels.md`) defines the commands for listing, viewing,
gating, and transitioning items; follow it wherever this skill shows a `gh`
command. If it does not exist, use the built-in GitHub (`gh`) commands shown
below. Announce which mode you are in once, alongside the superpowers-mode
announcement, then go heads-down. The operations an adapter doc must cover are
listed in `tracker-adapter.md`.

```

- [ ] **Step 2: Generalise the gate wording**

In the same section, replace:

```markdown
Then **gate**: drop any issue lacking the `ready-for-agent` label - workers would refuse them anyway. List the dropped ones for the user.
```

with:

```markdown
Then **gate**: drop any item not in the adapter's `ready-for-agent` state - the
`ready-for-agent` label for GitHub, or the equivalent status the adapter
defines (e.g. a board column for Jira). Workers would refuse them anyway. List
the dropped ones for the user.
```

- [ ] **Step 3: Note the adapter on the list/view commands**

In `### 2. Assess and group`, replace the line:

```markdown
Read each issue (`gh issue view <n> --json number,title,body,labels,comments`). Decide batching:
```

with:

```markdown
Read each item (in adapter mode use the adapter's view command; the GitHub
default is `gh issue view <n> --json number,title,body,labels,comments`).
Decide batching:
```

- [ ] **Step 4: Add the on-merge Done transition to step 8**

In `### 8. Merge cleanup and human review feedback`, in the **"PR #N is merged" / "clean up merged PRs"** bullet, after the `git worktree remove ... git worktree prune` guidance, append:

```markdown

  In **adapter mode**, also transition the merged item to the adapter's *done*
  state if it does not close automatically (GitHub closes via `Closes #<n>`;
  Jira needs an explicit transition, e.g.
  `acli jira workitem transition --key <KEY> --status "Done (Complete)"`). Do
  this once per merged item, as part of cleanup.
```

- [ ] **Step 5: Verify the edits are present and coherent**

Run:
```bash
cd skills/afk-issues
grep -c "adapter mode" SKILL.md          # expect >= 3
grep -q "ready-for-agent state" SKILL.md && echo gate-ok
grep -q "issue-tracker.md" SKILL.md && echo discovery-ok
```
Expected: a number `>= 3`, then `gate-ok`, then `discovery-ok`.

Re-read the three edited sections: confirm GitHub commands still read as the default (no behaviour change when no adapter doc), and that nothing teaches the worker its workflow (scope/dispatch/review only).

- [ ] **Step 6: Commit**

```bash
git add skills/afk-issues/SKILL.md
git commit -m "feat: make afk-issues orchestrator tracker-aware"
```

---

### Task 3: Make the worker tracker-aware (`issue-worker.md`)

**Files:**
- Modify: `agents/issue-worker.md`

**Interfaces:**
- Consumes: operation names from Task 1 (*view one item*, *verify actionable*, *on pickup → in progress*, *PR reference syntax*, *branch identifier*, *on merge → done*).
- Produces: a worker that fetches/verifies/branches/links/transitions via the adapter, GitHub as default.

- [ ] **Step 1: Add a discovery preamble**

In `agents/issue-worker.md`, immediately after the intro paragraph ending "...make it structured and factual (see Reporting)." and before `## Modes`, insert:

```markdown
## Tracker

Before anything else, resolve the tracker. Look for `docs/agents/issue-tracker.md`
in the repo. If it exists, you are in **adapter mode** - that doc (and
`docs/agents/triage-labels.md`) defines how to view items, check they are
actionable, transition them, name your branch, and reference them from the PR;
follow it wherever a `gh` command appears below. If it does not exist, use the
built-in GitHub (`gh`) commands shown. State which mode you resolved in your
report. The operations an adapter doc covers are listed in the plugin's
`tracker-adapter.md`.
```

- [ ] **Step 2: Generalise fetch and actionable-check (build mode step 1)**

Replace the `### 1. Fetch every issue in the batch` body:

```markdown
For each number: `gh issue view <n> --json number,title,body,labels,state,url,comments`.

If any issue is **not OPEN**, exclude it and note it in your report. If that leaves no open issues, stop and report - do nothing else. Take issue comments into account when implementing.
```

with:

```markdown
For each item, fetch it (GitHub default: `gh issue view <n> --json
number,title,body,labels,state,url,comments`; in adapter mode use the adapter's
view command).

If any item is **not actionable** (GitHub: state not `OPEN`; adapter: in a done
state per the adapter), exclude it and note it in your report. If that leaves
nothing actionable, stop and report - do nothing else. Take item comments into
account when implementing.

In adapter mode, transition each item you are picking up to the adapter's *in
progress* state now (GitHub has no such step - skip it).
```

- [ ] **Step 3: Generalise the branch identifier (build mode step 2)**

In `### 2. Create one isolated worktree for the whole batch`, replace:

```markdown
Pick a **primary** issue: the lowest number in the batch. Branch name is `issue-<primary>-<slug>`, where `<slug>` is the primary issue's title lowercased, non-alphanumerics replaced with `-`, trimmed to a few words.
```

with:

```markdown
Pick a **primary** item: the lowest issue number, or for an adapter the first
item key in the batch. The branch identifier follows the adapter (GitHub
default: `issue-<primary>-<slug>`; e.g. Jira: `<KEY>-<slug>`), where `<slug>`
is the primary item's title lowercased, non-alphanumerics replaced with `-`,
trimmed to a few words.
```

- [ ] **Step 4: Generalise the PR reference (build mode step 4)**

In `### 4. Push and open one PR`, replace the paragraph:

```markdown
Open the PR as **draft** - the orchestrator marks it ready once it passes review, so draft means "not yet reviewed". One `Closes #<n>` line **per issue** so the merge auto-closes all of them. Keep the body plain and factual - what the code does now, not the journey. Use the repo's PR template if one exists.
```

with:

```markdown
Open the PR as **draft** - the orchestrator marks it ready once it passes
review, so draft means "not yet reviewed". Reference every item so the merge
links/closes them: GitHub uses one `Closes #<n>` line **per issue** in the body
(auto-closes on merge); a tracker without auto-close (e.g. Jira) needs the item
key in the PR **title** (e.g. `PI-1288: ...`) so its VCS integration links the
PR, plus the key in the body. Keep the body plain and factual - what the code
does now, not the journey. Use the repo's PR template if one exists.
```

- [ ] **Step 5: Guard rework against transitions, add done to cleanup**

In `## Rework mode`, add a final bullet after item 4:

```markdown
5. Never transition the tracker item in rework - the pickup transition already
   happened in build mode, and *done* is the orchestrator's job at merge.
```

In `## Cleanup mode`, after the `git worktree prune` block, append:

```markdown
In adapter mode, if the orchestrator asks you to also close the tracker item,
transition it to the adapter's *done* state (e.g.
`acli jira workitem transition --key <KEY> --status "Done (Complete)"`). GitHub
closes automatically via the PR's `Closes` line - nothing to do.
```

- [ ] **Step 6: Update the Rules list**

In `## Rules`, replace:

```markdown
- One PR per batch, closing every issue in it. Never a second PR on rework.
```

with:

```markdown
- One PR per batch, referencing every item in it (GitHub `Closes #<n>`; otherwise the item key in the title). Never a second PR on rework.
```

And replace:

```markdown
- Don't re-gate labels (the orchestrator owns that); do verify issues are OPEN.
```

with:

```markdown
- Don't re-gate (the orchestrator owns the ready-for-agent gate); do verify items are actionable per the tracker.
```

- [ ] **Step 7: Verify the edits**

Run:
```bash
cd agents
grep -c "adapter mode" issue-worker.md     # expect >= 4
grep -q "in progress" issue-worker.md && echo pickup-ok
grep -q "PR \*\*title\*\*" issue-worker.md && echo title-ok
grep -q "Never transition the tracker item in rework" issue-worker.md && echo rework-ok
```
Expected: a number `>= 4`, then `pickup-ok`, `title-ok`, `rework-ok`.

Re-read build/rework/cleanup: confirm GitHub remains the no-config default and that the worker still makes no scope decisions.

- [ ] **Step 8: Commit**

```bash
git add agents/issue-worker.md
git commit -m "feat: make issue-worker tracker-aware"
```

---

### Task 4: Update project docs and bump version

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: behaviour established in Tasks 1-3.
- Produces: project docs and manifests consistent with tracker-agnostic behaviour.

- [ ] **Step 1: Update the project CLAUDE.md invariant**

In `CLAUDE.md`, replace the bullet:

```markdown
- **State lives in GitHub, never on disk.** No state files. Draft vs ready PR status *is* the review state; a resumed session reconstructs everything from `gh`. Any edit that introduces a tracking file is wrong.
```

with:

```markdown
- **State lives in the system of record, never on disk.** No state files. Draft vs ready PR status *is* the review state (always GitHub); issue lifecycle state lives in the tracker (GitHub issues, or whatever the repo's `docs/agents/issue-tracker.md` adapter describes). A resumed session reconstructs everything from those systems. Any edit that introduces a tracking file is wrong.
```

- [ ] **Step 2: Add a tracker-adapter note to CLAUDE.md architecture**

In `CLAUDE.md`, in the "## Architecture: manager / worker split" section, after the existing paragraph about workflow vs judgement, add:

```markdown
The tracker is pluggable. `skills/afk-issues/tracker-adapter.md` defines the
contract; a repo supplies `docs/agents/issue-tracker.md` to drive a non-GitHub
tracker (e.g. Jira via `acli`), and both the orchestrator and worker fall back
to inline GitHub commands when no adapter doc is present. Worker owns pickup →
in-progress; orchestrator owns merge → done; rework never transitions.
```

- [ ] **Step 3: Update the file map in CLAUDE.md**

In the code block under "## What this is", add a line after the `agents/issue-worker.md` line:

```
skills/afk-issues/tracker-adapter.md  the tracker adapter contract (GitHub default + Jira example)
```

- [ ] **Step 4: Bump versions and broaden the descriptions**

In `.claude-plugin/plugin.json`: set `"version"` to `"0.2.0"` and change `"description"` to:

```
"Autonomously work a batch of tracker issues to reviewed GitHub pull requests. GitHub by default; pluggable to Jira and others via a repo adapter doc. Orchestrator skill plus the issue-worker agent it dispatches."
```

In `.claude-plugin/marketplace.json`: set the plugin entry's `"version"` to `"0.2.0"` and change its `"description"` to the same string as above.

- [ ] **Step 5: Verify JSON is well-formed and versions match**

Run:
```bash
python3 -m json.tool .claude-plugin/plugin.json > /dev/null && echo plugin-json-ok
python3 -m json.tool .claude-plugin/marketplace.json > /dev/null && echo marketplace-json-ok
grep -h '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json
```
Expected: `plugin-json-ok`, `marketplace-json-ok`, and both version lines showing `0.2.0`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "docs: document tracker adapter and bump to 0.2.0"
```

---

## Self-Review

**Spec coverage:**
- Discovery convention (adapter doc path, announcement) → Task 1 step 1, Task 2 step 1, Task 3 step 1. ✓
- Contract table → Task 1. ✓
- SKILL.md changes (gate, list/view, step 8 done) → Task 2. ✓
- issue-worker.md changes (fetch/verify/branch/PR-ref, pickup transition, rework no-transition, cleanup done) → Task 3. ✓
- PR title carries the key → Task 3 steps 4 & 6. ✓
- Invariant rewording + transition ownership → Task 4 steps 1-2, Task 1 ownership section. ✓
- Version bump together → Task 4 step 4. ✓

**Placeholder scan:** No TBD/TODO; every edit shows exact old→new text and exact commands. ✓

**Type/name consistency:** Operation names (*list ready items*, *the gate*, *view one item*, *verify actionable*, *on pickup → in progress*, *PR reference syntax*, *branch identifier*, *on merge → done*) and mode names (*adapter mode*, *built-in GitHub mode*) are used identically across Tasks 1-4. ✓
