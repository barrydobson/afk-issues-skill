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
