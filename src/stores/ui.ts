/**
 * Stores for general UI state.
 */

import { writable } from 'svelte/store';

/** State object for the preview canvas overlay message. */
export interface PreviewOverlayState {
  /** Heading shown in the overlay. */
  title: string;
  /** Body text shown in the overlay. */
  body: string;
  /** When true the overlay is hidden and title/body are ignored. */
  hidden: boolean;
}

/** Whether the track summary panel is expanded by the user. */
export const isTrackSummaryExpanded = writable<boolean>(true);

/** The current status bar message; empty string means no message. */
export const statusMessage = writable<string>('');

/** State controlling the preview canvas overlay. */
export const previewOverlayState = writable<PreviewOverlayState>({
  title: 'Search for a track',
  body: 'Choose a circuit to load a large live preview and export a 3D model.',
  hidden: false,
});
