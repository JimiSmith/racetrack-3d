import trackSearchIndex from './generated/track-search-index.json' with { type: 'json' };
import { getTrackGeometry } from './geometry-index.js';
import { searchLocalTrackIndex } from './search-index.js';

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
} from './search-index.js';

export async function searchTracks(query, signal) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return searchLocalTrackIndex(query, trackSearchIndex);
}

// Returns prebuilt geometry for a circuit from the local geometry index.
// Throws if no prebuilt entry is found — there is no runtime network fallback.
export async function fetchTrackGeometry(trackName, options = {}) {
  const localGeometry = await getTrackGeometry(options.wikidataId);
  if (localGeometry) {
    return localGeometry;
  }

  throw new Error(`No prebuilt geometry available for ${trackName ?? 'this circuit'}`);
}
