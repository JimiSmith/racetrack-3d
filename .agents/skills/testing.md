# Skill: Testing

## Running tests

```bash
npm test
```

All tests must pass before committing. `npm run build` must also pass.

## Test files

| File | Covers |
|---|---|
| `test/search.test.js` | Runtime geometry search and layout selection |
| `test/build-track-geometry-index.test.js` | Geometry build script logic |
| `test/osm-api-source.test.js` | OSM API fetch helper (adaptive bbox, rate limiting) |
| `test/elevation.test.js` | Elevation fetching and exaggeration modes |
| `test/geometry.test.js` | Geometry projection and outline building |
| `test/model.test.js` | 3D model construction |
| `test/export3mf.test.js` | 3MF export format |
| `test/text3d.test.js` | Track name text rendering |
| `test/track-name.test.js` | Track name selection logic |
| `test/picker.test.js` | Layout picker ranking |
| `test/preview-geometry.test.js` | Preview geometry generation |

## Frozen OSM fixtures

`test/fixtures/` contains frozen OSM API responses used for regression tests on previously broken venues. These ensure geometry selection behaviour doesn't regress.

Current fixtures:
- `mexico-city.json`
- `monaco.json`
- `monza.json`
- `zandvoort.json`
- `brands-hatch.json`
- `bahrain.json`
- `silverstone.json`

## Adding a regression fixture

When fixing a geometry selection bug for a specific venue:

1. Capture the raw OSM API response for that venue (use `--track <wikidataId>` with logging)
2. Save it to `test/fixtures/<venue-slug>.json`
3. Add a test in the relevant test file that loads the fixture and asserts the expected layout set
4. The fixture freezes the OSM data so future changes can't silently break that venue

## Test helpers

`test/helpers/` contains shared test utilities. Check there before duplicating setup logic.
