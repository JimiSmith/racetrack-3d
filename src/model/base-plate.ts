import earcut from 'earcut';
import type { Triangle, BasePlate } from '../types/model.js';
import type { Point2D } from '../types/geometry.js';
import { createVertex, addTriangle, addQuad } from './mesh-primitives.js';

export const BASE_THICKNESS_MM = 2.5;
export const BASE_CORNER_RADIUS_MM = 3;
export const BASE_CORNER_SEGMENTS_PER_CORNER = 8;
export const TARGET_MAX_SIZE_MM = 200; // fit model within this bounding box dimension

// Compute a scale factor so the outline fits within TARGET_MAX_SIZE_MM
export function computeScale(basePlate: Pick<BasePlate, 'width' | 'height'>): number {
  const longestSide = Math.max(basePlate.width, basePlate.height); // metres
  if (longestSide <= 0) { return 1; }
  return TARGET_MAX_SIZE_MM / longestSide;
}

export function appendRoundedArc(
  points: Point2D[],
  centerX: number,
  centerY: number,
  radiusMm: number,
  startAngleDeg: number,
  endAngleDeg: number,
  segments: number,
): void {
  const step = (endAngleDeg - startAngleDeg) / segments;

  for (let index = 1; index <= segments; index += 1) {
    const angle = ((startAngleDeg + step * index) * Math.PI) / 180;
    points.push({
      x: centerX + Math.cos(angle) * radiusMm,
      y: centerY + Math.sin(angle) * radiusMm,
    });
  }
}

export function buildRoundedRectangleRing(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  radiusMm: number,
  segmentsPerCorner: number,
): Point2D[] {
  const ring: Point2D[] = [];

  ring.push({ x: minX + radiusMm, y: minY });
  ring.push({ x: maxX - radiusMm, y: minY });
  appendRoundedArc(ring, maxX - radiusMm, minY + radiusMm, radiusMm, 270, 360, segmentsPerCorner);
  ring.push({ x: maxX, y: maxY - radiusMm });
  appendRoundedArc(ring, maxX - radiusMm, maxY - radiusMm, radiusMm, 0, 90, segmentsPerCorner);
  ring.push({ x: minX + radiusMm, y: maxY });
  appendRoundedArc(ring, minX + radiusMm, maxY - radiusMm, radiusMm, 90, 180, segmentsPerCorner);
  ring.push({ x: minX, y: minY + radiusMm });
  appendRoundedArc(ring, minX + radiusMm, minY + radiusMm, radiusMm, 180, 270, segmentsPerCorner);

  return ring;
}

export function buildBasePlateMesh(basePlate: BasePlate, scale: number): Triangle[] {
  if (!basePlate) {
    throw new Error('Base plate dimensions are missing');
  }

  const minX = basePlate.minX * scale;
  const maxX = basePlate.maxX * scale;
  const minY = basePlate.minY * scale;
  const maxY = basePlate.maxY * scale;
  const minZ = 0;
  const maxZ = BASE_THICKNESS_MM;
  const radiusMm = Math.min(BASE_CORNER_RADIUS_MM, (maxX - minX) / 2, (maxY - minY) / 2);

  if (radiusMm <= 0) {
    const v000 = createVertex(minX, minY, minZ);
    const v100 = createVertex(maxX, minY, minZ);
    const v110 = createVertex(maxX, maxY, minZ);
    const v010 = createVertex(minX, maxY, minZ);
    const v001 = createVertex(minX, minY, maxZ);
    const v101 = createVertex(maxX, minY, maxZ);
    const v111 = createVertex(maxX, maxY, maxZ);
    const v011 = createVertex(minX, maxY, maxZ);
    const triangles: Triangle[] = [];

    addQuad(triangles, v001, v101, v111, v011);
    addQuad(triangles, v000, v010, v110, v100);
    addQuad(triangles, v000, v100, v101, v001);
    addQuad(triangles, v100, v110, v111, v101);
    addQuad(triangles, v110, v010, v011, v111);
    addQuad(triangles, v010, v000, v001, v011);

    return triangles;
  }

  const ring = buildRoundedRectangleRing(
    minX,
    maxX,
    minY,
    maxY,
    radiusMm,
    BASE_CORNER_SEGMENTS_PER_CORNER,
  );
  const flattened: number[] = [];

  for (const point of ring) {
    flattened.push(point.x, point.y);
  }

  const indices = earcut(flattened);
  const bottom = ring.map(point => createVertex(point.x, point.y, minZ));
  const top = ring.map(point => createVertex(point.x, point.y, maxZ));
  const triangles: Triangle[] = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]!;
    const b = indices[index + 1]!;
    const c = indices[index + 2]!;
    addTriangle(triangles, top[a]!, top[b]!, top[c]!);
    addTriangle(triangles, bottom[c]!, bottom[b]!, bottom[a]!);
  }

  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    addQuad(triangles, bottom[index]!, bottom[next]!, top[next]!, top[index]!);
  }

  return triangles;
}
