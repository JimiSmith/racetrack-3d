/**
 * Scoring weights and magic numbers used by the text-placement scoring pipeline.
 * Collected here so the tuning surface is visible in one place.
 */
import type { ScoringWeights, FittedTextLayout, Rect2D, PlacementScoreBreakdown } from '../types/text.js';

export const SCORING_WEIGHTS: ScoringWeights = Object.freeze({
  /** Minimum multiplier when the candidate is fully inside the track outline. */
  outsideMultiplierMin: 0.25,
  /** Additional multiplier range scaled by fractionOutside (0-1). */
  outsideMultiplierRange: 0.75,

  /** Base multiplier for track clearance (applied when clearance is 0). */
  trackClearanceMultiplierBase: 0.92,
  /** Additional multiplier range scaled by normalized track clearance. */
  trackClearanceMultiplierRange: 0.08,

  /** Base multiplier for text clearance (applied when clearance is 0). */
  textClearanceMultiplierBase: 0.96,
  /** Additional multiplier range scaled by normalized text clearance. */
  textClearanceMultiplierRange: 0.04,

  /** Per-line-count multipliers; index 0 = 1 line, index 3 = 4 lines. */
  lineCountMultipliers: [1, 1, 0.94, 0.91] as [number, number, number, number],
  /** Line-balance damping per line count; index 0 = 2 lines, index 2 = 4 lines. */
  lineBalanceDamping: [0.75, 0.25, 0] as [number, number, number],
  /** Lines within this fraction of the longest line width incur no balance penalty. */
  lineBalanceWindow: 0.30,

  // --- Size-window curve breakpoints (computeSizeWindowMultiplier) ---
  /** Maximum multiplier at the low end of the preferred height range. */
  sizeWindowLowPeak: 0.6,
  /** Additional range across the preferred height window. */
  sizeWindowPreferredRange: 0.65,
  /** Peak multiplier just above the preferred height ceiling. */
  sizeWindowHighPeak: 1.25,

  // --- DP line-breaking cost function (findOptimalLineBreaks) ---
  /** Last-line width / targetWidth below this ratio is considered an orphan. */
  orphanThreshold: 0.65,
  /** Additive penalty for orphan lines, as a multiple of targetWidth². */
  orphanPenaltyWeight: 10.0,

  // --- Orientation selection bonuses (selectAutoOrientation in model.js) ---
  /** Score bonus for landscape (width >= height) orientation. */
  landscapeBonus: 1000,
  /** Score bonus when text centroid sits in the lower half of the plate. */
  textBottomBonus: 100,
});

const MIN_TEXT_HEIGHT_MM = 2;
const MIN_PREFERRED_HEIGHT_MM = 16 * 25.4 / 72;
const MAX_PREFERRED_HEIGHT_MM = 24 * 25.4 / 72;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeSizeWindowMultiplier(heightMm: number): number {
  if (heightMm <= MIN_TEXT_HEIGHT_MM) {
    return 0;
  }

  const zone2Span = MIN_PREFERRED_HEIGHT_MM - MIN_TEXT_HEIGHT_MM;

  if (heightMm < MIN_PREFERRED_HEIGHT_MM) {
    const t = clamp(
      (heightMm - MIN_TEXT_HEIGHT_MM) / zone2Span,
      0,
      1,
    );
    return t * t * t * SCORING_WEIGHTS.sizeWindowLowPeak;
  }

  if (heightMm <= MAX_PREFERRED_HEIGHT_MM) {
    const t = (heightMm - MIN_PREFERRED_HEIGHT_MM) / (MAX_PREFERRED_HEIGHT_MM - MIN_PREFERRED_HEIGHT_MM);
    return SCORING_WEIGHTS.sizeWindowLowPeak + SCORING_WEIGHTS.sizeWindowPreferredRange * clamp(t, 0, 1);
  }

  const zone4End = MAX_PREFERRED_HEIGHT_MM + zone2Span;
  if (heightMm <= zone4End) {
    const t = clamp((heightMm - MAX_PREFERRED_HEIGHT_MM) / zone2Span, 0, 1);
    return SCORING_WEIGHTS.sizeWindowHighPeak * (1 - t);
  }

  return 0;
}

export function computeLineCountMultiplier(lineCount: number): number {
  return SCORING_WEIGHTS.lineCountMultipliers[Math.min(Math.max(lineCount, 1), SCORING_WEIGHTS.lineCountMultipliers.length) - 1] ?? SCORING_WEIGHTS.lineCountMultipliers[SCORING_WEIGHTS.lineCountMultipliers.length - 1] ?? 1;
}

function computeTrackClearanceMultiplier(normalizedClearance: number): number {
  return SCORING_WEIGHTS.trackClearanceMultiplierBase + SCORING_WEIGHTS.trackClearanceMultiplierRange * normalizedClearance;
}

/** Context used to compute text-vs-text spacing. */
export interface ClearanceContext {
  distanceMap: number[][];
  maxTrackClearance: number;
  cellWidth: number;
  cellHeight: number;
  originX: number;
  originY: number;
}

function computeTextClearance(rect: Rect2D, layout: FittedTextLayout, clearanceContext: ClearanceContext): number {
  if (!clearanceContext.distanceMap) {
    return Infinity;
  }

  const { distanceMap, cellWidth, cellHeight, originX, originY } = clearanceContext;
  const rows = distanceMap.length;
  const columns = distanceMap[0]?.length ?? 0;
  if (rows === 0 || columns === 0) {
    return Infinity;
  }

  const textMinX = rect.minX + (rect.width - layout.fittedWidth) / 2;
  const textMinY = rect.minY + (rect.height - layout.fittedHeight) / 2;
  const textMaxX = textMinX + layout.fittedWidth;
  const textMaxY = textMinY + layout.fittedHeight;

  const colMin = Math.max(0, Math.floor((textMinX - originX) / cellWidth));
  const colMax = Math.min(columns - 1, Math.floor((textMaxX - originX) / cellWidth));
  const rowMin = Math.max(0, Math.floor((textMinY - originY) / cellHeight));
  const rowMax = Math.min(rows - 1, Math.floor((textMaxY - originY) / cellHeight));

  if (colMin > colMax || rowMin > rowMax) {
    return 0;
  }

  let minDistance = Infinity;

  for (let col = colMin; col <= colMax; col += 1) {
    minDistance = Math.min(minDistance, distanceMap[rowMin]?.[col] ?? Infinity);
    minDistance = Math.min(minDistance, distanceMap[rowMax]?.[col] ?? Infinity);
  }
  for (let row = rowMin + 1; row < rowMax; row += 1) {
    minDistance = Math.min(minDistance, distanceMap[row]?.[colMin] ?? Infinity);
    minDistance = Math.min(minDistance, distanceMap[row]?.[colMax] ?? Infinity);
  }

  return Number.isFinite(minDistance) ? minDistance : 0;
}

export function computeTextClearanceMultiplier(rect: Rect2D, layout: FittedTextLayout, clearanceContext: ClearanceContext | null): number {
  if (!clearanceContext) {
    return 1;
  }

  const textClearance = computeTextClearance(rect, layout, clearanceContext);
  const normalizedTextClearance = Math.min(1, textClearance / clearanceContext.maxTrackClearance);
  return SCORING_WEIGHTS.textClearanceMultiplierBase + SCORING_WEIGHTS.textClearanceMultiplierRange * normalizedTextClearance;
}

/** Partial candidate fields needed for scoring. */
interface ScoringCandidate {
  fractionOutside?: number;
  normalizedTrackClearance?: number;
}

export function scoreTextFit(rect: Rect2D, layout: FittedTextLayout, candidate: ScoringCandidate = {}, clearanceContext: ClearanceContext | null = null): { score: number; breakdown: PlacementScoreBreakdown } {
  const rawLineBalance = layout.maxLineWidth > 0 ? layout.minLineWidth / layout.maxLineWidth : 1;
  const balanceThreshold = 1 - SCORING_WEIGHTS.lineBalanceWindow;
  const windowedBalance = rawLineBalance >= balanceThreshold ? 1 : rawLineBalance / balanceThreshold;
  const damping = SCORING_WEIGHTS.lineBalanceDamping[layout.lineCount - 2] ?? 0;
  const lineBalance = windowedBalance + (1 - windowedBalance) * damping;
  const textHeight = layout.averageLineHeight * layout.scale;
  const sizeWindowMultiplier = computeSizeWindowMultiplier(textHeight);
  const outsideMultiplier = SCORING_WEIGHTS.outsideMultiplierMin + SCORING_WEIGHTS.outsideMultiplierRange * clamp(candidate.fractionOutside ?? 1, 0, 1);
  const lineCountMultiplier = computeLineCountMultiplier(layout.lineCount);
  const trackClearanceMultiplier = computeTrackClearanceMultiplier(candidate.normalizedTrackClearance ?? 1);
  const textClearanceMultiplier = computeTextClearanceMultiplier(rect, layout, clearanceContext);

  const score = lineBalance
    * outsideMultiplier
    * lineCountMultiplier
    * sizeWindowMultiplier
    * trackClearanceMultiplier
    * textClearanceMultiplier;

  return {
    score,
    breakdown: {
      lineBalance,
      textHeight,
      outsideMultiplier,
      lineCountMultiplier,
      sizeWindowMultiplier,
      trackClearanceMultiplier,
      textClearanceMultiplier,
    },
  };
}
