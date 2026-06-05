/**
 * Synthetic unit tests for `findTJunctions` — the T-junction detector (#109).
 *
 * A T-junction is a vertex lying in the INTERIOR of another triangle's edge while
 * sharing no endpoint topologically with that edge. The mesh stays 2-manifold by
 * edge-incidence count, so `findNonManifoldEdges` cannot see it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findTJunctions, DEFAULT_PRECISION_MM, DEFAULT_TJUNCTION_TOLERANCE_MM } from '../src/model/validate-mesh.js';
import type { Triangle, Vertex } from '../src/types/model.js';

const v = (x: number, y: number, z = 0): Vertex => ({ x, y, z });

test('detects a vertex sitting exactly mid-edge of another triangle', () => {
  // Triangle 0 owns the long edge A=(0,0,0) -> B=(10,0,0).
  const longEdgeTri: Triangle = [v(0, 0), v(10, 0), v(5, 5)];
  // Triangle 1 has a vertex V=(5,0,0) exactly on the long edge's interior.
  const touchingTri: Triangle = [v(5, 0), v(2, -4), v(8, -4)];

  const result = findTJunctions([longEdgeTri, touchingTri]);
  assert.equal(result.length, 1);
  const tj = result[0]!;
  assert.equal(tj.triangleIndex, 0, 'reports the triangle owning the offending edge');
  assert.ok(tj.perpendicularDistance < 1e-9, 'vertex lies on the line');
  assert.deepEqual(tj.vertex, { x: 5, y: 0, z: 0 });
  // Edge endpoints are A/B of the long edge (order-independent).
  const xs = [tj.edge.a.x, tj.edge.b.x].sort((p, q) => p - q);
  assert.deepEqual(xs, [0, 10]);
});

test('returns [] for a clean triangle fan (all shared endpoints, no interior incidence)', () => {
  // Fan around a shared centre — every outer vertex is a true shared endpoint.
  const c = v(0, 0);
  const ring = [v(10, 0), v(7, 7), v(0, 10), v(-7, 7), v(-10, 0), v(-7, -7), v(0, -10), v(7, -7)];
  const fan: Triangle[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    fan.push([c, ring[i]!, ring[(i + 1) % ring.length]!]);
  }
  assert.deepEqual(findTJunctions(fan), []);
});

test('excludes a sub-precision near-endpoint vertex via the absolute endpoint radius', () => {
  // Edge A=(0,0,0) -> B=(10,0,0). Place V offset from A by precisionMm/2 ALONG the edge.
  // This sub-grid offset can quantize to a key different from qA, so the key inequality
  // would let it through; the absolute |V-A| > precisionMm radius must REJECT it.
  const offset = DEFAULT_PRECISION_MM / 2;
  const longEdgeTri: Triangle = [v(0, 0), v(10, 0), v(5, 5)];
  const nearEndpointTri: Triangle = [v(offset, 0), v(2, -4), v(8, -4)];

  const result = findTJunctions([longEdgeTri, nearEndpointTri]);
  assert.deepEqual(result, [], 'near-endpoint duplicate is not a T-junction');
});

test('tolerance boundary at 1e-4: just-above rejected, just-below reported', () => {
  const longEdgeTri: Triangle = [v(0, 0), v(10, 0), v(5, 5)];

  // Vertex perpendicular-offset just ABOVE tolerance — not reported.
  const above = DEFAULT_TJUNCTION_TOLERANCE_MM * 1.5;
  const aboveTri: Triangle = [v(5, above), v(2, -4), v(8, -4)];
  assert.deepEqual(findTJunctions([longEdgeTri, aboveTri]), [], 'd just above tolerance is rejected');

  // Vertex perpendicular-offset just BELOW tolerance — reported.
  const below = DEFAULT_TJUNCTION_TOLERANCE_MM * 0.5;
  const belowTri: Triangle = [v(5, below), v(2, -4), v(8, -4)];
  const reported = findTJunctions([longEdgeTri, belowTri]);
  assert.equal(reported.length, 1, 'd just below tolerance is reported');
  assert.ok(reported[0]!.perpendicularDistance <= DEFAULT_TJUNCTION_TOLERANCE_MM);
});

test('does not report a strictly t<=0 or t>=1 projection (beyond the segment)', () => {
  // Vertex collinear with the edge but PAST endpoint B (t > 1): not interior.
  const longEdgeTri: Triangle = [v(0, 0), v(10, 0), v(5, 5)];
  const beyondTri: Triangle = [v(15, 0), v(12, -4), v(18, -4)];
  assert.deepEqual(findTJunctions([longEdgeTri, beyondTri]), []);
});
