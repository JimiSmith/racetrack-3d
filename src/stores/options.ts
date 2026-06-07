/**
 * Stores for user-configurable rendering and label options.
 */

import { writable, derived } from 'svelte/store';
import { selectPrintedTrackName } from '../search/index.js';
import { DEFAULT_TEXT_POSITION_RANK } from '../text/index.js';
import { selectedTrack, layouts, layoutIndex, osmVenueNames } from './track.js';

/** Primary orientation of the model in degrees, or 'auto'. */
export const primaryOrientationDeg = writable<number | 'auto'>('auto');

/** Text placement rank (1 = best placement, 2 = second-best, etc.). */
export const textPositionRank = writable<number>(DEFAULT_TEXT_POSITION_RANK);

/** User-supplied label override; null means use the auto-derived label. */
export const labelOverride = writable<string | null>(null);

/** Whether to render all layouts combined into a single model. */
export const combinedLayoutMode = writable<boolean>(false);

/** Elevation exaggeration multiplier (e.g. 1 = no exaggeration, 2 = double). */
export const exaggeration = writable<number>(1);

/**
 * Whether to auto-derive the printed track width.
 * When true: non-coaster uses TRACK_WIDTH_METRES (12 m); coaster uses
 * max(TRACK_WIDTH_METRES, MIN_COASTER_TRACK_WIDTH_MM / scale).
 * When false: width is taken from `trackWidthMm` directly.
 */
export const trackWidthAuto = writable<boolean>(true);

/** User-selected printed track width in mm (used when trackWidthAuto is false). */
export const trackWidthMm = writable<number>(2);

/** Whether the model is built as a fixed-size 9x9 cm coaster with a level top. */
export const coasterMode = writable<boolean>(false);

/** Outline shape used in coaster mode. */
export const coasterShape = writable<'round' | 'square'>('round');

/**
 * How the track/text inlay sits on the coaster top.
 * - 'flush': strictly coplanar with the base top (holes cut in the base top face).
 * - 'raised': sits 0.2 mm above the base top (works well with colour-change layers).
 */
export const coasterInlay = writable<'flush' | 'raised'>('raised');

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
