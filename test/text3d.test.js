import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_THICKNESS_MM } from '../src/model.js';
import { TEXT_HEIGHT_MM, buildTextMesh } from '../src/text3d.js';

function rectangleCommands(x, y, width, height) {
  return [
    { type: 'M', x, y },
    { type: 'L', x: x + width, y },
    { type: 'L', x: x + width, y: y + height },
    { type: 'L', x, y: y + height },
    { type: 'Z' },
  ];
}

function createMockFont() {
  return {
    getPath(text, startX, startY, fontSize) {
      const commands = [];
      let cursor = startX;

      for (const character of text) {
        if (character === ' ') {
          cursor += fontSize * 0.4;
          continue;
        }

        if (character === 'O') {
          commands.push(...rectangleCommands(cursor, startY, fontSize, fontSize * 1.2));
          commands.push(...rectangleCommands(cursor + fontSize * 0.28, startY + fontSize * 0.28, fontSize * 0.44, fontSize * 0.64));
        } else {
          commands.push(...rectangleCommands(cursor, startY, fontSize, fontSize * 1.2));
        }

        cursor += fontSize * 1.2;
      }

      return { commands };
    },
  };
}

function largeHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 2500 },
      { x: 0, y: 2500 },
    ],
    holes: [[
      { x: 700, y: 650 },
      { x: 3300, y: 650 },
      { x: 3300, y: 1850 },
      { x: 700, y: 1850 },
    ]],
  };
}

function smallHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 100 },
      { x: 0, y: 100 },
    ],
    holes: [[
      { x: 120, y: 30 },
      { x: 180, y: 30 },
      { x: 180, y: 60 },
      { x: 120, y: 60 },
    ]],
  };
}

test('buildTextMesh generates embossed text inside a large infield', () => {
  const triangles = buildTextMesh(
    'GO',
    largeHoleOutline(),
    { minX: -100, maxX: 4100, minY: -100, maxY: 2600, width: 4200, height: 2700 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles.length > 0);
});

test('buildTextMesh skips unreadable text when the infield is too small', () => {
  const triangles = buildTextMesh(
    'MONACO STREET CIRCUIT',
    smallHoleOutline(),
    { minX: 0, maxX: 300, minY: 0, maxY: 100, width: 300, height: 100 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.deepEqual(triangles, []);
});

test('buildTextMesh keeps all embossed vertices within the text z range', () => {
  const triangles = buildTextMesh(
    'GO',
    largeHoleOutline(),
    { minX: -100, maxX: 4100, minY: -100, maxY: 2600, width: 4200, height: 2700 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles.length > 0);
  assert.ok(triangles.every(triangle => triangle.every(vertex => vertex.z >= BASE_THICKNESS_MM)));
  assert.ok(triangles.every(triangle => triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM + TEXT_HEIGHT_MM)));
});

test('buildTextMesh returns non-empty triangles for a known good input', () => {
  const triangles = buildTextMesh(
    'SILVERSTONE',
    largeHoleOutline(),
    { minX: -100, maxX: 4100, minY: -100, maxY: 2600, width: 4200, height: 2700 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles.length > 0);
});
