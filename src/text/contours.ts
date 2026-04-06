import type { Font, PathCommand } from 'opentype.js';
import type { Point2D } from '../types/geometry.js';
import type { Rect2D } from '../types/text.js';

export const CURVE_SEGMENTS = 8;

// Performance counters for benchmarking — gated behind __perfCounters so they add zero cost in production.
interface ContoursCounters {
  buildMultilineContours: number;
}

let __perfCounters: ContoursCounters | null = null;
export function __resetPerfCounters(): void {
  __perfCounters = { buildMultilineContours: 0 };
}
export function __getPerfCounters(): ContoursCounters | null { return __perfCounters ? { ...__perfCounters } : null; }
export function __disablePerfCounters(): void { __perfCounters = null; }

function signedArea(points: Point2D[]): number {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function ensureClockwise(points: Point2D[]): Point2D[] {
  return signedArea(points) <= 0 ? points : [...points].reverse();
}

function ensureCounterClockwise(points: Point2D[]): Point2D[] {
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

export function polygonBounds(points: Point2D[]): Rect2D {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

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

function normalizeContour(points: Point2D[]): Point2D[] | null {
  const contour: Point2D[] = [];

  for (const point of points) {
    if (!Number.isFinite((point as Partial<Point2D>)?.x) || !Number.isFinite((point as Partial<Point2D>)?.y)) {
      continue;
    }

    const previous = contour[contour.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      contour.push({ x: point.x, y: point.y });
    }
  }

  if (contour.length >= 2) {
    const first = contour[0]!;
    const last = contour[contour.length - 1]!;
    if (first.x === last.x && first.y === last.y) {
      contour.pop();
    }
  }

  return contour.length >= 3 ? contour : null;
}

function sampleQuadraticCurve(start: Point2D, control: Point2D, end: Point2D, segments: number): Point2D[] {
  const points: Point2D[] = [];

  for (let step = 1; step <= segments; step += 1) {
    const t = step / segments;
    const oneMinusT = 1 - t;
    points.push({
      x: oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x,
      y: oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y,
    });
  }

  return points;
}

function sampleCubicCurve(start: Point2D, controlA: Point2D, controlB: Point2D, end: Point2D, segments: number): Point2D[] {
  const points: Point2D[] = [];

  for (let step = 1; step <= segments; step += 1) {
    const t = step / segments;
    const oneMinusT = 1 - t;
    points.push({
      x: oneMinusT ** 3 * start.x
        + 3 * oneMinusT ** 2 * t * controlA.x
        + 3 * oneMinusT * t * t * controlB.x
        + t ** 3 * end.x,
      y: oneMinusT ** 3 * start.y
        + 3 * oneMinusT ** 2 * t * controlA.y
        + 3 * oneMinusT * t * t * controlB.y
        + t ** 3 * end.y,
    });
  }

  return points;
}

function pathCommandsToContours(commands: PathCommand[]): Point2D[][] {
  const contours: Point2D[][] = [];
  let currentContour: Point2D[] = [];
  let currentPoint: Point2D | null = null;
  let contourStart: Point2D | null = null;

  function closeContour(): void {
    const contour = normalizeContour(currentContour);
    if (contour) {
      contours.push(contour);
    }
    currentContour = [];
    contourStart = null;
  }

  for (const command of commands) {
    if (command.type === 'M') {
      closeContour();
      currentPoint = { x: command.x, y: command.y };
      contourStart = currentPoint;
      currentContour.push(currentPoint);
      continue;
    }

    if (!currentPoint) {
      continue;
    }

    if (command.type === 'L') {
      currentPoint = { x: command.x, y: command.y };
      currentContour.push(currentPoint);
      continue;
    }

    if (command.type === 'Q') {
      const endPoint = { x: command.x, y: command.y };
      currentContour.push(...sampleQuadraticCurve(
        currentPoint,
        { x: command.x1 ?? 0, y: command.y1 ?? 0 },
        endPoint,
        CURVE_SEGMENTS,
      ));
      currentPoint = endPoint;
      continue;
    }

    if (command.type === 'C') {
      const endPoint = { x: command.x, y: command.y };
      currentContour.push(...sampleCubicCurve(
        currentPoint,
        { x: command.x1 ?? 0, y: command.y1 ?? 0 },
        { x: command.x2 ?? 0, y: command.y2 ?? 0 },
        endPoint,
        CURVE_SEGMENTS,
      ));
      currentPoint = endPoint;
      continue;
    }

    if (command.type === 'Z') {
      if (contourStart) {
        currentContour.push(contourStart);
      }
      closeContour();
      currentPoint = null;
    }
  }

  closeContour();
  return contours;
}

/** A node in the contour tree built by buildContourTree(). */
export interface ContourNode {
  index: number;
  points: Point2D[];
  bounds: Rect2D;
  absoluteArea: number;
  parent: ContourNode | null;
  children: ContourNode[];
}

/** A shape with an outer ring and optional holes, produced by collectShapes(). */
export interface ContourShape {
  outer: Point2D[];
  holes: Point2D[][];
}

export function buildContourTree(contours: Point2D[][]): ContourNode[] {
  const nodes: ContourNode[] = contours.map((points, index) => ({
    index,
    points,
    bounds: polygonBounds(points),
    absoluteArea: Math.abs(signedArea(points)),
    parent: null,
    children: [],
  }));

  for (const node of nodes) {
    const samplePoint = node.points[0]!;
    let bestParent: ContourNode | null = null;

    for (const candidate of nodes) {
      if (candidate.index === node.index) {
        continue;
      }

      const containsPoint = samplePoint.x > candidate.bounds.minX
        && samplePoint.x < candidate.bounds.maxX
        && samplePoint.y > candidate.bounds.minY
        && samplePoint.y < candidate.bounds.maxY
        && pointInPolygon(samplePoint, candidate.points);

      if (!containsPoint) {
        continue;
      }

      if (!bestParent || candidate.absoluteArea < bestParent.absoluteArea) {
        bestParent = candidate;
      }
    }

    if (bestParent) {
      node.parent = bestParent;
      bestParent.children.push(node);
    }
  }

  return nodes;
}

export function collectShapes(nodes: ContourNode[]): ContourShape[] {
  const roots = nodes.filter(node => !node.parent);
  const shapes: ContourShape[] = [];

  function visit(node: ContourNode, depth: number): void {
    if (depth % 2 === 0) {
      shapes.push({
        outer: ensureCounterClockwise(node.points),
        holes: node.children.map(child => ensureClockwise(child.points)),
      });
    }

    for (const child of node.children) {
      visit(child, depth + 1);
    }
  }

  for (const root of roots) {
    visit(root, 0);
  }

  return shapes;
}

export function translateAndScaleContours(contours: Point2D[][], scale: number, offsetX: number, offsetY: number): Point2D[][] {
  return contours.map(contour => contour.map(point => ({
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  })));
}

export function flipContoursY(contours: Point2D[][]): Point2D[][] {
  return contours.map(contour => contour.map(point => ({
    x: point.x,
    y: -point.y,
  })));
}

export function translateAndScaleBounds(bounds: Rect2D, scale: number, offsetX: number, offsetY: number): Rect2D {
  return {
    minX: bounds.minX * scale + offsetX,
    minY: bounds.minY * scale + offsetY,
    maxX: bounds.maxX * scale + offsetX,
    maxY: bounds.maxY * scale + offsetY,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

function normalizeBoundsListToOrigin(boundsList: Rect2D[]): Rect2D[] {
  const combined = polygonBounds(boundsList.flatMap(bounds => [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
  ]));

  return boundsList.map(bounds => ({
    minX: bounds.minX - combined.minX,
    minY: bounds.minY - combined.minY,
    maxX: bounds.maxX - combined.minX,
    maxY: bounds.maxY - combined.minY,
    width: bounds.width,
    height: bounds.height,
  }));
}

export function computeTextBounds(contours: Point2D[][]): Rect2D {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const contour of contours) {
    const bounds = polygonBounds(contour);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function normalizeContoursToOrigin(contours: Point2D[][]): { contours: Point2D[][]; bounds: Rect2D } {
  const bounds = computeTextBounds(contours);
  return {
    contours: translateAndScaleContours(contours, 1, -bounds.minX, -bounds.minY),
    bounds: {
      minX: 0,
      minY: 0,
      maxX: bounds.width,
      maxY: bounds.height,
      width: bounds.width,
      height: bounds.height,
    },
  };
}

/** Result of measuring a single text line. */
export interface LineMeasurement {
  text: string;
  contours: Point2D[][];
  bounds: Rect2D;
}

export function measureLine(font: Font, line: string, cache: Map<string, LineMeasurement | null>): LineMeasurement | null {
  const cached = cache.get(line);
  if (cached !== undefined) {
    return cached;
  }

  const path = font.getPath(line, 0, 0, 1);
  const contours = flipContoursY(pathCommandsToContours(path.commands));
  if (!contours.length) {
    cache.set(line, null);
    return null;
  }

  const normalized = normalizeContoursToOrigin(contours);
  const result: LineMeasurement = {
    text: line,
    contours: normalized.contours,
    bounds: normalized.bounds,
  };
  cache.set(line, result);
  return result;
}

/** Result of building multiline contours. */
export interface MultilineContours {
  text: string;
  lines: string[];
  contours: Point2D[][];
  bounds: Rect2D;
  lineBounds: Rect2D[];
  averageLineHeight: number;
  maxLineWidth: number;
  minLineWidth: number;
  lineCount: number;
}

export function buildMultilineContours(lines: string[], font: Font, cache: Map<string, LineMeasurement | null>): MultilineContours | null {
  if (__perfCounters) { __perfCounters.buildMultilineContours++; }
  const measuredLines = lines.map(line => measureLine(font, line, cache));
  if (measuredLines.some(line => !line || line.bounds.width <= 0 || line.bounds.height <= 0)) {
    return null;
  }

  const validLines = measuredLines as LineMeasurement[];
  const maxWidth = Math.max(...validLines.map(line => line.bounds.width));
  const averageHeight = validLines.reduce((sum, line) => sum + line.bounds.height, 0) / validLines.length;
  const lineGap = averageHeight * 0.35;
  const contours: Point2D[][] = [];
  const lineBounds: Rect2D[] = [];
  const lineWidths = validLines.map(line => line.bounds.width);
  const lineOffsetsY: number[] = [];
  let totalHeight = 0;

  for (let index = 0; index < validLines.length; index += 1) {
    lineOffsetsY.push(totalHeight);
    totalHeight += validLines[index]!.bounds.height;
    if (index < validLines.length - 1) {
      totalHeight += lineGap;
    }
  }

  for (let index = 0; index < validLines.length; index += 1) {
    const line = validLines[index]!;
    const offsetX = (maxWidth - line.bounds.width) / 2;
    const offsetY = totalHeight - lineOffsetsY[index]! - line.bounds.height;
    contours.push(...translateAndScaleContours(line.contours, 1, offsetX, offsetY));
    lineBounds.push(translateAndScaleBounds(line.bounds, 1, offsetX, offsetY));
  }

  const normalized = normalizeContoursToOrigin(contours);

  return {
    text: lines.join('\n'),
    lines: [...lines],
    contours: normalized.contours,
    bounds: normalized.bounds,
    lineBounds: normalizeBoundsListToOrigin(lineBounds),
    averageLineHeight: averageHeight,
    maxLineWidth: Math.max(...lineWidths),
    minLineWidth: Math.min(...lineWidths),
    lineCount: validLines.length,
  };
}
