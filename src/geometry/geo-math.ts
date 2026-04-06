/**
 * Pure geographic math utilities — haversine-approximation distances,
 * bounding box area, and coordinate helpers.
 * No side effects. No DOM access. No external dependencies.
 */

import type { LatLonNode } from '../types/geometry.js';

/** Convert degrees to radians. */
export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/**
 * Manhattan distance in lat/lon units.
 * Used for fast approximate proximity checks (not metres).
 */
export function dist(a: LatLonNode, b: LatLonNode): number {
  return Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon);
}

/**
 * Compute the length of a polyline in metres using a haversine approximation.
 * Consecutive segment lengths are summed using the equirectangular projection.
 */
export function measurePolylineLength(nodes: LatLonNode[]): number {
  let length = 0;

  for (let i = 1; i < nodes.length; i += 1) {
    // Safe: loop starts at 1 and ends before nodes.length, so both indices are in bounds.
    const prev = nodes[i - 1] as LatLonNode;
    const next = nodes[i] as LatLonNode;
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
export function measureDistanceMetres(a: LatLonNode, b: LatLonNode): number {
  return measurePolylineLength([a, b]);
}

/**
 * Compute the bounding box area of a set of nodes in square metres.
 * Returns 0 for empty input.
 */
export function computeBoundingBoxArea(nodes: LatLonNode[]): number {
  if (!nodes.length) {
    return 0;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (const node of nodes) {
    minLat = Math.min(minLat, node.lat);
    maxLat = Math.max(maxLat, node.lat);
    minLon = Math.min(minLon, node.lon);
    maxLon = Math.max(maxLon, node.lon);
  }

  const cosLat = Math.cos(toRadians((minLat + maxLat) / 2));
  const width = (maxLon - minLon) * cosLat * 111320;
  const height = (maxLat - minLat) * 111320;
  return Math.abs(width * height);
}

/**
 * Compute the distance in metres between the first and last node of a chain.
 * Returns 0 for chains shorter than 2 nodes.
 */
export function computeEndpointGap(nodes: LatLonNode[]): number {
  if (nodes.length < 2) {
    return 0;
  }

  // Safe: length >= 2 checked above.
  const first = nodes[0] as LatLonNode;
  const last = nodes[nodes.length - 1] as LatLonNode;
  const avgLat = toRadians((first.lat + last.lat) / 2);
  const dx = (last.lon - first.lon) * Math.cos(avgLat) * 111320;
  const dy = (last.lat - first.lat) * 111320;
  return Math.hypot(dx, dy);
}
