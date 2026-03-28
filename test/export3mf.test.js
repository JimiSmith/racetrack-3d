import assert from 'node:assert/strict';
import test from 'node:test';

import { strFromU8, unzipSync } from 'fflate';

import { buildBasePlate } from '../src/geometry.js';
import { buildTrackModel } from '../src/model.js';
import { export3mf } from '../src/export3mf.js';

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

function extractModelXml(archive) {
  return strFromU8(archive['3D/3dmodel.model']);
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
