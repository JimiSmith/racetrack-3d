/**
 * Stores for the 3D model and its intermediate geometry data.
 */

import { writable } from 'svelte/store';
import type { LatLonNode, ProjectedNode } from '../types/geometry.js';
import type { TrackModel, OutlinePoints, BasePlate } from '../types/model.js';

/** The fully built 3D track model, ready for rendering and export. */
export const currentModel = writable<TrackModel | null>(null);

/** Geographic nodes of the primary layout (raw lat/lon). */
export const nodes = writable<LatLonNode[] | null>(null);

/** Projected nodes of the primary layout (metres from centroid). */
export const projectedNodes = writable<ProjectedNode[] | null>(null);

/** Elevation data for the primary layout nodes. */
export const elevations = writable<number[] | null>(null);

/** Elevation data for each secondary layout (parallel-indexed to secondary layouts). */
export const secondaryElevations = writable<(number[] | null)[]>([]);

/** Buffered outline of the primary layout. */
export const outline = writable<OutlinePoints | null>(null);

/** Axis-aligned bounding box for the model base plate. */
export const basePlate = writable<BasePlate | null>(null);
