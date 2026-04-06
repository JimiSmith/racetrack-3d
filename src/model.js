/**
 * Thin re-export shim — all logic has moved to src/model/.
 * This file exists so that existing imports from './model.js' continue to work.
 */

export {
  BASE_THICKNESS_MM,
  computeScale,
  buildTrackModel,
  orientTrackGeometry,
  __resetModelPerfCounters,
  __getModelPerfCounters,
  __disableModelPerfCounters,
} from './model/index.js';

export { serializeBinaryStl, computeNormal } from './export/stl.ts';

import { serializeBinaryStl } from './export/stl.ts';

export function exportStl(model, fileName = 'racetrack.stl') {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
  const downloadFileName = normalizedBase.endsWith('.stl') ? normalizedBase : `${normalizedBase}.stl`;
  const stlBytes = serializeBinaryStl(model.triangles, downloadFileName);
  const blob = new Blob([stlBytes], { type: 'model/stl' });
  const canDownloadInBrowser = typeof document !== 'undefined'
    && typeof document.createElement === 'function'
    && typeof document.body?.appendChild === 'function'
    && typeof URL?.createObjectURL === 'function';

  if (canDownloadInBrowser) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = downloadFileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return {
    blob,
    buffer: stlBytes,
    filename: downloadFileName,
    fileName: downloadFileName,
    triangleCount: model.triangles.length,
    byteLength: stlBytes.byteLength,
  };
}
