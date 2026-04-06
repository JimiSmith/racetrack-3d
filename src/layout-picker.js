/**
 * Thin re-export shim — all logic has moved to src/search/layout-picker.ts.
 * This file exists so that existing imports from './layout-picker.js' continue to work.
 */

export {
  formatLayoutOptionLabel,
  normalizeSelectedLayoutIndex,
  getSelectedLayout,
  buildLayoutPickerState,
} from './search/layout-picker.js';
