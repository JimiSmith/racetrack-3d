import earcut from 'earcut';
import opentype from 'opentype.js';

import { LABEL_FONT_BASE64 } from './label-font-data.js';

export const TEXT_HEIGHT_MM = 0.8;
const CURVE_SEGMENTS = 8;
const MIN_INFIELD_WIDTH_METRES = 200;
const MIN_INFIELD_HEIGHT_METRES = 100;
const MIN_TEXT_HEIGHT_MM = 2;

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

function getPrimaryPlacement(outlinePoints, scale) {
  const holes = outlinePoints?.holes ?? [];
  if (!holes.length) {
    return null;
  }

  let bestHole = null;
  let bestArea = -Infinity;

  for (const hole of holes) {
    const area = Math.abs(signedArea(hole));
    if (area > bestArea) {
      bestArea = area;
      bestHole = hole;
    }
  }

  if (!bestHole) {
    return null;
  }

  const bounds = polygonBounds(bestHole);
  if (bounds.width < MIN_INFIELD_WIDTH_METRES || bounds.height < MIN_INFIELD_HEIGHT_METRES) {
    return null;
  }

  const scaledBounds = createScaledBounds(bounds, scale);
  const padding = Math.max(0.8, Math.min(scaledBounds.width, scaledBounds.height) * 0.08);

  return {
    minX: scaledBounds.minX + padding,
    minY: scaledBounds.minY + padding,
    width: Math.max(0, scaledBounds.width - padding * 2),
    height: Math.max(0, scaledBounds.height - padding * 2),
  };
}

function getFallbackPlacement(outlinePoints, basePlate, scale) {
  const baseBounds = createScaledBounds(basePlate, scale);
  const outlineBounds = createScaledBounds(computeOutlineBounds(outlinePoints), scale);
  const edgePadding = Math.max(1.5, Math.min(baseBounds.width, baseBounds.height) * 0.02);
  const availableWidth = Math.max(0, baseBounds.width * 0.45 - edgePadding * 2);
  const availableHeight = Math.max(
    0,
    Math.min(baseBounds.height * 0.16, Math.max(outlineBounds.minY - baseBounds.minY - edgePadding, 0) + baseBounds.height * 0.08),
  );

  return {
    minX: baseBounds.minX + edgePadding,
    minY: baseBounds.minY + edgePadding,
    width: availableWidth,
    height: Math.max(0, availableHeight - edgePadding),
  };
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
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return [];
  }

  const font = getLabelFont(options.font ?? null);
  const placement = getPrimaryPlacement(outlinePoints, scale) ?? getFallbackPlacement(outlinePoints, basePlate, scale);
  if (!placement || placement.width <= 0 || placement.height <= 0) {
    return [];
  }

  const path = font.getPath(normalizedText, 0, 0, 1);
  const contours = pathCommandsToContours(path.commands);
  if (!contours.length) {
    return [];
  }

  const textBounds = computeTextBounds(contours);
  if (textBounds.width <= 0 || textBounds.height <= 0) {
    return [];
  }

  const fittedScale = Math.min(placement.width / textBounds.width, placement.height / textBounds.height);
  if (!Number.isFinite(fittedScale) || fittedScale * textBounds.height < MIN_TEXT_HEIGHT_MM) {
    return [];
  }

  const fittedWidth = textBounds.width * fittedScale;
  const fittedHeight = textBounds.height * fittedScale;
  const offsetX = placement.minX + (placement.width - fittedWidth) / 2 - textBounds.minX * fittedScale;
  const offsetY = placement.minY + (placement.height - fittedHeight) / 2 - textBounds.minY * fittedScale;
  const positionedContours = translateAndScaleContours(contours, fittedScale, offsetX, offsetY);
  const shapes = collectShapes(buildContourTree(positionedContours));
  const minZ = options.baseThickness ?? 8;
  const maxZ = minZ + (options.textHeight ?? TEXT_HEIGHT_MM);

  return shapes.flatMap(shape => triangulateShape(shape, minZ, maxZ));
}
