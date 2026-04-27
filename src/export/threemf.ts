/**
 * 3MF serialization — pure serialization and zip packaging, no Blob creation.
 * Safe to use in Web Workers.
 */

import { strToU8, zipSync } from 'fflate';
import { splitModelTriangles as _splitModelTriangles } from '../model/triangle-groups.js';
import type { TrackModel, Triangle, Vertex } from '../types/model.js';

type SplitResult = {
  baseTriangles: Triangle[];
  secondaryTrackTriangles: Triangle[] | null | undefined;
  trackTriangles: Triangle[];
};

const splitModelTriangles = _splitModelTriangles as (model: TrackModel) => SplitResult;

function formatCoordinate(value: number): string {
  return (Math.round(value * 10000) / 10000).toFixed(4);
}

/**
 * Builds a vertex/triangle table for a single triangle group, with vertex
 * dedup scoped to the group. Keeping each part's mesh separate is what
 * makes the 3MF a multi-object file: each `<object>` owns its own vertex
 * pool, so coplanar pocket walls in different parts can't be merged into
 * non-2-manifold edges.
 */
function buildPart(
  triangles: Triangle[],
  colorIndex: number,
): { vertexXml: string; triangleXml: string } | null {
  if (triangles.length === 0) {
    return null;
  }

  const vertexIndexes = new Map<string, number>();
  const vertices: { x: string; y: string; z: string }[] = [];
  const triangleEntries: { v1: number; v2: number; v3: number }[] = [];

  function getVertexIndex(vertex: Vertex): number {
    const x = formatCoordinate(vertex.x);
    const y = formatCoordinate(vertex.y);
    const z = formatCoordinate(vertex.z);
    const key = `${x},${y},${z}`;

    if (!vertexIndexes.has(key)) {
      vertexIndexes.set(key, vertices.length);
      vertices.push({ x, y, z });
    }

    return vertexIndexes.get(key) as number;
  }

  for (const triangle of triangles) {
    const v1 = getVertexIndex(triangle[0]);
    const v2 = getVertexIndex(triangle[1]);
    const v3 = getVertexIndex(triangle[2]);
    // Drop triangles that collapse after vertex dedup (zero-area slivers).
    if (v1 === v2 || v2 === v3 || v1 === v3) {
      continue;
    }
    triangleEntries.push({ v1, v2, v3 });
  }

  if (triangleEntries.length === 0) {
    return null;
  }

  const vertexXml = vertices
    .map(vertex => `          <vertex x="${vertex.x}" y="${vertex.y}" z="${vertex.z}"/>`)
    .join('\n');
  const triangleXml = triangleEntries
    .map(triangle => `          <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}" pid="1" p1="${colorIndex}"/>`)
    .join('\n');

  return { vertexXml, triangleXml };
}

export function build3mfModelXml(model: TrackModel): string {
  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);

  // One <object> per logical part, each with its own vertex pool. This keeps
  // the parts independently 2-manifold even when they share coplanar
  // boundaries (e.g. flush coaster pocket walls vs. inlay walls), where a
  // single shared mesh would have edges incident to four faces.
  const parts: { id: number; pindex: number; vertexXml: string; triangleXml: string }[] = [];

  // Allocate object IDs sequentially; object id "1" would conflict with
  // colorgroup id "1" in some readers, so we start at 2.
  let nextId = 2;
  function tryAdd(triangles: Triangle[], colorIndex: number): void {
    const part = buildPart(triangles, colorIndex);
    if (part) {
      parts.push({ id: nextId++, pindex: colorIndex, ...part });
    }
  }

  tryAdd(baseTriangles, 0);
  tryAdd(secondaryTrackTriangles ?? [], 2);
  tryAdd(trackTriangles, 1);

  const objectsXml = parts
    .map(part => `    <object id="${part.id}" type="model" pid="1" pindex="${part.pindex}">
      <mesh>
        <vertices>
${part.vertexXml}
        </vertices>
        <triangles>
${part.triangleXml}
        </triangles>
      </mesh>
    </object>`)
    .join('\n');
  const buildXml = parts
    .map(part => `    <item objectid="${part.id}"/>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:colorgroup id="1">
      <m:color color="#000000"/>
      <m:color color="#E8002D"/>
      <m:color color="#888888"/>
    </m:colorgroup>
${objectsXml}
  </resources>
  <build>
${buildXml}
  </build>
</model>`;
}

export function package3mf(model: TrackModel): Uint8Array<ArrayBuffer> {
  const modelXml = build3mfModelXml(model);
  return zipSync({
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`),
    '3D/3dmodel.model': strToU8(modelXml),
  }) as unknown as Uint8Array<ArrayBuffer>;
}

const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip';

function normalizeFileName(fileName: string): string {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';

  return normalizedBase.endsWith('.3mf') ? normalizedBase : `${normalizedBase}.3mf`;
}

/**
 * Convenience wrapper: package model as 3MF zip, wrap in a Blob.
 * Returns the blob and a normalized filename for download.
 */
export function export3mf(
  model: TrackModel,
  fileName = 'racetrack.3mf',
): { blob: Blob; fileName: string } {
  const downloadFileName = normalizeFileName(fileName);
  const zipBuffer = package3mf(model);

  return {
    blob: new Blob([zipBuffer], { type: MODEL_CONTENT_TYPE }),
    fileName: downloadFileName,
  };
}
