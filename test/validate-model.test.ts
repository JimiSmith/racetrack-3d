/**
 * Structural contract test for `validateModel`: locks the part ordering,
 * empty-part inclusion, and `ok` derivation so future #109/#115 extensions
 * don't silently change the report shape.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { buildTrackModel } from '../src/model/index.js';
import { validateModel } from '../src/model/validate-mesh.js';
import type { ProjectedNode } from '../src/types/geometry.js';

function syntheticProjectedLoop(): ProjectedNode[] {
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

  nodes.push({ x: -halfW + radius, y: -halfH, elevation: 0 });
  nodes.push({ x: halfW - radius, y: -halfH, elevation: 0 });
  pushArc(halfW - radius, -halfH + radius, -90, 0);
  nodes.push({ x: halfW, y: halfH - radius, elevation: 0 });
  pushArc(halfW - radius, halfH - radius, 0, 90);
  nodes.push({ x: -halfW + radius, y: halfH, elevation: 0 });
  pushArc(-halfW + radius, halfH - radius, 90, 180);
  nodes.push({ x: -halfW, y: -halfH + radius, elevation: 0 });
  pushArc(-halfW + radius, -halfH + radius, 180, 270);
  return nodes;
}

async function buildModel() {
  const projectedNodes = syntheticProjectedLoop();
  const outlinePoints = buildTrackOutline(projectedNodes, 12);
  const basePlate = buildBasePlate(outlinePoints, 50);
  return buildTrackModel({
    outlinePoints,
    basePlate,
    projectedNodes,
    trackName: 'Test Loop',
    coasterMode: false,
    coasterShape: 'round',
    primaryOrientationDeg: 0,
  });
}

test('validateModel reports parts in fixed base/secondary/track order', async () => {
  const report = validateModel(await buildModel());
  assert.deepEqual(report.parts.map(p => p.part), ['base', 'secondary', 'track']);
});

test('validateModel includes empty parts with zero findings that never break ok', async () => {
  const report = validateModel(await buildModel());
  // The synthetic non-coaster model has no secondary track.
  const secondary = report.parts.find(p => p.part === 'secondary')!;
  assert.equal(secondary.triangleCount, 0);
  assert.deepEqual(secondary.nonManifoldEdges, []);
  assert.deepEqual(secondary.degenerateTriangles, []);
  assert.deepEqual(secondary.tJunctions, []);
  // #115: an empty part has no triangles, so findShellComponents([]) is [] (length 0).
  assert.deepEqual(secondary.selfIntersections, []);
  assert.deepEqual(secondary.flippedFaces, []);
  assert.equal(secondary.shellComponentCount, 0);
});

test('validateModel reports a tJunctions array on every part', async () => {
  const report = validateModel(await buildModel());
  for (const part of report.parts) {
    assert.ok(Array.isArray(part.tJunctions), `${part.part} has a tJunctions array`);
  }
});

test('validateModel exposes #115 detector fields on every part', async () => {
  const report = validateModel(await buildModel());
  for (const part of report.parts) {
    assert.ok(Array.isArray(part.selfIntersections), `${part.part} has a selfIntersections array`);
    assert.ok(Array.isArray(part.flippedFaces), `${part.part} has a flippedFaces array`);
    // Empty parts legitimately yield 0; healthy non-empty parts yield 1; the DEFECT rule
    // (used by the sweep/assertions) is strictly `> 1`. Assert ONLY the type here.
    assert.equal(typeof part.shellComponentCount, 'number', `${part.part} has a numeric shellComponentCount`);
  }
});

test('validateModel.ok is true iff every part has zero non-manifold edges and degenerates', async () => {
  const report = validateModel(await buildModel());
  const expected = report.parts.every(
    p => p.nonManifoldEdges.length === 0 && p.degenerateTriangles.length === 0,
  );
  assert.equal(report.ok, expected);
  assert.equal(report.ok, true);
});
