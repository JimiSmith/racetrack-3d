import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate } from '../src/geometry.js';
import {
  buildTrackModel,
  __resetModelPerfCounters,
  __getModelPerfCounters,
  __disableModelPerfCounters,
} from '../src/model.js';
import {
  __resetPerfCounters,
  __getPerfCounters,
  __disablePerfCounters,
} from '../src/text3d.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Portrait track — triggers auto-orientation (will test all 4 orientations)
function tallNarrowHoleOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 2000, y: 0 },
      { x: 2000, y: 4000 },
      { x: 0, y: 4000 },
    ],
    holes: [[
      { x: 425, y: 400 },
      { x: 1575, y: 400 },
      { x: 1575, y: 3600 },
      { x: 425, y: 3600 },
    ]],
  };
}

// Landscape outline — auto-orientation still runs but 0° should win easily
function landscapeOutline() {
  return {
    outerRing: [
      { x: 0, y: 0 },
      { x: 2400, y: 0 },
      { x: 2400, y: 1800 },
      { x: 0, y: 1800 },
    ],
    holes: [[
      { x: 200, y: 200 },
      { x: 900, y: 200 },
      { x: 900, y: 700 },
      { x: 200, y: 700 },
    ]],
  };
}

// Oval circuit with projectedNodes — tests the projectedNodes path
function ovalCircuitNodes(segments = 64) {
  const nodes = [];
  const radiusX = 300;
  const radiusY = 150;
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    nodes.push({
      x: radiusX * Math.cos(angle),
      y: radiusY * Math.sin(angle),
      elevation: 0,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Issue 2: Duplicate buildTrackOutline for winning orientation
// ---------------------------------------------------------------------------

test('perf: buildTrackOutline calls during auto-orientation (outline-based)', () => {
  const outline = tallNarrowHoleOutline();
  const basePlate = buildBasePlate(outline, 50);

  __resetModelPerfCounters();
  __resetPerfCounters();
  const model = buildTrackModel({
    outlinePoints: outline,
    basePlate,
    trackName: 'IMOLA',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();
  __disableModelPerfCounters();
  __disablePerfCounters();

  assert.ok(model.triangles.length > 0);

  // With outline-based input (no projectedNodes), buildTrackOutline is NOT called
  // because orientTrackGeometry uses rotateOutlineByOrientation instead.
  // But selectAutoOrientation still checks projectedNodes first and falls through.
  console.log('--- Issue 2: buildTrackOutline calls (outline-based, portrait) ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  selectAutoOrientation calls:       ${modelCounters.selectAutoOrientation}`);
  console.log(`  buildTrackPrismMesh calls:          ${modelCounters.buildTrackPrismMesh}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  Auto-orientation resolved to:       ${model.orientationDeg}°`);

  // Auto-orientation should fire since no explicit orientation provided
  assert.equal(model.primaryOrientationDeg, 'auto');
  assert.equal(modelCounters.selectAutoOrientation, 1);
  // With outline-based input, buildTrackOutline is not called (rotateOutlineByOrientation is used)
  assert.equal(modelCounters.buildTrackOutline, 0);
  // Text placements: 4 from auto-orientation, winner reused (no redundant 5th call)
  assert.equal(textCounters.computeRankedTextPlacements, 4);
});

test('perf: buildTrackOutline calls during auto-orientation (projectedNodes)', () => {
  const nodes = ovalCircuitNodes();

  __resetModelPerfCounters();
  __resetPerfCounters();
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();
  __disableModelPerfCounters();
  __disablePerfCounters();

  assert.ok(model.triangles.length > 0);

  // With projectedNodes, selectAutoOrientation calls buildTrackOutline for:
  //   - 1x base outline (line ~570)
  //   - 4x rotated outlines (once per candidate orientation)
  // buildTrackModel now reuses the winning orientation's geometry from selectAutoOrientation,
  // so no additional buildTrackOutline call is needed.
  // Total: 5 calls (was 6 before the fix).
  console.log('--- Issue 2: buildTrackOutline calls (projectedNodes, oval) ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  selectAutoOrientation calls:       ${modelCounters.selectAutoOrientation}`);
  console.log(`  buildTrackPrismMesh calls:          ${modelCounters.buildTrackPrismMesh}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  Auto-orientation resolved to:       ${model.orientationDeg}°`);
  console.log('');
  console.log(`  Previous (before fix):             6 (duplicate for winning orientation)`);
  console.log(`  Current:                           ${modelCounters.buildTrackOutline} (no duplicate)`);

  assert.equal(model.primaryOrientationDeg, 'auto');
  assert.equal(modelCounters.selectAutoOrientation, 1);

  // No duplicate: winning orientation outline is reused from selectAutoOrientation.
  assert.equal(modelCounters.buildTrackOutline, 5,
    'should be 5 buildTrackOutline calls (1 base + 4 orientations, no duplicate)');
});

test('perf: buildTrackOutline calls with explicit orientation (no auto)', () => {
  const nodes = ovalCircuitNodes();

  __resetModelPerfCounters();
  __resetPerfCounters();
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
    primaryOrientationDeg: 90,
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();
  __disableModelPerfCounters();
  __disablePerfCounters();

  assert.ok(model.triangles.length > 0);

  // With explicit orientation, selectAutoOrientation is skipped.
  // buildTrackOutline is called only once in orientTrackGeometry.
  console.log('--- Issue 2: buildTrackOutline calls (explicit orientation, baseline) ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  selectAutoOrientation calls:       ${modelCounters.selectAutoOrientation}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);

  assert.equal(modelCounters.selectAutoOrientation, 0);
  assert.equal(modelCounters.buildTrackOutline, 1,
    'explicit orientation should only build outline once');
});

test('perf: computeRankedTextPlacements calls during auto-orientation (no cache token)', () => {
  const nodes = ovalCircuitNodes();

  __resetPerfCounters();
  __resetModelPerfCounters();
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
  });
  const textCounters = __getPerfCounters();
  __disablePerfCounters();

  assert.ok(model.textTriangleCount > 0);

  // selectAutoOrientation computes 4 orientations. buildTrackModel now reuses the
  // winning orientation's result directly (via autoPlacementsForWinner), so no 5th call.
  console.log('--- Issue 2: computeRankedTextPlacements during auto-orientation (no cache) ---');
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  computePlacementMask calls:         ${textCounters.computePlacementMask}`);
  console.log(`  findPlacementCandidates calls:      ${textCounters.findPlacementCandidates}`);
  console.log(`  rankTextPlacements calls:           ${textCounters.rankTextPlacements}`);
  console.log('');
  console.log('  Previous (before fix):              5 (4 + 1 redundant)');
  console.log('  Current:                            4 (winning orientation reused)');

  assert.equal(textCounters.computeRankedTextPlacements, 4,
    'auto-orientation should compute text placements exactly 4 times, no redundant 5th call');
});

test('perf: computeRankedTextPlacements calls during auto-orientation (with cache token)', () => {
  const nodes = ovalCircuitNodes();
  const token = {};

  __resetPerfCounters();
  __resetModelPerfCounters();
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
    placementCacheToken: token,
  });
  const textCounters = __getPerfCounters();
  __disablePerfCounters();

  assert.ok(model.textTriangleCount > 0);

  // With a cache token, selectAutoOrientation's 4 results are stored, and
  // buildTrackModel hits the cache for the winning orientation — 4 total.
  console.log('--- Issue 2: computeRankedTextPlacements during auto-orientation (cached) ---');
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  computePlacementMask calls:         ${textCounters.computePlacementMask}`);
  console.log(`  findPlacementCandidates calls:      ${textCounters.findPlacementCandidates}`);
  console.log(`  rankTextPlacements calls:           ${textCounters.rankTextPlacements}`);
  console.log('');
  console.log('  Each of the 4 calls independently computes placement mask, candidates,');
  console.log('  and ranks all candidates. Text layout work inside rankTextPlacements');
  console.log('  is then multiplied by Issue 1 (fitTextToRectangle per candidate).');

  assert.equal(textCounters.computeRankedTextPlacements, 4,
    'with cache token: 4 from auto-orientation, 0 redundant from buildTrackModel');
});

// ---------------------------------------------------------------------------
// Issue 2 timing: wall-clock for buildTrackOutline
// ---------------------------------------------------------------------------

test('perf: wall-clock cost of buildTrackOutline (Turf buffer)', async () => {
  const { buildTrackOutline } = await import('../src/geometry.js');
  const nodes = ovalCircuitNodes();

  // Warm up
  buildTrackOutline(nodes);

  const iterations = 10;
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    buildTrackOutline(nodes);
    timings.push(performance.now() - start);
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];

  console.log('--- Issue 2: wall-clock cost of buildTrackOutline ---');
  console.log(`  Median over ${iterations} runs: ${median.toFixed(1)} ms`);
  console.log(`  All timings: [${timings.map(t => t.toFixed(1)).join(', ')}] ms`);
  console.log(`  Each duplicate call wastes ~${median.toFixed(1)} ms`);

  assert.ok(median >= 0);
});

test('perf: wall-clock cost of full buildTrackModel with auto-orientation', () => {
  const nodes = ovalCircuitNodes();

  // Warm up
  buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'WARM',
    primaryOrientationDeg: 0,
  });

  const iterations = 3;
  const autoTimings = [];
  const explicitTimings = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    buildTrackModel({
      outlinePoints: null,
      basePlate: null,
      projectedNodes: nodes,
      trackName: 'INDIANAPOLIS',
    });
    autoTimings.push(performance.now() - start);
  }

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    buildTrackModel({
      outlinePoints: null,
      basePlate: null,
      projectedNodes: nodes,
      trackName: 'INDIANAPOLIS',
      primaryOrientationDeg: 0,
    });
    explicitTimings.push(performance.now() - start);
  }

  autoTimings.sort((a, b) => a - b);
  explicitTimings.sort((a, b) => a - b);
  const autoMedian = autoTimings[Math.floor(autoTimings.length / 2)];
  const explicitMedian = explicitTimings[Math.floor(explicitTimings.length / 2)];

  console.log('--- Issue 2: wall-clock buildTrackModel auto vs explicit ---');
  console.log(`  Auto-orientation median:    ${autoMedian.toFixed(1)} ms (tests 4 orientations)`);
  console.log(`  Explicit orientation median: ${explicitMedian.toFixed(1)} ms (single orientation)`);
  console.log(`  Ratio:                       ${(autoMedian / explicitMedian).toFixed(1)}x`);

  assert.ok(autoMedian >= 0);
  assert.ok(explicitMedian >= 0);
});
