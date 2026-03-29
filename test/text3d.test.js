import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_THICKNESS_MM } from '../src/model.js';
import { rotateOutlineByOrientation } from '../src/orientation.js';
import { TEXT_HEIGHT_MM, TEXT_ORIENTATION_FIXED, buildTextMesh } from '../src/text3d.js';

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

function createCanvasCoordinateLFont() {
  return {
    getPath() {
      return {
        commands: [
          ...rectangleCommands(0, 0, 0.2, 1.2),
          ...rectangleCommands(0, 0.95, 0.85, 0.25),
        ],
      };
    },
  };
}

function triangleArea2d(a, b, c) {
  return Math.abs(
    (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2,
  );
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

function sumTopFaceAreaByHalf(triangles) {
  const topZ = Math.max(...triangles.flatMap(triangle => triangle.map(vertex => vertex.z)));
  const topFaceTriangles = triangles.filter(triangle => triangle.every(vertex => vertex.z === topZ));
  const ys = topFaceTriangles.flatMap(triangle => triangle.map(vertex => vertex.y));
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

  return topFaceTriangles.reduce((areas, [a, b, c]) => {
    const centroidY = (a.y + b.y + c.y) / 3;
    const area = triangleArea2d(a, b, c);

    if (centroidY <= midY) {
      areas.lower += area;
    } else {
      areas.upper += area;
    }

    return areas;
  }, { lower: 0, upper: 0 });
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

function centeredHoleOutline({ width = 2000, height = 2000, holeMinX, holeMaxX, holeMinY, holeMaxY }) {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    holes: [[
      { x: holeMinX, y: holeMinY },
      { x: holeMaxX, y: holeMinY },
      { x: holeMaxX, y: holeMaxY },
      { x: holeMinX, y: holeMaxY },
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

test('buildTextMesh restores upright glyph orientation from canvas-style font paths', () => {
  const triangles = buildTextMesh(
    'L',
    largeHoleOutline(),
    { minX: -100, maxX: 4100, minY: -100, maxY: 2600, width: 4200, height: 2700 },
    0.05,
    { font: createCanvasCoordinateLFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles.length > 0);

  const { lower, upper } = sumTopFaceAreaByHalf(triangles);
  assert.ok(lower > upper, `expected more top-face area in the lower half, got lower=${lower} upper=${upper}`);
});

test('buildTextMesh uses multiline fitting when a single line would be unreadable', () => {
  const outline = centeredHoleOutline({
    width: 1200,
    height: 700,
    holeMinX: 300,
    holeMaxX: 900,
    holeMinY: 200,
    holeMaxY: 500,
  });

  const triangles = buildTextMesh(
    'LAS VEGAS STRIP CIRCUIT',
    outline,
    { minX: 0, maxX: 1200, minY: 0, maxY: 700, width: 1200, height: 700 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles.length > 0);
});

test('buildTextMesh auto mode can choose 90 degree text orientation when fixed mode cannot fit', () => {
  const outline = centeredHoleOutline({
    width: 1000,
    height: 2000,
    holeMinX: 425,
    holeMaxX: 575,
    holeMinY: 200,
    holeMaxY: 1800,
  });

  const autoTriangles = buildTextMesh(
    'IMOLA',
    outline,
    { minX: 0, maxX: 1000, minY: 0, maxY: 2000, width: 1000, height: 2000 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );
  const fixedTriangles = buildTextMesh(
    'IMOLA',
    outline,
    { minX: 0, maxX: 1000, minY: 0, maxY: 2000, width: 1000, height: 2000 },
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM, textOrientationMode: TEXT_ORIENTATION_FIXED },
  );

  assert.ok(autoTriangles.length > 0);
  assert.deepEqual(fixedTriangles, []);
});

test('buildTextMesh recomputes placement in the rotated search space', () => {
  const outline0 = centeredHoleOutline({
    width: 1200,
    height: 700,
    holeMinX: 360,
    holeMaxX: 840,
    holeMinY: 210,
    holeMaxY: 280,
  });
  const basePlate0 = { minX: -50, maxX: 1250, minY: -50, maxY: 750, width: 1300, height: 800 };
  const outline90 = rotateOutlineByOrientation(outline0, 90);
  const basePlate90 = { minX: -750, maxX: 50, minY: -50, maxY: 1250, width: 800, height: 1300 };

  const triangles0 = buildTextMesh(
    'LAS VEGAS STRIP CIRCUIT',
    outline0,
    basePlate0,
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );
  const triangles90 = buildTextMesh(
    'LAS VEGAS STRIP CIRCUIT',
    outline90,
    basePlate90,
    0.05,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(triangles0.length > 0);
  assert.ok(triangles90.length > 0);

  const bounds0 = triangleBounds(triangles0);
  const bounds90 = triangleBounds(triangles90);
  const derotatedBounds90 = triangleBounds(rotateTrianglesByOrientation(triangles90, 270));

  assert.notEqual(bounds0.minX, bounds90.minX);
  assert.ok(
    Math.abs(bounds0.minY - derotatedBounds90.minY) > 1
      || Math.abs(bounds0.maxY - derotatedBounds90.maxY) > 1,
    'expected rotated placement search to produce a different fitted result',
  );
});
