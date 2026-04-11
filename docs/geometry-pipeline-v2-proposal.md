# Geometry Import Pipeline v2 — Proposal

## Design Principles

1. **Strict upstream**: If OSM data is wrong, fix it in OSM. No downstream hacks or workarounds.
2. **Relations and names are untrustworthy**: OSM relations and `name` tags are inconsistent by nature. Tagging (e.g. `highway=raceway`, `sport=motor`) is the reliable signal.
3. **Manual layout definitions are the source of truth**: The pipeline only produces runtime geometry for tracks that have an explicit, human-authored layout file. No automated layout detection or heuristics.
4. **Separation of concerns**: Raw OSM data, manual layout definitions, and final geometry output are distinct artifacts stored in distinct locations.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        STEP 1: Search Index                         │
│                                                                     │
│   src/generated/track-search-index.json                             │
│   (existing — built from Wikidata, contains lat/lon per track)      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  For each track: use lat/lon to
                               │  query OSM API for nearby ways
                               │  tagged highway=raceway + sport=motor
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     STEP 2: Fetch OSM Ways                          │
│                     (automated build step)                          │
│                                                                     │
│   Query: all ways within bounding box of track centre               │
│   Filter: highway=raceway AND sport=motor                           │
│                                                                     │
│   Output: src/generated/geometry/ways/{wikidataId}.json             │
│           One file per track. Superset of all raceway ways          │
│           at this location.                                         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  Human reviews ways file,
                               │  identifies which ways belong
                               │  to which layout
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  STEP 3: Manual Layout Definition                   │
│                  (human-authored, checked into git)                 │
│                                                                     │
│   src/generated/geometry/layouts/{wikidataId}.json                  │
│   One file per track. Maps layout names to ordered                  │
│   lists of OSM way IDs with optional per-way metadata.              │
│                                                                     │
│   Only tracks with a layout file proceed to Step 4.                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               │  Build script joins layout
                               │  definitions with way geometry
                               │  from Step 2
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   STEP 4: Generate Runtime Geometry                 │
│                   (automated build step)                            │
│                                                                     │
│   For each track with a layout file:                                │
│     - Resolve way IDs → node chains from the ways file              │
│     - Stitch ways in declared order                                 │
│     - Validate (closed loop, no gaps, sane length)                  │
│     - Write final geometry                                          │
│                                                                     │
│   Output: src/generated/geometry/{wikidataId}.json                  │
│           (same location/format as today — runtime compatible)      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## File Specifications

### Step 2 Output — Ways File

**Location**: `src/generated/geometry/ways/{wikidataId}.json`

This file is the raw OSM data dump for a given venue. It is generated automatically and should not be hand-edited (re-run the fetch instead).

```jsonc
{
  // Metadata about the fetch
  "trackId": "Q171402",
  "fetchedAt": "2026-04-11T10:30:00.000Z",
  "center": { "lat": 52.0786, "lon": -1.0169 },
  "boundingBox": {
    "south": 52.0586,
    "west": -1.0369,
    "north": 52.0986,
    "east": -0.9969
  },

  // Every way matching highway=raceway + sport=motor in the bbox
  "ways": [
    {
      "id": 3571477,
      "tags": {
        "highway": "raceway",
        "sport": "motor",
        "name": "Silverstone Circuit"
      },
      "nodes": [
        { "lat": 52.0710, "lon": -1.0228 },
        { "lat": 52.0712, "lon": -1.0225 },
        { "lat": 52.0715, "lon": -1.0220 }
        // ... full node chain
      ]
    },
    {
      "id": 169730585,
      "tags": {
        "highway": "raceway",
        "sport": "motor",
        "name": "Copse"
      },
      "nodes": [
        { "lat": 52.0715, "lon": -1.0220 },
        { "lat": 52.0720, "lon": -1.0210 }
        // ...
      ]
    },
    {
      "id": 430075117,
      "tags": {
        "highway": "raceway",
        "sport": "motor",
        "name": "Pit Lane"
      },
      "nodes": [
        { "lat": 52.0711, "lon": -1.0230 },
        { "lat": 52.0709, "lon": -1.0222 }
        // ...
      ]
    }
    // ... all matching ways at Silverstone
  ]
}
```

**Key decisions:**
- Tags are preserved verbatim from OSM (for human inspection), but the pipeline does not rely on `name` tags for layout detection.
- Node coordinates are stored at full OSM precision.
- The bounding box used is recorded for reproducibility.

---

### Step 3 Input — Layout File

**Location**: `src/generated/geometry/layouts/{wikidataId}.json`

This file is human-authored and checked into git. It is the single source of truth for which ways compose which layout.

```jsonc
{
  "trackId": "Q171402",
  "name": "Silverstone Circuit",

  "layouts": {
    "Grand Prix": {
      "ways": [
        { "wayId": 3571477 },
        { "wayId": 169730585 },
        { "wayId": 169730587 },
        { "wayId": 169733768 },
        { "wayId": 169730586 },
        { "wayId": 430075118 },
        { "wayId": 169733766 },
        { "wayId": 169733769 },
        { "wayId": 169733770 },
        { "wayId": 169848880 },
        { "wayId": 169848884 },
        { "wayId": 169848881 },
        { "wayId": 55224168 },
        { "wayId": 55224167 },
        { "wayId": 169854842 },
        { "wayId": 169800226 },
        { "wayId": 169800223 },
        { "wayId": 169800225 },
        { "wayId": 169848882 },
        { "wayId": 169800224 },
        { "wayId": 169800222 },
        { "wayId": 169618242 },
        { "wayId": 169618240 },
        { "wayId": 169618241 },
        { "wayId": 169618245 },
        { "wayId": 169609611 },
        { "wayId": 169730588 }
      ]
    },

    "National": {
      "ways": [
        { "wayId": 3571477 },
        { "wayId": 169730585 },
        { "wayId": 169730587 },
        { "wayId": 169733768 },
        { "wayId": 169730586, "toNode": { "lat": 52.0731007, "lon": -1.0096291 } },
        { "wayId": 227820537 },
        { "wayId": 169618242 },
        { "wayId": 169618240 },
        { "wayId": 169618241 },
        { "wayId": 169618245 },
        { "wayId": 169609611 },
        { "wayId": 169730588 }
      ]
    },

    "International": {
      "ways": [
        { "wayId": 169848882 },
        { "wayId": 169800224, "toNode": { "lat": 52.0714208, "lon": -1.0124441 } },
        { "wayId": 227820536, "fromNode": { "lat": 52.0714208, "lon": -1.0124441 }, "toNode": { "lat": 52.0706238, "lon": -1.0105705 } },
        { "wayId": 227820535 },
        { "wayId": 169733766, "fromNode": { "lat": 52.0704519, "lon": -1.0097476 } },
        { "wayId": 169733769 },
        { "wayId": 169733770 },
        { "wayId": 169848880 },
        { "wayId": 169848884 },
        { "wayId": 169848881 },
        { "wayId": 55224168 },
        { "wayId": 55224167 },
        { "wayId": 169854842 },
        { "wayId": 169800226 },
        { "wayId": 169800223 },
        { "wayId": 169800225 }
      ]
    }
  },

  // Optional: ways at this venue that are not part of any racing layout.
  // Listed here to suppress "unused way" warnings during validation.
  "excludedWays": [
    { "wayId": 430075117, "reason": "pit lane" },
    { "wayId": 999999999, "reason": "access road" }
  ]
}
```

**Way entry schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wayId` | `number` | yes | OSM way ID. Must exist in the corresponding ways file. |
| `fromNode` | `{ lat, lon }` | no | Slice: use this way only from this node onward. |
| `toNode` | `{ lat, lon }` | no | Slice: use this way only up to this node. |
| `role` | `string` | no | Semantic role, e.g. `"pitLane"`. Not used for stitching; informational only for now. |

**Design notes:**
- Layout names are the dictionary keys. Names are freeform strings chosen by the author.
- Way order within a layout is significant — it defines the stitching sequence.
- `fromNode`/`toNode` allow slicing a way at a junction point when a layout only uses part of a way. Coordinates must match an existing node in the way's node list.
- `excludedWays` is optional. It documents ways that were intentionally omitted. This helps validation: the build step can warn about ways present in the ways file but absent from all layouts and not listed in `excludedWays`.

---

### Step 4 Output — Runtime Geometry File

**Location**: `src/generated/geometry/{wikidataId}.json`

Same format as today, ensuring backward compatibility with the runtime loader. Only tracks that have a layout file in Step 3 will have this file generated.

```jsonc
{
  "trackId": "Q171402",
  "name": "Silverstone Circuit",
  "source": {
    "kind": "osm-prebuilt",
    "generatedAt": "2026-04-11T12:00:00.000Z",
    "pipelineVersion": 2
  },
  "center": {
    "lat": 52.0786,
    "lon": -1.0169
  },
  "names": {
    "searchLabel": "Silverstone Circuit",
    "shortName": "Silverstone"
  },
  "layouts": [
    {
      "id": "grand-prix",
      "name": "Grand Prix",
      "nodes": [
        { "lat": 52.0710, "lon": -1.0228 },
        { "lat": 52.0712, "lon": -1.0225 }
        // ... stitched, ordered node chain
      ],
      "stats": {
        "lengthMetres": 5891,
        "segmentCount": 27
      }
    },
    {
      "id": "national",
      "name": "National",
      "nodes": [ /* ... */ ],
      "stats": {
        "lengthMetres": 2639,
        "segmentCount": 12
      }
    },
    {
      "id": "international",
      "name": "International",
      "nodes": [ /* ... */ ],
      "stats": {
        "lengthMetres": 2979,
        "segmentCount": 16
      }
    }
  ],
  "selectedLayoutIndex": 0
}
```

---

### Simple Track Example — Adelaide Street Circuit

A track with a single layout and no way slicing.

**Ways file** (`src/generated/geometry/ways/Q83234.json`):
```jsonc
{
  "trackId": "Q83234",
  "fetchedAt": "2026-04-11T10:30:00.000Z",
  "center": { "lat": -34.930466, "lon": 138.620609 },
  "boundingBox": {
    "south": -34.945,
    "west": 138.605,
    "north": -34.915,
    "east": 138.635
  },
  "ways": [
    {
      "id": 110291837,
      "tags": { "highway": "raceway", "sport": "motor", "name": "Adelaide Parklands Circuit" },
      "nodes": [ /* ... full node chain ... */ ]
    },
    {
      "id": 110291838,
      "tags": { "highway": "raceway", "sport": "motor" },
      "nodes": [ /* ... */ ]
    },
    {
      "id": 110291839,
      "tags": { "highway": "raceway", "sport": "motor" },
      "nodes": [ /* ... */ ]
    }
  ]
}
```

**Layout file** (`src/generated/geometry/layouts/Q83234.json`):
```jsonc
{
  "trackId": "Q83234",
  "name": "Adelaide Street Circuit",

  "layouts": {
    "Main": {
      "ways": [
        { "wayId": 110291837 },
        { "wayId": 110291838 },
        { "wayId": 110291839 }
      ]
    }
  }
}
```

---

## Sample OSM Structures

For reference, here is what the raw OSM data looks like for these tracks. The pipeline queries the OSM API with a bounding box and filters the response.

### OSM Way (XML from API)

```xml
<way id="3571477" visible="true" version="15">
  <nd ref="25552744"/>
  <nd ref="25552745"/>
  <nd ref="25552746"/>
  <!-- ... more node references ... -->
  <tag k="highway" v="raceway"/>
  <tag k="sport" v="motor"/>
  <tag k="name" v="Silverstone Circuit"/>
  <tag k="surface" v="asphalt"/>
  <tag k="wikidata" v="Q171402"/>
</way>
```

### OSM Node (XML from API)

```xml
<node id="25552744" lat="52.0710234" lon="-1.0228456" visible="true" version="3"/>
```

### OSM Relation (for context — not used by v2 pipeline)

```xml
<!-- Relations exist but are NOT consumed by the pipeline.
     They are unreliable for layout definition. -->
<relation id="2345678" visible="true">
  <member type="way" ref="3571477" role=""/>
  <member type="way" ref="169730585" role=""/>
  <tag k="type" v="route"/>
  <tag k="name" v="Grand Prix Circuit"/>
</relation>
```

---

## Build Steps Summary

| Step | Trigger | Input | Output | Automated? |
|------|---------|-------|--------|------------|
| 1 | `npm run build:search-index` | Wikidata SPARQL | `track-search-index.json` | Yes (existing) |
| 2 | `npm run build:ways` | Search index + OSM API | `geometry/ways/{id}.json` | Yes |
| 3 | Manual authoring | Ways files + OSM inspector | `geometry/layouts/{id}.json` | No |
| 4 | `npm run build:geometry` | Ways files + Layout files | `geometry/{id}.json` | Yes |

---

## Validation Rules (Step 4)

The build step should fail with a clear error if any of these conditions are violated:

1. **Way existence**: Every `wayId` in a layout file must exist in the corresponding ways file.
2. **Node existence**: Every `fromNode`/`toNode` coordinate must match an existing node in the referenced way (within a small tolerance, e.g. 1e-7 degrees).
3. **Continuity**: After slicing, consecutive ways in a layout must share an endpoint (the last node of way N must equal the first node of way N+1, or vice versa if the way needs reversing).
4. **Closure**: The stitched chain must form a closed loop (first node ≈ last node).
5. **Reasonable length**: The computed layout length should be > 500m and < 30km. Outliers get a warning.
6. **No orphaned ways**: Ways in the ways file that appear in no layout and are not in `excludedWays` produce a warning (not a hard error — new ways may appear in OSM before the layout file is updated).

---

## Migration Path

The current `TRACK_BUILD_OVERRIDES` map with `manualLayoutWays` entries is conceptually equivalent to the new layout files. Migration:

1. Run Step 2 for all tracks to populate the `ways/` directory.
2. For tracks that currently have `manualLayoutWays` overrides (Silverstone, Spa, Bahrain, Road Atlanta, Le Mans), convert each override into a layout JSON file.
3. For tracks that currently rely on automated layout detection, create layout files manually (this is the bulk of the work, but ensures correctness).
4. Once all desired tracks have layout files, switch the runtime to read from the new geometry output and remove the old pipeline code.
