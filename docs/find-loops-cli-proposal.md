# `find-loops` CLI Tool — Proposal

## Summary

A new command for the geometry import pipeline that enumerates all possible closed loops from the OSM ways at a given track. The output is a structured list of candidate racing layouts — complete with way IDs, ordering, `fromNode`/`toNode` slice coordinates, and named sections — that an LLM agent (or human) can then filter and classify into a final layout file.

This tool sits between Step 2 (import-osm-data) and Step 3 (manual layout authoring) of the [v2 pipeline](geometry-pipeline-v2-proposal.md), replacing the blank-slate authoring problem with a classification problem.

---

## Motivation

Creating a layout file today requires a human to:

1. Open a ways file containing 2–87 raw OSM ways
2. Mentally construct an adjacency graph from node coordinates
3. Identify which subsets of ways form closed racing circuits
4. Determine the correct ordering for stitching
5. Figure out where layouts branch at interior nodes of shared ways and compute `fromNode`/`toNode` slice coordinates

Steps 1–5 are pure graph computation. Only the final decision — "which of these closed loops are real racing layouts, and what are they called?" — requires domain knowledge.

The `find-loops` tool performs steps 1–5 deterministically, producing a list of every valid closed loop. An LLM agent then handles classification: filtering out artefacts (pit lane shortcuts, service road loops), naming real layouts, and writing the layout file.

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  Step 2 Output — Ways File                                           │
│  src/generated/geometry/ways/{trackId}.json                          │
│  (all highway=raceway + sport=motor ways near the track)             │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  find-loops (this tool)                                              │
│                                                                      │
│  1. Build inverse node index (all nodes → way references)            │
│  2. Identify junction coordinates (nodes shared by 2+ ways)          │
│  3. Split ways into segments at interior junctions                   │
│  4. Build adjacency graph over segments                              │
│  5. Enumerate all simple closed loops (DFS, pruned by length)        │
│  6. Collapse cosmetic splits; emit fromNode/toNode for real slices   │
│                                                                      │
│  Output: src/generated/geometry/loops/{trackId}.json                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LLM agent or human                                                  │
│                                                                      │
│  - Reviews candidate loops                                           │
│  - Filters artefacts (pit lane routes, service road loops)           │
│  - Names real layouts                                                │
│  - Writes layout file: src/generated/geometry/layouts/{trackId}.json │
│  - Validates with: create-track-geometry --track {trackId} --force   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Algorithm

### Step 1 — Inverse node index

Build a map from every node coordinate (across all ways) to the ways that pass through it:

```
nodeIndex: Map<CoordKey, Array<{ wayId: number, nodeIndex: number }>>
```

Where `CoordKey` is `(lat, lon)` rounded to 7 decimal places (OSM node precision). This captures every connection — endpoint-to-endpoint, endpoint-to-interior, and interior-to-interior.

**Example (Spa, 41 ways):** 514 unique node coordinates indexed.

### Step 2 — Junction identification

A junction coordinate is any coordinate present in 2 or more distinct ways:

```
junctionCoords: Set<CoordKey> = { coord | nodeIndex[coord] spans ≥ 2 way IDs }
```

**Example (Spa):** 41 junction coordinates found, including:
- Endpoint junctions (e.g. Eau Rouge end → Raidillon start)
- Interior junctions (e.g. Raidillon node 16/24 → Rallycross circuit start, unnamed way node 11/12 → Rallycross circuit end)

### Step 3 — Segment splitting

Each way is split at every interior junction node into sub-segments. A segment inherits its parent way's ID, name tags, and node list, plus the index range it covers.

```
Segment {
  segmentId:  number       // unique within this run
  wayId:      number       // parent OSM way
  fromIdx:    number       // start node index within the parent way
  toIdx:      number       // end node index within the parent way
  fromCoord:  CoordKey     // coordinate of fromIdx node
  toCoord:    CoordKey     // coordinate of toIdx node
  length:     number       // polyline length in metres
  name:       string       // from parent way's name tag
}
```

A way with no interior junctions produces a single segment spanning `[0, nodeCount-1]`. A way with `k` interior junctions produces `k+1` segments (or fewer if some junctions coincide with endpoints).

**Example (Spa):** 41 ways → 47 segments. Ways that split:
| Way | Name | Nodes | Interior junctions | Segments |
|-----|------|-------|--------------------|----------|
| 126835637 | Raidillon | 25 | node 16 (Rallycross) | `[0:16]`, `[16:24]` |
| 126807110 | (unnamed) | 13 | node 11 (Rallycross) | `[0:11]`, `[11:12]` |
| 126835638 | Kemmel | 18 | node 12 (Support Pit Lane) | `[0:12]`, `[12:17]` |
| 323851541 | Pit Lane | 47 | node 38 (Support Pit Lane) | `[0:38]`, `[38:46]` |
| 689853534 | Rallycross circuit | 20 | nodes 14, 15 (Joker lap, Rallycross start) | `[0:14]`, `[14:15]`, `[15:19]` |

### Step 4 — Adjacency graph

Vertices are junction coordinates. Edges are segments. Two segments are adjacent if they share a junction coordinate endpoint.

```
adj: Map<CoordKey, Array<{ toCoord: CoordKey, segmentId: number }>>
```

### Step 5 — Cycle enumeration

Depth-first search from every junction vertex, collecting all simple cycles (no vertex revisited). Pruning:

- **Length window:** Discard cycles with total length < 200m or > 30,000m.
- **Depth cap:** Abort traversal at a configurable maximum depth (default: 50 segments). This prevents combinatorial explosion on dense graphs.

Deduplication: two cycles are identical if they contain the same set of segment IDs (regardless of traversal direction or start vertex).

**Example (Spa):** 26 unique closed loops found, ranging from 636m to 7,465m.

### Step 6 — Collapse and emit

For each loop, collapse the segment list back into way-level entries:

1. **Full-way usage:** If a loop uses every segment of a split way, merge them back into a single entry with no `fromNode`/`toNode`. The way is used in its entirety.

2. **Partial-way usage:** If a loop uses only some segments of a split way, emit one entry per contiguous run of segments, with `fromNode` and/or `toNode` set to the junction coordinate where the slice occurs.

3. **Ordering:** Emit ways in traversal order (the stitching sequence). The stitcher handles direction resolution, so the traversal order is sufficient.

---

## Output Format

**Location:** `src/generated/geometry/loops/{trackId}.json`

```jsonc
{
  "trackId": "Q172851",
  "generatedAt": "2026-04-11T16:00:00.000Z",
  "waysFileHash": "sha256:abc123...",  // detect stale loops if ways change
  "stats": {
    "totalWays": 41,
    "junctionCoords": 41,
    "segments": 47,
    "loopsFound": 26
  },

  "loops": [
    {
      "loopId": 1,
      "lengthMetres": 7003,
      "wayCount": 30,
      "namedSections": [
        "Blanchimont", "Bruxelles", "Campus", "Chicane", "Courbe Paul Frère",
        "Double Gauche", "Eau Rouge", "Fagnes", "Kemmel", "La Source",
        "Les Combes", "Malmedy", "Raidillon", "Speaker's Corner"
      ],
      "ways": [
        { "wayId": 175178443, "usage": "full" },
        { "wayId": 175178448, "usage": "full" },
        { "wayId": 126807110, "usage": "full" },
        { "wayId": 126835639, "usage": "full" },
        { "wayId": 126835637, "usage": "full" },
        // ... remaining full ways ...
      ]
    },
    {
      "loopId": 2,
      "lengthMetres": 6985,
      "wayCount": 30,
      "namedSections": [
        "Blanchimont", "Bruxelles", "Campus", "Chicane", "Courbe Paul Frère",
        "Double Gauche", "Eau Rouge", "Fagnes", "Kemmel", "La Source",
        "Les Combes", "Malmedy", "Moto layout", "Raidillon"
      ],
      "ways": [
        // ... same as loop 1 but with wayId 1134119259 (Moto layout)
        // instead of 126807106 (Speaker's Corner) ...
      ]
    },
    {
      "loopId": 24,
      "lengthMetres": 992,
      "wayCount": 7,
      "namedSections": ["Eau Rouge", "Raidillon", "Rallycross circuit"],
      "ways": [
        { "wayId": 126835637, "usage": "partial",
          "toNode": { "lat": 50.4411262, "lon": 5.9719918 },
          "name": "Raidillon" },
        { "wayId": 689853533, "usage": "full", "name": "Rallycross circuit" },
        { "wayId": 1467574854, "usage": "full", "name": "Rallycross circuit" },
        { "wayId": 689853534, "usage": "full", "name": "Rallycross circuit" },
        { "wayId": 1467574855, "usage": "full", "name": "Rallycross circuit" },
        { "wayId": 126807110, "usage": "partial",
          "fromNode": { "lat": 50.4429533, "lon": 5.9698663 },
          "name": "(unnamed)" },
        { "wayId": 126835639, "usage": "full", "name": "Eau Rouge" }
      ]
    }
    // ... 23 more loops ...
  ],

  // Ways not used in any loop
  "unusedWays": [
    { "wayId": 711703474, "name": "Rallycross start" },
    { "wayId": 126807525, "name": "Support Pit Lane" }
  ]
}
```

### Per-way entry schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `wayId` | `number` | yes | OSM way ID. |
| `usage` | `"full" \| "partial"` | yes | Whether the loop uses the entire way or a slice. |
| `name` | `string` | yes | Way's `name` tag from OSM, or `"(unnamed)"`. |
| `fromNode` | `{ lat, lon }` | when partial | Slice start coordinate. Omitted if the slice starts at the way's first node. |
| `toNode` | `{ lat, lon }` | when partial | Slice end coordinate. Omitted if the slice ends at the way's last node. |

---

## CLI Interface

```
npx tsx utils/geometry-import/main.ts find-loops [options]
```

| Option | Description |
|--------|-------------|
| `--track <ids>` | Comma-separated Wikidata IDs (e.g. `Q172851`). If omitted, processes all tracks with ways files. |
| `--max-depth <n>` | Maximum DFS traversal depth in segments (default: 50). Increase for tracks with many small ways. |
| `--min-length <m>` | Minimum loop length in metres (default: 200). |
| `--max-length <m>` | Maximum loop length in metres (default: 30000). |
| `--force` | Overwrite existing loops file. |
| `--dry-run` | Print stats without writing files. |

---

## Validation Against Known Layouts

The algorithm has been prototyped against the Spa-Francorchamps ways file (41 ways). Results:

| Known layout | Length | Found? | Loop details |
|---|---|---|---|
| Grand Prix | ~7,003m | Yes | Loop with 30 full ways. Way set matches the human-authored layout exactly. |
| Moto | ~6,985m | Yes | Loop with 30 full ways. Differs from Grand Prix by one way swap (Speaker's Corner ↔ Moto layout). |
| Rallycross | ~992m | Yes | Loop with 7 ways, 2 of which are partial (Raidillon sliced at node 16, unnamed way sliced at node 11). Slice coordinates match the human-authored `fromNode`/`toNode` values exactly. |

The tool also found 23 additional loops that are not real racing layouts — combinations involving pit lanes, support roads, and joker lap detours. These are the artefacts that the LLM agent filters out during classification.

---

## Combinatorial Bounds

The number of loops found depends on the graph structure:

| Track | Ways | Expected junction density | Concern |
|---|---|---|---|
| Simple (2–6 ways) | Low | 1–2 junctions, 1–2 loops | Trivial |
| Medium (7–30 ways) | Moderate | 3–5 junctions, 5–30 loops | Manageable |
| Complex (30–87 ways) | High | 5+ junctions, potentially hundreds of loops | Needs pruning |

For complex tracks, additional pruning strategies:

1. **Loop grouping:** Loops that share >90% of their way set are near-duplicates (e.g. same circuit but routing through the pit lane instead of the main straight). Group them and present one representative per group, with the variants noted.

2. **Dead-end filtering:** Ways whose endpoints connect to only one other way (degree-1 vertices in the segment graph) cannot be part of any cycle. Prune them before DFS. At Spa, this would remove the "Rallycross start" way immediately.

3. **Depth cap:** The `--max-depth` flag prevents unbounded traversal. For most tracks, the longest real layout uses fewer than 35 ways, so a default of 50 provides headroom without explosion.

---

## Intended Consumer: LLM Agent Workflow

The `find-loops` output is designed to be consumed by an LLM agent that automates layout file authoring. The agent's workflow:

1. **Read** the loops file for a track.
2. **Classify** each loop: real racing layout, pit lane route, artefact, or duplicate variant.
3. **Name** real layouts using the track name and named sections (e.g. "Grand Prix", "National", "Rallycross").
4. **Select** one representative loop per real layout. For loops where a partial way is used, the `fromNode`/`toNode` coordinates are already computed — copy them directly.
5. **Write** the layout file in the format specified by the [v2 proposal](geometry-pipeline-v2-proposal.md#step-3-input--layout-file).
6. **Populate** `excludedWays` from the `unusedWays` list plus any ways that only appear in rejected loops.
7. **Validate** by running `create-track-geometry --track {trackId} --force` and fixing any errors.

The key property: the LLM never reasons about node coordinates or graph connectivity. It receives pre-computed, pre-ordered, pre-sliced loop candidates and makes a domain-knowledge decision about which ones are real.

---

## Implementation Location

New files within the existing `utils/geometry-import/` structure:

```
utils/geometry-import/
  commands/
    find-loops.ts          # Command entry point (reads ways, writes loops)
  lib/
    loop-finder.ts         # Core algorithm (node index, splitting, DFS, collapsing)
    cli.ts                 # Add parseFindLoopsArgs
    types.ts               # Add FindLoopsOptions, LoopCandidate, LoopsFile types
  main.ts                  # Add find-loops to the command switch
```

The existing `geo-math.ts` (polyline length, distance) and `stitch.ts` (`coordsMatch` tolerance constant) are reused.
