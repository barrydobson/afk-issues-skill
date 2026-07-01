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

Every tracker must let an agent answer each operation below. This is the
abstract contract; the concrete commands live in the built-in reference for each
tracker (see next section).

| Operation | Used by |
|---|---|
| List ready items | orchestrator (scope) |
| The gate | orchestrator |
| View one item | both |
| Dependencies (blocks / blocked-by) | orchestrator (assess) |
| Verify actionable | worker |
| On pickup → in progress | worker |
| PR reference syntax | worker |
| Branch identifier | worker |
| On merge → done | orchestrator (cleanup) |

## Built-in references

The mechanics - the actual `gh` / `acli` commands for each operation - live in
this skill so a repo doesn't restate them:

- `references/github.md` - the built-in GitHub tracker (`gh`).
- `references/jira.md` - Jira via `acli`, written with placeholders.

A repo's `docs/agents/issue-tracker.md` is a thin **profile**: it names which
reference applies and supplies only the project variables that reference can't
know - for Jira that's the instance, project key, optional scope filter, and the
role→status map (workflow column names are per-project). For GitHub the profile
is usually unnecessary (the repo is inferred from the remote, and triage labels
equal the role names). See the README for an example profile of each.

To add a new tracker, add one `references/<tracker>.md` implementing the
contract; a repo then profiles against it the same way.

## Ownership of transitions

- The **worker** transitions an item to *in progress* on pickup (build mode
  only; never on rework).
- The **orchestrator** transitions an item to *done* on merge (cleanup).
- For GitHub both are automatic/implicit, so the worker and orchestrator do
  nothing extra.
