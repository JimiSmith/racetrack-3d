---
name: geometry-pipeline
description: Build-time system that fetches OSM circuit geometry and stores it in per-track prebuilt files shipped with the app. Use when working on the geometry build pipeline, OSM fetch helper, or the generated geometry artifacts. Triggers on tasks like "rebuild geometry", "update a track's geometry", "fix OSM fetch", "add a track to the index", or anything touching utils/geometry-import/.
---

# Geometry Pipeline

## Key files

- `utils/geometry-import/main.ts` — entry point that dispatches to subcommands
- `utils/geometry-import/commands/import-osm-data.ts` — fetches raw OSM ways per track
- `utils/geometry-import/commands/find-loops.ts` — detects closed loops in the fetched ways
- `utils/geometry-import/commands/create-track-geometry.ts` — stitches layout files into the runtime artifacts
- `utils/geometry-import/lib/osm-fetch.ts` — OSM API fetch helper with rate-limit handling and retry
- `src/generated/geometry/ways/<wikidataId>.json` — raw OSM ways per track
- `src/generated/geometry/loops/<wikidataId>.json` — detected loops
- `src/generated/geometry/layouts/<wikidataId>.json` — hand-authored layout definitions
- `src/generated/geometry/<wikidataId>.json` — runtime artifact consumed by the app
- `src/search/geometry-index.ts` — runtime loader (fetches the top-level per-track file)

## Pipeline stages

Three commands, run in order, each consuming the previous stage's output:

```bash
npm run geometry:import -- import-osm-data        # -> ways/<id>.json
npm run geometry:import -- find-loops             # -> loops/<id>.json
npm run geometry:import -- create-track-geometry  # -> <id>.json (runtime)
```

Each command accepts `--track <wikidataId>` (repeatable) to limit to specific tracks, and `--help` for full options.

## Runtime contract

The runtime only reads `src/generated/geometry/<wikidataId>.json`. The `ways/`, `loops/`, and `layouts/` subdirectories are build-time inputs to `create-track-geometry` and are also consumed by the layout editor (`src/layout-editor/entry.ts`). Source-specific cleanup and normalization belongs in the import pipeline — never in `src/search.js`.

## Layouts

Layout files under `src/generated/geometry/layouts/` are hand-authored (via the layout editor) and reference which loop ways form each named layout (Grand Prix, National, etc.). `create-track-geometry` stitches those way references into the runtime geometry.
