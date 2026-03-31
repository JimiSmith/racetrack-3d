# Skill: Search and Layout

Runtime geometry selection pipeline — how a track search turns into a ranked set of layouts.

## Key files

- `src/search.js` — core runtime search and layout selection logic
- `src/search-index.js` — local track search index loader
- `src/geometry-index.js` — prebuilt geometry index loader (checked first)
- `src/layout-picker.js` — layout ranking and selection

## How it works

1. User searches → matched against local search index (Wikidata-backed, no live queries)
2. For matched track, geometry is loaded from the prebuilt index (`src/generated/track-geometry-index.json`) if available
3. If not in the prebuilt index, falls back to live Overpass query
4. Layouts are ranked and deduplicated
5. Best layout is selected; others remain available for the user to choose

## Layout ranking rules

- GP/main/primary named layouts beat rallycross/moto/inner/outer/alternate variants
- Relation names are preserved without clobbering member-way tags
- Named layouts that resolve to near-identical geometry are deduplicated (general dedup, not venue-specific)
- Tiny named OSM fragments no longer outrank real circuit components

## Hard rules for this file

- **No source-specific cleanup here.** `src/search.js` must stay generic.
- **No Overpass-specific or OSM-API-specific normalization.** That belongs in the build script.
- **No runtime widening** of geometry based on source type.

## Known venue-specific notes

- **Bahrain**: 5 layouts exposed (Grand Prix, Endurance, Inner, Paddock, Outer). Inner Circuit is ~2.569 km.
- **Brands Hatch**: 2 layouts (Grand Prix + Indy). General dedup prevents the third spurious duplicate.
- **Le Mans**: text rendering fixed; layout selection is stable.

## Adding a new regression fixture

See `.agents/skills/testing.md`.
