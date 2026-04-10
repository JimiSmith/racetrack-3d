import assert from 'node:assert/strict';
import test from 'node:test';

import { __debugDedupeRankedPlacements } from '../src/text3d.js';
import type { RankedTextPlacement, Rect2D } from '../src/types/text.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRect(cx: number, cy: number, w = 10, h = 5): Rect2D {
  return { minX: cx - w / 2, maxX: cx + w / 2, minY: cy - h / 2, maxY: cy + h / 2, width: w, height: h };
}

function makePlacement(
  candidateIndex: number,
  cx: number,
  cy: number,
  lineCount: number,
  scale: number,
  score: number,
): RankedTextPlacement {
  return {
    candidateIndex,
    candidate: {
      left: 0, right: 1, top: 0, bottom: 1,
      widthCells: 1, heightCells: 1, areaCells: 1,
      fractionOutside: 0, trackClearance: 0, normalizedTrackClearance: 0,
      index: candidateIndex,
      bounds: makeRect(cx, cy),
      area: 50,
    },
    layout: {
      text: 'Test', lines: ['Test'], scale,
      lineCount, score: 0,
      bounds: makeRect(0, 0), lineBounds: [], contours: [],
      fittedWidth: 0, fittedHeight: 0, averageLineHeight: 0,
      maxLineWidth: 1, minLineWidth: 1,
    },
    score,
  };
}

/** 100×100 plate; maxDist = sqrt(100²+100²)/2 ≈ 70.71 */
const PLATE: Rect2D = { minX: 0, maxX: 100, minY: 0, maxY: 100, width: 100, height: 100 };

// ── Tests ─────────────────────────────────────────────────────────────────────

test('dedup: single placement passes through unchanged', () => {
  const p = makePlacement(0, 50, 50, 1, 1.0, 1.0);
  const result = __debugDedupeRankedPlacements([p], PLATE);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.candidateIndex, 0);
});

test('dedup: identical placements — only the first survives', () => {
  const p0 = makePlacement(0, 50, 50, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 50, 50, 1, 1.0, 0.9);

  const result = __debugDedupeRankedPlacements([p0, p1], PLATE);

  assert.equal(result.length, 1);
  assert.equal(result[0]!.candidateIndex, 0);
});

test('dedup: completely different placements — both survive', () => {
  // Different center, line count, scale — combined similarity well below threshold
  const p0 = makePlacement(0, 10, 10, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 90, 90, 2, 0.3, 0.9);

  const result = __debugDedupeRankedPlacements([p0, p1], PLATE);

  assert.equal(result.length, 2);
});

test('dedup: removed placement has similarityInfo pointing to the similar kept placement', () => {
  const p0 = makePlacement(0, 50, 50, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 50, 50, 1, 1.0, 0.9); // identical → removed

  __debugDedupeRankedPlacements([p0, p1], PLATE);

  assert.ok(p1.similarityInfo, 'removed placement should have similarityInfo set');
  assert.equal(p1.similarityInfo.tooSimilarToCandidateIndex, 0);
});

test('dedup: similarityInfo breakdown components are within expected ranges', () => {
  const p0 = makePlacement(0, 50, 50, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 50, 50, 1, 0.87, 0.9);

  __debugDedupeRankedPlacements([p0, p1], PLATE);

  const info = p1.similarityInfo!;
  assert.ok(info, 'should have similarityInfo');

  // Same line count → lineCountSim should be 1
  assert.equal(info.lineCountSim, 1);
  // Same center → centerSim should be 1
  assert.equal(info.centerSim, 1);
  // scale ratio: min(0.87, 1) / max(0.87, 1) = 0.87
  assert.ok(Math.abs(info.scaleSim - 0.87) < 0.001, `scaleSim should be ~0.87, got ${info.scaleSim}`);
  // combined: (1 + 1 + 0.87) / 3 ≈ 0.957
  assert.ok(info.total > 0.85, 'total similarity should exceed threshold');
  assert.ok(Math.abs(info.total - (1 + 1 + 0.87) / 3) < 0.001);
});

test('dedup: survived placement has no similarityInfo', () => {
  const p0 = makePlacement(0, 10, 10, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 90, 90, 2, 0.3, 0.9);

  __debugDedupeRankedPlacements([p0, p1], PLATE);

  assert.equal(p0.similarityInfo, undefined);
  assert.equal(p1.similarityInfo, undefined);
});

test('dedup: different line count lowers similarity enough to keep both', () => {
  // Max similarity with different lineCount: (0 + 1 + 1) / 3 = 0.667 < 0.85
  const p0 = makePlacement(0, 50, 50, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 50, 50, 2, 1.0, 0.9); // same center+scale, different lineCount

  const result = __debugDedupeRankedPlacements([p0, p1], PLATE);

  assert.equal(result.length, 2, 'different line count should keep both placements');
});

test('dedup: lookback window is capped at 3 kept placements', () => {
  // Build result = [P0, P1, P2, P3] (4 distinct kept placements).
  // P4 is identical to P0, which is beyond the 3-item lookback window.
  // P4 should be kept because only P1, P2, P3 are checked.
  const p0 = makePlacement(0, 10, 10, 1, 1.0, 1.0);  // far left
  const p1 = makePlacement(1, 50, 10, 1, 1.0, 0.99); // center
  const p2 = makePlacement(2, 90, 10, 1, 1.0, 0.98); // far right
  const p3 = makePlacement(3, 90, 90, 1, 1.0, 0.97); // far corner
  const p4 = makePlacement(4, 10, 10, 1, 1.0, 0.96); // identical to P0, but P0 is 4th back

  // Verify P0–P3 don't dedupe each other (all must survive to result)
  const inner = __debugDedupeRankedPlacements([p0, p1, p2, p3], PLATE);
  assert.equal(inner.length, 4, 'P0–P3 should all be distinct enough to survive');

  const result = __debugDedupeRankedPlacements([p0, p1, p2, p3, p4], PLATE);

  // P4 is identical to P0, but the lookback only reaches P1, P2, P3 — none of which are
  // similar enough to P4 — so P4 should survive.
  assert.ok(result.some(p => p.candidateIndex === 4), 'P4 should survive because P0 is outside the 3-item lookback window');
});

test('dedup: compares only against kept placements, not removed ones', () => {
  // P0: kept (seed)
  // P1: removed (too similar to P0 — same center, same lineCount, scale slightly off)
  // P2: similar to P1 (old code would remove it), but NOT similar enough to P0 (new code keeps it)
  //
  // With PLATE maxDist ≈ 70.71:
  //   P1 vs P0: (1 + 1 + 0.87)/3 = 0.957 > 0.85  → P1 removed
  //   P2 vs P1: (1 + centerSim(77) + 1.0)/3        (scale 0.87 == 0.87, lineCount same, center shifts 27)
  //             centerSim = 1 - 27/70.71 = 0.618
  //             total = (1 + 0.618 + 1) / 3 = 0.873 > 0.85  → old code removes P2
  //   P2 vs P0: (1 + 0.618 + 0.87)/3 = 0.829 ≤ 0.85  → new code KEEPS P2
  const p0 = makePlacement(0, 50, 50, 1, 1.0,  1.0);
  const p1 = makePlacement(1, 50, 50, 1, 0.87, 0.9);  // removed: similar to P0
  const p2 = makePlacement(2, 77, 50, 1, 0.87, 0.8);  // center shifted by 27

  const result = __debugDedupeRankedPlacements([p0, p1, p2], PLATE);

  assert.ok(p1.similarityInfo, 'P1 should be removed (similar to P0)');
  assert.equal(p1.similarityInfo!.tooSimilarToCandidateIndex, 0);

  assert.ok(
    result.some(p => p.candidateIndex === 2),
    'P2 should be kept — it is only similar to P1 (removed), not to P0 (the only kept item)',
  );
});

test('dedup: empty list returns empty list', () => {
  const result = __debugDedupeRankedPlacements([], PLATE);
  assert.equal(result.length, 0);
});

test('dedup: zero-size plate does not crash', () => {
  const zeroPLate: Rect2D = { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 };
  const p0 = makePlacement(0, 0, 0, 1, 1.0, 1.0);
  const p1 = makePlacement(1, 0, 0, 1, 1.0, 0.9);

  const result = __debugDedupeRankedPlacements([p0, p1], zeroPLate);

  // With maxDist=1 (fallback) and same center, centerSim=1; both identical → p1 removed
  assert.equal(result.length, 1);
});
