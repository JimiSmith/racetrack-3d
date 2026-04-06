/**
 * Stores for export operation state.
 */

import { writable, derived } from 'svelte/store';
import { outline, basePlate } from './model.js';
import { selectedTrack } from './track.js';

/** Whether an STL export is currently in progress. */
export const isExportingStl = writable<boolean>(false);

/** Whether a 3MF export is currently in progress. */
export const isExporting3mf = writable<boolean>(false);

/**
 * Whether the user can trigger an export.
 * Requires a loaded track, outline and base plate; and no export already running.
 */
export const canExport = derived(
  [isExportingStl, isExporting3mf, outline, basePlate, selectedTrack],
  ([$isExportingStl, $isExporting3mf, $outline, $basePlate, $selectedTrack]) =>
    !$isExportingStl &&
    !$isExporting3mf &&
    $outline !== null &&
    $basePlate !== null &&
    $selectedTrack !== null,
);
