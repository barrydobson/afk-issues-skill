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

The skill is self-contained but works better alongside two [superpowers](https://github.com/obra/superpowers) skills. It checks for them on start, tells you which mode it's in, and falls back when they're absent:

- `superpowers:dispatching-parallel-agents` - disciplined fan-out of workers.
- `superpowers:requesting-code-review` - a deeper review pass for risky changes.

## Install

This repo is its own marketplace (see `.claude-plugin/marketplace.json`), so add it then install:

```bash
# From a git URL
/plugin marketplace add barrydobson/afk-issues-skill
# ...or from a local clone
/plugin marketplace add ./afk-issues-skill

/plugin install afk-issues@afk-issues
```

`afk-issues@afk-issues` is `<plugin>@<marketplace>` - both are named `afk-issues` here.

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
