# Tracker reference: Jira (acli)

General `acli` mechanics behind each contract operation in
`../tracker-adapter.md`. A repo drives Jira by writing a short
`docs/agents/issue-tracker.md` **profile** that supplies the variables below and
points here for the commands - see the README example.

`acli` is authenticated as the current user (OAuth) and points at the instance.
Verify with `acli jira workitem view <KEY>` before relying on it.

## Profile variables (repo supplies)

The commands below use these placeholders. The repo profile fills them:

- `<INSTANCE>` - Jira Cloud site, e.g. `yourteam.atlassian.net`.
- `<PROJECT>` - project key, e.g. `PI`. Item keys are `<PROJECT>-<n>`.
- `<SCOPE>` - optional JQL fragment scoping items to this repo's work, e.g.
  `labels = development-metrics`. Omit if the whole project is in scope.
- **role -> status map** - Jira triage state is a workflow *status* (board
  column), not a label, and the column names are per-project workflow config.
  The profile provides the table mapping each role to this project's status name.

## Operations

| Operation | Command |
|---|---|
| List ready items | `acli jira workitem search --jql "project = <PROJECT> AND <SCOPE> AND status = '<ready-for-agent status>'" --json` |
| Get ticket comments | `acli jira workitem view <KEY> --fields comment --json` |
| The gate | status = the `ready-for-agent` status |
| View one item | `acli jira workitem view <KEY> --fields "*all" --json` |
| Dependencies | `is blocked by` / `blocks` issue links (in the item's link fields) |
| Verify actionable | status not in a `Done` category |
| On pickup -> in progress | `acli jira workitem transition --key <KEY> --status "<in-progress status>"` then `acli jira workitem assign --key <KEY> --assignee @me` |
| PR reference syntax | `<KEY>` in the PR **title** (e.g. `PI-1288: ...`) and body; no auto-close, so the title carries the link the tracker's VCS integration follows |
| Branch identifier | `<KEY>-<slug>` (e.g. `PI-1288-add-foo`) |
| On merge -> done | `acli jira workitem transition --key <KEY> --status "<done status>"` |
| Comment | `acli jira workitem comment create --key <KEY> --body "..."` (or `--body-file` for ADF) |
| Transition | `acli jira workitem transition --key <KEY> --status "<status>"` |

## Status names are exact

Status strings are case- and punctuation-exact: `Ready For Agent` (capital `F`),
`Won't Fix` (apostrophe), `Done (Complete)` (parenthesised). A mismatch fails
with "No allowed transitions found". Jira has no separate "close" - moving to a
`Done`-category status closes the item.

## Dependencies and links

Record real dependencies with `Blocks` links so blocked work isn't picked up
before its blocker clears:

```sh
# "PI-1288 blocks PI-1290" -> PI-1290 shows "is blocked by PI-1288"
acli jira workitem link create --in <blocker> --out <blocked> --type Blocks --yes
```

**`acli` reverses `--in`/`--out` for `Blocks`.** Despite the flag names, the
**blocker** goes in `--in` and the **blocked** item goes in `--out`. Getting this
backwards silently shows ready work as blocked and vice versa - always verify
after creating by viewing the *blocked* item and confirming it reads "is blocked
by" the right key:

```sh
acli jira workitem view <blocked> --fields issuelinks --json \
  | jq -r '.fields.issuelinks[] | select(.type.name=="Blocks") |
      if .inwardIssue then "\(.inwardIssue.key) blocks <blocked>"
      else "<blocked> blocks \(.outwardIssue.key)" end'
```

List an item's links with `acli jira workitem link list --key <KEY>`; see
relationship names with `acli jira workitem link type`. Encode only *hard*
blockers, and skip transitive links a chain already implies.

**External (GitHub) dependencies.** `acli` only links items *within* Jira - no
remote/web-link command, no raw REST. To record a dependency on a GitHub issue,
add a comment with the full URL stating the relationship and keep the item back
until the upstream work resolves.

## Bodies are ADF, not Markdown

Jira descriptions and comments are **ADF** (a JSON document tree). `acli` accepts
a body as plain text or ADF; anything else is stored verbatim, so `**bold**`,
`## heading`, `- bullet` and `| a | b |` render as those raw characters.

- A bare, unformatted one-liner can go through `--description "..."` / `--body
  "..."` as-is.
- **Any formatting** (headings, lists, bold, code, links, tables) must be ADF.

Recommended converter: the **`jira-adf` skill** (wraps
[marklassian](https://github.com/jamsinclair/marklassian)). Locate it by name (it
may be installed at project or user level; the path varies) and follow its
`SKILL.md` - author the body in Markdown, convert to an ADF JSON file, then pass
it to `acli`:

```sh
acli jira workitem edit --key <KEY> --description-file body.json --yes
acli jira workitem comment create --key <KEY> --body-file body.json
```

If `jira-adf` is not installed, fall back to plain-text bodies for unformatted
content, or hand-author the ADF JSON (`acli jira workitem edit --generate-json`
prints a skeleton). This is an optional dependency, not a hard one.
