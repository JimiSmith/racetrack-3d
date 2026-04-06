/**
 * Way-graph construction and cycle detection.
 * Builds a node/edge adjacency structure from OSM ways and finds backbone cycles.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Way, WayGraph, WayGraphEdge, WayGraphVertex } from '../types/geometry.js';
import { measurePolylineLength, computeBoundingBoxArea } from './geo-math.js';
import { SNAP_FUZZY, dedupeSequentialNodes } from './chain-cleanup.js';

/** A cycle candidate built from a subset of graph edges. */
export interface CycleCandidate {
  /** Ordered edge IDs that form this cycle. */
  edgeIds: number[];
  /** Ordered nodes around the cycle. */
  nodes: LatLonNode[];
  /** Total length in metres. */
  length: number;
  /** Bounding-box area in square metres. */
  area: number;
  /** Number of edges in the cycle. */
  segments: number;
}

/**
 * Build a string key for a way endpoint that snaps nearby nodes together.
 * Used to identify shared vertices across ways.
 */
function makeEndpointKey(node: LatLonNode): string {
  return `${Math.round(node.lat / SNAP_FUZZY)}:${Math.round(node.lon / SNAP_FUZZY)}`;
}

/**
 * Build a node/edge adjacency graph from a list of ways.
 * Each way becomes an edge; shared endpoints (within SNAP_FUZZY) become vertices.
 */
export function buildWayGraph(ways: Way[]): WayGraph {
  const vertices = new Map<string, WayGraphVertex>();
  const edges: WayGraphEdge[] = [];

  function ensureVertex(node: LatLonNode): WayGraphVertex {
    const key = makeEndpointKey(node);
    let vertex = vertices.get(key);
    if (!vertex) {
      vertex = { id: key, node, edges: [] };
      vertices.set(key, vertex);
    }
    return vertex;
  }

  for (const way of ways) {
    // Safe: way.nodes is a non-empty array per the Way interface contract.
    const startNode = way.nodes[0] as LatLonNode;
    const endNode = way.nodes[way.nodes.length - 1] as LatLonNode;
    const start = ensureVertex(startNode);
    const end = ensureVertex(endNode);
    const edge: WayGraphEdge = {
      id: edges.length,
      start: start.id,
      end: end.id,
      nodes: way.nodes,
      tags: way.tags ?? {},
      length: measurePolylineLength(way.nodes),
    };

    edges.push(edge);
    start.edges.push(edge.id);
    end.edges.push(edge.id);
  }

  return { vertices, edges };
}

/**
 * Reconstruct an ordered cycle (closed node chain) from a set of edge IDs in a graph.
 * Returns null if the edge set does not form a valid simple cycle (each vertex must
 * have degree exactly 2 within the subgraph).
 */
export function buildCycleFromEdges(graph: WayGraph, edgeIds: number[]): CycleCandidate | null {
  if (!edgeIds.length) {
    return null;
  }

  const adjacency = new Map<string, number[]>();
  for (const edgeId of edgeIds) {
    // Safe: edgeId comes from graph.edges indices.
    const edge = graph.edges[edgeId] as WayGraphEdge;

    if (!adjacency.has(edge.start)) { adjacency.set(edge.start, []); }
    if (!adjacency.has(edge.end)) { adjacency.set(edge.end, []); }
    (adjacency.get(edge.start) as number[]).push(edgeId);
    (adjacency.get(edge.end) as number[]).push(edgeId);
  }

  for (const connectedEdgeIds of adjacency.values()) {
    if (connectedEdgeIds.length !== 2) {
      return null;
    }
  }

  // Safe: edgeIds is non-empty (checked above).
  const firstEdgeId = edgeIds[0] as number;
  const firstEdge = graph.edges[firstEdgeId] as WayGraphEdge;
  const startVertexId = firstEdge.start;
  let currentVertexId = firstEdge.end;
  let previousEdgeId = firstEdgeId;
  let orderedNodes = [...firstEdge.nodes];
  const orderedEdgeIds = [firstEdgeId];
  const visitedEdges = new Set([firstEdgeId]);

  while (currentVertexId !== startVertexId) {
    const nextEdgeId = adjacency.get(currentVertexId)?.find(edgeId => edgeId !== previousEdgeId);
    if (nextEdgeId == null || visitedEdges.has(nextEdgeId)) {
      return null;
    }

    const nextEdge = graph.edges[nextEdgeId] as WayGraphEdge;
    const forward = nextEdge.start === currentVertexId;
    const orientedNodes = forward ? nextEdge.nodes : [...nextEdge.nodes].reverse();
    orderedNodes.push(...orientedNodes.slice(1));
    orderedEdgeIds.push(nextEdgeId);
    visitedEdges.add(nextEdgeId);
    previousEdgeId = nextEdgeId;
    currentVertexId = forward ? nextEdge.end : nextEdge.start;
  }

  if (visitedEdges.size !== edgeIds.length) {
    return null;
  }

  orderedNodes = dedupeSequentialNodes(orderedNodes);

  return {
    edgeIds: orderedEdgeIds,
    nodes: orderedNodes,
    length: orderedEdgeIds.reduce((sum, edgeId) => sum + (graph.edges[edgeId] as WayGraphEdge).length, 0),
    area: computeBoundingBoxArea(orderedNodes),
    segments: orderedEdgeIds.length,
  };
}

/**
 * Enumerate all simple cycle candidates in the graph using DFS from each vertex.
 * Returns only cycles with at least 4 nodes and 500m length.
 * Capped at 32 cycles to keep runtime bounded.
 */
function enumerateCycleCandidates(graph: WayGraph): CycleCandidate[] {
  const cycles = new Map<string, CycleCandidate>();
  const vertexIds = [...graph.vertices.keys()].sort();
  const maxDepth = Math.max(graph.edges.length + 1, 8);
  const maxCycles = 32;
  let limitReached = false;

  function visit(
    startVertexId: string,
    currentVertexId: string,
    pathEdgeIds: number[],
    visitedVertices: Set<string>,
  ): void {
    if (limitReached || pathEdgeIds.length > maxDepth) {
      return;
    }

    const vertex = graph.vertices.get(currentVertexId);
    if (!vertex) {
      return;
    }

    for (const edgeId of vertex.edges) {
      // Safe: edgeId comes from vertex.edges which references valid graph edge indices.
      const edge = graph.edges[edgeId] as WayGraphEdge;
      const nextVertexId = edge.start === currentVertexId ? edge.end : edge.start;

      if (pathEdgeIds.includes(edgeId)) {
        continue;
      }

      if (nextVertexId === startVertexId) {
        if (pathEdgeIds.length >= 1) {
          const sortedEdgeIds = [...pathEdgeIds, edgeId].sort((a, b) => a - b);
          const key = sortedEdgeIds.join(',');
          if (!cycles.has(key)) {
            const cycle = buildCycleFromEdges(graph, sortedEdgeIds);
            if (cycle !== null && cycle.nodes.length >= 4 && cycle.length >= 500) {
              cycles.set(key, cycle);
              if (cycles.size >= maxCycles) {
                limitReached = true;
                return;
              }
            }
          }
        }
        continue;
      }

      if (visitedVertices.has(nextVertexId)) {
        continue;
      }

      visitedVertices.add(nextVertexId);
      visit(startVertexId, nextVertexId, [...pathEdgeIds, edgeId], visitedVertices);
      visitedVertices.delete(nextVertexId);
      if (limitReached) {
        return;
      }
    }
  }

  for (const startVertexId of vertexIds) {
    visit(startVertexId, startVertexId, [], new Set([startVertexId]));
    if (limitReached) {
      break;
    }
  }

  return [...cycles.values()];
}

/**
 * Find the best backbone cycle in the graph — the longest cycle by length,
 * with bounding-box area as a tiebreaker.
 * Returns null if no valid cycle exists.
 */
export function selectBackboneCycle(graph: WayGraph): CycleCandidate | null {
  const cycleCandidates = enumerateCycleCandidates(graph);
  return cycleCandidates.sort((a, b) => {
    const lengthDelta = b.length - a.length;
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }
    return b.area - a.area;
  })[0] ?? null;
}
