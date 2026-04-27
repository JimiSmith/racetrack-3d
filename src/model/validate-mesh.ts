/**
 * Mesh validation utilities — used by tests and offline diagnostics to verify
 * that the model.triangles list serialised by the export pipeline forms a
 * 2-manifold mesh (every edge shared by exactly 2 triangles, no degenerate
 * triangles).
 *
 * Quantization matches `formatCoordinate` in src/export/threemf.ts so the
 * validator measures the mesh as Bambu Studio sees it after vertex dedup.
 */

import type { Triangle, Vertex } from '../types/model.js';

/** 4-decimal quantization, matching `formatCoordinate` in src/export/threemf.ts. */
const DEFAULT_PRECISION_MM = 1e-4;
/** Triangles with cross-product magnitude below this (in mm²) are considered degenerate. */
const DEFAULT_AREA_TOLERANCE_MM2 = 1e-6;

function quantize(value: number, precision: number): number {
  return Math.round(value / precision) * precision;
}

function vertexKey(v: Vertex, precision: number): string {
  return `${quantize(v.x, precision)},${quantize(v.y, precision)},${quantize(v.z, precision)}`;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function triangleArea(a: Vertex, b: Vertex, c: Vertex): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return Math.hypot(nx, ny, nz) / 2;
}

export interface NonManifoldEdge {
  /** The two endpoints, quantized. */
  a: Vertex;
  b: Vertex;
  /** Indices into the triangles array that contain this edge. */
  triangleIndices: number[];
}

export interface ValidateOptions {
  precisionMm?: number;
  areaToleranceMm2?: number;
}

/**
 * Returns every edge whose triangle-incidence count is not exactly 2.
 * Edges with count 1 are open boundaries; edges with count >= 3 indicate
 * shared internal faces or T-junctions.
 */
export function findNonManifoldEdges(
  triangles: Triangle[],
  options: ValidateOptions = {},
): NonManifoldEdge[] {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const incidence = new Map<string, { a: Vertex; b: Vertex; indices: number[] }>();

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex]!;
    const keys = tri.map(v => vertexKey(v, precision)) as [string, string, string];
    for (let edge = 0; edge < 3; edge += 1) {
      const ka = keys[edge]!;
      const kb = keys[(edge + 1) % 3]!;
      if (ka === kb) {
        continue; // degenerate edge — handled by findDegenerateTriangles
      }
      const key = edgeKey(ka, kb);
      const existing = incidence.get(key);
      if (existing) {
        existing.indices.push(triIndex);
      } else {
        incidence.set(key, {
          a: tri[edge]!,
          b: tri[(edge + 1) % 3]!,
          indices: [triIndex],
        });
      }
    }
  }

  const result: NonManifoldEdge[] = [];
  for (const { a, b, indices } of incidence.values()) {
    if (indices.length !== 2) {
      result.push({ a, b, triangleIndices: indices });
    }
  }
  return result;
}

/**
 * Returns indices of triangles whose quantized cross-product area is below
 * the tolerance — collapsed slivers that confuse slicer mesh checkers.
 */
export function findDegenerateTriangles(
  triangles: Triangle[],
  options: ValidateOptions = {},
): number[] {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const tolerance = options.areaToleranceMm2 ?? DEFAULT_AREA_TOLERANCE_MM2;
  const result: number[] = [];

  for (let i = 0; i < triangles.length; i += 1) {
    const [a, b, c] = triangles[i]!;
    const qa = { x: quantize(a.x, precision), y: quantize(a.y, precision), z: quantize(a.z, precision) };
    const qb = { x: quantize(b.x, precision), y: quantize(b.y, precision), z: quantize(b.z, precision) };
    const qc = { x: quantize(c.x, precision), y: quantize(c.y, precision), z: quantize(c.z, precision) };
    if (triangleArea(qa, qb, qc) < tolerance) {
      result.push(i);
    }
  }
  return result;
}

export interface MeshSummary {
  triangleCount: number;
  uniqueVertexCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
}

export function summarizeMesh(triangles: Triangle[], options: ValidateOptions = {}): MeshSummary {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const uniqueVertices = new Set<string>();
  for (const tri of triangles) {
    for (const v of tri) {
      uniqueVertices.add(vertexKey(v, precision));
    }
  }
  return {
    triangleCount: triangles.length,
    uniqueVertexCount: uniqueVertices.size,
    nonManifoldEdgeCount: findNonManifoldEdges(triangles, options).length,
    degenerateTriangleCount: findDegenerateTriangles(triangles, options).length,
  };
}
