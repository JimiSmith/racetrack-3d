import { measureDistanceMetres } from './geo-math.js';
import type { LatLon, LayoutWayEntry, OutputWay } from './types.js';

const COORD_TOLERANCE = 1e-7; // degrees — matches OSM node precision
const CLOSURE_TOLERANCE_METRES = 50;

/** Check whether two coordinates refer to the same OSM node. */
export function coordsMatch(a: LatLon, b: LatLon, tolerance = COORD_TOLERANCE): boolean {
  return Math.abs(a.lat - b.lat) < tolerance && Math.abs(a.lon - b.lon) < tolerance;
}

/**
 * Slice a way's node list between optional anchor coordinates.
 * Throws if an anchor coordinate does not match any node in the way.
 */
export function sliceWayNodes(
  wayId: number,
  nodes: LatLon[],
  fromNode?: LatLon,
  toNode?: LatLon,
): LatLon[] {
  let startIndex = 0;
  let endIndex = nodes.length - 1;

  if (fromNode) {
    const idx = nodes.findIndex(n => coordsMatch(n, fromNode));
    if (idx === -1) {
      throw new Error(
        `Way ${wayId}: fromNode (${fromNode.lat}, ${fromNode.lon}) does not match any node in the way`,
      );
    }
    startIndex = idx;
  }

  if (toNode) {
    // Search forward from startIndex
    let idx = -1;
    for (let i = startIndex; i < nodes.length; i++) {
      if (coordsMatch(nodes[i]!, toNode)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      throw new Error(
        `Way ${wayId}: toNode (${toNode.lat}, ${toNode.lon}) does not match any node in the way`,
      );
    }
    endIndex = idx;
  }

  return nodes.slice(startIndex, endIndex + 1);
}

/** Result of stitching a single layout. */
export interface StitchResult {
  nodes: LatLon[];
  segmentCount: number;
}

/**
 * Stitch an ordered list of ways into a single continuous node chain.
 *
 * The first way's direction is ambiguous and resolved by looking at the second way.
 * Subsequent ways are oriented by matching endpoints with the chain tail.
 * Shared join nodes are deduplicated.
 */
export function stitchLayout(
  layoutName: string,
  wayEntries: LayoutWayEntry[],
  wayIndex: Map<number, OutputWay>,
): StitchResult {
  if (wayEntries.length === 0) {
    throw new Error(`Layout "${layoutName}": no ways defined`);
  }

  // Resolve and slice all ways up front
  const slicedWays: LatLon[][] = [];
  for (const entry of wayEntries) {
    const way = wayIndex.get(entry.wayId);
    if (!way) {
      throw new Error(
        `Layout "${layoutName}": way ${entry.wayId} not found in ways file. ` +
        `Re-run import-osm-data for this track.`,
      );
    }
    const sliced = sliceWayNodes(entry.wayId, way.nodes, entry.fromNode, entry.toNode);
    if (sliced.length < 2) {
      throw new Error(
        `Layout "${layoutName}": way ${entry.wayId} has fewer than 2 nodes after slicing`,
      );
    }
    slicedWays.push(sliced);
  }

  // Single-way layout: accept as-is
  if (slicedWays.length === 1) {
    return { nodes: slicedWays[0]!, segmentCount: 1 };
  }

  // Resolve first way orientation using the second way
  const first = slicedWays[0]!;
  const second = slicedWays[1]!;
  const chain: LatLon[] = resolveFirstTwoWays(layoutName, first, second, wayEntries);

  // Stitch remaining ways
  for (let i = 2; i < slicedWays.length; i++) {
    const way = slicedWays[i]!;
    const entry = wayEntries[i]!;
    appendWay(layoutName, chain, way, entry.wayId);
  }

  // Validate closure
  validateClosure(layoutName, chain);

  return { nodes: chain, segmentCount: wayEntries.length };
}

/**
 * Determine the orientation of the first two ways and return the initial chain.
 */
function resolveFirstTwoWays(
  layoutName: string,
  first: LatLon[],
  second: LatLon[],
  entries: LayoutWayEntry[],
): LatLon[] {
  const fFirst = first[0]!;
  const fLast = first[first.length - 1]!;
  const sFirst = second[0]!;
  const sLast = second[second.length - 1]!;

  // chain[last] ≈ way[first]: both in correct order
  if (coordsMatch(fLast, sFirst)) {
    return [...first, ...second.slice(1)];
  }
  // chain[last] ≈ way[last]: first correct, second reversed
  if (coordsMatch(fLast, sLast)) {
    return [...first, ...second.slice(0, -1).reverse()];
  }
  // chain[first] ≈ way[first]: first reversed, second correct
  if (coordsMatch(fFirst, sFirst)) {
    return [...first.slice().reverse(), ...second.slice(1)];
  }
  // chain[first] ≈ way[last]: first reversed, second reversed
  if (coordsMatch(fFirst, sLast)) {
    return [...first.slice().reverse(), ...second.slice(0, -1).reverse()];
  }

  const gap = Math.min(
    measureDistanceMetres(fLast, sFirst),
    measureDistanceMetres(fLast, sLast),
    measureDistanceMetres(fFirst, sFirst),
    measureDistanceMetres(fFirst, sLast),
  );

  throw new Error(
    `Layout "${layoutName}": ways ${entries[0]!.wayId} and ${entries[1]!.wayId} ` +
    `do not share an endpoint (closest gap: ${gap.toFixed(1)}m)`,
  );
}

/**
 * Append a way to the chain, orienting it so that its start matches the chain tail.
 */
function appendWay(layoutName: string, chain: LatLon[], way: LatLon[], wayId: number): void {
  const chainTail = chain[chain.length - 1]!;
  const wayFirst = way[0]!;
  const wayLast = way[way.length - 1]!;

  if (coordsMatch(chainTail, wayFirst)) {
    for (let i = 1; i < way.length; i++) {
      chain.push(way[i]!);
    }
  } else if (coordsMatch(chainTail, wayLast)) {
    for (let i = way.length - 2; i >= 0; i--) {
      chain.push(way[i]!);
    }
  } else {
    const gap = Math.min(
      measureDistanceMetres(chainTail, wayFirst),
      measureDistanceMetres(chainTail, wayLast),
    );
    throw new Error(
      `Layout "${layoutName}": way ${wayId} does not connect to the previous way ` +
      `(gap: ${gap.toFixed(1)}m)`,
    );
  }
}

/**
 * Validate that the stitched chain forms a closed loop.
 * Snaps the last node to the first if they are within coordinate tolerance.
 */
function validateClosure(layoutName: string, chain: LatLon[]): void {
  if (chain.length < 2) return;

  const first = chain[0]!;
  const last = chain[chain.length - 1]!;

  if (coordsMatch(first, last)) {
    // Snap to exact closure
    chain[chain.length - 1] = first;
    return;
  }

  const gap = measureDistanceMetres(first, last);
  if (gap > CLOSURE_TOLERANCE_METRES) {
    throw new Error(
      `Layout "${layoutName}": chain does not form a closed loop ` +
      `(gap: ${gap.toFixed(1)}m between first and last node)`,
    );
  }

  // Within tolerance — snap to close
  chain[chain.length - 1] = first;
}
