/**
 * Thin re-export shim — all logic has moved to src/preview/renderer.ts.
 * This file exists so that existing imports from './preview.js' continue to work.
 */

export { initPreview, updatePreview } from './preview/renderer.js';
