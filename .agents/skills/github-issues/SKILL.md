---
name: github-issues
description: Use GitHub issues as the canonical backlog for racetrack-3d. Use when identifying a bug or improvement that is out of scope for the current task, before starting work (to check for existing issues), or when closing completed work. Triggers on tasks involving feature tracking, bug reporting, or backlog management.
---

# GitHub Issues

GitHub issues are the canonical backlog. Use them consistently.

## Before starting work

Check for existing issues related to the task:

```bash
gh issue list --repo JimiSmith/racetrack-3d --state open
```

Reference and close the issue in your commit message if one exists.

## Creating issues

When you identify a bug or improvement out of scope for the current task, create an issue rather than a TODO comment.

```bash
gh issue create --title "Short descriptive title" --body "Context, observed behaviour, suggested fix"
```

Good issue bodies include: what the problem is, where it lives in the codebase, relevant context (venue names, Wikidata IDs, error messages), and suggested approach if known.

## Closing issues in commits

```
fix: correct layout deduplication for overlapping geometry

Closes #12
```

## Grouping

Prefer one issue per logical problem. Group related failures (e.g. multiple affected venues) under a single issue with examples in the body.
