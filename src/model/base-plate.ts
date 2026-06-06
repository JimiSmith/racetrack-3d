import type { BasePlate } from '../types/model.js';
import type { Point2D } from '../types/geometry.js';


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

  // The final arc closes onto the first explicit point, but `Math.cos(270°)`
  // leaves a sub-ULP residual whose survival depends on coordinate magnitude,
  // so an exact `===` would miss the duplicate near the origin. Compare with an
  // epsilon below the export grid to drop the closing vertex reliably.
  const RING_CLOSE_EPSILON_MM = 1e-6;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (
    Math.abs(first.x - last.x) < RING_CLOSE_EPSILON_MM
    && Math.abs(first.y - last.y) < RING_CLOSE_EPSILON_MM
  ) {
    ring.pop();
  }

  return ring;
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

