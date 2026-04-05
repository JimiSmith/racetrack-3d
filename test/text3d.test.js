import assert from 'node:assert/strict';
import test from 'node:test';

import { BASE_THICKNESS_MM } from '../src/model.js';
import { rotateOutlineByOrientation } from '../src/orientation.js';
import {
  TEXT_HEIGHT_MM,
  __debugTextPlacement,
  __debugTextFitModifiers,
  __debugCompareRankedTextPlacements,
  __debugPlacementCandidates,
  __debugAllPlacements,
  __debugRectIntersectsPolygon,
  __findOptimalLineBreaks,
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
    unitsPerEm: 1,
    charToGlyph(char) {
      return { advanceWidth: char === ' ' ? 0.4 : 1.2 };
    },
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

function assertRenderedLineOrder(layout) {
  assert.ok(layout);
  assert.equal(layout.lines.length, layout.lineBounds.length);

  const centers = layout.lineBounds.map(boundsCenter);
  for (let index = 1; index < centers.length; index += 1) {
    assert.ok(
      centers[index - 1].y > centers[index].y,
      `expected line ${index - 1} above line ${index}, got ${centers[index - 1].y} and ${centers[index].y}`,
    );
  }
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
  ].sort(__debugCompareRankedTextPlacements);

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
  assert.equal(Math.max(...candidates.map(candidate => candidate.widthCells)), 2);
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
  assertRenderedLineOrder(layout);
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
    [firstRank, rankText],
    [secondRank, rankText],
  ]) {
    assert.ok(layout);
    assert.equal(collapseWhitespace(layout.text), expectedText);
    assert.equal(layout.text, layout.lines.join('\n'));
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
  assert.ok(placement.candidateFractionOutside > 0.9);
  assert.ok(placement.candidateArea < largestInsideCandidate.area);
});

test('debug placements expose textClearanceMultiplier in the expected range', () => {
  const outline = largeHoleOutline();
  const basePlate = { minX: -200, maxX: 4200, minY: -200, maxY: 2700, width: 4400, height: 2900 };

  const orientations = __debugAllPlacements('Circuit Name', outline, basePlate, 1, {
    font: createMockFont(),
  });

  assert.ok(orientations);
  const allPlacements = orientations;
  assert.ok(allPlacements.length > 0, 'expected at least one placement');

  for (const placement of allPlacements) {
    assert.ok(
      typeof placement.textClearanceMultiplier === 'number',
      'textClearanceMultiplier should be a number',
    );
    assert.ok(
      placement.textClearanceMultiplier >= 0.96 && placement.textClearanceMultiplier <= 1.0,
      `textClearanceMultiplier ${placement.textClearanceMultiplier} should be in [0.96, 1.0]`,
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

  const shortText = __debugAllPlacements('GO', outline, basePlate, 1, {
    font: createMockFont(),
  });
  const longText = __debugAllPlacements('A Very Long Circuit Name', outline, basePlate, 1, {
    font: createMockFont(),
  });

  assert.ok(shortText);
  assert.ok(longText);

  const shortBest = shortText[0];
  const longBest = longText[0];

  assert.ok(shortBest, 'expected a placement for short text');
  assert.ok(longBest, 'expected a placement for long text');

  // Short text fills less of the rectangle, so it has more margin → higher text clearance
  assert.ok(
    shortBest.textClearanceMultiplier >= longBest.textClearanceMultiplier,
    `short text clearance ${shortBest.textClearanceMultiplier} should be >= long text clearance ${longBest.textClearanceMultiplier}`,
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

  const orientations = __debugAllPlacements('Hi', outline, basePlate, 1, {
    font: createMockFont(),
  });

  assert.ok(orientations);
  const best = orientations[0];
  assert.ok(best, 'expected a placement');
  assert.ok(
    best.textClearanceMultiplier > 0.96,
    `text far from track should have clearance above the 0.96 floor, got ${best.textClearanceMultiplier}`,
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
    const lines = __findOptimalLineBreaks('Las Vegas Strip Circuit', k, font);
    assert.equal(lines.length, k, `expected ${k} lines, got ${lines.length}`);
  }
});

test('DP line breaks preserve all words in order', () => {
  const font = createMockFont();
  for (let k = 1; k <= 3; k += 1) {
    const lines = __findOptimalLineBreaks('Las Vegas Strip Circuit', k, font);
    const reassembled = lines.join(' ');
    assert.equal(reassembled, 'Las Vegas Strip Circuit');
  }
});

test('DP line breaks avoid orphaning short words', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('Autodromo Internazionale del Mugello', 3, font);
  assert.equal(lines.length, 3);
  // "del" (3 chars) should not be isolated on its own line
  for (const line of lines) {
    const words = line.split(' ');
    if (words.length === 1) {
      assert.ok(
        words[0].length > 3,
        `Short word "${words[0]}" isolated on its own line: ${JSON.stringify(lines)}`,
      );
    }
  }
});

test('DP handles single word input', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('Monza', 1, font);
  assert.deepEqual(lines, ['Monza']);
});

test('DP handles word count equal to line count', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('A B C', 3, font);
  assert.equal(lines.length, 3);
  assert.equal(lines.join(' '), 'A B C');
});

test('DP handles 10+ word names efficiently', () => {
  const font = createMockFont();
  const longName = 'Autodromo Internazionale del Mugello Formula One Grand Prix Racing Circuit';
  const start = performance.now();
  for (let k = 1; k <= 4; k += 1) {
    const lines = __findOptimalLineBreaks(longName, k, font);
    assert.equal(lines.length, k);
    assert.equal(lines.join(' '), longName);
  }
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 100, `DP took ${elapsed.toFixed(1)}ms for 10-word name, expected < 100ms`);
});

test('DP produces balanced lines for even-width words', () => {
  const font = createMockFont();
  // 4 words of similar length into 2 lines should split evenly (2+2)
  const lines = __findOptimalLineBreaks('AAAA BBBB CCCC DDDD', 2, font);
  assert.equal(lines.length, 2);
  const wordsPerLine = lines.map(l => l.split(' ').length);
  assert.deepEqual(wordsPerLine, [2, 2]);
});

test('DP returns empty array for empty input', () => {
  const font = createMockFont();
  const lines = __findOptimalLineBreaks('', 2, font);
  assert.deepEqual(lines, []);
});
