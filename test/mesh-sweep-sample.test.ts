/**
 * Mesh-validation baseline sweep over the representative sample (#122).
 *
 * Runs the SHARED sweep core (`test-utils/mesh-sweep.ts`) — the same code path the
 * `npm run validate:meshes` CLI runs — over the committed `REPRESENTATIVE_SAMPLE`, and
 * asserts ZERO mesh failures (non-manifold edges / degenerate triangles / T-junctions /
 * self-intersections / flipped faces / disjoint shells, #115) across the worker/export
 * build path. The #115 detectors make this baseline LOUDER (more failures counted) — that
 * is expected and by design, not a regression.
 *
 * INTENTIONALLY RED (owner decision): several representative tracks already fail the
 * current detectors. This test asserts zero failures on purpose so the pre-existing
 * baseline is loud and visible in CI. The assert message is the full compact failure
 * table (track id, label, mode, part, counts, first offending edge). Do NOT skip/todo
 * this test or weaken the assertion to make it pass — its redness is the deliverable.
 * The failures are captured in the PR body and a follow-up issue; no mesh fixes land
 * with this test.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REPRESENTATIVE_SAMPLE, formatFailureTable, runSweep } from '../test-utils/mesh-sweep.js';

test('representative sample meshes are 2-manifold and free of degenerate triangles', () => {
  const result = runSweep(REPRESENTATIVE_SAMPLE, { variant: 'sample' });

  assert.equal(
    result.failures.length,
    0,
    `\nMesh validation sweep found ${result.failures.length} baseline failure(s):\n\n` +
      `${formatFailureTable(result, REPRESENTATIVE_SAMPLE.length)}\n`,
  );
});
