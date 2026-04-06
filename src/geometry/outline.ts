import * as turf from '@turf/turf';
import type { Point2D } from '../types/geometry.js';
import type { BasePlate, OutlinePoints } from '../types/model.js';

export function buildTrackOutline(nodes: Point2D[], widthMetres = 12): OutlinePoints {
  let pts = [...nodes];

  // Close the loop if needed
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first === undefined || last === undefined) {
    return { outerRing: [], holes: [] };
  }
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (Math.sqrt(dx * dx + dy * dy) > 5) {
    pts = [...pts, first];
  }

  // Convert XY metres → fake lon/lat (divide by 111320)
  const coords = pts.map(p => [p.x / 111320, p.y / 111320] as [number, number]);
  const line = turf.lineString(coords);

  const bufferKm = widthMetres / 2 / 1000;
  const buffered = turf.buffer(line, bufferKm, { units: 'kilometers' });
  if (!buffered) {
    return { outerRing: [], holes: [] };
  }

  // Outer ring + any inner hole rings (donut shape for closed circuits)
  const toMetres = (ring: number[][]): Point2D[] =>
    ring.map(([lon, lat]) => ({ x: (lon ?? 0) * 111320, y: (lat ?? 0) * 111320 }));
  return {
    outerRing: toMetres(buffered.geometry.coordinates[0] as number[][]),
    holes: (buffered.geometry.coordinates.slice(1) as number[][][]).map(toMetres),
  };
}

export function buildBasePlate(outline: OutlinePoints | Point2D[], margin = 50): BasePlate {
  // Accept either the full outline object {outerRing, holes} or a plain array
  const outlinePoints = (outline as OutlinePoints)?.outerRing ?? (outline as Point2D[]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of outlinePoints) {
    if (x < minX) { minX = x; }
    if (x > maxX) { maxX = x; }
    if (y < minY) { minY = y; }
    if (y > maxY) { maxY = y; }
  }
  minX -= margin;
  maxX += margin;
  minY -= margin;
  maxY += margin;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
