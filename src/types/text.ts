/**
 * Shared types for the text placement and rendering pipeline.
 * These represent the scored candidate regions and layout objects
 * used to decide where to emboss the track name on the base plate.
 */

import type { Point2D } from './geometry.js';

/**
 * Axis-aligned bounding rectangle in the scaled (mm) coordinate system.
 * Used for both placement candidates and fitted text layouts.
 */
export interface Rect2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/**
 * A single placement candidate rectangle found by `findPlacementCandidates`.
 * Coordinates are in the grid cell system; `bounds` gives mm coordinates.
 */
export interface TextPlacementCandidate {
  /** Left cell column index (inclusive). */
  left: number;
  /** Right cell column index (inclusive). */
  right: number;
  /** Top cell row index (inclusive). */
  top: number;
  /** Bottom cell row index (inclusive). */
  bottom: number;
  widthCells: number;
  heightCells: number;
  areaCells: number;
  /** Fraction of this candidate that lies outside the track outline (0–1). */
  fractionOutside: number;
  /** Cells of clearance from the nearest blocked (track obstacle) cell. */
  trackClearance: number;
  /** `trackClearance` normalised to [0, 1]. */
  normalizedTrackClearance: number;
  /** Ordinal index within the candidates array. */
  index: number;
  /** Bounding box in mm coordinates. */
  bounds: Rect2D;
  /** Area of the bounding box in mm². */
  area: number;
}

/**
 * A text layout that has been scaled to fit inside a candidate rectangle.
 * Produced by `scaleLayoutsToRect` and used in scoring and final mesh generation.
 */
export interface FittedTextLayout {
  /** The full text string (newline-separated when multi-line). */
  text: string;
  /** Individual line strings. */
  lines: string[];
  /** Scale factor applied to the normalised glyph contours. */
  scale: number;
  /** Bounding box of the unscaled glyph contours (before `scale` is applied). */
  bounds: Rect2D;
  /** Per-line bounding boxes (unscaled). */
  lineBounds: Rect2D[];
  /** Contour polygons for all glyphs (unscaled). */
  contours: Point2D[][];
  /** Width of the fitted text in mm (`bounds.width * scale`). */
  fittedWidth: number;
  /** Height of the fitted text in mm (`bounds.height * scale`). */
  fittedHeight: number;
  /** Average line height across all lines (unscaled). */
  averageLineHeight: number;
  /** Width of the widest line (unscaled). */
  maxLineWidth: number;
  /** Width of the narrowest line (unscaled). */
  minLineWidth: number;
  /** Number of text lines. */
  lineCount: number;
  /** Score assigned to this layout within the candidate. */
  score: number;
}

/**
 * Per-multiplier breakdown of a placement score, returned by `scoreTextFit`.
 * `textHeight` is informational (input to `sizeWindowMultiplier`).
 * The remaining fields are direct multipliers in the composite product.
 */
export interface PlacementScoreBreakdown {
  lineBalance: number;
  textHeight: number;
  outsideMultiplier: number;
  lineCountMultiplier: number;
  sizeWindowMultiplier: number;
  trackClearanceMultiplier: number;
  textClearanceMultiplier: number;
}

/**
 * A single ranked text placement: a candidate region paired with its
 * best-fitting layout and a composite score.
 */
export interface RankedTextPlacement {
  candidate: TextPlacementCandidate;
  candidateIndex: number;
  layout: FittedTextLayout;
  score: number;
  scoreBreakdown?: PlacementScoreBreakdown;
}

/**
 * The result of `computeRankedTextPlacements` — an ordered list of scored
 * placements together with the context used to compute them.
 */
export interface RankedPlacements {
  /** Up to 3 ranked placement options (best first). */
  placements: RankedTextPlacement[];
  /** All scored placements (for debug inspection). */
  allScoredPlacements?: RankedTextPlacement[];
  /** Clearance context used for text-vs-text spacing. */
  clearanceContext: {
    distanceMap: number[][];
    maxTrackClearance: number;
    cellWidth: number;
    cellHeight: number;
    originX: number;
    originY: number;
  };
  /** All placement candidates that were evaluated. */
  candidates: TextPlacementCandidate[];
  /** The scaled base plate used for this computation. */
  scaledBasePlate: Rect2D;
}

/**
 * The tuning surface for the text placement scoring pipeline.
 * All magic numbers are collected here so they can be seen — and adjusted — in one place.
 * Shape mirrors the frozen `SCORING_WEIGHTS` object in `text3d.js`.
 */
export interface ScoringWeights {
  /** Minimum multiplier when the candidate is fully inside the track outline. */
  outsideMultiplierMin: number;
  /** Additional multiplier range scaled by `fractionOutside` (0–1). */
  outsideMultiplierRange: number;
  /** Base multiplier for track clearance (applied when clearance is 0). */
  trackClearanceMultiplierBase: number;
  /** Additional multiplier range scaled by normalised track clearance. */
  trackClearanceMultiplierRange: number;
  /** Base multiplier for text clearance (applied when clearance is 0). */
  textClearanceMultiplierBase: number;
  /** Additional multiplier range scaled by normalised text clearance. */
  textClearanceMultiplierRange: number;
  /** Per-line-count multipliers; index 0 = 1 line, index 3 = 4 lines. */
  lineCountMultipliers: [number, number, number, number];
  /** Line-balance damping per line count; index 0 = 2 lines, index 2 = 4 lines. */
  lineBalanceDamping: [number, number, number];
  /** Lines within this fraction of the longest line width incur no balance penalty (e.g. 0.30 = 30% window). */
  lineBalanceWindow: number;
  /** Maximum multiplier at the low end of the preferred height range. */
  sizeWindowLowPeak: number;
  /** Additional range across the preferred height window. */
  sizeWindowPreferredRange: number;
  /** Peak multiplier just above the preferred height ceiling. */
  sizeWindowHighPeak: number;
  /** Last-line width / targetWidth below this ratio is considered an orphan. */
  orphanThreshold: number;
  /** Additive penalty for orphan lines, as a multiple of targetWidth². */
  orphanPenaltyWeight: number;
  /** Score bonus for landscape (width >= height) orientation. */
  landscapeBonus: number;
  /** Score bonus when text centroid sits in the lower half of the plate. */
  textBottomBonus: number;
}
