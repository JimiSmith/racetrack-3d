import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPreviewGeometry } from '../src/preview/model-mesh.js';

type Vec3 = { x: number; y: number; z: number };

function readVector(attribute: { getX(index: number): number; getY(index: number): number; getZ(index: number): number }, index: number): Vec3 {
  return {
    x: attribute.getX(index),
    y: attribute.getY(index),
    z: attribute.getZ(index),
  };
}

function approxEqual(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function approxVector(actual: Vec3, expected: Vec3, tolerance = 1e-6) {
  approxEqual(actual.x, expected.x, tolerance);
  approxEqual(actual.y, expected.y, tolerance);
  approxEqual(actual.z, expected.z, tolerance);
}

test('buildPreviewGeometry smooths shared track faces while preserving sharp side edges', () => {
  const triangles: [Vec3, Vec3, Vec3][] = [
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { x: 0, y: 1, z: 1 },
    ],
    [
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 1, z: 0 },
      { x: 1, y: 1, z: 1 },
    ],
    [
      { x: 1, y: 0, z: -1 },
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 0, z: 0 },
    ],
  ];

  const geometry = buildPreviewGeometry(triangles);
  const normals = geometry.getAttribute('normal');

  assert.equal(geometry.index, null);
  assert.equal(normals.count, triangles.length * 3);

  const firstTopNormal = readVector(normals, 0);
  for (let index = 1; index < 6; index += 1) {
    approxVector(readVector(normals, index), firstTopNormal, 1e-6);
  }

  const firstSideNormal = readVector(normals, 6);
  for (let index = 7; index < 12; index += 1) {
    approxVector(readVector(normals, index), firstSideNormal, 1e-6);
  }

  assert.ok(Math.abs(firstTopNormal.x - firstSideNormal.x) > 0.5);
  assert.ok(Math.abs(firstTopNormal.z - firstSideNormal.z) > 0.5);
});
