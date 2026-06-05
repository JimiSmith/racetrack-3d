/**
 * Regression test against real Spa-Francorchamps OSM geometry — the
 * synthetic loops in threemf-manifold.test.ts don't trigger the
 * earcut-with-many-baseline-collinear-glyph-holes failure mode that
 * shows up on real tracks with long printed labels.
 *
 * As in threemf-manifold.test.ts, `validate-mesh` measures the mesh at the
 * exporter's own 1e-4 mm grid, so passing here means manifold *at that grid*,
 * not necessarily manifold under a slicer's stricter quantization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { projectNodes } from '../src/geometry/projection.js';
import { buildTrackModel } from '../src/model/index.js';
import { validateModel } from '../src/model/validate-mesh.js';
import { assertModelManifold } from '../test-utils/mesh-assertions.js';

const here = dirname(fileURLToPath(import.meta.url));
const spaPath = join(here, '..', 'src', 'generated', 'geometry', 'Q172851.json');
type TrackFile = {
  center: { lat: number; lon: number };
  layouts: Array<{ id: string; name: string; nodes: Array<{ lat: number; lon: number }> }>;
};
const spa: TrackFile = JSON.parse(readFileSync(spaPath, 'utf8'));

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
  // Machine-checked #111 ratchet: the Spa flush BASE part had 194 T-junctions before the
  // simplifyRing colinearity fix. The fix (length-scaled threshold + iterate-until-stable
  // collapse) must keep the base-part T-junction count strictly below that baseline. We use
  // `<`, not `=== 0`, so the residual stays observable as the measurement input for #110.
  const SPA_BASE_TJUNCTION_BASELINE = 194;
  const report = validateModel(model);
  const baseTJunctions = report.parts.find(p => p.part === 'base')!.tJunctions.length;
  assert.ok(
    baseTJunctions < SPA_BASE_TJUNCTION_BASELINE,
    `Spa flush base-part T-junction count regressed: ${baseTJunctions} (baseline ${SPA_BASE_TJUNCTION_BASELINE}, must stay below)`,
  );

  // Opted into the full #115 detector set; this is one of the 3 intentional pre-existing
  // failures and the new detectors may make it louder (expected, not a regression). Kept so
  // the printed `T-junction count: N` residual remains visible for #110's re-measurement.
  assertModelManifold('Spa flush', model, { failOn: 'all' });
});
