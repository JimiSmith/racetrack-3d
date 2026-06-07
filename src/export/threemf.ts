/**
 * 3MF serialization — pure serialization and zip packaging, no Blob creation.
 * Safe to use in Web Workers.
 */

import { strToU8, zipSync } from 'fflate';
import { isDegenerateTriangle } from '../model/mesh-primitives.js';
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
    // Drop triangles whose vertices coincide after the export's grid dedup
    // (zero-area slivers that would leave a non-manifold boundary). Uses the
    // shared coincidence-only definition from mesh-primitives so the writer is
    // robust even for triangles that reach it without passing through
    // `addTriangle`, and stays consistent with the STL writer.
    if (isDegenerateTriangle(triangle[0], triangle[1], triangle[2])) {
      continue;
    }
    triangleEntries.push({
      v1: getVertexIndex(triangle[0]),
      v2: getVertexIndex(triangle[1]),
      v3: getVertexIndex(triangle[2]),
    });
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

  // One mesh <object> per logical part, each with its own vertex pool. This
  // keeps the parts independently 2-manifold even when they share coplanar
  // boundaries (e.g. flush coaster pocket walls vs. inlay walls), where a
  // single shared mesh would have edges incident to four faces. The mesh
  // objects are wired together as <component>s of a single parent object so
  // the model imports as ONE printable (see below).
  const parts: { id: number; vertexXml: string; triangleXml: string }[] = [];

  // Allocate object IDs sequentially; object id "1" would conflict with
  // colorgroup id "1" in some readers, so we start at 2.
  let nextId = 2;
  function tryAdd(triangles: Triangle[], colorIndex: number): void {
    // colorIndex is wired into each triangle's per-triangle p1 by buildPart;
    // there is no per-object pindex (one colour scheme — see #116).
    const part = buildPart(triangles, colorIndex);
    if (part) {
      parts.push({ id: nextId++, ...part });
    }
  }

  // NOTE: the add order below (base, secondary, track) is NOT the colour-index
  // order (base=0, track=1, secondary=2). The mismatch is intentional — the
  // colour index is fixed per part type, the add order only fixes the object
  // ids and the children-before-parent declaration order. Do not "fix" it.
  tryAdd(baseTriangles, 0);
  tryAdd(secondaryTrackTriangles ?? [], 2);
  tryAdd(trackTriangles, 1);

  const objectsXml = parts
    .map(part => `    <object id="${part.id}" type="model">
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

  // Wrap the per-part mesh objects in a single parent <object> that lists them
  // as <component>s, and emit exactly ONE <build><item> referencing the parent.
  // This makes the file import as one printable rather than N scattered parts.
  // The mesh objects (children) are declared in <resources> before this parent
  // — PrusaSlicer requires children to precede the parent that references them,
  // which our fixed add order already guarantees. The parent gets the next free
  // id after all children. When the model has no parts at all, skip the parent
  // object and the build item entirely (avoid a parent referencing zero
  // components, which some readers reject).
  const parentId = nextId;
  const hasParts = parts.length > 0;

  const componentsXml = parts
    .map(part => `        <component objectid="${part.id}"/>`)
    .join('\n');
  const parentObjectXml = hasParts
    ? `\n    <object id="${parentId}" type="model">
      <components>
${componentsXml}
      </components>
    </object>`
    : '';
  const buildXml = hasParts ? `    <item objectid="${parentId}"/>` : '';

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
${objectsXml}${parentObjectXml}
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
