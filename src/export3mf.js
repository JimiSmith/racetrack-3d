/**
 * Re-export shim — kept for backward compatibility.
 * Serialization logic now lives in src/export/threemf.ts.
 */

import { build3mfModelXml, package3mf } from './export/threemf.ts';

export { build3mfModelXml };

const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip';

function normalizeFileName(fileName) {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';

  return normalizedBase.endsWith('.3mf') ? normalizedBase : `${normalizedBase}.3mf`;
}

export function export3mf(model, fileName = 'racetrack.3mf') {
  const downloadFileName = normalizeFileName(fileName);
  const zipBuffer = package3mf(model);

  return {
    blob: new Blob([zipBuffer], { type: MODEL_CONTENT_TYPE }),
    fileName: downloadFileName,
  };
}
