/**
 * Mesh validation utilities — used by tests and offline diagnostics to verify
 * that the model.triangles list serialised by the export pipeline forms a
 * 2-manifold mesh (every edge shared by exactly 2 triangles, no degenerate
 * triangles).
 *
 * Quantization matches `formatCoordinate` in src/export/threemf.ts so the
 * validator measures the mesh as Bambu Studio sees it after vertex dedup.
 */

import type { Triangle, TrackModel, Vertex } from '../types/model.js';
import {
  DEFAULT_PRECISION_MM,
  edgeKey,
  quantize,
  vertexKey,
  type ValidateOptions,
} from './validate-mesh-primitives.js';
import {
  findFlippedAdjacentFaces,
  findSelfIntersectingTriangles,
  findShellComponents,
  findOpenShellComponentCount,
  type SelfIntersection,
} from './mesh-detectors.js';
import { splitModelTriangles } from './triangle-groups.js';

// Re-export the shared primitives so existing import paths
// (`import { DEFAULT_PRECISION_MM, ValidateOptions } from '.../validate-mesh.js'`)
// keep working unchanged after the §6 module split.
export { DEFAULT_PRECISION_MM };
export type { ValidateOptions };
// Re-export the #115 detectors + types so consumers can import them from the
// validator module exactly as the issue phrases it.
export { findFlippedAdjacentFaces, findSelfIntersectingTriangles, findShellComponents, findOpenShellComponentCount };
export type { SelfIntersection };

/** Triangles with cross-product magnitude below this (in mm²) are considered degenerate. */
const DEFAULT_AREA_TOLERANCE_MM2 = 1e-6;
/**
 * Perpendicular distance (mm) within which a vertex is treated as lying ON an
 * edge for T-junction detection. Deliberately equal to `DEFAULT_PRECISION_MM`:
 * a vertex is "on the line" exactly when it sits within one quantization grid
 * step of the edge.
 */
export const DEFAULT_TJUNCTION_TOLERANCE_MM = 1e-4;

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

/**
 * A T-junction: vertex `V` lying in the INTERIOR of an edge `(a,b)` of another
 * triangle, sharing no endpoint topologically (quantized) with that edge. The
 * mesh stays 2-manifold by edge-incidence count, so `findNonManifoldEdges`
 * cannot see this, yet slicers (Bambu Studio / PrusaSlicer) flag it.
 */
export interface TJunction {
  /** The interior vertex (raw coordinates). */
  vertex: Vertex;
  /** The edge whose interior `vertex` lies on (raw coordinates). */
  edge: { a: Vertex; b: Vertex };
  /** Index of the triangle that owns the offending edge. */
  triangleIndex: number;
  /** Perpendicular distance (mm) from `vertex` to the edge line. */
  perpendicularDistance: number;
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

/** Edge record stored in the uniform XY grid for T-junction detection. */
interface GridEdge {
  a: Vertex;
  b: Vertex;
  qaKey: string;
  qbKey: string;
  triangleIndex: number;
}

/**
 * Detects T-junctions: vertices lying in the interior of another triangle's edge.
 *
 * Backed by a uniform XY-plane grid spatial index. These meshes are prismatic
 * (Z is a small set of discrete levels), so binning on XY is the discriminating
 * axis. The `t` projection, perpendicular distance, and endpoint-radius math are
 * all full 3D, so XY-only binning only OVER-collects candidates across Z levels;
 * the 3D distance term rejects the over-collected cross-level pairs.
 *
 * Predicate — a vertex `V` is a T-junction of edge `(A,B)` iff ALL hold (identity
 * tests use quantized coords; the t/distance/radius math uses raw coords):
 *  - quantized-key inequality `qV != qA` and `qV != qB` (no shared endpoint),
 *  - absolute endpoint radius `|V-A| > precisionMm` and `|V-B| > precisionMm`,
 *  - non-degenerate edge (`|B-A| > 0` after quantization),
 *  - interior projection `t = dot(V-A, B-A)/dot(B-A, B-A)` strictly in `(0, 1)`,
 *  - perpendicular distance `d = |(V-A) - t*(B-A)| <= toleranceMm`.
 */
export function findTJunctions(
  triangles: Triangle[],
  options: ValidateOptions = {},
): TJunction[] {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const tolerance = options.toleranceMm ?? DEFAULT_TJUNCTION_TOLERANCE_MM;
  const cell = Math.max(tolerance, 0.5);

  const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;
  const grid = new Map<string, GridEdge[]>();

  // Unique representative raw vertex per quantized key (first seen).
  const uniqueVertices = new Map<string, Vertex>();

  // Deduplicate physical edges by quantized edge-key, keeping the lowest
  // triangleIndex that owns the edge (so emission is deterministic).
  const edges = new Map<string, GridEdge>();
  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex]!;
    const keys = tri.map(v => vertexKey(v, precision)) as [string, string, string];
    for (let v = 0; v < 3; v += 1) {
      if (!uniqueVertices.has(keys[v]!)) {
        uniqueVertices.set(keys[v]!, tri[v]!);
      }
    }
    for (let e = 0; e < 3; e += 1) {
      const ka = keys[e]!;
      const kb = keys[(e + 1) % 3]!;
      if (ka === kb) {
        continue; // degenerate edge — owned by findDegenerateTriangles
      }
      const ek = edgeKey(ka, kb);
      if (!edges.has(ek)) {
        edges.set(ek, { a: tri[e]!, b: tri[(e + 1) % 3]!, qaKey: ka, qbKey: kb, triangleIndex: triIndex });
      }
    }
  }

  // Insert each unique edge into every cell its tol-expanded XY bbox covers.
  for (const record of edges.values()) {
    const { a, b } = record;
    const cx0 = Math.floor((Math.min(a.x, b.x) - tolerance) / cell);
    const cx1 = Math.floor((Math.max(a.x, b.x) + tolerance) / cell);
    const cy0 = Math.floor((Math.min(a.y, b.y) - tolerance) / cell);
    const cy1 = Math.floor((Math.max(a.y, b.y) + tolerance) / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) {
          bucket.push(record);
        } else {
          grid.set(key, [record]);
        }
      }
    }
  }

  const tol2 = tolerance * tolerance;
  const precision2 = precision * precision;
  const emitted = new Set<string>();
  const result: TJunction[] = [];

  for (const [qV, V] of uniqueVertices) {
    const cx = Math.floor(V.x / cell);
    const cy = Math.floor(V.y / cell);
    const bucket = grid.get(cellKey(cx, cy));
    if (!bucket) {
      continue;
    }
    for (const edge of bucket) {
      if (qV === edge.qaKey || qV === edge.qbKey) {
        continue; // shares an endpoint with the edge
      }
      const { a, b } = edge;
      const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
      const len2 = bax * bax + bay * bay + baz * baz;
      if (len2 === 0) {
        continue; // zero-length edge
      }
      const vax = V.x - a.x, vay = V.y - a.y, vaz = V.z - a.z;
      // Absolute endpoint radius (raw 3D coords).
      const distA2 = vax * vax + vay * vay + vaz * vaz;
      if (distA2 <= precision2) {
        continue;
      }
      const vbx = V.x - b.x, vby = V.y - b.y, vbz = V.z - b.z;
      const distB2 = vbx * vbx + vby * vby + vbz * vbz;
      if (distB2 <= precision2) {
        continue;
      }
      const t = (vax * bax + vay * bay + vaz * baz) / len2;
      if (!(t > 0 && t < 1)) {
        continue; // not strictly interior
      }
      const px = vax - t * bax, py = vay - t * bay, pz = vaz - t * baz;
      const d2 = px * px + py * py + pz * pz;
      if (d2 > tol2) {
        continue;
      }
      const ek = edgeKey(edge.qaKey, edge.qbKey);
      const pairKey = `${qV}#${ek}`;
      if (emitted.has(pairKey)) {
        continue;
      }
      emitted.add(pairKey);
      result.push({
        vertex: V,
        edge: { a, b },
        triangleIndex: edge.triangleIndex,
        perpendicularDistance: Math.sqrt(d2),
      });
    }
  }

  return result;
}

export interface MeshSummary {
  triangleCount: number;
  uniqueVertexCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
  tJunctionCount: number;
  /** #115: total self-intersecting pairs (true 3D crossers + coplanar laminations). */
  selfIntersectionCount: number;
  /** #115: adjacent face pairs with flipped (same-direction) shared-edge winding. */
  flippedFaceCount: number;
  /** #115: connected shell components by shared-edge adjacency. */
  componentCount: number;
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
    tJunctionCount: findTJunctions(triangles, options).length,
    selfIntersectionCount: findSelfIntersectingTriangles(triangles, options).length,
    flippedFaceCount: findFlippedAdjacentFaces(triangles, options).length,
    componentCount: findShellComponents(triangles, options).length,
  };
}

export interface PartReport {
  /** Logical part name. 'track' = primary track + embossed text (same exported object). */
  part: 'base' | 'secondary' | 'track';
  triangleCount: number;
  nonManifoldEdges: NonManifoldEdge[];
  degenerateTriangles: number[];
  /** T-junctions (#109): interior-of-edge vertices. NOT folded into `ModelReport.ok`. */
  tJunctions: TJunction[];
  /** #115: self-intersecting triangle pairs (3D crossers + coplanar laminations, tagged
   *  via `kind`). NOT folded into `ModelReport.ok`. */
  selfIntersections: SelfIntersection[];
  /** #115: adjacent face pairs with flipped (same-direction) shared-edge winding.
   *  NOT folded into `ModelReport.ok`. */
  flippedFaces: Array<{ triangleA: number; triangleB: number; sharedEdge: { a: Vertex; b: Vertex } }>;
  /** #115: count of disjoint shell components (`findShellComponents(triangles).length`).
   *  A healthy single shell is 1; >1 indicates disjoint shells. An empty part is 0.
   *  NOT folded into `ModelReport.ok`. */
  shellComponentCount: number;
  /** #133: count of shell components that are NOT closed 2-manifolds (have at least
   *  one boundary/non-manifold edge). A part may legitimately contain several disjoint
   *  but individually-watertight shells (the track ribbon + disconnected text glyph
   *  solids), so the meaningful "fragmented soup" defect is `openShellComponentCount > 0`,
   *  not `shellComponentCount > 1`. An empty part is 0. NOT folded into `ModelReport.ok`. */
  openShellComponentCount: number;
}

export interface ModelReport {
  /** True iff every part is 2-manifold AND free of degenerate triangles. T-junctions (#109) are
   *  deliberately NOT folded in — they are a separate measurement consumed via the test helper's
   *  `failOn`. Pure data report; the decision of what to ASSERT on lives in the test helper, not here. */
  ok: boolean;
  parts: PartReport[];
}

/**
 * Splits a model into its per-part triangle groups (base / secondary / track)
 * and composes the existing manifold + degenerate detectors into a structured
 * report. Pure data: it always computes both detectors for every part and never
 * decides what callers should fail on — that decision lives in the test helper.
 *
 * `parts` always contains exactly three entries in the fixed order
 * `base`, `secondary`, `track`; empty parts are included with zero findings and
 * therefore never make `ok` false.
 */
export function validateModel(
  model: TrackModel,
  options: ValidateOptions = {},
): ModelReport {
  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);

  const buildPart = (part: PartReport['part'], triangles: Triangle[]): PartReport => ({
    part,
    triangleCount: triangles.length,
    nonManifoldEdges: findNonManifoldEdges(triangles, options),
    degenerateTriangles: findDegenerateTriangles(triangles, options),
    tJunctions: findTJunctions(triangles, options),
    selfIntersections: findSelfIntersectingTriangles(triangles, options),
    flippedFaces: findFlippedAdjacentFaces(triangles, options),
    shellComponentCount: findShellComponents(triangles, options).length,
    openShellComponentCount: findOpenShellComponentCount(triangles, options),
  });

  const parts: PartReport[] = [
    buildPart('base', baseTriangles),
    buildPart('secondary', secondaryTrackTriangles),
    buildPart('track', trackTriangles),
  ];

  const ok = parts.every(
    p => p.nonManifoldEdges.length === 0 && p.degenerateTriangles.length === 0,
  );

  return { ok, parts };
}
