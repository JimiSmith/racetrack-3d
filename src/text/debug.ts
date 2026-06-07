/**
 * Test-only debug helpers for the src/text/ module group.
 *
 * These `__`-prefixed wrappers expose internal pipeline functions to the test
 * suite without polluting the stable public API barrel (src/text/index.ts).
 * Production code should never import from this module.
 */

import type { Font } from 'opentype.js';
import type { OutlinePoints, BasePlate } from '../types/model.js';
import type {
  ScoringWeights,
  TextPlacementCandidate,
  RankedTextPlacement,
  FittedTextLayout,
  Rect2D,
  PlacementScoreBreakdown,
} from '../types/text.js';
import type { Point2D } from '../types/geometry.js';
import {
  computeRankedTextPlacements,
  compareRankedTextPlacements,
  scaleOutline,
  createScaledBounds,
  computePlacementMask,
  findPlacementCandidates,
  rectIntersectsPolygon,
  dedupeRankedPlacements,
  __resetPerfCounters as resetPlacementCounters,
  __getPerfCounters as getPlacementCounters,
  __disablePerfCounters as disablePlacementCounters,
  type ComputeRankedOptions,
} from './placement.js';
import {
  __resetPerfCounters as resetContoursCounters,
  __getPerfCounters as getContoursCounters,
  __disablePerfCounters as disableContoursCounters,
} from './contours.js';
import {
  findOptimalLineBreaksForText,
  __resetPerfCounters as resetLineBreakingCounters,
  __getPerfCounters as getLineBreakingCounters,
  __disablePerfCounters as disableLineBreakingCounters,
} from './line-breaking.js';
import {
  scoreTextFit,
  computeSizeWindowMultiplier,
  computeLineCountMultiplier,
  SCORING_WEIGHTS,
} from './scoring.js';
import { selectAndExpandPlacement } from './mesh.js';

// --- Performance counter aggregation across all sub-modules ---

export function __resetPerfCounters(): void {
  resetPlacementCounters();
  resetContoursCounters();
  resetLineBreakingCounters();
}

interface PerfCounters {
  findOptimalLineBreaks: number;
  buildMultilineContours: number;
  computePlacementMask: number;
  findPlacementCandidates: number;
  rankTextPlacements: number;
  computeRankedTextPlacements: number;
}

export function __getPerfCounters(): PerfCounters | null {
  const placement = getPlacementCounters();
  const contours = getContoursCounters();
  const lineBreaking = getLineBreakingCounters();
  if (!placement && !contours && !lineBreaking) {
    return null;
  }
  return {
    findOptimalLineBreaks: lineBreaking?.findOptimalLineBreaks ?? 0,
    buildMultilineContours: contours?.buildMultilineContours ?? 0,
    computePlacementMask: placement?.computePlacementMask ?? 0,
    findPlacementCandidates: placement?.findPlacementCandidates ?? 0,
    rankTextPlacements: placement?.rankTextPlacements ?? 0,
    computeRankedTextPlacements: placement?.computeRankedTextPlacements ?? 0,
  };
}

export function __disablePerfCounters(): void {
  disablePlacementCounters();
  disableContoursCounters();
  disableLineBreakingCounters();
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface ExpandedPlacement {
  text: string;
  lines: string[];
  lineBounds: Array<{ minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }>;
  scale: number;
  candidateIndex: number;
  candidateCount: number;
  placementRank: number;
  placementCount: number;
  score: number;
  candidate?: TextPlacementCandidate;
  contours?: Point2D[][];
}

function computeTextPlacement(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options: ComputeRankedOptions & { textPositionRank?: number } = {},
): (ExpandedPlacement & { normalizedText: string }) | null {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return null;
  }

  const rankedResult = computeRankedTextPlacements(text, outlinePoints, basePlate, scale, options);
  const expanded = selectAndExpandPlacement(rankedResult, options);
  if (!expanded) {
    return null;
  }

  return { ...expanded, normalizedText };
}

// ─── Debug exports (for tests) ────────────────────────────────────────────────

export function __findOptimalLineBreaks(
  text: string,
  lineCount: number,
  font: unknown,
): string[] {
  return findOptimalLineBreaksForText(text, lineCount, (font ?? null) as Font);
}

export function __debugScoreTextFit(
  rect: Rect2D,
  layout: FittedTextLayout,
  candidate: { fractionOutside?: number; normalizedTrackClearance?: number } = {},
): { score: number; breakdown: PlacementScoreBreakdown } {
  return scoreTextFit(rect, layout, candidate);
}

export function __debugTextFitModifiers(
  heightMm: number,
  lineCount: number,
  fractionOutside = 1,
): { sizeWindowMultiplier: number; lineCountMultiplier: number; outsideMultiplier: number } {
  const weights: ScoringWeights = SCORING_WEIGHTS;
  return {
    sizeWindowMultiplier: computeSizeWindowMultiplier(heightMm),
    lineCountMultiplier: computeLineCountMultiplier(lineCount),
    outsideMultiplier: weights.outsideMultiplierMin + weights.outsideMultiplierRange * clamp(fractionOutside, 0, 1),
  };
}

export function __debugCompareRankedTextPlacements(
  a: RankedTextPlacement,
  b: RankedTextPlacement,
): number {
  return compareRankedTextPlacements(a, b);
}

export function __debugTextPlacement(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options: Record<string, unknown> = {},
): {
  text: string;
  lines: string[];
  lineBounds: unknown[];
  scale: number;
  candidateIndex: number;
  candidateCount: number;
  placementRank: number;
  placementCount: number;
  score: number;
  candidateArea: number | undefined;
  candidateFractionOutside: number | undefined;
  candidateTrackClearance: number | undefined;
} | null {
  const placement = computeTextPlacement(
    text,
    outlinePoints,
    basePlate,
    scale,
    options as ComputeRankedOptions & { textPositionRank?: number },
  );
  if (!placement) {
    return null;
  }

  return {
    text: placement.text,
    lines: [...placement.lines],
    lineBounds: placement.lineBounds.map(bounds => ({ ...bounds })),
    scale: placement.scale,
    candidateIndex: placement.candidateIndex,
    candidateCount: placement.candidateCount,
    placementRank: placement.placementRank,
    placementCount: placement.placementCount,
    score: placement.score,
    candidateArea: placement.candidate?.area,
    candidateFractionOutside: placement.candidate?.fractionOutside,
    candidateTrackClearance: placement.candidate?.trackClearance,
  };
}

export function __debugPlacementCandidates(
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
): TextPlacementCandidate[] {
  const scaledOutline = scaleOutline(outlinePoints, scale);
  const scaledBasePlate = createScaledBounds(basePlate, scale);
  const placementMask = computePlacementMask([scaledOutline], scaledOutline, scaledBasePlate);
  return findPlacementCandidates(scaledBasePlate, placementMask).candidates;
}

export function __debugRectIntersectsPolygon(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  polygon: Point2D[],
): boolean {
  return rectIntersectsPolygon(
    { ...rect, width: rect.maxX - rect.minX, height: rect.maxY - rect.minY },
    polygon,
  );
}

export function __debugDedupeRankedPlacements(
  placements: RankedTextPlacement[],
  scaledBasePlate: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number },
): RankedTextPlacement[] {
  return dedupeRankedPlacements(placements, scaledBasePlate);
}
