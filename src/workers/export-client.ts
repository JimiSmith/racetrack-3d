/**
 * Client-side wrapper for the export Web Worker.
 *
 * Creates the worker lazily on the first request, tracks in-flight requests
 * by ID, and returns Promises that resolve when the worker posts results back.
 */

import type { TrackModel } from '../types/model.js';

export interface ExportResult {
  buffer: ArrayBuffer;
  fileName: string;
  triangleCount: number;
}

interface ExportResponse {
  type: 'export-ready';
  id: number;
  format: 'stl' | '3mf';
  buffer: ArrayBuffer;
  fileName: string;
  triangleCount: number;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (result: ExportResult) => void; reject: (err: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });

    worker.addEventListener('message', (event: MessageEvent<ExportResponse>) => {
      const { id, buffer, fileName, triangleCount } = event.data;
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.resolve({ buffer, fileName, triangleCount });
      }
    });

    worker.addEventListener('error', (event: ErrorEvent) => {
      // Reject all pending requests on a fatal worker error
      const err = new Error(event.message || 'Export worker error');
      for (const entry of pending.values()) {
        entry.reject(err);
      }
      pending.clear();
      // Allow the worker to be recreated on the next request
      worker = null;
    });
  }

  return worker;
}

function sendRequest(
  type: 'export-stl' | 'export-3mf',
  model: TrackModel,
  fileName: string,
): Promise<ExportResult> {
  return new Promise<ExportResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ type, id, model, fileName });
  });
}

/** Serialize the model as a binary STL in a background worker. */
export function requestStlExport(model: TrackModel, fileName: string): Promise<ExportResult> {
  return sendRequest('export-stl', model, fileName);
}

/** Serialize the model as a 3MF zip in a background worker. */
export function requestThreemfExport(model: TrackModel, fileName: string): Promise<ExportResult> {
  return sendRequest('export-3mf', model, fileName);
}
