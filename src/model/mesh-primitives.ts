import type { Vertex, Triangle } from '../types/model.js';
import type { Point2D } from '../types/geometry.js';

export function createVertex(x: number, y: number, z: number): Vertex {
  return { x, y, z };
}

/**
 * Quantization grid (mm). Matches the 4-decimal precision in
 * `formatCoordinate` (src/export/threemf.ts) so we only filter triangles
 * that genuinely collapse after the export's vertex dedup.
 */
const DEGENERATE_QUANTIZATION_MM = 1e-4;

function quantize(value: number): number {
  return Math.round(value / DEGENERATE_QUANTIZATION_MM) * DEGENERATE_QUANTIZATION_MM;
}

/**
 * Returns true only when two of the triangle's vertices collapse to the same
 * point under the 3MF's 1e-4 mm vertex dedup. This is the exact condition for a
 * triangle to disappear on export and leave a non-manifold boundary.
 *
 * This is intentionally coincidence-only, *not* area-based: a thin but distinct
 * sliver — three collinear-looking yet separate vertices — still contributes
 * its edges to the mesh's edge-pairing. Dropping such triangles (as an
 * area < tolerance test would) opens holes in the ribbon and pocket meshes,
 * which is exactly the failure an STL area-filter previously introduced. So
 * collinear-but-distinct triangles are deliberately kept; only genuine
 * coincident-vertex collapses are removed.
 *
 * This is the single degeneracy definition shared by the STL and 3MF writers,
 * so both agree on which triangles disappear. (The mesh validator's separate
 * area-based `findDegenerateTriangles` is a stricter diagnostic, not an export
 * filter.)
 */
export function isDegenerateTriangle(a: Vertex, b: Vertex, c: Vertex): boolean {
  const ax = quantize(a.x), ay = quantize(a.y), az = quantize(a.z);
  const bx = quantize(b.x), by = quantize(b.y), bz = quantize(b.z);
  const cx = quantize(c.x), cy = quantize(c.y), cz = quantize(c.z);
  return (
    (ax === bx && ay === by && az === bz) ||
    (bx === cx && by === cy && bz === cz) ||
    (ax === cx && ay === cy && az === cz)
  );
}

export function addTriangle(triangles: Triangle[], a: Vertex, b: Vertex, c: Vertex): void {
  if (isDegenerateTriangle(a, b, c)) {
    return;
  }
  triangles.push([a, b, c]);
}

export function addQuad(triangles: Triangle[], a: Vertex, b: Vertex, c: Vertex, d: Vertex): void {
  addTriangle(triangles, a, b, c);
  addTriangle(triangles, a, c, d);
}

export function normalizeRing(points: Point2D[] | null | undefined): Point2D[] {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('Outline must contain at least three points');
  }

  const ring: Point2D[] = [];

  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      continue;
    }

    const previous = ring[ring.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      continue;
    }

    ring.push({ x: point.x, y: point.y });
  }

  if (ring.length < 3) {
    throw new Error('Outline must contain at least three unique points');
  }

  const first = ring[0]!;
  const last = ring[ring.length - 1]!;

  if (first.x === last.x && first.y === last.y) {
    ring.pop();
  }

  if (ring.length < 3) {
    throw new Error('Outline must contain at least three unique points');
  }

  return ring;
}

export function signedArea(points: Point2D[]): number {
  let area = 0;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

export function ensureCounterClockwise(points: Point2D[]): Point2D[] {
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

export function normalizeVector(dx: number, dy: number): { x: number; y: number } | null {
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return null;
  }

  return { x: dx / length, y: dy / length };
}
