/**
 * Web Worker for STL and 3MF serialization.
 *
 * Runs serialization off the main thread so the UI stays responsive
 * during large model exports (10k+ triangles → 20-50 ms).
 */

import { serializeBinaryStl } from '../export/stl.js';
import { package3mf } from '../export/threemf.js';
import type { TrackModel } from '../types/model.js';

interface ExportRequest {
  type: 'export-stl' | 'export-3mf';
  id: number;
  model: TrackModel;
  fileName: string;
}

interface ExportResponse {
  type: 'export-ready';
  id: number;
  format: 'stl' | '3mf';
  buffer: ArrayBuffer;
  fileName: string;
  triangleCount: number;
}

// postMessage with a transfer list — use the structured-clone + transfer overload
// available on both Window and DedicatedWorkerGlobalScope.
type PostMessageFn = (message: unknown, transfer: ArrayBuffer[]) => void;
const postTransfer = (self.postMessage as PostMessageFn).bind(self);

self.addEventListener('message', (event: MessageEvent<ExportRequest>) => {
  const { type, id, model, fileName } = event.data;

  if (type === 'export-stl') {
    const buffer = serializeBinaryStl(model.triangles, fileName);
    const response: ExportResponse = {
      type: 'export-ready',
      id,
      format: 'stl',
      buffer,
      fileName,
      triangleCount: model.triangles.length,
    };
    postTransfer(response, [response.buffer]);
  } else if (type === 'export-3mf') {
    const uint8 = package3mf(model);
    // Ensure we have the underlying ArrayBuffer (not a view slice)
    const buffer =
      uint8.byteOffset === 0 && uint8.byteLength === uint8.buffer.byteLength
        ? uint8.buffer
        : uint8.buffer.slice(uint8.byteOffset, uint8.byteOffset + uint8.byteLength);
    const response: ExportResponse = {
      type: 'export-ready',
      id,
      format: '3mf',
      buffer,
      fileName,
      triangleCount: model.triangles.length,
    };
    postTransfer(response, [response.buffer]);
  }
});
