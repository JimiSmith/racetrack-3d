// Ported from src/geometry/geo-math.ts — keep in sync.

import type { LatLon } from './types.js';

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/**
 * Compute the length of a polyline in metres using an equirectangular approximation.
 */
export function measurePolylineLength(nodes: LatLon[]): number {
  let length = 0;

  for (let i = 1; i < nodes.length; i += 1) {
    const prev = nodes[i - 1] as LatLon;
    const next = nodes[i] as LatLon;
    const avgLat = toRadians((prev.lat + next.lat) / 2);
    const dx = (next.lon - prev.lon) * Math.cos(avgLat) * 111320;
    const dy = (next.lat - prev.lat) * 111320;
    length += Math.hypot(dx, dy);
  }

  return length;
}

/**
 * Measure the straight-line distance between two points in metres.
 */
export function measureDistanceMetres(a: LatLon, b: LatLon): number {
  return measurePolylineLength([a, b]);
}
