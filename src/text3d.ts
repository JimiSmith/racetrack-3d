/**
 * Thin re-export shim for the src/text/ module group.
 *
 * This file previously contained all 1585 lines of the text placement and
 * mesh generation pipeline. Those have been decomposed into focused modules
 * under src/text/. This shim re-exports the public API so that existing
 * callers (src/model/, src/main.ts, tests) continue to work unchanged.
 *
 * The src/text/ modules are still plain .js — their .d.ts files only declare
 * the public API. Internal helpers are accessed via `any` casts.
 */

import type { OutlinePoints, BasePlate } from './types/model.js';
import type { RankedPlacements, ScoringWeights, TextPlacementCandidate, RankedTextPlacement } from './types/text.js';
import type { Point2D } from './types/geometry.js';
// --- Internal module access (text/* modules are still .js — use any for internals) ---
import * as _placementMod from './text/placement.js';
import * as _contoursMod from './text/contours.js';
import * as _lineBreakingMod from './text/line-breaking.js';
import * as _scoringMod from './text/scoring.js';
import * as _meshMod from './text/mesh.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const P = _placementMod as any; // internal exports not in .d.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const C = _contoursMod as any; // internal exports not in .d.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LB = _lineBreakingMod as any; // internal exports not in .d.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SC = _scoringMod as any; // internal exports not in .d.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = _meshMod as any; // internal exports not in .d.ts
// --- Public API re-exports ---
export {
  TEXT_HEIGHT_MM,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  buildTextMeshFromRankedPlacements,
} from './text/mesh.js';

export { SCORING_WEIGHTS } from './text/scoring.js';

export { computeRankedTextPlacements } from './text/placement.js';

// --- Performance counter aggregation across all sub-modules ---

export function __resetPerfCounters(): void {
  (P.__resetPerfCounters as () => void)();
  (C.__resetPerfCounters as () => void)();
  (LB.__resetPerfCounters as () => void)();
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
  const placement = (P.__getPerfCounters as () => Record<string, number> | null)();
  const contours = (C.__getPerfCounters as () => Record<string, number> | null)();
  const lineBreaking = (LB.__getPerfCounters as () => Record<string, number> | null)();
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
  (P.__disablePerfCounters as () => void)();
  (C.__disablePerfCounters as () => void)();
  (LB.__disablePerfCounters as () => void)();
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
  options: Record<string, unknown> = {},
): (ExpandedPlacement & { normalizedText: string }) | null {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return null;
  }

  const rankedResult = (P.computeRankedTextPlacements as (...a: unknown[]) => RankedPlacements | null)(text, outlinePoints, basePlate, scale, options);
  const expanded = (M.selectAndExpandPlacement as (r: unknown, opts: unknown) => ExpandedPlacement | null)(rankedResult, options);
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
): unknown {
  return (LB.findOptimalLineBreaksForText as (t: string, n: number, f: unknown) => unknown)(text, lineCount, font ?? null);
}

export function __debugScoreTextFit(
  rect: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number },
  layout: Record<string, unknown>,
  candidate: Record<string, unknown> = {},
): { score: number; breakdown: Record<string, number> } {
  return (SC.scoreTextFit as (...a: unknown[]) => { score: number; breakdown: Record<string, number> })(rect, layout, candidate);
}

export function __debugTextFitModifiers(
  heightMm: number,
  lineCount: number,
  fractionOutside = 1,
): { sizeWindowMultiplier: number; lineCountMultiplier: number; outsideMultiplier: number } {
  const weights = SC.SCORING_WEIGHTS as ScoringWeights;
  return {
    sizeWindowMultiplier: (SC.computeSizeWindowMultiplier as (h: number) => number)(heightMm),
    lineCountMultiplier: (SC.computeLineCountMultiplier as (n: number) => number)(lineCount),
    outsideMultiplier: weights.outsideMultiplierMin + weights.outsideMultiplierRange * clamp(fractionOutside, 0, 1),
  };
}

export function __debugCompareRankedTextPlacements(
  a: RankedTextPlacement,
  b: RankedTextPlacement,
): number {
  return (P.compareRankedTextPlacements as (a: unknown, b: unknown) => number)(a, b);
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
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
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
  const scaledOutline = (P.scaleOutline as (o: unknown, s: number) => unknown)(outlinePoints, scale);
  const scaledBasePlate = (P.createScaledBounds as (b: unknown, s: number) => unknown)(basePlate, scale);
  const placementMask = (P.computePlacementMask as (...a: unknown[]) => unknown)([scaledOutline], scaledOutline, scaledBasePlate);
  return (P.findPlacementCandidates as (...a: unknown[]) => { candidates: TextPlacementCandidate[] })(scaledBasePlate, placementMask).candidates;
}

export function __debugRectIntersectsPolygon(
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  polygon: Point2D[],
): boolean {
  return (P.rectIntersectsPolygon as (r: unknown, p: unknown) => boolean)(rect, polygon);
}

export function __debugDedupeRankedPlacements(
  placements: RankedTextPlacement[],
  scaledBasePlate: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number },
): RankedTextPlacement[] {
  return (P.dedupeRankedPlacements as (p: unknown, b: unknown) => RankedTextPlacement[])(placements, scaledBasePlate);
}
