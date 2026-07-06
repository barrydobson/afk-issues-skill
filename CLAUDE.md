# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin, not an application. It is almost entirely prose: markdown instruction files plus three JSON manifests, validated by reading rather than running. The one exception is `scripts/` - a couple of git-plumbing helpers the worker invokes. Mechanical checks: the JSON stays well-formed, the frontmatter stays valid, and the scripts stay `shellcheck`/`shfmt` clean.

```
skills/afk-issues/SKILL.md   the orchestrator's instructions (skill `afk-issues:afk-issues`)
skills/grab-issue/SKILL.md    single-issue supervised front-door (skill `afk-issues:grab-issue`)
agents/issue-worker.md        the worker's instructions (subagent_type `issue-worker`)
skills/afk-issues/tracker-adapter.md  the abstract tracker contract + which reference implements it
skills/afk-issues/references/github.md  built-in GitHub (gh) tracker mechanics
skills/afk-issues/references/jira.md   Jira (acli) tracker mechanics, placeholders for the repo profile
skills/afk-issues/references/pr-review.md  the shared PR review cycle both front-doors run
scripts/new-worktree.sh       create/reattach a batch worktree, ignored locally
scripts/remove-worktree.sh    remove a worktree from the main checkout (cleanup)
.claude-plugin/plugin.json    plugin manifest
.claude-plugin/marketplace.json  self-marketplace (this repo installs itself)
```

Worker Bash calls reach these via `${CLAUDE_PLUGIN_ROOT}/scripts/...`, which resolves to the plugin's install dir regardless of the worker's cwd (it runs in the target repo). They are the git fallback - a native worktree tool, if present, is still preferred.

## Architecture: manager / worker split

The whole design is one rule - **the orchestrator never writes code, the worker never makes scope decisions.** Keep edits on the correct side of that line.

- `SKILL.md` is the **manager**: resolve scope, gate the `ready-for-agent` label, group issues into batches, pick a model per batch, dispatch one `issue-worker` per batch, review each resulting PR, loop. It dispatches via the Agent/Task tool with `subagent_type: issue-worker`.
- `issue-worker.md` is the **worker**: gate-trusting, it isolates a git worktree, implements the batch, pushes, and opens **one draft PR** closing every issue in the batch. Has three modes - build, rework, cleanup - selected from what the dispatch prompt provides.

`skills/grab-issue/SKILL.md` is a second, **supervised single-issue** front-door: it resolves and gates one issue, dispatches one `issue-worker` to build it, runs the same PR review cycle (`references/pr-review.md`) as `afk-issues` - marking a PASS ready, reworking a NEEDS WORK to the 2-round cap - then hands the PR back to the human for the merge. Same manager-side-of-the-line as `afk-issues` (it decides and dispatches, never codes), minus the batch loop and the autonomy.

When you change behaviour, decide first which file owns it. Workflow knowledge (how to worktree, how to PR) lives in the worker; what-to-work-on judgement lives in the orchestrator. Don't duplicate one into the other.

The tracker is pluggable. `skills/afk-issues/tracker-adapter.md` defines the
abstract contract; `references/github.md` and `references/jira.md` hold the
per-tracker mechanics (the actual `gh`/`acli` commands). A repo supplies a thin
`docs/agents/issue-tracker.md` **profile** that names a reference and fills its
project variables; with no profile the orchestrator and worker use the built-in
GitHub reference. Keep mechanics in the references and project variables in the
repo profile - don't restate one in the other. Worker owns pickup → in-progress;
orchestrator owns merge → done; rework never transitions.

## Invariants that must survive any edit

These are load-bearing. Breaking one quietly breaks the plugin's safety story.

- **State lives in the system of record, never on disk.** No state files. Draft vs ready PR status *is* the review state (always GitHub); issue lifecycle state lives in the tracker (GitHub issues, or whatever the repo's `docs/agents/issue-tracker.md` adapter describes). A resumed session reconstructs everything from those systems. Any edit that introduces a tracking file is wrong.
- **Draft = not yet reviewed, ready = passed.** Workers always open PRs `--draft`. Only the orchestrator marks ready (`gh pr ready`), and only after review. This is what stops a human merging unreviewed work.
- **Bounded loops.** Concurrency caps at 5 workers in flight; rework caps at 2 rounds per PR; CI is watched with one `timeout ... gh pr checks --watch` call (exit 124 = bail), never polled in a loop. These caps exist to bound token spend - don't relax them without saying why.
- **One PR per batch, one worktree per batch.** Rework pushes to the same branch (never a second PR). Cleanup uses `git worktree remove`, never `rm -rf`.

## Optional dependency posture

The skill checks at runtime whether two `superpowers` skills (`dispatching-parallel-agents`, `requesting-code-review`) are installed and announces which mode it's in. They are recommendations with built-in fallbacks, not hard dependencies - keep them that way. Any new external skill reference must degrade gracefully when absent.

## Conventions

- British English, conventional commit prefixes (the repo's own history uses `feat:`, `fix:`, `docs:`).
- The "Common Mistakes" table in `SKILL.md` is the canonical statement of the anti-patterns - when adding a rule, add the excuse/reality pair there rather than burying it in prose.
- `afk-issues@afk-issues` is `<plugin>@<marketplace>`; both are named `afk-issues`. Bump `version` in both `plugin.json` and `marketplace.json` together.
