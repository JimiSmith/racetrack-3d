/**
 * Fork/merge section detection for circuit graphs.
 * Identifies diverging sections (alternate routes) in a way graph.
 * No side effects. No DOM access.
 */

import type { LatLonNode, WayGraph, WayGraphEdge, WayGraphVertex } from '../types/geometry.js';
import { dedupeSequentialNodes } from './chain-cleanup.js';

/** A single branch connecting a fork vertex to a merge vertex. */
export interface ForkBranch {
  /** ID of the fork vertex (where this branch diverges). */
  startVertexId: string;
  /** ID of the merge vertex (where this branch rejoins). */
  endVertexId: string;
  /** Edge IDs that make up this branch. */
  edgeIds: number[];
  /** Ordered nodes along this branch. */
  nodes: LatLonNode[];
  /** Total length in metres. */
  length: number;
  /** True if any edge in this branch belongs to the backbone cycle. */
  onBackbone?: boolean;
}

/** A detected fork section: one fork vertex, one merge vertex, multiple parallel branches. */
export interface ForkSection {
  /** Stable dedup key for this section. */
  key: string;
  /** ID of the vertex where this section begins (diverges). */
  forkVertexId: string;
  /** ID of the vertex where this section ends (rejoins). */
  mergeVertexId: string;
  /** Parallel branches ordered backbone-first, then by descending length. */
  branches: ForkBranch[];
  /** Combined length of all branches. */
  totalLength: number;
}

/**
 * Return the nodes of `edge` oriented so they start at `fromVertexId`.
 */
function orientEdgeNodes(edge: WayGraphEdge, fromVertexId: string): LatLonNode[] {
  return edge.start === fromVertexId ? edge.nodes : [...edge.nodes].reverse();
}

/**
 * Walk from `startVertexId` along `initialEdgeId` until reaching a vertex
 * with degree != 2 (a junction). Returns null if the walk hits a cycle or
 * dead end before finding a junction.
 */
function walkBranchToJunction(
  graph: WayGraph,
  startVertexId: string,
  initialEdgeId: number,
): ForkBranch | null {
  const startVertex = graph.vertices.get(startVertexId);
  if (!startVertex || !startVertex.edges.includes(initialEdgeId)) {
    return null;
  }

  const traversedEdgeIds: number[] = [];
  const visitedEdgeIds = new Set<number>();
  const visitedVertexIds = new Set<string>([startVertexId]);
  let currentVertexId = startVertexId;
  let edgeId: number | null = initialEdgeId;
  let nodes: LatLonNode[] = [];

  while (edgeId != null) {
    if (visitedEdgeIds.has(edgeId)) {
      return null;
    }

    visitedEdgeIds.add(edgeId);
    traversedEdgeIds.push(edgeId);
    // Safe: edgeId is a valid graph edge index.
    const edge = graph.edges[edgeId] as WayGraphEdge;
    const orientedNodes = orientEdgeNodes(edge, currentVertexId);
    nodes = nodes.length === 0 ? [...orientedNodes] : [...nodes, ...orientedNodes.slice(1)];

    const nextVertexId = edge.start === currentVertexId ? edge.end : edge.start;
    if (nextVertexId === startVertexId || visitedVertexIds.has(nextVertexId)) {
      return null;
    }

    const nextVertex = graph.vertices.get(nextVertexId) as WayGraphVertex | undefined;
    if (!nextVertex) {
      return null;
    }

    visitedVertexIds.add(nextVertexId);
    if (nextVertex.edges.length !== 2) {
      return {
        startVertexId,
        endVertexId: nextVertexId,
        edgeIds: traversedEdgeIds,
        nodes: dedupeSequentialNodes(nodes),
        length: traversedEdgeIds.reduce(
          (sum, traversedEdgeId) => sum + (graph.edges[traversedEdgeId] as WayGraphEdge).length,
          0,
        ),
      };
    }

    edgeId = nextVertex.edges.find(candidateEdgeId => candidateEdgeId !== edge.id) ?? null;
    currentVertexId = nextVertexId;
  }

  return null;
}

/**
 * Detect fork sections in a way graph — points where the route diverges and
 * then rejoins, creating alternate route options.
 *
 * When `backboneEdgeIds` is provided, only sections connected to the backbone
 * cycle are returned, and branches are annotated with `onBackbone`.
 *
 * Returns sections sorted by descending total length, deduplicated so that
 * each edge belongs to at most one section.
 */
export function detectForkSections(
  graph: WayGraph,
  backboneEdgeIds: Set<number> | null = null,
): ForkSection[] {
  const sectionCandidates: ForkSection[] = [];

  for (const [vertexId, vertex] of graph.vertices.entries()) {
    if (vertex.edges.length < 3) {
      continue;
    }

    const groupedBranches = new Map<string, ForkBranch[]>();
    for (const edgeId of vertex.edges) {
      const branch = walkBranchToJunction(graph, vertexId, edgeId);
      if (!branch || branch.endVertexId === vertexId) {
        continue;
      }

      const mergeVertex = graph.vertices.get(branch.endVertexId);
      if (!mergeVertex || mergeVertex.edges.length < 3) {
        continue;
      }

      if (!groupedBranches.has(branch.endVertexId)) {
        groupedBranches.set(branch.endVertexId, []);
      }
      (groupedBranches.get(branch.endVertexId) as ForkBranch[]).push(branch);
    }

    for (const [mergeVertexId, branches] of groupedBranches.entries()) {
      if (branches.length < 2) {
        continue;
      }

      const forkTouchesBackbone = !backboneEdgeIds || vertex.edges.some(edgeId => (backboneEdgeIds as Set<number>).has(edgeId));
      const mergeVertex = graph.vertices.get(mergeVertexId);
      const mergeTouchesBackbone = !backboneEdgeIds || mergeVertex?.edges.some(edgeId => (backboneEdgeIds as Set<number>).has(edgeId));
      const backboneBranches = !backboneEdgeIds
        ? branches
        : branches.filter(branch => branch.edgeIds.some(edgeId => (backboneEdgeIds as Set<number>).has(edgeId)));

      if (!forkTouchesBackbone || !mergeTouchesBackbone || backboneBranches.length === 0) {
        continue;
      }

      const orderedBranches = branches
        .map(branch => ({ ...branch, onBackbone: branch.edgeIds.some(edgeId => backboneEdgeIds?.has(edgeId)) }))
        .sort((a, b) => Number(b.onBackbone) - Number(a.onBackbone) || b.length - a.length);

      const branchKeys = orderedBranches
        .map(branch => [...branch.edgeIds].sort((a, b) => a - b).join(','))
        .sort();
      sectionCandidates.push({
        key: `${[vertexId, mergeVertexId].sort().join('::')}|${branchKeys.join('|')}`,
        forkVertexId: vertexId,
        mergeVertexId,
        branches: orderedBranches,
        totalLength: orderedBranches.reduce((sum, branch) => sum + branch.length, 0),
      });
    }
  }

  const uniqueSections = [...new Map(sectionCandidates.map(section => [section.key, section])).values()]
    .sort((a, b) => b.totalLength - a.totalLength);
  const usedEdgeIds = new Set<number>();
  const acceptedSections: ForkSection[] = [];

  for (const section of uniqueSections) {
    const overlapsExistingSection = section.branches.some(branch =>
      branch.edgeIds.some(edgeId => usedEdgeIds.has(edgeId)),
    );
    if (overlapsExistingSection) {
      continue;
    }

    section.branches.forEach(branch => branch.edgeIds.forEach(edgeId => usedEdgeIds.add(edgeId)));
    acceptedSections.push(section);
  }

  return acceptedSections;
}
