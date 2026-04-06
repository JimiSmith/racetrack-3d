/**
 * Binary STL serialization — pure serialization, no DOM or Blob usage.
 * Safe to use in Web Workers.
 */

import type { TrackModel, Triangle, Vertex } from '../types/model.js';

export function computeNormal(a: Vertex, b: Vertex, c: Vertex): Vertex {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const acz = c.z - a.z;

  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz) || 1;

  return {
    x: nx / length,
    y: ny / length,
    z: nz / length,
  };
}

export function serializeBinaryStl(triangles: Triangle[], solidName = 'racetrack-3d'): ArrayBuffer {
  const safeName = String(solidName).replace(/[^\x20-\x7e]+/g, ' ').slice(0, 80);
  const triangleCount = triangles.length;
  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const view = new DataView(buffer);
  const header = new Uint8Array(buffer, 0, 80);

  for (let i = 0; i < safeName.length; i += 1) {
    header[i] = safeName.charCodeAt(i);
  }

  view.setUint32(80, triangleCount, true);

  let offset = 84;
  for (const [a, b, c] of triangles) {
    const normal = computeNormal(a, b, c);
    const values = [
      normal.x, normal.y, normal.z,
      a.x, a.y, a.z,
      b.x, b.y, b.z,
      c.x, c.y, c.z,
    ];

    for (const value of values) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }

    view.setUint16(offset, 0, true);
    offset += 2;
  }

  return buffer;
}

/**
 * Convenience wrapper: serialize model triangles to STL, wrap in a Blob,
 * and trigger a browser download. Also returns metadata for callers that
 * need it (e.g. tests that inspect the buffer without a DOM).
 */
export function exportStl(
  model: TrackModel,
  fileName = 'racetrack.stl',
): { blob: Blob; buffer: ArrayBuffer; filename: string; fileName: string; triangleCount: number; byteLength: number } {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
  const downloadFileName = normalizedBase.endsWith('.stl') ? normalizedBase : `${normalizedBase}.stl`;
  const stlBytes = serializeBinaryStl(model.triangles, downloadFileName);
  const blob = new Blob([stlBytes], { type: 'model/stl' });

  const canDownloadInBrowser =
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function' &&
    typeof document.body?.appendChild === 'function' &&
    typeof URL?.createObjectURL === 'function';

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
