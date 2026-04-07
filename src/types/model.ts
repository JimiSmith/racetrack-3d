/**
 * Shared model types used across the 3D construction pipeline.
 * These represent the outputs of the geometry → model → export stages.
 */

import type { Point2D, ProjectedNode } from './geometry.js';
import type { RankedTextPlacement, TextPlacementCandidate, Rect2D } from './text.js';

/** A 3D vertex with millimetre coordinates. */
export interface Vertex {
  x: number;
  y: number;
  z: number;
}

/** A triangle as three ordered vertices in counter-clockwise winding. */
export type Triangle = [Vertex, Vertex, Vertex];

/**
 * Axis-aligned bounding box of the model's base plate, in the projected
 * coordinate system (metres) before scaling to millimetres.
 */
export interface BasePlate {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** maxX - minX */
  width: number;
  /** maxY - minY */
  height: number;
}

/**
 * The buffered outline of a circuit, as produced by `buildTrackOutline`.
 * An outer ring plus optional inner holes (for closed circuits).
 */
export interface OutlinePoints {
  /** Counter-clockwise outer boundary of the buffered track. */
  outerRing: Point2D[];
  /** Clockwise inner hole boundaries (may be empty). */
  holes: Point2D[][];
}

/**
 * The complete output of `buildTrackModel`.
 * Contains all triangles for the base plate, track, secondary layouts,
 * and embossed text label, plus metadata for rendering and export.
 */
export interface TrackModel {
  /** All triangles in draw order: base, secondary tracks, primary track, text. */
  triangles: Triangle[];
  /** Number of triangles in the base plate section. */
  baseTriangleCount: number;
  /** Number of triangles in secondary layout sections. */
  secondaryTrackTriangleCount: number;
  /** Number of triangles in the primary layout section. */
  trackTriangleCount: number;
  /** Number of triangles in the embossed text section. */
  textTriangleCount: number;
  /** Scale factor (mm / metre) applied to all coordinates. */
  scale: number;
  /** The primary orientation input — either a degree value or 'auto'. */
  primaryOrientationDeg: number | 'auto';
  /** The resolved rotation in degrees (0, 90, 180, or 270). */
  orientationDeg: number;
  /** Requested text placement rank (1 = best, 2 = second-best, etc.). */
  textPositionRank: number;
  /** Buffered outline of the primary layout after orientation. */
  outlinePoints: OutlinePoints;
  /** Bounding box of the model's base plate. */
  basePlate: BasePlate;
  /** Projected nodes of the primary layout after orientation, or null if unavailable. */
  projectedNodes: ProjectedNode[] | null;
  /** All scored placements with breakdown data (debug only). */
  allScoredPlacements?: RankedTextPlacement[];
  /** Placement candidates evaluated during scoring (debug only). */
  placementCandidates?: TextPlacementCandidate[];
  /** Scaled base plate used for placement scoring (debug only). */
  scaledBasePlate?: Rect2D;
}
