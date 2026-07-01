# afk-issues

A Claude Code plugin that works through a batch of GitHub issues to reviewed pull requests, unsupervised.

You give it a list of issues (or a query like "everything labelled bug"). It scopes and groups the work, dispatches a worker per batch into isolated git worktrees, reviews each resulting PR against the original issue, reworks what falls short, and hands you back a tidy list of PRs that are ready to merge.

## What's inside

| Path | Purpose |
|------|---------|
| `skills/afk-issues/SKILL.md` | The orchestrator. Scopes, groups, dispatches, reviews, loops. Does **not** write code itself. |
| `agents/issue-worker.md` | The worker the orchestrator dispatches. Carries one or more issues to a single draft PR in its own worktree; also handles rework and worktree cleanup. |

Once the plugin is installed, Claude Code discovers both automatically - the skill as `afk-issues:afk-issues` and the agent as the `issue-worker` subagent type.

## Requirements

- The current directory is the target repo, with `gh` authenticated.
- Issues must carry the `ready-for-agent` label - the orchestrator gates on it and workers refuse anything without it.

### Optional

The skill is self-contained but works better with two superpowers skills - see [Recommended: superpowers](#recommended-superpowers) below.

## Install

This repo is its own marketplace (see `.claude-plugin/marketplace.json`), so add it then install:

```bash
/plugin marketplace add barrydobson/afk-issues-skill
/plugin install afk-issues@afk-issues
```

`afk-issues@afk-issues` is `<plugin>@<marketplace>` - both are named `afk-issues` here.

## Recommended: superpowers

This plugin runs fine on its own, but two skills from the [superpowers](https://github.com/obra/superpowers) plugin sharpen it. On start the orchestrator checks whether they're installed, tells you which mode it's in, and falls back gracefully when they're absent - so they're a recommendation, not a hard dependency.

| Skill | What it adds | Fallback when absent |
|-------|--------------|----------------------|
| `superpowers:dispatching-parallel-agents` | Disciplined fan-out when dispatching worker batches. | Built-in parallel dispatch, capped at 5 workers in waves. |
| `superpowers:requesting-code-review` | A deeper review pass for risky PRs. | The orchestrator's own quick review, with the risk flagged to you at handoff. |

Both ship in the **superpowers** plugin, which is its own marketplace. Install it the same way as this one:

```bash
/plugin marketplace add obra/superpowers
/plugin install superpowers@superpowers-dev
```

(The marketplace is named `superpowers-dev`; the plugin is `superpowers`.) Once installed, this plugin picks them up automatically on the next run - no configuration needed.

## Issue trackers

GitHub is the default. To source work from another tracker (e.g. Jira), the repo
drops a short `docs/agents/issue-tracker.md` **profile**. The tracker mechanics
(the actual commands) live in the skill's `references/` - the profile only
supplies the project-specific variables. See `skills/afk-issues/tracker-adapter.md`
for the contract and `references/github.md` / `references/jira.md` for the
mechanics.

**GitHub** needs no profile - absence of `docs/agents/issue-tracker.md` selects
the built-in GitHub reference, and the repo is inferred from the git remote. A
profile is only worth writing to note something non-standard:

```markdown
# Issue tracker: GitHub

Mechanics: afk-issues skill `references/github.md`. Repo inferred from the remote.
Triage labels are the canonical five (`ready-for-agent`, etc.). Nothing to override.
```

**Jira** needs a profile supplying the instance, project key, optional scope
filter, and the role->status map (workflow column names are per-project):

```markdown
# Issue tracker: Jira

Mechanics: afk-issues skill `references/jira.md`. This file supplies the profile.

- instance: yourteam.atlassian.net
- project: PI                 (item keys are PI-<n>)
- scope: labels = development-metrics   (every item carries this; drop from JQL if whole project is in scope)
- PRDs are Epics; work items --parent'd to their PRD epic

## Role -> workflow status
| role            | status          |
| --------------- | --------------- |
| needs-triage    | Triage          |
| needs-info      | Needs Info      |
| ready-for-agent | Ready For Agent |
| ready-for-human | Ready For Human |
| wontfix         | Won't Fix       |
| (in progress)   | In Progress     |
| (done)          | Done (Complete) |

Statuses to avoid: Selected for Development, In Feedback, In Progress (Gate 3).
```

Formatted Jira bodies must be ADF - `references/jira.md` recommends the `jira-adf`
skill as converter, with a plain-text fallback when it's absent.

## Usage

Trigger it with the issues you want cleared:

```
/afk-issues 12 15 20
afk-issues work all issues labelled bug
afk all the ready-for-agent issues
clear the backlog while I'm away
```

It confirms the resolved list with you once, then goes heads-down. PRs land as **draft** and are marked **ready** only after passing the orchestrator's review - so you only ever merge work that's been checked.

## How it works

- **You're the manager, not the builder.** The skill scopes and reviews; the `issue-worker` agent does the implementation.
- **State lives in GitHub, never on disk.** A PR's draft/ready status *is* the review state, so a resumed session reconstructs everything from `gh`.
- **Bounded.** Concurrency caps at 5 workers in flight; rework caps at 2 rounds per PR before a PR is parked for a human. CI is watched once with a hard timeout rather than polled in a loop.

## Licence

[MIT](LICENSE) (c) 2026 Barry Dobson.
