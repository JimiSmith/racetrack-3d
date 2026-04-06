/**
 * Main-thread client for the model Web Worker.
 *
 * Creates and owns the worker, tracks request IDs, discards stale responses,
 * and reconstructs TrackModel objects from the flat Float32Array payloads.
 */

import type { ProjectedNode } from '../types/geometry.js';
import type { TrackModel, Triangle, Vertex } from '../types/model.js';
import type {
  ModelBuildRequest,
  ModelBuildResponse,
  ModelBuildErrorResponse,
} from './model.worker.js';

export interface ModelBuildParams {
  projectedNodes: ProjectedNode[];
  secondaryProjectedNodes: ProjectedNode[][];
  trackName: string;
  primaryOrientationDeg: number | 'auto';
  textPositionRank: number;
  /** Numeric generation counter for cache invalidation. Defaults to 0. */
  cacheGeneration?: number;
}

type WorkerResponse = ModelBuildResponse | ModelBuildErrorResponse;

// ── Reconstruct Triangle[] from flat Float32Array ─────────────────────────────

function unflattenPositions(positions: Float32Array): Triangle[] {
  const triangleCount = positions.length / 9;
  const triangles: Triangle[] = new Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) {
    const offset = i * 9;
    const v0: Vertex = { x: positions[offset + 0]!, y: positions[offset + 1]!, z: positions[offset + 2]! };
    const v1: Vertex = { x: positions[offset + 3]!, y: positions[offset + 4]!, z: positions[offset + 5]! };
    const v2: Vertex = { x: positions[offset + 6]!, y: positions[offset + 7]!, z: positions[offset + 8]! };
    triangles[i] = [v0, v1, v2];
  }
  return triangles;
}

// ── ModelWorkerClient ─────────────────────────────────────────────────────────

export function createModelWorkerClient(): {
  requestModelBuild: (params: ModelBuildParams) => Promise<TrackModel>;
  terminate: () => void;
} {
  const worker = new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' });

  let currentRequestId = 0;

  // Pending resolvers keyed by request ID.
  const pending = new Map<number, {
    resolve: (model: TrackModel) => void;
    reject: (err: Error) => void;
  }>();

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;

    if (response.type === 'model-ready') {
      const handler = pending.get(response.id);
      pending.delete(response.id);

      // Discard if a newer request has superseded this one.
      if (response.id !== currentRequestId) {
        return;
      }

      if (!handler) {
        return;
      }

      const triangles = unflattenPositions(response.positions);
      const { segments, metadata } = response;

      const model: TrackModel = {
        triangles,
        baseTriangleCount: segments.base,
        secondaryTrackTriangleCount: segments.secondary,
        trackTriangleCount: segments.track,
        textTriangleCount: segments.text,
        scale: metadata.scale,
        orientationDeg: metadata.orientationDeg,
        basePlate: metadata.basePlate,
        primaryOrientationDeg: metadata.primaryOrientationDeg,
        textPositionRank: metadata.textPositionRank,
        outlinePoints: metadata.outlinePoints,
        projectedNodes: metadata.projectedNodes,
      };

      handler.resolve(model);
    } else if (response.type === 'model-error') {
      const handler = pending.get(response.id);
      pending.delete(response.id);

      if (!handler) {
        return;
      }

      handler.reject(new Error(response.message));
    }
  };

  worker.onerror = (event: ErrorEvent) => {
    // Reject all pending requests on a fatal worker error.
    const err = new Error(event.message ?? 'Worker error');
    for (const handler of pending.values()) {
      handler.reject(err);
    }
    pending.clear();
  };

  function requestModelBuild(params: ModelBuildParams): Promise<TrackModel> {
    const id = ++currentRequestId;

    // Cancel any in-flight requests that are now stale.
    for (const [oldId, handler] of pending) {
      handler.reject(new Error('Superseded by newer request'));
      pending.delete(oldId);
    }

    const request: ModelBuildRequest = {
      type: 'build-model',
      id,
      projectedNodes: params.projectedNodes,
      secondaryProjectedNodes: params.secondaryProjectedNodes,
      trackName: params.trackName,
      primaryOrientationDeg: params.primaryOrientationDeg,
      textPositionRank: params.textPositionRank,
      cacheGeneration: params.cacheGeneration ?? 0,
    };

    return new Promise<TrackModel>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  function terminate(): void {
    worker.terminate();
    const err = new Error('Worker terminated');
    for (const handler of pending.values()) {
      handler.reject(err);
    }
    pending.clear();
  }

  return { requestModelBuild, terminate };
}
