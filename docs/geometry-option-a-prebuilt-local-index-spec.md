# Geometry Source Spec — Option A: Prebuilt Local Geometry Index

## Goal
Replace live Overpass usage in the normal runtime path with a **prebuilt local circuit geometry dataset** shipped with the app.

The dataset should contain:
- cleaned circuit geometry
- layout variants where available
- stable layout names
- enough metadata for rendering and export

The app should use this local geometry dataset as the **primary geometry source**.

Overpass or other live OSM access may remain as:
- a build-time source
- a manual refresh source
- a fallback for tracks not yet included

But **normal user interaction should not depend on live Overpass**.

---

# Why this option exists

## Problem with live Overpass
Public Overpass is useful for exploration, but poor as a primary production dependency because:
- requests time out unpredictably
- public mirrors differ in reliability
- latency is inconsistent
- rate limits and transient failures affect UX

## Why this option is attractive
The racetrack domain is relatively bounded.
A prebuilt geometry dataset gives:
- deterministic results
- lower latency
- consistent layout naming
- no runtime dependency on public Overpass

This matches the local-search-index direction already adopted for search.

---

# High-level architecture

## Build-time pipeline
1. start with the shipped track search index
2. select track items to include in geometry generation
3. fetch source geometry using OSM/Overpass during a build script
4. run the existing geometry/layout extraction pipeline offline
5. validate and normalize layout outputs
6. write a generated static geometry dataset into the repo/app

## Runtime pipeline
1. search finds a track from the local search index
2. geometry lookup reads the local geometry dataset
3. the app loads layouts directly from local generated data
4. preview/export runs without live Overpass

---

# Scope

## Primary scope
This option is intended to cover:
- known racetracks already in the local search index
- especially high-value/popular tracks
- current F1 and other commonly requested circuits first

## Recommended rollout strategy
Implement in phases:

### Phase 1
Ship a curated set of high-value tracks, e.g.:
- current F1
- major endurance circuits
- a few well-known historical/club circuits used for testing

### Phase 2
Expand toward broader catalog coverage.

### Phase 3
Use fallback logic for tracks not yet prebuilt.

---

# Required build artifact

## Generated dataset
Create a generated file, for example:
- `src/generated/track-geometry-index.json`

Or a directory form if splitting is needed, for example:
- `src/generated/track-geometry/<id>.json`

The exact file layout is flexible, but the artifact must be:
- reproducible
- versioned intentionally
- usable directly by the frontend runtime

---

# Dataset schema

## Top-level keying
Each track entry should be keyed by a stable identifier.

Preferred options:
- `wikidataId`
- or a stable generated track id already used elsewhere in the app

## Required per-track fields
Each geometry entry should contain:

```json
{
  "trackId": "Q171332",
  "name": "Bahrain International Circuit",
  "source": {
    "kind": "osm-prebuilt",
    "generatedAt": "2026-03-30T12:00:00Z",
    "osmQueryVersion": 1
  },
  "center": {
    "lat": 26.0325,
    "lon": 50.5106
  },
  "layouts": [
    {
      "id": "grand-prix-circuit",
      "name": "Grand Prix Circuit",
      "nodes": [
        { "lat": 26.0, "lon": 50.5 },
        { "lat": 26.0, "lon": 50.5 }
      ],
      "stats": {
        "lengthMetres": 5412.3,
        "segmentCount": 4,
        "variantSectionCount": 0
      }
    }
  ]
}
```

## Required layout fields
Each layout must include:
- stable `id`
- display `name`
- `nodes[]`
- `stats.lengthMetres`
- `stats.segmentCount`
- `stats.variantSectionCount`

## Optional metadata
Optional but useful:
- source OSM way/relation ids
- naming provenance
- confidence score
- canonical/derived flags

---

# Build-time source of truth

## Input source
The build step may still use live OSM/Overpass to construct the prebuilt dataset.

That is acceptable because the reliability problem is at **runtime**, not necessarily at build time.

## Important separation
This option does **not** require solving the build source problem first.
The requirement is only that runtime no longer depends on Overpass.

---

# Build-time generation flow

## Step 1 — Enumerate tracks to build
Use the local search index or a curated track list as the input universe.

## Step 2 — Resolve source geometry
For each track:
- fetch candidate OSM geometry
- use the existing extraction logic
- build candidate layouts

## Step 3 — Normalize layout outputs
Ensure layouts are:
- named sensibly
- deduped
- closed where expected
- sorted in a deterministic order

## Step 4 — Validate
Reject or flag tracks where:
- no usable geometry is found
- extracted layouts are malformed
- layout lengths are implausible
- geometry is too incomplete for shipping

## Step 5 — Write generated artifact
Persist the cleaned geometry dataset into a generated file or files.

---

# Validation rules

## Required validations
At build time, validate that each layout:
- has at least 2 nodes
- has finite coordinates
- has a positive length
- has a sane length for a circuit layout
- is deterministic across repeated generation runs where practical

## Recommended validations
- ensure loop-like circuits are actually closed or closeable
- reject tiny fragments masquerading as layouts
- reject duplicate/near-duplicate layouts unless intentionally distinct
- ensure layout names are meaningful and not generic noise

## Track-level validation report
The build script should emit a summary report showing:
- built successfully
- skipped
- flagged for manual review
- failed

---

# Runtime behavior

## Primary lookup behavior
At runtime, geometry should be looked up locally by track id.

## Required behavior
If local geometry exists:
- use it directly
- do not hit Overpass

## Fallback behavior
If local geometry does not exist, one of these strategies may be used:
- return a clean “geometry unavailable” error
- optionally use live Overpass as a fallback

This choice can be phased in later.

---

# Caching and bundling strategy

## Small dataset strategy
If the generated geometry dataset remains reasonably small, shipping one static JSON file is acceptable.

## Larger dataset strategy
If bundle size becomes too large, split by track or category and lazy-load per selected track.

### Recommended evolution path
Start with one generated file if simple.
Later evolve to per-track chunks if size becomes problematic.

---

# Determinism requirements

The build should be as deterministic as possible.

## Required
- stable layout ordering
- stable naming where source data has not changed
- stable generated ids

## Recommended
- avoid nondeterministic object ordering
- sort emitted entries consistently

---

# Update workflow

## Required script
Create a build/update script, for example:
- `scripts/build-track-geometry-index.mjs`

## Supported modes
Recommended modes:
- full rebuild
- single-track rebuild
- validate-only mode

Example concepts:
- `npm run build:geometry-index`
- `npm run build:geometry-index -- --track Q171332`
- `npm run validate:geometry-index`

---

# Testing requirements

## Build-time tests
Test the generator on known tricky circuits.

## Runtime tests
Ensure local geometry loading returns the same shape expected by the rest of the app.

## Regression set
At minimum, cover:
- Bahrain
- Brands Hatch
- Le Mans
- Monaco
- Mexico City
- Spa
- Silverstone
- Zandvoort

---

# Benefits

## Main benefits
- no runtime Overpass dependency for covered tracks
- better performance
- deterministic layouts
- easier debugging and regression testing

## Product benefit
The app becomes much more reliable for repeated use and demos.

---

# Tradeoffs

## Costs
- more generated data in repo or build output
- maintenance of a generation script
- periodic rebuilds when OSM changes

## Acceptable tradeoff
For this project, that tradeoff is likely worth it because the track set is bounded and geometry correctness matters more than fully live OSM freshness.

---

# Non-goals

This option does **not** require:
- self-hosting Overpass
- downloading whole regional extracts
- a server backend
- support for arbitrary unknown OSM tracks on day one

---

# Recommended first implementation

1. Build a geometry-index generator using the current extraction logic.
2. Prebuild only the current F1 set first.
3. Ship generated local geometry for those tracks.
4. Use local geometry preferentially at runtime.
5. Keep Overpass only as an optional fallback for uncached tracks.
6. Expand coverage iteratively.

This provides a strong reliability win with manageable implementation complexity.