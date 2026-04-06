---
name: architecture
description: Target architecture for racetrack-3d — module structure, decomposition boundaries, TypeScript migration, Svelte UI, Web Worker strategy, and data flow. Use when planning new features, decomposing modules, migrating files to TypeScript, adding Svelte components, or making structural decisions about where code belongs. Triggers on tasks like "where should this code go", "refactor X", "migrate to TypeScript", "add a Svelte component", "move to workers", or any structural/organizational question.
---

# Architecture

This document defines the target architecture for racetrack-3d. It represents the future direction, not the current state. All new code should follow this structure. Existing code should be migrated incrementally.

## Principles

1. **Pure computation, no side effects.** Geometry, model, text, and export modules are pure functions. No DOM access, no fetch calls, no global state. This makes them testable, worker-compatible, and framework-agnostic.

2. **Single responsibility per module.** No file should exceed ~300 lines. When a file grows beyond that, it is doing too much and should be split along responsibility boundaries.

3. **Types as contracts.** TypeScript interfaces define the shape of data flowing between modules. Shared types live in `src/types/`. Prefer narrow interfaces over passing entire objects.

4. **Dependencies flow one way.** `components → stores → workers → pure modules`. No circular dependencies. Pure modules never import from components, stores, or workers.

5. **Worker-first for heavy computation.** Model building, text placement, and export serialization run in Web Workers. The main thread handles only UI, search, and preview rendering.

6. **Static deployment.** No server-side components. All runtime data comes from prebuilt artifacts shipped with the app or fetched from public tile servers (elevation). The build pipeline produces a static site for GitHub Pages.

7. **Incremental migration.** The architecture supports coexistence of old JS and new TS modules. Files are migrated one at a time. Svelte components can wrap existing DOM logic during transition.

## Target directory structure

```
src/
├── components/              # Svelte UI components
│   ├── App.svelte
│   ├── SearchBar.svelte
│   ├── TrackSummary.svelte
│   ├── PreviewCanvas.svelte
│   ├── OptionsPanel.svelte
│   ├── ExportBar.svelte
│   └── LayoutPicker.svelte
│
├── stores/                  # Svelte stores (shared reactive state)
│   ├── track.ts             # Selected track, layouts, layout index, OSM venue names
│   ├── model.ts             # Current model output, projected nodes, outline, base plate
│   ├── options.ts           # Orientation, text position, exaggeration, label, combined mode
│   ├── export.ts            # Export-in-progress flags
│   └── search.ts            # Query, results, abort controller
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
│   └── index.ts             # Public re-exports
│
├── export/                  # Export serialization (pure, no DOM)
│   ├── stl.ts               # serializeBinaryStl → ArrayBuffer
│   ├── threemf.ts           # build3mfModelXml, package3mf → Uint8Array
│   └── index.ts
│
├── search/                  # Track search (pure logic + geometry index loader)
│   ├── scoring.ts           # scoreTrackSearchEntry, token overlap, ranking
│   ├── normalize.ts         # normalizeSearchText, tokenizeNormalizedText, buildTrackSearchEntry
│   ├── track-name.ts        # selectPrintedTrackName, candidate scoring, printed name composition
│   ├── geometry-index.ts    # getTrackGeometry (fetch from prebuilt JSON assets)
│   └── index.ts             # searchTracks, fetchTrackGeometry
│
├── elevation/               # Elevation data fetching
│   └── terrarium.ts         # fetchElevations, tile loading, exaggeration, smoothing
│
├── preview/                 # Three.js preview rendering (DOM-bound)
│   ├── renderer.ts          # initPreview, resizeRenderer, animation loop
│   ├── scene.ts             # Scene setup, lighting, camera fitting
│   ├── model-mesh.ts        # Triangle data → Three.js BufferGeometry + materials
│   └── index.ts
│
├── workers/                 # Web Workers
│   ├── model.worker.ts      # Runs buildTrackModel off main thread
│   └── export.worker.ts     # Runs STL/3MF serialization off main thread
│
├── types/                   # Shared TypeScript interfaces
│   ├── geometry.ts          # LatLonNode, ProjectedNode, Way, WayGraph, Layout, TrackGeometry
│   ├── model.ts             # TrackModel, Triangle, Vertex, BasePlate, OutlinePoints
│   ├── text.ts              # TextPlacement, RankedPlacements, ScoringWeights
│   ├── search.ts            # TrackSearchEntry, SearchResult
│   └── index.ts             # Re-exports all types
│
├── generated/               # Build-time artifacts (committed)
│   ├── geometry/            # Per-track JSON files keyed by Wikidata ID
│   └── track-search-index.json
│
├── main.ts                  # App entry point (mounts Svelte App component)
└── style.css                # Global styles and CSS custom properties
```

## Module decomposition map

How the current monoliths map to the target structure:

### search.js (1,900 lines) → `src/geometry/` + `src/search/`

| Current function group | Target module |
|---|---|
| `measurePolylineLength`, `measureDistanceMetres`, `computeBoundingBoxArea`, `computeEndpointGap` | `geometry/geo-math.ts` |
| `closeNodeChainIfNearClosed`, `fixChainReversals`, `collapseImmediateBacktracks`, `dedupeSequentialNodes` | `geometry/chain-cleanup.ts` |
| `buildWayGraph`, `buildCycleFromEdges`, `selectBackboneCycle` | `geometry/way-graph.ts` |
| `stitchWaysOrdered`, `selectBestComponentWays` | `geometry/way-stitching.ts` |
| `detectForkSections` | `geometry/fork-detection.ts` |
| `buildVariantLayouts`, `buildLayoutsFromWays`, `buildNamedCircuitLayouts` | `geometry/layout-builder.ts` |
| `dedupeLayoutsByGeometry`, `dedupeLayoutsByName`, `canonicalizeLayoutNames` | `geometry/layout-dedup.ts` |
| `extractWays`, `collectOsmVenueNames`, `collectNamedLayoutWays`, pit filtering | `geometry/osm-elements.ts` |
| `normalizeTrackGeometryResult` | `geometry/normalize.ts` |
| `buildTrackGeometryFromPayload`, `buildTrackGeometryResult` | `geometry/track-geometry.ts` |
| `searchTracks`, `fetchTrackGeometry` | `search/index.ts` |

### text3d.js (1,585 lines) → `src/text/`

| Current function group | Target module |
|---|---|
| Font loading and parsing | `text/font-loader.ts` |
| `findOptimalLineBreaks` and DP cost function | `text/line-breaking.ts` |
| `buildMultilineContours`, glyph path conversion | `text/contours.ts` |
| `computePlacementMask`, `findPlacementCandidates`, `computeRankedTextPlacements` | `text/placement.ts` |
| `SCORING_WEIGHTS`, `scoreTextFit`, size/clearance multipliers | `text/scoring.ts` |
| `buildTextMeshFromRankedPlacements`, earcut triangulation | `text/mesh.ts` |

### model.js (926 lines) → `src/model/`

| Current function group | Target module |
|---|---|
| `createVertex`, `addTriangle`, `addQuad`, `normalizeRing`, `signedArea` | `model/mesh-primitives.ts` |
| `buildBasePlateMesh`, `buildRoundedRectangleRing`, `computeScale` | `model/base-plate.ts` |
| `buildRaisedRibbonMesh` | `model/track-ribbon.ts` |
| `buildTrackPrismMesh` | `model/track-prism.ts` |
| `orientTrackGeometry`, `selectAutoOrientation`, rotation helpers | `model/orientation.ts` |
| `buildCombinedBasePlate`, `buildPrimaryEdgeSet`, `getUniqueSubChains` | `model/combined-layout.ts` |
| `buildTrackModel`, placement cache | `model/track-model.ts` |
| `serializeBinaryStl`, `exportStl` | `export/stl.ts` |

### main.js (638 lines) → Svelte components + stores

| Current concern | Target location |
|---|---|
| 20+ `let currentXxx` state variables | `stores/track.ts`, `stores/model.ts`, `stores/options.ts` |
| Search input, debouncing, results list | `SearchBar.svelte` + `stores/search.ts` |
| Track summary panel, label editing | `TrackSummary.svelte` |
| Layout selector, combined toggle | `LayoutPicker.svelte` + `OptionsPanel.svelte` |
| Exaggeration slider, orientation, text position | `OptionsPanel.svelte` |
| Export buttons, download triggering | `ExportBar.svelte` + `stores/export.ts` |
| Preview overlay states | `PreviewCanvas.svelte` |
| `handleSelect` orchestration | `stores/track.ts` (reactive derivation) |

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
│                                    stores/options.ts         │
│                                         │                   │
│  ┌──────────────────────────────────────┼───────────────┐   │
│  │  MODEL WORKER                        │               │   │
│  │                                      ▼               │   │
│  │  geometry/projection.ts ──→ model/track-model.ts     │   │
│  │  geometry/outline.ts            │                    │   │
│  │  model/orientation.ts           ├──→ model/base-plate│   │
│  │  model/track-prism.ts           ├──→ model/ribbon    │   │
│  │  text/placement.ts              └──→ text/mesh.ts    │   │
│  │                                      │               │   │
│  │                              TrackModel result        │   │
│  └──────────────────────────────────────┼───────────────┘   │
│                                         │                   │
│                                    stores/model.ts          │
│                                         │                   │
│                              ┌──────────┴──────────┐        │
│                              ▼                     ▼        │
│                     PreviewCanvas          ExportBar         │
│                     (Three.js render)      (trigger worker)  │
│                                                     │       │
│  ┌──────────────────────────────────────────────────┼───┐   │
│  │  EXPORT WORKER                                   │   │   │
│  │                                                  ▼   │   │
│  │  export/stl.ts  ──→  ArrayBuffer (transferable)      │   │
│  │  export/threemf.ts ──→ Uint8Array (transferable)     │   │
│  └──────────────────────────────────────────────────────┘   │
│                                         │                   │
│                                    Blob → download          │
└─────────────────────────────────────────────────────────────┘
```

## Web Worker strategy

### Model Worker (`workers/model.worker.ts`)

Handles the most expensive operation: `buildTrackModel`. This includes orientation selection (which evaluates 4 rotations), track prism meshing, base plate meshing, and text placement + mesh generation.

**Input message:**
```typescript
{
  type: 'build-model';
  projectedNodes: ProjectedNode[];
  secondaryProjectedNodes: ProjectedNode[][];
  trackName: string;
  primaryOrientationDeg: number | 'auto';
  textPositionRank: number;
  placementCacheToken: object | null;
}
```

**Output message:**
```typescript
{
  type: 'model-ready';
  // Float32Array of triangle vertex positions — transferred, not copied
  trianglePositions: Float32Array;
  // Metadata for splitting triangles into base/secondary/track/text groups
  segmentCounts: { base: number; secondary: number; track: number; text: number };
  // Model metadata for UI display
  metadata: { scale: number; orientationDeg: number; basePlate: BasePlate; ... };
}
```

Use `Transferable` objects for the triangle position buffer to avoid copying large arrays between threads.

### Export Worker (`workers/export.worker.ts`)

Handles STL and 3MF serialization. Receives the triangle data (which may already be on the worker if model building happened there) and returns a serialized buffer.

**Input:** Triangle positions + format choice.
**Output:** `ArrayBuffer` (STL) or `Uint8Array` (3MF zip) as transferable.

### Worker lifecycle

- Workers are created once at app startup and reused.
- Each request carries an ID; stale responses (from superseded requests) are discarded.
- The main thread sends an abort signal when the user changes options before a build completes.

## Svelte UI architecture

### Why Svelte

- **Zero runtime overhead.** Compiles to vanilla JS — no framework shipped to the browser. Ideal for a static site where bundle size matters.
- **Reactive state without boilerplate.** Replaces the 20+ mutable `let` variables in main.js with derived stores. State changes flow automatically to the DOM.
- **Scoped CSS.** Each component's styles are scoped by default, replacing the single global stylesheet for component-specific rules.
- **Vite-native.** `@sveltejs/vite-plugin-svelte` integrates seamlessly with the existing Vite setup.

### Component responsibility

| Component | Responsibility |
|---|---|
| `App.svelte` | Top-level layout, mounts all sections, subscribes to stores for cross-component coordination |
| `SearchBar.svelte` | Input, debounce, abort controller, results dropdown, track selection |
| `TrackSummary.svelte` | Track name, metadata, label input with reset, mobile collapse toggle |
| `PreviewCanvas.svelte` | Three.js renderer lifecycle, overlay states, resize handling |
| `OptionsPanel.svelte` | Orientation select, text position select, exaggeration slider |
| `LayoutPicker.svelte` | Layout dropdown, combined-layout toggle (hidden when single layout) |
| `ExportBar.svelte` | STL/3MF download buttons, in-progress states, file naming |

### Store design

Stores use Svelte's `writable` and `derived` stores. The key insight is that most of main.js's complexity comes from manually propagating state changes — Svelte's reactivity eliminates this.

```typescript
// stores/track.ts
export const selectedTrack = writable<TrackSearchResult | null>(null);
export const layouts = writable<Layout[]>([]);
export const layoutIndex = writable<number>(0);
export const selectedLayout = derived(
  [layouts, layoutIndex],
  ([$layouts, $index]) => $layouts[$index] ?? null,
);
```

The orchestration in `handleSelect` (loading geometry, fetching elevations, building model) becomes a reactive chain: when `selectedTrack` changes, a derived store triggers geometry loading, which triggers elevation loading, which triggers a worker message to build the model.

## TypeScript migration

### Strategy

Migrate bottom-up: pure leaf modules first, then modules that depend on them, then stores, then components.

**Phase 1 — Types and pure leaves:**
1. Create `src/types/` with all shared interfaces
2. Migrate `geometry/geo-math.ts`, `geometry/chain-cleanup.ts`, `model/mesh-primitives.ts`
3. Migrate `export/stl.ts`, `export/threemf.ts`

**Phase 2 — Core computation modules:**
4. Migrate remaining `geometry/` modules (way-graph, stitching, fork-detection, layout-builder, dedup)
5. Migrate `text/` modules
6. Migrate `model/` modules

**Phase 3 — Integration layers:**
7. Migrate `search/` modules
8. Migrate `elevation/`
9. Add workers with typed message protocols

**Phase 4 — UI:**
10. Add Svelte with TypeScript (`.svelte` files with `<script lang="ts">`)
11. Migrate stores
12. Replace main.js with Svelte App component

### TypeScript configuration

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.svelte"]
}
```

Key choices:
- `strict: true` — non-negotiable for a world-class codebase.
- `noUncheckedIndexedAccess` — catches array/map index bugs that are common in geometry code.
- `exactOptionalPropertyTypes` — prevents `undefined` from sneaking into optional properties.
- `verbatimModuleSyntax` — enforces explicit `import type` for type-only imports.

### Coexistence during migration

Vite handles mixed `.js` and `.ts` files natively. During migration:
- New files are written in TypeScript.
- Existing JS files can be imported from TS files (Vite resolves them).
- `// @ts-check` + JSDoc can be added to JS files that aren't ready for full migration.
- Type checking runs via `tsc --noEmit` (not via Vite's build, which uses esbuild and skips type checking).

## Key type definitions

```typescript
// types/geometry.ts
export interface LatLonNode {
  lat: number;
  lon: number;
}

export interface ProjectedNode {
  x: number;
  y: number;
  elevation: number;
}

export interface Way {
  id: number;
  tags: Record<string, unknown>;
  nodes: LatLonNode[];
}

export interface Layout {
  id: string;
  name: string;
  nodes: LatLonNode[];
  stats: {
    lengthMetres: number;
    segmentCount: number;
    variantSectionCount?: number;
  };
}

export interface TrackGeometryResult {
  layouts: Layout[];
  selectedLayoutIndex: number;
  osmVenueNames: string[];
}

// types/model.ts
export interface Vertex {
  x: number;
  y: number;
  z: number;
}

export type Triangle = [Vertex, Vertex, Vertex];

export interface BasePlate {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

export interface OutlinePoints {
  outerRing: Array<{ x: number; y: number }>;
  holes: Array<Array<{ x: number; y: number }>>;
}

export interface TrackModel {
  triangles: Triangle[];
  baseTriangleCount: number;
  secondaryTrackTriangleCount: number;
  trackTriangleCount: number;
  textTriangleCount: number;
  scale: number;
  primaryOrientationDeg: number | 'auto';
  orientationDeg: number;
  outlinePoints: OutlinePoints;
  basePlate: BasePlate;
  projectedNodes: ProjectedNode[] | null;
}
```

## Testing approach

- **Node.js native test runner** (`node --test`) — already in use, keep it.
- **Pure modules are trivially testable.** No browser environment needed. Import the function, pass data, assert output.
- **Worker protocol tests.** Test message serialization/deserialization independently of actual worker threads.
- **Svelte component tests** are not a priority. The components are thin wrappers; the logic lives in stores and pure modules where it is testable.
- **Regression fixtures** continue to live in `test/fixtures/`. The frozen OSM data pattern works well and should be maintained.

## Build pipeline

```
npm run dev          →  Vite dev server (HMR for Svelte + TS)
npm run build        →  Vite production build (static assets for GitHub Pages)
npm run typecheck    →  tsc --noEmit (type checking only, not part of build)
npm run lint         →  ESLint with @typescript-eslint
npm test             →  node --test
npm run build:geometry-index    →  (unchanged) Node script for OSM geometry
npm run build:track-search-index →  (unchanged) Node script for search index
```

Vite uses esbuild for transpilation (fast, no type checking) and Rollup for production bundling. Type checking is a separate step (`npm run typecheck`) run in CI and pre-commit hooks.

## Hard rules

- **No file over 300 lines.** If a module exceeds this, decompose it.
- **No circular dependencies.** Enforce with ESLint `import/no-cycle` or a bundler plugin.
- **No DOM access in pure modules.** Only `components/`, `preview/`, and the top-level entry point may touch the DOM.
- **No `any` in new TypeScript code.** Use `unknown` and narrow. Existing JS interop may use `any` temporarily during migration.
- **Exports are the public API.** Each directory's `index.ts` defines what is public. Internal helpers are not exported from the index.
- **Workers own their computation.** Once model building moves to a worker, the main thread must not also import and call `buildTrackModel` directly. One owner per computation.
- **Build scripts stay in JS/MJS.** The `scripts/` directory does not need TypeScript — it runs in Node with a different lifecycle than the app.
