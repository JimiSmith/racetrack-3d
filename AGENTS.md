# AGENTS.md

**racetrack-3d** — a web app that renders 3D printable F1/motorsport circuit models from OpenStreetMap geometry.

## Before every task

- Run `npm test` and `npm run build` before committing. Both must pass.
- Always push to `origin/main` after committing.
- Check open GitHub issues before starting work. See `.agents/skills/github-issues.md`.

## Hard rules

- Never add source-specific or Overpass-specific cleanup to `src/search.js`. Runtime logic stays generic.
- Runtime must never query Overpass or raw OSM for tracks covered by the prebuilt geometry index.
- `.cache/` must never be committed.
- `scripts/run-logs/` must never be committed.

## Skills

Read the relevant skill before working in that area:

- `.agents/skills/geometry-pipeline/SKILL.md` — build-time geometry index (OSM API, staleness, build script)
- `.agents/skills/search-and-layout/SKILL.md` — runtime geometry selection and layout ranking
- `.agents/skills/testing/SKILL.md` — test framework, frozen fixtures, adding regression tests
- `.agents/skills/export/SKILL.md` — STL and 3MF export pipeline
- `.agents/skills/github-issues/SKILL.md` — how to use GitHub issues as the project backlog
