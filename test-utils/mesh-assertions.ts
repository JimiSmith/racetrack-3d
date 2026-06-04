import assert from 'node:assert/strict';

import { summarizeMesh, validateModel } from '../src/model/validate-mesh.js';
import type { PartReport, ValidateOptions } from '../src/model/validate-mesh.js';
import { splitModelTriangles } from '../src/model/triangle-groups.js';
import type { Triangle, TrackModel } from '../src/types/model.js';

/** Human-readable per-part label suffix, matching the original test helpers. */
const PART_LABELS: Record<PartReport['part'], string> = {
  base: 'base',
  secondary: 'secondary tracks',
  track: 'primary track + text',
};

/**
 * Asserts that each non-empty part of the model is 2-manifold (and, depending on
 * `failOn`, free of degenerate triangles). Composes `validateModel`, which mirrors
 * what Bambu sees — `build3mfModelXml` emits one `<object>` per part with its own
 * vertex pool.
 *
 * `failOn` selects the failure CONDITION:
 *   - `'edges+degenerates'` (default): fail on non-manifold edges OR degenerate triangles.
 *   - `'edges'`: fail ONLY on non-manifold edges.
 *
 * Degenerate diagnostics are PRINTED in the failure message in both modes; printing
 * is not failing.
 */
export function assertModelManifold(
  label: string,
  model: TrackModel,
  options?: { failOn?: 'edges' | 'edges+degenerates' } & ValidateOptions,
): void {
  const { failOn = 'edges+degenerates', ...validateOptions } = options ?? {};
  const report = validateModel(model, validateOptions);
  const groups = splitModelTriangles(model);
  const trianglesByPart: Record<PartReport['part'], Triangle[]> = {
    base: groups.baseTriangles,
    secondary: groups.secondaryTrackTriangles,
    track: groups.trackTriangles,
  };

  for (const part of report.parts) {
    if (part.triangleCount === 0) {
      continue;
    }

    const failed =
      part.nonManifoldEdges.length > 0 ||
      (failOn === 'edges+degenerates' && part.degenerateTriangles.length > 0);

    if (!failed) {
      continue;
    }

    const partLabel = `${label} / ${PART_LABELS[part.part]}`;
    const summary = summarizeMesh(trianglesByPart[part.part], validateOptions);
    const examples = part.nonManifoldEdges.slice(0, 5).map(e => ({
      a: { x: +e.a.x.toFixed(4), y: +e.a.y.toFixed(4), z: +e.a.z.toFixed(4) },
      b: { x: +e.b.x.toFixed(4), y: +e.b.y.toFixed(4), z: +e.b.z.toFixed(4) },
      triangleIndices: e.triangleIndices,
    }));
    assert.fail(
      `${partLabel}: part is not 2-manifold\n  summary=${JSON.stringify(summary)}\n  first non-manifold edges: ${JSON.stringify(examples, null, 2)}\n  degenerate triangle indices (first 5): ${JSON.stringify(part.degenerateTriangles.slice(0, 5))}`,
    );
  }
}
