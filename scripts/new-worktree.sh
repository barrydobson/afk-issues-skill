#!/usr/bin/env bash
# Create an isolated git worktree for a batch and print its path on stdout, so
# the caller can `cd "$(new-worktree.sh <branch>)"`. The worktree dir is ignored
# locally via info/exclude - never a committed .gitignore, which would leak into
# the PR diff and collide with other workers' parallel PRs. Handles build (new
# branch) and rework (existing branch), and is a no-op if the worktree is already
# on disk.
set -euo pipefail

branch="${1:?usage: new-worktree.sh <branch-name>}"
root=".worktrees"
path="$root/$branch"

git check-ignore -q "$root" ||
  echo "$root/" >>"$(git rev-parse --git-common-dir)/info/exclude"

if [ -d "$path" ]; then
  echo "$path"
  exit 0
fi

# Clear any stale registration for a worktree whose dir was deleted (the rework
# "if gone" case), otherwise `git worktree add` refuses the path.
git worktree prune

# git's own output goes to stderr so stdout carries only the path.
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$path" "$branch" >&2
else
  git worktree add "$path" -b "$branch" >&2
fi

echo "$path"
