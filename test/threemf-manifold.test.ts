/**
 * Per-part 2-manifold assertions for the exported mesh.
 *
 * Caveat: `validate-mesh` quantizes on the same 1e-4 mm grid the 3MF exporter
 * uses, so these tests verify the mesh is self-consistent *at the export grid*
 * — they cannot detect non-manifold edges a slicer with a tighter or different
 * grid (e.g. Bambu Studio) might still report. The flush-coaster-with-text case
 * is one such known residual, tracked in the PR; a green run here is necessary
 * but not sufficient for "clean in the slicer".
 */
import test from 'node:test';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { buildTrackModel } from '../src/model/index.js';
import { assertModelManifold } from '../test-utils/mesh-assertions.js';
import type { ProjectedNode } from '../src/types/geometry.js';

/**
 * A simple closed racing-line: rounded rectangle in projected metres.
 * Enough nodes to give the ribbon a real curvature without producing
 * pathological sharp angles.
 */
function syntheticProjectedLoop(): ProjectedNode[] {
  const cx = 0, cy = 0;
  const halfW = 80;
  const halfH = 50;
  const radius = 25;
  const segmentsPerCorner = 6;
  const nodes: ProjectedNode[] = [];

  function pushArc(centerX: number, centerY: number, startDeg: number, endDeg: number): void {
    for (let i = 1; i <= segmentsPerCorner; i += 1) {
      const t = i / segmentsPerCorner;
      const angle = ((startDeg + (endDeg - startDeg) * t) * Math.PI) / 180;
      nodes.push({ x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, elevation: 0 });
    }
  }

  nodes.push({ x: cx - halfW + radius, y: cy - halfH, elevation: 0 });
  nodes.push({ x: cx + halfW - radius, y: cy - halfH, elevation: 0 });
  pushArc(cx + halfW - radius, cy - halfH + radius, -90, 0);
  nodes.push({ x: cx + halfW, y: cy + halfH - radius, elevation: 0 });
  pushArc(cx + halfW - radius, cy + halfH - radius, 0, 90);
  nodes.push({ x: cx - halfW + radius, y: cy + halfH, elevation: 0 });
  pushArc(cx - halfW + radius, cy + halfH - radius, 90, 180);
  nodes.push({ x: cx - halfW, y: cy - halfH + radius, elevation: 0 });
  pushArc(cx - halfW + radius, cy - halfH + radius, 180, 270);
  return nodes;
}

function buildModelForCase(opts: {
  coasterMode?: boolean;
  coasterInlay?: 'flush' | 'raised';
  trackName?: string;
}) {
  const projectedNodes = syntheticProjectedLoop();
  const outlinePoints = buildTrackOutline(projectedNodes, 12);
  const basePlate = buildBasePlate(outlinePoints, 50);
  return buildTrackModel({
    outlinePoints,
    basePlate,
    projectedNodes,
    trackName: opts.trackName ?? 'Test Loop',
    coasterMode: opts.coasterMode ?? false,
    coasterShape: 'round',
    ...(opts.coasterInlay ? { coasterInlay: opts.coasterInlay } : {}),
    primaryOrientationDeg: 0,
  });
}

test('non-coaster export is 2-manifold per part', () => {
  const model = buildModelForCase({ coasterMode: false });
  assertModelManifold('non-coaster', model);
});

test('coaster round + raised export is 2-manifold per part (Spa repro mode)', () => {
  const model = buildModelForCase({ coasterMode: true, coasterInlay: 'raised' });
  assertModelManifold('coaster raised', model);
});

test('coaster round + flush export is 2-manifold per part', () => {
  const model = buildModelForCase({ coasterMode: true, coasterInlay: 'flush' });
  assertModelManifold('coaster flush', model, { failOn: 'edges+tjunctions' });
});
