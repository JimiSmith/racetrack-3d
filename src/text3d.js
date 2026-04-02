import earcut from 'earcut';
import opentype from 'opentype.js';

import { LABEL_FONT_BASE64 } from './label-font-data.js';

export const TEXT_HEIGHT_MM = 0.8;
export const TEXT_ORIENTATION_AUTO = 'auto';
export const TEXT_ORIENTATION_FIXED = 'fixed';
export const DEFAULT_TEXT_POSITION_RANK = 1;
const CURVE_SEGMENTS = 8;
const MIN_TEXT_HEIGHT_MM = 2;
const MIN_PREFERRED_HEIGHT_MM = 16 * 25.4 / 72;
const MAX_PREFERRED_HEIGHT_MM = 24 * 25.4 / 72;
const MAX_TEXT_LINES = 4;
const MAX_CANDIDATES = 16;
const MIN_CELL_MM = 3;
const MIN_GRID_CELLS_PER_SIDE = 8;
const LINE_COUNT_MULTIPLIERS = [1, 1, 0.94, 0.91];

let cachedFont = null;

function decodeBase64ToArrayBuffer(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    const bytes = Uint8Array.fromBase64(base64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  if (typeof Buffer === 'function') {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  throw new Error('No base64 decoder is available');
}

function getLabelFont(fontOverride = null) {
  if (fontOverride) {
    return fontOverride;
  }

  if (!cachedFont) {
    cachedFont = opentype.parse(decodeBase64ToArrayBuffer(LABEL_FONT_BASE64));
  }

  return cachedFont;
}

function createVertex(x, y, z) {
  return { x, y, z };
}

function addTriangle(triangles, a, b, c) {
  triangles.push([a, b, c]);
}

function addQuad(triangles, a, b, c, d) {
  addTriangle(triangles, a, b, c);
  addTriangle(triangles, a, c, d);
}

function signedArea(points) {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function ensureClockwise(points) {
  return signedArea(points) <= 0 ? points : [...points].reverse();
}

function ensureCounterClockwise(points) {
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

function polygonBounds(points) {
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

function pointInPolygon(point, polygon) {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const a = polygon[index];
    const b = polygon[previous];
    const intersects = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || Number.EPSILON) + a.x);

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

const SEGMENT_INTERSECTION_EPSILON = 1e-9;

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point, a, b) {
  const cross = orientation(a, b, point);
  if (Math.abs(cross) > SEGMENT_INTERSECTION_EPSILON) {
    return false;
  }

  return point.x >= Math.min(a.x, b.x) - SEGMENT_INTERSECTION_EPSILON
    && point.x <= Math.max(a.x, b.x) + SEGMENT_INTERSECTION_EPSILON
    && point.y >= Math.min(a.y, b.y) - SEGMENT_INTERSECTION_EPSILON
    && point.y <= Math.max(a.y, b.y) + SEGMENT_INTERSECTION_EPSILON;
}

function segmentsIntersect(a, b, c, d) {
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

function rectIntersectsPolygon(rect, polygon) {
  if (!polygon?.length) {
    return false;
  }

  const corners = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];

  if (corners.some(corner => pointInPolygon(corner, polygon))) {
    return true;
  }

  const rectangleEdges = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];

  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];

    for (const [rectA, rectB] of rectangleEdges) {
      if (segmentsIntersect(rectA, rectB, a, b)) {
        return true;
      }
    }
  }

  return false;
}

function rectFullyInsidePolygon(rect, polygon) {
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

function normalizeContour(points) {
  const contour = [];

  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      continue;
    }

    const previous = contour[contour.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      contour.push({ x: point.x, y: point.y });
    }
  }

  if (contour.length >= 2) {
    const first = contour[0];
    const last = contour[contour.length - 1];
    if (first.x === last.x && first.y === last.y) {
      contour.pop();
    }
  }

  return contour.length >= 3 ? contour : null;
}

function sampleQuadraticCurve(start, control, end, segments) {
  const points = [];

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

function sampleCubicCurve(start, controlA, controlB, end, segments) {
  const points = [];

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

function pathCommandsToContours(commands) {
  const contours = [];
  let currentContour = [];
  let currentPoint = null;
  let contourStart = null;

  function closeContour() {
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
        { x: command.x1, y: command.y1 },
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
        { x: command.x1, y: command.y1 },
        { x: command.x2, y: command.y2 },
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

function buildContourTree(contours) {
  const nodes = contours.map((points, index) => ({
    index,
    points,
    bounds: polygonBounds(points),
    absoluteArea: Math.abs(signedArea(points)),
    parent: null,
    children: [],
  }));

  for (const node of nodes) {
    const samplePoint = node.points[0];
    let bestParent = null;

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

function collectShapes(nodes) {
  const roots = nodes.filter(node => !node.parent);
  const shapes = [];

  function visit(node, depth) {
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

function triangulateShape(shape, minZ, maxZ) {
  const rings = [shape.outer, ...shape.holes];
  const flattened = [];
  const holeIndices = [];
  const vertices2d = [];

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
  const triangles = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];

    addTriangle(triangles, topVertices[a], topVertices[b], topVertices[c]);
    addTriangle(triangles, bottomVertices[c], bottomVertices[b], bottomVertices[a]);
  }

  let ringOffset = 0;
  for (const ring of rings) {
    const clockwise = signedArea(ring) < 0;

    for (let index = 0; index < ring.length; index += 1) {
      const current = ringOffset + index;
      const next = ringOffset + ((index + 1) % ring.length);
      if (clockwise) {
        addQuad(triangles, bottomVertices[next], bottomVertices[current], topVertices[current], topVertices[next]);
      } else {
        addQuad(triangles, bottomVertices[current], bottomVertices[next], topVertices[next], topVertices[current]);
      }
    }

    ringOffset += ring.length;
  }

  return triangles;
}

function translateAndScaleContours(contours, scale, offsetX, offsetY) {
  return contours.map(contour => contour.map(point => ({
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  })));
}

function flipContoursY(contours) {
  return contours.map(contour => contour.map(point => ({
    x: point.x,
    y: -point.y,
  })));
}

function computeOutlineBounds(points) {
  return polygonBounds(points?.outerRing ?? points);
}

function createScaledBounds(bounds, scale) {
  return {
    minX: bounds.minX * scale,
    minY: bounds.minY * scale,
    maxX: bounds.maxX * scale,
    maxY: bounds.maxY * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

function translateAndScaleBounds(bounds, scale, offsetX, offsetY) {
  return {
    minX: bounds.minX * scale + offsetX,
    minY: bounds.minY * scale + offsetY,
    maxX: bounds.maxX * scale + offsetX,
    maxY: bounds.maxY * scale + offsetY,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

function rotateBounds90(bounds) {
  return polygonBounds([
    { x: -bounds.minY, y: bounds.minX },
    { x: -bounds.minY, y: bounds.maxX },
    { x: -bounds.maxY, y: bounds.maxX },
    { x: -bounds.maxY, y: bounds.minX },
  ]);
}

function normalizeBoundsListToOrigin(boundsList) {
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

function scaleRing(points, scale) {
  return (points ?? []).map(point => ({
    x: point.x * scale,
    y: point.y * scale,
  }));
}

function scaleOutline(outlinePoints, scale) {
  return {
    outerRing: scaleRing(outlinePoints?.outerRing ?? outlinePoints ?? [], scale),
    holes: (outlinePoints?.holes ?? []).map(hole => scaleRing(hole, scale)),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeTextPositionRank(value) {
  const normalized = Math.trunc(Number(value));
  return Number.isFinite(normalized) && normalized >= 1 ? normalized : DEFAULT_TEXT_POSITION_RANK;
}

function createPlacementGrid(basePlate) {
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

function dilateBlockedCells(mask, radius) {
  if (radius <= 0) {
    return mask;
  }

  const rows = mask.length;
  const columns = mask[0]?.length ?? 0;
  const dilated = mask.map(row => [...row]);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!mask[row][column]) {
        continue;
      }

      for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
        for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
          const nextRow = row + deltaY;
          const nextColumn = column + deltaX;
          if (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < columns) {
            dilated[nextRow][nextColumn] = true;
          }
        }
      }
    }
  }

  return dilated;
}

function buildDistanceMap(mask) {
  const rows = mask.length;
  const columns = mask[0]?.length ?? 0;
  const distances = Array.from({ length: rows }, () => Array.from({ length: columns }, () => Infinity));
  const queue = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!mask[row][column]) {
        continue;
      }

      distances[row][column] = 0;
      queue.push([row, column]);
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const [row, column] = queue[index];
    const nextDistance = distances[row][column] + 1;

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

        if (nextDistance < distances[nextRow][nextColumn]) {
          distances[nextRow][nextColumn] = nextDistance;
          queue.push([nextRow, nextColumn]);
        }
      }
    }
  }

  return distances;
}

function computeCandidateTrackClearance(candidate, distanceMap) {
  let trackClearance = Infinity;

  for (let row = candidate.top; row <= candidate.bottom; row += 1) {
    for (let column = candidate.left; column <= candidate.right; column += 1) {
      trackClearance = Math.min(trackClearance, distanceMap[row]?.[column] ?? Infinity);
    }
  }

  return Number.isFinite(trackClearance) ? trackClearance : 0;
}

function computeCentreDistance(rect, basePlate) {
  const rectCenterX = rect.minX + rect.width / 2;
  const rectCenterY = rect.minY + rect.height / 2;
  const baseCenterX = basePlate.minX + basePlate.width / 2;
  const baseCenterY = basePlate.minY + basePlate.height / 2;
  const maxDistance = Math.hypot(basePlate.width / 2, basePlate.height / 2) || 1;
  return Math.min(1, Math.hypot(rectCenterX - baseCenterX, rectCenterY - baseCenterY) / maxDistance);
}

function computePlacementMask(outlinePoints, basePlate) {
  const grid = createPlacementGrid(basePlate);
  const mask = Array.from({ length: grid.rows }, () => Array.from({ length: grid.columns }, () => false));
  const outside = Array.from({ length: grid.rows }, () => Array.from({ length: grid.columns }, () => true));
  const hasOuterRing = outlinePoints?.outerRing?.length >= 3;
  const holes = outlinePoints?.holes ?? [];

  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      const minX = basePlate.minX + column * grid.cellWidth;
      const minY = basePlate.minY + row * grid.cellHeight;
      const x = minX + grid.cellWidth / 2;
      const y = minY + grid.cellHeight / 2;
      const rect = {
        minX,
        minY,
        maxX: minX + grid.cellWidth,
        maxY: minY + grid.cellHeight,
      };

      const intersectsOuterRing = rectIntersectsPolygon(rect, outlinePoints?.outerRing);
      const fullyInsideHole = intersectsOuterRing && holes.some(hole => hole.length >= 3 && rectFullyInsidePolygon(rect, hole));

      mask[row][column] = intersectsOuterRing && !fullyInsideHole;
      outside[row][column] = !hasOuterRing || !pointInPolygon({ x, y }, outlinePoints.outerRing);
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
        dilated[row][column] = true;
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

function buildPrefixSum(grid) {
  const rows = grid.length;
  const columns = grid[0]?.length ?? 0;
  const prefix = Array.from({ length: rows + 1 }, () => Array.from({ length: columns + 1 }, () => 0));

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      prefix[row + 1][column + 1] = (grid[row][column] ? 1 : 0)
        + prefix[row][column + 1]
        + prefix[row + 1][column]
        - prefix[row][column];
    }
  }

  return prefix;
}

function sumPrefixArea(prefix, left, top, right, bottom) {
  return prefix[bottom + 1][right + 1]
    - prefix[top][right + 1]
    - prefix[bottom + 1][left]
    + prefix[top][left];
}

function rectIntersectionArea(a, b) {
  const overlapWidth = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const overlapHeight = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return overlapWidth * overlapHeight;
}

function candidateToBounds(candidate, basePlate, grid) {
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

function dedupeCandidates(candidates, basePlate, grid, maxCandidates) {
  const deduped = [];

  for (const candidate of candidates) {
    const bounds = candidateToBounds(candidate, basePlate, grid);
    const area = bounds.width * bounds.height;
    if (area <= 0) {
      continue;
    }

    const duplicate = deduped.find(existing => {
      const intersection = rectIntersectionArea(bounds, existing.bounds);
      return intersection / Math.min(area, existing.area) > 0.9;
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

function findPlacementCandidates(basePlate, placementMask, maxCandidates = MAX_CANDIDATES) {
  const heights = Array.from({ length: placementMask.columns }, () => 0);
  const rectangles = [];
  const outsidePrefix = buildPrefixSum(placementMask.outside ?? []);
  const blockedDistanceMap = buildDistanceMap(placementMask.blockedBeforeDilation ?? placementMask.blocked ?? []);
  const maxTrackClearance = Math.max(placementMask.rows - 1, placementMask.columns - 1) || 1;

  for (let row = 0; row < placementMask.rows; row += 1) {
    for (let column = 0; column < placementMask.columns; column += 1) {
      heights[column] = placementMask.blocked[row][column] ? 0 : heights[column] + 1;
    }

    const stack = [];
    for (let column = 0; column <= placementMask.columns; column += 1) {
      const currentHeight = column < placementMask.columns ? heights[column] : 0;
      let start = column;

      while (stack.length && stack[stack.length - 1].height > currentHeight) {
        const item = stack.pop();
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

      if (!stack.length || stack[stack.length - 1].height < currentHeight) {
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

  return dedupeCandidates(rectangles, basePlate, placementMask, maxCandidates).map((candidate, index) => ({
    ...candidate,
    index,
    fractionOutside: candidate.fractionOutside ?? 0,
    trackClearance: candidate.trackClearance ?? 0,
    normalizedTrackClearance: Math.min(1, (candidate.trackClearance ?? 0) / maxTrackClearance),
    centreDistance: computeCentreDistance(candidate.bounds, basePlate),
  }));
}

function normalizeContoursToOrigin(contours) {
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

function rotateContours90(contours) {
  return contours.map(contour => contour.map(point => ({
    x: -point.y,
    y: point.x,
  })));
}

function createSequentialLineGrouping(words, breakpoints) {
  const lines = [];
  let start = 0;

  for (const breakpoint of [...breakpoints, words.length]) {
    const lineWords = words.slice(start, breakpoint);
    if (!lineWords.length) {
      return null;
    }
    lines.push(lineWords);
    start = breakpoint;
  }

  return lines;
}

function lineWordsToText(lineWords) {
  return lineWords.map(words => words.join(' '));
}

function createRenderedMultilineText(lines) {
  return lines.join('\n');
}

function enumerateSequentialLineGroupings(words, lineCount) {
  if (lineCount <= 1) {
    return [lineWordsToText([words])];
  }

  const groupings = [];

  function visit(nextIndex, chosen) {
    if (chosen.length === lineCount - 1) {
      const grouping = createSequentialLineGrouping(words, chosen);
      if (grouping) {
        groupings.push(lineWordsToText(grouping));
      }
      return;
    }

    const remainingBreaks = lineCount - 1 - chosen.length;
    for (let breakpoint = nextIndex; breakpoint <= words.length - remainingBreaks; breakpoint += 1) {
      visit(breakpoint + 1, [...chosen, breakpoint]);
    }
  }

  visit(1, []);
  return groupings;
}

export function __enumerateSequentialTextLineBreaks(text, lineCount) {
  const words = String(text).split(/\s+/u).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const maxLines = Math.min(MAX_TEXT_LINES, words.length);
  const targetLineCount = clamp(Math.trunc(Number(lineCount)) || 1, 1, maxLines);
  return enumerateSequentialLineGroupings(words, targetLineCount).map(createRenderedMultilineText);
}

function measureLine(font, line, cache) {
  const cached = cache.get(line);
  if (cached) {
    return cached;
  }

  const path = font.getPath(line, 0, 0, 1);
  const contours = flipContoursY(pathCommandsToContours(path.commands));
  if (!contours.length) {
    cache.set(line, null);
    return null;
  }

  const normalized = normalizeContoursToOrigin(contours);
  const result = {
    text: line,
    contours: normalized.contours,
    bounds: normalized.bounds,
  };
  cache.set(line, result);
  return result;
}

function buildMultilineContours(lines, font, cache) {
  const measuredLines = lines.map(line => measureLine(font, line, cache));
  if (measuredLines.some(line => !line || line.bounds.width <= 0 || line.bounds.height <= 0)) {
    return null;
  }

  const maxWidth = Math.max(...measuredLines.map(line => line.bounds.width));
  const averageHeight = measuredLines.reduce((sum, line) => sum + line.bounds.height, 0) / measuredLines.length;
  const lineGap = averageHeight * 0.35;
  const contours = [];
  const lineBounds = [];
  const lineWidths = measuredLines.map(line => line.bounds.width);
  const lineOffsetsY = [];
  let totalHeight = 0;

  for (let index = 0; index < measuredLines.length; index += 1) {
    lineOffsetsY.push(totalHeight);
    totalHeight += measuredLines[index].bounds.height;
    if (index < measuredLines.length - 1) {
      totalHeight += lineGap;
    }
  }

  for (let index = 0; index < measuredLines.length; index += 1) {
    const line = measuredLines[index];
    const offsetX = (maxWidth - line.bounds.width) / 2;
    const offsetY = totalHeight - lineOffsetsY[index] - line.bounds.height;
    contours.push(...translateAndScaleContours(line.contours, 1, offsetX, offsetY));
    lineBounds.push(translateAndScaleBounds(line.bounds, 1, offsetX, offsetY));
  }

  const normalized = normalizeContoursToOrigin(contours);

  return {
    text: createRenderedMultilineText(lines),
    lines: [...lines],
    contours: normalized.contours,
    bounds: normalized.bounds,
    lineBounds: normalizeBoundsListToOrigin(lineBounds),
    averageLineHeight: averageHeight,
    maxLineWidth: Math.max(...lineWidths),
    minLineWidth: Math.min(...lineWidths),
    lineCount: measuredLines.length,
  };
}

function computeSizeWindowMultiplier(heightMm) {
  if (heightMm <= MIN_TEXT_HEIGHT_MM) {
    return 0;
  }

  if (heightMm < MIN_PREFERRED_HEIGHT_MM) {
    const t = clamp(
      (heightMm - MIN_TEXT_HEIGHT_MM) / (MIN_PREFERRED_HEIGHT_MM - MIN_TEXT_HEIGHT_MM),
      0,
      1,
    );
    return t * t * t;
  }

  if (heightMm <= MAX_PREFERRED_HEIGHT_MM) {
    const t = (heightMm - MIN_PREFERRED_HEIGHT_MM) / (MAX_PREFERRED_HEIGHT_MM - MIN_PREFERRED_HEIGHT_MM);
    return 0.85 + 0.15 * clamp(t, 0, 1);
  }

  const excessRatio = (heightMm - MAX_PREFERRED_HEIGHT_MM) / MAX_PREFERRED_HEIGHT_MM;
  return 1 / (1 + excessRatio * 0.25);
}

function computeLineCountMultiplier(lineCount) {
  return LINE_COUNT_MULTIPLIERS[Math.min(Math.max(lineCount, 1), LINE_COUNT_MULTIPLIERS.length) - 1] ?? LINE_COUNT_MULTIPLIERS[LINE_COUNT_MULTIPLIERS.length - 1];
}

function computeTrackClearanceMultiplier(normalizedClearance) {
  return 0.97 + 0.03 * normalizedClearance;
}

function computeCentralityMultiplier(centreDistance) {
  return 1.0 - 0.12 * clamp(centreDistance, 0, 1);
}

function normalizeTextOrientationMode(value) {
  return value === TEXT_ORIENTATION_FIXED ? TEXT_ORIENTATION_FIXED : TEXT_ORIENTATION_AUTO;
}

function getTextRotationCandidates(textOrientationMode) {
  return normalizeTextOrientationMode(textOrientationMode) === TEXT_ORIENTATION_FIXED ? [0] : [0, 90];
}

function scoreTextFit(rect, layout, scaledBounds, candidate = {}) {
  const fittedWidth = scaledBounds.width;
  const fittedHeight = scaledBounds.height;
  const utilization = Math.min(1, (fittedWidth * fittedHeight) / Math.max(rect.width * rect.height, Number.EPSILON));
  const rectAspect = rect.width / Math.max(rect.height, Number.EPSILON);
  const layoutAspect = scaledBounds.width / Math.max(scaledBounds.height, Number.EPSILON);
  const aspectPenalty = 1 / (1 + Math.abs(Math.log(rectAspect / Math.max(layoutAspect, Number.EPSILON))));
  const lineBalance = layout.maxLineWidth > 0 ? layout.minLineWidth / layout.maxLineWidth : 1;
  const sizeWindowMultiplier = computeSizeWindowMultiplier(layout.averageLineHeight * layout.fittedScale);
  const outsideMultiplier = 0.5 + 0.5 * clamp(candidate.fractionOutside ?? 1, 0, 1);
  const trackClearanceMultiplier = computeTrackClearanceMultiplier(candidate.normalizedTrackClearance ?? 1);
  const centralityMultiplier = computeCentralityMultiplier(candidate.centreDistance ?? 0);

  return layout.averageLineHeight
    * Math.pow(utilization, 0.2)
    * aspectPenalty
    * lineBalance
    * outsideMultiplier
    * computeLineCountMultiplier(layout.lineCount)
    * sizeWindowMultiplier
    * trackClearanceMultiplier
    * centralityMultiplier;
}

export function __debugTextFitModifiers(heightMm, lineCount, fractionOutside = 1) {
  return {
    sizeWindowMultiplier: computeSizeWindowMultiplier(heightMm),
    lineCountMultiplier: computeLineCountMultiplier(lineCount),
    outsideMultiplier: 0.5 + 0.5 * clamp(fractionOutside, 0, 1),
  };
}

function fitTextToRectangle(text, font, rect, cache, textOrientationMode = TEXT_ORIENTATION_AUTO) {
  const words = String(text).split(/\s+/u).filter(Boolean);
  if (!words.length) {
    return [];
  }

  const layouts = [];
  const maxLines = Math.min(MAX_TEXT_LINES, words.length);

  for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
    const groupings = enumerateSequentialLineGroupings(words, lineCount);
    for (const grouping of groupings) {
      const multiline = buildMultilineContours(grouping, font, cache);
      if (!multiline || multiline.bounds.width <= 0 || multiline.bounds.height <= 0) {
        continue;
      }

      for (const rotation of getTextRotationCandidates(textOrientationMode)) {
        const oriented = rotation === 0
          ? multiline
          : {
            ...multiline,
            ...normalizeContoursToOrigin(rotateContours90(multiline.contours)),
            lineBounds: normalizeBoundsListToOrigin(multiline.lineBounds.map(rotateBounds90)),
          };
        const fittedScale = Math.min(
          rect.width / oriented.bounds.width,
          rect.height / oriented.bounds.height,
        );

        if (!Number.isFinite(fittedScale) || fittedScale * multiline.averageLineHeight < MIN_TEXT_HEIGHT_MM) {
          continue;
        }

        const fittedWidth = oriented.bounds.width * fittedScale;
        const fittedHeight = oriented.bounds.height * fittedScale;
        layouts.push({
          text: multiline.text,
          lines: multiline.lines,
          rotation,
          scale: fittedScale,
          bounds: oriented.bounds,
          contours: oriented.contours,
          lineBounds: oriented.lineBounds,
          fittedWidth,
          fittedHeight,
          averageLineHeight: multiline.averageLineHeight,
          maxLineWidth: multiline.maxLineWidth,
          minLineWidth: multiline.minLineWidth,
          lineCount: multiline.lineCount,
          fittedScale,
        });
      }
    }
  }

  return layouts;
}

function rankTextPlacements(text, font, candidates, textOrientationMode = TEXT_ORIENTATION_AUTO) {
  const cache = new Map();
  const ranked = [];

  candidates.forEach((candidate, candidateIndex) => {
    const fits = fitTextToRectangle(text, font, candidate.bounds, cache, textOrientationMode);
    const outsideMultiplier = 0.5 + 0.5 * clamp(candidate.fractionOutside ?? 1, 0, 1);
    for (let fitIndex = 0; fitIndex < fits.length; fitIndex += 1) {
      const layout = fits[fitIndex];
      const score = scoreTextFit(candidate.bounds, layout, candidate);

      ranked.push({
        candidate,
        candidateIndex,
        fitIndex,
        outsideMultiplier,
        layout: {
          ...layout,
          score,
        },
        score,
      });
    }
  });

  ranked.sort((a, b) => (
    b.outsideMultiplier - a.outsideMultiplier
      || b.score - a.score
      || a.candidateIndex - b.candidateIndex
      || a.fitIndex - b.fitIndex
  ));

  return ranked;
}

function computeTextPlacement(text, outlinePoints, basePlate, scale, options = {}) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return null;
  }

  const font = getLabelFont(options.font ?? null);
  const scaledOutline = scaleOutline(outlinePoints, scale);
  const scaledBasePlate = createScaledBounds(basePlate, scale);
  const placementMask = computePlacementMask(scaledOutline, scaledBasePlate);
  const candidates = findPlacementCandidates(scaledBasePlate, placementMask);
  if (!candidates.length) {
    return null;
  }

  const rankedPlacements = rankTextPlacements(
    normalizedText,
    font,
    candidates,
    options.textOrientationMode,
  );
  if (!rankedPlacements.length) {
    return null;
  }

  const placementRank = Math.min(
    normalizeTextPositionRank(options.textPositionRank) - 1,
    rankedPlacements.length - 1,
  );
  const selected = rankedPlacements[placementRank];
  const { candidate, candidateIndex, layout, score } = selected;
  const offsetX = candidate.bounds.minX + (candidate.bounds.width - layout.fittedWidth) / 2 - layout.bounds.minX * layout.scale;
  const offsetY = candidate.bounds.minY + (candidate.bounds.height - layout.fittedHeight) / 2 - layout.bounds.minY * layout.scale;
  const contours = translateAndScaleContours(layout.contours, layout.scale, offsetX, offsetY);
  const lineBounds = layout.lineBounds.map(bounds => translateAndScaleBounds(bounds, layout.scale, offsetX, offsetY));

  return {
    ...layout,
    score,
    candidate,
    candidateIndex,
    candidateCount: candidates.length,
    placementRank: placementRank + 1,
    placementCount: rankedPlacements.length,
    contours,
    lineBounds,
    normalizedText,
  };
}

export function __debugTextPlacement(text, outlinePoints, basePlate, scale, options = {}) {
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
  if (!placement) {
    return null;
  }

  return {
    text: placement.text,
    lines: [...placement.lines],
    lineBounds: placement.lineBounds.map(bounds => ({ ...bounds })),
    rotation: placement.rotation,
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

export function __debugPlacementCandidates(outlinePoints, basePlate, scale) {
  const scaledOutline = scaleOutline(outlinePoints, scale);
  const scaledBasePlate = createScaledBounds(basePlate, scale);
  const placementMask = computePlacementMask(scaledOutline, scaledBasePlate);
  return findPlacementCandidates(scaledBasePlate, placementMask);
}

function computeTextBounds(contours) {
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

export function buildTextMesh(text, outlinePoints, basePlate, scale, options = {}) {
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
  if (!placement?.contours?.length) {
    return [];
  }

  const shapes = collectShapes(buildContourTree(placement.contours));
  const minZ = options.baseThickness ?? 8;
  const maxZ = minZ + (options.textHeight ?? TEXT_HEIGHT_MM);

  return shapes.flatMap(shape => triangulateShape(shape, minZ, maxZ));
}
