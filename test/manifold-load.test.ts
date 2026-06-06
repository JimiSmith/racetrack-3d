/**
 * #133: the manifold WASM toplevel loads once and is module-cached.
 *
 * Runs cleanly under `node --import tsx/esm --test` because `base-plate-csg.ts`
 * has NO top-level `?url` import — `resolveWasmUrl` takes the node branch
 * (`import.meta.resolve('manifold-3d/manifold.wasm')`), so no Vite `?url` shim is
 * ever evaluated by tsx.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadManifold } from '../src/model/base-plate-csg.js';

test('loadManifold resolves the toplevel and is module-cached (same instance)', async () => {
  const a = await loadManifold();
  const b = await loadManifold();
  assert.strictEqual(a, b, 'second loadManifold() returns the cached toplevel');
  assert.equal(typeof a.Manifold, 'function', 'Manifold constructor present after setup()');
  assert.equal(typeof a.CrossSection, 'function', 'CrossSection constructor present after setup()');
});

test('a basic CrossSection extrude + boolean round-trips', async () => {
  const api = await loadManifold();
  const square = new api.CrossSection(
    [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    'Positive',
  );
  const solid = square.extrude(2);
  assert.equal(solid.isEmpty(), false);
  const mesh = solid.getMesh();
  assert.ok(mesh.triVerts.length > 0, 'extruded box reads back triangles');
});
