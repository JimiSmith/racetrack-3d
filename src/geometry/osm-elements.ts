/**
 * OSM element extraction and filtering.
 * Extracts ways from raw OSM API payloads, filters pit lanes and motor-sports ways,
 * and collects venue names from OSM tags.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Way } from '../types/geometry.js';
import { dist } from './geo-math.js';
import { SNAP_FUZZY } from './chain-cleanup.js';
import { buildCandidateFromWays, getWayCandidateNames } from './way-stitching.js';

/** Regex matching pit lane / pit road names that should be excluded from the racing line. */
export const PIT_PATTERN = /pit[\s\-_]*lane|pit[\s\-_]*road|pitlane|pitroad|support[\s\-_]*pit|\bpit\s*$|boxen(?:stra[sß]e|gasse)/i;

/**
 * Regex matching way/relation names that carry a recognisable "layout" keyword.
 * Used to identify named circuit variants (e.g. "Grand Prix Circuit", "Inner Circuit").
 */
export const NAMED_LAYOUT_KEYWORD_PATTERN = /\b(circuit|course|layout|oval|grand[\s_-]*prix|indy|national|endurance|inner|outer|short|chicane|bypass|long[\s_-]*lap|rallycross|moto[\s_-]*gp|alternate)\b/i;

/**
 * Find the closest nodes in `nodes` to `targetNode` within `maxDistance` metres.
 * Returns up to `limit` matches, sorted by distance ascending.
 */
export function findClosestNodePositions(
  nodes: LatLonNode[],
  targetNode: LatLonNode,
  maxDistance: number,
  limit = 8,
): { index: number; distance: number }[] {
  // Exclude the final duplicate node in a closed chain (same as first node)
  const searchNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  const matches = searchNodes
    .map((node, index) => ({ index, distance: dist(node, targetNode) }))
    .filter(match => match.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.index - b.index);

  return matches.slice(0, limit);
}

/**
 * Extract all OSM ways from an element array, merging relation tags onto member ways.
 * Ways referenced by multiple relations accumulate `relationNames` in their tags.
 */
export function extractWays(elements: unknown[]): Way[] {
  const waysById = new Map<number, Way>();

  function mergeRelationTags(
    existingTags: Record<string, unknown> | undefined,
    relationTags: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const relationNames = [...new Set([
      ...(Array.isArray(existingTags?.['relationNames']) ? (existingTags!['relationNames'] as unknown[]) : []),
      relationTags?.['name'],
    ].map((name: unknown) => (typeof name === 'string' ? name.trim() : undefined)).filter(Boolean))] as string[];

    return {
      ...(relationTags ?? {}),
      ...(existingTags ?? {}),
      ...(relationNames.length > 0 ? { relationNames } : {}),
    };
  }

  function addWay(
    id: number,
    tags: Record<string, unknown> | undefined,
    geometry: Array<{ lat: number; lon: number }>,
    overwrite = false,
  ): void {
    if (!Number.isFinite(id) || !Array.isArray(geometry) || geometry.length < 2) {
      return;
    }

    const existing = waysById.get(id);
    if (existing && !overwrite) {
      return;
    }

    waysById.set(id, {
      id,
      tags: overwrite ? mergeRelationTags(existing?.tags, tags) : (tags ?? {}),
      nodes: geometry.map(({ lat: wayLat, lon: wayLon }) => ({ lat: wayLat, lon: wayLon })),
    });
  }

  const els = elements ?? [];

  for (const element of els) {
    const el = element as Record<string, unknown>;
    if (el['type'] === 'way') {
      addWay(
        el['id'] as number,
        el['tags'] as Record<string, unknown>,
        el['geometry'] as Array<{ lat: number; lon: number }>,
      );
    }
  }

  for (const element of els) {
    const el = element as Record<string, unknown>;
    if (el['type'] !== 'relation') {
      continue;
    }

    for (const member of (el['members'] as Array<Record<string, unknown>>) || []) {
      if (member['type'] !== 'way' || member['role'] === 'pit_lane') {
        continue;
      }

      addWay(
        member['ref'] as number,
        el['tags'] as Record<string, unknown>,
        member['geometry'] as Array<{ lat: number; lon: number }>,
        true,
      );
    }
  }

  return [...waysById.values()];
}

/**
 * Collect all unique venue name strings from way tags.
 * Returns a sorted array of distinct names.
 */
export function collectOsmVenueNames(ways: Way[]): string[] {
  return [...new Set(
    ways
      .flatMap(way => getWayCandidateNames(way))
      .filter(Boolean),
  )].sort((a, b) => a.localeCompare(b));
}

/**
 * Find additional named-layout ways from `filteredWays` that are not already in
 * `componentWays` but whose endpoints snap onto the component reference geometry.
 * Returns `componentWays` with any such extra ways appended.
 */
export function collectNamedLayoutWays(filteredWays: Way[], componentWays: Way[]): Way[] {
  const componentWayIds = new Set(componentWays.map(way => way.id));
  const referenceNodes = buildCandidateFromWays(componentWays)?.nodes ?? [];

  const extraWays = filteredWays.filter(way => {
    if (componentWayIds.has(way.id)) {
      return false;
    }

    const hasLayoutLikeName = getWayCandidateNames(way)
      .some(name => NAMED_LAYOUT_KEYWORD_PATTERN.test(name));
    if (!hasLayoutLikeName) {
      return false;
    }

    if (way.nodes.length < 2 || referenceNodes.length === 0) {
      return false;
    }

    const firstNodeNearReference = findClosestNodePositions(referenceNodes, way.nodes[0]!, SNAP_FUZZY * 8, 1).length > 0;
    const lastNodeNearReference = findClosestNodePositions(referenceNodes, way.nodes[way.nodes.length - 1]!, SNAP_FUZZY * 8, 1).length > 0;
    return firstNodeNearReference && lastNodeNearReference;
  });

  return [...componentWays, ...extraWays];
}
