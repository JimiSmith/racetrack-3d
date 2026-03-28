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
  const basePlateTriangles = model.triangles.slice(0, 12);
  const trackTriangles = model.triangles.slice(12);

  assert.ok(basePlateTriangles.length > 0);
  assert.ok(trackTriangles.length > 0);
  assert.ok(basePlateTriangles.every(triangle => triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)));
  assert.ok(trackTriangles.some(triangle => triangle.some(vertex => vertex.z > BASE_THICKNESS_MM)));
});

test('computeScale fits the base plate inside a 200mm bounding box', () => {
  const scale = computeScale({ width: 400, height: 150 });

  assert.equal(scale, 0.5);
  assert.ok(400 * scale <= 200);
  assert.ok(150 * scale <= 200);
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
