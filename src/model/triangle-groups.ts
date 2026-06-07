import type { TrackModel, Triangle } from '../types/model.js';

interface SplitModelTriangles {
  baseTriangles: Triangle[];
  secondaryTrackTriangles: Triangle[];
  trackTriangles: Triangle[];
}

function hasExplicitTriangleSegments(model: Partial<TrackModel> | null | undefined): boolean {
  return (
    Number.isInteger(model?.baseTriangleCount) &&
    (model?.baseTriangleCount ?? -1) >= 0 &&
    (model?.baseTriangleCount ?? 0) <= (model?.triangles?.length ?? 0)
  );
}

export function splitModelTriangles(
  model: Partial<TrackModel> | null | undefined,
): SplitModelTriangles {
  const triangles = model?.triangles ?? [];

  if (!hasExplicitTriangleSegments(model)) {
    throw new Error(
      'splitModelTriangles requires explicit triangle-segment counts ' +
        '(baseTriangleCount/secondaryTrackTriangleCount/trackTriangleCount); ' +
        'the legacy Z-only heuristic cannot recover secondary-track triangles. ' +
        'Build the model via buildTrackModel.',
    );
  }

  const baseEnd = model!.baseTriangleCount!;
  const secCount = model!.secondaryTrackTriangleCount ?? 0;
  const secondaryEnd = baseEnd + secCount;
  // trackTriangles includes primary track + text (both rendered in the same red/primary colour).
  return {
    baseTriangles: triangles.slice(0, baseEnd),
    secondaryTrackTriangles: triangles.slice(baseEnd, secondaryEnd),
    trackTriangles: triangles.slice(secondaryEnd),
  };
}
