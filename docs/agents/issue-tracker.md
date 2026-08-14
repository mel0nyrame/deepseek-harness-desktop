# Issue tracker: GitHub

English | [中文](issue-tracker.zh.md)

Issues and specs for this repository live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue:** `gh issue create --title "..." --body "..."`. Use a heredoc for multiline bodies.
- **Read an issue:** `gh issue view <number> --comments`, including its labels and relevant comments.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue:** `gh issue comment <number> --body "..."`.
- **Apply or remove labels:** `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue:** `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, external pull requests use the same triage labels and states as issues:

- **Read a pull request:** `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external pull requests:** use `gh pr list` and retain authors whose association is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment, label, or close:** use the corresponding `gh pr` commands.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `wayfinder` skill represents a work map as one issue and its tickets as child issues.

- **Map:** one issue labelled `wayfinder:map`, containing the Notes, Decisions-so-far, and Fog sections.
- **Child ticket:** an issue linked through GitHub sub-issues. When sub-issues are unavailable, add it to the map's task list and begin its body with `Part of #<map>`. Apply one `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking:** use GitHub native issue dependencies. When dependencies are unavailable, begin the child body with `Blocked by: #<n>, #<n>`.
- **Frontier:** inspect open map children in map order and select the first ticket with no open blocker or assignee.
- **Claim:** run `gh issue edit <number> --add-assignee @me` as the session's first write.
- **Resolve:** comment with the result, close the child, and add a concise result link to the map's Decisions-so-far section.
