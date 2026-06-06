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
 * GREEN AS OF #133: the unified manifold-3d CSG pipeline builds correct geometry for
 * every enumerated mode, so the representative sample now passes with ZERO failures
 * (was intentionally red against the old hand-assembled meshes). This is achieved by
 * correct geometry — NOT by skip/todo/weakening the assertion. The assert message is
 * still the full compact failure table so any future regression surfaces loudly.
 *
 * The CSG path runs a boolean + simplify per build, so the corpus sweep is slower than
 * the old sync path; the timeout below is set from a measured run with ≥2× headroom.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REPRESENTATIVE_SAMPLE, formatFailureTable, runSweep } from '../test-utils/mesh-sweep.js';

// Measured post-CSG sweep wall-time was ~210 s on a dev machine (40 tracks × sample
// modes, each through manifold-3d CSG). Timeout set well above 2× with generous CI +
// first-build-WASM-instantiation headroom.
const SWEEP_TIMEOUT_MS = 1_800_000;

test(
  'representative sample meshes are 2-manifold and free of degenerate triangles',
  { timeout: SWEEP_TIMEOUT_MS },
  async () => {
    const result = await runSweep(REPRESENTATIVE_SAMPLE, { variant: 'sample' });

    assert.equal(
      result.failures.length,
      0,
      `\nMesh validation sweep found ${result.failures.length} baseline failure(s):\n\n` +
        `${formatFailureTable(result, REPRESENTATIVE_SAMPLE.length)}\n`,
    );
  },
);
