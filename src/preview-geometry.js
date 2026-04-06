/**
 * Thin re-export shim — all logic has moved to src/preview/model-mesh.ts.
 * This file exists so that existing imports from './preview-geometry.js' continue to work.
 */

export { buildPreviewGeometry } from './preview/model-mesh.js';
