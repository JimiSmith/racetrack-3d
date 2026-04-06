/**
 * Thin re-export shim — all logic has moved to src/elevation/terrarium.ts.
 * This file exists so that existing imports from './elevation.js' continue to work.
 */

export {
  fetchElevations,
  buildElevationProfile,
  applyExaggeration,
  smoothElevationProfile,
} from './elevation/terrarium.js';
