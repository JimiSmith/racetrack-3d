import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate } from '../src/geometry.js';
import { BASE_THICKNESS_MM, buildTrackModel, computeScale, exportStl } from '../src/model.js';

function syntheticOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 80 },
      { x: 0, y: 80 },
    ],
    holes: [],
  };
}

function triangleBounds(triangles) {
  return triangles.flat().reduce((bounds, vertex) => ({
    minX: Math.min(bounds.minX, vertex.x),
    maxX: Math.max(bounds.maxX, vertex.x),
    minY: Math.min(bounds.minY, vertex.y),
    maxY: Math.max(bounds.maxY, vertex.y),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  });
}

function span(bounds) {
  return {
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function offsetHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 1200, y: 0 },
      { x: 1200, y: 700 },
      { x: 0, y: 700 },
    ],
    holes: [[
      { x: 180, y: 140 },
      { x: 360, y: 140 },
      { x: 360, y: 350 },
      { x: 180, y: 350 },
    ]],
  };
}

function textTriangles(model) {
  return model.triangles.slice(model.baseTriangleCount + model.trackTriangleCount);
}

function rotateTrianglesByOrientation(triangles, orientationDeg) {
  return triangles.map(triangle => triangle.map(vertex => {
    switch (orientationDeg) {
      case 90:
        return { ...vertex, x: -vertex.y, y: vertex.x };
      case 180:
        return { ...vertex, x: -vertex.x, y: -vertex.y };
      case 270:
        return { ...vertex, x: vertex.y, y: -vertex.x };
      default:
        return { ...vertex };
    }
  }));
}

function approxEqual(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function withMockedDownloadDom(callback) {
  const originalDocument = globalThis.document;
  const originalUrl = globalThis.URL;
  const clicks = [];
  const appended = [];
  const removed = [];
  const revoked = [];
  const link = {
    href: '',
    download: '',
    style: {},
    click() {
      clicks.push(this.download);
    },
    remove() {
      removed.push(this.download);
    },
  };

  globalThis.document = {
    createElement(tagName) {
      assert.equal(tagName, 'a');
      return link;
    },
    body: {
      appendChild(node) {
        appended.push(node);
      },
    },
  };
  globalThis.URL = {
    createObjectURL(blob) {
      assert.ok(blob instanceof Blob);
      return 'blob:test';
    },
    revokeObjectURL(url) {
      revoked.push(url);
    },
  };

  return Promise.resolve(callback({ clicks, appended, removed, revoked }))
    .then(async result => {
      await new Promise(resolve => setTimeout(resolve, 0));
      return result;
    })
    .finally(() => {
      globalThis.document = originalDocument;
      globalThis.URL = originalUrl;
    });
}

test('buildTrackModel returns triangles and a positive finite scale', () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);

  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  assert.ok(Array.isArray(model.triangles));
  assert.ok(model.triangles.length > 0);
  assert.ok(Number.isFinite(model.scale));
  assert.ok(model.scale > 0);
});

test('buildTrackModel keeps base plate triangles at or below the base thickness and includes raised track triangles', () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });
  const basePlateTriangles = model.triangles.slice(0, model.baseTriangleCount);
  const trackTriangles = model.triangles.slice(model.baseTriangleCount);

  assert.ok(basePlateTriangles.length > 0);
  assert.ok(trackTriangles.length > 0);
  assert.ok(model.trackTriangleCount > 0);
  assert.ok(model.textTriangleCount > 0);
  assert.ok(basePlateTriangles.every(triangle => triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)));
  assert.ok(trackTriangles.some(triangle => triangle.some(vertex => vertex.z > BASE_THICKNESS_MM)));
});

test('buildTrackModel keeps embossed text after the track segment and out of the base segment', () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const baseTriangles = model.triangles.slice(0, model.baseTriangleCount);
  const textTriangles = model.triangles.slice(model.baseTriangleCount + model.trackTriangleCount);

  assert.equal(baseTriangles.length, model.baseTriangleCount);
  assert.equal(textTriangles.length, model.textTriangleCount);
  assert.ok(textTriangles.length > 0);
  assert.ok(textTriangles.some(triangle => triangle.some(vertex => vertex.z > BASE_THICKNESS_MM)));
  assert.ok(baseTriangles.every(triangle => triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)));
});

test('computeScale fits the base plate inside a 200mm bounding box', () => {
  const scale = computeScale({ width: 400, height: 150 });

  assert.equal(scale, 0.5);
  assert.ok(400 * scale <= 200);
  assert.ok(150 * scale <= 200);
});

test('buildTrackModel rotates geometry bounds in 90 degree increments', () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);

  const model0 = buildTrackModel({ outlinePoints, basePlate, orientationDeg: 0 });
  const model90 = buildTrackModel({ outlinePoints, basePlate, orientationDeg: 90 });
  const model180 = buildTrackModel({ outlinePoints, basePlate, orientationDeg: 180 });
  const model270 = buildTrackModel({ outlinePoints, basePlate, orientationDeg: 270 });

  const span0 = span(triangleBounds(model0.triangles));
  const span90 = span(triangleBounds(model90.triangles));
  const span180 = span(triangleBounds(model180.triangles));
  const span270 = span(triangleBounds(model270.triangles));

  approxEqual(span0.width, span180.width);
  approxEqual(span0.height, span180.height);
  approxEqual(span90.width, span270.width);
  approxEqual(span90.height, span270.height);
  approxEqual(span0.width, span90.height);
  approxEqual(span0.height, span90.width);
  assert.notEqual(span0.width, span90.width);
  assert.equal(model90.orientationDeg, 90);
  assert.equal(model180.orientationDeg, 180);
  assert.equal(model270.orientationDeg, 270);
});

test('buildTrackModel reruns text placement when primary orientation changes', () => {
  const outlinePoints = offsetHoleOutline();
  const basePlate = buildBasePlate(outlinePoints, 50);

  const model0 = buildTrackModel({ outlinePoints, basePlate, trackName: 'DAYTONA ROAD COURSE', orientationDeg: 0 });
  const model90 = buildTrackModel({ outlinePoints, basePlate, trackName: 'DAYTONA ROAD COURSE', orientationDeg: 90 });

  const bounds0 = triangleBounds(textTriangles(model0));
  const bounds90 = triangleBounds(textTriangles(model90));
  const derotatedBounds90 = triangleBounds(rotateTrianglesByOrientation(textTriangles(model90), 270));

  assert.ok(model0.textTriangleCount > 0);
  assert.ok(model90.textTriangleCount > 0);
  assert.notDeepEqual(bounds0, bounds90);
  assert.ok(
    Math.abs(bounds0.minX - derotatedBounds90.minX) > 1
      || Math.abs(bounds0.maxX - derotatedBounds90.maxX) > 1
      || Math.abs(bounds0.minY - derotatedBounds90.minY) > 1
      || Math.abs(bounds0.maxY - derotatedBounds90.maxY) > 1,
    'expected text placement to be recomputed instead of only rotating the final mesh',
  );
});

test('exportStl returns download metadata with a blob, buffer, and filename', async () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  await withMockedDownloadDom(async ({ clicks, appended, removed }) => {
    const result = exportStl(model, 'Synthetic Raceway');

    assert.equal(result.filename, 'synthetic-raceway.stl');
    assert.equal(result.fileName, 'synthetic-raceway.stl');
    assert.ok(result.blob instanceof Blob);
    assert.ok(result.buffer instanceof ArrayBuffer);
    assert.ok(result.byteLength > 0);
    assert.equal(result.triangleCount, model.triangles.length);
    assert.equal(clicks.length, 1);
    assert.equal(appended.length, 1);
    assert.equal(removed.length, 1);
  });
});
