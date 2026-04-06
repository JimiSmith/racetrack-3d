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

import earcut from 'earcut';
import type { OutlinePoints, BasePlate, Triangle } from './types/model.js';
import type { RankedPlacements, ScoringWeights, TextPlacementCandidate, RankedTextPlacement } from './types/text.js';
import type { Point2D } from './types/geometry.js';
// --- Internal module access (text/* modules are still .js — use any for internals) ---
import * as _placementMod from './text/placement.js';
import * as _contoursMod from './text/contours.js';
import * as _lineBreakingMod from './text/line-breaking.js';
import * as _scoringMod from './text/scoring.js';
import * as _meshMod from './text/mesh.js';
import * as _fontLoaderMod from './text/font-loader.js';

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FL = _fontLoaderMod as any; // internal exports not in .d.ts

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

function createVertex(x: number, y: number, z: number): { x: number; y: number; z: number } {
  return { x, y, z };
}

type Vertex2D = { x: number; y: number };
type Vertex3D = { x: number; y: number; z: number };

function addTriangle(
  triangles: [Vertex3D, Vertex3D, Vertex3D][],
  a: Vertex3D,
  b: Vertex3D,
  c: Vertex3D,
): void {
  triangles.push([a, b, c]);
}

function addQuad(
  triangles: [Vertex3D, Vertex3D, Vertex3D][],
  a: Vertex3D,
  b: Vertex3D,
  c: Vertex3D,
  d: Vertex3D,
): void {
  addTriangle(triangles, a, b, c);
  addTriangle(triangles, a, c, d);
}

function signedArea(points: Vertex2D[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

interface ContourShape {
  outer: Vertex2D[];
  holes: Vertex2D[][];
}

function triangulateShape(shape: ContourShape, minZ: number, maxZ: number): [Vertex3D, Vertex3D, Vertex3D][] {
  const rings = [shape.outer, ...shape.holes];
  const flattened: number[] = [];
  const holeIndices: number[] = [];
  const vertices2d: Vertex2D[] = [];

  for (const ring of rings) {
    if (flattened.length > 0) {
      holeIndices.push(vertices2d.length);
    }
    for (const point of ring) {
      flattened.push(point.x, point.y);
      vertices2d.push(point);
    }
  }

  const indices = earcut(flattened, holeIndices.length ? holeIndices : null);
  const bottomVertices = vertices2d.map(point => createVertex(point.x, point.y, minZ));
  const topVertices = vertices2d.map(point => createVertex(point.x, point.y, maxZ));
  const triangles: [Vertex3D, Vertex3D, Vertex3D][] = [];

  for (let index = 0; index < indices.length; index += 3) {
    addTriangle(triangles, topVertices[indices[index]!]!, topVertices[indices[index + 1]!]!, topVertices[indices[index + 2]!]!);
    addTriangle(triangles, bottomVertices[indices[index + 2]!]!, bottomVertices[indices[index + 1]!]!, bottomVertices[indices[index]!]!);
  }

  let ringOffset = 0;
  for (const ring of rings) {
    const clockwise = signedArea(ring) < 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ringOffset + index;
      const next = ringOffset + ((index + 1) % ring.length);
      if (clockwise) {
        addQuad(triangles, bottomVertices[next]!, bottomVertices[current]!, topVertices[current]!, topVertices[next]!);
      } else {
        addQuad(triangles, bottomVertices[current]!, bottomVertices[next]!, topVertices[next]!, topVertices[current]!);
      }
    }
    ringOffset += ring.length;
  }

  return triangles;
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

export function __debugAllPlacements(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options: Record<string, unknown> = {},
): unknown[] | null {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) { return null; }

  const font = (FL.loadFont as (f: null) => unknown)(options['font'] as null ?? null);
  const scaledOutline = (P.scaleOutline as (o: unknown, s: number) => unknown)(outlinePoints, scale);
  const scaledBasePlate = (P.createScaledBounds as (b: unknown, s: number) => unknown)(basePlate, scale);
  const placementMask = (P.computePlacementMask as (...a: unknown[]) => unknown)([scaledOutline], scaledOutline, scaledBasePlate);
  const { candidates, distanceMap, maxTrackClearance } = (P.findPlacementCandidates as (...a: unknown[]) => {
    candidates: TextPlacementCandidate[];
    distanceMap: number[][];
    maxTrackClearance: number;
  })(scaledBasePlate, placementMask);
  if (!candidates.length) { return null; }

  const maskTyped = placementMask as { cellWidth: number; cellHeight: number };
  const scaledBPTyped = scaledBasePlate as { minX: number; minY: number };
  const clearanceContext = {
    distanceMap,
    maxTrackClearance,
    cellWidth: maskTyped.cellWidth,
    cellHeight: maskTyped.cellHeight,
    originX: scaledBPTyped.minX,
    originY: scaledBPTyped.minY,
  };
  const placements = (P.rankTextPlacements as (...a: unknown[]) => RankedTextPlacement[])(normalizedText, font, candidates, clearanceContext);

  return placements.map(({ candidateIndex, layout, score, candidate }) => {
    const textHeight = layout.averageLineHeight * layout.scale;
    const utilization = Math.min(1, (layout.fittedWidth * layout.fittedHeight) / Math.max(candidate.bounds.width * candidate.bounds.height, Number.EPSILON));
    const lineBalance = layout.maxLineWidth > 0 ? layout.minLineWidth / layout.maxLineWidth : 1;
    return {
      candidateIndex,
      lines: layout.lines,
      lineCount: layout.lineCount,
      score,
      textHeight,
      utilization,
      lineBalance,
      averageLineHeight: layout.averageLineHeight,
      fittedScale: layout.scale,
      fittedWidth: layout.fittedWidth,
      fittedHeight: layout.fittedHeight,
      candidateArea: candidate.area,
      candidateWidth: candidate.bounds.width,
      candidateHeight: candidate.bounds.height,
      fractionOutside: candidate.fractionOutside,
      normalizedTrackClearance: candidate.normalizedTrackClearance,
      centreDistance: candidate.centreDistance,
      sizeWindowMultiplier: (SC.computeSizeWindowMultiplier as (h: number) => number)(textHeight),
      lineCountMultiplier: (SC.computeLineCountMultiplier as (n: number) => number)(layout.lineCount),
      textClearanceMultiplier: (SC.computeTextClearanceMultiplier as (b: unknown, l: unknown, c: unknown) => number)(candidate.bounds, layout, clearanceContext),
    };
  });
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

// ─── Legacy buildTextMesh (for tests — uses triangulateShape directly) ────────

export function buildTextMesh(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options: Record<string, unknown> = {},
): Triangle[] {
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
  if (!placement?.contours?.length) {
    return [];
  }

  const shapes = (C.collectShapes as (t: unknown) => ContourShape[])(
    (C.buildContourTree as (c: unknown) => unknown)(placement.contours),
  );
  const minZ = (options['baseThickness'] as number | undefined) ?? 8;
  const maxZ = minZ + ((options['textHeight'] as number | undefined) ?? (M.TEXT_HEIGHT_MM as number));

  return shapes.flatMap(shape => triangulateShape(shape, minZ, maxZ));
}
