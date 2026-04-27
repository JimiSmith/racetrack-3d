import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { buildTrackModel } from '../src/model/index.js';
import { splitModelTriangles } from '../src/model/triangle-groups.js';
import { findDegenerateTriangles, findNonManifoldEdges, summarizeMesh } from '../src/model/validate-mesh.js';
import type { ProjectedNode } from '../src/types/geometry.js';
import type { Triangle } from '../src/types/model.js';

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

function assertPartManifold(label: string, triangles: Triangle[]): void {
  if (triangles.length === 0) {
    return;
  }
  const nonManifold = findNonManifoldEdges(triangles);
  const degenerate = findDegenerateTriangles(triangles);
  if (nonManifold.length > 0 || degenerate.length > 0) {
    const summary = summarizeMesh(triangles);
    const examples = nonManifold.slice(0, 5).map(e => ({
      a: { x: +e.a.x.toFixed(4), y: +e.a.y.toFixed(4), z: +e.a.z.toFixed(4) },
      b: { x: +e.b.x.toFixed(4), y: +e.b.y.toFixed(4), z: +e.b.z.toFixed(4) },
      triangleIndices: e.triangleIndices,
    }));
    assert.fail(
      `${label}: part is not 2-manifold\n  summary=${JSON.stringify(summary)}\n  first non-manifold edges: ${JSON.stringify(examples, null, 2)}\n  degenerate triangle indices (first 5): ${JSON.stringify(degenerate.slice(0, 5))}`,
    );
  }
}

/**
 * Validates that each logical part of the model — base, secondary tracks,
 * primary track + text — is independently 2-manifold. This mirrors what
 * Bambu sees, since `build3mfModelXml` emits one `<object>` per part with
 * its own vertex pool.
 */
function assertModelManifold(label: string, model: ReturnType<typeof buildTrackModel>): void {
  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);
  assertPartManifold(`${label} / base`, baseTriangles);
  assertPartManifold(`${label} / secondary tracks`, secondaryTrackTriangles);
  assertPartManifold(`${label} / primary track + text`, trackTriangles);
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
  assertModelManifold('coaster flush', model);
});
