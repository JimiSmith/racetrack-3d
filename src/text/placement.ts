import type { Font } from 'opentype.js';
import type { PerfTimer } from '../model/perf-timer.js';
import type { Point2D } from '../types/geometry.js';
import type { OutlinePoints, BasePlate } from '../types/model.js';
import type {
  Rect2D,
  TextPlacementCandidate,
  FittedTextLayout,
  RankedTextPlacement,
  RankedPlacements,
} from '../types/text.js';
import { buildMultilineContours, polygonBounds } from './contours.js';
import type { MultilineContours } from './contours.js';
import { findOptimalLineBreaks, measureWordWidths, MAX_TEXT_LINES } from './line-breaking.js';
import { loadFont } from './font-loader.js';
import { scoreTextFit, computeSizeWindowMultiplier, computeLineCountMultiplier, computeTextClearanceMultiplier } from './scoring.js';
import type { ClearanceContext } from './scoring.js';

export const MIN_CELL_MM = 3;
export const MIN_GRID_CELLS_PER_SIDE = 8;
export const MAX_CANDIDATES = 16;

const SEGMENT_INTERSECTION_EPSILON = 1e-9;
const MAX_PREFERRED_HEIGHT_MM = 24 * 25.4 / 72;
const MIN_TEXT_HEIGHT_MM = 2;

// Performance counters for benchmarking — gated behind __perfCounters so they add zero cost in production.
interface PlacementCounters {
  computePlacementMask: number;
  findPlacementCandidates: number;
  rankTextPlacements: number;
  computeRankedTextPlacements: number;
}

let __perfCounters: PlacementCounters | null = null;
export function __resetPerfCounters(): void {
  __perfCounters = {
    computePlacementMask: 0,
    findPlacementCandidates: 0,
    rankTextPlacements: 0,
    computeRankedTextPlacements: 0,
  };
}
export function __getPerfCounters(): PlacementCounters | null { return __perfCounters ? { ...__perfCounters } : null; }
export function __disablePerfCounters(): void { __perfCounters = null; }

function pointInPolygon(point: Point2D, polygon: Point2D[]): boolean {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: Point2D, a: Point2D, b: Point2D): boolean {
  const cross = orientation(a, b, point);
  if (Math.abs(cross) > SEGMENT_INTERSECTION_EPSILON) {
    return false;
  }

  return point.x >= Math.min(a.x, b.x) - SEGMENT_INTERSECTION_EPSILON
    && point.x <= Math.max(a.x, b.x) + SEGMENT_INTERSECTION_EPSILON
    && point.y >= Math.min(a.y, b.y) - SEGMENT_INTERSECTION_EPSILON
    && point.y <= Math.max(a.y, b.y) + SEGMENT_INTERSECTION_EPSILON;
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  const s1 = Math.sign(o1);
  const s2 = Math.sign(o2);
  const s3 = Math.sign(o3);
  const s4 = Math.sign(o4);

  if (s1 !== 0 && s2 !== 0 && s1 !== s2 && s3 !== 0 && s4 !== 0 && s3 !== s4) {
    return true;
  }

  return pointOnSegment(c, a, b)
    || pointOnSegment(d, a, b)
    || pointOnSegment(a, c, d)
    || pointOnSegment(b, c, d);
}

export function rectIntersectsPolygon(rect: Rect2D, polygon: Point2D[] | null | undefined): boolean {
  if (!polygon?.length) {
    return false;
  }

  const corners: Point2D[] = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];

  if (corners.some(corner => pointInPolygon(corner, polygon))) {
    return true;
  }

  if (polygon.some(point => (
    point.x >= rect.minX
      && point.x <= rect.maxX
      && point.y >= rect.minY
      && point.y <= rect.maxY
  ))) {
    return true;
  }

  const rectangleEdges: [Point2D, Point2D][] = [
    [corners[0]!, corners[1]!],
    [corners[1]!, corners[2]!],
    [corners[2]!, corners[3]!],
    [corners[3]!, corners[0]!],
  ];

  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index]!;
    const b = polygon[(index + 1) % polygon.length]!;

    for (const [rectA, rectB] of rectangleEdges) {
      if (segmentsIntersect(rectA, rectB, a, b)) {
        return true;
      }
    }
  }

  return false;
}

function rectFullyInsidePolygon(rect: Rect2D, polygon: Point2D[] | null | undefined): boolean {
  if (!polygon?.length) {
    return false;
  }

  return [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ].every(corner => pointInPolygon(corner, polygon));
}

/** Internal grid descriptor produced by createPlacementGrid(). */
interface PlacementGrid {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  edgeMarginCells: number;
  obstacleMarginCells: number;
}

function createPlacementGrid(basePlate: Rect2D): PlacementGrid {
  const longSide = Math.max(basePlate.width, basePlate.height);
  const shortSide = Math.min(basePlate.width, basePlate.height);
  const longCells = Math.max(MIN_GRID_CELLS_PER_SIDE, Math.floor(longSide / MIN_CELL_MM));
  const cellSize = longSide / longCells;
  const shortCells = Math.max(MIN_GRID_CELLS_PER_SIDE, Math.round(shortSide / cellSize));
  const columns = basePlate.width >= basePlate.height ? longCells : shortCells;
  const rows = basePlate.width >= basePlate.height ? shortCells : longCells;
  const cellWidth = basePlate.width / columns;
  const cellHeight = basePlate.height / rows;
  const edgeMarginCells = 1;
  const obstacleMarginCells = shortSide >= 80 ? 1 : 0;

  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    edgeMarginCells,
    obstacleMarginCells,
  };
}

function dilateBlockedCells(mask: boolean[][], radius: number): boolean[][] {
  if (radius <= 0) {
    return mask;
  }

  const rows = mask.length;
  const columns = mask[0]?.length ?? 0;
  const dilated = mask.map(row => [...row]);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!mask[row]![column]) {
        continue;
      }

      for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
        for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
          const nextRow = row + deltaY;
          const nextColumn = column + deltaX;
          if (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < columns) {
            dilated[nextRow]![nextColumn] = true;
          }
        }
      }
    }
  }

  return dilated;
}

function buildDistanceMap(mask: boolean[][]): number[][] {
  const rows = mask.length;
  const columns = mask[0]?.length ?? 0;
  const distances: number[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => Infinity));
  const queue: [number, number][] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!mask[row]![column]) {
        continue;
      }

      distances[row]![column] = 0;
      queue.push([row, column]);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const [row, column] = queue[index]!;
    const nextDistance = distances[row]![column]! + 1;

    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        if (deltaX === 0 && deltaY === 0) {
          continue;
        }

        const nextRow = row + deltaY;
        const nextColumn = column + deltaX;
        if (nextRow < 0 || nextRow >= rows || nextColumn < 0 || nextColumn >= columns) {
          continue;
        }

        if (nextDistance < distances[nextRow]![nextColumn]!) {
          distances[nextRow]![nextColumn] = nextDistance;
          queue.push([nextRow, nextColumn]);
        }
      }
    }
  }

  return distances;
}

/** Minimal candidate shape for clearance computation. */
interface CandidateCell {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function computeCandidateTrackClearance(candidate: CandidateCell, distanceMap: number[][]): number {
  let trackClearance = Infinity;

  for (let row = candidate.top; row <= candidate.bottom; row += 1) {
    for (let column = candidate.left; column <= candidate.right; column += 1) {
      trackClearance = Math.min(trackClearance, distanceMap[row]?.[column] ?? Infinity);
    }
  }

  return Number.isFinite(trackClearance) ? trackClearance : 0;
}

function computeCentreDistance(rect: Rect2D, basePlate: Rect2D): number {
  const rectCenterX = rect.minX + rect.width / 2;
  const rectCenterY = rect.minY + rect.height / 2;
  const baseCenterX = basePlate.minX + basePlate.width / 2;
  const baseCenterY = basePlate.minY + basePlate.height / 2;
  const maxDistance = Math.hypot(basePlate.width / 2, basePlate.height / 2) || 1;
  return Math.min(1, Math.hypot(rectCenterX - baseCenterX, rectCenterY - baseCenterY) / maxDistance);
}

/** The result of computePlacementMask(). */
export interface PlacementMask extends PlacementGrid {
  blockedBeforeDilation: boolean[][];
  blocked: boolean[][];
  outside: boolean[][];
}

export function computePlacementMask(allObstacleOutlines: OutlinePoints[], primaryOutline: OutlinePoints | null | undefined, basePlate: Rect2D): PlacementMask {
  if (__perfCounters) { __perfCounters.computePlacementMask++; }
  const grid = createPlacementGrid(basePlate);
  const mask: boolean[][] = Array.from({ length: grid.rows }, () => Array.from({ length: grid.columns }, () => false));
  const outside: boolean[][] = Array.from({ length: grid.rows }, () => Array.from({ length: grid.columns }, () => true));
  const hasOuterRing = (primaryOutline?.outerRing?.length ?? 0) >= 3;

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const minX = basePlate.minX + column * grid.cellWidth;
      const minY = basePlate.minY + row * grid.cellHeight;
      const x = minX + grid.cellWidth / 2;
      const y = minY + grid.cellHeight / 2;
      const rect: Rect2D = {
        minX,
        minY,
        maxX: minX + grid.cellWidth,
        maxY: minY + grid.cellHeight,
        width: grid.cellWidth,
        height: grid.cellHeight,
      };

      mask[row]![column] = allObstacleOutlines.some(outline => {
        const intersects = rectIntersectsPolygon(rect, outline?.outerRing);
        const insideHole = intersects && (outline?.holes ?? []).some(
          hole => hole.length >= 3 && rectFullyInsidePolygon(rect, hole),
        );
        return intersects && !insideHole;
      });
      outside[row]![column] = !hasOuterRing || !pointInPolygon({ x, y }, primaryOutline!.outerRing);
    }
  }

  const dilated = dilateBlockedCells(mask, grid.obstacleMarginCells);

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      if (
        row < grid.edgeMarginCells
        || column < grid.edgeMarginCells
        || row >= grid.rows - grid.edgeMarginCells
        || column >= grid.columns - grid.edgeMarginCells
      ) {
        dilated[row]![column] = true;
      }
    }
  }

  return {
    ...grid,
    blockedBeforeDilation: mask,
    blocked: dilated,
    outside,
  };
}

function buildPrefixSum(grid: boolean[][]): number[][] {
  const rows = grid.length;
  const columns = grid[0]?.length ?? 0;
  const prefix: number[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: columns + 1 }, () => 0));

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      prefix[row + 1]![column + 1] = (grid[row]![column] ? 1 : 0)
        + prefix[row]![column + 1]!
        + prefix[row + 1]![column]!
        - prefix[row]![column]!;
    }
  }

  return prefix;
}

function sumPrefixArea(prefix: number[][], left: number, top: number, right: number, bottom: number): number {
  return prefix[bottom + 1]![right + 1]!
    - prefix[top]![right + 1]!
    - prefix[bottom + 1]![left]!
    + prefix[top]![left]!;
}

function rectIntersectionArea(a: Rect2D, b: Rect2D): number {
  const overlapWidth = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapHeight = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return overlapWidth * overlapHeight;
}

function candidateToBounds(candidate: CandidateCell, basePlate: Rect2D, grid: PlacementGrid): Rect2D {
  const minX = basePlate.minX + candidate.left * grid.cellWidth;
  const maxX = basePlate.minX + (candidate.right + 1) * grid.cellWidth;
  const minY = basePlate.minY + candidate.top * grid.cellHeight;
  const maxY = basePlate.minY + (candidate.bottom + 1) * grid.cellHeight;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** Internal rectangle found by the histogram sweep, before deduplication. */
interface RawCandidate extends CandidateCell {
  widthCells: number;
  heightCells: number;
  areaCells: number;
  fractionOutside: number;
  trackClearance: number;
}

/** Deduplicated candidate with mm bounds and area, before final index/clearance fields. */
interface DedupedCandidate extends RawCandidate {
  bounds: Rect2D;
  area: number;
}

function dedupeCandidates(candidates: RawCandidate[], basePlate: Rect2D, grid: PlacementGrid, maxCandidates: number): DedupedCandidate[] {
  const deduped: DedupedCandidate[] = [];

  for (const candidate of candidates) {
    const bounds = candidateToBounds(candidate, basePlate, grid);
    const area = bounds.width * bounds.height;
    if (area <= 0) {
      continue;
    }

    const duplicate = deduped.find(existing => {
      const intersection = rectIntersectionArea(bounds, existing.bounds);
      return intersection / Math.min(area, existing.area) > 0.5;
    });

    if (duplicate) {
      continue;
    }

    deduped.push({ ...candidate, bounds, area });
    if (deduped.length >= maxCandidates) {
      break;
    }
  }

  return deduped;
}

/** Result of findPlacementCandidates(). */
export interface PlacementCandidatesResult {
  candidates: TextPlacementCandidate[];
  distanceMap: number[][];
  maxTrackClearance: number;
}

/** Stack item used during the histogram sweep. */
interface StackItem {
  start: number;
  height: number;
}

export function findPlacementCandidates(basePlate: Rect2D, placementMask: PlacementMask, maxCandidates: number = MAX_CANDIDATES): PlacementCandidatesResult {
  if (__perfCounters) { __perfCounters.findPlacementCandidates++; }
  const heights: number[] = Array.from({ length: placementMask.columns }, () => 0);
  const rectangles: RawCandidate[] = [];
  const outsidePrefix = buildPrefixSum(placementMask.outside ?? []);
  const blockedDistanceMap = buildDistanceMap(placementMask.blockedBeforeDilation ?? placementMask.blocked ?? []);
  const maxTrackClearance = Math.max(placementMask.rows - 1, placementMask.columns - 1) || 1;

  for (let row = 0; row < placementMask.rows; row += 1) {
    for (let column = 0; column < placementMask.columns; column += 1) {
      heights[column] = placementMask.blocked[row]![column] ? 0 : (heights[column] ?? 0) + 1;
    }

    const stack: StackItem[] = [];
    for (let column = 0; column <= placementMask.columns; column += 1) {
      const currentHeight = column < placementMask.columns ? (heights[column] ?? 0) : 0;
      let start = column;

      while (stack.length && stack[stack.length - 1]!.height > currentHeight) {
        const item = stack.pop()!;
        start = item.start;
        if (item.height <= 0 || column <= item.start) {
          continue;
        }

        rectangles.push({
          left: item.start,
          right: column - 1,
          top: row - item.height + 1,
          bottom: row,
          widthCells: column - item.start,
          heightCells: item.height,
          areaCells: (column - item.start) * item.height,
          fractionOutside: sumPrefixArea(
            outsidePrefix,
            item.start,
            row - item.height + 1,
            column - 1,
            row,
          ) / ((column - item.start) * item.height),
          trackClearance: computeCandidateTrackClearance({
            left: item.start,
            right: column - 1,
            top: row - item.height + 1,
            bottom: row,
          }, blockedDistanceMap),
        });
      }

      if (!stack.length || stack[stack.length - 1]!.height < currentHeight) {
        stack.push({ start, height: currentHeight });
      }
    }
  }

  rectangles.sort((a, b) => (
    b.areaCells - a.areaCells
      || Math.abs(a.widthCells - a.heightCells) - Math.abs(b.widthCells - b.heightCells)
      || a.top - b.top
      || a.left - b.left
  ));

  const candidates: TextPlacementCandidate[] = dedupeCandidates(rectangles, basePlate, placementMask, maxCandidates).map((candidate, index) => ({
    ...candidate,
    index,
    fractionOutside: candidate.fractionOutside ?? 0,
    trackClearance: candidate.trackClearance ?? 0,
    normalizedTrackClearance: Math.min(1, (candidate.trackClearance ?? 0) / maxTrackClearance),
    centreDistance: computeCentreDistance(candidate.bounds, basePlate),
  }));

  return { candidates, distanceMap: blockedDistanceMap, maxTrackClearance };
}

function scaleLayoutsToRect(multilines: MultilineContours[], rect: Rect2D): Omit<FittedTextLayout, 'score'>[] {
  const layouts: Omit<FittedTextLayout, 'score'>[] = [];

  for (const multiline of multilines) {
    const fittedScale = Math.min(
      rect.width / multiline.bounds.width,
      rect.height / multiline.bounds.height,
      MAX_PREFERRED_HEIGHT_MM / multiline.averageLineHeight,
    );

    if (!Number.isFinite(fittedScale) || fittedScale * multiline.averageLineHeight < MIN_TEXT_HEIGHT_MM) {
      continue;
    }

    const fittedWidth = multiline.bounds.width * fittedScale;
    const fittedHeight = multiline.bounds.height * fittedScale;
    layouts.push({
      text: multiline.text,
      lines: multiline.lines,
      scale: fittedScale,
      bounds: multiline.bounds,
      contours: multiline.contours,
      lineBounds: multiline.lineBounds,
      fittedWidth,
      fittedHeight,
      averageLineHeight: multiline.averageLineHeight,
      maxLineWidth: multiline.maxLineWidth,
      minLineWidth: multiline.minLineWidth,
      lineCount: multiline.lineCount,
    });
  }

  return layouts;
}

function precomputeMultilineLayouts(text: string, font: Font, cache: Map<string, import('./contours.js').LineMeasurement | null>): MultilineContours[] {
  const words = String(text).split(/\s+/u).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const { wordWidths, spaceWidth } = measureWordWidths(words, font, cache);
  const multilines: MultilineContours[] = [];
  const maxLines = Math.min(MAX_TEXT_LINES, words.length);

  for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
    const optimalLines = findOptimalLineBreaks(words, lineCount, wordWidths, spaceWidth);
    const multiline = buildMultilineContours(optimalLines, font, cache);
    if (!multiline || multiline.bounds.width <= 0 || multiline.bounds.height <= 0) {
      continue;
    }
    multilines.push(multiline);
  }

  return multilines;
}

/** Result of finding the best layout for a single candidate location. */
interface BestLayoutResult {
  layout: FittedTextLayout;
  score: number;
}

function findBestPrecomputedLayoutForLocation(multilines: MultilineContours[], candidate: TextPlacementCandidate, clearanceContext: ClearanceContext | null = null): BestLayoutResult | null {
  const layouts = scaleLayoutsToRect(multilines, candidate.bounds);
  if (!layouts.length) { return null; }

  let bestLayout: Omit<FittedTextLayout, 'score'> | null = null;
  let bestScore = -Infinity;

  for (const layout of layouts) {
    const score = scoreTextFit(candidate.bounds, { ...layout, score: 0 }, candidate, clearanceContext);
    if (score > bestScore) {
      bestScore = score;
      bestLayout = layout;
    }
  }

  return bestLayout ? { layout: { ...bestLayout, score: bestScore }, score: bestScore } : null;
}

export function compareRankedTextPlacements(a: RankedTextPlacement, b: RankedTextPlacement): number {
  return b.score - a.score
    || a.candidateIndex - b.candidateIndex;
}

export function rankTextPlacements(text: string, font: Font, candidates: TextPlacementCandidate[], clearanceContext: ClearanceContext | null = null): RankedTextPlacement[] {
  if (__perfCounters) { __perfCounters.rankTextPlacements++; }
  const cache = new Map<string, import('./contours.js').LineMeasurement | null>();

  // Pre-compute all multiline layouts once — line breaks and glyph contours
  // depend only on text + line count, not on the candidate rectangle.
  const multilines = precomputeMultilineLayouts(text, font, cache);
  if (!multilines.length) {
    return [];
  }

  const locationResults: RankedTextPlacement[] = candidates
    .map((candidate, candidateIndex) => {
      const best = findBestPrecomputedLayoutForLocation(multilines, candidate, clearanceContext);
      if (!best) { return null; }
      return { candidate, candidateIndex, layout: best.layout, score: best.score };
    })
    .filter((r): r is RankedTextPlacement => r !== null);

  locationResults.sort(compareRankedTextPlacements);

  return locationResults.slice(0, 3);
}

function scaleRing(points: Point2D[] | null | undefined, scale: number): Point2D[] {
  return (points ?? []).map(point => ({
    x: point.x * scale,
    y: point.y * scale,
  }));
}

export function scaleOutline(outlinePoints: OutlinePoints | Point2D[] | null | undefined, scale: number): OutlinePoints {
  const asOutline = outlinePoints as OutlinePoints | null | undefined;
  return {
    outerRing: scaleRing(asOutline?.outerRing ?? (outlinePoints as Point2D[] | null | undefined) ?? [], scale),
    holes: (asOutline?.holes ?? []).map(hole => scaleRing(hole, scale)),
  };
}

export function createScaledBounds(bounds: BasePlate, scale: number): Rect2D {
  return {
    minX: bounds.minX * scale,
    minY: bounds.minY * scale,
    maxX: bounds.maxX * scale,
    maxY: bounds.maxY * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

/** Options for computeRankedTextPlacements(). */
interface ComputeRankedOptions {
  font?: import('opentype.js').Font | null;
  allOutlinePoints?: OutlinePoints[] | null;
  perfTimer?: PerfTimer | undefined;
}

export function computeRankedTextPlacements(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options: ComputeRankedOptions = {},
): RankedPlacements | null {
  if (__perfCounters) { __perfCounters.computeRankedTextPlacements++; }
  const { perfTimer } = options;
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return null;
  }

  const font = loadFont(options.font ?? null);
  perfTimer?.step('textPlacement:font');
  const scaledOutline = scaleOutline(outlinePoints, scale);
  const scaledBasePlate = createScaledBounds(basePlate, scale);
  const allScaledOutlines = options.allOutlinePoints
    ? options.allOutlinePoints.map(o => scaleOutline(o, scale))
    : [scaledOutline];
  perfTimer?.step('textPlacement:scale');
  const placementMask = computePlacementMask(allScaledOutlines, scaledOutline, scaledBasePlate);
  perfTimer?.step('textPlacement:mask');
  const { candidates, distanceMap, maxTrackClearance } = findPlacementCandidates(scaledBasePlate, placementMask);
  perfTimer?.step('textPlacement:candidates');
  if (!candidates.length) {
    return null;
  }

  const clearanceContext: ClearanceContext = {
    distanceMap,
    maxTrackClearance,
    cellWidth: placementMask.cellWidth,
    cellHeight: placementMask.cellHeight,
    originX: scaledBasePlate.minX,
    originY: scaledBasePlate.minY,
  };
  const placements = rankTextPlacements(
    normalizedText,
    font,
    candidates,
    clearanceContext,
  );
  perfTimer?.step('textPlacement:rank');
  if (!placements.length) {
    return null;
  }

  return { placements, clearanceContext, candidates, scaledBasePlate };
}

export { computeSizeWindowMultiplier, computeLineCountMultiplier, computeTextClearanceMultiplier, polygonBounds };
