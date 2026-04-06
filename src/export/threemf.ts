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

export function build3mfModelXml(model: TrackModel): string {
  const vertexIndexes = new Map<string, number>();
  const vertices: { x: string; y: string; z: string }[] = [];
  const triangleEntries: { v1: number; v2: number; v3: number; colorIndex: number }[] = [];
  const { baseTriangles, secondaryTrackTriangles, trackTriangles } = splitModelTriangles(model);

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

  function addTriangles(triangles: [Vertex, Vertex, Vertex][], colorIndex: number): void {
    for (const triangle of triangles) {
      triangleEntries.push({
        v1: getVertexIndex(triangle[0]),
        v2: getVertexIndex(triangle[1]),
        v3: getVertexIndex(triangle[2]),
        colorIndex,
      });
    }
  }

  addTriangles(baseTriangles, 0);
  addTriangles(secondaryTrackTriangles ?? [], 2);
  addTriangles(trackTriangles, 1);

  const vertexXml = vertices
    .map(vertex => `          <vertex x="${vertex.x}" y="${vertex.y}" z="${vertex.z}"/>`)
    .join('\n');
  const triangleXml = triangleEntries
    .map(triangle => `          <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}" pid="1" p1="${triangle.colorIndex}"/>`)
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
    <object id="2" type="model" pid="1" pindex="0">
      <mesh>
        <vertices>
${vertexXml}
        </vertices>
        <triangles>
${triangleXml}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2"/>
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
