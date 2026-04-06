/**
 * Final normalization of track geometry results.
 * Cleans up layout geometry, deduplicates, and canonicalizes names.
 * No side effects. No DOM access.
 */

import type { LatLonNode, Layout } from '../types/geometry.js';
import { measurePolylineLength } from './geo-math.js';
import {
  closeNodeChainIfNearClosed,
  collapseImmediateBacktracks,
  fixChainReversals,
  dedupeSequentialNodes,
} from './chain-cleanup.js';
import {
  dedupeLayoutsByGeometry,
  dedupeLayoutsByName,
  canonicalizeLayoutNames,
} from './layout-dedup.js';

/** The top-level geometry result shape expected by the normalizer. */
interface TrackGeometryResultLike {
  layouts: Array<Layout & { nameSourceRank?: number; groupWayNames?: string[] }>;
  selectedLayoutIndex?: number;
  osmVenueNames?: string[];
  [key: string]: unknown;
}

/**
 * Apply geometry cleanup to each layout node chain.
 */
function normalizeLayoutGeometry<T extends { nodes?: LatLonNode[]; stats?: { lengthMetres?: number } | null }>(
  layouts: T[],
): T[] {
  return layouts.map(layout => {
    const nodes = closeNodeChainIfNearClosed(
      collapseImmediateBacktracks(dedupeSequentialNodes(fixChainReversals(layout.nodes ?? []))),
    );
    return {
      ...layout,
      nodes,
      stats: layout.stats
        ? {
            ...layout.stats,
            lengthMetres: measurePolylineLength(nodes),
          }
        : layout.stats,
    };
  });
}

/**
 * Normalize a raw track geometry result:
 * 1. Canonicalize layout names (resolve known aliases)
 * 2. Clean up geometry (dedupe nodes, fix reversals, close gaps)
 * 3. Deduplicate by name
 * 4. Deduplicate by geometry
 *
 * @param result - The raw result to normalize (may be null/undefined)
 * @param trackName - Optional track name for ranking heuristics
 */
export function normalizeTrackGeometryResult(
  result: TrackGeometryResultLike | null | undefined,
  trackName: string | null = null,
): TrackGeometryResultLike | null | undefined {
  if (!result || !Array.isArray(result.layouts)) {
    return result;
  }

  const normalizedLayouts = dedupeLayoutsByName(
    normalizeLayoutGeometry(canonicalizeLayoutNames(result.layouts)),
    trackName,
  );

  return {
    ...result,
    layouts: dedupeLayoutsByGeometry(normalizedLayouts, trackName),
    selectedLayoutIndex: Math.min(result.selectedLayoutIndex ?? 0, Math.max(normalizedLayouts.length - 1, 0)),
  };
}
