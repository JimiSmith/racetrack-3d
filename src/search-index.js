/**
 * Thin re-export shim — all logic has moved to src/search/.
 * This file exists so that existing imports from './search-index.js' continue to work.
 */

export {
  normalizeSearchText,
  tokenizeNormalizedText,
  buildTrackSearchEntry,
  buildTrackDisplayName,
} from './search/normalize.js';

export { searchLocalTrackIndex, compareTrackSearchResults } from './search/scoring.js';
