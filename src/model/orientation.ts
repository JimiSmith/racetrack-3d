import { buildBasePlate, buildTrackOutline as _buildTrackOutline } from '../geometry/outline.js';
import { computeRankedTextPlacements, SCORING_WEIGHTS } from '../text/index.js';
import type { OutlinePoints, BasePlate } from '../types/model.js';
import type { Point2D, ProjectedNode } from '../types/geometry.js';
import type { RankedPlacements } from '../types/text.js';
import { computeScale } from './base-plate.js';
import { TRACK_WIDTH_METRES } from './track-ribbon.js';

// ── Primitives (merged from src/orientation.js) ──────────────────────────────

export const PRIMARY_ORIENTATION_AUTO = 'auto';

const ORIENTATION_STEPS = [0, 90, 180, 270];

export function normalizeOrientationDeg(value: unknown): number {
  const normalized = Number(value);
  return ORIENTATION_STEPS.includes(normalized) ? normalized : 0;
}

export function normalizePrimaryOrientationDeg(value: unknown): number | 'auto' {
  return value === PRIMARY_ORIENTATION_AUTO
    ? PRIMARY_ORIENTATION_AUTO
    : normalizeOrientationDeg(value);
}

export function rotatePointByOrientation(point: Point2D, orientationDeg: number): Point2D {
  switch (normalizeOrientationDeg(orientationDeg)) {
    case 90:
      return { ...point, x: point.y, y: -point.x };
    case 180:
      return { ...point, x: -point.x, y: -point.y };
    case 270:
      return { ...point, x: -point.y, y: point.x };
    default:
      return { ...point };
  }
}

export function rotatePointsByOrientation(points: Point2D[] | null | undefined, orientationDeg: number): Point2D[] {
  return (points ?? []).map(point => rotatePointByOrientation(point, orientationDeg));
}

export function rotateOutlineByOrientation(
  outline: OutlinePoints | Point2D[] | null | undefined,
  orientationDeg: number,
): OutlinePoints {
  const asOutline = outline as { outerRing?: Point2D[]; holes?: Point2D[][] } | Point2D[] | null | undefined;
  return {
    outerRing: rotatePointsByOrientation(
      (asOutline as { outerRing?: Point2D[] } | null)?.outerRing ?? (asOutline as Point2D[] | null) ?? [],
      orientationDeg,
    ),
    holes: ((asOutline as { holes?: Point2D[][] } | null)?.holes ?? []).map(
      hole => rotatePointsByOrientation(hole, orientationDeg),
    ),
  };
}

// ── Bounds helpers ────────────────────────────────────────────────────────────

export function boundsFromPoints(points: Point2D[]): BasePlate {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export function rotateBasePlateByOrientation(basePlate: BasePlate | null | undefined, orientationDeg: number): BasePlate | null {
  if (!basePlate) {
    return null;
  }

  return boundsFromPoints(rotatePointsByOrientation([
    { x: basePlate.minX, y: basePlate.minY },
    { x: basePlate.maxX, y: basePlate.minY },
    { x: basePlate.maxX, y: basePlate.maxY },
    { x: basePlate.minX, y: basePlate.maxY },
  ], orientationDeg));
}

// ── buildTrackOutline wrapper (with perf counter hook) ───────────────────────

// Performance counter hook — injected by track-model.ts
export let __orientationBuildTrackOutlineCounter: { buildTrackOutline: number } | null = null;
export function __setOrientationBuildTrackOutlineCounter(c: { buildTrackOutline: number } | null): void {
  __orientationBuildTrackOutlineCounter = c;
}

function buildTrackOutline(...args: Parameters<typeof _buildTrackOutline>): ReturnType<typeof _buildTrackOutline> {
  if (__orientationBuildTrackOutlineCounter) { __orientationBuildTrackOutlineCounter.buildTrackOutline++; }
  return _buildTrackOutline(...args);
}

// ── orientTrackGeometry ───────────────────────────────────────────────────────

export interface OrientTrackGeometryOptions {
  outlinePoints: OutlinePoints | Point2D[] | null | undefined;
  basePlate: BasePlate | null | undefined;
  projectedNodes?: ProjectedNode[] | null;
  orientationDeg?: number;
  /** Ribbon width in metres for outline rebuild. Defaults to TRACK_WIDTH_METRES. */
  widthMetres?: number;
}

export interface OrientedTrackGeometry {
  outlinePoints: OutlinePoints;
  basePlate: BasePlate;
  projectedNodes: ProjectedNode[] | null;
  orientationDeg: number;
}

export function orientTrackGeometry({
  outlinePoints,
  basePlate,
  projectedNodes = null,
  orientationDeg = 0,
  widthMetres = TRACK_WIDTH_METRES,
}: OrientTrackGeometryOptions): OrientedTrackGeometry {
  const normalizedOrientationDeg = normalizeOrientationDeg(orientationDeg);
  const orientedProjectedNodes = projectedNodes?.length
    ? (rotatePointsByOrientation(projectedNodes, normalizedOrientationDeg) as ProjectedNode[])
    : null;
  const orientedOutlinePoints = orientedProjectedNodes?.length
    ? buildTrackOutline(orientedProjectedNodes, widthMetres)
    : rotateOutlineByOrientation(outlinePoints, normalizedOrientationDeg);
  const orientedBasePlate = rotateBasePlateByOrientation(basePlate, normalizedOrientationDeg)
    ?? buildBasePlate(orientedOutlinePoints);

  return {
    outlinePoints: orientedOutlinePoints,
    basePlate: orientedBasePlate,
    projectedNodes: orientedProjectedNodes,
    orientationDeg: normalizedOrientationDeg,
  };
}

// ── selectAutoOrientation ─────────────────────────────────────────────────────

export interface AutoOrientationGeometry {
  outlinePoints: OutlinePoints;
  basePlate: BasePlate;
  projectedNodes: ProjectedNode[] | null;
  secondaryOutlines: OutlinePoints[];
  orientedSecondaries: ProjectedNode[][];
}

export interface AutoOrientationResult {
  deg: number;
  placements: Map<number, RankedPlacements | null> | null;
  geometry: AutoOrientationGeometry | null;
}

// Performance counter hook — injected by track-model.ts
export let __autoOrientCounter: { selectAutoOrientation: number } | null = null;
export function __setAutoOrientCounter(c: { selectAutoOrientation: number } | null): void {
  __autoOrientCounter = c;
}

export function selectAutoOrientation(
  outlinePoints: OutlinePoints | Point2D[] | null | undefined,
  basePlate: BasePlate | null | undefined,
  projectedNodes: ProjectedNode[] | null | undefined,
  trackName: string | null | undefined,
  secondaryProjectedNodes: ProjectedNode[][] = [],
  widthMetres: number = TRACK_WIDTH_METRES,
): AutoOrientationResult {
  if (__autoOrientCounter) { __autoOrientCounter.selectAutoOrientation++; }
  // Build an outline we can use for all candidates.
  // projectedNodes takes priority — same logic as orientTrackGeometry.
  const baseOutline = projectedNodes?.length
    ? buildTrackOutline(projectedNodes, widthMetres)
    : outlinePoints;
  const bp = basePlate ?? (baseOutline ? buildBasePlate(baseOutline) : null);
  if (!bp) { return { deg: 0, placements: null, geometry: null }; }

  const LANDSCAPE_BONUS = SCORING_WEIGHTS.landscapeBonus;
  const TEXT_BOTTOM_BONUS = SCORING_WEIGHTS.textBottomBonus;
  const CANDIDATES = [0, 90, 180, 270];

  // Scoring text label: use the provided name or a short placeholder for geometry-only scoring.
  const normalizedTrackName = String(trackName ?? '').trim();
  const scoringText = normalizedTrackName || 'CIRCUIT';
  const resultsAreCacheable = Boolean(normalizedTrackName);

  let bestDeg = 0;
  let bestScore = -Infinity;
  const placementsMap: Map<number, RankedPlacements | null> | null = resultsAreCacheable ? new Map() : null;

  // Track the winning orientation's geometry so buildTrackModel can reuse it,
  // avoiding a redundant buildTrackOutline call.
  let bestGeometry: AutoOrientationGeometry | null = null;

  // Import buildCombinedBasePlate lazily to avoid circular deps — inline the logic here
  function buildCombinedBasePlateFn(allOutlines: OutlinePoints[], margin = 50): BasePlate | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const outline of allOutlines) {
      for (const { x, y } of (outline?.outerRing ?? [])) {
        if (x < minX) { minX = x; }
        if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; }
        if (y > maxY) { maxY = y; }
      }
    }
    if (!Number.isFinite(minX)) { return null; }
    minX -= margin; maxX += margin; minY -= margin; maxY += margin;
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  for (const deg of CANDIDATES) {
    // Rotate projected nodes when available, otherwise rotate outline directly.
    const rotatedProjectedNodes = projectedNodes?.length
      ? (rotatePointsByOrientation(projectedNodes, deg) as ProjectedNode[])
      : null;
    const rotatedOutline = rotatedProjectedNodes
      ? buildTrackOutline(rotatedProjectedNodes, widthMetres)
      : rotateOutlineByOrientation(outlinePoints, deg);

    // In combined mode, rotate all secondary layouts and expand the base plate to fit all of them.
    const rotatedSecondaryNodes = secondaryProjectedNodes.map(nodes =>
      rotatePointsByOrientation(nodes, deg) as ProjectedNode[]
    );
    const rotatedSecondaryOutlines = rotatedSecondaryNodes.map(nodes =>
      buildTrackOutline(nodes, widthMetres)
    );

    // Compute basePlate using the same logic as orientTrackGeometry:
    // prefer rotating the caller-supplied basePlate, fall back to building from the outline.
    const rotatedBp = rotatedSecondaryOutlines.length > 0
      ? (buildCombinedBasePlateFn([rotatedOutline, ...rotatedSecondaryOutlines])
        ?? rotateBasePlateByOrientation(basePlate, deg)
        ?? buildBasePlate(rotatedOutline) ?? bp)
      : (rotateBasePlateByOrientation(basePlate, deg)
        ?? (rotatedOutline ? buildBasePlate(rotatedOutline) : null) ?? bp);

    const allOutlinePoints = rotatedSecondaryOutlines.length > 0
      ? [rotatedOutline, ...rotatedSecondaryOutlines]
      : null;

    let score = 0;

    // Landscape bonus: width >= height after rotation.
    if (rotatedBp.width >= rotatedBp.height) {
      score += LANDSCAPE_BONUS;
    }

    // Text-bottom bonus: text centroid Y should be in the lower half of the base plate.
    // We use computeRankedTextPlacements so the results can also be cached for later use.
    try {
      const scale = computeScale(rotatedBp);
      const ranked = computeRankedTextPlacements(scoringText, rotatedOutline, rotatedBp, scale, {
        allOutlinePoints,
      });
      placementsMap?.set(deg, ranked);
      if (ranked) {
        const best = ranked.placements[0];
        if (best?.layout?.lineBounds?.length) {
          const { candidate, layout } = best;
          const offsetY = candidate.bounds.minY
            + (candidate.bounds.height - layout.fittedHeight) / 2
            - layout.bounds.minY * layout.scale;
          const textCentroidY = layout.lineBounds.reduce(
            (sum, b) => sum + (b.minY * layout.scale + offsetY + b.maxY * layout.scale + offsetY) / 2,
            0,
          ) / layout.lineBounds.length;
          const scaledBpCenterY = (rotatedBp.minY + rotatedBp.maxY) / 2 * scale;
          if (textCentroidY < scaledBpCenterY) {
            score += TEXT_BOTTOM_BONUS;
          }
        }
      }
    } catch {
      // Text placement scoring is best-effort; skip bonus on failure.
      placementsMap?.set(deg, null);
    }

    // Stable tiebreak: prefer smaller degree value.
    if (score > bestScore) {
      bestScore = score;
      bestDeg = deg;
      bestGeometry = {
        outlinePoints: rotatedOutline,
        basePlate: rotatedBp,
        projectedNodes: rotatedProjectedNodes,
        secondaryOutlines: rotatedSecondaryOutlines,
        orientedSecondaries: rotatedSecondaryNodes,
      };
    }
  }

  return { deg: bestDeg, placements: placementsMap, geometry: bestGeometry };
}
