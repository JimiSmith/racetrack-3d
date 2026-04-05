import { BASE_THICKNESS_MM } from './model.js';

function hasExplicitTriangleSegments(model) {
  return Number.isInteger(model?.baseTriangleCount)
    && model.baseTriangleCount >= 0
    && model.baseTriangleCount <= (model?.triangles?.length ?? 0);
}

export function splitModelTriangles(model) {
  const triangles = model?.triangles ?? [];

  if (hasExplicitTriangleSegments(model)) {
    const baseEnd = model.baseTriangleCount;
    const secCount = model.secondaryTrackTriangleCount ?? 0;
    const secondaryEnd = baseEnd + secCount;
    // trackTriangles includes primary track + text (both rendered in the same red/primary colour).
    return {
      baseTriangles: triangles.slice(0, baseEnd),
      secondaryTrackTriangles: triangles.slice(baseEnd, secondaryEnd),
      trackTriangles: triangles.slice(secondaryEnd),
    };
  }

  const baseTriangles = [];
  const trackTriangles = [];

  for (const triangle of triangles) {
    if (triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)) {
      baseTriangles.push(triangle);
    } else {
      trackTriangles.push(triangle);
    }
  }

  return { baseTriangles, secondaryTrackTriangles: [], trackTriangles };
}
