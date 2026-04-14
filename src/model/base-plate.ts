import earcut from 'earcut';
import type { Triangle, BasePlate, Vertex } from '../types/model.js';
import type { Point2D } from '../types/geometry.js';
import { createVertex, addTriangle, addQuad, signedArea } from './mesh-primitives.js';

export const BASE_THICKNESS_MM = 2.5;
export const BASE_CORNER_RADIUS_MM = 3;
export const BASE_CORNER_SEGMENTS_PER_CORNER = 8;
export const TARGET_MAX_SIZE_MM = 200; // fit model within this bounding box dimension

/** Physical edge length / diameter of a coaster, in millimetres. */
export const COASTER_SIZE_MM = 90;
/** Keep-out distance between the track envelope and the coaster edge, in millimetres. */
export const COASTER_INNER_MARGIN_MM = 5;
/** Number of segments used to approximate a round coaster outline. */
export const COASTER_CIRCLE_SEGMENTS = 128;
/** Depth of the flush-mode track pocket carved into the top of the coaster, in mm. */
export const COASTER_POCKET_DEPTH_MM = 1;

// Compute a scale factor so the outline fits within TARGET_MAX_SIZE_MM
export function computeScale(basePlate: Pick<BasePlate, 'width' | 'height'>): number {
  const longestSide = Math.max(basePlate.width, basePlate.height); // metres
  if (longestSide <= 0) { return 1; }
  return TARGET_MAX_SIZE_MM / longestSide;
}

export function appendRoundedArc(
  points: Point2D[],
  centerX: number,
  centerY: number,
  radiusMm: number,
  startAngleDeg: number,
  endAngleDeg: number,
  segments: number,
): void {
  const step = (endAngleDeg - startAngleDeg) / segments;

  for (let index = 1; index <= segments; index += 1) {
    const angle = ((startAngleDeg + step * index) * Math.PI) / 180;
    points.push({
      x: centerX + Math.cos(angle) * radiusMm,
      y: centerY + Math.sin(angle) * radiusMm,
    });
  }
}

export function buildRoundedRectangleRing(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  radiusMm: number,
  segmentsPerCorner: number,
): Point2D[] {
  const ring: Point2D[] = [];

  ring.push({ x: minX + radiusMm, y: minY });
  ring.push({ x: maxX - radiusMm, y: minY });
  appendRoundedArc(ring, maxX - radiusMm, minY + radiusMm, radiusMm, 270, 360, segmentsPerCorner);
  ring.push({ x: maxX, y: maxY - radiusMm });
  appendRoundedArc(ring, maxX - radiusMm, maxY - radiusMm, radiusMm, 0, 90, segmentsPerCorner);
  ring.push({ x: minX + radiusMm, y: maxY });
  appendRoundedArc(ring, minX + radiusMm, maxY - radiusMm, radiusMm, 90, 180, segmentsPerCorner);
  ring.push({ x: minX, y: minY + radiusMm });
  appendRoundedArc(ring, minX + radiusMm, minY + radiusMm, radiusMm, 180, 270, segmentsPerCorner);

  return ring;
}

export function buildBasePlateMesh(basePlate: BasePlate, scale: number): Triangle[] {
  if (!basePlate) {
    throw new Error('Base plate dimensions are missing');
  }

  const minX = basePlate.minX * scale;
  const maxX = basePlate.maxX * scale;
  const minY = basePlate.minY * scale;
  const maxY = basePlate.maxY * scale;
  const minZ = 0;
  const maxZ = BASE_THICKNESS_MM;
  const radiusMm = Math.min(BASE_CORNER_RADIUS_MM, (maxX - minX) / 2, (maxY - minY) / 2);

  if (radiusMm <= 0) {
    const v000 = createVertex(minX, minY, minZ);
    const v100 = createVertex(maxX, minY, minZ);
    const v110 = createVertex(maxX, maxY, minZ);
    const v010 = createVertex(minX, maxY, minZ);
    const v001 = createVertex(minX, minY, maxZ);
    const v101 = createVertex(maxX, minY, maxZ);
    const v111 = createVertex(maxX, maxY, maxZ);
    const v011 = createVertex(minX, maxY, maxZ);
    const triangles: Triangle[] = [];

    addQuad(triangles, v001, v101, v111, v011);
    addQuad(triangles, v000, v010, v110, v100);
    addQuad(triangles, v000, v100, v101, v001);
    addQuad(triangles, v100, v110, v111, v101);
    addQuad(triangles, v110, v010, v011, v111);
    addQuad(triangles, v010, v000, v001, v011);

    return triangles;
  }

  const ring = buildRoundedRectangleRing(
    minX,
    maxX,
    minY,
    maxY,
    radiusMm,
    BASE_CORNER_SEGMENTS_PER_CORNER,
  );
  const flattened: number[] = [];

  for (const point of ring) {
    flattened.push(point.x, point.y);
  }

  const indices = earcut(flattened);
  const bottom = ring.map(point => createVertex(point.x, point.y, minZ));
  const top = ring.map(point => createVertex(point.x, point.y, maxZ));
  const triangles: Triangle[] = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index]!;
    const b = indices[index + 1]!;
    const c = indices[index + 2]!;
    addTriangle(triangles, top[a]!, top[b]!, top[c]!);
    addTriangle(triangles, bottom[c]!, bottom[b]!, bottom[a]!);
  }

  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    addQuad(triangles, bottom[index]!, bottom[next]!, top[next]!, top[index]!);
  }

  return triangles;
}

/** Generates a centred circle ring at the origin, counter-clockwise. */
export function buildCircleRing(diameterMm: number, segments: number): Point2D[] {
  const radius = diameterMm / 2;
  const ring: Point2D[] = [];

  for (let index = 0; index < segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    ring.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }

  return ring;
}

/**
 * A recess cut into the top surface of the coaster base (does not pass through).
 * `boundary` is the outer edge of the pocket on the top surface; `islands` are
 * sub-regions inside the pocket that remain at full base height (e.g. the
 * infield inside a closed track loop). Islands must be simple and fully
 * contained within the boundary; nested holes inside islands are not supported.
 */
export interface CoasterPocketSpec {
  boundary: Point2D[];
  islands?: Point2D[][];
}

function normalizeToCounterClockwise(ring: Point2D[]): Point2D[] {
  return signedArea(ring) >= 0 ? ring : [...ring].reverse();
}

/**
 * Builds a fixed 90 mm coaster base plate centred at the origin. Optional
 * `pockets` are shallow recesses cut into the top surface (not through the
 * base), used in flush-inlay mode to seat the coloured track prism flush with
 * the top face. Each pocket may list `islands` — sub-regions kept at full
 * height inside the pocket (typically the infield of a closed track loop so
 * the area inside the loop remains solid). The resulting mesh is watertight.
 */
export function buildCoasterBasePlateMesh(
  shape: 'round' | 'square',
  pockets: CoasterPocketSpec[] = [],
  pocketDepthMm: number = COASTER_POCKET_DEPTH_MM,
): Triangle[] {
  const outerRing = shape === 'round'
    ? buildCircleRing(COASTER_SIZE_MM, COASTER_CIRCLE_SEGMENTS)
    : buildRoundedRectangleRing(
        -COASTER_SIZE_MM / 2,
        COASTER_SIZE_MM / 2,
        -COASTER_SIZE_MM / 2,
        COASTER_SIZE_MM / 2,
        BASE_CORNER_RADIUS_MM,
        BASE_CORNER_SEGMENTS_PER_CORNER,
      );

  const validPockets = pockets
    .filter(p => p.boundary.length >= 3)
    .map(p => ({
      boundary: normalizeToCounterClockwise(p.boundary),
      islands: (p.islands ?? [])
        .filter(island => island.length >= 3)
        .map(normalizeToCounterClockwise),
    }));

  const minZ = 0;
  const maxZ = BASE_THICKNESS_MM;
  const pocketZ = Math.max(minZ, maxZ - pocketDepthMm);
  const triangles: Triangle[] = [];

  // ── BOTTOM face (single connected slab, no cuts) ────────────────────────
  {
    const flat: number[] = [];
    for (const p of outerRing) { flat.push(p.x, p.y); }
    const idx = earcut(flat);
    const bottomVerts = outerRing.map(p => createVertex(p.x, p.y, minZ));
    for (let i = 0; i < idx.length; i += 3) {
      addTriangle(triangles, bottomVerts[idx[i + 2]!]!, bottomVerts[idx[i + 1]!]!, bottomVerts[idx[i]!]!);
    }
  }

  // ── OUTER side wall (CCW ring → outward-facing) ─────────────────────────
  {
    const topVerts = outerRing.map(p => createVertex(p.x, p.y, maxZ));
    const bottomVerts = outerRing.map(p => createVertex(p.x, p.y, minZ));
    for (let i = 0; i < outerRing.length; i += 1) {
      const next = (i + 1) % outerRing.length;
      addQuad(triangles, bottomVerts[i]!, bottomVerts[next]!, topVerts[next]!, topVerts[i]!);
    }
  }

  // ── TOP face at maxZ: coaster minus each pocket's boundary ──────────────
  // Pocket boundaries are stored CCW; reverse them for earcut to treat them as holes.
  {
    const flat: number[] = [];
    const holeIndices: number[] = [];
    let runningIndex = outerRing.length;
    const reversedBoundaries = validPockets.map(p => [...p.boundary].reverse());
    const topVerts: Vertex[] = outerRing.map(p => createVertex(p.x, p.y, maxZ));
    for (const p of outerRing) { flat.push(p.x, p.y); }
    for (const b of reversedBoundaries) {
      holeIndices.push(runningIndex);
      for (const p of b) {
        flat.push(p.x, p.y);
        topVerts.push(createVertex(p.x, p.y, maxZ));
      }
      runningIndex += b.length;
    }
    const topIdx = earcut(flat, holeIndices.length ? holeIndices : null);
    for (let i = 0; i < topIdx.length; i += 3) {
      addTriangle(triangles, topVerts[topIdx[i]!]!, topVerts[topIdx[i + 1]!]!, topVerts[topIdx[i + 2]!]!);
    }
  }

  // ── Per-pocket geometry: outer wall, floor, island walls + tops ─────────
  for (const pocket of validPockets) {
    // Pocket outer wall — CCW boundary, reversed quad winding so faces point into the pocket.
    const boundaryTop = pocket.boundary.map(p => createVertex(p.x, p.y, maxZ));
    const boundaryFloor = pocket.boundary.map(p => createVertex(p.x, p.y, pocketZ));
    for (let i = 0; i < pocket.boundary.length; i += 1) {
      const next = (i + 1) % pocket.boundary.length;
      addQuad(triangles, boundaryFloor[next]!, boundaryFloor[i]!, boundaryTop[i]!, boundaryTop[next]!);
    }

    // Pocket floor at pocketZ (faces up, +Z). Outer = boundary (CCW);
    // islands go in as holes (reversed → CW).
    {
      const flat: number[] = [];
      const holeIndices: number[] = [];
      let runningIndex = pocket.boundary.length;
      const reversedIslands = pocket.islands.map(i => [...i].reverse());
      const floorVerts: Vertex[] = pocket.boundary.map(p => createVertex(p.x, p.y, pocketZ));
      for (const p of pocket.boundary) { flat.push(p.x, p.y); }
      for (const isl of reversedIslands) {
        holeIndices.push(runningIndex);
        for (const p of isl) {
          flat.push(p.x, p.y);
          floorVerts.push(createVertex(p.x, p.y, pocketZ));
        }
        runningIndex += isl.length;
      }
      const floorIdx = earcut(flat, holeIndices.length ? holeIndices : null);
      for (let i = 0; i < floorIdx.length; i += 3) {
        addTriangle(triangles, floorVerts[floorIdx[i]!]!, floorVerts[floorIdx[i + 1]!]!, floorVerts[floorIdx[i + 2]!]!);
      }
    }

    // Each island rises from pocketZ to maxZ as a pillar, with an upward-facing
    // top and an outward-facing side wall (same winding as the outer coaster wall).
    for (const island of pocket.islands) {
      const islandFlat: number[] = [];
      for (const p of island) { islandFlat.push(p.x, p.y); }
      const islandIdx = earcut(islandFlat);
      const islandTop = island.map(p => createVertex(p.x, p.y, maxZ));
      const islandFloor = island.map(p => createVertex(p.x, p.y, pocketZ));
      for (let i = 0; i < islandIdx.length; i += 3) {
        addTriangle(triangles, islandTop[islandIdx[i]!]!, islandTop[islandIdx[i + 1]!]!, islandTop[islandIdx[i + 2]!]!);
      }
      for (let i = 0; i < island.length; i += 1) {
        const next = (i + 1) % island.length;
        addQuad(triangles, islandFloor[i]!, islandFloor[next]!, islandTop[next]!, islandTop[i]!);
      }
    }
  }

  return triangles;
}
