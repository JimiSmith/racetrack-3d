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
    minZ: Math.min(bounds.minZ, vertex.z),
    maxZ: Math.max(bounds.maxZ, vertex.z),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  });
}

function span(bounds) {
  return {
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}

function boundsCenter(bounds) {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
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

function tallNarrowHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 2000 },
      { x: 0, y: 2000 },
    ],
    holes: [[
      { x: 425, y: 200 },
      { x: 575, y: 200 },
      { x: 575, y: 1800 },
      { x: 425, y: 1800 },
    ]],
  };
}

function rankedHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 2400, y: 0 },
      { x: 2400, y: 1800 },
      { x: 0, y: 1800 },
    ],
    holes: [
      [
        { x: 200, y: 200 },
        { x: 900, y: 200 },
        { x: 900, y: 700 },
        { x: 200, y: 700 },
      ],
      [
        { x: 1500, y: 200 },
        { x: 2200, y: 200 },
        { x: 2200, y: 700 },
        { x: 1500, y: 700 },
      ],
      [
        { x: 850, y: 1000 },
        { x: 1550, y: 1000 },
        { x: 1550, y: 1500 },
        { x: 850, y: 1500 },
      ],
    ],
  };
}

function textTriangles(model) {
  return model.triangles.slice(model.baseTriangleCount + model.trackTriangleCount);
}

function trackTriangles(model) {
  return model.triangles.slice(model.baseTriangleCount, model.baseTriangleCount + model.trackTriangleCount);
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

function textBounds(model) {
  return triangleBounds(textTriangles(model));
}

function uniqueVertices(triangles, minZ = -Infinity) {
  const vertices = new Map();

  for (const triangle of triangles) {
    for (const vertex of triangle) {
      if (vertex.z < minZ) {
        continue;
      }

      vertices.set(
        `${vertex.x.toFixed(6)},${vertex.y.toFixed(6)},${vertex.z.toFixed(6)}`,
        vertex,
      );
    }
  }

  return [...vertices.values()];
}

function topTrackVertices(model) {
  return uniqueVertices(trackTriangles(model), BASE_THICKNESS_MM + 1);
}

function crossSectionEdgeVertices(vertices, targetX, tolerance = 1e-3) {
  const sectionVertices = vertices
    .filter(vertex => Math.abs(vertex.x - targetX) <= tolerance)
    .sort((a, b) => a.y - b.y);

  assert.ok(sectionVertices.length >= 2, `expected at least two vertices near x=${targetX}`);

  return {
    minY: sectionVertices[0],
    maxY: sectionVertices[sectionVertices.length - 1],
  };
}

function buildElevatedStraightTrackModel() {
  return buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: [
      { x: 0, y: 0, elevation: 0 },
      { x: 100, y: 0, elevation: 20 },
    ],
  });
}

function parseBinaryStlBounds(buffer) {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  let offset = 84;

  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
    offset += 12;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex += 1) {
      const x = view.getFloat32(offset, true);
      const y = view.getFloat32(offset + 4, true);
      const z = view.getFloat32(offset + 8, true);
      bounds.minX = Math.min(bounds.minX, x);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.minZ = Math.min(bounds.minZ, z);
      bounds.maxZ = Math.max(bounds.maxZ, z);
      offset += 12;
    }
    offset += 2;
  }

  return bounds;
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

test('buildTrackModel preserves longitudinal elevation along the track top surface', () => {
  const model = buildElevatedStraightTrackModel();
  const topVertices = topTrackVertices(model);
  const startSection = crossSectionEdgeVertices(topVertices, 0, 1e-3);
  const endSection = crossSectionEdgeVertices(topVertices, 100 * model.scale, 1e-3);
  const expectedRise = 20 * model.scale;

  approxEqual(endSection.minY.z - startSection.minY.z, expectedRise, 1e-3);
  assert.ok(endSection.minY.z > startSection.minY.z);
});

test('buildTrackModel keeps each local top cross-section level across the track width', () => {
  const model = buildElevatedStraightTrackModel();
  const topVertices = topTrackVertices(model);
  const startSection = crossSectionEdgeVertices(topVertices, 0, 1e-3);
  const endSection = crossSectionEdgeVertices(topVertices, 100 * model.scale, 1e-3);

  approxEqual(startSection.minY.z, startSection.maxY.z, 1e-6);
  approxEqual(endSection.minY.z, endSection.maxY.z, 1e-6);
});

test('buildTrackModel keeps elevated preview geometry aligned with STL export bounds', () => {
  const model = buildElevatedStraightTrackModel();
  const previewBounds = triangleBounds(model.triangles);
  const exportBounds = parseBinaryStlBounds(exportStl(model, 'elevated-track').buffer);

  approxEqual(previewBounds.minX, exportBounds.minX, 1e-4);
  approxEqual(previewBounds.maxX, exportBounds.maxX, 1e-4);
  approxEqual(previewBounds.minY, exportBounds.minY, 1e-4);
  approxEqual(previewBounds.maxY, exportBounds.maxY, 1e-4);
  approxEqual(previewBounds.minZ, exportBounds.minZ, 1e-4);
  approxEqual(previewBounds.maxZ, exportBounds.maxZ, 1e-4);
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

  const model0 = buildTrackModel({ outlinePoints, basePlate, trackName: 'DAYTONA ROAD COURSE', orientationDeg: 0, textPositionRank: 3 });
  const model90 = buildTrackModel({ outlinePoints, basePlate, trackName: 'DAYTONA ROAD COURSE', orientationDeg: 90, textPositionRank: 3 });

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

test('buildTrackModel keeps auto text orientation flexible but makes explicit rotations strict', () => {
  const outlinePoints = tallNarrowHoleOutline();
  const basePlate = buildBasePlate(outlinePoints, 50);

  const autoModel = buildTrackModel({ outlinePoints, basePlate, trackName: 'IMOLA' });
  const explicitModel = buildTrackModel({ outlinePoints, basePlate, trackName: 'IMOLA', primaryOrientationDeg: 0 });

  assert.equal(autoModel.primaryOrientationDeg, 'auto');
  assert.equal(autoModel.textOrientationMode, 'auto');
  assert.equal(explicitModel.primaryOrientationDeg, 0);
  assert.equal(explicitModel.textOrientationMode, 'fixed');
  assert.ok(autoModel.textTriangleCount > 0);
  assert.ok(explicitModel.textTriangleCount > 0);

  const autoBounds = triangleBounds(textTriangles(autoModel));
  const explicitBounds = triangleBounds(textTriangles(explicitModel));

  assert.ok(
    autoBounds.maxY - autoBounds.minY > (explicitBounds.maxY - explicitBounds.minY) * 5,
    'expected auto mode to use the taller 90 degree fit while explicit mode stays in the fixed orientation',
  );
});

test('buildTrackModel threads text position rank through preview and STL export geometry', () => {
  const outlinePoints = rankedHoleOutline();
  const basePlate = buildBasePlate(outlinePoints, 60);

  const firstModel = buildTrackModel({ outlinePoints, basePlate, trackName: 'GO', textPositionRank: 1 });
  const secondModel = buildTrackModel({ outlinePoints, basePlate, trackName: 'GO', textPositionRank: 2 });
  const exportedSecond = exportStl(secondModel, 'ranked-position');

  const firstCenter = boundsCenter(textBounds(firstModel));
  const secondCenter = boundsCenter(textBounds(secondModel));
  const previewBounds = triangleBounds(secondModel.triangles);
  const exportBounds = parseBinaryStlBounds(exportedSecond.buffer);

  assert.equal(firstModel.textPositionRank, 1);
  assert.equal(secondModel.textPositionRank, 2);
  assert.ok(firstCenter.x < secondCenter.x, `expected rank 2 text to move right, got ${firstCenter.x} and ${secondCenter.x}`);
  approxEqual(previewBounds.minX, exportBounds.minX, 1e-4);
  approxEqual(previewBounds.maxX, exportBounds.maxX, 1e-4);
  approxEqual(previewBounds.minY, exportBounds.minY, 1e-4);
  approxEqual(previewBounds.maxY, exportBounds.maxY, 1e-4);
  approxEqual(previewBounds.minZ, exportBounds.minZ, 1e-4);
  approxEqual(previewBounds.maxZ, exportBounds.maxZ, 1e-4);
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
