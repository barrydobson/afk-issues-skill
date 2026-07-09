#!/usr/bin/env bash
# Bundle a batch's commit list, diffstat, and full diff into one file for a
# pr-reviewer subagent to read, instead of pasting the diff into its dispatch
# prompt. Prints the file's path on stdout. Run from the main checkout - a
# worker's worktree shares the same object store, so no fetch is needed.
set -euo pipefail

base="${1:?usage: review-package.sh <base-sha> <head-sha>}"
head="${2:?usage: review-package.sh <base-sha> <head-sha>}"

out="$(mktemp -t afk-review-XXXXXX)"

{
  echo "## Commits"
  git log --oneline "$base..$head"
  echo
  echo "## Diffstat"
  git diff --stat "$base..$head"
  echo
  echo "## Diff"
  git diff -U10 "$base..$head"
} >"$out"

echo "$out"
