/**
 * Thin re-export shim — all logic has moved to src/search/geometry-index.ts.
 * This file exists so that existing imports from './geometry-index.js' continue to work.
 */

export { getTrackGeometry } from './search/geometry-index.js';
