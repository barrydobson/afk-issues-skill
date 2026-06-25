# Tracker adapter: pluggable issue source for afk-issues

## Problem

afk-issues hardcodes GitHub: `SKILL.md` and `issue-worker.md` bake in `gh`,
the `ready-for-agent` label, and `Closes #<n>` auto-close. The work source
cannot be anything else. We want Jira (and, in principle, any tracker) as the
source while still producing GitHub pull requests reviewed exactly as today.

Jira projects differ from each other (columns, statuses, mandatory labels,
JQL scoping), so the plugin must not encode "Jira" as a fixed shape.

## Approach

Treat the tracker as a **pluggable adapter the repo describes**. The plugin
defines an adapter *contract* (the operations it needs answered) and reads the
repo's adapter doc at runtime. No adapter doc = built-in GitHub behaviour.

Both the orchestrator and the worker do the same first move: check the repo for
an adapter doc; if present, follow it; otherwise fall back to the inline GitHub
defaults. The worker reads the repo's adapter doc itself - the same way it
already reads `CLAUDE.md` - so the orchestrator still hands over only issue
identifiers and a model, never the workflow.

This matches the convention already in use in `tote/platform-ex/dev-metrics`:
`docs/agents/issue-tracker.md` + `docs/agents/triage-labels.md` describe that
repo's Jira workflow.

### Discovery convention

- Adapter doc path: `docs/agents/issue-tracker.md` (with `triage-labels.md`
  alongside for the state map). Presence of `issue-tracker.md` switches the
  skill out of built-in GitHub mode.
- On start, both orchestrator and worker announce which tracker they resolved,
  once, like the existing superpowers-mode announcement. E.g. *"Adapter doc
  found - driving Jira via acli."* or *"No adapter doc - using built-in GitHub
  (gh)."*

GitHub stays the default and the reference adapter (its commands remain inline
in both files). Jira is simply "a repo whose adapter doc points at `acli`".

## The contract

New file `skills/afk-issues/tracker-adapter.md`. Authoring guidance for whoever
writes a repo's adapter doc; it names the operations afk-issues needs answered
and shows the GitHub default plus a Jira (dev-metrics) example for each.

| Operation | Used by | GitHub default | Jira (dev-metrics) example |
|---|---|---|---|
| List ready items | orchestrator (scope) | `gh issue list --label ready-for-agent --state open` | `acli jira workitem search --jql "project = PI AND labels = development-metrics AND status = 'Ready For Agent'"` |
| The gate | orchestrator | `ready-for-agent` label present | status = `Ready For Agent` |
| View one item | both | `gh issue view <n> --json ...` | `acli jira workitem view <KEY> --fields "*all"` |
| Verify actionable | worker | issue state is OPEN | status not in a Done category |
| On pickup -> in progress | worker | none (no-op; open issue + draft PR is the signal) | transition to `In Progress` |
| PR reference syntax | worker | `Closes #<n>` in the body (auto-closes on merge) | `<KEY>` in the PR title (e.g. `PI-1288: ...`) and body; no auto-close, so the title carries the link |
| Branch identifier | worker | `issue-<n>-<slug>` | `<KEY>-<slug>` (e.g. `PI-1288-add-foo`) |
| On merge -> done | orchestrator (cleanup) | automatic via `Closes` | transition to `Done (Complete)` |

The repo's `docs/agents/issue-tracker.md` is the runtime artefact the agents
read; this contract doc exists so a human knows what their doc must cover.

## File changes

### `skills/afk-issues/SKILL.md`

- Step 1 gains a discovery preamble: look for the adapter doc, resolve the
  tracker, announce it once.
- "Gate: drop any issue lacking the `ready-for-agent` label" becomes "gate on
  the adapter's ready-for-agent state" (label for GitHub, status for Jira).
- List/view commands in steps 1-2 reference the adapter's operations rather
  than literal `gh` (GitHub commands shown as the default).
- Step 8 (merge cleanup) gains the on-merge Done transition for trackers whose
  adapter defines one; GitHub remains automatic via `Closes`.

### `agents/issue-worker.md`

- A discovery preamble mirroring the orchestrator's.
- Build mode parametrises fetch, actionable-check, branch identifier, and PR
  reference syntax on the adapter; GitHub commands stay inline as the default.
  For trackers without PR auto-close (e.g. Jira), the worker must put the item
  key in the PR title so the tracker's VCS integration links it.
- Build mode adds the on-pickup transition to In Progress (no-op for GitHub).
- Cleanup mode adds the on-merge Done transition where the adapter defines one.
- Rework mode never transitions (it only updates the existing branch/PR).

## Invariant changes

- *"State lives in GitHub, never on disk"* -> *"State lives in the system of
  record, never on disk."* Review state is still the GitHub PR draft/ready flag
  (unchanged). **Issue lifecycle** state lives in the tracker. Nothing on disk.
- New invariant: ticket transitions are owned. Worker does pickup -> In
  Progress; orchestrator does merge -> Done. Rework never re-transitions.

The bounded-loop, one-PR-per-batch, one-worktree-per-batch, and draft=unreviewed
invariants are unchanged.

## Out of scope

- No invocation flag, no autodetect of the tracker.
- No shipped Jira adapter doc and no `acli`/MCP wrapper in the plugin.
- No change to the GitHub review/CI flow.

## Mechanical follow-ups

- Bump `version` in `.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` together.
- Update the project `CLAUDE.md` (architecture + invariants sections) and the
  "Common Mistakes" / conventions where tracker-specific wording appears.
- British English, conventional commit prefixes.
