/**
 * Node-chain cleanup utilities — closing near-closed chains, fixing reversals,
 * collapsing backtracks, and deduplicating sequential nodes.
 * No side effects. No DOM access.
 */

import type { LatLonNode } from '../types/geometry.js';
import { computeEndpointGap, measureDistanceMetres, dist } from './geo-math.js';

// Exact snap: shared OSM node (same coords). Fuzzy snap: slight gap in OSM data (~30m).
export const SNAP_EXACT = 1e-5;
export const SNAP_FUZZY = 3e-4; // ~30m — catches gaps in OSM data without pulling in distant outliers

/**
 * If the first and last nodes of a chain are within `maxGapMetres` of each
 * other (but not already identical), append a copy of the first node to close
 * the chain. Returns the original array unchanged if the chain is already
 * closed or the gap is too large.
 */
export function closeNodeChainIfNearClosed(
  nodes: LatLonNode[],
  maxGapMetres = 80,
): LatLonNode[] {
  if (nodes.length < 2) {
    return nodes;
  }

  // Safe: length >= 2 checked above.
  const first = nodes[0] as LatLonNode;
  const last = nodes[nodes.length - 1] as LatLonNode;
  if (first.lat === last.lat && first.lon === last.lon) {
    return nodes;
  }

  return computeEndpointGap(nodes) <= maxGapMetres
    ? [...nodes, first]
    : nodes;
}

/**
 * Fix "spikes" in a node chain where a section is traversed backwards.
 * A spike shows up as two near-180° reversals — the chain goes forward, then
 * abruptly backward (reversal 1), then forward again (reversal 2).
 * Reversing the section between the two reversal points fixes the winding.
 * Genuine sharp corners (hairpins) don't create paired reversals like this.
 */
export function fixChainReversals(nodes: LatLonNode[]): LatLonNode[] {
  if (nodes.length < 6) { return nodes; }

  const reversals: number[] = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    // Safe: i ranges from 1 to nodes.length - 2, so i-1, i, and i+1 are all in bounds.
    const nodePrev = nodes[i - 1] as LatLonNode;
    const nodeCurr = nodes[i] as LatLonNode;
    const nodeNext = nodes[i + 1] as LatLonNode;
    const d1lat = nodeCurr.lat - nodePrev.lat;
    const d1lon = nodeCurr.lon - nodePrev.lon;
    const d2lat = nodeNext.lat - nodeCurr.lat;
    const d2lon = nodeNext.lon - nodeCurr.lon;
    const m1 = Math.sqrt(d1lat * d1lat + d1lon * d1lon);
    const m2 = Math.sqrt(d2lat * d2lat + d2lon * d2lon);
    if (m1 > 1e-10 && m2 > 1e-10) {
      const dot = (d1lat * d2lat + d1lon * d2lon) / (m1 * m2);
      if (dot < -0.9) { reversals.push(i); }
    }
  }

  if (reversals.length < 2) { return nodes; }

  // Fix in pairs: reverse the section between each consecutive pair of reversals.
  const result = [...nodes];
  for (let i = 0; i + 1 < reversals.length; i += 2) {
    // Safe: loop ensures i and i+1 are valid indices into reversals.
    const start = reversals[i] as number;
    const end = reversals[i + 1] as number;
    const section = result.slice(start + 1, end + 1).reverse();
    result.splice(start + 1, end - start, ...section);
  }
  return result;
}

/**
 * Detect whether visiting `current` between `prev` and `next` is an
 * immediate backtrack — i.e. the path goes to `current` and immediately
 * reverses back almost to `prev`.
 */
export function isImmediateBacktrack(
  prev: LatLonNode,
  current: LatLonNode,
  next: LatLonNode,
): boolean {
  const lenA = measureDistanceMetres(prev, current);
  const lenB = measureDistanceMetres(current, next);
  if (lenA < 0.01 || lenB < 0.01) {
    return false;
  }

  const d1x = current.lon - prev.lon;
  const d1y = current.lat - prev.lat;
  const d2x = next.lon - current.lon;
  const d2y = next.lat - current.lat;
  const dot = (d1x * d2x + d1y * d2y) / (Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y));
  const returnGap = measureDistanceMetres(prev, next);
  if (dot < -0.98 && returnGap <= Math.max(lenA, lenB) * 0.25) {
    return true;
  }

  return Math.max(lenA, lenB) <= 10
    && dot < -0.8
    && returnGap <= Math.max(lenA, lenB) * 0.75;
}

/**
 * Iteratively collapse immediate backtracks from a node chain until no more
 * are found. Deduplicates sequential nodes after each pass.
 */
export function collapseImmediateBacktracks(nodes: LatLonNode[]): LatLonNode[] {
  let result = [...nodes];
  let changed = true;

  while (changed && result.length >= 3) {
    changed = false;
    // Safe: result.length >= 3, so result[0] exists.
    const collapsed: LatLonNode[] = [result[0] as LatLonNode];

    for (let index = 1; index < result.length - 1; index += 1) {
      // Safe: collapsed is never empty (seeded with result[0]).
      const prev = collapsed[collapsed.length - 1] as LatLonNode;
      // Safe: index ranges 1..result.length-2, and index+1 <= result.length-1.
      const current = result[index] as LatLonNode;
      const next = result[index + 1] as LatLonNode;

      if (isImmediateBacktrack(prev, current, next)) {
        changed = true;
        continue;
      }

      collapsed.push(current);
    }

    // Safe: result.length >= 3, so last element exists.
    collapsed.push(result[result.length - 1] as LatLonNode);
    result = dedupeSequentialNodes(collapsed);
  }

  return result;
}

/**
 * Remove consecutive duplicate nodes from a chain. Two nodes are considered
 * duplicates if their Manhattan lat/lon distance is less than `SNAP_EXACT`.
 */
export function dedupeSequentialNodes(nodes: LatLonNode[]): LatLonNode[] {
  const deduped: LatLonNode[] = [];

  for (const node of nodes) {
    const prev = deduped[deduped.length - 1];
    if (!prev || dist(prev, node) >= SNAP_EXACT) {
      deduped.push(node);
    }
  }

  return deduped;
}
