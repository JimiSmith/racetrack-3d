import { buildTrackOutline as _buildTrackOutline, DEFAULT_BASE_PLATE_MARGIN_METRES } from '../geometry/outline.js';
import {
  computeRankedTextPlacements,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  TEXT_HEIGHT_MM,
} from '../text3d.js';
import type { TrackModel, OutlinePoints, BasePlate } from '../types/model.js';
import type { ProjectedNode } from '../types/geometry.js';
import type { RankedPlacements } from '../types/text.js';
import { selectAndExpandPlacement } from '../text/mesh.js';
import { buildContourTree, collectShapes } from '../text/contours.js';
import type { ContourShape } from '../text/contours.js';
import type { PerfTimer } from './perf-timer.js';
import {
  BASE_THICKNESS_MM,
  COASTER_SIZE_MM,
  COASTER_INNER_MARGIN_MM,
  COASTER_POCKET_DEPTH_MM,
  BASE_CORNER_RADIUS_MM,
  TARGET_MAX_SIZE_MM,
  computeScale,
} from './base-plate.js';
import type { Footprint, CsgSpec } from './base-plate-csg.js';
import {
  COASTER_TRACK_HEIGHT_FLUSH_MM,
  COASTER_TRACK_HEIGHT_RAISED_MM,
  TRACK_HEIGHT_MM,
  TRACK_WIDTH_METRES,
  MIN_COASTER_TRACK_WIDTH_MM,
  type RibbonMeshOptions,
} from './track-ribbon.js';
import {
  PRIMARY_ORIENTATION_AUTO,
  normalizePrimaryOrientationDeg,
  normalizeOrientationDeg,
  rotatePointsByOrientation,
  orientTrackGeometry,
  selectAutoOrientation,
  boundsFromPoints,
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
}

let __modelPerfCounters: ModelPerfCounters | null = null;

export function __resetModelPerfCounters(): void {
  __modelPerfCounters = {
    buildTrackOutline: 0,
    selectAutoOrientation: 0,
  };
  __setOrientationBuildTrackOutlineCounter(__modelPerfCounters);
  __setAutoOrientCounter(__modelPerfCounters);
}

export function __getModelPerfCounters(): ModelPerfCounters | null {
  return __modelPerfCounters ? { ...__modelPerfCounters } : null;
}

export function __disableModelPerfCounters(): void {
  __modelPerfCounters = null;
  __setOrientationBuildTrackOutlineCounter(null);
  __setAutoOrientCounter(null);
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
  /**
   * When true (default), the printed ribbon width is auto-derived:
   * non-coaster uses TRACK_WIDTH_METRES; coaster clamps to MIN_COASTER_TRACK_WIDTH_MM.
   * When false, `trackWidthMm` overrides in both modes.
   */
  trackWidthAuto?: boolean;
  /** User-selected printed ribbon width in mm; used when trackWidthAuto is false. */
  trackWidthMm?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const COASTER_TARGET_ENVELOPE_MM = COASTER_SIZE_MM - 2 * (COASTER_INNER_MARGIN_MM + BASE_CORNER_RADIUS_MM);
/** Total margin (both sides per axis) added by buildBasePlate's default margin. */
const BASE_PLATE_MARGIN_TOTAL_METRES = 2 * DEFAULT_BASE_PLATE_MARGIN_METRES;

/**
 * Solves for the ribbon width (in metres) that — once buffered by `buildTrackOutline`
 * and bounded by `buildBasePlate` — renders at exactly `targetMm` printed millimetres.
 *
 * Derivation:
 *   basePlate.longest = bbox(line).longest + widthMetres + 2 * margin
 *   scale = TARGET_MM / basePlate.longest
 *   rendered_mm = widthMetres * scale = targetMm  (we want this)
 *   ⇒ widthMetres = targetMm * (B + M) / (TARGET_MM - targetMm)
 * where B = bbox(line) longest side, M = 2 * margin.
 */
function solveWidthMetresForTargetMm(
  bboxLongestMetres: number,
  targetEnvelopeMm: number,
  targetMm: number,
): number {
  if (!Number.isFinite(targetMm) || targetMm <= 0 || targetMm >= targetEnvelopeMm) {
    return TRACK_WIDTH_METRES;
  }
  return targetMm * (bboxLongestMetres + BASE_PLATE_MARGIN_TOTAL_METRES) / (targetEnvelopeMm - targetMm);
}

/**
 * Computes the effective ribbon width (metres) to be applied during outline
 * construction, accounting for auto/manual mode and coaster vs non-coaster.
 * Solved upfront so auto-orientation scoring and per-orientation text placement
 * use the same outline as the final render.
 */
function computeEffectiveTrackWidthMetres(
  projectedNodes: ProjectedNode[] | null | undefined,
  secondaryProjectedNodes: ProjectedNode[][],
  coasterMode: boolean,
  trackWidthAuto: boolean,
  trackWidthMm: number,
): number {
  if (trackWidthAuto && !coasterMode) {
    return TRACK_WIDTH_METRES;
  }

  const allNodes = [projectedNodes, ...secondaryProjectedNodes]
    .filter((nodes): nodes is ProjectedNode[] => !!nodes?.length)
    .flat();
  const bounds = boundsFromPoints(allNodes);
  const B = Math.max(bounds.width, bounds.height);
  if (!Number.isFinite(B) || B <= 0) {
    return TRACK_WIDTH_METRES;
  }

  const targetEnvelopeMm = coasterMode ? COASTER_TARGET_ENVELOPE_MM : TARGET_MAX_SIZE_MM;
  if (!trackWidthAuto) {
    return solveWidthMetresForTargetMm(B, targetEnvelopeMm, trackWidthMm);
  }
  // coasterMode auto: ensure rendered width >= MIN_COASTER_TRACK_WIDTH_MM,
  // otherwise fall back to the default.
  const widthAtMin = solveWidthMetresForTargetMm(B, targetEnvelopeMm, MIN_COASTER_TRACK_WIDTH_MM);
  return Math.max(TRACK_WIDTH_METRES, widthAtMin);
}

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
 * Converts a list of contour shapes (placement coords, mm) into CSG footprints
 * (outer + holes), filtering rings that are too small to form a polygon.
 */
function shapesToFootprints(shapes: ContourShape[]): Footprint[] {
  return shapes
    .filter(shape => shape.outer.length >= 3)
    .map(shape => ({
      outer: shape.outer.map(p => ({ x: p.x, y: p.y })),
      holes: shape.holes.filter(h => h.length >= 3).map(h => h.map(p => ({ x: p.x, y: p.y }))),
    }));
}

// ── buildTrackModel ──────────────────────────────────────────────────────────

export async function buildTrackModel({
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
  trackWidthAuto = true,
  trackWidthMm = 2,
}: BuildTrackModelOptions): Promise<TrackModel> {
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

  // Solve for the ribbon width (in metres) upfront so auto-orientation scoring,
  // per-orientation text placement, and the final render all use the same outline.
  const effectiveTrackWidthMetres = computeEffectiveTrackWidthMetres(
    projectedNodes,
    secondaryProjectedNodes,
    coasterMode,
    trackWidthAuto,
    trackWidthMm,
  );

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
        effectiveTrackWidthMetres,
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
      widthMetres: effectiveTrackWidthMetres,
    });
    orientedSecondaries = secondaryProjectedNodes.map(nodes =>
      rotatePointsByOrientation(nodes, resolvedOrientationDeg) as ProjectedNode[]
    );
    secondaryOutlines = orientedSecondaries.map(nodes => buildTrackOutline(nodes, effectiveTrackWidthMetres));
  }

  perfTimer?.step('geometry');

  // In combined mode, expand the base plate to encompass all layouts.
  // When reusing autoGeometry, the basePlate already accounts for secondary outlines.
  let effectiveBasePlate = !autoGeometry && secondaryOutlines.length > 0
    ? (buildCombinedBasePlate([orientedGeometry.outlinePoints, ...secondaryOutlines]) ?? orientedGeometry.basePlate)
    : orientedGeometry.basePlate;

  // ── Geometry post-processing ───────────────────────────────────────────────
  // Outlines from the orientation pass are already at effectiveTrackWidthMetres,
  // so non-coaster mode just needs the rendering scale. Coaster mode additionally
  // translates the geometry so the track's bounding-box centre sits at (0, 0)
  // (aligning with the coaster mesh) and substitutes a synthetic 90 mm base plate.
  let workingOutline = orientedGeometry.outlinePoints;
  let workingProjected = orientedGeometry.projectedNodes;
  let workingSecondaryOutlines = secondaryOutlines;
  let workingSecondaries = orientedSecondaries;
  let scale: number;

  if (coasterMode) {
    const longestSide = Math.max(effectiveBasePlate.width, effectiveBasePlate.height);
    scale = longestSide > 0 ? COASTER_TARGET_ENVELOPE_MM / longestSide : 1;

    const centreX = (effectiveBasePlate.minX + effectiveBasePlate.maxX) / 2;
    const centreY = (effectiveBasePlate.minY + effectiveBasePlate.maxY) / 2;
    const dx = -centreX;
    const dy = -centreY;

    workingProjected = orientedGeometry.projectedNodes
      ? orientedGeometry.projectedNodes.map(n => translatePoint(n, dx, dy))
      : orientedGeometry.projectedNodes;
    workingSecondaries = orientedSecondaries.map(nodes => nodes.map(n => translatePoint(n, dx, dy)));

    // The orientation-pass outlines are already buffered at
    // effectiveTrackWidthMetres, so translating them is equivalent to (and far
    // cheaper than) re-buffering the translated nodes.
    workingOutline = translateOutline(orientedGeometry.outlinePoints, dx, dy);
    workingSecondaryOutlines = secondaryOutlines.map(outline => translateOutline(outline, dx, dy));

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
        trackWidthMetres: effectiveTrackWidthMetres,
      }
    : (trackWidthAuto ? undefined : { trackWidthMetres: effectiveTrackWidthMetres });

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

  // Collect the chosen placement's glyph shapes (true, un-perturbed contours).
  // CSG's CrossSection union resolves overlapping/abutting glyphs exactly, so no
  // per-glyph perturbation is needed. These footprints serve as the text solid
  // (raised/embossed) and, in flush mode, as the base pocket cutter for text.
  let textFootprints: Footprint[] = [];
  if (rankedPlacements) {
    const expanded = selectAndExpandPlacement(rankedPlacements, { textPositionRank: resolvedTextPositionRank });
    if (expanded?.contours?.length) {
      textFootprints = shapesToFootprints(collectShapes(buildContourTree(expanded.contours)));
    }
  }

  // Text height/Z:
  //  - non-coaster: TEXT_HEIGHT_MM on top of base.
  //  - coaster raised: 0.2 mm on top of base, matching the track.
  //  - coaster flush: embedded in a 1 mm pocket, top flush with the base.
  const textBaseThickness = coasterMode && coasterInlay === 'flush'
    ? BASE_THICKNESS_MM - COASTER_POCKET_DEPTH_MM
    : BASE_THICKNESS_MM;
  const textHeight = coasterMode
    ? (coasterInlay === 'flush' ? COASTER_POCKET_DEPTH_MM : COASTER_TRACK_HEIGHT_RAISED_MM)
    : TEXT_HEIGHT_MM;

  // Unique secondary sub-chains (drop sections shared with the primary to avoid
  // z-fighting); each buffered into a closed outline so the CSG path extrudes a
  // clean (non-self-intersecting) solid. Combined into one grey solid by CSG.
  const primaryEdgeSet = buildPrimaryEdgeSet(workingProjected ?? []);
  const secondaryRibbonOutlines = workingSecondaries
    .flatMap(nodes => getUniqueSubChains(nodes, primaryEdgeSet))
    .filter(chain => chain.length >= 2)
    .map(chain => ({ outline: buildTrackOutline(chain, effectiveTrackWidthMetres), projected: chain }));

  // Normalize the ribbon options into a concrete shape for the CSG extruder.
  const csgRibbon: RibbonMeshOptions = {
    trackHeightMm: ribbonOptions?.trackHeightMm ?? TRACK_HEIGHT_MM,
    ignoreElevation: ribbonOptions?.ignoreElevation ?? false,
    baseZ: ribbonOptions?.baseZ ?? BASE_THICKNESS_MM,
    trackWidthMetres: ribbonOptions?.trackWidthMetres ?? effectiveTrackWidthMetres,
  };

  const mode: CsgSpec['mode'] = coasterMode
    ? (coasterInlay === 'flush' ? 'coaster-flush' : 'coaster-raised')
    : 'embossed';

  // Dynamic import keeps the ~1 MB wasm + glue out of any chunk that merely
  // imports src/model for types/constants (export worker, preview module).
  const { buildModelGeometryCsg } = await import('./base-plate-csg.js');

  const csg = await buildModelGeometryCsg({
    mode,
    coasterShape,
    scale,
    primaryOutline: workingOutline,
    primaryProjected: workingProjected,
    secondaryOutlines: secondaryRibbonOutlines,
    basePlate: effectiveBasePlate,
    flushTextFootprints: mode === 'coaster-flush' ? textFootprints : [],
    textSolid: textFootprints.length > 0
      ? { footprints: textFootprints, baseZ: textBaseThickness, height: textHeight }
      : null,
    ribbon: csgRibbon,
  });

  perfTimer?.step('csg');

  const result: TrackModel = {
    triangles: csg.triangles,
    baseTriangleCount: csg.baseTriangleCount,
    secondaryTrackTriangleCount: csg.secondaryTrackTriangleCount,
    trackTriangleCount: csg.trackTriangleCount,
    textTriangleCount: csg.textTriangleCount,
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
