// Compatibility shim — re-exports from the typed geometry sub-modules.
// Existing importers (model.js, search.js, build-track-geometry-index.mjs) can
// continue to import from './geometry.js' without changes.
export { projectNodes } from './geometry/projection.ts';
export { buildTrackOutline, buildBasePlate } from './geometry/outline.ts';
