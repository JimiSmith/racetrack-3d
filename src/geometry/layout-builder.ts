/**
 * Circuit layout construction.
 * Builds named and variant circuit layouts from OSM ways and way-graphs.
 * Handles fork-based variant detection and named-group substitution.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Way } from '../types/geometry.js';
import {
  dist,
  measurePolylineLength,
  computeBoundingBoxArea,
  computeEndpointGap,
} from './geo-math.js';
import {
  SNAP_FUZZY,
  closeNodeChainIfNearClosed,
  dedupeSequentialNodes,
} from './chain-cleanup.js';
import { buildWayGraph, selectBackboneCycle } from './way-graph.js';
import {
  stitchWaysOrdered,
  selectBestComponentWays,
  buildCandidateFromWays,
  measureWaySetLength,
  normalizeCircuitName,
  namesLikelyMatchCircuit,
  getWayCandidateNames,
  getWayCandidateNameEntries,
} from './way-stitching.js';
import { detectForkSections } from './fork-detection.js';
import type { ForkSection } from './fork-detection.js';
import { NAMED_LAYOUT_KEYWORD_PATTERN, findClosestNodePositions } from './osm-elements.js';
import {
  dedupeLayoutsByGeometry,
  rankLayoutsForTrack,
  SHORTCUT_LAYOUT_PATTERN,
} from './layout-dedup.js';

/** A partially-built layout used internally during construction. */
interface PartialLayout {
  id: string;
  name: string;
  nameSourceRank?: number;
  groupWayNames?: string[];
  nodes: LatLonNode[];
  area?: number;
  candidate?: ReturnType<typeof buildCandidateFromWays>;
  ways?: Way[];
  stats: {
    lengthMetres: number;
    segmentCount: number;
    variantSectionCount: number;
  };
}

/** A published layout (without internal-only fields). */
interface PublicLayout {
  id: string;
  name: string;
  nameSourceRank?: number;
  groupWayNames?: string[];
  nodes: LatLonNode[];
  /** Bounding-box area in square metres; stripped before returning from buildLayoutsFromWays. */
  area?: number;
  /** Shared by layouts that were created together (e.g. backbone + substitution variants)
   *  so geometry dedup won't collapse them despite spatial proximity. */
  _dedupeGroup?: string;
  stats: {
    lengthMetres: number;
    segmentCount: number;
    variantSectionCount: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Look up a known target length for a specific track+label combination.
 * Used to guide substitution scoring for venues with well-known circuit dimensions.
 */
function getKnownLayoutLengthTarget(trackName: string | null, label: string): number | null {
  const normalizedTrackName = normalizeCircuitName(trackName ?? '');
  const normalizedLabel = normalizeCircuitName(label);

  if (normalizedTrackName === 'bahrain international circuit') {
    if (normalizedLabel === 'inner circuit') {
      return 2550;
    }

    if (normalizedLabel === 'flat oval layout' || normalizedLabel === 'bahrain oval gp' || normalizedLabel === 'test oval') {
      return 2500;
    }
  }

  return null;
}

/**
 * Build a map from edge-id-set-key → weighted name for fork branch labelling.
 */
function buildWeightedNames(
  edgeIds: number[],
  graph: ReturnType<typeof buildWayGraph>,
  trackName: string | null,
): { names: Map<string, number>; namedLength: number } {
  const names = new Map<string, number>();
  let namedLength = 0;

  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId]!;
    for (const name of getWayCandidateNames(edge as unknown as Way)) {
      if (name.toLowerCase() === trackName?.toLowerCase()) {
        continue;
      }

      namedLength += edge.length;
      names.set(name, (names.get(name) ?? 0) + edge.length);
    }
  }

  return { names, namedLength };
}

/**
 * Infer the best label name for a fork branch, or null if no clear dominant name.
 */
function inferBranchName(
  branch: ForkSection['branches'][0],
  graph: ReturnType<typeof buildWayGraph>,
  trackName: string | null,
): string | null {
  const { names, namedLength } = buildWeightedNames(branch.edgeIds, graph, trackName);
  const [bestName, bestWeight = 0] = [...names.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const isDominantName = bestName && bestWeight >= branch.length * 0.35 && namedLength >= branch.length * 0.35;
  return isDominantName ? bestName : null;
}

/**
 * Create fallback labels for branches when no dominant name can be inferred.
 */
function makeFallbackBranchLabels(branches: ForkSection['branches']): Map<string, string> {
  if (branches.length === 2) {
    const [first, second] = [...branches].sort((a, b) => Number(b.onBackbone) - Number(a.onBackbone) || b.length - a.length) as [ForkSection['branches'][0], ForkSection['branches'][0]];
    if (first.onBackbone || (first.length > 0 && second.length / first.length <= 0.92)) {
      return new Map([
        [first.edgeIds.join(','), 'Main'],
        [second.edgeIds.join(','), 'Alternate'],
      ]);
    }
  }

  return new Map(branches.map((branch, index) => [branch.edgeIds.join(','), `Layout ${String.fromCharCode(65 + index)}`]));
}

/**
 * Enumerate all combinations of branch choices across fork sections.
 * Caps at `maxCombinations` to avoid exponential blowup.
 */
function enumerateBranchCombinations(
  sections: ForkSection[],
  maxCombinations = 8,
): ForkSection['branches'][0][][] {
  if (!sections.length) {
    return [[]];
  }

  const combinations: ForkSection['branches'][0][][] = [];

  function visit(sectionIndex: number, selectedBranches: ForkSection['branches'][0][]): void {
    if (combinations.length >= maxCombinations) {
      return;
    }

    if (sectionIndex >= sections.length) {
      combinations.push(selectedBranches);
      return;
    }

    for (const branch of sections[sectionIndex]!.branches) {
      visit(sectionIndex + 1, [...selectedBranches, branch]);
      if (combinations.length >= maxCombinations) {
        return;
      }
    }
  }

  visit(0, []);
  return combinations;
}

/**
 * Slice a closed node chain from `startIndex` to `endIndex` (wrapping around if needed).
 */
function sliceClosedNodeChain(nodes: LatLonNode[], startIndex: number, endIndex: number): LatLonNode[] {
  const baseNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  if (!baseNodes.length) {
    return [];
  }

  if (startIndex <= endIndex) {
    return baseNodes.slice(startIndex, endIndex + 1);
  }

  return [...baseNodes.slice(startIndex), ...baseNodes.slice(0, endIndex + 1)];
}

/**
 * Orient `variantNodes` so they run from `startNode` to `endNode`
 * (reversing if that direction is closer).
 */
function orientVariantNodes(
  variantNodes: LatLonNode[],
  startNode: LatLonNode,
  endNode: LatLonNode,
): LatLonNode[] {
  const forwardScore = dist(variantNodes[0]!, startNode) + dist(variantNodes[variantNodes.length - 1]!, endNode);
  const reverseScore = dist(variantNodes[0]!, endNode) + dist(variantNodes[variantNodes.length - 1]!, startNode);
  return reverseScore < forwardScore ? [...variantNodes].reverse() : variantNodes;
}

/**
 * Build an ordered cycle from a subset of edges, returning the node sequence and
 * ordered edge list, or null if the edges don't form a simple cycle.
 */
function buildOrderedCycleMetadata(
  graph: ReturnType<typeof buildWayGraph>,
  edgeIds: number[],
): { nodes: LatLonNode[]; orderedEdges: { edgeId: number }[] } | null {
  if (!edgeIds.length) {
    return null;
  }

  const adjacency = new Map<string, number[]>();
  for (const edgeId of edgeIds) {
    const edge = graph.edges[edgeId]!;

    if (!adjacency.has(edge.start)) { adjacency.set(edge.start, []); }
    if (!adjacency.has(edge.end)) { adjacency.set(edge.end, []); }
    adjacency.get(edge.start)!.push(edgeId);
    adjacency.get(edge.end)!.push(edgeId);
  }

  for (const connectedEdgeIds of adjacency.values()) {
    if (connectedEdgeIds.length !== 2) {
      return null;
    }
  }

  const firstEdgeId = edgeIds[0]!;
  const firstEdge = graph.edges[firstEdgeId]!;
  const orderedEdges: { edgeId: number }[] = [];
  const orderedNodes = [...firstEdge.nodes];
  const visitedEdges = new Set([firstEdgeId]);
  let currentVertexId = firstEdge.end;
  let previousEdgeId = firstEdgeId;

  orderedEdges.push({ edgeId: firstEdgeId });

  while (currentVertexId !== firstEdge.start) {
    const nextEdgeId = adjacency.get(currentVertexId)?.find(edgeId => edgeId !== previousEdgeId);
    if (nextEdgeId == null || visitedEdges.has(nextEdgeId)) {
      return null;
    }

    const nextEdge = graph.edges[nextEdgeId]!;
    const forward = nextEdge.start === currentVertexId;
    const orientedNodes = forward ? nextEdge.nodes : [...nextEdge.nodes].reverse();
    orderedNodes.push(...orientedNodes.slice(1));
    orderedEdges.push({ edgeId: nextEdgeId });
    visitedEdges.add(nextEdgeId);
    previousEdgeId = nextEdgeId;
    currentVertexId = forward ? nextEdge.end : nextEdge.start;
  }

  if (visitedEdges.size !== edgeIds.length) {
    return null;
  }

  return {
    nodes: dedupeSequentialNodes(orderedNodes),
    orderedEdges,
  };
}

/**
 * Stitch ways into an ordered node chain (for fallback use in track-geometry).
 */
export function stitchWays(ways: Way[]): LatLonNode[] {
  if (ways.length === 0) { return []; }
  if (ways.length === 1) { return ways[0]!.nodes; }

  return stitchWaysOrdered(selectBestComponentWays(ways));
}

/**
 * Build an ordered node chain from a set of named ways.
 */
export function buildNamedGroupChain(namedWays: Way[]): LatLonNode[] {
  return dedupeSequentialNodes(stitchWaysOrdered(namedWays));
}

/**
 * Return true if any sampled node of `namedWays` is within `maxDistance` of `referenceNodes`.
 */
function isWaySetNearReference(namedWays: Way[], referenceNodes: LatLonNode[], maxDistance = SNAP_FUZZY * 8): boolean {
  if (!namedWays.length || !referenceNodes?.length) {
    return false;
  }

  const candidate = buildCandidateFromWays(namedWays);
  if (!candidate?.nodes?.length) {
    return false;
  }

  return sampleChainNodes(candidate.nodes, 12)
    .some(node => findClosestNodePositions(referenceNodes, node, maxDistance, 1).length > 0);
}

/**
 * Sample `sampleCount` evenly-spaced nodes from a chain.
 */
function sampleChainNodes(nodes: LatLonNode[], sampleCount = 24): LatLonNode[] {
  const baseNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  if (baseNodes.length <= sampleCount) {
    return baseNodes;
  }

  return Array.from({ length: sampleCount }, (_, index) => {
    const sampleIndex = Math.floor((index * baseNodes.length) / sampleCount);
    return baseNodes[sampleIndex]!;
  });
}

// ---------------------------------------------------------------------------
// Named layout sub-builders
// ---------------------------------------------------------------------------

/**
 * Try to substitute a named variant into the backbone cycle, returning the best
 * resulting layout or null if no valid substitution exists.
 */
export function substituteVariantIntoLayout(
  baseNodes: LatLonNode[],
  variantNodes: LatLonNode[],
  variantLength: number,
  label: string,
  backboneLength: number,
  trackName: string | null = null,
): { score: number; candidate: NonNullable<ReturnType<typeof buildCandidateFromWays>>; selectedWays: Way[] } | null {
  const MAX_ENDPOINT_MATCH_DISTANCE = SNAP_FUZZY * 8;
  const MIN_LENGTH = 1000;
  const MAX_GAP_FRACTION = 0.2;
  const startMatches = findClosestNodePositions(baseNodes, variantNodes[0]!, MAX_ENDPOINT_MATCH_DISTANCE);
  const endMatches = findClosestNodePositions(baseNodes, variantNodes[variantNodes.length - 1]!, MAX_ENDPOINT_MATCH_DISTANCE);

  if (!startMatches.length || !endMatches.length) {
    return null;
  }

  let bestLayout: { score: number; candidate: NonNullable<ReturnType<typeof buildCandidateFromWays>>; selectedWays: Way[] } | null = null;

  for (const startMatch of startMatches) {
    for (const endMatch of endMatches) {
      if (startMatch.index === endMatch.index) {
        continue;
      }

      const forwardReplacementNodes = sliceClosedNodeChain(baseNodes, startMatch.index, endMatch.index);
      const reverseReplacementNodes = sliceClosedNodeChain(baseNodes, endMatch.index, startMatch.index);
      const replacementCandidates = [
        {
          replacementNodes: forwardReplacementNodes,
          preservedNodes: reverseReplacementNodes,
          variantNodes: orientVariantNodes(variantNodes, forwardReplacementNodes[0]!, forwardReplacementNodes[forwardReplacementNodes.length - 1]!),
        },
        {
          replacementNodes: reverseReplacementNodes,
          preservedNodes: forwardReplacementNodes,
          variantNodes: orientVariantNodes(variantNodes, reverseReplacementNodes[0]!, reverseReplacementNodes[reverseReplacementNodes.length - 1]!),
        },
      ].map(option => ({
        ...option,
        replacementLength: measurePolylineLength(option.replacementNodes),
      }));

      for (const replacement of replacementCandidates) {
        if (!replacement?.preservedNodes?.length || replacement.preservedNodes.length < 2) {
          continue;
        }

        const selectedWays: Way[] = [
          { id: -1, nodes: replacement.preservedNodes, tags: { name: 'Main' } },
          { id: -2, nodes: replacement.variantNodes, tags: { name: label } },
        ];
        const candidate = buildCandidateFromWays(selectedWays);
        if (!candidate || candidate.nodes.length < 4) {
          continue;
        }
        if (candidate.length < MIN_LENGTH) {
          continue;
        }
        const maxEndpointGap = SHORTCUT_LAYOUT_PATTERN.test(label)
          ? Math.min(80, candidate.length * MAX_GAP_FRACTION)
          : candidate.length * MAX_GAP_FRACTION;
        if (candidate.endpointGap > maxEndpointGap) {
          continue;
        }

        const knownTargetLength = getKnownLayoutLengthTarget(trackName, label);
        if (knownTargetLength != null && Math.abs(candidate.length - knownTargetLength) > 250) {
          continue;
        }
        const prefersShortcutLength = knownTargetLength == null && SHORTCUT_LAYOUT_PATTERN.test(label);
        const score = (startMatch.distance + endMatch.distance) * 1000000
          + (knownTargetLength != null
              ? Math.abs(candidate.length - knownTargetLength)
              : prefersShortcutLength
              ? candidate.length
              : Math.abs(candidate.length - backboneLength) + Math.abs(replacement.replacementLength - variantLength));
        if (!bestLayout || score < bestLayout.score) {
          bestLayout = {
            score,
            candidate,
            selectedWays,
          };
        }
      }
    }
  }

  return bestLayout;
}

/**
 * Build substitution-based layouts from named way groups.
 * Returns an array of layouts when the backbone + at least one variant can be formed.
 */
function buildSubstitutionLayouts(
  nameGroups: Map<string, { ways: Way[]; sourceRank: number }>,
  backboneGroupName: string,
  backboneWays: Way[],
  backboneCandidate: NonNullable<ReturnType<typeof buildCandidateFromWays>>,
  trackName: string | null,
): PublicLayout[] {
  const backboneGraph = buildWayGraph(backboneWays);
  const cycleMetadata = buildOrderedCycleMetadata(backboneGraph, backboneGraph.edges.map(edge => edge.id));

  if (!cycleMetadata || cycleMetadata.orderedEdges.length !== backboneWays.length) {
    return [];
  }

  const layouts: PublicLayout[] = [{
    id: 'layout-1',
    name: backboneGroupName,
    nameSourceRank: nameGroups.get(backboneGroupName)?.sourceRank ?? 0,
    groupWayNames: [...new Set(backboneWays.map(way => way.tags?.['name'] as string | undefined).filter((n): n is string => typeof n === 'string'))],
    nodes: backboneCandidate.nodes,
    stats: {
      lengthMetres: backboneCandidate.length,
      segmentCount: backboneWays.length,
      variantSectionCount: 0,
    },
  }];

  for (const [groupName, group] of nameGroups) {
    if (groupName === backboneGroupName) {
      continue;
    }

    const namedWays = group.ways;
    const variantNodes = buildNamedGroupChain(namedWays);
    if (variantNodes.length < 2) {
      continue;
    }
    const bestLayout = substituteVariantIntoLayout(
      cycleMetadata.nodes,
      variantNodes,
      measureWaySetLength(namedWays),
      groupName,
      backboneCandidate.length,
      trackName,
    );

    if (!bestLayout) {
      continue;
    }

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: groupName,
      nameSourceRank: nameGroups.get(groupName)?.sourceRank ?? 0,
      groupWayNames: [...new Set(namedWays.map(way => way.tags?.['name'] as string | undefined).filter((n): n is string => typeof n === 'string'))],
      nodes: bestLayout.candidate.nodes,
      stats: {
        lengthMetres: bestLayout.candidate.length,
        segmentCount: bestLayout.selectedWays.length,
        variantSectionCount: 1,
      },
    });
  }

  return layouts.length >= 2 ? layouts : [];
}

/**
 * Build implicit relation layouts: layouts inferred from relation-level names
 * that weren't found as standalone named groups.
 */
function buildImplicitRelationLayouts(
  nameGroups: Map<string, { ways: Way[]; sourceRank: number }>,
  eligibleNameGroups: Map<string, { ways: Way[]; sourceRank: number }>,
  existingLayouts: PublicLayout[],
  trackName: string | null,
  minLength: number,
  maxGapFraction: number,
): PublicLayout[] {
  const existingNames = new Set(existingLayouts.map(layout => normalizeCircuitName(layout.name)));
  const implicitLayouts: PublicLayout[] = [];

  for (const [groupName, group] of nameGroups) {
    if (eligibleNameGroups.has(groupName) || group.sourceRank > 0 || !namesLikelyMatchCircuit(groupName, trackName ?? '')) {
      continue;
    }

    const layoutLikeWayNames = [...new Set(group.ways
      .map(way => (way.tags?.['name'] as string | undefined)?.trim())
      .filter((name): name is string => Boolean(name) && NAMED_LAYOUT_KEYWORD_PATTERN.test(name!)))];
    const missingWayNames = layoutLikeWayNames
      .filter(name => normalizeCircuitName(name) !== normalizeCircuitName(groupName))
      .filter(name => !existingNames.has(normalizeCircuitName(name)));
    if (missingWayNames.length !== 1) {
      continue;
    }

    const candidate = buildCandidateFromWays(group.ways);
    if (!candidate || candidate.nodes.length < 4 || candidate.length < minLength) {
      continue;
    }
    if (candidate.endpointGap > candidate.length * maxGapFraction) {
      continue;
    }

    implicitLayouts.push({
      id: `layout-${existingLayouts.length + implicitLayouts.length + 1}`,
      name: missingWayNames[0]!,
      nameSourceRank: 1,
      groupWayNames: layoutLikeWayNames,
      nodes: candidate.nodes,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: group.ways.length,
        variantSectionCount: 1,
      },
    });
    existingNames.add(normalizeCircuitName(missingWayNames[0]!));
  }

  return implicitLayouts;
}

/**
 * Resolve generic relation layout names: when a layout's name matches the track
 * name but it has exactly one missing "layout-like" way name, rename the layout
 * to that way name.
 */
function resolveGenericRelationLayoutNames(
  layouts: PublicLayout[],
  trackName: string | null,
): PublicLayout[] {
  const seenLayoutNames = new Set(layouts.map(layout => normalizeCircuitName(layout.name)));

  return layouts.map(layout => {
    if ((layout?.nameSourceRank ?? 0) > 0 || !namesLikelyMatchCircuit(layout?.name, trackName ?? '')) {
      return layout;
    }

    const candidateWayNames = [...new Set((layout.groupWayNames ?? [])
      .filter(name => NAMED_LAYOUT_KEYWORD_PATTERN.test(name))
      .filter(name => normalizeCircuitName(name) !== normalizeCircuitName(layout.name)))];
    const missingWayNames = candidateWayNames.filter(name => !seenLayoutNames.has(normalizeCircuitName(name)));
    if (missingWayNames.length !== 1) {
      return layout;
    }

    return {
      ...layout,
      name: missingWayNames[0]!,
      nameSourceRank: 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build layout variants from fork sections detected in the way graph.
 *
 * @param ways - All ways in the component
 * @param graph - The way graph
 * @param sections - Fork sections from `detectForkSections`
 * @param trackName - Track name for scoring/naming
 * @param backboneCycle - The primary backbone cycle to use as the base
 */
export function buildVariantLayouts(
  ways: Way[],
  graph: ReturnType<typeof buildWayGraph>,
  sections: ForkSection[],
  trackName: string | null,
  backboneCycle: { nodes: LatLonNode[]; edgeIds?: number[]; length?: number } | null | undefined,
): PublicLayout[] {
  if (!backboneCycle?.nodes?.length) {
    return [];
  }

  const MAX_ENDPOINT_MATCH_DISTANCE = SNAP_FUZZY * 8;
  const MIN_LAYOUT_LENGTH = 1000;
  const sectionEdgeIds = new Set(sections.flatMap(section => section.branches.flatMap(branch => branch.edgeIds)));
  const sharedWayIds = ways
    .map((_, index) => index)
    .filter(index => !sectionEdgeIds.has(index));
  const branchFallbackLabels = new Map<string, string>();

  for (const section of sections) {
    const fallbacks = makeFallbackBranchLabels(section.branches);
    for (const branch of section.branches) {
      const branchKey = branch.edgeIds.join(',');
      branchFallbackLabels.set(branchKey, inferBranchName(branch, graph, trackName) ?? fallbacks.get(branchKey) ?? 'Alternate');
    }
  }

  const combinations = enumerateBranchCombinations(sections);
  const layouts: PublicLayout[] = [];

  for (const selectedBranches of combinations) {
    const selectedWayIds = [...sharedWayIds];
    const substitutedSections: { section: ForkSection; branch: ForkSection['branches'][0] }[] = [];
    const nameParts: string[] = [];

    for (let sectionIndex = 0; sectionIndex < selectedBranches.length; sectionIndex += 1) {
      const branch = selectedBranches[sectionIndex]!;
      const section = sections[sectionIndex]!;
      const backboneBranch = section.branches[0]!;
      selectedWayIds.push(...branch.edgeIds);
      const branchLabel = branchFallbackLabels.get(branch.edgeIds.join(',')) ?? 'Alternate';

      if (branch === backboneBranch) {
        nameParts.push(branchLabel);
        continue;
      }

      substitutedSections.push({ section, branch });
      nameParts.push(branchLabel);
    }

    let layoutNodes = backboneCycle.nodes;

    if (substitutedSections.length > 0) {
      let isValid = true;

      for (const { section, branch } of substitutedSections) {
        const forkNode = graph.vertices.get(section.forkVertexId)?.node;
        const mergeNode = graph.vertices.get(section.mergeVertexId)?.node;
        const backboneBranch = section.branches[0]!;
        if (!forkNode || !mergeNode || !branch.nodes?.length) {
          isValid = false;
          break;
        }

        const forkMatches = findClosestNodePositions(layoutNodes, forkNode, MAX_ENDPOINT_MATCH_DISTANCE);
        const mergeMatches = findClosestNodePositions(layoutNodes, mergeNode, MAX_ENDPOINT_MATCH_DISTANCE);
        if (!forkMatches.length || !mergeMatches.length) {
          isValid = false;
          break;
        }

        let bestNodes: LatLonNode[] | null = null;
        let bestScore = Infinity;

        for (const forkMatch of forkMatches) {
          for (const mergeMatch of mergeMatches) {
            if (forkMatch.index === mergeMatch.index) {
              continue;
            }

            const forwardPreservedSection = sliceClosedNodeChain(layoutNodes, mergeMatch.index, forkMatch.index);
            const reversePreservedSection = sliceClosedNodeChain(layoutNodes, forkMatch.index, mergeMatch.index);
            const replacementCandidates = [
              {
                preservedNodes: forwardPreservedSection,
                replacementLength: measurePolylineLength(reversePreservedSection),
                variantNodes: orientVariantNodes(branch.nodes, forkNode, mergeNode),
              },
              {
                preservedNodes: reversePreservedSection,
                replacementLength: measurePolylineLength(forwardPreservedSection),
                variantNodes: orientVariantNodes(branch.nodes, mergeNode, forkNode),
              },
            ];

            for (const replacement of replacementCandidates) {
              if (!replacement.preservedNodes?.length || replacement.preservedNodes.length < 2) {
                continue;
              }

              const candidateNodes = dedupeSequentialNodes([
                ...replacement.preservedNodes,
                ...replacement.variantNodes,
              ]);
              if (candidateNodes.length < 4) {
                continue;
              }

              const endpointGap = computeEndpointGap(candidateNodes);
              const score = Math.abs(replacement.replacementLength - backboneBranch.length)
                + endpointGap * 10
                + forkMatch.distance
                + mergeMatch.distance;
              if (score < bestScore) {
                bestScore = score;
                bestNodes = candidateNodes;
              }
            }
          }
        }

        if (!bestNodes) {
          isValid = false;
          break;
        }

        layoutNodes = bestNodes;
      }

      if (!isValid) {
        continue;
      }
    }

    const candidateNodes = closeNodeChainIfNearClosed(layoutNodes);
    const candidate = {
      nodes: candidateNodes,
      length: measurePolylineLength(candidateNodes),
      area: computeBoundingBoxArea(candidateNodes),
      endpointGap: computeEndpointGap(candidateNodes),
    };

    if (candidate.nodes.length < 4 || candidate.length < MIN_LAYOUT_LENGTH || candidate.endpointGap > 80) {
      continue;
    }

    const uniqueWayIds = [...new Set(selectedWayIds)].sort((a, b) => a - b);

    layouts.push({
      id: `layout-${layouts.length + 1}`,
      name: substitutedSections.length === 0
        ? 'Main'
        : (sections.length === 1 ? (nameParts[0] ?? `Layout ${layouts.length + 1}`) : nameParts.join(' + ')),
      nodes: candidate.nodes,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: uniqueWayIds.length,
        variantSectionCount: substitutedSections.length,
      },
    });
  }

  return layouts;
}

/**
 * Build all circuit layouts from a set of ways.
 * Uses fork detection to find variant layouts; falls back to a single "Main" layout.
 *
 * @param ways - All ways in the component
 * @param trackName - Track name for scoring/naming
 */
export function buildLayoutsFromWays(ways: Way[], trackName: string | null): PublicLayout[] {
  if (!ways.length) {
    return [];
  }

  const graph = buildWayGraph(ways);
  const backboneCycle = selectBackboneCycle(graph);
  const stitchedCandidate = buildCandidateFromWays(ways);
  const variantBackbone = stitchedCandidate
    && stitchedCandidate.endpointGap <= 80
    && stitchedCandidate.length > (backboneCycle?.length ?? 0) + 400
    ? {
        ...backboneCycle,
        nodes: stitchedCandidate.nodes,
        length: stitchedCandidate.length,
        area: stitchedCandidate.area,
      }
    : backboneCycle;
  const sections = detectForkSections(graph, new Set(backboneCycle?.edgeIds ?? []));
  const variantLayouts = buildVariantLayouts(ways, graph, sections, trackName, variantBackbone);

  if (variantLayouts.length > 1) {
    return dedupeLayoutsByGeometry(variantLayouts.slice(0, 8), trackName).map(({ area: _area, ...layout }) => layout);
  }

  const singleLayout = variantBackbone
    ? {
        nodes: variantBackbone.nodes!,
        length: variantBackbone.length!,
      }
    : stitchedCandidate;
  if (!singleLayout || singleLayout.nodes.length < 4) {
    return [];
  }

  return [{
    id: 'layout-1',
    name: 'Main',
    nodes: singleLayout.nodes,
    stats: {
      lengthMetres: singleLayout.length || measureWaySetLength(ways),
      segmentCount: ways.length,
      variantSectionCount: 0,
    },
  }];
}

/**
 * Build layouts by substituting named variant ways into a backbone built from referenceWays.
 * Used when eligible named groups exist but none form standalone closed circuits on their own.
 * E.g. Red Bull Ring: "MotoGP chicane" and "Long Lap Penalty" are variant segments
 * that create different layouts when spliced into the main circuit backbone.
 */
function buildVariantSubstitutionLayouts(
  eligibleNameGroups: Map<string, { ways: Way[]; sourceRank: number }>,
  referenceWays: Way[],
  trackName: string | null,
): PublicLayout[] {
  const MAX_GAP_FRACTION = 0.15;
  const MAX_VARIANT_LENGTH_FRACTION = 0.5;

  const backbone = buildCandidateFromWays(referenceWays);
  if (!backbone || backbone.nodes.length < 4) { return []; }
  if (backbone.endpointGap > backbone.length * MAX_GAP_FRACTION) { return []; }

  const baseNodes = closeNodeChainIfNearClosed(backbone.nodes, backbone.length * MAX_GAP_FRACTION);

  const dedupeGroup = `variant-sub-${Date.now()}`;
  const mainLayout: PublicLayout = {
    id: 'layout-1',
    name: 'Main',
    _dedupeGroup: dedupeGroup,
    nodes: baseNodes,
    stats: {
      lengthMetres: backbone.length,
      segmentCount: referenceWays.length,
      variantSectionCount: 0,
    },
  };

  const backboneWayIds = new Set(referenceWays.map(w => w.id));
  const variantLayouts: PublicLayout[] = [];
  let layoutIndex = 2;

  for (const [groupName, group] of eligibleNameGroups) {
    // Skip groups whose ways are already part of the backbone — they're
    // segments of the main circuit, not alternate variant sections.
    if (group.ways.every(w => backboneWayIds.has(w.id))) { continue; }

    const variantChain = buildNamedGroupChain(group.ways);
    if (variantChain.length < 2) { continue; }

    const variantLength = measureWaySetLength(group.ways);
    if (variantLength > backbone.length * MAX_VARIANT_LENGTH_FRACTION) { continue; }

    const result = substituteVariantIntoLayout(
      baseNodes,
      variantChain,
      variantLength,
      groupName,
      backbone.length,
      trackName,
    );
    if (!result) { continue; }

    variantLayouts.push({
      id: `layout-${layoutIndex++}`,
      name: groupName,
      _dedupeGroup: dedupeGroup,
      nodes: result.candidate.nodes,
      stats: {
        lengthMetres: result.candidate.length,
        segmentCount: result.selectedWays.length,
        variantSectionCount: 1,
      },
    });
  }

  if (variantLayouts.length === 0) { return []; }

  // Dedup variants against each other (e.g. MotoGP chicane ≈ Long Lap Penalty),
  // but don't include the backbone in geometry dedup — variant substitution
  // segments can run very close to the backbone (< 100m) while being
  // intentionally distinct routes.
  const dedupedVariants = dedupeLayoutsByGeometry(variantLayouts, trackName);
  return [mainLayout, ...dedupedVariants];
}

/**
 * Detect named circuit layouts from ways that carry distinct circuit-level names.
 *
 * E.g. Bahrain: "Grand Prix Circuit", "Inner Circuit", "Endurance Circuit" — each
 * group of named ways forms a COMPLETE standalone circuit on its own.
 *
 * Returns [] if no two named groups independently form valid closed circuits.
 *
 * @param ways - Ways to search for named groups
 * @param trackName - Track name for scoring/naming
 * @param referenceWays - Reference ways for proximity filtering (defaults to `ways`)
 */
export function buildNamedCircuitLayouts(
  ways: Way[],
  trackName: string | null,
  referenceWays: Way[] = ways,
): PublicLayout[] {
  const MIN_LENGTH = 1500; // metres — ignore sub-km stubs
  const MAX_GAP_FRACTION = 0.15; // endpoint gap must be < 15% of total length
  const referenceNodes = buildCandidateFromWays(referenceWays)?.nodes ?? [];

  const nameGroups = new Map<string, { ways: Way[]; sourceRank: number }>();
  for (const way of ways) {
    for (const { name, source } of getWayCandidateNameEntries(way)) {
      if (!NAMED_LAYOUT_KEYWORD_PATTERN.test(name)) { continue; }
      if (!nameGroups.has(name)) {
        nameGroups.set(name, { ways: [], sourceRank: source === 'way' ? 1 : 0 });
      }

      const group = nameGroups.get(name)!;
      group.ways.push(way);
      group.sourceRank = Math.max(group.sourceRank, source === 'way' ? 1 : 0);
    }
  }

  if (nameGroups.size < 2) { return []; }

  const eligibleNameGroups = new Map<string, { ways: Way[]; sourceRank: number }>();
  const standaloneLayouts: PartialLayout[] = [];
  for (const [groupName, group] of nameGroups) {
    const namedWays = group.ways;
    const wayNames = new Set(namedWays.map(way => (way.tags?.['name'] as string | undefined)?.trim()).filter((n): n is string => Boolean(n)));
    const competingLayoutWayNames = [...wayNames].filter(name =>
      NAMED_LAYOUT_KEYWORD_PATTERN.test(name)
      && normalizeCircuitName(name) !== normalizeCircuitName(groupName)
    );
    if (group.sourceRank === 0 && competingLayoutWayNames.length > 1) {
      continue;
    }
    if (!isWaySetNearReference(namedWays, referenceNodes)) {
      continue;
    }

    eligibleNameGroups.set(groupName, group);

    // Only use the named ways — no shared backbone mixing
    const candidate = buildCandidateFromWays(namedWays);
    if (!candidate || candidate.nodes.length < 4) { continue; }
    if (candidate.length < MIN_LENGTH) { continue; }
    // Must form a near-closed loop on its own
    if (candidate.endpointGap > candidate.length * MAX_GAP_FRACTION) { continue; }

    standaloneLayouts.push({
      id: `layout-${standaloneLayouts.length + 1}`,
      name: groupName,
      nameSourceRank: group.sourceRank,
      groupWayNames: [...wayNames],
      nodes: candidate.nodes,
      candidate,
      ways: namedWays,
      stats: {
        lengthMetres: candidate.length,
        segmentCount: namedWays.length,
        variantSectionCount: 0,
      },
    });
  }

  if (eligibleNameGroups.size < 2 && standaloneLayouts.length === 0) {
    return [];
  }

  // When no standalone layouts exist but eligible named groups do, try substituting
  // each named group as a variant into the backbone built from referenceWays.
  if (standaloneLayouts.length === 0) {
    return buildVariantSubstitutionLayouts(eligibleNameGroups, referenceWays, trackName);
  }

  const backboneLayout = rankLayoutsForTrack(standaloneLayouts, trackName)[0];
  const substitutionLayouts = backboneLayout
      ? buildSubstitutionLayouts(
          eligibleNameGroups,
          backboneLayout.name,
          backboneLayout.ways!,
          backboneLayout.candidate!,
          trackName,
        )
      : [];

  const publicLayouts: PublicLayout[] = standaloneLayouts.map(({ candidate: _candidate, ways: _groupedWays, ...publicLayout }) => publicLayout);
  const dedupedCombinedLayouts = dedupeLayoutsByGeometry([...publicLayouts, ...substitutionLayouts], trackName);
  const implicitRelationLayouts = buildImplicitRelationLayouts(
    nameGroups,
    eligibleNameGroups,
    dedupedCombinedLayouts,
    trackName,
    MIN_LENGTH,
    MAX_GAP_FRACTION,
  );
  const combinedLayouts = resolveGenericRelationLayoutNames(
    dedupeLayoutsByGeometry([...dedupedCombinedLayouts, ...implicitRelationLayouts], trackName),
    trackName,
  );

  if (combinedLayouts.length >= 2) {
    return combinedLayouts;
  }

  return [];
}
