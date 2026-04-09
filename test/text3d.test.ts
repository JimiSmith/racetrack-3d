import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_THICKNESS_MM } from '../src/model/index.js';
import { rotateOutlineByOrientation } from '../src/model/orientation.js';
import {
  TEXT_HEIGHT_MM,
  __debugTextPlacement,
  __debugTextFitModifiers,
  __debugScoreTextFit,
  __debugCompareRankedTextPlacements,
  __debugPlacementCandidates,
  __debugRectIntersectsPolygon,
  __findOptimalLineBreaks,
  buildTextMesh,
  computeRankedTextPlacements,
} from '../src/text3d.js';

type Point = { x: number; y: number };
type Vertex3D = { x: number; y: number; z: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function rectangleCommands(x: number, y: number, width: number, height: number) {
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
    unitsPerEm: 1000,
    charToGlyph(char: string) {
      return { advanceWidth: char === ' ' ? 400 : 1200 };
    },
    getPath(text: string, startX: number, startY: number, fontSize: number) {
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

function triangleArea2d(a: Point, b: Point, c: Point) {
  return Math.abs(
    (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2,
  );
}

function triangleBounds(triangles: Point[][]) {
  return triangles.flat().reduce((bounds: Bounds, vertex: Point) => ({
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

function boundsCenter(bounds: Bounds) {
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
}

function assertRenderedLineOrder(layout: { lines: string[]; lineBounds: Bounds[] }) {
  assert.ok(layout);
  assert.equal(layout.lines.length, layout.lineBounds.length);

  const centers = layout.lineBounds.map(boundsCenter);
  for (let index = 1; index < centers.length; index += 1) {
    assert.ok(
      centers[index - 1]!.y > centers[index]!.y,
      `expected line ${index - 1} above line ${index}, got ${centers[index - 1]!.y} and ${centers[index]!.y}`,
    );
  }
}

function collapseWhitespace(text: string) {
  return String(text).trim().split(/\s+/u).filter(Boolean).join(' ');
}

function rotateTrianglesByOrientation(triangles: Vertex3D[][], orientationDeg: number) {
  return triangles.map((triangle: Vertex3D[]) => triangle.map((vertex: Vertex3D) => {
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

function sumTopFaceAreaByHalf(triangles: Vertex3D[][]) {
  const topZ = Math.max(...triangles.flatMap((triangle: Vertex3D[]) => triangle.map((vertex: Vertex3D) => vertex.z)));
  const topFaceTriangles = triangles.filter((triangle: Vertex3D[]) => triangle.every((vertex: Vertex3D) => vertex.z === topZ));
  const ys = topFaceTriangles.flatMap((triangle: Vertex3D[]) => triangle.map((vertex: Vertex3D) => vertex.y));
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;

  return topFaceTriangles.reduce((areas: { lower: number; upper: number }, tri: Vertex3D[]) => {
    const a = tri[0]!;
    const b = tri[1]!;
    const c = tri[2]!;
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

function centeredHoleOutline({ width = 2000, height = 2000, holeMinX, holeMaxX, holeMinY, holeMaxY }: { width?: number; height?: number; holeMinX: number; holeMaxX: number; holeMinY: number; holeMaxY: number }) {
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

test('text fit modifiers apply the size window, line count, and outside bonuses', () => {
  const belowFloor = __debugTextFitModifiers(2, 1);
  const belowPreferred = __debugTextFitModifiers(4, 1);
  const inRange = __debugTextFitModifiers(6, 1);
  const aboveRange = __debugTextFitModifiers(12, 1);

  assert.equal(belowFloor.sizeWindowMultiplier, 0);
  assert.ok(belowPreferred.sizeWindowMultiplier > 0 && belowPreferred.sizeWindowMultiplier < 1);
  assert.ok(inRange.sizeWindowMultiplier > 0.6 && inRange.sizeWindowMultiplier <= 1.25);
  assert.ok(aboveRange.sizeWindowMultiplier < 1);
  assert.equal(__debugTextFitModifiers(6, 1).lineCountMultiplier, 1);
  assert.equal(__debugTextFitModifiers(6, 2).lineCountMultiplier, 1);
  assert.equal(__debugTextFitModifiers(6, 3).lineCountMultiplier, 0.94);
  assert.equal(__debugTextFitModifiers(6, 4).lineCountMultiplier, 0.91);
  assert.equal(__debugTextFitModifiers(6, 1, 0).outsideMultiplier, 0.25);
  assert.equal(__debugTextFitModifiers(6, 1, 1).outsideMultiplier, 1);
});

test('sizeWindowMultiplier curve is continuous at all zone boundaries', () => {
  // Zone 1: ≤ 2mm → 0
  assert.equal(__debugTextFitModifiers(2, 1).sizeWindowMultiplier, 0);
  assert.equal(__debugTextFitModifiers(1, 1).sizeWindowMultiplier, 0);

  // Zone 2 top (at MIN_PREFERRED_HEIGHT_MM ≈ 5.644mm) → 0.6
  const minPrefMm = 16 * 25.4 / 72;
  const atMinPref = __debugTextFitModifiers(minPrefMm, 1).sizeWindowMultiplier;
  assert.ok(Math.abs(atMinPref - 0.6) < 1e-9, `expected ~0.6 at MIN_PREFERRED, got ${atMinPref}`);

  // Zone 3 bottom (same point) → continuous with Zone 2
  // Zone 3 top (at MAX_PREFERRED_HEIGHT_MM ≈ 8.467mm) → 1.25
  const maxPrefMm = 24 * 25.4 / 72;
  const atMaxPref = __debugTextFitModifiers(maxPrefMm, 1).sizeWindowMultiplier;
  assert.ok(Math.abs(atMaxPref - 1.25) < 1e-9, `expected 1.25 at MAX_PREFERRED, got ${atMaxPref}`);

  // Zone 4 bottom (same point) → continuous with Zone 3
  // Zone 4 end (MAX_PREFERRED + zone2Span) → 0
  const zone2Span = minPrefMm - 2;
  const zone4End = maxPrefMm + zone2Span;
  const atZone4End = __debugTextFitModifiers(zone4End, 1).sizeWindowMultiplier;
  assert.ok(Math.abs(atZone4End - 0) < 1e-9, `expected 0 at zone4End, got ${atZone4End}`);

  // Above zone 4 end → 0
  assert.equal(__debugTextFitModifiers(zone4End + 1, 1).sizeWindowMultiplier, 0);
  assert.equal(__debugTextFitModifiers(20, 1).sizeWindowMultiplier, 0);
});

test('ranked placements sort by score, then candidate index', () => {
  const placements = [
    { id: 'lower-score', score: 9, candidateIndex: 2 },
    { id: 'best-score-lowest-candidate', score: 10, candidateIndex: 0 },
    { id: 'best-score-higher-candidate', score: 10, candidateIndex: 1 },
  ].sort((a, b) => __debugCompareRankedTextPlacements(a as any, b as any));

  assert.deepEqual(placements.map(({ id }) => id), [
    'best-score-lowest-candidate',
    'best-score-higher-candidate',
    'lower-score',
  ]);
});

test('placement candidates carry outside-circuit fractions', () => {
  const outline = centeredHoleOutline({
    width: 1200,
    height: 1200,
    holeMinX: 400,
    holeMaxX: 800,
    holeMinY: 400,
    holeMaxY: 800,
  });
  const candidates = __debugPlacementCandidates(outline, {
    minX: 0,
    minY: 0,
    maxX: 2000,
    maxY: 2000,
    width: 2000,
    height: 2000,
  }, 1);

  assert.ok(candidates.length > 0);
  assert.ok(candidates.some(candidate => candidate.fractionOutside > 0.9));
  assert.ok(candidates.some(candidate => candidate.fractionOutside < 0.5));
});

test('grid blocking marks cells whose rectangles intersect the track outline', () => {
  const outline = {
    outerRing: [
      { x: 11.8, y: 0 },
      { x: 12.2, y: 0 },
      { x: 12.2, y: 24 },
      { x: 11.8, y: 24 },
    ],
    holes: [] as Point[][],
  };

  const candidates = __debugPlacementCandidates(outline, {
    minX: 0,
    minY: 0,
    maxX: 24,
    maxY: 24,
    width: 24,
    height: 24,
  }, 1);

  assert.ok(candidates.length > 0);
  assert.equal(Math.max(...candidates.map(candidate => candidate.widthCells)), 4);
});

test('rect blocking treats polygons fully inside a cell as intersections', () => {
  const rect = { minX: 0, minY: 0, maxX: 3, maxY: 3 };
  const polygon = [
    { x: 0.75, y: 0.75 },
    { x: 1.5, y: 0.75 },
    { x: 1.25, y: 1.5 },
  ];

  assert.equal(__debugRectIntersectsPolygon(rect, polygon), true);
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

test('multiline line stacking preserves top-to-bottom order without rotation', () => {
  // A narrow infield (50mm wide) makes single-line text too small to fit the preferred
  // size range, so the 3-line grouping scores highest at rotation=0.
  const outline = centeredHoleOutline({
    width: 300,
    height: 200,
    holeMinX: 125,
    holeMaxX: 175,
    holeMinY: 20,
    holeMaxY: 180,
  });

  const layout = __debugTextPlacement(
    'Autodromo Nazionale di Monza',
    outline,
    { minX: 0, minY: 0, maxX: 300, maxY: 200, width: 300, height: 200 },
    1,
    { font: createMockFont(), baseThickness: BASE_THICKNESS_MM },
  );

  assert.ok(layout);
  assert.ok(layout.lines.length > 1, `expected multiline, got: ${JSON.stringify(layout.lines)}`);
  assert.equal(collapseWhitespace(layout.text), 'Autodromo Nazionale di Monza');
  assertRenderedLineOrder(layout as any);
});

test('placement rank does not alter word order', () => {
  const outline = rankedHoleOutline();
  const basePlate = { minX: 0, maxX: 2400, minY: 0, maxY: 1800, width: 2400, height: 1800 };
  const rankText = 'Las Vegas Strip Circuit';
  const font = createMockFont();

  const firstRank = __debugTextPlacement(rankText, outline, basePlate, 1, {
    font,
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1,
  });
  const secondRank = __debugTextPlacement(rankText, outline, basePlate, 1, {
    font,
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 2,
  });

  for (const [layout, expectedText] of [
    [firstRank, rankText] as const,
    [secondRank, rankText] as const,
  ]) {
    assert.ok(layout);
    assert.equal(collapseWhitespace(layout!.text), expectedText);
    assert.equal(layout!.text, layout!.lines.join('\n'));
  }
});

test('buildTextMesh recomputes placement in the rotated search space', () => {
  const outline0 = rankedHoleOutline();
  const basePlate0 = { minX: -50, maxX: 2450, minY: -50, maxY: 1850, width: 2500, height: 1900 };
  const outline90 = rotateOutlineByOrientation(outline0, 90);
  const basePlate90 = { minX: -1850, maxX: 50, minY: -50, maxY: 2450, width: 1900, height: 2500 };

  const triangles0 = buildTextMesh(
    'LAS VEGAS STRIP CIRCUIT',
    outline0,
    basePlate0,
    1,
    { baseThickness: BASE_THICKNESS_MM },
  );
  const triangles90 = buildTextMesh(
    'LAS VEGAS STRIP CIRCUIT',
    outline90,
    basePlate90,
    1,
    { baseThickness: BASE_THICKNESS_MM },
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

  const first = __debugTextPlacement('GO', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1,
  });
  const second = __debugTextPlacement('GO', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 2,
  });
  const third = __debugTextPlacement('GO', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 3,
  });

  const triangles = buildTextMesh('GO', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
  });

  assert.ok(triangles.length > 0);
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.ok(
    first.scale !== second.scale
      || first.candidateIndex !== second.candidateIndex
      || first.lines.join('\n') !== second.lines.join('\n'),
    'expected rank 1 and rank 2 to select different placements',
  );
  assert.ok(
    first.scale !== third.scale
      || first.candidateIndex !== third.candidateIndex
      || first.lines.join('\n') !== third.lines.join('\n'),
    'expected rank 1 and rank 3 to select different placements',
  );
});

test('buildTextMesh falls back to the best available ranked candidate', () => {
  const outline = fallbackHoleOutline();
  const basePlate = { minX: 0, maxX: 2000, minY: 0, maxY: 1200, width: 2000, height: 1200 };

  const last = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 999,
  });
  const beyond = buildTextMesh('GO', outline, basePlate, 0.05, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1000,
  });

  assert.ok(last.length > 0);
  assert.deepEqual(beyond, last);
});

test('placement score is a finite number, not NaN', () => {
  // Regression test: scoreTextFit was called with (rect, layout, candidate) but its signature
  // was (rect, layout, scaledBounds, candidate). The candidate object has no .width/.height,
  // so scaledBounds.width was undefined → utilization = NaN → score = NaN.
  // With NaN scores, ranking fell back to candidateIndex order (= largest area first),
  // always selecting the first/largest candidate regardless of the text size it produced.
  const outline = centeredHoleOutline({
    width: 1000,
    height: 1000,
    holeMinX: 300,
    holeMaxX: 700,
    holeMinY: 300,
    holeMaxY: 700,
  });
  const basePlate = { minX: 0, maxX: 1100, minY: 0, maxY: 1100, width: 1100, height: 1100 };

  const placement = __debugTextPlacement('Las Vegas Strip Circuit', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
  });

  assert.ok(placement);
  assert.ok(Number.isFinite(placement.score), `expected finite score, got ${placement.score}`);
});

test('fully outside candidates outrank larger fully inside candidates', () => {
  const outline = centeredHoleOutline({
    width: 1000,
    height: 1000,
    holeMinX: 250,
    holeMaxX: 750,
    holeMinY: 250,
    holeMaxY: 750,
  });
  const basePlate = { minX: 0, maxX: 1100, minY: 0, maxY: 1100, width: 1100, height: 1100 };

  const candidates = __debugPlacementCandidates(outline, basePlate, 1);
  const outsideCandidate = candidates.find(candidate => candidate.fractionOutside > 0.9);
  const largestInsideCandidate = candidates
    .filter(candidate => candidate.fractionOutside < 0.1)
    .sort((a, b) => b.area - a.area)[0];
  const placement = __debugTextPlacement('GO', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
    textPositionRank: 1,
  });

  assert.ok(outsideCandidate);
  assert.ok(largestInsideCandidate);
  assert.ok(outsideCandidate.area < largestInsideCandidate.area);
  assert.ok(placement);
  assert.ok(placement.candidateFractionOutside! > 0.9);
  assert.ok(placement.candidateArea! < largestInsideCandidate.area);
});

test('scored placements expose textClearanceMultiplier in the expected range', () => {
  const outline = largeHoleOutline();
  const basePlate = { minX: -200, maxX: 4200, minY: -200, maxY: 2700, width: 4400, height: 2900 };

  const result = computeRankedTextPlacements('Circuit Name', outline, basePlate, 1, {
    font: createMockFont() as any,
  });

  assert.ok(result);
  const allPlacements = result.allScoredPlacements!;
  assert.ok(allPlacements.length > 0, 'expected at least one placement');

  for (const placement of allPlacements) {
    const tcm = placement.scoreBreakdown?.textClearanceMultiplier;
    assert.ok(
      typeof tcm === 'number',
      'textClearanceMultiplier should be a number',
    );
    assert.ok(
      tcm >= 0.96 && tcm <= 1.0,
      `textClearanceMultiplier ${tcm} should be in [0.96, 1.0]`,
    );
  }
});

test('text clearance multiplier is higher when text has more breathing room from track', () => {
  const outline = centeredHoleOutline({
    width: 2000,
    height: 2000,
    holeMinX: 400,
    holeMaxX: 1600,
    holeMinY: 400,
    holeMaxY: 1600,
  });
  const basePlate = { minX: 0, maxX: 2200, minY: 0, maxY: 2200, width: 2200, height: 2200 };

  const shortResult = computeRankedTextPlacements('GO', outline, basePlate, 1, {
    font: createMockFont() as any,
  });
  const longResult = computeRankedTextPlacements('A Very Long Circuit Name', outline, basePlate, 1, {
    font: createMockFont() as any,
  });

  assert.ok(shortResult);
  assert.ok(longResult);

  const shortBest = shortResult.allScoredPlacements![0];
  const longBest = longResult.allScoredPlacements![0];

  assert.ok(shortBest, 'expected a placement for short text');
  assert.ok(longBest, 'expected a placement for long text');

  const shortTcm = shortBest.scoreBreakdown?.textClearanceMultiplier;
  const longTcm = longBest.scoreBreakdown?.textClearanceMultiplier;

  // Short text fills less of the rectangle, so it has more margin → higher text clearance
  assert.ok(
    shortTcm! >= longTcm!,
    `short text clearance ${shortTcm} should be >= long text clearance ${longTcm}`,
  );
});

test('text clearance multiplier is above the floor when text is far from the track', () => {
  // Large infield with a thin track border — text placed inside has meaningful clearance
  const outline = centeredHoleOutline({
    width: 6000,
    height: 6000,
    holeMinX: 100,
    holeMaxX: 5900,
    holeMinY: 100,
    holeMaxY: 5900,
  });
  const basePlate = { minX: -200, maxX: 6200, minY: -200, maxY: 6200, width: 6400, height: 6400 };

  const result = computeRankedTextPlacements('Hi', outline, basePlate, 1, {
    font: createMockFont() as any,
  });

  assert.ok(result);
  const best = result.allScoredPlacements![0];
  assert.ok(best, 'expected a placement');
  const tcm = best.scoreBreakdown?.textClearanceMultiplier;
  assert.ok(
    tcm! > 0.96,
    `text far from track should have clearance above the 0.96 floor, got ${tcm}`,
  );
});

test('placement score includes text clearance contribution and remains finite', () => {
  const outline = largeHoleOutline();
  const basePlate = { minX: -200, maxX: 4200, minY: -200, maxY: 2700, width: 4400, height: 2900 };

  const placement = __debugTextPlacement('Test Track', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
  });

  assert.ok(placement);
  assert.ok(Number.isFinite(placement.score), `expected finite score, got ${placement.score}`);
  assert.ok(placement.score > 0, 'score should be positive');
});

// --- DP line-breaking tests ---

test('DP line breaks return correct number of lines', () => {
  const font = createMockFont();
  for (let k = 1; k <= 4; k += 1) {
    const lines = __findOptimalLineBreaks('Las Vegas Strip Circuit', k, font) as string[];
    assert.equal(lines.length, k, `expected ${k} lines, got ${lines.length}`);
  }
});

test('DP line breaks preserve all words in order', () => {
  const font = createMockFont();
  for (let k = 1; k <= 3; k += 1) {
    const lines = __findOptimalLineBreaks('Las Vegas Strip Circuit', k, font) as string[];
    const reassembled = lines.join(' ');
    assert.equal(reassembled, 'Las Vegas Strip Circuit');
  }
});

test('DP line breaks avoid orphaning short words', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('Autodromo Internazionale del Mugello', 3, font) as string[];
  assert.equal(lines.length, 3);
  for (const line of lines) {
    const words = line.split(' ');
    if (words.length === 1) {
      assert.ok(
        words[0]!.length > 3,
        `Short word "${words[0]}" isolated on its own line: ${JSON.stringify(lines)}`,
      );
    }
  }
});

test('DP handles single word input', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('Monza', 1, font) as string[];
  assert.deepEqual(lines, ['Monza']);
});

test('DP handles word count equal to line count', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('A B C', 3, font) as string[];
  assert.equal(lines.length, 3);
  assert.equal(lines.join(' '), 'A B C');
});

test('DP handles 10+ word names efficiently', () => {
  const font = createMockFont();
  const longName = 'Autodromo Internazionale del Mugello Formula One Grand Prix Racing Circuit';
  const start = performance.now();
  for (let k = 1; k <= 4; k += 1) {
    const lines = __findOptimalLineBreaks(longName, k, font) as string[];
    assert.equal(lines.length, k);
    assert.equal(lines.join(' '), longName);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `DP took ${elapsed.toFixed(1)}ms for 10-word name, expected < 100ms`);
});

test('DP produces balanced lines for even-width words', () => {
  const font = createMockFont();
  // 4 words of similar length into 2 lines should split evenly (2+2)
  const lines = __findOptimalLineBreaks('AAAA BBBB CCCC DDDD', 2, font) as string[];
  assert.equal(lines.length, 2);
  const wordsPerLine = lines.map((l: string) => l.split(' ').length);
  assert.deepEqual(wordsPerLine, [2, 2]);
});

test('DP splits one word per line when lineCount equals word count', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('A B', 2, font) as string[];
  assert.deepEqual(lines, ['A', 'B']);
});

test('DP returns empty array for empty input', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('', 2, font) as string[];
  assert.deepEqual(lines, []);
});

test('DP clamps to one word per line when lineCount exceeds word count', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('A B', 5, font) as string[];
  assert.deepEqual(lines, ['A', 'B']);
});

test('orphan penalty prevents isolating a single short word on the last line', () => {
  const font = createMockFont();
  // "A B C DDD E" into 3 lines: pure raggedness prefers ["A B C", "DDD", "E"]
  // (cost 5.76) over ["A", "B C", "DDD E"] (cost 8.32) because the first split
  // is closer to the target width. The orphan penalty must override this since
  // "E" alone on the last line is an orphan (width / target = 0.29 < 0.65).
  const lines = __findOptimalLineBreaks('A B C DDD E', 3, font) as string[];
  assert.deepEqual(lines, ['A', 'B C', 'DDD E']);
});

test('orphan penalty does not penalise long single words on a line', () => {
  const font = createMockFont();
  // A long word alone on a line is not an orphan — its width exceeds the threshold.
  const lines = __findOptimalLineBreaks('Spa-Francorchamps Grand Prix', 2, font) as string[];
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), 'Spa-Francorchamps Grand Prix');
});

test('DP produces valid splits when all words render to zero width', () => {
  // Font that returns no path commands for any text
  const emptyFont = {
    unitsPerEm: 1000,
    charToGlyph() { return { advanceWidth: 0 }; },
    getPath() { return { commands: [] }; },
  };
  const lines = __findOptimalLineBreaks('A B C', 2, emptyFont) as string[];
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), 'A B C');
});

test('DP measures space width via fallback when charToGlyph is unavailable', () => {
  const font = createMockFont() as any;
  delete font.charToGlyph;
  delete font.unitsPerEm;
  const lines = __findOptimalLineBreaks('Las Vegas Strip Circuit', 2, font) as string[];
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), 'Las Vegas Strip Circuit');
});

test('line-balance damping: 2-line gets most damping, decreasing for more lines', () => {
  // A layout with poor raw balance (min/max = 0.3) should get progressively
  // less forgiveness as line count increases: 2-line > 3-line > 4-line.
  const rect = { minX: 0, minY: 0, maxX: 50, maxY: 20, width: 50, height: 20 };
  const baseLayout = {
    text: 'test',
    lines: ['test'],
    scale: 1,
    bounds: rect,
    lineBounds: [rect],
    contours: [],
    fittedWidth: 50,
    fittedHeight: 20,
    averageLineHeight: 6,
    maxLineWidth: 10,
    minLineWidth: 3, // raw balance = 0.3
    score: 0,
  };

  const score2 = __debugScoreTextFit(rect, { ...baseLayout, lineCount: 2 });
  const score3 = __debugScoreTextFit(rect, { ...baseLayout, lineCount: 3 });
  const score4 = __debugScoreTextFit(rect, { ...baseLayout, lineCount: 4 });

  // 2-line damping=0.75: balance = 0.3 + 0.7*0.75 = 0.825
  // 3-line damping=0.25: balance = 0.3 + 0.7*0.25 = 0.475
  // 4-line damping=0:    balance = 0.3
  assert.ok(
    score2.breakdown.lineBalance! > score3.breakdown.lineBalance!,
    `2-line balance (${score2.breakdown.lineBalance}) should exceed 3-line (${score3.breakdown.lineBalance})`,
  );
  assert.ok(
    score3.breakdown.lineBalance! > score4.breakdown.lineBalance!,
    `3-line balance (${score3.breakdown.lineBalance}) should exceed 4-line (${score4.breakdown.lineBalance})`,
  );
  assert.ok(
    Math.abs(score2.breakdown.lineBalance! - 0.825) < 0.001,
    `2-line balance should be ~0.825, got ${score2.breakdown.lineBalance}`,
  );
  assert.ok(
    Math.abs(score3.breakdown.lineBalance! - 0.475) < 0.001,
    `3-line balance should be ~0.475, got ${score3.breakdown.lineBalance}`,
  );
  assert.ok(
    Math.abs(score4.breakdown.lineBalance! - 0.3) < 0.001,
    `4-line balance should be ~0.3, got ${score4.breakdown.lineBalance}`,
  );
});

test('2-line split beats 3-line for "Circuit de Spa-Francorchamps"', () => {
  // Regression: inverted damping array caused 3-line ("Circuit"/"de"/"Spa-Francorchamps")
  // to outscore the natural 2-line split ("Circuit de"/"Spa-Francorchamps").
  // Use a narrow infield to force multi-line splitting.
  const outline = centeredHoleOutline({
    width: 400,
    height: 300,
    holeMinX: 160,
    holeMaxX: 240,
    holeMinY: 30,
    holeMaxY: 270,
  });
  const basePlate = { minX: 0, maxX: 400, minY: 0, maxY: 300, width: 400, height: 300 };

  const placement = __debugTextPlacement('Circuit de Spa-Francorchamps', outline, basePlate, 1, {
    font: createMockFont(),
    baseThickness: BASE_THICKNESS_MM,
  });

  assert.ok(placement);
  assert.ok(
    placement.lines.length <= 2,
    `expected at most 2-line split, got ${placement.lines.length}: ${placement.lines.join(' / ')}`,
  );
});
