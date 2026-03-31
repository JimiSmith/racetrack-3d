---
name: search-and-layout
description: Runtime geometry selection pipeline — how a track search turns into a ranked set of layouts for rendering. Use when working on src/search.js, src/layout-picker.js, layout ranking/deduplication, or fixing incorrect geometry selection for a specific venue. Triggers on tasks like "wrong layout selected", "fix layout ranking", "deduplicate layouts", "venue shows wrong circuit", or anything touching the runtime search and layout pipeline.
---

# Search and Layout

## Key files

- `src/search.js` — core runtime search and layout selection logic
- `src/search-index.js` — local track search index loader
- `src/geometry-index.js` — prebuilt geometry index loader (checked first)
- `src/layout-picker.js` — layout ranking and selection

## How it works

1. User searches → matched against local search index (Wikidata-backed, no live queries)
2. Geometry loaded from prebuilt index (`src/generated/track-geometry-index.json`) if available
3. If not in prebuilt index, falls back to live Overpass query
4. Layouts are ranked and deduplicated
5. Best layout selected; others remain available for the user to choose

## Layout ranking rules

- GP/main/primary named layouts beat rallycross/moto/inner/outer/alternate variants
- Relation names are preserved without clobbering member-way tags
- Named layouts that resolve to near-identical geometry are deduplicated (general dedup, not venue-specific)
- Tiny named OSM fragments no longer outrank real circuit components

## Hard rules

- **No source-specific cleanup here.** `src/search.js` must stay generic.
- **No Overpass-specific or OSM-API-specific normalization.** That belongs in the build script.
- **No runtime widening** of geometry based on source type.

## Known venue notes

- **Bahrain**: 5 layouts (Grand Prix, Endurance, Inner, Paddock, Outer). Inner Circuit ~2.569 km.
- **Brands Hatch**: 2 layouts (Grand Prix + Indy). General dedup prevents spurious duplicate.
- **Le Mans**: text rendering fixed; layout selection stable.

## Adding a regression fixture

When fixing a geometry selection bug for a specific venue, add a frozen fixture. See `.agents/skills/testing/SKILL.md`.
