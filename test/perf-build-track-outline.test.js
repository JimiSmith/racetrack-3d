import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate } from '../src/geometry/outline.js';
import {
  buildTrackModel,
  __resetModelPerfCounters,
  __getModelPerfCounters,
  __disableModelPerfCounters,
} from '../src/model/index.js';
import {
  __resetPerfCounters,
  __getPerfCounters,
  __disablePerfCounters,
} from '../src/text3d.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function disableAllPerfCounters() {
  __disableModelPerfCounters();
  __disablePerfCounters();
}

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

test('perf: buildTrackOutline calls during auto-orientation (outline-based)', (t) => {
  const outline = tallNarrowHoleOutline();
  const basePlate = buildBasePlate(outline, 50);

  __resetModelPerfCounters();
  __resetPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: outline,
    basePlate,
    trackName: 'IMOLA',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();

  assert.ok(model.triangles.length > 0);

  console.log('--- Issue 2: buildTrackOutline calls (outline-based, portrait) ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  selectAutoOrientation calls:       ${modelCounters.selectAutoOrientation}`);
  console.log(`  buildTrackPrismMesh calls:          ${modelCounters.buildTrackPrismMesh}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  Auto-orientation resolved to:       ${model.orientationDeg}°`);

  assert.equal(model.primaryOrientationDeg, 'auto');
  assert.equal(modelCounters.selectAutoOrientation, 1);
  assert.equal(modelCounters.buildTrackOutline, 0);
  assert.equal(textCounters.computeRankedTextPlacements, 4);
});

test('perf: buildTrackOutline calls during auto-orientation (projectedNodes)', (t) => {
  const nodes = ovalCircuitNodes();

  __resetModelPerfCounters();
  __resetPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();

  assert.ok(model.triangles.length > 0);

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
  assert.equal(modelCounters.buildTrackOutline, 5,
    'should be 5 buildTrackOutline calls (1 base + 4 orientations, no duplicate)');
});

test('perf: buildTrackOutline calls with explicit orientation (no auto)', (t) => {
  const nodes = ovalCircuitNodes();

  __resetModelPerfCounters();
  __resetPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
    primaryOrientationDeg: 90,
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();

  assert.ok(model.triangles.length > 0);

  console.log('--- Issue 2: buildTrackOutline calls (explicit orientation, baseline) ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  selectAutoOrientation calls:       ${modelCounters.selectAutoOrientation}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);

  assert.equal(modelCounters.selectAutoOrientation, 0);
  assert.equal(modelCounters.buildTrackOutline, 1,
    'explicit orientation should only build outline once');
});

test('perf: computeRankedTextPlacements calls during auto-orientation (no cache token)', (t) => {
  const nodes = ovalCircuitNodes();

  __resetPerfCounters();
  __resetModelPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
  });
  const textCounters = __getPerfCounters();

  assert.ok(model.textTriangleCount > 0);

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

test('perf: computeRankedTextPlacements calls during auto-orientation (with cache token)', (t) => {
  const nodes = ovalCircuitNodes();
  const token = {};

  __resetPerfCounters();
  __resetModelPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
    placementCacheToken: token,
  });
  const textCounters = __getPerfCounters();

  assert.ok(model.textTriangleCount > 0);

  console.log('--- Issue 2: computeRankedTextPlacements during auto-orientation (cached) ---');
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);
  console.log(`  computePlacementMask calls:         ${textCounters.computePlacementMask}`);
  console.log(`  findPlacementCandidates calls:      ${textCounters.findPlacementCandidates}`);
  console.log(`  rankTextPlacements calls:           ${textCounters.rankTextPlacements}`);

  assert.equal(textCounters.computeRankedTextPlacements, 4,
    'with cache token: 4 from auto-orientation, 0 redundant from buildTrackModel');
});

// ---------------------------------------------------------------------------
// Issue 2 timing: wall-clock for buildTrackOutline
// ---------------------------------------------------------------------------

test('perf: wall-clock cost of buildTrackOutline (Turf buffer)', async () => {
  const { buildTrackOutline } = await import('../src/geometry/outline.js');
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

// ---------------------------------------------------------------------------
// Edge cases and correctness
// ---------------------------------------------------------------------------

test('perf: empty track name with auto-orientation does not crash', (t) => {
  const nodes = ovalCircuitNodes();

  __resetModelPerfCounters();
  __resetPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: '',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();

  assert.ok(model.triangles.length > 0, 'model should have triangles even without a name');
  assert.equal(model.textTriangleCount, 0, 'no text triangles for empty name');
  assert.equal(model.primaryOrientationDeg, 'auto');
  assert.equal(modelCounters.selectAutoOrientation, 1);
  assert.equal(textCounters.computeRankedTextPlacements, 4);
});

test('perf: combined mode with secondary layouts counts outline calls correctly', (t) => {
  const primary = ovalCircuitNodes(32);
  // Secondary is a smaller oval offset to the side
  const secondary = ovalCircuitNodes(32).map(n => ({ ...n, x: n.x + 700 }));

  __resetModelPerfCounters();
  __resetPerfCounters();
  t.after(disableAllPerfCounters);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: primary,
    secondaryProjectedNodes: [secondary],
    trackName: 'COMBINED TEST',
  });
  const modelCounters = __getModelPerfCounters();
  const textCounters = __getPerfCounters();

  assert.ok(model.triangles.length > 0);
  assert.ok(model.secondaryTrackTriangleCount > 0, 'should have secondary track triangles');
  assert.equal(model.primaryOrientationDeg, 'auto');
  assert.equal(modelCounters.selectAutoOrientation, 1);

  // selectAutoOrientation: 1 base outline + 4 × (1 primary + 1 secondary) = 9
  // No extra calls from buildTrackModel (geometry reused).
  console.log('--- Combined mode: buildTrackOutline calls ---');
  console.log(`  buildTrackOutline calls:           ${modelCounters.buildTrackOutline}`);
  console.log(`  computeRankedTextPlacements calls:  ${textCounters.computeRankedTextPlacements}`);

  assert.equal(modelCounters.buildTrackOutline, 9,
    '1 base + 4×(1 primary + 1 secondary) = 9 buildTrackOutline calls');
  assert.equal(textCounters.computeRankedTextPlacements, 4,
    '4 orientations, winner reused');
});

test('perf: auto-orientation output matches explicit orientation output', () => {
  const outline = tallNarrowHoleOutline();
  const basePlate = buildBasePlate(outline, 50);

  const autoModel = buildTrackModel({ outlinePoints: outline, basePlate, trackName: 'IMOLA' });
  const resolvedDeg = autoModel.orientationDeg;

  const explicitModel = buildTrackModel({
    outlinePoints: outline,
    basePlate,
    trackName: 'IMOLA',
    primaryOrientationDeg: resolvedDeg,
  });

  assert.equal(autoModel.baseTriangleCount, explicitModel.baseTriangleCount,
    'base triangle count should match');
  assert.equal(autoModel.trackTriangleCount, explicitModel.trackTriangleCount,
    'track triangle count should match');
  assert.equal(autoModel.textTriangleCount, explicitModel.textTriangleCount,
    'text triangle count should match');
  assert.equal(autoModel.triangles.length, explicitModel.triangles.length,
    'total triangle count should match');
  assert.equal(autoModel.scale, explicitModel.scale, 'scale should match');
});

test('perf: auto-orientation with projectedNodes output matches explicit', () => {
  const nodes = ovalCircuitNodes();

  const autoModel = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
  });
  const resolvedDeg = autoModel.orientationDeg;

  const explicitModel = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    projectedNodes: nodes,
    trackName: 'INDIANAPOLIS',
    primaryOrientationDeg: resolvedDeg,
  });

  assert.equal(autoModel.baseTriangleCount, explicitModel.baseTriangleCount,
    'base triangle count should match');
  assert.equal(autoModel.trackTriangleCount, explicitModel.trackTriangleCount,
    'track triangle count should match');
  assert.equal(autoModel.textTriangleCount, explicitModel.textTriangleCount,
    'text triangle count should match');
  assert.equal(autoModel.scale, explicitModel.scale, 'scale should match');
});

// This test uses a caller-supplied basePlate with extra margin that differs from
// the outline's tight bounding box. This stresses the basePlate alignment between
// selectAutoOrientation and orientTrackGeometry — if the two paths compute
// basePlate differently, auto and explicit will produce different scales.
test('perf: auto-orientation basePlate alignment with non-default margin', () => {
  const outline = tallNarrowHoleOutline();
  // Use a much larger margin than buildBasePlate's default (50).
  // This creates a basePlate whose bounds differ significantly from buildBasePlate(outline).
  const basePlate = buildBasePlate(outline, 200);

  const autoModel = buildTrackModel({ outlinePoints: outline, basePlate, trackName: 'IMOLA' });
  const resolvedDeg = autoModel.orientationDeg;

  const explicitModel = buildTrackModel({
    outlinePoints: outline,
    basePlate,
    trackName: 'IMOLA',
    primaryOrientationDeg: resolvedDeg,
  });

  // If basePlate computation diverges, scale will differ because
  // computeScale depends on the basePlate dimensions.
  assert.equal(autoModel.scale, explicitModel.scale,
    'scale should match when caller supplies a custom basePlate');
  assert.equal(autoModel.baseTriangleCount, explicitModel.baseTriangleCount,
    'base triangle count should match with custom basePlate');
  assert.equal(autoModel.trackTriangleCount, explicitModel.trackTriangleCount,
    'track triangle count should match with custom basePlate');
  assert.equal(autoModel.textTriangleCount, explicitModel.textTriangleCount,
    'text triangle count should match with custom basePlate');
});
