# Skill: GitHub Issues

GitHub issues are the canonical backlog for this project. Use them consistently.

## Before starting work

Check open issues for anything related to your task:

```bash
gh issue list --repo JimiSmith/racetrack-3d --state open
```

If an issue exists for the work you're doing, reference it in your commit message and close it when done.

## Creating issues

When you identify a bug, limitation, or future improvement that is out of scope for the current task — create an issue rather than leaving a TODO comment or doing it inline.

```bash
gh issue create --title "Short descriptive title" --body "Context, observed behaviour, suggested fix"
```

Good issue bodies include:
- What the problem or feature is
- Where in the codebase it lives
- Any relevant context (venue names, Wikidata IDs, error messages)
- Suggested approach if known

## Closing issues in commits

Reference issues in commit messages to close them automatically:

```
fix: correct layout deduplication for overlapping geometry

Closes #12
```

## Grouping related issues

Prefer one issue per logical problem, not one issue per affected venue/case. Group related failures under a single issue with examples listed in the body.

## Repo

`JimiSmith/racetrack-3d` — always pass `--repo JimiSmith/racetrack-3d` if not inside the repo directory.
