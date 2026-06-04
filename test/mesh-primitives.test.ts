import assert from 'node:assert/strict';
import test from 'node:test';

import { addTriangle, isDegenerateTriangle } from '../src/model/mesh-primitives.js';
import type { Triangle, Vertex } from '../src/types/model.js';

const v = (x: number, y: number, z: number): Vertex => ({ x, y, z });

test('isDegenerateTriangle flags triangles whose vertices coincide on the export grid', () => {
  // Two vertices identical.
  assert.equal(isDegenerateTriangle(v(0, 0, 0), v(0, 0, 0), v(1, 0, 0)), true);
  // Distinct in full precision but collapsing under the 1e-4 mm dedup.
  assert.equal(isDegenerateTriangle(v(0, 0, 0), v(0, 0, 1e-6), v(1, 0, 0)), true);
});

test('isDegenerateTriangle keeps thin, collinear-but-distinct slivers', () => {
  // Three collinear yet separate vertices (zero area). These must NOT be
  // dropped: an area-based filter would remove them and open holes in the
  // ribbon/pocket meshes, since the sliver still carries edge-pairing. This
  // guards against regressing the STL hole bug.
  assert.equal(isDegenerateTriangle(v(0, 0, 0), v(0.5, 0, 0), v(1, 0, 0)), false);
  // A genuinely thin but non-collinear sliver is also kept.
  assert.equal(isDegenerateTriangle(v(0, 0, 0), v(1, 0, 0), v(0.5, 1e-3, 0)), false);
});

test('addTriangle drops only coincident-vertex triangles', () => {
  const triangles: Triangle[] = [];
  addTriangle(triangles, v(0, 0, 0), v(0, 0, 0), v(1, 0, 0)); // coincident → dropped
  addTriangle(triangles, v(0, 0, 0), v(0.5, 0, 0), v(1, 0, 0)); // collinear → kept
  addTriangle(triangles, v(0, 0, 0), v(1, 0, 0), v(0, 1, 0)); // real → kept
  assert.equal(triangles.length, 2);
});
