/**
 * Synthetic unit tests for the #115 slicer-style mesh detectors:
 * `findSelfIntersectingTriangles`, `findFlippedAdjacentFaces`, `findShellComponents`.
 *
 * These hand-constructed fixtures lock the load-bearing semantics from the plan's §4e
 * falsification gates: a corner-sharing bow-tie IS reported; a fan touching only at a
 * shared vertex is NOT; a shared-edge neighbour is NOT; a flipped-winding pair IS
 * reported; two disjoint shells give componentCount 2; a single closed shell gives 1.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findFlippedAdjacentFaces,
  findSelfIntersectingTriangles,
  findShellComponents,
  summarizeMesh,
} from '../src/model/validate-mesh.js';
import type { Triangle, Vertex } from '../src/types/model.js';

const v = (x: number, y: number, z = 0): Vertex => ({ x, y, z });

// ── findSelfIntersectingTriangles ──────────────────────────────────────────────

test('self-intersection: bow-tie crossers SHARING A CORNER VERTEX are reported (§4e a)', () => {
  // T1 in plane z=0, T2 in plane y=0; share only corner C=(0,0,0). Their interiors
  // fold across each other along the x-axis. This is the exact failure mode #115 targets.
  const t1: Triangle = [v(0, 0, 0), v(4, 1, 0), v(4, -1, 0)];
  const t2: Triangle = [v(0, 0, 0), v(4, 0, 2), v(4, 0, -2)];
  const result = findSelfIntersectingTriangles([t1, t2]);
  assert.deepEqual(result, [{ triangleA: 0, triangleB: 1, kind: 'crossing' }]);
});

test('self-intersection: shared-EDGE neighbour is cleared (§4e c)', () => {
  // Two triangles sharing the full edge (0,0,0)-(4,0,0): manifold-friendly common case.
  const t1: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, 2, 0)];
  const t2: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, -2, 0)];
  assert.deepEqual(findSelfIntersectingTriangles([t1, t2]), []);
});

test('self-intersection: single-shared-vertex FAN, non-crossing interiors, is cleared (§4e b)', () => {
  // Two coplanar fan triangles meeting only at C=(0,0,0); interiors abut but do not overlap.
  const t1: Triangle = [v(0, 0, 0), v(4, 1, 0), v(4, -1, 0)];
  const t2: Triangle = [v(0, 0, 0), v(4, 3, 0), v(4, 1, 0)];
  assert.deepEqual(findSelfIntersectingTriangles([t1, t2]), []);
});

test('self-intersection: far-apart disjoint pair is pruned by the broad phase', () => {
  const t1: Triangle = [v(0, 0, 0), v(1, 0, 0), v(0, 1, 0)];
  const t2: Triangle = [v(100, 100, 0), v(101, 100, 0), v(100, 101, 0)];
  assert.deepEqual(findSelfIntersectingTriangles([t1, t2]), []);
});

test('self-intersection: coplanar area-overlapping lamination (no shared edge) is reported AND tagged coplanar (§4f)', () => {
  // Two coplanar (z=0) triangles whose 2D interiors overlap in area, sharing NO vertex.
  const t1: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, 4, 0)];
  const t2: Triangle = [v(0, 3, 0), v(4, 3, 0), v(2, -1, 0)];
  const result = findSelfIntersectingTriangles([t1, t2]);
  assert.deepEqual(result, [{ triangleA: 0, triangleB: 1, kind: 'coplanar' }]);
});

// ── findFlippedAdjacentFaces ───────────────────────────────────────────────────

test('flipped winding: two triangles sharing an edge with OPPOSITE traversal are consistent ([])', () => {
  // Shared edge A=(0,0,0)-B=(4,0,0). T1 walks A->B; T2 walks B->A (reversed) => consistent.
  const t1: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, 2, 0)];
  const t2: Triangle = [v(4, 0, 0), v(0, 0, 0), v(2, -2, 0)];
  assert.deepEqual(findFlippedAdjacentFaces([t1, t2]), []);
});

test('flipped winding: two triangles sharing an edge with SAME traversal report one flip', () => {
  // Both walk the shared edge A=(0,0,0)->B=(4,0,0) in the SAME direction => one is flipped.
  const t1: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, 2, 0)];
  const t2: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, -2, 0)];
  const result = findFlippedAdjacentFaces([t1, t2]);
  assert.equal(result.length, 1);
  const rec = result[0]!;
  assert.equal(rec.triangleA, 0);
  assert.equal(rec.triangleB, 1);
  const xs = [rec.sharedEdge.a.x, rec.sharedEdge.b.x].sort((p, q) => p - q);
  assert.deepEqual(xs, [0, 4]);
});

// ── findShellComponents ────────────────────────────────────────────────────────

/** The 4 triangles of a tetrahedron, vertices offset by `dx`. */
function tetrahedron(dx: number): Triangle[] {
  const a = v(dx + 0, 0, 0);
  const b = v(dx + 1, 0, 0);
  const c = v(dx + 0, 1, 0);
  const d = v(dx + 0, 0, 1);
  return [
    [a, b, c],
    [a, c, d],
    [a, d, b],
    [b, d, c],
  ];
}

test('shell components: a single closed shell is one component with all indices', () => {
  const tet = tetrahedron(0);
  const components = findShellComponents(tet);
  assert.equal(components.length, 1);
  assert.deepEqual(components[0], [0, 1, 2, 3]);
});

test('shell components: two disjoint tetrahedra give two correctly-partitioned components', () => {
  const triangles = [...tetrahedron(0), ...tetrahedron(50)];
  const components = findShellComponents(triangles);
  assert.equal(components.length, 2);
  assert.deepEqual(components[0], [0, 1, 2, 3]);
  assert.deepEqual(components[1], [4, 5, 6, 7]);
});

test('shell components: empty input returns []', () => {
  assert.deepEqual(findShellComponents([]), []);
});

// ── summarizeMesh new fields ───────────────────────────────────────────────────

test('summarizeMesh exposes the three #115 count fields', () => {
  // Flipped-winding fixture => flippedFaceCount === 1.
  const t1: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, 2, 0)];
  const t2: Triangle = [v(0, 0, 0), v(4, 0, 0), v(2, -2, 0)];
  const summary = summarizeMesh([t1, t2]);
  assert.equal(summary.flippedFaceCount, 1);
  assert.equal(typeof summary.selfIntersectionCount, 'number');
  assert.equal(typeof summary.componentCount, 'number');
  // The two triangles share an edge => one connected component.
  assert.equal(summary.componentCount, 1);
});
