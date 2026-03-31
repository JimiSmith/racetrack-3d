---
name: export
description: STL and 3MF export pipeline for 3D printable circuit models. Use when working on model construction, STL export, 3MF export, or the in-app export UI. Triggers on tasks like "fix STL export", "improve 3MF output", "add export button", "batch export", or anything touching src/model.js or src/export3mf.js.
---

# Export

## Key files

- `src/model.js` — `buildTrackModel()`, `exportStl()` — model construction and STL export
- `src/export3mf.js` — 3MF export (recommended format)
- `src/geometry.js` — `projectNodes()`, `buildTrackOutline()`, `buildBasePlate()`

## Export formats

**3MF** (recommended) — richer format with units, metadata, print orientation hints. Preferred for PrusaSlicer, Bambu Studio, Orca.

**STL** — simpler binary format; wider compatibility.

## Model construction pipeline

```
fetchTrackGeometry()  →  projectNodes()  →  buildTrackOutline()
  →  buildBasePlate()  →  buildTrackModel()  →  exportStl() / export3mf()
```

## Web app export

Export is triggered from the UI in `src/main.js` / `src/ui.js`. The preview and exported model must always match — do not introduce discrepancies between what is previewed and what is exported.

## Batch export

Issue #16 — batch export should move into the web app. The old `scripts/generate-all-stl.mjs` has been deleted. Use the prebuilt geometry index as the data source, not live Overpass queries.

## Notes

- `output/` is gitignored; local STL/3MF files go there
