import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { projectNodes } from '../src/geometry/projection.js';

function approxEqual(actual: number, expected: number, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function bbox(points: { x: number; y: number }[]) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  });
}

function area(bounds: { minX: number; maxX: number; minY: number; maxY: number }) {
  return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
}

function expectNoDuplicateSequentialPoints(points: { x: number; y: number }[]) {
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    assert.ok(previous.x !== current.x || previous.y !== current.y, `duplicate sequential points at ${index - 1}/${index}`);
  }
}

test('projectNodes converts lat/lon nodes into metre-space x/y values', () => {
  const nodes = [
    { lat: 10, lon: 20 },
    { lat: 10.001, lon: 20.002 },
  ];

  const projected = projectNodes(nodes);
  const cosLat = Math.cos((10.0005 * Math.PI) / 180);

  approxEqual(projected[0]!.x, -0.001 * cosLat * 111320, 1e-9);
  approxEqual(projected[1]!.x, 0.001 * cosLat * 111320, 1e-9);
  approxEqual(projected[0]!.y, -0.0005 * 111320, 1e-9);
  approxEqual(projected[1]!.y, 0.0005 * 111320, 1e-9);
});

test('buildTrackOutline returns outerRing and holes for straight and loop inputs', () => {
  const straightOutline = buildTrackOutline([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
  ], 12);
  const loopOutline = buildTrackOutline([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
  ], 12);

  assert.ok(Array.isArray(straightOutline.outerRing));
  assert.ok(Array.isArray(straightOutline.holes));
  assert.ok(straightOutline.outerRing.length >= 4);
  assert.equal(straightOutline.holes.length, 0);

  assert.ok(Array.isArray(loopOutline.outerRing));
  assert.ok(Array.isArray(loopOutline.holes));
  assert.ok(loopOutline.outerRing.length >= 4);
});

test('buildTrackOutline produces a wider outline for a larger buffer width', () => {
  const nodes = [
    { x: 0, y: 0 },
    { x: 150, y: 0 },
  ];

  const narrow = buildTrackOutline(nodes, 8);
  const wide = buildTrackOutline(nodes, 20);
  const narrowBox = bbox(narrow.outerRing);
  const wideBox = bbox(wide.outerRing);

  assert.ok((wideBox.maxY - wideBox.minY) > (narrowBox.maxY - narrowBox.minY));
  assert.ok((wideBox.maxX - wideBox.minX) > (narrowBox.maxX - narrowBox.minX));
});

test('buildTrackOutline avoids duplicate sequential points', () => {
  const outline = buildTrackOutline([
    { x: 0, y: 0 },
    { x: 0, y: 120 },
    { x: 120, y: 120 },
    { x: 120, y: 0 },
    { x: 0, y: 0 },
  ], 10);

  expectNoDuplicateSequentialPoints(outline.outerRing);
  outline.holes.forEach(expectNoDuplicateSequentialPoints);
});

test('buildBasePlate encloses the outline and accepts object or plain array input', () => {
  const outline = buildTrackOutline([
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 50 },
    { x: 0, y: 50 },
    { x: 0, y: 0 },
  ], 12);

  const fromObject = buildBasePlate(outline, 25);
  const fromArray = buildBasePlate(outline.outerRing, 25);
  const outlineBox = bbox(outline.outerRing);

  assert.deepEqual(fromObject, fromArray);
  assert.ok(fromObject.minX <= outlineBox.minX);
  assert.ok(fromObject.maxX >= outlineBox.maxX);
  assert.ok(fromObject.minY <= outlineBox.minY);
  assert.ok(fromObject.maxY >= outlineBox.maxY);
  assert.ok(fromObject.width * fromObject.height > area(outlineBox));
});
