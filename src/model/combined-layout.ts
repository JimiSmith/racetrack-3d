import type { OutlinePoints, BasePlate } from '../types/model.js';
import type { ProjectedNode } from '../types/geometry.js';

// Returns a canonical key for a directed edge (a→b), using ~1cm coordinate precision.
// Uses lexicographic ordering so the same edge traversed in either direction hashes identically.
export function edgeKey(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const ax = Math.round(a.x * 100), ay = Math.round(a.y * 100);
  const bx = Math.round(b.x * 100), by = Math.round(b.y * 100);
  return (ax < bx || (ax === bx && ay <= by))
    ? `${ax},${ay}|${bx},${by}`
    : `${bx},${by}|${ax},${ay}`;
}

export function buildPrimaryEdgeSet(nodes: ProjectedNode[]): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < nodes.length - 1; i += 1) {
    set.add(edgeKey(nodes[i]!, nodes[i + 1]!));
  }
  return set;
}

// Splits a secondary layout's node chain into sub-chains containing only edges
// not already present in the primary layout. This avoids rendering shared sections twice.
export function getUniqueSubChains(
  secondaryNodes: ProjectedNode[],
  primaryEdgeSet: Set<string>,
): ProjectedNode[][] {
  const chains: ProjectedNode[][] = [];
  let current: ProjectedNode[] | null = null;

  for (let i = 0; i < secondaryNodes.length - 1; i += 1) {
    const a = secondaryNodes[i]!;
    const b = secondaryNodes[i + 1]!;
    if (primaryEdgeSet.has(edgeKey(a, b))) {
      if (current) { chains.push(current); current = null; }
    } else {
      if (!current) { current = [a]; }
      current.push(b);
    }
  }
  if (current) { chains.push(current); }
  return chains;
}

// Builds a base plate that encompasses all provided outlines (used for combined-layout mode).
export function buildCombinedBasePlate(allOutlines: OutlinePoints[], margin = 50): BasePlate | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const outline of allOutlines) {
    for (const { x, y } of (outline?.outerRing ?? [])) {
      if (x < minX) { minX = x; }
      if (x > maxX) { maxX = x; }
      if (y < minY) { minY = y; }
      if (y > maxY) { maxY = y; }
    }
  }
  if (!Number.isFinite(minX)) { return null; }
  minX -= margin; maxX += margin; minY -= margin; maxY += margin;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}
