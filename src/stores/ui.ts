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

/** Whether the current status message represents an error. */
export const statusIsError = writable<boolean>(false);

/**
 * Whether a model rebuild is currently in flight. The model pipeline is async
 * (manifold-3d CSG), so a non-blocking overlay shows while a regeneration runs;
 * the prior preview stays visible until the new model arrives.
 */
export const isRebuilding = writable<boolean>(false);

/** State controlling the preview canvas overlay. */
export const previewOverlayState = writable<PreviewOverlayState>({
  title: 'Search for a track',
  body: 'Choose a circuit to load a large live preview and export a 3D model.',
  hidden: false,
});
