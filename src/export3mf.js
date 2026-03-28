import { strToU8, zipSync } from 'fflate';

import { BASE_THICKNESS_MM } from './model.js';

const MODEL_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip';

function normalizeFileName(fileName) {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';

  return normalizedBase.endsWith('.3mf') ? normalizedBase : `${normalizedBase}.3mf`;
}

function formatCoordinate(value) {
  return (Math.round(value * 10000) / 10000).toFixed(4);
}

function splitTriangles(model) {
  const triangles = model?.triangles ?? [];
  const baseTriangleCount = Number.isInteger(model?.baseTriangleCount)
    ? model.baseTriangleCount
    : null;
  const baseTriangles = [];
  const trackTriangles = [];

  for (let index = 0; index < triangles.length; index += 1) {
    const triangle = triangles[index];
    if ((baseTriangleCount !== null && index < baseTriangleCount) || triangle.every(vertex => vertex.z <= BASE_THICKNESS_MM)) {
      baseTriangles.push(triangle);
    } else {
      trackTriangles.push(triangle);
    }
  }

  return { baseTriangles, trackTriangles };
}

export function build3mfModelXml(model) {
  const vertexIndexes = new Map();
  const vertices = [];
  const triangleEntries = [];
  const { baseTriangles, trackTriangles } = splitTriangles(model);

  function getVertexIndex(vertex) {
    const x = formatCoordinate(vertex.x);
    const y = formatCoordinate(vertex.y);
    const z = formatCoordinate(vertex.z);
    const key = `${x},${y},${z}`;

    if (!vertexIndexes.has(key)) {
      vertexIndexes.set(key, vertices.length);
      vertices.push({ x, y, z });
    }

    return vertexIndexes.get(key);
  }

  function addTriangles(triangles, colorIndex) {
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

export function export3mf(model, fileName = 'racetrack.3mf') {
  const downloadFileName = normalizeFileName(fileName);
  const modelXml = build3mfModelXml(model);
  const zipBuffer = zipSync({
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
  });

  return {
    blob: new Blob([zipBuffer], { type: MODEL_CONTENT_TYPE }),
    fileName: downloadFileName,
  };
}
