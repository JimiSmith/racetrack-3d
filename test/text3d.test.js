import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_THICKNESS_MM } from '../src/model.js';
import { rotateOutlineByOrientation } from '../src/orientation.js';
import {
  TEXT_HEIGHT_MM,
  TEXT_ORIENTATION_FIXED,
  __debugTextPlacement,
  __enumerateSequentialTextLineBreaks,
  buildTextMesh,
} from '../src/text3d.js';

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

function boundsCenter(bounds) {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function collapseWhitespace(text) {
  return String(text).trim().split(/\s+/u).filter(Boolean).join(' ');
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

function fallbackHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 1200 },
      { x: 0, y: 1200 },
    ],
    holes: [
      [
        { x: 200, y: 200 },
        { x: 800, y: 200 },
        { x: 800, y: 800 },
        { x: 200, y: 800 },
      ],
      [
        { x: 1200, y: 200 },
        { x: 1800, y: 200 },
        { x: 1800, y: 800 },
        { x: 1200, y: 800 },
      ],
    ],
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

test('line-break candidate generation preserves exact sequential word order', () => {
  const candidates = __enumerateSequentialTextLineBreaks('Las Vegas Strip Circuit', 2);

  assert.deepEqual(candidates, [
    'Las\nVegas Strip Circuit',
    'Las Vegas\nStrip Circuit',
    'Las Vegas Strip\nCircuit',
  ]);
  assert.ok(candidates.every(candidate => collapseWhitespace(candidate) === 'Las Vegas Strip Circuit'));
});

test('multiline fitting preserves exact word order across different line counts', () => {
  const wideOutline = centeredHoleOutline({
    width: 240,
    height: 140,
    holeMinX: 20,
    holeMaxX: 220,
    holeMinY: 40,
    holeMaxY: 100,
  });
  const narrowOutline = centeredHoleOutline({
    width: 150,
    height: 220,
    holeMinX: 40,
    holeMaxX: 110,
    holeMinY: 20,
    holeMaxY: 200,
  });
  const wideBasePlate = { minX: 0, minY: 0, maxX: 240, maxY: 140, width: 240, height: 140 };
  const narrowBasePlate = { minX: 0, minY: 0, maxX: 150, maxY: 220, width: 150, height: 220 };
  const font = createMockFont();

  const wideLayout = __debugTextPlacement(
    'Las Vegas Strip Circuit',
    wideOutline,
    wideBasePlate,
    1,
    { font, baseThickness: BASE_THICKNESS_MM },
  );
  const narrowLayout = __debugTextPlacement(
    'Las Vegas Strip Circuit',
    narrowOutline,
    narrowBasePlate,
    1,
    { font, baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(wideLayout);
  assert.ok(narrowLayout);
  assert.equal(collapseWhitespace(wideLayout.text), 'Las Vegas Strip Circuit');
  assert.equal(collapseWhitespace(narrowLayout.text), 'Las Vegas Strip Circuit');
  assert.ok(narrowLayout.lines.length >= wideLayout.lines.length);
});

test('placement rank and orientation mode do not alter word order', () => {
  const outline = rankedHoleOutline();
  const basePlate = { minX: 0, maxX: 2400, minY: 0, maxY: 1800, width: 2400, height: 1800 };
  const rankText = 'Las Vegas Strip Circuit';
  const orientationText = 'Imola Circuit';

  const firstRank = __debugTextPlacement(rankText, outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1,
  });
  const secondRank = __debugTextPlacement(rankText, outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 2,
  });
  const autoOrientation = __debugTextPlacement(orientationText, centeredHoleOutline({
    width: 1000,
    height: 2000,
    holeMinX: 425,
    holeMaxX: 575,
    holeMinY: 200,
    holeMaxY: 1800,
  }), { minX: 0, maxX: 1000, minY: 0, maxY: 2000, width: 1000, height: 2000 }, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
  });
  const fixedOrientation = __debugTextPlacement(orientationText, rankedHoleOutline(), basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textOrientationMode: TEXT_ORIENTATION_FIXED,
  });

  for (const [layout, expectedText] of [
    [firstRank, rankText],
    [secondRank, rankText],
    [autoOrientation, orientationText],
    [fixedOrientation, orientationText],
  ]) {
    assert.ok(layout);
    assert.equal(collapseWhitespace(layout.text), expectedText);
    assert.equal(layout.text, layout.lines.join('\n'));
  }
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

test('buildTextMesh uses the selected ranked placement candidate', () => {
  const outline = rankedHoleOutline();
  const basePlate = { minX: 0, maxX: 2400, minY: 0, maxY: 1800, width: 2400, height: 1800 };

  const first = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1,
  });
  const second = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 2,
  });
  const third = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 3,
  });

  const firstCenter = boundsCenter(triangleBounds(first));
  const secondCenter = boundsCenter(triangleBounds(second));
  const thirdCenter = boundsCenter(triangleBounds(third));

  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.ok(third.length > 0);
  assert.ok(firstCenter.x < secondCenter.x, `expected rank 1 to sit left of rank 2, got ${firstCenter.x} and ${secondCenter.x}`);
  assert.ok(thirdCenter.y > firstCenter.y, `expected rank 3 to sit below rank 1, got ${thirdCenter.y} and ${firstCenter.y}`);
});

test('buildTextMesh falls back to the best available ranked candidate', () => {
  const outline = fallbackHoleOutline();
  const basePlate = { minX: 0, maxX: 2000, minY: 0, maxY: 1200, width: 2000, height: 1200 };

  const second = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 2,
  });
  const third = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 3,
  });

  assert.ok(second.length > 0);
  assert.deepEqual(third, second);
});
