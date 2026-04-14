import { buildTrackOutline as _buildTrackOutline } from '../geometry/outline.js';
import {
  buildTextMeshFromRankedPlacements,
  computeRankedTextPlacements,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  TEXT_HEIGHT_MM,
} from '../text3d.js';
import type { TrackModel, OutlinePoints, BasePlate } from '../types/model.js';
import type { Point2D, ProjectedNode } from '../types/geometry.js';
import type { RankedPlacements } from '../types/text.js';
import type { PerfTimer } from './perf-timer.js';
import {
  BASE_THICKNESS_MM,
  COASTER_SIZE_MM,
  COASTER_INNER_MARGIN_MM,
  COASTER_POCKET_DEPTH_MM,
  BASE_CORNER_RADIUS_MM,
  buildBasePlateMesh,
  buildCoasterBasePlateMesh,
  computeScale,
  type CoasterPocketSpec,
} from './base-plate.js';
import { selectAndExpandPlacement } from '../text/mesh.js';
import { buildContourTree, collectShapes } from '../text/contours.js';
import { buildTrackPrismMesh, __setTrackPrismPerfCounters } from './track-prism.js';
import {
  COASTER_TRACK_HEIGHT_FLUSH_MM,
  COASTER_TRACK_HEIGHT_RAISED_MM,
} from './track-ribbon.js';
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
  /** When true, produce a fixed 90 mm coaster with a level top surface. */
  coasterMode?: boolean;
  /** Coaster outline shape (only used when coasterMode is true). */
  coasterShape?: 'round' | 'square';
  /**
   * How the track inlay sits relative to the base top.
   * 'raised' (default) places a 0.2 mm thin layer on top of the base.
   * 'flush' cuts the track shape clean through the base and fills it with a full-height plug.
   */
  coasterInlay?: 'flush' | 'raised';
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function translatePoint<T extends { x: number; y: number }>(p: T, dx: number, dy: number): T {
  return { ...p, x: p.x + dx, y: p.y + dy };
}

function translateOutline(outline: OutlinePoints, dx: number, dy: number): OutlinePoints {
  return {
    outerRing: outline.outerRing.map(p => translatePoint(p, dx, dy)),
    holes: outline.holes.map(ring => ring.map(p => translatePoint(p, dx, dy))),
  };
}

/**
 * Builds a pocket spec (in mm, centred at origin) from the track's outline for
 * flush-inlay coaster mode. The boundary is the asphalt ribbon's outer edge
 * and the islands are the infield(s) inside the loop — kept at full base
 * height so the area inside the track loop remains solid, while the ribbon
 * itself is recessed so the coloured track prism sits flush with the top.
 */
function buildTrackPocketSpec(outline: OutlinePoints, scale: number): {
  boundary: Point2D[];
  islands: Point2D[][];
} {
  const scalePoint = (p: Point2D): Point2D => ({ x: p.x * scale, y: p.y * scale });
  return {
    boundary: outline.outerRing.map(scalePoint),
    islands: outline.holes.map(hole => hole.map(scalePoint)),
  };
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
  coasterMode = false,
  coasterShape = 'round',
  coasterInlay = 'raised',
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
  let effectiveBasePlate = !autoGeometry && secondaryOutlines.length > 0
    ? (buildCombinedBasePlate([orientedGeometry.outlinePoints, ...secondaryOutlines]) ?? orientedGeometry.basePlate)
    : orientedGeometry.basePlate;

  // ── Coaster mode geometry setup ────────────────────────────────────────────
  // Translate all geometry so the track's bounding-box centre sits at (0, 0),
  // aligning with the coaster mesh which is rendered centred on the origin.
  let workingOutline = orientedGeometry.outlinePoints;
  let workingProjected = orientedGeometry.projectedNodes;
  let workingSecondaryOutlines = secondaryOutlines;
  let workingSecondaries = orientedSecondaries;
  let scale: number;

  if (coasterMode) {
    const targetEnvelopeMm = COASTER_SIZE_MM - 2 * (COASTER_INNER_MARGIN_MM + BASE_CORNER_RADIUS_MM);
    const longestSide = Math.max(effectiveBasePlate.width, effectiveBasePlate.height);
    scale = longestSide > 0 ? targetEnvelopeMm / longestSide : 1;

    const centreX = (effectiveBasePlate.minX + effectiveBasePlate.maxX) / 2;
    const centreY = (effectiveBasePlate.minY + effectiveBasePlate.maxY) / 2;
    const dx = -centreX;
    const dy = -centreY;

    workingOutline = translateOutline(orientedGeometry.outlinePoints, dx, dy);
    workingProjected = orientedGeometry.projectedNodes
      ? orientedGeometry.projectedNodes.map(n => translatePoint(n, dx, dy))
      : orientedGeometry.projectedNodes;
    workingSecondaryOutlines = secondaryOutlines.map(o => translateOutline(o, dx, dy));
    workingSecondaries = orientedSecondaries.map(nodes => nodes.map(n => translatePoint(n, dx, dy)));

    // Synthetic base plate: a 90 mm square centred at origin, expressed in metres.
    // When scaled by `scale` it produces a 90×90 mm Rect2D for text placement.
    const halfMetres = (COASTER_SIZE_MM / 2) / scale;
    effectiveBasePlate = {
      minX: -halfMetres,
      maxX: halfMetres,
      minY: -halfMetres,
      maxY: halfMetres,
      width: halfMetres * 2,
      height: halfMetres * 2,
    };
  } else {
    scale = computeScale(effectiveBasePlate);
  }

  const ribbonOptions = coasterMode
    ? {
        trackHeightMm: coasterInlay === 'flush' ? COASTER_TRACK_HEIGHT_FLUSH_MM : COASTER_TRACK_HEIGHT_RAISED_MM,
        ignoreElevation: true,
        baseZ: coasterInlay === 'flush' ? BASE_THICKNESS_MM - COASTER_POCKET_DEPTH_MM : BASE_THICKNESS_MM,
      }
    : undefined;

  // Text placement uses all visible layouts as obstacles in combined mode.
  const allOutlinePoints = workingSecondaryOutlines.length > 0
    ? [workingOutline, ...workingSecondaryOutlines]
    : null;

  let rankedPlacements: RankedPlacements | null = null;
  const normalizedTrackName = String(trackName ?? '').trim();
  if (normalizedTrackName) {
    // Coaster mode runs placement against a different base plate shape, so it
    // must not reuse cached placements from non-coaster or cross-shape builds.
    const canUseCache = cacheActive && !coasterMode;
    rankedPlacements = canUseCache
      ? textPlacementCache.byOrientation.get(resolvedOrientationDeg) ?? null
      : null;
    if (!rankedPlacements && !coasterMode) {
      rankedPlacements = autoPlacementsForWinner;
    }

    if (!rankedPlacements) {
      rankedPlacements = computeRankedTextPlacements(
        normalizedTrackName,
        workingOutline,
        effectiveBasePlate,
        scale,
        { allOutlinePoints, perfTimer, coasterShape: coasterMode ? coasterShape : undefined },
      );
      if (canUseCache) {
        textPlacementCache.byOrientation.set(resolvedOrientationDeg, rankedPlacements);
      }
    }
  }

  perfTimer?.step('textPlacement');

  // In flush coaster mode, the text also sits in a top-surface pocket flush
  // with the base top. Collect the chosen placement's glyph shapes so they can
  // be passed as additional pockets to the base plate builder.
  const textPocketSpecs: CoasterPocketSpec[] = [];
  if (coasterMode && coasterInlay === 'flush' && rankedPlacements) {
    const expanded = selectAndExpandPlacement(rankedPlacements, { textPositionRank: resolvedTextPositionRank });
    if (expanded?.contours?.length) {
      const shapes = collectShapes(buildContourTree(expanded.contours));
      for (const shape of shapes) {
        textPocketSpecs.push({ boundary: shape.outer, islands: shape.holes });
      }
    }
  }

  const basePlateTriangles = coasterMode
    ? buildCoasterBasePlateMesh(
        coasterShape,
        coasterInlay === 'flush'
          ? [buildTrackPocketSpec(workingOutline, scale), ...textPocketSpecs]
          : [],
      )
    : buildBasePlateMesh(effectiveBasePlate, scale);

  perfTimer?.step('basePlate');

  // Build secondary prism meshes — unique segments only to avoid z-fighting on shared sections.
  const primaryEdgeSet = buildPrimaryEdgeSet(workingProjected ?? []);
  const secondaryTrackTriangles = workingSecondaries.flatMap(nodes => {
    const uniqueChains = getUniqueSubChains(nodes, primaryEdgeSet);
    return uniqueChains.flatMap(chain => buildTrackPrismMesh(null, scale, chain, true, ribbonOptions));
  });

  perfTimer?.step('secondaryTracks');

  // Primary layout prism mesh (shown in red in the preview/export).
  const trackTriangles = buildTrackPrismMesh(
    workingOutline, scale, workingProjected, false, ribbonOptions,
  );

  perfTimer?.step('primaryTrack');

  // Text height/Z:
  //  - non-coaster: unchanged (TEXT_HEIGHT_MM on top of base).
  //  - coaster raised: 0.2 mm on top of base, matching the track.
  //  - coaster flush: embedded in a 1 mm pocket, top flush with the base.
  const textBaseThickness = coasterMode && coasterInlay === 'flush'
    ? BASE_THICKNESS_MM - COASTER_POCKET_DEPTH_MM
    : BASE_THICKNESS_MM;
  const textHeight = coasterMode
    ? (coasterInlay === 'flush' ? COASTER_POCKET_DEPTH_MM : COASTER_TRACK_HEIGHT_RAISED_MM)
    : TEXT_HEIGHT_MM;
  const textTriangles = buildTextMeshFromRankedPlacements(rankedPlacements, {
    textPositionRank: resolvedTextPositionRank,
    baseThickness: textBaseThickness,
    textHeight,
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
    outlinePoints: workingOutline,
    basePlate: effectiveBasePlate,
    projectedNodes: workingProjected,
  };
  if (rankedPlacements?.allScoredPlacements) {
    result.allScoredPlacements = rankedPlacements.allScoredPlacements;
  }
  if (rankedPlacements?.dedupedPlacements) {
    result.dedupedPlacements = rankedPlacements.dedupedPlacements;
  }
  if (rankedPlacements?.candidates) {
    result.placementCandidates = rankedPlacements.candidates;
  }
  if (rankedPlacements?.scaledBasePlate) {
    result.scaledBasePlate = rankedPlacements.scaledBasePlate;
  }
  return result;
}
