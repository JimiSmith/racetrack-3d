import trackSearchIndex from '../generated/track-search-index.json' with { type: 'json' };
import type { TrackSearchEntry, SearchResult } from '../types/search.js';
import { getTrackGeometry } from './geometry-index.js';
import { searchLocalTrackIndex } from './scoring.js';

export { normalizeSearchText, tokenizeNormalizedText, buildTrackSearchEntry, buildTrackDisplayName } from './normalize.js';
export { searchLocalTrackIndex, compareTrackSearchResults } from './scoring.js';
export { selectPrintedTrackName } from './track-name.js';
export { getTrackGeometry } from './geometry-index.js';
export {
  formatLayoutOptionLabel,
  normalizeSelectedLayoutIndex,
  getSelectedLayout,
  buildLayoutPickerState,
} from './layout-picker.js';
export type { PrintedTrackNameResult } from './track-name.js';

export async function searchTracks(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return searchLocalTrackIndex(query, trackSearchIndex as TrackSearchEntry[]);
}

// Returns prebuilt geometry for a circuit from the local geometry index.
// Throws if no prebuilt entry is found — there is no runtime network fallback.
export async function fetchTrackGeometry(
  trackName: string | null | undefined,
  options: { wikidataId?: string | null } = {},
): Promise<unknown> {
  const localGeometry = await getTrackGeometry(options.wikidataId);
  if (localGeometry) {
    return localGeometry;
  }

  throw new Error(`No prebuilt geometry available for ${trackName ?? 'this circuit'}`);
}
