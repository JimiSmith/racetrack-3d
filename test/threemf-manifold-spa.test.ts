/**
 * Regression test against real Spa-Francorchamps OSM geometry — the
 * synthetic loops in threemf-manifold.test.ts don't trigger the
 * earcut-with-many-baseline-collinear-glyph-holes failure mode that
 * shows up on real tracks with long printed labels.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { projectNodes } from '../src/geometry/projection.js';
import { buildTrackModel } from '../src/model/index.js';
import { splitModelTriangles } from '../src/model/triangle-groups.js';
import { findNonManifoldEdges, summarizeMesh } from '../src/model/validate-mesh.js';
import type { Triangle } from '../src/types/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const spaPath = join(here, '..', 'src', 'generated', 'geometry', 'Q172851.json');
type TrackFile = {
  center: { lat: number; lon: number };
  layouts: Array<{ id: string; name: string; nodes: Array<{ lat: number; lon: number }> }>;
};
const spa: TrackFile = JSON.parse(readFileSync(spaPath, 'utf8'));

function assertPartManifold(label: string, triangles: Triangle[]): void {
  if (triangles.length === 0) { return; }
  const nm = findNonManifoldEdges(triangles);
  if (nm.length > 0) {
    const summary = summarizeMesh(triangles);
    const examples = nm.slice(0, 3).map(e => ({
      a: { x: +e.a.x.toFixed(4), y: +e.a.y.toFixed(4), z: +e.a.z.toFixed(4) },
      b: { x: +e.b.x.toFixed(4), y: +e.b.y.toFixed(4), z: +e.b.z.toFixed(4) },
      triangleIndices: e.triangleIndices,
    }));
    assert.fail(`${label}: ${nm.length} non-manifold edges\n  summary=${JSON.stringify(summary)}\n  first: ${JSON.stringify(examples)}`);
  }
}

test('Spa-Francorchamps flush coaster — each 3MF object is 2-manifold', () => {
  const layout = spa.layouts.find(l => l.id === 'grand-prix') ?? spa.layouts[0]!;
  const projected = projectNodes(layout.nodes, null, spa.center);
  const outlinePoints = buildTrackOutline(projected, 12);
  const basePlate = buildBasePlate(outlinePoints, 50);
  const model = buildTrackModel({
    outlinePoints,
    basePlate,
    projectedNodes: projected,
    trackName: 'Spa-Francorchamps Circuit',
    coasterMode: true,
    coasterShape: 'round',
    coasterInlay: 'flush',
    primaryOrientationDeg: 'auto',
  });
  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);
  assertPartManifold('Spa flush / base', baseTriangles);
  assertPartManifold('Spa flush / secondary', secondaryTrackTriangles);
  assertPartManifold('Spa flush / track + text', trackTriangles);
});
