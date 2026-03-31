# Geometry Source Spec — Option C: Local OSM Extract Processing Pipeline

## Goal
Replace runtime dependence on public Overpass by building a **local OSM extract processing pipeline** that derives circuit geometry from downloaded OSM data extracts.

This option moves geometry sourcing from:
- public Overpass queries at runtime

to:
- local extract ingestion
- local preprocessing
- generated geometry artifacts used by the app

---

# Why this option exists

## Problem with public Overpass
Public Overpass services are not ideal for a production-facing workflow because they can:
- timeout
- rate-limit
- differ between mirrors
- be slow or unavailable under load

## Why Option C is different from Option A
Option A changes the **runtime artifact** but may still use live Overpass at build time.

Option C changes the **data acquisition strategy itself**.
It replaces Overpass-style fetching with a local pipeline based on downloaded OSM extracts.

This gives more control and better repeatability, at the cost of more infrastructure and preprocessing complexity.

---

# High-level architecture

## Source layer
Download OSM extracts from sources such as:
- Geofabrik
- BBBike
- other regional extract providers

## Processing layer
Run local processing to:
- find raceway/circuit data
- resolve ways and relations
- reconstruct layouts
- validate geometry

## Output layer
Write the same kind of generated geometry artifact the app can use at runtime.

---

# Recommended source data providers

## Preferred providers
### Geofabrik
Best for continent/country/region extracts.

### BBBike
Useful for custom city/region extract generation.

## Important note
The exact provider is not critical as long as:
- data is reproducible
- updates are scriptable
- format is standard OSM/PBF/XML-compatible

---

# Input formats

## Supported source formats
The pipeline should support one or more of:
- `.osm.pbf`
- `.osm.bz2`
- `.osm`

## Preferred format
Prefer `.osm.pbf` because it is compact and standard for local processing.

---

# Geographic scope strategy

## Option 1 — Regional extracts
Download one or more country/region extracts covering the tracks of interest.

Examples:
- Europe extract for many circuits
- Bahrain / Gulf region extract
- Japan extract
- Australia extract
- Americas extracts as needed

## Option 2 — Curated multi-region set
Maintain a list of regions needed for supported circuits and download only those.

## Recommended approach
Use a curated region list aligned with the track catalog.
This keeps processing manageable while still avoiding live Overpass.

---

# Required output artifact

The final output should be the same kind of app-consumable geometry dataset described in Option A.

For example:
- `src/generated/geometry/<wikidataId>.json`
- or split per-track generated files

This means Option C is mostly about the **upstream data pipeline**, not the frontend runtime contract.

---

# Processing pipeline requirements

## Step 1 — Acquire extracts
Create a reproducible fetch/update step that downloads required extract files into a local data directory.

Example directory shape:
- `data/osm-extracts/`

## Step 2 — Filter relevant OSM features
From the extract, find candidate raceway/circuit features using tags like:
- `highway=raceway`
- `type=circuit`
- relevant supporting relation tags

## Step 3 — Resolve referenced ways and relations
The pipeline must resolve:
- ways
- relation members
- geometry needed for layout reconstruction

## Step 4 — Associate OSM geometry to known track entries
Using the local track search index or another catalog, associate extracted geometry to a known track identity.

This may use:
- spatial proximity to known coordinates
- OSM/Wikidata tags
- name/alias matching

## Step 5 — Build cleaned layout outputs
Run the current or improved layout extraction logic to derive:
- main layout
- alternates
- named circuits
- filtered deduped outputs

## Step 6 — Validate and emit generated geometry dataset
Write the final generated dataset the app will use at runtime.

---

# Track association rules

## Goal
Map raw OSM features from extracts to the app’s known track identities reliably.

## Required matching signals
Use a combination of:
- proximity to known track center coordinates
- normalized name/alias matching
- OSM `wikidata` tag when present
- relation/way names

## Preferred identity key
Prefer `wikidataId` where available, because it provides a stable bridge between:
- the track search index
- the geometry pipeline
- future metadata enrichment

---

# Tooling options for local processing

## Allowed implementation strategies
The spec does not require a specific parsing stack.

Possible tooling includes:
- custom Node-based parsers
- `osmium-tool`
- `pyosmium`
- GDAL/OGR workflows
- custom preprocessing scripts in Python/Node

## Recommendation
Use the simplest processing stack that can:
- read OSM extracts efficiently
- extract relevant way/relation geometry
- preserve reproducibility

If shell tooling is used, wrap it in explicit scripts rather than ad hoc manual steps.

---

# Data directory layout

A recommended structure:

```text
data/
  osm-extracts/
    source-manifest.json
    europe-latest.osm.pbf
    japan-latest.osm.pbf
    australia-latest.osm.pbf
  derived/
    candidate-raceways.json
    track-associations.json
src/
  generated/
    geometry/<wikidataId>.json
scripts/
  fetch-osm-extracts.mjs
  build-track-geometry-from-extracts.mjs
```

The exact structure is flexible, but the stages should be explicit.

---

# Update workflow

## Required scripts
Provide at least:
- a fetch/update script for source extracts
- a build script for derived geometry output

For example:
- `scripts/fetch-osm-extracts.mjs`
- `scripts/build-track-geometry-from-extracts.mjs`

## Recommended package scripts
Examples:
- `npm run osm:fetch`
- `npm run geometry:build-from-extracts`
- `npm run geometry:validate`

---

# Validation requirements

## Layout validation
Each emitted layout must satisfy:
- finite coordinates
- positive length
- meaningful name
- no obvious fragment-only false positives
- no accidental duplicate layouts

## Track association validation
Each mapped track should show:
- which extract it came from
- which OSM ids were used
- confidence or matching explanation when helpful

## Reporting
The build should emit a summary of:
- tracks resolved successfully
- unresolved tracks
- tracks with ambiguous geometry
- tracks requiring manual review

---

# Storage and repo policy

## Source extracts
Large raw extracts should generally **not** be committed to git.

Instead:
- download them via script
- store them in a local data cache directory
- optionally document checksum/version expectations

## Generated artifacts
Generated frontend-ready geometry artifacts may be committed if desired, depending on repo policy.

That choice should depend on:
- artifact size
- reproducibility
- convenience for deployment

---

# Runtime behavior

Runtime should not read raw OSM extracts directly.

## Required runtime rule
The frontend runtime should consume only generated app-ready geometry data.

So the runtime path remains:
- local search index
- generated geometry dataset

not:
- parse extracts in browser
- query live Overpass

---

# Benefits

## Main benefits
- no public Overpass dependency
- more controlled and reproducible source data
- easier bulk refreshes
- better long-term scalability for a larger track catalog

## Engineering benefit
This option creates a real geometry data pipeline rather than a request-time scrape.

---

# Tradeoffs

## Costs
- much more infrastructure than Option A
- handling large extract files
- more complex tooling and storage
- more operational overhead for updates

## Practical implication
This is stronger and more scalable, but heavier than needed if the app only needs a moderate curated set of tracks.

---

# When to choose Option C

Choose Option C when:
- you want a robust long-term geometry pipeline
- you expect to cover many tracks globally
- you want full control over source freshness and processing
- you want to eliminate Overpass entirely, even at build time

Do **not** choose it first if the immediate problem is just runtime flakiness for a modest set of popular tracks. In that case, Option A is likely faster to deliver.

---

# Non-goals

This option does **not** require:
- a browser-visible backend
- a hosted API
- processing the full planet file immediately

It also does not require that every possible OSM track be supported from day one.

---

# Recommended first implementation

## Phase 1
1. Define a curated supported track set.
2. Identify required regions/extracts for those tracks.
3. Build extract download scripts.
4. Build a local processor that emits the same geometry dataset contract as Option A.

## Phase 2
1. Expand region coverage.
2. Add stronger validation and review tooling.
3. Improve association confidence/diagnostics.

## Phase 3
1. Decide whether to fully retire Overpass build-time usage.
2. Scale the track catalog more broadly.

---

# Recommendation relative to Option A

If the goal is the fastest path to reliability, Option A is usually the better first move.

If the goal is the strongest long-term data pipeline with minimal third-party dependency, Option C is the stronger architecture.

In practice, a sensible path may be:
1. implement Option A first
2. later replace its build-time data acquisition with Option C

That allows the app runtime to stabilize early while the deeper data pipeline matures later.
