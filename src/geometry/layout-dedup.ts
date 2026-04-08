/**
 * Layout deduplication and canonicalization.
 * Removes geometrically near-identical layouts, deduplicates by name, and
 * canonicalizes layout names (e.g. "Flat Oval Layout" → "Test Oval").
 * No side effects. No DOM access.
 */

import type { LatLonNode } from '../types/geometry.js';
import { measurePolylineLength } from './geo-math.js';
import { SNAP_FUZZY } from './chain-cleanup.js';
import { normalizeCircuitName, namesLikelyMatchCircuit } from './way-stitching.js';
import { findClosestNodePositions } from './osm-elements.js';

/** Names that suggest a layout is the primary/main configuration. */
const PRIMARY_LAYOUT_PATTERN = /\b(main|grand[\s_-]*prix)\b/i;

/** Names that suggest a layout is a secondary/variant configuration. */
const SECONDARY_LAYOUT_PATTERN = /\b(alternate|alternative|club|corkscrew|endurance|formula\s*e|e[\s_-]*prix|flat|inner|joker|kart|moto|national|outer|oval|paddock|rallycross|short|test)\b/i;

/** Names associated with shortcut layouts (affects gap tolerance). */
export const SHORTCUT_LAYOUT_PATTERN = /\b(inner|oasis|oval|test)\b/i;

/** A partial layout type used internally for ranking (not all fields required). */
interface RankableLayout {
  name: string;
  nameSourceRank?: number;
  nodes?: LatLonNode[];
  stats?: { lengthMetres?: number };
}

/**
 * Normalize a single layout name, resolving known aliases.
 */
function canonicalizeLayoutName(name: string): string {
  const normalizedName = normalizeCircuitName(name);

  if (normalizedName === 'flat oval layout' || normalizedName === 'bahrain oval gp') {
    return 'Test Oval';
  }

  return name;
}

/**
 * Score a layout for ranking purposes.
 * Higher is better (preferred/main configuration).
 */
function scoreLayoutChoice(layout: RankableLayout, trackName: string | null): number {
  const name = layout?.name?.trim() ?? '';
  let score = 0;

  if (namesLikelyMatchCircuit(name, trackName ?? '')) {
    score += 420;
  }
  if (PRIMARY_LAYOUT_PATTERN.test(name)) {
    score += 520;
  }
  if (name === 'Main') {
    score += 260;
  }
  if (SECONDARY_LAYOUT_PATTERN.test(name)) {
    score -= 360;
  }

  score += Math.min(layout?.stats?.lengthMetres ?? 0, 9000) / 20;
  return score;
}

/**
 * Rank layouts for a given track, best first.
 */
export function rankLayoutsForTrack<T extends RankableLayout>(layouts: T[], trackName: string | null): T[] {
  return [...layouts].sort((a, b) => {
    const sourceRankDelta = (b?.nameSourceRank ?? 0) - (a?.nameSourceRank ?? 0);
    if (sourceRankDelta !== 0) {
      return sourceRankDelta;
    }

    const scoreDelta = scoreLayoutChoice(b, trackName) - scoreLayoutChoice(a, trackName);
    if (Math.abs(scoreDelta) > 1) {
      return scoreDelta;
    }

    const lengthDelta = (b?.stats?.lengthMetres ?? 0) - (a?.stats?.lengthMetres ?? 0);
    if (Math.abs(lengthDelta) > 1) {
      return lengthDelta;
    }

    return a.name.localeCompare(b.name);
  });
}

/**
 * Compare two layouts for ranking (negative = a wins, positive = b wins).
 */
export function compareLayoutsForTrack<T extends RankableLayout>(trackName: string | null, a: T, b: T): number {
  const sourceRankDelta = (b?.nameSourceRank ?? 0) - (a?.nameSourceRank ?? 0);
  if (sourceRankDelta !== 0) {
    return sourceRankDelta;
  }

  const scoreDelta = scoreLayoutChoice(b, trackName) - scoreLayoutChoice(a, trackName);
  if (Math.abs(scoreDelta) > 1) {
    return scoreDelta;
  }

  const lengthDelta = (b?.stats?.lengthMetres ?? 0) - (a?.stats?.lengthMetres ?? 0);
  if (Math.abs(lengthDelta) > 1) {
    return lengthDelta;
  }

  return a.name.localeCompare(b.name);
}

/**
 * Sample `sampleCount` evenly-spaced nodes from a node chain.
 * Excludes the final duplicate closing node of a closed chain.
 */
export function sampleChainNodes(nodes: LatLonNode[], sampleCount = 24): LatLonNode[] {
  const baseNodes = nodes.length > 1 ? nodes.slice(0, -1) : nodes;
  if (baseNodes.length <= sampleCount) {
    return baseNodes;
  }

  return Array.from({ length: sampleCount }, (_, index) => {
    const sampleIndex = Math.floor((index * baseNodes.length) / sampleCount);
    return baseNodes[sampleIndex]!;
  });
}

/** Internal candidate type used for geometry comparison. */
interface GeometryCandidate {
  nodes: LatLonNode[];
  length: number;
  dedupeGroup?: string | undefined;
}

/**
 * Return the index of a near-duplicate of `candidate` within `existingCandidates`,
 * or -1 if none found.
 */
function isNearDuplicateLayoutCandidate(candidate: GeometryCandidate, existingCandidates: GeometryCandidate[]): number {
  const MAX_LENGTH_DELTA = 250;
  const MAX_NODE_DISTANCE = SNAP_FUZZY * 4;

  return existingCandidates.findIndex(existing => {
    // Layouts sharing a dedupeGroup were intentionally created together (e.g.
    // backbone + substitution variants). Their short variant sections may run
    // very close to the backbone (< 100m) but represent genuinely different routes.
    if (candidate.dedupeGroup && candidate.dedupeGroup === existing.dedupeGroup) {
      return false;
    }

    if (Math.abs(existing.length - candidate.length) > MAX_LENGTH_DELTA) {
      return false;
    }

    const candidateSamples = sampleChainNodes(candidate.nodes);
    const existingSamples = sampleChainNodes(existing.nodes);
    return candidateSamples.every(node => findClosestNodePositions(existing.nodes, node, MAX_NODE_DISTANCE, 1).length > 0)
      && existingSamples.every(node => findClosestNodePositions(candidate.nodes, node, MAX_NODE_DISTANCE, 1).length > 0);
  });
}

/**
 * Remove geometrically near-identical layouts, keeping the best-ranked one of each group.
 */
export function dedupeLayoutsByGeometry<T extends RankableLayout & { nodes?: LatLonNode[]; stats?: { lengthMetres?: number }; _dedupeGroup?: string }>(
  layouts: T[],
  trackName: string | null,
): T[] {
  const rankedLayouts = rankLayoutsForTrack(layouts, trackName);
  const dedupedLayouts: T[] = [];
  const seenCandidates: GeometryCandidate[] = [];

  for (const layout of rankedLayouts) {
    const candidate: GeometryCandidate = {
      nodes: layout.nodes ?? [],
      length: layout?.stats?.lengthMetres ?? measurePolylineLength(layout.nodes ?? []),
      dedupeGroup: layout._dedupeGroup,
    };

    if (isNearDuplicateLayoutCandidate(candidate, seenCandidates) >= 0) {
      continue;
    }

    seenCandidates.push(candidate);
    dedupedLayouts.push(layout);
  }

  return dedupedLayouts;
}

/**
 * Remove layouts with duplicate normalized names, keeping the best-ranked one.
 */
export function dedupeLayoutsByName<T extends RankableLayout>(layouts: T[], trackName: string | null): T[] {
  const bestLayoutsByName = new Map<string, T>();

  for (const layout of layouts) {
    const key = normalizeCircuitName(layout.name);
    const existing = bestLayoutsByName.get(key);
    if (!existing || compareLayoutsForTrack(trackName, layout, existing) < 0) {
      bestLayoutsByName.set(key, layout);
    }
  }

  return [...bestLayoutsByName.values()];
}

/**
 * Canonicalize layout names in a layout array (resolves known name aliases).
 */
export function canonicalizeLayoutNames<T extends { name: string }>(layouts: T[]): T[] {
  return layouts.map(layout => ({
    ...layout,
    name: canonicalizeLayoutName(layout.name),
  }));
}
