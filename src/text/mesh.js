import earcut from 'earcut';

import { buildContourTree, collectShapes, translateAndScaleContours, translateAndScaleBounds } from './contours.js';

export const TEXT_HEIGHT_MM = 0.8;
export const DEFAULT_TEXT_POSITION_RANK = 1;
const MIN_TEXT_HEIGHT_MM = 2;

// Keep MIN_TEXT_HEIGHT_MM accessible (used in tests and debug)
export { MIN_TEXT_HEIGHT_MM };

export function normalizeTextPositionRank(value) {
  const normalized = Math.trunc(Number(value));
  return Number.isFinite(normalized) && normalized >= 1 ? normalized : DEFAULT_TEXT_POSITION_RANK;
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

export function selectAndExpandPlacement(rankedResult, options = {}) {
  if (!rankedResult?.placements?.length) {
    return null;
  }

  const { placements, candidates } = rankedResult;
  const placementRank = Math.min(
    normalizeTextPositionRank(options.textPositionRank) - 1,
    placements.length - 1,
  );
  const selected = placements[placementRank];
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
    placementCount: placements.length,
    contours,
    lineBounds,
  };
}

export function buildTextMeshFromRankedPlacements(rankedResult, options = {}) {
  const expanded = selectAndExpandPlacement(rankedResult, options);
  if (!expanded?.contours?.length) {
    return [];
  }

  const shapes = collectShapes(buildContourTree(expanded.contours));
  const minZ = options.baseThickness ?? 8;
  const maxZ = minZ + (options.textHeight ?? TEXT_HEIGHT_MM);

  return shapes.flatMap(shape => triangulateShape(shape, minZ, maxZ));
}
