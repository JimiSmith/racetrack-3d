import type { LatLonNode, ProjectedNode } from '../types/geometry.js';

export function projectNodes(
  nodes: LatLonNode[],
  elevations: number[] | null = null,
  center: { lat: number; lon: number } | null = null,
): ProjectedNode[] {
  const latC = center?.lat ?? nodes.reduce((s, n) => s + n.lat, 0) / nodes.length;
  const lonC = center?.lon ?? nodes.reduce((s, n) => s + n.lon, 0) / nodes.length;
  const cosLat = Math.cos((latC * Math.PI) / 180);

  return nodes.map((n, i) => ({
    x: (n.lon - lonC) * cosLat * 111320,
    y: (n.lat - latC) * 111320,
    elevation: elevations ? (elevations[i] ?? 0) : 0,
  }));
}
