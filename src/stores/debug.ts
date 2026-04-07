import { writable } from 'svelte/store';
import type { RankedTextPlacement, TextPlacementCandidate, Rect2D } from '../types/text.js';

export interface PlacementDebugData {
  allScoredPlacements: RankedTextPlacement[];
  candidates: TextPlacementCandidate[];
  scaledBasePlate: Rect2D;
}

export const placementDebugData = writable<PlacementDebugData | null>(null);
export const debugScreenVisible = writable<boolean>(false);
