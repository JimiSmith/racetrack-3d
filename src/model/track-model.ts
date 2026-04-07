import { buildTrackOutline as _buildTrackOutline } from '../geometry/outline.js';
import {
  buildTextMeshFromRankedPlacements,
  computeRankedTextPlacements,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  TEXT_HEIGHT_MM,
} from '../text3d.js';
import type { TrackModel, OutlinePoints, BasePlate } from '../types/model.js';
import type { ProjectedNode } from '../types/geometry.js';
import type { RankedPlacements } from '../types/text.js';
import type { PerfTimer } from './perf-timer.js';
import { BASE_THICKNESS_MM, computeScale } from './base-plate.js';
import { buildBasePlateMesh } from './base-plate.js';
import { buildTrackPrismMesh, __setTrackPrismPerfCounters } from './track-prism.js';
import {
  PRIMARY_ORIENTATION_AUTO,
  normalizePrimaryOrientationDeg,
  normalizeOrientationDeg,
  rotatePointsByOrientation,
  orientTrackGeometry,
  selectAutoOrientation,
  __setOrientationBuildTrackOutlineCounter,
  __setAutoOrientCounter,
} from './orientation.js';
import { buildCombinedBasePlate, buildPrimaryEdgeSet, getUniqueSubChains } from './combined-layout.js';

// ── Placement cache ──────────────────────────────────────────────────────────

interface TextPlacementCache {
  token: unknown;
  byOrientation: Map<number, RankedPlacements | null>;
  resolvedAutoDeg: number | null;
}

let textPlacementCache: TextPlacementCache = {
  token: null,
  byOrientation: new Map(),
  resolvedAutoDeg: null,
};

// ── Performance counters ─────────────────────────────────────────────────────

interface ModelPerfCounters {
  buildTrackOutline: number;
  selectAutoOrientation: number;
  buildTrackPrismMesh: number;
}

let __modelPerfCounters: ModelPerfCounters | null = null;

export function __resetModelPerfCounters(): void {
  __modelPerfCounters = {
    buildTrackOutline: 0,
    selectAutoOrientation: 0,
    buildTrackPrismMesh: 0,
  };
  __setOrientationBuildTrackOutlineCounter(__modelPerfCounters);
  __setAutoOrientCounter(__modelPerfCounters);
  __setTrackPrismPerfCounters(__modelPerfCounters);
}

export function __getModelPerfCounters(): ModelPerfCounters | null {
  return __modelPerfCounters ? { ...__modelPerfCounters } : null;
}

export function __disableModelPerfCounters(): void {
  __modelPerfCounters = null;
  __setOrientationBuildTrackOutlineCounter(null);
  __setAutoOrientCounter(null);
  __setTrackPrismPerfCounters(null);
}

// ── buildTrackOutline wrapper ────────────────────────────────────────────────

function buildTrackOutline(...args: Parameters<typeof _buildTrackOutline>): ReturnType<typeof _buildTrackOutline> {
  if (__modelPerfCounters) { __modelPerfCounters.buildTrackOutline++; }
  return _buildTrackOutline(...args);
}

// ── BuildTrackModelOptions ───────────────────────────────────────────────────

export interface BuildTrackModelOptions {
  outlinePoints: OutlinePoints | null | undefined;
  basePlate: BasePlate | null | undefined;
  trackName: string | null | undefined;
  projectedNodes?: ProjectedNode[] | null;
  secondaryProjectedNodes?: ProjectedNode[][];
  primaryOrientationDeg?: number | 'auto';
  orientationDeg?: number | 'auto';
  textPositionRank?: number;
  placementCacheToken?: unknown;
  perfTimer?: PerfTimer;
}

// ── buildTrackModel ──────────────────────────────────────────────────────────

export function buildTrackModel({
  outlinePoints,
  basePlate,
  trackName,
  projectedNodes = null,
  secondaryProjectedNodes = [],
  primaryOrientationDeg = undefined,
  orientationDeg = undefined,
  textPositionRank = DEFAULT_TEXT_POSITION_RANK,
  placementCacheToken = null,
  perfTimer,
}: BuildTrackModelOptions): TrackModel {
  const normalizedPrimaryOrientationDeg = normalizePrimaryOrientationDeg(
    primaryOrientationDeg === undefined
      ? (orientationDeg === undefined ? PRIMARY_ORIENTATION_AUTO : orientationDeg)
      : primaryOrientationDeg,
  );

  // Reset the cache upfront if the token has changed, so all subsequent reads see a clean slate.
  if (placementCacheToken !== null && placementCacheToken !== textPlacementCache.token) {
    textPlacementCache = { token: placementCacheToken, byOrientation: new Map(), resolvedAutoDeg: null };
  }
  const cacheActive = placementCacheToken !== null;

  let resolvedOrientationDeg: number;
  // When selectAutoOrientation runs, it already computes the winning orientation's
  // geometry (outline, basePlate, projected nodes, secondary outlines) and text placements.
  // We reuse both to avoid redundant buildTrackOutline and computeRankedTextPlacements calls.
  let autoGeometry: ReturnType<typeof selectAutoOrientation>['geometry'] = null;
  let autoPlacementsForWinner: RankedPlacements | null = null;
  if (normalizedPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO) {
    if (cacheActive && textPlacementCache.resolvedAutoDeg !== null) {
      // Auto-orientation already computed and cached — use it directly.
      resolvedOrientationDeg = textPlacementCache.resolvedAutoDeg;
    } else {
      // Compute auto orientation. This also runs text placement for all 4 candidate orientations,
      // so we pre-populate the cache with all of them in one pass.
      const autoResult = selectAutoOrientation(
        outlinePoints, basePlate, projectedNodes, trackName, secondaryProjectedNodes,
      );
      resolvedOrientationDeg = autoResult.deg;
      autoGeometry = autoResult.geometry;
      // Retain the winning orientation's text placements for direct reuse below,
      // avoiding a redundant computeRankedTextPlacements call even without a cache token.
      if (autoResult.placements) {
        autoPlacementsForWinner = autoResult.placements.get(resolvedOrientationDeg) ?? null;
      }
      if (cacheActive) {
        textPlacementCache.resolvedAutoDeg = resolvedOrientationDeg;
        if (autoResult.placements) {
          for (const [deg, ranked] of autoResult.placements) {
            textPlacementCache.byOrientation.set(deg, ranked);
          }
        }
      }
    }
  } else {
    resolvedOrientationDeg = normalizedPrimaryOrientationDeg;
  }

  perfTimer?.step('orientation');

  const resolvedTextPositionRank = normalizeTextPositionRank(textPositionRank);

  // Reuse geometry from selectAutoOrientation when available, otherwise compute fresh.
  let orientedGeometry: ReturnType<typeof orientTrackGeometry>;
  let orientedSecondaries: ProjectedNode[][];
  let secondaryOutlines: OutlinePoints[];
  if (autoGeometry) {
    orientedGeometry = {
      outlinePoints: autoGeometry.outlinePoints,
      basePlate: autoGeometry.basePlate,
      projectedNodes: autoGeometry.projectedNodes,
      orientationDeg: normalizeOrientationDeg(resolvedOrientationDeg),
    };
    orientedSecondaries = autoGeometry.orientedSecondaries;
    secondaryOutlines = autoGeometry.secondaryOutlines;
  } else {
    orientedGeometry = orientTrackGeometry({
      outlinePoints,
      basePlate,
      projectedNodes,
      orientationDeg: resolvedOrientationDeg,
    });
    orientedSecondaries = secondaryProjectedNodes.map(nodes =>
      rotatePointsByOrientation(nodes, resolvedOrientationDeg) as ProjectedNode[]
    );
    secondaryOutlines = orientedSecondaries.map(nodes => buildTrackOutline(nodes));
  }

  perfTimer?.step('geometry');

  // In combined mode, expand the base plate to encompass all layouts.
  // When reusing autoGeometry, the basePlate already accounts for secondary outlines.
  const effectiveBasePlate = !autoGeometry && secondaryOutlines.length > 0
    ? (buildCombinedBasePlate([orientedGeometry.outlinePoints, ...secondaryOutlines]) ?? orientedGeometry.basePlate)
    : orientedGeometry.basePlate;

  const scale = computeScale(effectiveBasePlate);
  const basePlateTriangles = buildBasePlateMesh(effectiveBasePlate, scale);

  perfTimer?.step('basePlate');

  // Build secondary prism meshes — unique segments only to avoid z-fighting on shared sections.
  const primaryEdgeSet = buildPrimaryEdgeSet(orientedGeometry.projectedNodes ?? []);
  const secondaryTrackTriangles = orientedSecondaries.flatMap(nodes => {
    const uniqueChains = getUniqueSubChains(nodes, primaryEdgeSet);
    return uniqueChains.flatMap(chain => buildTrackPrismMesh(null, scale, chain, true));
  });

  perfTimer?.step('secondaryTracks');

  // Primary layout prism mesh (shown in red in the preview/export).
  const trackTriangles = buildTrackPrismMesh(
    orientedGeometry.outlinePoints, scale, orientedGeometry.projectedNodes,
  );

  perfTimer?.step('primaryTrack');

  // Text placement uses all visible layouts as obstacles in combined mode.
  const allOutlinePoints = secondaryOutlines.length > 0
    ? [orientedGeometry.outlinePoints, ...secondaryOutlines]
    : null;

  let rankedPlacements: RankedPlacements | null = null;
  const normalizedTrackName = String(trackName ?? '').trim();
  if (normalizedTrackName) {
    // Try the cross-call cache first, then the local auto-orientation result.
    rankedPlacements = cacheActive
      ? textPlacementCache.byOrientation.get(resolvedOrientationDeg) ?? null
      : null;
    if (!rankedPlacements) {
      rankedPlacements = autoPlacementsForWinner;
    }

    if (!rankedPlacements) {
      rankedPlacements = computeRankedTextPlacements(
        normalizedTrackName,
        orientedGeometry.outlinePoints,
        effectiveBasePlate,
        scale,
        { allOutlinePoints, perfTimer },
      );
      if (cacheActive) {
        textPlacementCache.byOrientation.set(resolvedOrientationDeg, rankedPlacements);
      }
    }
  }

  perfTimer?.step('textPlacement');

  const textTriangles = buildTextMeshFromRankedPlacements(rankedPlacements, {
    textPositionRank: resolvedTextPositionRank,
    baseThickness: BASE_THICKNESS_MM,
    textHeight: TEXT_HEIGHT_MM,
  });

  perfTimer?.step('textMesh');

  const result: TrackModel = {
    triangles: [...basePlateTriangles, ...secondaryTrackTriangles, ...trackTriangles, ...textTriangles],
    baseTriangleCount: basePlateTriangles.length,
    secondaryTrackTriangleCount: secondaryTrackTriangles.length,
    trackTriangleCount: trackTriangles.length,
    textTriangleCount: textTriangles.length,
    scale,
    primaryOrientationDeg: normalizedPrimaryOrientationDeg,
    textPositionRank: resolvedTextPositionRank,
    orientationDeg: orientedGeometry.orientationDeg,
    outlinePoints: orientedGeometry.outlinePoints,
    basePlate: effectiveBasePlate,
    projectedNodes: orientedGeometry.projectedNodes,
  };
  if (rankedPlacements?.allScoredPlacements) {
    result.allScoredPlacements = rankedPlacements.allScoredPlacements;
  }
  if (rankedPlacements?.candidates) {
    result.placementCandidates = rankedPlacements.candidates;
  }
  if (rankedPlacements?.scaledBasePlate) {
    result.scaledBasePlate = rankedPlacements.scaledBasePlate;
  }
  return result;
}
