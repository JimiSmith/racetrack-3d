# Skill: Geometry Pipeline

Build-time system that fetches OSM circuit geometry and stores it in a prebuilt local index shipped with the app.

## Key files

- `scripts/build-track-geometry-index.mjs` — main build script
- `scripts/lib/osm-api-source.mjs` — OSM API fetch helper with adaptive bbox, rate-limit handling, and retry
- `src/generated/track-geometry-index.json` — committed artifact; durable canonical cache
- `src/geometry-index.js` — runtime loader for the prebuilt index
- `.cache/` — ephemeral local acceleration cache; never committed

## Architecture

- **OSM API** (`api.openstreetmap.org/api/0.6/map?bbox=...`) is the primary build-time source
- **Overpass** is the fallback only — used when OSM API fails to yield valid geometry
- Runtime never hits Overpass or live OSM for tracks covered by the index
- Source-specific cleanup and normalization belongs in the build script only — never in `src/search.js`

## Running a build

```bash
# Full build (all tracks)
node scripts/build-track-geometry-index.mjs

# Limited run (useful for testing)
node scripts/build-track-geometry-index.mjs --limit 20

# Single track by Wikidata ID
node scripts/build-track-geometry-index.mjs --track Q171402
```

Output is written to `src/generated/track-geometry-index.json`.
Run logs are written to `scripts/run-logs/` (gitignored).

## Staleness

- Entries are refreshed after **2 weeks** + a ±3-day deterministic per-track jitter (based on Wikidata ID hash)
- Entries deferred by `--limit` preserve existing geometry unchanged
- `.cache/` stores raw OSM responses for local acceleration; safe to delete at any time

## OSM API behaviour

- Adaptive bbox: starts small, grows progressively to find geometry without hitting the 50k-node cap
- Rate-limit (509) responses are detected, respected with backoff, and retried
- Requests are paced to avoid hammering the API in bulk runs

## npm scripts

```bash
npm run build:geometry-index:ci   # CI-safe full build
npm run validate:geometry-index   # Validate existing artifact without fetching
```

## Known edge cases

- Dense street circuits (e.g. Adelaide, Alexandra Park) often hit the node cap before geometry is found — falls back to Overpass
- Some venues have no OSM raceway geometry at all — both paths fail; logged as failures
- Tiny false-positive geometries (< ~500m) are rejected by sanity-length validation
