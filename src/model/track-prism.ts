import earcut from 'earcut';

import type { Triangle, OutlinePoints } from '../types/model.js';
import type { ProjectedNode } from '../types/geometry.js';
import { createVertex, addTriangle, addQuad, normalizeRing, ensureCounterClockwise } from './mesh-primitives.js';
import { BASE_THICKNESS_MM } from './base-plate.js';
import { TRACK_HEIGHT_MM, buildRaisedRibbonMesh } from './track-ribbon.js';

// Performance counters — set externally via __modelPerfCounters reference in track-model.ts
export let __trackPrismPerfCounters: { buildTrackPrismMesh: number } | null = null;
export function __setTrackPrismPerfCounters(c: { buildTrackPrismMesh: number } | null): void {
  __trackPrismPerfCounters = c;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function buildTrackPrismMesh(
  outline: OutlinePoints | null | undefined,
  scale: number,
  projectedNodes: ProjectedNode[] | null = null,
  forceOpen = false,
): Triangle[] {
  if (__trackPrismPerfCounters) { __trackPrismPerfCounters.buildTrackPrismMesh++; }
  const raisedRibbonMesh = buildRaisedRibbonMesh(projectedNodes, scale, forceOpen);
  if (raisedRibbonMesh) {
    return raisedRibbonMesh;
  }

  // Accept {outerRing, holes} or plain array (fallback)
  const outerRing = ensureCounterClockwise(normalizeRing((outline as { outerRing?: unknown } | null)?.outerRing as never ?? outline as never));
  const holeRings = ((outline as { holes?: unknown[] } | null)?.holes ?? []).map(h => normalizeRing(h as never));

  // Flatten all rings for earcut: [outerRing, ...holes]
  const allRings = [outerRing, ...holeRings];
  const flattened: number[] = [];
  const holeIndices: number[] = [];
  const allVertices: { x: number; y: number }[] = []; // parallel flat list of {x,y} for vertex lookup

  for (const ring of allRings) {
    if (flattened.length > 0) { holeIndices.push(allVertices.length); }
    for (const point of ring) {
      flattened.push(point.x * scale, point.y * scale);
      allVertices.push(point);
    }
  }

  const indices = earcut(flattened, holeIndices.length ? holeIndices : null);
  if (indices.length < 3) {
    throw new Error('Failed to triangulate track outline');
  }

  const bottomZ = BASE_THICKNESS_MM;

  // Sample elevation from the nearest point along the path so each
  // cross-section stays level while the ribbon still rises and falls.
  function elevOffsetMm(px: number, py: number): number {
    if (!projectedNodes?.length) { return 0; }
    if (projectedNodes.length === 1) {
      return (projectedNodes[0]!.elevation ?? 0) * scale;
    }

    let minDist = Infinity;
    let elev = projectedNodes[0]!.elevation ?? 0;

    for (let index = 0; index < projectedNodes.length; index += 1) {
      const start = projectedNodes[index]!;
      const end = projectedNodes[(index + 1) % projectedNodes.length]!;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;

      if (lengthSquared === 0) {
        continue;
      }

      const t = clamp(((px - start.x) * dx + (py - start.y) * dy) / lengthSquared, 0, 1);
      const nearestX = start.x + dx * t;
      const nearestY = start.y + dy * t;
      const distX = px - nearestX;
      const distY = py - nearestY;
      const distanceSquared = distX * distX + distY * distY;

      if (distanceSquared < minDist) {
        const startElevation = start.elevation ?? 0;
        const endElevation = end.elevation ?? startElevation;
        minDist = distanceSquared;
        elev = startElevation + (endElevation - startElevation) * t;
      }
    }

    return elev * scale;
  }

  const elevationOffsets = allVertices.map(p => elevOffsetMm(p.x, p.y));
  const bottom = allVertices.map(p => createVertex(p.x * scale, p.y * scale, bottomZ));
  const top = allVertices.map((p, index) => createVertex(
    p.x * scale,
    p.y * scale,
    bottomZ + TRACK_HEIGHT_MM + elevationOffsets[index]!,
  ));
  const triangles: Triangle[] = [];

  // Top and bottom faces
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    addTriangle(triangles, top[a]!, top[b]!, top[c]!);
    addTriangle(triangles, bottom[c]!, bottom[b]!, bottom[a]!);
  }

  // Side walls for each ring (track offsets built alongside allVertices above)
  let ringOffset = 0;
  for (const ring of allRings) {
    for (let i = 0; i < ring.length; i++) {
      const curr = ringOffset + i;
      const next = ringOffset + (i + 1) % ring.length;
      addQuad(triangles, bottom[curr]!, bottom[next]!, top[next]!, top[curr]!);
    }
    ringOffset += ring.length;
  }

  return triangles;
}
