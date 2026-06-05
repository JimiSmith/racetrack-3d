/**
 * Slicer-style mesh defect detectors (#115): self-intersecting triangles,
 * flipped-winding adjacent faces, and disjoint shell components.
 *
 * Split out of `validate-mesh.ts` (already over the 300-line soft budget) so the
 * heavier geometry — the Möller 1997 triangle-triangle predicate, the 2D SAT
 * coplanar overlap test, and union-find — does not bloat the validator. Imports the
 * shared quantization primitives from `validate-mesh-primitives.ts`; `validate-mesh.ts`
 * re-exports everything here so existing import paths keep working unchanged.
 *
 * These are MEASUREMENT-ONLY detectors; they never modify geometry.
 */

import type { Triangle, Vertex } from '../types/model.js';
import {
  DEFAULT_PRECISION_MM,
  edgeKey,
  vertexKey,
  type ValidateOptions,
} from './validate-mesh-primitives.js';

// ── Detector 1 — self-intersecting triangles ──────────────────────────────────

export interface SelfIntersection {
  triangleA: number;
  triangleB: number;
  /** Discriminator (additive to the issue's `{ triangleA, triangleB }` shape; see plan
   *  §4f). 'crossing' = true 3D interior cross; 'coplanar' = same-plane area-overlapping
   *  lamination. Lets consumers split true crossers from coplanar laminations without a
   *  second detector pass. */
  kind: 'crossing' | 'coplanar';
}

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function sub(a: Vertex, b: Vertex): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3, b: Vertex): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** The three quantized vertex keys of a triangle. */
function triKeys(tri: Triangle, precision: number): [string, string, string] {
  return [
    vertexKey(tri[0], precision),
    vertexKey(tri[1], precision),
    vertexKey(tri[2], precision),
  ];
}

/** Count how many quantized vertex keys two triangles share. 2+ => full shared edge. */
function sharedKeyCount(a: [string, string, string], b: [string, string, string]): number {
  let n = 0;
  for (const ka of a) {
    if (b.includes(ka)) {
      n += 1;
    }
  }
  return n;
}

/** Largest-magnitude component index of a vector (Möller projection axis). */
function dominantAxis(v: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) {
    return 0;
  }
  return ay >= az ? 1 : 2;
}

function component(v: Vertex, axis: 0 | 1 | 2): number {
  return axis === 0 ? v.x : axis === 1 ? v.y : v.z;
}

/**
 * Computes the parametric interval `[min,max]` along projection axis `axis` where
 * triangle `(p0,p1,p2)` crosses the other triangle's plane, given the signed
 * distances `d0,d1,d2` of its three vertices to that plane (callers must NOT pass an
 * all-same-sign triangle — that case returns no intersection earlier).
 *
 * Robust per-edge formulation: a triangle that straddles a plane meets the plane in a
 * segment. Each of the 3 edges contributes a crossing point when its endpoints' signed
 * distances straddle zero; a vertex lying exactly ON the plane (distance 0, e.g. a
 * shared corner) contributes its own projected coordinate directly. The interval is the
 * [min,max] of those projected crossing coordinates. Handles the zero-distance case the
 * classic "lone vertex" pivot mishandles.
 */
function planeInterval(
  p0: Vertex, p1: Vertex, p2: Vertex,
  d0: number, d1: number, d2: number,
  axis: 0 | 1 | 2,
): [number, number] {
  const verts: [Vertex, number][] = [[p0, d0], [p1, d1], [p2, d2]];
  const hits: number[] = [];

  for (let i = 0; i < 3; i += 1) {
    const [vi, di] = verts[i]!;
    const [vj, dj] = verts[(i + 1) % 3]!;
    if (di === 0) {
      // Vertex exactly on the plane: it is itself a crossing point.
      hits.push(component(vi, axis));
    }
    // Edge straddles the plane (strictly opposite signs): interpolate the crossing.
    if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
      const t = di / (di - dj);
      hits.push(component(vi, axis) + (component(vj, axis) - component(vi, axis)) * t);
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (const h of hits) {
    if (h < min) {
      min = h;
    }
    if (h > max) {
      max = h;
    }
  }
  return [min, max];
}

/** 2D point for the coplanar SAT test. */
interface P2 {
  u: number;
  v: number;
}

/** Project a vertex onto the plane's two non-dominant axes. */
function project2D(v: Vertex, drop: 0 | 1 | 2): P2 {
  if (drop === 0) {
    return { u: v.y, v: v.z };
  }
  if (drop === 1) {
    return { u: v.x, v: v.z };
  }
  return { u: v.x, v: v.y };
}

/**
 * Strict positive-area 2D triangle-triangle overlap via the separating-axis test
 * over both triangles' 6 edge normals. Returns true ONLY for genuine area overlap;
 * edge-butting / corner-touching fans project to a zero-area touch and a strict SAT
 * separation (with EPS margin) rejects them.
 */
function trianglesOverlap2D(a: [P2, P2, P2], b: [P2, P2, P2], eps: number): boolean {
  const tris: [P2, P2, P2][] = [a, b];
  for (const tri of tris) {
    for (let i = 0; i < 3; i += 1) {
      const p = tri[i]!;
      const q = tri[(i + 1) % 3]!;
      // Edge normal (perpendicular to the edge).
      const nx = -(q.v - p.v);
      const ny = q.u - p.u;
      let minA = Infinity, maxA = -Infinity;
      for (const pt of a) {
        const proj = pt.u * nx + pt.v * ny;
        if (proj < minA) {
          minA = proj;
        }
        if (proj > maxA) {
          maxA = proj;
        }
      }
      let minB = Infinity, maxB = -Infinity;
      for (const pt of b) {
        const proj = pt.u * nx + pt.v * ny;
        if (proj < minB) {
          minB = proj;
        }
        if (proj > maxB) {
          maxB = proj;
        }
      }
      // Separated (with strict EPS margin) on this axis => no positive-area overlap.
      if (minA > maxB - eps || minB > maxA - eps) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Möller 1997 "A Fast Triangle-Triangle Intersection Test" predicate, returning
 * whether the two triangle INTERIORS genuinely cross (and how). Returns `null` for
 * no intersection, `'crossing'` for a true 3D interior cross, `'coplanar'` for a
 * same-plane area-overlapping lamination.
 */
function triangleIntersectionKind(
  t1: Triangle,
  t2: Triangle,
  eps: number,
): 'crossing' | 'coplanar' | null {
  const [v0, v1, v2] = t1;
  const [u0, u1, u2] = t2;

  // Plane of T2.
  const n2 = cross(sub(u1, u0), sub(u2, u0));
  const d2 = -dot(n2, u0);
  let dv0 = dot(n2, v0) + d2;
  let dv1 = dot(n2, v1) + d2;
  let dv2 = dot(n2, v2) + d2;
  if (Math.abs(dv0) <= eps) {
    dv0 = 0;
  }
  if (Math.abs(dv1) <= eps) {
    dv1 = 0;
  }
  if (Math.abs(dv2) <= eps) {
    dv2 = 0;
  }

  // All on one side (and none on the plane) => no intersection.
  if (dv0 !== 0 && dv1 !== 0 && dv2 !== 0 &&
      ((dv0 > 0 && dv1 > 0 && dv2 > 0) || (dv0 < 0 && dv1 < 0 && dv2 < 0))) {
    return null;
  }

  // Plane of T1.
  const n1 = cross(sub(v1, v0), sub(v2, v0));
  const d1 = -dot(n1, v0);
  let du0 = dot(n1, u0) + d1;
  let du1 = dot(n1, u1) + d1;
  let du2 = dot(n1, u2) + d1;
  if (Math.abs(du0) <= eps) {
    du0 = 0;
  }
  if (Math.abs(du1) <= eps) {
    du1 = 0;
  }
  if (Math.abs(du2) <= eps) {
    du2 = 0;
  }

  if (du0 !== 0 && du1 !== 0 && du2 !== 0 &&
      ((du0 > 0 && du1 > 0 && du2 > 0) || (du0 < 0 && du1 < 0 && du2 < 0))) {
    return null;
  }

  // Coplanar: all of T1's verts lie on T2's plane.
  if (dv0 === 0 && dv1 === 0 && dv2 === 0) {
    const drop = dominantAxis(n2);
    const a2: [P2, P2, P2] = [project2D(v0, drop), project2D(v1, drop), project2D(v2, drop)];
    const b2: [P2, P2, P2] = [project2D(u0, drop), project2D(u1, drop), project2D(u2, drop)];
    return trianglesOverlap2D(a2, b2, eps) ? 'coplanar' : null;
  }

  // General non-coplanar case: both triangles straddle the other's plane.
  const d = cross(n1, n2);
  const axis = dominantAxis(d);
  const [a1, a2] = planeInterval(v0, v1, v2, dv0, dv1, dv2, axis);
  const [b1, b2] = planeInterval(u0, u1, u2, du0, du1, du2, axis);
  // Strict interior overlap with EPS margin => true crossing; an endpoint-only touch
  // (fan meeting at the shared corner) collapses to a point and is rejected.
  if (a1 < b2 - eps && b1 < a2 - eps) {
    return 'crossing';
  }
  return null;
}

/**
 * Finds pairs of triangles whose interiors actually cross in 3D (true crossers) or
 * lie coplanar and overlap in area (laminations). Uses a uniform 0.5 mm XY-grid
 * broad phase (mirroring `findTJunctions`) and the Möller narrow phase. Adjacency
 * exclusion is by SHARED EDGE ONLY (2+ shared quantized keys), so single-shared-vertex
 * corner bow-ties DO reach the narrow phase and are caught.
 */
export function findSelfIntersectingTriangles(
  triangles: Triangle[],
  options: ValidateOptions = {},
): SelfIntersection[] {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const eps = DEFAULT_PRECISION_MM;
  const cell = 0.5;
  const cellKey = (cx: number, cy: number): string => `${cx},${cy}`;

  // Broad phase: insert each triangle into every cell its tol-expanded XY bbox covers.
  const grid = new Map<string, number[]>();
  for (let i = 0; i < triangles.length; i += 1) {
    const [a, b, c] = triangles[i]!;
    const minX = Math.min(a.x, b.x, c.x) - eps;
    const maxX = Math.max(a.x, b.x, c.x) + eps;
    const minY = Math.min(a.y, b.y, c.y) - eps;
    const maxY = Math.max(a.y, b.y, c.y) + eps;
    const cx0 = Math.floor(minX / cell);
    const cx1 = Math.floor(maxX / cell);
    const cy0 = Math.floor(minY / cell);
    const cy1 = Math.floor(maxY / cell);
    for (let cx = cx0; cx <= cx1; cx += 1) {
      for (let cy = cy0; cy <= cy1; cy += 1) {
        const key = cellKey(cx, cy);
        const bucket = grid.get(key);
        if (bucket) {
          bucket.push(i);
        } else {
          grid.set(key, [i]);
        }
      }
    }
  }

  // Precompute quantized key triples once per triangle.
  const keys: [string, string, string][] = triangles.map(t => triKeys(t, precision));

  const visited = new Set<string>();
  const result: SelfIntersection[] = [];

  for (const bucket of grid.values()) {
    for (let bi = 0; bi < bucket.length; bi += 1) {
      for (let bj = bi + 1; bj < bucket.length; bj += 1) {
        const i = bucket[bi]!;
        const j = bucket[bj]!;
        const lo = i < j ? i : j;
        const hi = i < j ? j : i;
        const pairKey = `${lo}#${hi}`;
        if (visited.has(pairKey)) {
          continue;
        }
        visited.add(pairKey);
        // Shared-edge exclusion: 2+ shared quantized keys => edge-adjacent, skip.
        if (sharedKeyCount(keys[lo]!, keys[hi]!) >= 2) {
          continue;
        }
        const kind = triangleIntersectionKind(triangles[lo]!, triangles[hi]!, eps);
        if (kind !== null) {
          result.push({ triangleA: lo, triangleB: hi, kind });
        }
      }
    }
  }

  result.sort((p, q) => (p.triangleA - q.triangleA) || (p.triangleB - q.triangleB));
  return result;
}

// ── Detector 2 — flipped-winding adjacent faces ────────────────────────────────

interface FlippedIncidence {
  /** Directed quantized vertex-key tuple in this triangle's winding order. */
  dir: [string, string];
  triangleIndex: number;
  /** Raw endpoints (first-seen) for the reported `sharedEdge`. */
  a: Vertex;
  b: Vertex;
}

/**
 * Finds adjacent face pairs that traverse their shared edge in the SAME direction
 * (a winding/normal flip). For a consistently-wound 2-manifold edge the two incident
 * triangles' directed tuples are REVERSED of each other; identical tuples mean one
 * face is flipped. Grouping uses the UNDIRECTED `edgeKey`; the flip decision compares
 * the DIRECTED tuples (never sorted).
 */
export function findFlippedAdjacentFaces(
  triangles: Triangle[],
  options: ValidateOptions = {},
): Array<{ triangleA: number; triangleB: number; sharedEdge: { a: Vertex; b: Vertex } }> {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const incidence = new Map<string, FlippedIncidence[]>();

  for (let triIndex = 0; triIndex < triangles.length; triIndex += 1) {
    const tri = triangles[triIndex]!;
    const keys = triKeys(tri, precision);
    for (let edge = 0; edge < 3; edge += 1) {
      const ka = keys[edge]!;
      const kb = keys[(edge + 1) % 3]!;
      if (ka === kb) {
        continue; // degenerate edge
      }
      const key = edgeKey(ka, kb);
      const record: FlippedIncidence = {
        dir: [ka, kb],
        triangleIndex: triIndex,
        a: tri[edge]!,
        b: tri[(edge + 1) % 3]!,
      };
      const existing = incidence.get(key);
      if (existing) {
        existing.push(record);
      } else {
        incidence.set(key, [record]);
      }
    }
  }

  const result: Array<{ triangleA: number; triangleB: number; sharedEdge: { a: Vertex; b: Vertex } }> = [];
  for (const records of incidence.values()) {
    if (records.length !== 2) {
      continue; // non-manifold incidence is findNonManifoldEdges' concern
    }
    const [r1, r2] = records as [FlippedIncidence, FlippedIncidence];
    const identical = r1.dir[0] === r2.dir[0] && r1.dir[1] === r2.dir[1];
    if (!identical) {
      continue; // reversed tuples => consistent winding
    }
    const lo = Math.min(r1.triangleIndex, r2.triangleIndex);
    const hi = Math.max(r1.triangleIndex, r2.triangleIndex);
    result.push({ triangleA: lo, triangleB: hi, sharedEdge: { a: r1.a, b: r1.b } });
  }
  return result;
}

// ── Detector 3 — disjoint shell components ─────────────────────────────────────

/**
 * Groups triangles into connected components by shared-edge adjacency (union-find).
 * Two triangles are connected when they share a quantized edge; a component is
 * everything reachable by walking shared edges (across both 2-manifold and
 * non-manifold edges). A single closed shell => one component. Two disjoint shells
 * in one part => two components. Empty input => `[]`.
 *
 * Returns components ordered by their smallest member ascending, each component's
 * indices sorted ascending.
 */
export function findShellComponents(
  triangles: Triangle[],
  options: ValidateOptions = {},
): number[][] {
  const precision = options.precisionMm ?? DEFAULT_PRECISION_MM;
  const n = triangles.length;
  if (n === 0) {
    return [];
  }

  const parent = new Array<number>(n);
  const size = new Array<number>(n).fill(1);
  for (let i = 0; i < n; i += 1) {
    parent[i] = i;
  }
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) {
      root = parent[root]!;
    }
    // Path compression.
    let cur = x;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) {
      return;
    }
    if (size[ra]! < size[rb]!) {
      parent[ra] = rb;
      size[rb]! += size[ra]!;
    } else {
      parent[rb] = ra;
      size[ra]! += size[rb]!;
    }
  };

  // First incident triangle per quantized edge; union every subsequent one with it.
  const firstByEdge = new Map<string, number>();
  for (let triIndex = 0; triIndex < n; triIndex += 1) {
    const tri = triangles[triIndex]!;
    const keys = triKeys(tri, precision);
    for (let edge = 0; edge < 3; edge += 1) {
      const ka = keys[edge]!;
      const kb = keys[(edge + 1) % 3]!;
      if (ka === kb) {
        continue;
      }
      const key = edgeKey(ka, kb);
      const first = firstByEdge.get(key);
      if (first === undefined) {
        firstByEdge.set(key, triIndex);
      } else {
        union(first, triIndex);
      }
    }
  }

  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const members = byRoot.get(root);
    if (members) {
      members.push(i);
    } else {
      byRoot.set(root, [i]);
    }
  }

  const components = [...byRoot.values()];
  for (const members of components) {
    members.sort((a, b) => a - b);
  }
  components.sort((a, b) => a[0]! - b[0]!);
  return components;
}
