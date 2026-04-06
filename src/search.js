/**
 * Thin re-export shim — all logic has moved to src/search/.
 * This file exists so that existing imports from './search.js' continue to work.
 */

// Re-export geometry modules for backward compatibility
export { buildWayGraph, buildCycleFromEdges } from './geometry/way-graph.js';
export { stitchWaysOrdered } from './geometry/way-stitching.js';
export { detectForkSections } from './geometry/fork-detection.js';
export { buildVariantLayouts, buildLayoutsFromWays } from './geometry/layout-builder.js';
export { normalizeTrackGeometryResult } from './geometry/normalize.js';
export { buildTrackGeometryFromPayload } from './geometry/track-geometry.js';

export {
  buildTrackDisplayName,
  buildTrackSearchEntry,
  normalizeSearchText,
  searchLocalTrackIndex,
  tokenizeNormalizedText,
  searchTracks,
  fetchTrackGeometry,
} from './search/index.js';
