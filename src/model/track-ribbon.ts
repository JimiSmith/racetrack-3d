import type { ProjectedNode } from '../types/geometry.js';

export const TRACK_HEIGHT_MM = 3;
export const COASTER_TRACK_HEIGHT_FLUSH_MM = 1;     // fills a 1 mm pocket carved into the top of the base
export const COASTER_TRACK_HEIGHT_RAISED_MM = 0.2;  // thin inlay sitting on top of the base
export const TRACK_WIDTH_METRES = 12;
/** Minimum ribbon width in coaster mode, in mm (thin tracks look fragile at small scales). */
export const MIN_COASTER_TRACK_WIDTH_MM = 1.0;

export interface RibbonMeshOptions {
  /** Height of the ribbon above its base, in mm. Defaults to TRACK_HEIGHT_MM. */
  trackHeightMm?: number;
  /** If true, ignore per-node elevation (flat ribbon). Defaults to false. */
  ignoreElevation?: boolean;
  /** Z of the ribbon base (top surface of the base plate). Defaults to BASE_THICKNESS_MM. */
  baseZ?: number;
  /** Track width in metres. Defaults to TRACK_WIDTH_METRES. */
  trackWidthMetres?: number;
}

/**
 * Cleans a projected centreline path: drops non-finite and consecutive-duplicate
 * points, and removes a closing point that coincides with the start. Live consumers:
 * `orientation.ts`, `track-model.ts`, the CSG ribbon elevation sampler.
 */
export function normalizeProjectedPath(projectedNodes: ProjectedNode[] | null | undefined): ProjectedNode[] {
  if (!projectedNodes?.length) {
    return [];
  }

  const normalized: ProjectedNode[] = [];

  for (const node of projectedNodes) {
    if (!Number.isFinite(node?.x) || !Number.isFinite(node?.y)) {
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && previous.x === node.x && previous.y === node.y) {
      continue;
    }

    normalized.push(node);
  }

  if (normalized.length > 2) {
    const first = normalized[0]!;
    const last = normalized[normalized.length - 1]!;
    if (first.x === last.x && first.y === last.y) {
      normalized.pop();
    }
  }

  return normalized;
}
