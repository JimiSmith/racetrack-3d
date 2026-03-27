import earcut from 'earcut';

const BASE_THICKNESS_MM = 8;
const TRACK_HEIGHT_MM = 2;

function toMm(valueMetres) {
  return valueMetres * 1000;
}

function normalizeRing(points) {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('Outline must contain at least three points');
  }

  const ring = [];

  for (const point of points) {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      continue;
    }

    const previous = ring[ring.length - 1];
    if (previous && previous.x === point.x && previous.y === point.y) {
      continue;
    }

    ring.push({ x: point.x, y: point.y });
  }

  if (ring.length < 3) {
    throw new Error('Outline must contain at least three unique points');
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first.x === last.x && first.y === last.y) {
    ring.pop();
  }

  if (ring.length < 3) {
    throw new Error('Outline must contain at least three unique points');
  }

  return ring;
}

function signedArea(points) {
  let area = 0;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }

  return area / 2;
}

function ensureCounterClockwise(points) {
  return signedArea(points) >= 0 ? points : [...points].reverse();
}

function createVertex(x, y, z) {
  return { x, y, z };
}

function addTriangle(triangles, a, b, c) {
  triangles.push([a, b, c]);
}

function addQuad(triangles, a, b, c, d) {
  addTriangle(triangles, a, b, c);
  addTriangle(triangles, a, c, d);
}

function buildBasePlateMesh(basePlate) {
  if (!basePlate) {
    throw new Error('Base plate dimensions are missing');
  }

  const minX = toMm(basePlate.minX);
  const maxX = toMm(basePlate.maxX);
  const minY = toMm(basePlate.minY);
  const maxY = toMm(basePlate.maxY);
  const minZ = 0;
  const maxZ = BASE_THICKNESS_MM;

  const v000 = createVertex(minX, minY, minZ);
  const v100 = createVertex(maxX, minY, minZ);
  const v110 = createVertex(maxX, maxY, minZ);
  const v010 = createVertex(minX, maxY, minZ);
  const v001 = createVertex(minX, minY, maxZ);
  const v101 = createVertex(maxX, minY, maxZ);
  const v111 = createVertex(maxX, maxY, maxZ);
  const v011 = createVertex(minX, maxY, maxZ);

  const triangles = [];

  addQuad(triangles, v001, v101, v111, v011);
  addQuad(triangles, v000, v010, v110, v100);
  addQuad(triangles, v000, v100, v101, v001);
  addQuad(triangles, v100, v110, v111, v101);
  addQuad(triangles, v110, v010, v011, v111);
  addQuad(triangles, v010, v000, v001, v011);

  return triangles;
}

function buildTrackPrismMesh(outlinePoints) {
  const ring = ensureCounterClockwise(normalizeRing(outlinePoints));
  const flattened = [];

  for (const point of ring) {
    flattened.push(toMm(point.x), toMm(point.y));
  }

  const indices = earcut(flattened);
  if (indices.length < 3) {
    throw new Error('Failed to triangulate track outline');
  }

  const bottomZ = BASE_THICKNESS_MM;
  const topZ = BASE_THICKNESS_MM + TRACK_HEIGHT_MM;
  const bottom = ring.map(point => createVertex(toMm(point.x), toMm(point.y), bottomZ));
  const top = ring.map(point => createVertex(toMm(point.x), toMm(point.y), topZ));
  const triangles = [];

  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    addTriangle(triangles, top[a], top[b], top[c]);
    addTriangle(triangles, bottom[c], bottom[b], bottom[a]);
  }

  for (let i = 0; i < ring.length; i += 1) {
    const nextIndex = (i + 1) % ring.length;
    addQuad(triangles, bottom[i], bottom[nextIndex], top[nextIndex], top[i]);
  }

  return triangles;
}

export function buildTrackModel({ outlinePoints, basePlate, trackName }) {
  void trackName;

  return {
    triangles: [
      ...buildBasePlateMesh(basePlate),
      ...buildTrackPrismMesh(outlinePoints),
    ],
  };
}

function computeNormal(a, b, c) {
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

export function serializeBinaryStl(triangles, solidName = 'racetrack-3d') {
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

export function exportStl(model, fileName = 'racetrack.stl') {
  const normalizedBase = String(fileName)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
  const downloadFileName = normalizedBase.endsWith('.stl') ? normalizedBase : `${normalizedBase}.stl`;
  const stlBytes = serializeBinaryStl(model.triangles, downloadFileName);
  const blob = new Blob([stlBytes], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = downloadFileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);

  return {
    fileName: downloadFileName,
    triangleCount: model.triangles.length,
    byteLength: stlBytes.byteLength,
  };
}
