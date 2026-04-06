/**
 * Way stitching and connected-component selection.
 * Assembles OSM ways into ordered node chains and selects the best component.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Way } from '../types/geometry.js';
import { measurePolylineLength, computeBoundingBoxArea, computeEndpointGap, dist } from './geo-math.js';
import {
  SNAP_EXACT,
  SNAP_FUZZY,
  closeNodeChainIfNearClosed,
  dedupeSequentialNodes,
} from './chain-cleanup.js';
import { buildWayGraph, buildCycleFromEdges } from './way-graph.js';

/** A candidate route assembled from one or more ways. */
export interface WayCandidate {
  nodes: LatLonNode[];
  length: number;
  area: number;
  segments: number;
  endpointGap: number;
}

/**
 * Stitch a list of ways into a single ordered node chain.
 * Tries exact endpoint snapping first, then fuzzy snapping.
 * Returns an empty array if `ways` is empty.
 */
export function stitchWaysOrdered(ways: Way[]): LatLonNode[] {
  if (ways.length === 0) { return []; }
  if (ways.length === 1) { return ways[0]?.nodes ?? []; }

  const remaining = ways.map(w => ({ nodes: [...w.nodes] }));
  // Safe: remaining is non-empty (ways.length > 1 checked above).
  const chain = [...(remaining.shift() as { nodes: LatLonNode[] }).nodes];

  while (remaining.length > 0) {
    // Safe: chain is seeded with at least 1 node (from the first way).
    const chainStart = chain[0] as LatLonNode;
    const chainEnd = chain[chain.length - 1] as LatLonNode;
    let found = false;

    for (const snap of [SNAP_EXACT, SNAP_FUZZY]) {
      for (let i = 0; i < remaining.length; i++) {
        // Safe: i is a valid index into remaining.
        const way = remaining[i] as { nodes: LatLonNode[] };
        // Safe: way.nodes is non-empty (ways with < 2 nodes are excluded upstream).
        const wayStart = way.nodes[0] as LatLonNode;
        const wayEnd = way.nodes[way.nodes.length - 1] as LatLonNode;

        if (dist(chainEnd, wayStart) < snap) {
          chain.push(...way.nodes.slice(1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainEnd, wayEnd) < snap) {
          chain.push(...way.nodes.slice(0, -1).reverse());
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayEnd) < snap) {
          chain.unshift(...way.nodes.slice(0, -1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayStart) < snap) {
          chain.unshift(...way.nodes.slice(1).reverse());
          remaining.splice(i, 1); found = true; break;
        }
      }
      if (found) { break; }
    }

    if (!found) { break; } // no more connectable ways in this component
  }

  return chain;
}

/**
 * Measure the total arc length (in metres) of a set of ways.
 */
export function measureWaySetLength(ways: Way[]): number {
  return ways.reduce((sum, way) => sum + measurePolylineLength(way.nodes), 0);
}

/**
 * Build a route candidate from a list of ways: stitch them, close the chain if
 * near-closed, and return length/area/gap metrics.
 * Returns null for an empty way list.
 */
export function buildCandidateFromWays(ways: Way[]): WayCandidate | null {
  if (!ways.length) {
    return null;
  }

  const graph = buildWayGraph(ways);
  const edgeIds = graph.edges.map(edge => edge.id);
  const isSimpleLoop = graph.edges.length > 0
    && [...graph.vertices.values()].every(vertex => vertex.edges.length === 2);
  const cycleCandidate = isSimpleLoop ? buildCycleFromEdges(graph, edgeIds) : null;
  const stitchedNodes = cycleCandidate?.nodes ?? dedupeSequentialNodes(stitchWaysOrdered(ways));
  const nodes = closeNodeChainIfNearClosed(stitchedNodes);

  return {
    nodes,
    length: cycleCandidate?.length ?? measurePolylineLength(nodes),
    area: computeBoundingBoxArea(nodes),
    segments: ways.length,
    endpointGap: computeEndpointGap(nodes),
  };
}

/**
 * Group ways into connected components using endpoint proximity.
 * Returns arrays of way indices grouped by connectivity.
 */
export function buildConnectedComponents(ways: Way[]): number[][] {
  const n = ways.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    let i = x;
    // Safe: parent[i] is always initialised; loop terminates at the root.
    while (parent[i] !== i) { parent[i] = parent[parent[i] as number] as number; i = parent[i] as number; }
    return i;
  }
  function union(a: number, b: number): void { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    // Safe: i is a valid index into ways.
    const si = (ways[i] as Way).nodes[0] as LatLonNode;
    const ei = (ways[i] as Way).nodes[(ways[i] as Way).nodes.length - 1] as LatLonNode;
    for (let j = i + 1; j < n; j++) {
      // Safe: j is a valid index into ways.
      const sj = (ways[j] as Way).nodes[0] as LatLonNode;
      const ej = (ways[j] as Way).nodes[(ways[j] as Way).nodes.length - 1] as LatLonNode;
      if (dist(si, sj) < SNAP_FUZZY || dist(si, ej) < SNAP_FUZZY ||
          dist(ei, sj) < SNAP_FUZZY || dist(ei, ej) < SNAP_FUZZY) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) { groups.set(root, []); }
    (groups.get(root) as number[]).push(i);
  }
  return [...groups.values()];
}

/** Normalise a circuit name to lowercase alphanumeric tokens for fuzzy comparison. */
export function normalizeCircuitName(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Return true if `candidateName` and `trackName` refer to the same circuit. */
export function namesLikelyMatchCircuit(candidateName: string, trackName: string | null | undefined): boolean {
  const candidateKey = normalizeCircuitName(candidateName);
  const trackKey = normalizeCircuitName(trackName);

  if (!candidateKey || !trackKey) {
    return false;
  }

  return candidateKey === trackKey
    || candidateKey.includes(trackKey)
    || trackKey.includes(candidateKey);
}

interface NameEntry {
  name: string;
  source: 'way' | 'relation';
}

interface TaggedWay extends Way {
  tags: Record<string, unknown> & {
    name?: string;
    relationNames?: unknown;
  };
}

/** Collect all candidate name entries (from way tags and relation names) for a way. */
export function getWayCandidateNameEntries(way: Way): NameEntry[] {
  const entries: NameEntry[] = [];
  const seenNames = new Set<string>();

  const taggedWay = way as TaggedWay;
  const wayName = typeof taggedWay.tags?.name === 'string' ? taggedWay.tags.name.trim() : undefined;
  if (wayName) {
    seenNames.add(wayName);
    entries.push({ name: wayName, source: 'way' });
  }

  const relationNames = Array.isArray(taggedWay.tags?.relationNames)
    ? (taggedWay.tags.relationNames as unknown[])
    : [];
  for (const relationName of relationNames) {
    const trimmedName = typeof relationName === 'string' ? relationName.trim() : null;
    if (!trimmedName || seenNames.has(trimmedName)) {
      continue;
    }

    seenNames.add(trimmedName);
    entries.push({ name: trimmedName, source: 'relation' });
  }

  return entries;
}

/** Return all candidate names for a way (flattened from getWayCandidateNameEntries). */
export function getWayCandidateNames(way: Way): string[] {
  return getWayCandidateNameEntries(way).map(({ name }) => name);
}

/** Return true if any candidate name for `way` likely matches `trackName`. */
function wayLikelyMatchesCircuit(way: Way, trackName: string | null | undefined): boolean {
  return getWayCandidateNames(way).some(name => namesLikelyMatchCircuit(name, trackName));
}

/**
 * Given a list of ways potentially spanning multiple connected components,
 * return the ways belonging to the single best component.
 *
 * "Best" is determined by a multi-factor ranking: closed-loop priority,
 * track-name matching, total length, and bounding-box area.
 *
 * If there is only one component (or only one way), the original list is returned.
 */
export function selectBestComponentWays(ways: Way[], trackName: string | null = null): Way[] {
  if (ways.length <= 1) {
    return ways;
  }

  const components = buildConnectedComponents(ways);
  if (components.length <= 1) {
    return ways;
  }

  const rankedComponents = components.map(component => {
    const componentWays = component.map(index => ways[index] as Way);
    const candidate = buildCandidateFromWays(componentWays);
    const matchedWays = componentWays.filter(way => wayLikelyMatchesCircuit(way, trackName));
    const matchedLength = measureWaySetLength(matchedWays);
    const gapRatio = (candidate?.length ?? 0) > 0
      ? (candidate?.endpointGap ?? 0) / (candidate?.length ?? 1)
      : Infinity;
    const candidateLength = candidate?.length ?? 0;
    const strongTrackNameMatch = matchedLength >= Math.max(250, Math.min(1500, candidateLength * 0.18));
    const nearClosed = gapRatio <= 0.16;

    return {
      componentWays,
      candidate,
      matchedLength,
      hasTrackNameMatch: matchedWays.length > 0,
      strongTrackNameMatch,
      gapRatio,
      nearClosed,
      candidateLength,
      totalLength: measureWaySetLength(componentWays),
      totalNodes: componentWays.reduce((sum, way) => sum + way.nodes.length, 0),
      area: candidate?.area ?? 0,
    };
  });

  rankedComponents.sort((a, b) => {
    if (a.strongTrackNameMatch !== b.strongTrackNameMatch) {
      const namedComp = b.strongTrackNameMatch ? b : a;
      const otherComp = b.strongTrackNameMatch ? a : b;
      // Only give name-match absolute priority when the named component itself forms
      // a closed circuit, or neither does, or the size difference is negligible.
      // Otherwise a small open named fragment would beat a much larger closed circuit
      // (e.g. a pit straight named after the venue vs. the full public-road loop).
      const namedWins =
        namedComp.nearClosed ||
        !otherComp.nearClosed ||
        otherComp.candidateLength - namedComp.candidateLength <= 500;
      if (namedWins) {
        return Number(b.strongTrackNameMatch) - Number(a.strongTrackNameMatch);
      }
      // Fall through to length comparison
    }

    const candidateLengthDelta = b.candidateLength - a.candidateLength;
    if (Math.abs(candidateLengthDelta) > 500) {
      return candidateLengthDelta;
    }

    if (a.nearClosed !== b.nearClosed) {
      return Number(b.nearClosed) - Number(a.nearClosed);
    }

    if (a.hasTrackNameMatch !== b.hasTrackNameMatch) {
      return Number(b.hasTrackNameMatch) - Number(a.hasTrackNameMatch);
    }

    const gapRatioDelta = a.gapRatio - b.gapRatio;
    if (Math.abs(gapRatioDelta) > 0.08) {
      return gapRatioDelta;
    }

    const matchedLengthDelta = b.matchedLength - a.matchedLength;
    if (Math.abs(matchedLengthDelta) > 1) {
      return matchedLengthDelta;
    }

    const lengthDelta = b.totalLength - a.totalLength;
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }

    const areaDelta = b.area - a.area;
    if (Math.abs(areaDelta) > 1) {
      return areaDelta;
    }

    return b.totalNodes - a.totalNodes;
  });

  return rankedComponents[0]?.componentWays ?? ways;
}
