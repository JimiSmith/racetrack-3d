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
 *   - `'edges+tjunctions'`: fail on non-manifold edges OR T-junctions (#109).
 *   - `'edges+degenerates+tjunctions'`: fail on any of the three.
 *   - `'edges+selfx'`: fail on non-manifold edges OR self-intersections (#115).
 *   - `'edges+flipped'`: fail on non-manifold edges OR flipped-winding faces (#115).
 *   - `'edges+shells'`: fail on non-manifold edges OR OPEN shells (a shell with a
 *     boundary/non-manifold edge, #133). Multiple disjoint but individually-watertight
 *     shells (e.g. track ribbon + disconnected text glyphs) are valid and do NOT fail.
 *   - `'all'`: fail on ANY detector (edges, degenerates, T-junctions, self-intersections,
 *     flipped faces, open shells).
 *
 * All diagnostics (degenerate, T-junction, self-intersection, flipped-face, shell)
 * are PRINTED in the failure message regardless of `failOn`; printing is not failing.
 */
type FailOn =
  | 'edges'
  | 'edges+degenerates'
  | 'edges+tjunctions'
  | 'edges+degenerates+tjunctions'
  | 'edges+selfx'
  | 'edges+flipped'
  | 'edges+shells'
  | 'all';

export function assertModelManifold(
  label: string,
  model: TrackModel,
  options?: { failOn?: FailOn } & ValidateOptions,
): void {
  const { failOn = 'edges+degenerates', ...validateOptions } = options ?? {};
  const failOnDegenerates =
    failOn === 'edges+degenerates' || failOn === 'edges+degenerates+tjunctions' || failOn === 'all';
  const failOnTJunctions =
    failOn === 'edges+tjunctions' || failOn === 'edges+degenerates+tjunctions' || failOn === 'all';
  // HONEST self-intersection gate (#133, §3.5a): under `'all'` (and the explicit `'edges+selfx'`
  // opt-in) we fail on GENUINE `crossing` self-intersections — a true 3D interior cross, which is
  // a real defect (the kind the old `warp` ribbon produced). We tolerate the `coplanar` class
  // ONLY (same-plane area lamination / near-contact surfaces), which the detector over-reports on
  // watertight CSG output. The hull+union ribbon is `crossing`-free BY CONSTRUCTION, so a genuine
  // crossing means broken geometry and MUST fail the gate — no blanket CSG exemption.
  const failOnSelfIntersections = failOn === 'edges+selfx' || failOn === 'all';
  const failOnFlipped = failOn === 'edges+flipped' || failOn === 'all';
  const failOnShells = failOn === 'edges+shells' || failOn === 'all';
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

    const crossingSelfx = part.selfIntersections.filter(s => s.kind === 'crossing').length;
    const failed =
      part.nonManifoldEdges.length > 0 ||
      (failOnDegenerates && part.degenerateTriangles.length > 0) ||
      (failOnTJunctions && part.tJunctions.length > 0) ||
      (failOnSelfIntersections && crossingSelfx > 0) ||
      (failOnFlipped && part.flippedFaces.length > 0) ||
      (failOnShells && part.openShellComponentCount > 0);

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
    const tJunctionExamples = part.tJunctions.slice(0, 10).map(t => ({
      vertex: { x: +t.vertex.x.toFixed(4), y: +t.vertex.y.toFixed(4), z: +t.vertex.z.toFixed(4) },
      edge: {
        a: { x: +t.edge.a.x.toFixed(4), y: +t.edge.a.y.toFixed(4), z: +t.edge.a.z.toFixed(4) },
        b: { x: +t.edge.b.x.toFixed(4), y: +t.edge.b.y.toFixed(4), z: +t.edge.b.z.toFixed(4) },
      },
      triangleIndex: t.triangleIndex,
      perpendicularDistance: +t.perpendicularDistance.toFixed(6),
    }));
    const coplanarSelfIntersections = part.selfIntersections.filter(s => s.kind === 'coplanar').length;
    const crossingSelfIntersections = part.selfIntersections.length - coplanarSelfIntersections;
    assert.fail(
      `${partLabel}: part failed mesh validation (failOn=${failOn})\n  summary=${JSON.stringify(summary)}\n  first non-manifold edges: ${JSON.stringify(examples, null, 2)}\n  degenerate triangle indices (first 5): ${JSON.stringify(part.degenerateTriangles.slice(0, 5))}\n  T-junction count: ${part.tJunctions.length}\n  first T-junctions (vertex / edge / perpendicularDistance): ${JSON.stringify(tJunctionExamples, null, 2)}\n  self-intersection count: ${part.selfIntersections.length} (crossing=${crossingSelfIntersections}, coplanar=${coplanarSelfIntersections})\n  flipped-face count: ${part.flippedFaces.length}\n  shell-component count: ${part.shellComponentCount} (open shells: ${part.openShellComponentCount})`,
    );
  }
}
