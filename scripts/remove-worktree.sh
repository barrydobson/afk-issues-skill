#!/usr/bin/env bash
# Remove a git worktree from the main checkout (never rm -rf). Safe to run from
# inside the worktree being removed - resolves the main root first - and a no-op
# if it is already gone. <worktree-path> is relative to the main root (as the
# dispatch contract passes it) or absolute. A dirty worktree makes `git worktree
# remove` refuse loudly rather than silently discarding work.
set -euo pipefail

path="${1:?usage: remove-worktree.sh <worktree-path>}"
main_root="$(git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel)"
cd "$main_root"

case "$path" in
/*) abs="$path" ;;
*) abs="$main_root/$path" ;;
esac

if git worktree list --porcelain | grep -qxF "worktree $abs"; then
  git worktree remove "$abs"
fi
git worktree prune
