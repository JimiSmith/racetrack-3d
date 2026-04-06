import type { Vertex, Triangle } from '../types/model.js';
import type { Point2D } from '../types/geometry.js';

export function createVertex(x: number, y: number, z: number): Vertex {
  return { x, y, z };
}

export function addTriangle(triangles: Triangle[], a: Vertex, b: Vertex, c: Vertex): void {
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
