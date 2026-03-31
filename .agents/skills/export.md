# Skill: Export

STL and 3MF export pipeline for 3D printable circuit models.

## Key files

- `src/model.js` — `buildTrackModel()`, `exportStl()` — core model construction and STL export
- `src/export3mf.js` — 3MF export format (recommended over STL)
- `src/geometry.js` — `projectNodes()`, `buildTrackOutline()`, `buildBasePlate()`

## Export formats

### 3MF (recommended)
- Richer format: includes units, metadata, and print orientation hints
- Preferred for most slicers (PrusaSlicer, Bambu Studio, Orca)
- Implemented in `src/export3mf.js`

### STL
- Simpler binary format; wider compatibility
- Implemented via `exportStl()` in `src/model.js`

## Model construction pipeline

```
fetchTrackGeometry()       → raw lat/lon nodes
projectNodes()             → flat 2D projected coordinates
buildTrackOutline()        → outline point array
buildBasePlate()           → base geometry
buildTrackModel()          → full 3D model with triangles
exportStl() / export3mf()  → file buffer
```

## Web app export (current)

Export is triggered from the UI in `src/main.js` / `src/ui.js`. The preview and exported model must always match — do not introduce discrepancies between what is previewed and what is exported.

## Batch export (future)

Issue #16 — batch STL export should move into the web app rather than a separate CLI script. The old `scripts/generate-all-stl.mjs` has been deleted.

## Notes

- The prebuilt geometry index should be used as the data source for export — not live Overpass queries
- `output/` is gitignored; any local STL/3MF files go there
