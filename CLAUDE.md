# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code plugin, not an application. It is almost entirely prose: markdown instruction files plus three JSON manifests, validated by reading rather than running. The one exception is `scripts/` - a couple of git-plumbing helpers the worker and orchestrator invoke. Mechanical checks: the JSON stays well-formed, the frontmatter stays valid, and the scripts stay `shellcheck`/`shfmt` clean.

```
skills/afk-issues/SKILL.md   the orchestrator's instructions (skill `afk-issues:afk-issues`) - one issue or a whole backlog
agents/issue-worker.md        the worker's instructions (subagent_type `issue-worker`)
agents/pr-reviewer.md         the reviewer's instructions (subagent_type `pr-reviewer`), read-only
skills/afk-issues/tracker-adapter.md  the abstract tracker contract + which reference implements it
skills/afk-issues/references/github.md  built-in GitHub (gh) tracker mechanics
skills/afk-issues/references/jira.md   Jira (acli) tracker mechanics, placeholders for the repo profile
skills/afk-issues/references/pr-review.md  the review cycle every batch runs: CI watch, reviewer dispatch, verdict, PR creation/parking
skills/afk-spec/SKILL.md      the second orchestrator (skill `afk-spec:afk-spec`) - one written spec -> one open PR, wrapping superpowers' writing-plans + subagent-driven-development
scripts/new-worktree.sh       create/reattach a batch worktree, ignored locally
scripts/remove-worktree.sh    remove a worktree from the main checkout (cleanup)
scripts/review-package.sh     bundle a batch's diff into one file for the reviewer to read
.claude-plugin/plugin.json    plugin manifest
.claude-plugin/marketplace.json  self-marketplace (this repo installs itself)
```

Worker Bash calls reach these via `${CLAUDE_PLUGIN_ROOT}/scripts/...`, which resolves to the plugin's install dir regardless of the worker's cwd (it runs in the target repo). They are the git fallback - a native worktree tool, if present, is still preferred.

## Architecture: manager / worker / reviewer split

The whole design is one rule - **the orchestrator never writes code, the worker never makes scope decisions, and neither of them reads a diff with their own eyes.** Keep edits on the correct side of that line.

- `SKILL.md` is the **manager**: resolve scope, gate the `ready-for-agent` label, group issues into batches, pick a model per batch, dispatch one `issue-worker` per batch, dispatch one `pr-reviewer` per batch once CI is green, act on the verdict, loop. It dispatches via the Agent/Task tool with `subagent_type: issue-worker` / `subagent_type: pr-reviewer`. A single issue is just a batch of one - there is no separate supervised front-door; the same loop reports back as soon as that one batch's review lands.
- `issue-worker.md` is the **worker**: gate-trusting, it isolates a git worktree, implements the batch, and pushes. It never opens a PR. Has three modes - build, rework, cleanup - selected from what the dispatch prompt provides.
- `pr-reviewer.md` is the **reviewer**: read-only, dispatched fresh per batch once CI is green. Reads a diff package (never re-derives it with git commands, never crawls the wider codebase without a named reason), returns a spec-compliance + quality verdict. Never touches PR state - that decision belongs to the orchestrator once it has the verdict.

When you change behaviour, decide first which file owns it. Workflow knowledge (how to worktree, how to push) lives in the worker; how to judge a diff lives in the reviewer; what-to-work-on and when-to-open-a-PR judgement lives in the orchestrator. Don't duplicate one into another.

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

- **State lives in the system of record, never on disk.** No state files. A PR's existence and draft flag *is* the review state (always GitHub); issue lifecycle state lives in the tracker (GitHub issues, or whatever the repo's `docs/agents/issue-tracker.md` adapter describes). A resumed session reconstructs everything from those systems. Any edit that introduces a tracking file is wrong.
- **No PR until decided; no separate ready-flip, ever.** `issue-worker` never calls `gh pr create`. The orchestrator creates the PR itself, once, only after a `pr-reviewer` verdict of `APPROVED`, and opens it non-draft - there is no later `gh pr ready` call. This is deliberate, not a missing step: a PR opened only once approved never needs a ready-flip, which is exactly the "approving Claude's own pull request" pattern auto-mode's classifier blocks as self-approval. A draft PR only ever appears when a batch is being *parked* (CI stalled, or the rework cap was hit) - flagging a failure, never certifying a success, so it doesn't trip the same rule. Don't reintroduce a worker-opens-draft / orchestrator-marks-ready flow; that's the exact shape this design routes around.
- **Bounded loops.** Concurrency caps at 5 workers in flight; rework caps at 2 rounds per batch; CI is watched with one bounded `timeout ... gh run watch` call against the pushed branch (exit 124 = bail), never polled in a loop, and never via `gh pr checks` before a PR exists. These caps exist to bound token spend - don't relax them without saying why.
- **One PR per batch (at most), one worktree per batch.** Rework pushes to the same branch (never a second PR). Cleanup uses `git worktree remove`, never `rm -rf`.

## Optional dependency posture

The skill checks at runtime whether two `superpowers` skills (`dispatching-parallel-agents`, `requesting-code-review`) are installed and announces which mode it's in. They are recommendations with built-in fallbacks, not hard dependencies - keep them that way. Any new external skill reference must degrade gracefully when absent.

`afk-spec` is the deliberate exception to the optional-dependency posture above:
its two superpowers skills (`writing-plans`, `subagent-driven-development`) are
**hard** dependencies - it wraps them and has nothing to fall back to, so it
fails fast if they are absent rather than degrading.

## Conventions

- British English, conventional commit prefixes (the repo's own history uses `feat:`, `fix:`, `docs:`).
- The "Common Mistakes" table in `SKILL.md` is the canonical statement of the anti-patterns - when adding a rule, add the excuse/reality pair there rather than burying it in prose.
- `afk-issues@afk-issues` is `<plugin>@<marketplace>`; both are named `afk-issues`. Bump `version` in both `plugin.json` and `marketplace.json` together.
