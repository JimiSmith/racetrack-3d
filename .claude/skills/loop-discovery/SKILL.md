---
name: loop-discovery
description: Workflow for discovering racing circuit layouts from OSM data and turning them into renderable track geometry. Use this skill whenever the task involves creating or updating a track's layout file, running the find-loops algorithm, analyzing loop candidates, selecting layouts for a circuit, running create-track-geometry, or debugging stitching/geometry issues. Triggers on: "create layouts for <track>", "find loops", "add a new track", "create track geometry", "generate layout file", "which loop is the GP circuit", "identify layouts from loops", "analyze loops output", "update excludedWays", or any work involving the files in utils/geometry-import/ or src/generated/geometry/layouts/.
---

# Loop Discovery and Layout Creation

This skill covers the full workflow for turning raw OSM way data into renderable track geometry: running the loop finder, analyzing candidates, authoring a layout file, and generating final geometry.

## Pipeline overview

```
ways file ──> find-loops ──> loops file ──> human/LLM analysis ──> layout file ──> create-track-geometry ──> geometry file
```

| Step | Input | Output | Command |
|------|-------|--------|---------|
| 2 | Search index | `src/generated/geometry/ways/<ID>.json` | `import-osm-data --track <ID>` |
| 2.5 | Ways file | `src/generated/geometry/loops/<ID>.json` | `find-loops --track <ID>` |
| 3 | Layout + ways files | `src/generated/geometry/<ID>.json` | `create-track-geometry --track <ID>` |

All commands are run as:
```bash
npx tsx utils/geometry-import/main.ts <command> [options]
```

## Step 1: Generate loops

Prerequisites: a ways file must exist at `src/generated/geometry/ways/<ID>.json`. If not, run `import-osm-data --track <ID>` first. If the ways data is empty after import, note and skip it. Do not investigate or invent.

```bash
npx tsx utils/geometry-import/main.ts find-loops --track Q171402 --force
```

Key options:
- `--max-depth 500` (default) — max DFS traversal depth in segments
- `--min-length 200` (default) — minimum loop length in metres
- `--max-length 30000` (default) — maximum loop length in metres
- `--max-loops 1000` (default) — cap on total loops emitted. Increase with `--max-loops 5000` for venues with many possible configurations

Output: `src/generated/geometry/loops/<ID>.json`

### Loops file structure

```json
{
  "trackId": "Q171402",
  "generatedAt": "...",
  "waysFileHash": "sha256:...",
  "stats": { "totalWays": 67, "junctionCoords": 48, "segments": 98, "loopsFound": 267 },
  "loops": [
    {
      "loopId": 1,
      "lengthMetres": 1280,
      "wayCount": 6,
      "namedSections": ["Stowe Circuit"],
      "ways": [
        { "wayId": 169851260 },
        { "wayId": 259160215 },
        { "wayId": 259160219 },
        { "wayId": 259160218 },
        { "wayId": 259160217 },
        { "wayId": 259160214 }
      ]
    }
  ],
  "unusedWays": [
    { "wayId": 224513497, "name": "" }
  ]
}
```

Each loop's `ways` array uses the `LayoutWayEntry` format — the same format used in layout files. This means loop entries can be copied directly into a layout file without transformation.

- `wayId` only: the entire way is used
- `fromNode: { lat, lon }`: the way is trimmed — starts at this coordinate instead of the way's first node
- `toNode: { lat, lon }`: the way is trimmed — ends at this coordinate instead of the way's last node

## Step 2: Analyze loops and identify layouts

This is the most judgment-intensive step. The goal is to match loop candidates to real-world racing layouts.

### Gather reference data

Look up the circuit on a reference site like racingcircuits.info to find:
- Layout names (e.g. "Grand Prix", "National", "International")
- Approximate lengths (e.g. 5.891 km, 2.638 km)
- Which layouts exist and are distinct
- You must validate the found loops against the reference data

### Match loops to layouts

For each known real-world layout:

1. **Filter by length** — find loops whose `lengthMetres` is close to the reference length (within ~5% is typical, OSM geometry won't match precisely)
2. **Check named sections** — the `namedSections` array shows which named OSM ways are included. Use this to verify the loop follows the expected route (e.g. a "National" circuit should include Copse, Maggotts, Becketts but not the Arena section)
3. **Check way count** — layouts using more of the circuit tend to have higher way counts
4. **Verify the route makes sense** — if two loops have similar length, compare their ways arrays to understand which roads each follows

### When a layout is missing from the loops file

If a known real-world layout doesn't appear in the loops output:

1. **Check `--max-loops`** — the default cap of 100 may cut off longer/more complex loops. Try `--max-loops 5000`
2. **Check `--max-depth`** — layouts that traverse many short segments may exceed the default depth of 50. Try `--max-depth 200`
3. **Check `--max-length`** — some layouts (like endurance circuits) exceed 30km. Increase with `--max-length 50000`
4. **Check that all necessary ways exist** — read the ways file and verify the connecting roads are present. Missing OSM data can't be fixed by the algorithm
5. **Do not manually construct layouts that should be discoverable** — fix the algorithm parameters or investigate the data gap instead

### Layouts that can't be found automatically

Some layouts genuinely can't be discovered by the loop finder because they require ways that aren't in the OSM data (e.g. historic layouts where the road no longer exists). These must be noted and skipped.

## Step 3: Create the layout file

Create `src/generated/geometry/layouts/<ID>.json` with this structure:

```json
{
  "trackId": "Q171402",
  "name": "Silverstone Circuit",
  "layouts": {
    "Grand Prix": {
      "ways": [
        { "wayId": 169733770 },
        { "wayId": 169733769 }
      ]
    },
    "National": {
      "ways": [
        { "wayId": 169730586, "toNode": { "lat": 52.0731007, "lon": -1.0096291 } },
        { "wayId": 169733768 }
      ]
    }
  },
  "excludedWays": [
    { "wayId": 3945001, "reason": "alternative Vale connector" },
    { "wayId": 227902927, "reason": "International pit lane" }
  ]
}
```

### Building the layouts object

For each identified layout:
1. Copy the `ways` array directly from the matching loop in the loops file
2. Use the layout's real-world name as the key (e.g. "Grand Prix", "National")

The `ways` arrays from loops already include `fromNode`/`toNode` trim coordinates where needed — they're ready to use as-is.

### Building the excludedWays array

The `excludedWays` list tells `create-track-geometry` which ways in the ways file are intentionally not part of any layout. This suppresses the "orphaned ways" warning.

Common reasons to exclude a way:
- **Pit lanes** — parallel to the main straight, not part of the racing line
- **Service roads** — access roads within the venue perimeter
- **Experience/drift tracks** — separate facilities within the venue (e.g. Silverstone's stunt driving tracks)
- **Alternative connectors** — roads that link sections but aren't used by any current layout
- **Paddock areas** — internal paddock roads

To find which ways need excluding:
1. Run `create-track-geometry` — it will warn about orphaned ways by ID
2. Look up each orphaned way ID in the ways file to understand what it is (check its `tags.name` and position)
3. Add it to `excludedWays` with a descriptive reason

### Track name

The `name` field should be the circuit's official name (e.g. "Silverstone Circuit", "Circuit Zandvoort"). This is used as the display name in the app.

## Step 4: Generate track geometry

```bash
npx tsx utils/geometry-import/main.ts create-track-geometry --track Q171402 --force
```

Output: `src/generated/geometry/<ID>.json`

This command:
1. Reads the layout file and ways file
2. Stitches each layout's ways into a continuous polyline
3. Validates lengths (warns if < 200m or > 30km)
4. Reports orphaned ways (ways in the ways file not used by any layout and not in excludedWays)
5. Writes the final geometry file

### Interpreting the output

```
Layout "Grand Prix": 27 ways, 5887m, 412 nodes
Layout "National": 12 ways, 2638m, 198 nodes
  Warning: 3 orphaned ways in ways file: 3945001, 227902927, 169854666
```

- **Way count and length** — cross-check these against reference data
- **Orphaned ways warning** — add these to `excludedWays` or investigate if they should be part of a layout
- **Stitching errors** — if a layout fails to stitch, the ways aren't forming a continuous path. Check way ordering and trim coordinates

### Validation checklist

After generating geometry, verify:
- [ ] All layout lengths are within ~5% of reference data
- [ ] No stitching errors
- [ ] No unexpected orphaned ways (all accounted for in excludedWays)
- [ ] Layout names match real-world names

## Algorithm details

The loop finder works in 6 steps:

1. **Inverse node index** — maps each coordinate (rounded to 5dp, ~1.1m buckets) to the ways that pass through it
2. **Junction identification** — a coordinate is a junction if it's shared by 2+ distinct ways (validated with `coordsMatch` at 1e-7 degree tolerance) or is a way endpoint
3. **Segment splitting** — each way is split at junction nodes into segments
4. **Adjacency graph** — all segments become bidirectional edges (oneway tags are ignored — they indicate racing direction for a specific layout, not physical road constraints)
5. **DFS cycle enumeration** — exhaustive depth-first search from each junction vertex, with pruning by max depth, max length, and vertex ordering
6. **Collapse and emit** — consecutive segments from the same way are merged back into `LayoutWayEntry` format with optional `fromNode`/`toNode` trim coordinates

### TypeScript constraint

The project uses `exactOptionalPropertyTypes: true`. When building `LayoutWayEntry` objects with optional `fromNode`/`toNode`, use conditional spreading:

```typescript
const entry: LayoutWayEntry = {
  wayId: group.wayId,
  ...(needsFrom ? { fromNode: coord } : {}),
  ...(needsTo ? { toNode: coord } : {}),
};
```

## File locations

| File | Path |
|------|------|
| Ways files (input) | `src/generated/geometry/ways/<ID>.json` |
| Loops files (intermediate) | `src/generated/geometry/loops/<ID>.json` |
| Layout files (authored) | `src/generated/geometry/layouts/<ID>.json` |
| Geometry files (output) | `src/generated/geometry/<ID>.json` |
| Loop finder algorithm | `utils/geometry-import/lib/loop-finder.ts` |
| Find-loops command | `utils/geometry-import/commands/find-loops.ts` |
| Create-track-geometry command | `utils/geometry-import/commands/create-track-geometry.ts` |
| CLI argument parsing | `utils/geometry-import/lib/cli.ts` |
| Type definitions | `utils/geometry-import/lib/types.ts` |
| Stitching logic | `utils/geometry-import/lib/stitch.ts` |
| Geo math utilities | `utils/geometry-import/lib/geo-math.ts` |

## Complete example: adding a new track

```bash
# 1. Import OSM data (if ways file doesn't exist yet)
npx tsx utils/geometry-import/main.ts import-osm-data --track Q173083

# 2. Find all loops
npx tsx utils/geometry-import/main.ts find-loops --track Q173083 --force

# 3. Read and analyze the loops file
# (examine loops, match to known layouts, identify excludedWays)

# 4. Create src/generated/geometry/layouts/Q173083.json
# (copy ways arrays from matching loops, add excludedWays)

# 5. Generate final geometry
npx tsx utils/geometry-import/main.ts create-track-geometry --track Q173083 --force

# 6. Verify output
# Check layout lengths match reference data
# Ensure no orphaned ways warnings (or add to excludedWays)
```
