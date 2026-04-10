/**
 * Web Worker for building 3D track models off the main thread.
 *
 * Receives a ModelBuildRequest, runs buildTrackModel, and posts back a
 * ModelBuildResponse with a transferable Float32Array of triangle vertex data.
 */

import { PerfTimer } from '../model/perf-timer.js';
import { buildTrackModel } from '../model/track-model.js';
import type { ProjectedNode } from '../types/geometry.js';
import type { BasePlate, OutlinePoints } from '../types/model.js';
import type { RankedTextPlacement, TextPlacementCandidate, Rect2D } from '../types/text.js';

// ── Message types ─────────────────────────────────────────────────────────────

export interface ModelBuildRequest {
  type: 'build-model';
  id: number;
  projectedNodes: ProjectedNode[];
  secondaryProjectedNodes: ProjectedNode[][];
  trackName: string;
  primaryOrientationDeg: number | 'auto';
  textPositionRank: number;
  /** Numeric generation counter; when it changes, the placement cache is invalidated. */
  cacheGeneration: number;
}

export interface ModelBuildResponse {
  type: 'model-ready';
  id: number;
  /** Flat array of all triangle vertex positions [x,y,z, x,y,z, ...] (9 floats per triangle). */
  positions: Float32Array;
  segments: {
    base: number;
    secondary: number;
    track: number;
    text: number;
  };
  metadata: {
    scale: number;
    orientationDeg: number;
    basePlate: BasePlate;
    primaryOrientationDeg: number | 'auto';
    textPositionRank: number;
    outlinePoints: OutlinePoints;
    projectedNodes: ProjectedNode[] | null;
    allScoredPlacements?: RankedTextPlacement[];
    dedupedPlacements?: RankedTextPlacement[];
    placementCandidates?: TextPlacementCandidate[];
    scaledBasePlate?: Rect2D;
  };
}

export interface ModelBuildErrorResponse {
  type: 'model-error';
  id: number;
  message: string;
}

// ── Cache generation token mapping ───────────────────────────────────────────

let lastCacheGeneration = -1;
let cacheToken: object | null = null;

function getOrCreateCacheToken(generation: number): object {
  if (generation !== lastCacheGeneration) {
    lastCacheGeneration = generation;
    cacheToken = {};
  }
  return cacheToken!;
}

// ── Worker message handler ────────────────────────────────────────────────────

let latestRequest: ModelBuildRequest | null = null;
let processingScheduled = false;

self.onmessage = (event: MessageEvent<ModelBuildRequest>) => {
  const request = event.data;

  if (request.type !== 'build-model') {
    return;
  }

  // Always keep only the latest request — earlier ones are stale
  latestRequest = request;

  // Schedule processing if not already scheduled; yield first so any other
  // queued messages can arrive and overwrite latestRequest before we build
  if (!processingScheduled) {
    processingScheduled = true;
    setTimeout(processLatest, 0);
  }
};

function processLatest(): void {
  // Grab the latest request (most recently arrived)
  const request = latestRequest;
  latestRequest = null;
  processingScheduled = false;

  if (!request) {
    return;
  }

  try {
    const placementCacheToken = getOrCreateCacheToken(request.cacheGeneration);
    const perfTimer = new PerfTimer();

    const model = buildTrackModel({
      outlinePoints: null,
      basePlate: null,
      trackName: request.trackName,
      projectedNodes: request.projectedNodes,
      secondaryProjectedNodes: request.secondaryProjectedNodes,
      primaryOrientationDeg: request.primaryOrientationDeg,
      textPositionRank: request.textPositionRank,
      placementCacheToken,
      perfTimer,
    });

    // Flatten Triangle[] into a Float32Array (9 floats per triangle: 3 vertices × 3 coords).
    const triangleCount = model.triangles.length;
    const positions = new Float32Array(triangleCount * 9);
    for (let i = 0; i < triangleCount; i++) {
      const tri = model.triangles[i]!;
      const offset = i * 9;
      positions[offset + 0] = tri[0].x;
      positions[offset + 1] = tri[0].y;
      positions[offset + 2] = tri[0].z;
      positions[offset + 3] = tri[1].x;
      positions[offset + 4] = tri[1].y;
      positions[offset + 5] = tri[1].z;
      positions[offset + 6] = tri[2].x;
      positions[offset + 7] = tri[2].y;
      positions[offset + 8] = tri[2].z;
    }

    const response: ModelBuildResponse = {
      type: 'model-ready',
      id: request.id,
      positions,
      segments: {
        base: model.baseTriangleCount,
        secondary: model.secondaryTrackTriangleCount,
        track: model.trackTriangleCount,
        text: model.textTriangleCount,
      },
      metadata: {
        scale: model.scale,
        orientationDeg: model.orientationDeg,
        basePlate: model.basePlate,
        primaryOrientationDeg: model.primaryOrientationDeg,
        textPositionRank: model.textPositionRank,
        outlinePoints: model.outlinePoints,
        projectedNodes: model.projectedNodes,
        ...(model.allScoredPlacements ? {
          allScoredPlacements: model.allScoredPlacements.map(p => ({
            ...p,
            layout: { ...p.layout, contours: [] },
          })),
        } : {}),
        ...(model.dedupedPlacements ? {
          dedupedPlacements: model.dedupedPlacements.map(p => ({
            ...p,
            layout: { ...p.layout, contours: [] },
          })),
        } : {}),
        ...(model.placementCandidates ? { placementCandidates: model.placementCandidates } : {}),
        ...(model.scaledBasePlate ? { scaledBasePlate: model.scaledBasePlate } : {}),
      },
    };

    perfTimer.step('flatten');
    console.table(perfTimer.finish());

    // Transfer the buffer to avoid copying.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (self as any).postMessage(response, [response.positions.buffer]);
  } catch (err) {
    const error = err as Error;
    const errorResponse: ModelBuildErrorResponse = {
      type: 'model-error',
      id: request.id,
      message: error.message ?? String(err),
    };
    self.postMessage(errorResponse);
  }
  // After synchronous processing completes, any messages that arrived during
  // buildTrackModel will fire onmessage and re-schedule processLatest if needed.
}
