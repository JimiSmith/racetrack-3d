import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBasePlate, buildTrackOutline } from '../src/geometry/outline.js';
import { computeScale } from '../src/model/index.js';
import {
  __resetPerfCounters,
  __getPerfCounters,
  __disablePerfCounters,
} from '../src/text/debug.js';
import { computeRankedTextPlacements } from '../src/text/index.js';

// ---------------------------------------------------------------------------
// Helpers — realistic track shapes
// ---------------------------------------------------------------------------

// Oval circuit — simple closed loop (like Indianapolis Motor Speedway outline)
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

// Rectangle with hole — simulates an outline-based track (no projectedNodes)
function outlineWithHole() {
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

// ---------------------------------------------------------------------------
// Issue 1: text layout pre-computation across candidates
// ---------------------------------------------------------------------------

test('perf: line breaks and contours are computed once regardless of candidate count', (t) => {
  const outline = outlineWithHole();
  const basePlate = buildBasePlate(outline, 50);
  const scale = computeScale(basePlate);

  __resetPerfCounters();
  t.after(() => __disablePerfCounters());
  const result = computeRankedTextPlacements('SILVERSTONE GRAND PRIX CIRCUIT', outline, basePlate, scale);
  const counters = __getPerfCounters()!;

  assert.ok(result, 'expected placements to be produced');

  const candidateCount = result.candidates.length;
  // "SILVERSTONE GRAND PRIX CIRCUIT" has 4 words → up to 4 line-count variants
  const maxLineVariants = 4;

  console.log('--- Issue 1: line breaks pre-computed once (outline-based) ---');
  console.log(`  Candidates evaluated:           ${candidateCount}`);
  console.log(`  findOptimalLineBreaks calls:     ${counters.findOptimalLineBreaks}`);
  console.log(`  buildMultilineContours calls:    ${counters.buildMultilineContours}`);
  console.log(`  Optimal:                         ${maxLineVariants} (one per line count)`);

  // Line breaks and contours should be computed exactly once per line-count variant,
  // regardless of how many candidates there are.
  assert.equal(counters.findOptimalLineBreaks, maxLineVariants,
    'findOptimalLineBreaks should run once per line-count variant');
  assert.equal(counters.buildMultilineContours, maxLineVariants,
    'buildMultilineContours should run once per line-count variant');
});

test('perf: line breaks pre-computed once with many candidates (oval circuit)', (t) => {
  const nodes = ovalCircuitNodes();
  const outline = buildTrackOutline(nodes);
  const basePlate = buildBasePlate(outline, 50);
  const scale = computeScale(basePlate);

  __resetPerfCounters();
  t.after(() => __disablePerfCounters());
  const result = computeRankedTextPlacements('CIRCUIT DE MONACO', outline, basePlate, scale);
  const counters = __getPerfCounters()!;

  assert.ok(result, 'expected placements to be produced');

  const candidateCount = result.candidates.length;
  // "CIRCUIT DE MONACO" has 3 words → up to 3 line-count variants
  const maxLineVariants = 3;

  console.log('--- Issue 1: line breaks pre-computed once (oval circuit) ---');
  console.log(`  Candidates evaluated:           ${candidateCount}`);
  console.log(`  findOptimalLineBreaks calls:     ${counters.findOptimalLineBreaks}`);
  console.log(`  buildMultilineContours calls:    ${counters.buildMultilineContours}`);
  console.log(`  Optimal:                         ${maxLineVariants}`);
  console.log(`  Previous (before fix):           ${candidateCount * maxLineVariants} (${candidateCount} candidates × ${maxLineVariants} variants)`);
  console.log(`  Improvement:                     ${candidateCount}x fewer calls`);

  assert.ok(candidateCount > 1, 'oval circuit should produce multiple candidates');
  assert.equal(counters.findOptimalLineBreaks, maxLineVariants,
    'findOptimalLineBreaks should run once per line-count variant, not per candidate');
  assert.equal(counters.buildMultilineContours, maxLineVariants,
    'buildMultilineContours should run once per line-count variant');
});

test('perf: line breaks pre-computed once with long multi-word name', (t) => {
  // Use the oval circuit which produces many candidates
  const nodes = ovalCircuitNodes();
  const outline = buildTrackOutline(nodes);
  const basePlate = buildBasePlate(outline, 50);
  const scale = computeScale(basePlate);

  __resetPerfCounters();
  t.after(() => __disablePerfCounters());
  const result = computeRankedTextPlacements(
    'AUTODROMO JOSE CARLOS PACE INTERLAGOS', outline, basePlate, scale,
  );
  const counters = __getPerfCounters()!;

  assert.ok(result, 'expected placements to be produced');

  const candidateCount = result.candidates.length;
  // 5 words → up to 4 line-count variants (MAX_TEXT_LINES=4)
  const maxLineVariants = 4;

  console.log('--- Issue 1: line breaks pre-computed once (long name, oval) ---');
  console.log(`  Candidates evaluated:           ${candidateCount}`);
  console.log(`  findOptimalLineBreaks calls:     ${counters.findOptimalLineBreaks}`);
  console.log(`  buildMultilineContours calls:    ${counters.buildMultilineContours}`);
  console.log(`  Optimal:                         ${maxLineVariants}`);
  console.log(`  Previous (before fix):           ${candidateCount * maxLineVariants}`);
  console.log(`  Improvement:                     ${candidateCount}x fewer calls`);

  assert.ok(candidateCount > 1, 'oval circuit should produce multiple candidates');
  assert.equal(counters.findOptimalLineBreaks, maxLineVariants,
    'findOptimalLineBreaks should run once per line-count variant');
  assert.equal(counters.buildMultilineContours, maxLineVariants,
    'buildMultilineContours should run once per line-count variant');
});

// ---------------------------------------------------------------------------
// Issue 1 timing: measure wall-clock cost of the redundancy
// ---------------------------------------------------------------------------

test('perf: wall-clock time for computeRankedTextPlacements', () => {
  const outline = outlineWithHole();
  const basePlate = buildBasePlate(outline, 50);
  const scale = computeScale(basePlate);
  const text = 'SILVERSTONE GRAND PRIX CIRCUIT';

  // Warm up (font loading etc.)
  computeRankedTextPlacements(text, outline, basePlate, scale);

  const iterations = 5;
  const timings = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    computeRankedTextPlacements(text, outline, basePlate, scale);
    timings.push(performance.now() - start);
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)]!;

  console.log('--- Issue 1: wall-clock timing for computeRankedTextPlacements ---');
  console.log(`  Median over ${iterations} runs: ${median.toFixed(1)} ms`);
  console.log(`  All timings: [${timings.map(t => t.toFixed(1)).join(', ')}] ms`);

  // Just record — no assertion on timing (varies by machine)
  assert.ok(median >= 0);
});
