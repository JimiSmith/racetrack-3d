/**
 * Shared low-level primitives for the mesh validator and its detectors.
 *
 * Extracted (additively, nothing removed) so both `validate-mesh.ts` and the
 * sibling `mesh-detectors.ts` can import them WITHOUT a circular dependency:
 * `validate-mesh.ts` imports the detectors (for `summarizeMesh`/`validateModel`),
 * and the detectors import these primitives. The primitives live here, depended on
 * by both, breaking the cycle. `validate-mesh.ts` re-exports these so existing
 * import paths (`import { DEFAULT_PRECISION_MM } from '.../validate-mesh.js'`) keep
 * working unchanged.
 *
 * NOTE: this is a SEPARATE file from the unrelated, pre-existing
 * `src/model/mesh-primitives.ts` (model-construction helpers: createVertex,
 * addTriangle, …). The plan named `mesh-primitives.ts`, but that name is already
 * taken in the live tree, so the validator primitives live here under a
 * validator-scoped name to avoid clobbering it.
 */

import type { Vertex } from '../types/model.js';

/** 4-decimal quantization, matching `formatCoordinate` in src/export/threemf.ts. */
export const DEFAULT_PRECISION_MM = 1e-4;

export interface ValidateOptions {
  precisionMm?: number;
  areaToleranceMm2?: number;
  /** Perpendicular distance tolerance (mm) for T-junction detection. Defaults to
   *  `DEFAULT_TJUNCTION_TOLERANCE_MM` (1e-4). */
  toleranceMm?: number;
}

export function quantize(value: number, precision: number): number {
  return Math.round(value / precision) * precision;
}

export function vertexKey(v: Vertex, precision: number): string {
  return `${quantize(v.x, precision)},${quantize(v.y, precision)},${quantize(v.z, precision)}`;
}

/** Undirected edge key: SORTS its two vertex keys so `(a,b)` and `(b,a)` collide.
 *  Use ONLY for grouping incident triangles; never for direction-sensitive logic. */
export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
