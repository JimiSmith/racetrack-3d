/**
 * Stores for user-configurable rendering and label options.
 */

import { writable, derived } from 'svelte/store';
import { selectPrintedTrackName } from '../search/index.js';
import { normalizePrimaryOrientationDeg } from '../model/orientation.js';
import { DEFAULT_TEXT_POSITION_RANK } from '../text3d.js';
import { selectedTrack, layouts, layoutIndex, osmVenueNames } from './track.js';

/** Primary orientation of the model in degrees, or 'auto'. */
export const primaryOrientationDeg = writable<number | 'auto'>(
  normalizePrimaryOrientationDeg(undefined),
);

/** Text placement rank (1 = best placement, 2 = second-best, etc.). */
export const textPositionRank = writable<number>(DEFAULT_TEXT_POSITION_RANK);

/** User-supplied label override; null means use the auto-derived label. */
export const labelOverride = writable<string | null>(null);

/** Whether to render all layouts combined into a single model. */
export const combinedLayoutMode = writable<boolean>(false);

/** Elevation exaggeration multiplier (e.g. 1 = no exaggeration, 2 = double). */
export const exaggeration = writable<number>(1);

/**
 * Cache-busting token for text placement; replaced with a new object whenever
 * placement needs to be invalidated (e.g. after orientation or track changes).
 */
export const placementCacheToken = writable<object | null>(null);

/**
 * The label that will actually be embossed on the model.
 * Uses `labelOverride` if set; otherwise falls back to the auto-selected
 * printed name derived from the track metadata and selected layout.
 */
export const effectiveLabel = derived(
  [labelOverride, selectedTrack, layouts, layoutIndex, osmVenueNames],
  ([$labelOverride, $selectedTrack, $layouts, $layoutIndex, $osmVenueNames]) => {
    if ($labelOverride !== null) {
      return $labelOverride;
    }

    const layout = $layouts[$layoutIndex] ?? null;

    return selectPrintedTrackName({
      wikidataLabel: $selectedTrack?.wikidataLabel ?? $selectedTrack?.name ?? null,
      wikidataAliases: $selectedTrack?.wikidataAliases ?? [],
      wikidataShortName: $selectedTrack?.wikidataShortName ?? null,
      description: $selectedTrack?.wikidataDescription ?? null,
      osmVenueNames: $osmVenueNames,
      selectedLayoutName: layout?.name ?? null,
    }).printedName;
  },
);
