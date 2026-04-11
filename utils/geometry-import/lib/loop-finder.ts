import { measurePolylineLength } from './geo-math.js';
import { coordsMatch } from './stitch.js';
import type { FindLoopsResult, FoundLoop, LatLon, LayoutWayEntry, OutputWay, UnusedWayEntry, WaySegment } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Coordinate key: lat and lon rounded to 5dp (~1.1m buckets). */
type CoordKey = string;

interface NodeRef {
  wayId: number;
  nodeIndex: number;
  coord: LatLon;
}

interface AdjEntry {
  segment: WaySegment;
  targetVertex: CoordKey;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCoordKey(coord: LatLon): CoordKey {
  return `${coord.lat.toFixed(5)},${coord.lon.toFixed(5)}`;
}

// ---------------------------------------------------------------------------
// Step 1 — Inverse node index
// ---------------------------------------------------------------------------

function buildInverseNodeIndex(ways: OutputWay[]): Map<CoordKey, NodeRef[]> {
  const index = new Map<CoordKey, NodeRef[]>();

  for (const way of ways) {
    for (let i = 0; i < way.nodes.length; i++) {
      const coord = way.nodes[i]!;
      const key = buildCoordKey(coord);
      let bucket = index.get(key);
      if (!bucket) {
        bucket = [];
        index.set(key, bucket);
      }
      bucket.push({ wayId: way.id, nodeIndex: i, coord });
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Step 2 — Junction identification
// ---------------------------------------------------------------------------

function findJunctions(
  inverseIndex: Map<CoordKey, NodeRef[]>,
  ways: OutputWay[],
): Set<CoordKey> {
  const junctions = new Set<CoordKey>();

  // Rule 1: endpoint of every way is always a junction
  for (const way of ways) {
    if (way.nodes.length >= 2) {
      junctions.add(buildCoordKey(way.nodes[0]!));
      junctions.add(buildCoordKey(way.nodes[way.nodes.length - 1]!));
    }
  }

  // Rule 2: any coordinate shared by 2+ distinct ways (confirmed via coordsMatch)
  for (const [key, refs] of inverseIndex) {
    if (junctions.has(key)) continue;

    // Check for cross-way matches
    let found = false;
    for (let i = 0; i < refs.length && !found; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        if (refs[i]!.wayId !== refs[j]!.wayId && coordsMatch(refs[i]!.coord, refs[j]!.coord)) {
          found = true;
          break;
        }
      }
    }

    if (found) {
      junctions.add(key);
    }
  }

  return junctions;
}

// ---------------------------------------------------------------------------
// Step 3 — Segment splitting
// ---------------------------------------------------------------------------

function splitWaysIntoSegments(ways: OutputWay[], junctions: Set<CoordKey>): WaySegment[] {
  const segments: WaySegment[] = [];
  let nextId = 0;

  for (const way of ways) {
    if (way.nodes.length < 2) continue;

    // Collect junction indices within this way (always include first and last)
    const junctionIndices: number[] = [0];
    for (let i = 1; i < way.nodes.length - 1; i++) {
      if (junctions.has(buildCoordKey(way.nodes[i]!))) {
        junctionIndices.push(i);
      }
    }
    junctionIndices.push(way.nodes.length - 1);

    // Deduplicate (shouldn't happen, but be safe)
    const unique = [...new Set(junctionIndices)].sort((a, b) => a - b);

    // Create segments between consecutive junction indices
    const name = way.tags.name ?? '';

    for (let i = 0; i < unique.length - 1; i++) {
      const fromIdx = unique[i]!;
      const toIdx = unique[i + 1]!;
      if (toIdx - fromIdx < 1) continue;

      const segmentNodes = way.nodes.slice(fromIdx, toIdx + 1);

      segments.push({
        segmentId: nextId++,
        wayId: way.id,
        fromIdx,
        toIdx,
        fromCoord: way.nodes[fromIdx]!,
        toCoord: way.nodes[toIdx]!,
        lengthMetres: measurePolylineLength(segmentNodes),
        name,
      });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Step 4 — Adjacency graph
// ---------------------------------------------------------------------------

interface AdjGraph {
  adj: Map<CoordKey, AdjEntry[]>;
  vertices: Set<CoordKey>;
}

function buildAdjacencyGraph(segments: WaySegment[]): AdjGraph {
  const adj = new Map<CoordKey, AdjEntry[]>();
  const vertices = new Set<CoordKey>();

  function ensureVertex(key: CoordKey): void {
    vertices.add(key);
    if (!adj.has(key)) {
      adj.set(key, []);
    }
  }

  for (const segment of segments) {
    const fromKey = buildCoordKey(segment.fromCoord);
    const toKey = buildCoordKey(segment.toCoord);

    // Skip degenerate self-loop segments
    if (fromKey === toKey) continue;

    ensureVertex(fromKey);
    ensureVertex(toKey);

    // Always bidirectional: the oneway tag indicates racing direction for a
    // specific layout, not a physical road constraint.  Different circuit
    // configurations may traverse the same road segment in either direction.
    adj.get(fromKey)!.push({ segment, targetVertex: toKey });
    adj.get(toKey)!.push({ segment, targetVertex: fromKey });
  }

  return { adj, vertices };
}

// ---------------------------------------------------------------------------
// Step 5 — Cycle enumeration (DFS)
// ---------------------------------------------------------------------------

function enumerateCycles(
  graph: AdjGraph,
  options: { maxDepth: number; minLength: number; maxLength: number; maxLoops: number },
): Map<string, number[]> {
  const allCycles = new Map<string, number[]>();

  // Sort vertices for deterministic ordering; also used for the vertex-ordering optimization
  const sortedVertices = [...graph.vertices].sort();

  for (const startVertex of sortedVertices) {
    if (allCycles.size >= options.maxLoops) break;

    const visitedVertices = new Set<CoordKey>([startVertex]);
    const usedSegments = new Set<number>();
    const pathSegmentIds: number[] = [];

    dfs(startVertex, startVertex, visitedVertices, usedSegments, pathSegmentIds, 0);
  }

  function dfs(
    current: CoordKey,
    startVertex: CoordKey,
    visitedVertices: Set<CoordKey>,
    usedSegments: Set<number>,
    pathSegmentIds: number[],
    currentLength: number,
  ): void {
    if (allCycles.size >= options.maxLoops) return;

    const edges = graph.adj.get(current);
    if (!edges) return;

    for (const { segment, targetVertex } of edges) {
      if (allCycles.size >= options.maxLoops) return;
      if (usedSegments.has(segment.segmentId)) continue;

      const newLength = currentLength + segment.lengthMetres;

      if (targetVertex === startVertex) {
        // Closing the loop
        if (pathSegmentIds.length >= 1 && newLength >= options.minLength && newLength <= options.maxLength) {
          const cycleSegments = [...pathSegmentIds, segment.segmentId];
          const canonicalKey = cycleSegments.slice().sort((a, b) => a - b).join(',');
          if (!allCycles.has(canonicalKey)) {
            allCycles.set(canonicalKey, cycleSegments);
          }
        }
        continue;
      }

      // Vertex ordering prune: only visit vertices >= startVertex
      if (targetVertex < startVertex) continue;

      if (visitedVertices.has(targetVertex)) continue;
      if (newLength > options.maxLength) continue;
      if (pathSegmentIds.length + 1 >= options.maxDepth) continue;

      visitedVertices.add(targetVertex);
      usedSegments.add(segment.segmentId);
      pathSegmentIds.push(segment.segmentId);

      dfs(targetVertex, startVertex, visitedVertices, usedSegments, pathSegmentIds, newLength);

      pathSegmentIds.pop();
      usedSegments.delete(segment.segmentId);
      visitedVertices.delete(targetVertex);
    }
  }

  return allCycles;
}

// ---------------------------------------------------------------------------
// Step 6 — Collapse and emit
// ---------------------------------------------------------------------------

function collapseAndEmit(
  loopId: number,
  orderedSegmentIds: number[],
  segmentIndex: Map<number, WaySegment>,
  wayIndex: Map<number, OutputWay>,
  segmentsPerWay: Map<number, number>,
): FoundLoop {
  const segments = orderedSegmentIds.map(id => segmentIndex.get(id)!);

  // Group consecutive segments by wayId
  interface WayGroup {
    wayId: number;
    segments: WaySegment[];
  }

  const groups: WayGroup[] = [];
  for (const seg of segments) {
    const last = groups[groups.length - 1];
    if (last && last.wayId === seg.wayId) {
      last.segments.push(seg);
    } else {
      groups.push({ wayId: seg.wayId, segments: [seg] });
    }
  }

  // Merge wrap-around: if first and last group share the same wayId, merge last into first
  if (groups.length > 1 && groups[0]!.wayId === groups[groups.length - 1]!.wayId) {
    const lastGroup = groups.pop()!;
    groups[0]!.segments = [...lastGroup.segments, ...groups[0]!.segments];
  }

  // Convert groups to LayoutWayEntry-compatible entries
  const ways: LayoutWayEntry[] = [];
  let totalLength = 0;
  const nameSet = new Set<string>();

  for (const group of groups) {
    const way = wayIndex.get(group.wayId);
    const totalSegmentsForWay = segmentsPerWay.get(group.wayId) ?? 0;
    const isFullWay = group.segments.length === totalSegmentsForWay;

    // Collect names
    for (const seg of group.segments) {
      if (seg.name) nameSet.add(seg.name);
      totalLength += seg.lengthMetres;
    }

    if (isFullWay) {
      ways.push({ wayId: group.wayId });
    } else {
      // Find the min fromIdx and max toIdx across the group's segments
      const sortedSegs = group.segments.slice().sort((a, b) => a.fromIdx - b.fromIdx);
      const minFromIdx = sortedSegs[0]!.fromIdx;
      const maxToIdx = sortedSegs[sortedSegs.length - 1]!.toIdx;

      const lastNodeIdx = way ? way.nodes.length - 1 : -1;

      const entry: LayoutWayEntry = {
        wayId: group.wayId,
        ...(minFromIdx !== 0 && way ? { fromNode: way.nodes[minFromIdx]! } : {}),
        ...(maxToIdx !== lastNodeIdx && way ? { toNode: way.nodes[maxToIdx]! } : {}),
      };
      ways.push(entry);
    }
  }

  return {
    loopId,
    lengthMetres: Math.round(totalLength),
    wayCount: groups.length,
    namedSections: [...nameSet].sort(),
    ways,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function findLoops(
  ways: OutputWay[],
  options: { maxDepth: number; minLength: number; maxLength: number; maxLoops: number },
): FindLoopsResult {
  if (ways.length === 0) {
    return { junctionCount: 0, segmentCount: 0, loops: [], unusedWays: [] };
  }

  // Step 1: Inverse node index
  const inverseIndex = buildInverseNodeIndex(ways);

  // Step 2: Junction identification
  const junctions = findJunctions(inverseIndex, ways);

  // Step 3: Segment splitting
  const segments = splitWaysIntoSegments(ways, junctions);

  // Step 4: Adjacency graph
  const graph = buildAdjacencyGraph(segments);

  // Step 5: Cycle enumeration
  const startTime = performance.now();
  const cycles = enumerateCycles(graph, options);
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
  console.log(`  Enumerated ${cycles.size} unique loops in ${elapsed}s`);

  if (cycles.size >= options.maxLoops) {
    console.log(`  Warning: hit loop cap (${options.maxLoops}). Increase --max-loops to find more.`);
  }

  // Step 6: Collapse and emit
  const segmentIndex = new Map<number, WaySegment>();
  for (const seg of segments) {
    segmentIndex.set(seg.segmentId, seg);
  }

  const wayIndex = new Map<number, OutputWay>();
  for (const way of ways) {
    wayIndex.set(way.id, way);
  }

  // Count segments per way (for full-way detection)
  const segmentsPerWay = new Map<number, number>();
  for (const seg of segments) {
    segmentsPerWay.set(seg.wayId, (segmentsPerWay.get(seg.wayId) ?? 0) + 1);
  }

  const loops: FoundLoop[] = [];
  let loopId = 1;
  for (const orderedSegmentIds of cycles.values()) {
    loops.push(collapseAndEmit(loopId++, orderedSegmentIds, segmentIndex, wayIndex, segmentsPerWay));
  }

  // Sort by length ascending, re-number
  loops.sort((a, b) => a.lengthMetres - b.lengthMetres);
  for (let i = 0; i < loops.length; i++) {
    loops[i]!.loopId = i + 1;
  }

  // Unused ways
  const usedWayIds = new Set<number>();
  for (const loop of loops) {
    for (const entry of loop.ways) {
      usedWayIds.add(entry.wayId);
    }
  }

  const unusedWays: UnusedWayEntry[] = ways
    .filter(w => !usedWayIds.has(w.id))
    .map(w => ({ wayId: w.id, name: w.tags.name ?? '' }));

  return {
    junctionCount: junctions.size,
    segmentCount: segments.length,
    loops,
    unusedWays,
  };
}
