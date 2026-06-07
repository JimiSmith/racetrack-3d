---
name: architecture
description: Established architecture for racetrack-3d — module structure, dependency rules, Web Worker protocols, Svelte UI, data flow, and conventions to maintain. Use when adding new features, deciding where code belongs, understanding module boundaries, or reviewing structural decisions. Triggers on tasks like "where should this code go", "add a new module", "add a Svelte component", "how do the workers work", or any structural/organizational question.
---

# Architecture

This document describes the established architecture of racetrack-3d. The migration from the original monolithic JS codebase is complete. All new code must follow these conventions; deviations require justification.

## Principles

1. **Pure computation, no side effects.** `geometry/`, `model/`, `text/`, and `export/` modules are pure functions. No DOM access, no fetch calls, no global state mutation. This makes them testable, worker-compatible, and framework-agnostic.

2. **Single responsibility per module.** No file should exceed ~300 lines. When a module grows beyond that, decompose it along responsibility boundaries.

3. **Types as contracts.** TypeScript interfaces in `src/types/` define the shape of data flowing between modules. Prefer narrow interfaces over passing entire objects.

4. **Dependencies flow one way.** `components → stores → track-loader → workers → pure modules`. No circular dependencies. Pure modules never import from components, stores, or workers.

5. **Worker-first for heavy computation.** Model building and export serialization run in Web Workers. The main thread handles only UI, search, preview rendering, and orchestration.

6. **Static deployment.** No server-side components. All runtime data comes from prebuilt geometry artifacts shipped with the app or fetched from public tile servers (elevation). The build pipeline produces a static site for GitHub Pages.

## Directory structure

```
src/
├── components/              # Svelte UI components
│   ├── ElevationSlider.svelte
│   ├── ExportBar.svelte
│   ├── LayoutPicker.svelte
│   ├── OptionsPanel.svelte
│   ├── PreviewCanvas.svelte
│   ├── SearchBar.svelte
│   └── TrackSummary.svelte
│
├── stores/                  # Svelte stores (shared reactive state)
│   ├── track.ts             # selectedTrack, layouts, layoutIndex, osmVenueNames, selectedLayout
│   ├── model.ts             # currentModel, projectedNodes, outline, basePlate, elevations
│   ├── options.ts           # orientation, textPositionRank, exaggeration, label, combinedMode, effectiveLabel
│   ├── export.ts            # isExportingStl, isExporting3mf, canExport
│   ├── search.ts            # searchQuery, searchResults
│   ├── ui.ts                # statusMessage, statusIsError, previewOverlayState, isTrackSummaryExpanded
│   └── index.ts             # Re-exports all stores
│
├── geometry/                # Track geometry processing (pure, no DOM)
│   ├── geo-math.ts          # measurePolylineLength, measureDistanceMetres, computeBoundingBoxArea, computeEndpointGap
│   ├── chain-cleanup.ts     # closeNodeChainIfNearClosed, fixChainReversals, collapseImmediateBacktracks, dedupeSequentialNodes
│   ├── way-graph.ts         # buildWayGraph, buildCycleFromEdges, selectBackboneCycle
│   ├── way-stitching.ts     # stitchWaysOrdered, selectBestComponentWays
│   ├── fork-detection.ts    # detectForkSections
│   ├── layout-builder.ts    # buildVariantLayouts, buildLayoutsFromWays, buildNamedCircuitLayouts
│   ├── layout-dedup.ts      # dedupeLayoutsByGeometry, dedupeLayoutsByName, canonicalizeLayoutNames
│   ├── osm-elements.ts      # extractWays, collectOsmVenueNames, collectNamedLayoutWays, pit lane filtering
│   ├── normalize.ts         # normalizeTrackGeometryResult
│   ├── track-geometry.ts    # buildTrackGeometryFromPayload, buildTrackGeometryResult (orchestrator)
│   ├── projection.ts        # projectNodes
│   ├── outline.ts           # buildTrackOutline, buildBasePlate
│   └── index.ts             # Public re-exports
│
├── model/                   # 3D model construction (pure, no DOM)
│   ├── mesh-primitives.ts   # createVertex, addTriangle, addQuad, normalizeRing, signedArea, ensureCounterClockwise
│   ├── base-plate.ts        # buildBasePlateMesh, buildRoundedRectangleRing, computeScale
│   ├── track-ribbon.ts      # buildRaisedRibbonMesh (elevation-aware ribbon mesh)
│   ├── track-prism.ts       # buildTrackPrismMesh (outline extrusion + ribbon fallback)
│   ├── orientation.ts       # orientTrackGeometry, selectAutoOrientation, rotatePoint/Outline/BasePlate
│   ├── combined-layout.ts   # buildCombinedBasePlate, buildPrimaryEdgeSet, getUniqueSubChains
│   ├── triangle-groups.ts   # splitModelTriangles (split by base/secondary/track/text)
│   ├── track-model.ts       # buildTrackModel orchestrator, placement cache
│   └── index.ts             # Public re-exports
│
├── text/                    # Text rendering pipeline (pure, no DOM)
│   ├── font-loader.ts       # loadFont, parse base64 font, cache parsed font
│   ├── line-breaking.ts     # findOptimalLineBreaks (Knuth-Plass-style DP)
│   ├── contours.ts          # buildMultilineContours, glyph path to polygon conversion
│   ├── placement.ts         # computePlacementMask, findPlacementCandidates, computeRankedTextPlacements
│   ├── scoring.ts           # SCORING_WEIGHTS, scoreTextFit, size window multiplier, clearance scoring
│   ├── mesh.ts              # buildTextMeshFromRankedPlacements, contour triangulation
│   ├── debug.ts            # Test-only __debug*/__*PerfCounters helpers (not part of public API)
│   └── index.ts             # Public re-exports
│
├── export/                  # Export serialization (pure, no DOM)
│   ├── stl.ts               # computeNormal, serializeBinaryStl → ArrayBuffer, exportStl
│   ├── threemf.ts           # build3mfModelXml, package3mf → Uint8Array, export3mf
│   └── index.ts
│
├── search/                  # Track search (pure logic + geometry index loader)
│   ├── scoring.ts           # scoreTrackSearchEntry, token overlap, ranking
│   ├── normalize.ts         # normalizeSearchText, tokenizeNormalizedText, buildTrackSearchEntry
│   ├── track-name.ts        # selectPrintedTrackName, candidate scoring, printed name composition
│   ├── geometry-index.ts    # getTrackGeometry (fetch from prebuilt JSON assets)
│   ├── layout-picker.ts     # getSelectedLayout, normalizeSelectedLayoutIndex
│   └── index.ts             # searchTracks, fetchTrackGeometry
│
├── elevation/               # Elevation data fetching
│   └── terrarium.ts         # fetchElevations, tile loading, exaggeration, smoothing
│
├── preview/                 # Three.js preview rendering (DOM-bound)
│   ├── renderer.ts          # initPreview, updatePreviewModel, resize handling, OrbitControls
│   └── model-mesh.ts        # buildPreviewGeometry (Triangle[] → Three.js BufferGeometry + materials)
│
├── workers/                 # Web Workers + main-thread clients
│   ├── model.worker.ts      # Runs buildTrackModel off main thread
│   ├── model-client.ts      # Main-thread client: request/response, stale detection, Float32Array reconstruction
│   ├── export.worker.ts     # Runs STL/3MF serialization off main thread
│   └── export-client.ts     # Main-thread client: lazy init, promise tracking, error handling
│
├── types/                   # Shared TypeScript interfaces
│   ├── geometry.ts          # LatLonNode, ProjectedNode, Point2D, Way, WayGraph, Layout, TrackGeometry
│   ├── model.ts             # TrackModel, Triangle, Vertex, BasePlate, OutlinePoints
│   ├── text.ts              # TextPlacement, RankedPlacements, ScoringWeights
│   ├── search.ts            # TrackSearchEntry, SearchResult
│   ├── index.ts             # Re-exports
│   ├── earcut.d.ts          # Module declaration for earcut
│   ├── opentype.d.ts        # Module declaration for opentype.js
│   └── three.d.ts           # Module declaration for three
│
├── generated/               # Build-time artifacts (committed)
│   ├── geometry/            # Per-track JSON files keyed by Wikidata ID
│   └── track-search-index.json
│
├── track-loader.ts          # Orchestrates model rebuilds: reads stores, posts to model worker, writes results back
├── label-font-data.js       # Base64-encoded font (+ .d.ts)
├── entry.ts                 # App entry point — mounts Svelte App component
├── App.svelte               # Root Svelte component
├── style.css                # Global styles and CSS custom properties
└── vite-env.d.ts
```

## Data flow

```
┌─────────────────────────────────────────────────────────────┐
│  MAIN THREAD                                                │
│                                                             │
│  SearchBar ──→ search/index.ts ──→ stores/search.ts         │
│                                         │                   │
│                                    stores/track.ts          │
│                                         │                   │
│                                    geometry-index.ts         │
│                                    (prebuilt JSON fetch)     │
│                                         │                   │
│                                    elevation/terrarium.ts    │
│                                    (tile fetch + decode)     │
│                                         │                   │
│  track-loader.ts ◄───── stores/options.ts                   │
│  (rebuildModel)                                             │
│       │                                                     │
│       │ postMessage (ProjectedNode[] + options)              │
│  ┌────┼─────────────────────────────────────────────────┐   │
│  │  MODEL WORKER                                        │   │
│  │    ▼                                                 │   │
│  │  model/track-model.ts (buildTrackModel)              │   │
│  │    ├── geometry/outline.ts                           │   │
│  │    ├── model/orientation.ts (auto: 4 rotations)      │   │
│  │    ├── model/base-plate.ts                           │   │
│  │    ├── model/track-prism.ts + track-ribbon.ts        │   │
│  │    └── text/placement.ts + text/mesh.ts              │   │
│  │              │                                       │   │
│  │    Float32Array (transferred, zero-copy)              │   │
│  └──────────────┼───────────────────────────────────────┘   │
│                 ▼                                           │
│  model-client.ts → unflatten → TrackModel                   │
│       │                                                     │
│  stores/model.ts (currentModel)                             │
│       │                                                     │
│       ├──→ PreviewCanvas (Three.js render)                  │
│       └──→ ExportBar (trigger export worker)                │
│                 │                                           │
│  ┌──────────────┼───────────────────────────────────────┐   │
│  │  EXPORT WORKER                                       │   │
│  │              ▼                                       │   │
│  │  export/stl.ts → ArrayBuffer (transferred)           │   │
│  │  export/threemf.ts → Uint8Array (transferred)        │   │
│  └──────────────────────────────────────────────────────┘   │
│                 │                                           │
│            Blob → browser download                          │
└─────────────────────────────────────────────────────────────┘
```

## Web Worker protocols

### Model Worker (`workers/model.worker.ts` + `model-client.ts`)

The model worker runs `buildTrackModel` — the most expensive operation (50-700ms depending on hardware). It handles orientation selection (evaluates 4 rotations for auto mode), track prism meshing, base plate meshing, and text placement + mesh generation.

**Request message:**
```typescript
interface ModelBuildRequest {
  type: 'build-model';
  id: number;                              // Monotonic request ID for stale detection
  projectedNodes: ProjectedNode[];
  secondaryProjectedNodes: ProjectedNode[][];
  trackName: string;
  primaryOrientationDeg: number | 'auto';
  textPositionRank: number;
  cacheGeneration: number;                 // Numeric counter; when it changes, placement cache is invalidated
}
```

**Response message:**
```typescript
interface ModelBuildResponse {
  type: 'model-ready';
  id: number;
  positions: Float32Array;                 // Flat vertex positions [x,y,z,...] — transferred, not copied
  segments: { base: number; secondary: number; track: number; text: number };
  metadata: {
    scale: number;
    orientationDeg: number;
    basePlate: BasePlate;
    primaryOrientationDeg: number | 'auto';
    textPositionRank: number;
    outlinePoints: OutlinePoints;
    projectedNodes: ProjectedNode[] | null;
  };
}
```

**Key behaviours:**
- Triangle data is flattened to `Float32Array` and transferred (zero-copy) via `postMessage(response, [response.positions.buffer])`.
- The client (`model-client.ts`) tracks a monotonic `currentRequestId`. When a new request is made, all older pending promises are rejected with `'Superseded by newer request'`.
- The worker uses `setTimeout(0)` batching: incoming messages overwrite `latestRequest`, and only the most recent request is processed. This prevents the worker from grinding through stale builds during rapid UI changes.
- `cacheGeneration` maps to internal `placementCacheToken` objects in the worker — identity-based cache invalidation across the structured-clone boundary.

### Export Worker (`workers/export.worker.ts` + `export-client.ts`)

Handles STL and 3MF serialization off the main thread.

**Request:** `{ type: 'export-stl' | 'export-3mf'; id: number; model: TrackModel; fileName: string }`
**Response:** `{ type: 'export-ready'; id: number; format: 'stl' | '3mf'; buffer: ArrayBuffer; fileName: string; triangleCount: number }`
**Error:** `{ type: 'export-error'; id: number; message: string }`

- The worker is created lazily on first export request.
- `ArrayBuffer` results are transferred (zero-copy).
- Error responses are posted for serialization failures so the client promise rejects cleanly.

## Orchestration: track-loader.ts

`track-loader.ts` is the glue between Svelte stores and the model worker. It is the only module that both reads from stores and posts to the worker.

- `selectTrack(track)` — Resets all state, fetches geometry, builds model, loads elevations.
- `rebuildModel(elevationData?)` — Reads current store state, posts to model worker, writes results to stores. **Async** — returns a Promise. Catches `'Superseded by newer request'` silently (expected during rapid option changes).
- `loadElevations(nodes)` — Fetches elevation data and calls `rebuildModel` with the results.
- `invalidatePlacementCache()` — Bumps `placementCacheToken` to force text placement recomputation.

Components call these functions directly (e.g., `rebuildModel()` after an orientation change). The model worker processes the request and the stores are updated when the result arrives.

## Svelte UI

### Component responsibilities

| Component | Responsibility |
|---|---|
| `App.svelte` | Root layout, mounts all sections |
| `SearchBar.svelte` | Search input, debounce, abort controller, results dropdown, track selection |
| `TrackSummary.svelte` | Track name, metadata, label input (300ms debounced) with reset, mobile collapse |
| `PreviewCanvas.svelte` | Three.js renderer lifecycle, overlay states, resize handling |
| `OptionsPanel.svelte` | Orientation select, text position select, layout picker, elevation slider |
| `ElevationSlider.svelte` | Elevation exaggeration slider with live value display |
| `LayoutPicker.svelte` | Layout dropdown, combined-layout toggle (hidden for single layout) |
| `ExportBar.svelte` | STL/3MF download buttons via export worker, in-progress states, uses `effectiveLabel` for filenames |

### Store design

Stores use Svelte's `writable` and `derived`. Key patterns:

- **`effectiveLabel`** (derived) — returns `labelOverride` if set, otherwise the auto-derived printed track name. Used by both the model builder (for text embossing) and ExportBar (for filenames).
- **`canExport`** (derived) — enables export buttons only when a model, outline, and base plate exist and no export is in progress.
- **`selectedLayout`** (derived) — `layouts[layoutIndex]`, used by components to display layout-specific data.

## TypeScript conventions

All source files are TypeScript (`.ts` or `.svelte` with `<script lang="ts">`). The only exceptions are:
- `src/label-font-data.js` — large base64 blob with a `.d.ts` sidecar
- Build scripts in `scripts/` — remain JS/MJS (different lifecycle)

**tsconfig highlights:**
- `strict: true` — non-negotiable.
- `noUncheckedIndexedAccess` — catches array/map index bugs common in geometry code.
- `exactOptionalPropertyTypes` — prevents `undefined` from sneaking into optional properties.
- `verbatimModuleSyntax` — enforces explicit `import type` for type-only imports.

## Testing

- **Node.js native test runner** (`node --test`) with `scripts/ts-resolver-register.mjs` for TypeScript.
- **Pure modules are trivially testable.** Import the function, pass data, assert output.
- **Regression fixtures** in `test/fixtures/` — frozen OSM JSON payloads per-venue.
- **Svelte component tests** are not a priority. Components are thin wrappers; logic lives in stores and pure modules.
- **Worker protocol correctness** is validated indirectly — tests import `buildTrackModel` and export functions directly (not via workers), so the pure computation is tested independently of the message-passing layer.

## Build pipeline

```
npm run dev                    →  Vite dev server (HMR for Svelte + TS)
npm run build                  →  Vite production build (static assets for GitHub Pages)
npm run typecheck              →  tsc --noEmit
npm run lint                   →  ESLint with @typescript-eslint
npm test                       →  node --test (179 tests)
npm run check                  →  typecheck + lint + test + file-size check
npm run geometry:import        →  OSM geometry pipeline (utils/geometry-import/)
npm run build:track-search-index → Node script for search index
```

Vite uses esbuild for transpilation and Rollup for production bundling. Workers are bundled as separate chunks via `new Worker(new URL(...), { type: 'module' })`.

## Known debt

- _(none currently tracked)_ — The former legacy text re-export shim was removed in #137: production code now imports directly from the `src/text/index.ts` barrel, and its test-only debug helpers live in `src/text/debug.ts`.

## Hard rules

- **No file over 300 lines.** Decompose along responsibility boundaries.
- **No circular dependencies.** Enforced by ESLint `import/no-cycle`.
- **No DOM access in pure modules.** Only `components/`, `preview/`, and `entry.ts` may touch the DOM.
- **No `any` in new code.** Use `unknown` and narrow. (The legacy `any` casts in the old text re-export shim were eliminated in #137; `src/text/debug.ts` is `any`-free.)
- **Exports are the public API.** Each directory's `index.ts` defines what is public. Internal helpers are not re-exported.
- **Workers own their computation.** The main thread must not call `buildTrackModel` directly — only via the model worker client. Same for export serialization.
- **Build scripts stay in JS/MJS.** `scripts/` does not need TypeScript.
- **Debounce rapid-fire inputs.** Any input that triggers `rebuildModel` more than once per user action must be debounced (currently: label input at 300ms). The model worker also batches requests internally, but debouncing at the source prevents unnecessary message overhead.
