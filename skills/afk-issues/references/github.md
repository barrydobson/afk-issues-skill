# Tracker reference: GitHub (gh)

The built-in tracker. This file is the mechanics - the `gh` commands behind each
contract operation in `../tracker-adapter.md`. A repo using GitHub needs **no
adapter doc**: absence of `docs/agents/issue-tracker.md` selects this reference
automatically. A repo that wants to note anything non-standard (e.g. a different
scope label) writes a short profile pointing here - see the README example.

`gh` infers the repo from `git remote -v` when run inside a clone, so no repo
argument is needed.

## Operations

| Operation | Command |
|---|---|
| List ready items | `gh issue list --label ready-for-agent --state open --json number,title,labels` |
| The gate | `ready-for-agent` label present |
| View one item | `gh issue view <n> --json number,title,body,labels,state,url,comments` |
| Dependencies | `Blocked by #<n>` / `Depends on #<n>` references in the issue body |
| Verify actionable | issue `state` is `OPEN` |
| On pickup -> in progress | none (no-op; an open issue plus a draft PR is the signal) |
| PR reference syntax | `Closes #<n>` in the PR body, one line per issue (auto-closes on merge) |
| Branch identifier | `issue-<n>-<slug>` |
| On merge -> done | automatic via `Closes #<n>` |
| Comment | `gh issue comment <n> --body "..."` |
| Triage label | `gh issue edit <n> --add-label "<label>" --remove-label "<old>"` |

## Triage roles

Triage state is a **label**; the label string equals the role name, so no
translation is needed.

| Role | Label |
|---|---|
| `needs-triage` | `needs-triage` |
| `needs-info` | `needs-info` |
| `ready-for-agent` | `ready-for-agent` |
| `ready-for-human` | `ready-for-human` |
| `wontfix` | `wontfix` |

## Bodies

`gh` bodies are Markdown - use `--body "..."`, or `--body-file` / a heredoc for
multi-line bodies. No conversion step.
