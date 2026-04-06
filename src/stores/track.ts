/**
 * Stores for the currently selected track and its available layouts.
 */

import { writable, derived } from 'svelte/store';
import type { Layout } from '../types/geometry.js';
import type { SearchResult } from '../types/search.js';

/** The track selected by the user from the search results. */
export const selectedTrack = writable<SearchResult | null>(null);

/** All layouts available for the selected track. */
export const layouts = writable<Layout[]>([]);

/** Index of the currently selected layout within `layouts`. */
export const layoutIndex = writable<number>(0);

/** OSM venue name strings collected for the selected track. */
export const osmVenueNames = writable<string[]>([]);

/** The currently selected layout, derived from `layouts` and `layoutIndex`. */
export const selectedLayout = derived(
  [layouts, layoutIndex],
  ([$layouts, $layoutIndex]) => $layouts[$layoutIndex] ?? null,
);
