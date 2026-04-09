import assert from 'node:assert/strict';
import test from 'node:test';

import { strFromU8, unzipSync } from 'fflate';

import { buildBasePlate } from '../src/geometry/outline.js';
import { splitModelTriangles } from '../src/model/triangle-groups.js';
import { buildTrackModel } from '../src/model/index.js';
import { export3mf } from '../src/export/threemf.js';

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

function extractModelXml(archive: Record<string, Uint8Array>) {
  return strFromU8(archive['3D/3dmodel.model']!);
}

type Vertex = { x: number; y: number; z: number };
type Bounds3D = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

function triangleBounds(triangles: Vertex[][]) {
  return triangles.flat().reduce<Bounds3D>((bounds, vertex) => ({
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

function vertexBoundsFromXml(xml: string) {
  return [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].reduce<Bounds3D>((bounds, [, x, y, z]) => ({
    minX: Math.min(bounds.minX, Number(x)),
    maxX: Math.max(bounds.maxX, Number(x)),
    minY: Math.min(bounds.minY, Number(y)),
    maxY: Math.max(bounds.maxY, Number(y)),
    minZ: Math.min(bounds.minZ, Number(z)),
    maxZ: Math.max(bounds.maxZ, Number(z)),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  });
}

function approxEqual(actual: number, expected: number, tolerance = 1e-4) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

test('export3mf returns a 3MF blob and filename', async () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const result = export3mf(model, 'Synthetic Raceway');

  assert.ok(result.blob instanceof Blob);
  assert.equal(result.fileName, 'synthetic-raceway.3mf');
  assert.match(result.fileName, /\.3mf$/);
  assert.equal(result.blob.type, 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip');

  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  assert.ok(archive['[Content_Types].xml']);
  assert.ok(archive['_rels/.rels']);
  assert.ok(archive['3D/3dmodel.model']);
});

test('export3mf colors base plate triangles black and track triangles red', async () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const result = export3mf(model, 'Synthetic Raceway.3mf');
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml = extractModelXml(archive);

  assert.match(xml, /<m:color color="#000000"\/>/);
  assert.match(xml, /<m:color color="#E8002D"\/>/);

  const blackTriangles = [...xml.matchAll(/<triangle[^>]*p1="0"\/>/g)];
  const redTriangles = [...xml.matchAll(/<triangle[^>]*p1="1"\/>/g)];

  assert.ok(blackTriangles.length > 0);
  assert.ok(redTriangles.length > 0);
});

test('splitModelTriangles keeps embossed text in the red track group', () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const { baseTriangles, trackTriangles } = splitModelTriangles(model);
  const textTriangles = model.triangles.slice(model.baseTriangleCount + model.trackTriangleCount);

  assert.equal(baseTriangles.length, model.baseTriangleCount);
  assert.equal(trackTriangles.length, model.trackTriangleCount + model.textTriangleCount);
  assert.ok(textTriangles.length > 0);
  assert.ok(textTriangles.every(triangle => trackTriangles.includes(triangle)));
});

test('export3mf colors embossed text triangles red', async () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const textTriangles = model.triangles.slice(model.baseTriangleCount + model.trackTriangleCount);
  const textVertexSet = new Set(
    textTriangles.flatMap(triangle => triangle.map(vertex => `${vertex.x.toFixed(4)},${vertex.y.toFixed(4)},${vertex.z.toFixed(4)}`)),
  );

  const result = export3mf(model, 'Synthetic Raceway.3mf');
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml = extractModelXml(archive);

  const redTriangles = [...xml.matchAll(/<triangle[^>]*v1="(\d+)"[^>]*v2="(\d+)"[^>]*v3="(\d+)"[^>]*p1="1"\/>/g)];
  const vertices = [...xml.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g)].map(([, x, y, z]) => `${x},${y},${z}`);

  const hasRedTextTriangle = redTriangles.some(([, v1, v2, v3]) => {
    const keys = [Number(v1), Number(v2), Number(v3)].map(index => vertices[index]!);
    return keys.every(key => textVertexSet.has(key));
  });

  assert.ok(hasRedTextTriangle);
});

test('export3mf deduplicates vertices in the model XML', async () => {
  const outlinePoints = syntheticOutline();
  const basePlate = buildBasePlate(outlinePoints, 20);
  const model = buildTrackModel({ outlinePoints, basePlate, trackName: 'Synthetic Raceway' });

  const result = export3mf(model, 'Synthetic Raceway');
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml = extractModelXml(archive);

  const vertexCount = [...xml.matchAll(/<vertex\s/g)].length;
  const triangleCount = [...xml.matchAll(/<triangle\s/g)].length;

  assert.ok(vertexCount > 0);
  assert.ok(triangleCount > 0);
  assert.ok(vertexCount < triangleCount * 3);
});

test('export3mf keeps preview geometry bounds aligned for rotated models', async () => {
  const outlinePoints = rankedHoleOutline();
  const basePlate = buildBasePlate(outlinePoints, 60);
  const model = buildTrackModel({
    outlinePoints,
    basePlate,
    trackName: 'GO',
    primaryOrientationDeg: 90,
    textPositionRank: 2,
  });

  const result = export3mf(model, 'Synthetic Raceway');
  const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const xml = extractModelXml(archive);

  const previewBounds = triangleBounds(model.triangles);
  const exportBounds = vertexBoundsFromXml(xml);

  approxEqual(previewBounds.minX, exportBounds.minX);
  approxEqual(previewBounds.maxX, exportBounds.maxX);
  approxEqual(previewBounds.minY, exportBounds.minY);
  approxEqual(previewBounds.maxY, exportBounds.maxY);
  approxEqual(previewBounds.minZ, exportBounds.minZ);
  approxEqual(previewBounds.maxZ, exportBounds.maxZ);
});
