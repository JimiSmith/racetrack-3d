import earcut from 'earcut';

import { buildBasePlate, buildTrackOutline } from './geometry.js';
import { PRIMARY_ORIENTATION_AUTO, normalizeOrientationDeg, normalizePrimaryOrientationDeg } from './orientation.js';
import { rotateOutlineByOrientation, rotatePointsByOrientation } from './orientation.js';
import {
  __debugTextPlacement,
  buildTextMesh,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  TEXT_ORIENTATION_AUTO,
  TEXT_ORIENTATION_FIXED,
} from './text3d.js';

export const BASE_THICKNESS_MM = 8;
const TRACK_HEIGHT_MM = 3;
const TRACK_WIDTH_METRES = 12;
const TARGET_MAX_SIZE_MM = 200; // fit model within this bounding box dimension
const MAX_RIBBON_SECTION_STEP_METRES = 4;

// Compute a scale factor so the outline fits within TARGET_MAX_SIZE_MM
export function computeScale(basePlate) {
  const longestSide = Math.max(basePlate.width, basePlate.height); // metres
  if (longestSide <= 0) return 1;
  return TARGET_MAX_SIZE_MM / longestSide;
}

function toScaled(valueMetres, scale) {
  return valueMetres * scale;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeProjectedPath(projectedNodes) {
  if (!projectedNodes?.length) {
    return [];
  }

  const normalized = [];

  for (const node of projectedNodes) {
    if (!Number.isFinite(node?.x) || !Number.isFinite(node?.y)) {
      continue;
    }

    const previous = normalized[normalized.length - 1];
    if (previous && previous.x === node.x && previous.y === node.y) {
      continue;
    }

    normalized.push(node);
  }

  if (normalized.length > 2) {
    const first = normalized[0];
    const last = normalized[normalized.length - 1];
    if (first.x === last.x && first.y === last.y) {
      normalized.pop();
    }
  }

  return normalized;
}

function normalizeVector(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return null;
  }

  return { x: dx / length, y: dy / length };
}

function buildRaisedRibbonMesh(projectedNodes, scale) {
  const path = normalizeProjectedPath(projectedNodes);

  if (path.length < 2) {
    return null;
  }

  const isClosed = path.length > 2;
  const bottomZ = BASE_THICKNESS_MM;
  const halfWidth = TRACK_WIDTH_METRES / 2;
  const sections = [];
  const segmentCount = isClosed ? path.length : path.length - 1;

  for (let index = 0; index < segmentCount; index += 1) {
    const start = path[index];
    const end = path[(index + 1) % path.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const direction = normalizeVector(dx, dy);
    const segmentLength = Math.hypot(dx, dy);

    if (!direction || segmentLength === 0) {
      continue;
    }

    const offsetX = -direction.y * halfWidth;
    const offsetY = direction.x * halfWidth;
    const sampleCount = Math.max(1, Math.ceil(segmentLength / MAX_RIBBON_SECTION_STEP_METRES));

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const t = sampleIndex / sampleCount;
      const x = start.x + dx * t;
      const y = start.y + dy * t;
      const elevation = (start.elevation ?? 0) + ((end.elevation ?? start.elevation ?? 0) - (start.elevation ?? 0)) * t;
      const section = {
        topLeft: createVertex(toScaled(x + offsetX, scale), toScaled(y + offsetY, scale), bottomZ + TRACK_HEIGHT_MM + toScaled(elevation, scale)),
        topRight: createVertex(toScaled(x - offsetX, scale), toScaled(y - offsetY, scale), bottomZ + TRACK_HEIGHT_MM + toScaled(elevation, scale)),
        bottomLeft: createVertex(toScaled(x + offsetX, scale), toScaled(y + offsetY, scale), bottomZ),
        bottomRight: createVertex(toScaled(x - offsetX, scale), toScaled(y - offsetY, scale), bottomZ),
      };
      const previous = sections[sections.length - 1];

      if (
        previous
        && previous.topLeft.x === section.topLeft.x
        && previous.topLeft.y === section.topLeft.y
        && previous.topRight.x === section.topRight.x
        && previous.topRight.y === section.topRight.y
      ) {
        continue;
      }

      sections.push(section);
    }
  }

  if (sections.length < 2) {
    return null;
  }

  const triangles = [];
  const sectionSegmentCount = isClosed ? sections.length : sections.length - 1;

  for (let index = 0; index < sectionSegmentCount; index += 1) {
    const current = sections[index];
    const next = sections[(index + 1) % sections.length];

    addQuad(triangles, current.topLeft, current.topRight, next.topRight, next.topLeft);
    addQuad(triangles, current.bottomLeft, next.bottomLeft, next.bottomRight, current.bottomRight);
    addQuad(triangles, current.bottomLeft, current.topLeft, next.topLeft, next.bottomLeft);
    addQuad(triangles, current.bottomRight, next.bottomRight, next.topRight, current.topRight);
  }

  if (!isClosed) {
    const start = sections[0];
    const end = sections[sections.length - 1];

    addQuad(triangles, start.bottomRight, start.bottomLeft, start.topLeft, start.topRight);
    addQuad(triangles, end.bottomLeft, end.bottomRight, end.topRight, end.topLeft);
  }

  return triangles;
}

function boundsFromPoints(points) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function rotateBasePlateByOrientation(basePlate, orientationDeg) {
  if (!basePlate) {
    return null;
  }

  return boundsFromPoints(rotatePointsByOrientation([
    { x: basePlate.minX, y: basePlate.minY },
    { x: basePlate.maxX, y: basePlate.minY },
    { x: basePlate.maxX, y: basePlate.maxY },
    { x: basePlate.minX, y: basePlate.maxY },
  ], orientationDeg));
}

export function orientTrackGeometry({
  outlinePoints,
  basePlate,
  projectedNodes = null,
  orientationDeg = 0,
}) {
  const normalizedOrientationDeg = normalizeOrientationDeg(orientationDeg);
  const orientedProjectedNodes = projectedNodes?.length
    ? rotatePointsByOrientation(projectedNodes, normalizedOrientationDeg)
    : null;
  const orientedOutlinePoints = orientedProjectedNodes?.length
    ? buildTrackOutline(orientedProjectedNodes)
    : rotateOutlineByOrientation(outlinePoints, normalizedOrientationDeg);
  const orientedBasePlate = rotateBasePlateByOrientation(basePlate, normalizedOrientationDeg)
    ?? buildBasePlate(orientedOutlinePoints);

  return {
    outlinePoints: orientedOutlinePoints,
    basePlate: orientedBasePlate,
    projectedNodes: orientedProjectedNodes,
    orientationDeg: normalizedOrientationDeg,
  };
}

function buildBasePlateMesh(basePlate, scale) {
  if (!basePlate) {
    throw new Error('Base plate dimensions are missing');
  }

  const minX = toScaled(basePlate.minX, scale);
  const maxX = toScaled(basePlate.maxX, scale);
  const minY = toScaled(basePlate.minY, scale);
  const maxY = toScaled(basePlate.maxY, scale);
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

function buildTrackPrismMesh(outline, scale, projectedNodes = null) {
  const raisedRibbonMesh = buildRaisedRibbonMesh(projectedNodes, scale);
  if (raisedRibbonMesh) {
    return raisedRibbonMesh;
  }

  // Accept {outerRing, holes} or plain array (fallback)
  const outerRing = ensureCounterClockwise(normalizeRing(outline?.outerRing ?? outline));
  const holeRings = (outline?.holes ?? []).map(h => normalizeRing(h));

  // Flatten all rings for earcut: [outerRing, ...holes]
  const allRings = [outerRing, ...holeRings];
  const flattened = [];
  const holeIndices = [];
  const allVertices = []; // parallel flat list of {x,y} for vertex lookup

  for (const ring of allRings) {
    if (flattened.length > 0) holeIndices.push(allVertices.length);
    for (const point of ring) {
      flattened.push(toScaled(point.x, scale), toScaled(point.y, scale));
      allVertices.push(point);
    }
  }

  const indices = earcut(flattened, holeIndices.length ? holeIndices : null);
  if (indices.length < 3) {
    throw new Error('Failed to triangulate track outline');
  }

  const bottomZ = BASE_THICKNESS_MM;

  // Sample elevation from the nearest point along the path so each
  // cross-section stays level while the ribbon still rises and falls.
  function elevOffsetMm(px, py) {
    if (!projectedNodes?.length) return 0;
    if (projectedNodes.length === 1) {
      return toScaled(projectedNodes[0].elevation ?? 0, scale);
    }

    let minDist = Infinity;
    let elev = projectedNodes[0].elevation ?? 0;

    for (let index = 0; index < projectedNodes.length; index += 1) {
      const start = projectedNodes[index];
      const end = projectedNodes[(index + 1) % projectedNodes.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;

      if (lengthSquared === 0) {
        continue;
      }

      const t = clamp(((px - start.x) * dx + (py - start.y) * dy) / lengthSquared, 0, 1);
      const nearestX = start.x + dx * t;
      const nearestY = start.y + dy * t;
      const distX = px - nearestX;
      const distY = py - nearestY;
      const distanceSquared = distX * distX + distY * distY;

      if (distanceSquared < minDist) {
        const startElevation = start.elevation ?? 0;
        const endElevation = end.elevation ?? startElevation;
        minDist = distanceSquared;
        elev = startElevation + (endElevation - startElevation) * t;
      }
    }

    return toScaled(elev, scale);
  }

  const elevationOffsets = allVertices.map(p => elevOffsetMm(p.x, p.y));
  const bottom = allVertices.map(p => createVertex(toScaled(p.x, scale), toScaled(p.y, scale), bottomZ));
  const top = allVertices.map((p, index) => createVertex(
    toScaled(p.x, scale),
    toScaled(p.y, scale),
    bottomZ + TRACK_HEIGHT_MM + elevationOffsets[index],
  ));
  const triangles = [];

  // Top and bottom faces
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    addTriangle(triangles, top[a], top[b], top[c]);
    addTriangle(triangles, bottom[c], bottom[b], bottom[a]);
  }

  // Side walls for each ring (track offsets built alongside allVertices above)
  let ringOffset = 0;
  for (const ring of allRings) {
    for (let i = 0; i < ring.length; i++) {
      const curr = ringOffset + i;
      const next = ringOffset + (i + 1) % ring.length;
      addQuad(triangles, bottom[curr], bottom[next], top[next], top[curr]);
    }
    ringOffset += ring.length;
  }

  return triangles;
}

function computeAutoOrientationDeg(outlinePoints, basePlate, projectedNodes = null, trackName = null) {
  // Build an outline we can use for all candidates.
  // projectedNodes takes priority — same logic as orientTrackGeometry.
  const baseOutline = projectedNodes?.length
    ? buildTrackOutline(projectedNodes)
    : outlinePoints;
  const bp = basePlate ?? (baseOutline ? buildBasePlate(baseOutline) : null);
  if (!bp) return 0;

  const LANDSCAPE_BONUS = 1000;
  const TEXT_BOTTOM_BONUS = 100;
  const CANDIDATES = [0, 90, 180, 270];

  // Scoring text label: use the provided name or a short placeholder for geometry-only scoring.
  const scoringText = trackName ? String(trackName).trim() : 'CIRCUIT';

  let bestDeg = 0;
  let bestScore = -Infinity;

  for (const deg of CANDIDATES) {
    // Rotate projected nodes when available, otherwise rotate outline directly.
    const rotatedOutline = projectedNodes?.length
      ? buildTrackOutline(rotatePointsByOrientation(projectedNodes, deg))
      : rotateOutlineByOrientation(outlinePoints, deg);
    const rotatedBp = (rotatedOutline ? buildBasePlate(rotatedOutline) : null) ?? bp;

    let score = 0;

    // Landscape bonus: width >= height after rotation.
    if (rotatedBp.width >= rotatedBp.height) {
      score += LANDSCAPE_BONUS;
    }

    // Text-bottom bonus: text centroid Y should be in the lower half of the base plate.
    try {
      const scale = computeScale(rotatedBp);
      const placement = __debugTextPlacement(scoringText, rotatedOutline, rotatedBp, scale, {
        textOrientationMode: TEXT_ORIENTATION_FIXED,
      });
      if (placement?.lineBounds?.length) {
        const textCentroidY = placement.lineBounds.reduce(
          (sum, b) => sum + (b.minY + b.maxY) / 2,
          0,
        ) / placement.lineBounds.length;
        const scaledBpCenterY = (rotatedBp.minY + rotatedBp.maxY) / 2 * scale;
        if (textCentroidY < scaledBpCenterY) {
          score += TEXT_BOTTOM_BONUS;
        }
      }
    } catch {
      // Text placement scoring is best-effort; skip bonus on failure.
    }

    // Stable tiebreak: prefer smaller degree value.
    if (score > bestScore) {
      bestScore = score;
      bestDeg = deg;
    }
  }

  return bestDeg;
}

export function buildTrackModel({
  outlinePoints,
  basePlate,
  trackName,
  projectedNodes = null,
  primaryOrientationDeg = undefined,
  orientationDeg = undefined,
  textOrientationMode = undefined,
  textPositionRank = DEFAULT_TEXT_POSITION_RANK,
}) {
  const normalizedPrimaryOrientationDeg = normalizePrimaryOrientationDeg(
    primaryOrientationDeg === undefined
      ? (orientationDeg === undefined ? PRIMARY_ORIENTATION_AUTO : orientationDeg)
      : primaryOrientationDeg,
  );
  const resolvedOrientationDeg = normalizedPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO
    ? computeAutoOrientationDeg(outlinePoints, basePlate, projectedNodes, trackName)
    : normalizedPrimaryOrientationDeg;
  // Text orientation is always fixed: the model is already rotated to the correct orientation,
  // so text should be placed right-side-up on the rotated model.
  const resolvedTextOrientationMode = textOrientationMode ?? TEXT_ORIENTATION_FIXED;
  const resolvedTextPositionRank = normalizeTextPositionRank(textPositionRank);
  const orientedGeometry = orientTrackGeometry({
    outlinePoints,
    basePlate,
    projectedNodes,
    orientationDeg: resolvedOrientationDeg,
  });
  const scale = computeScale(orientedGeometry.basePlate);
  const basePlateTriangles = buildBasePlateMesh(orientedGeometry.basePlate, scale);
  const trackTriangles = buildTrackPrismMesh(orientedGeometry.outlinePoints, scale, orientedGeometry.projectedNodes);
  const textTriangles = trackName
    ? buildTextMesh(trackName, orientedGeometry.outlinePoints, orientedGeometry.basePlate, scale, {
      baseThickness: BASE_THICKNESS_MM,
      textPositionRank: resolvedTextPositionRank,
      textOrientationMode: resolvedTextOrientationMode,
    })
    : [];

  return {
    triangles: [...basePlateTriangles, ...trackTriangles, ...textTriangles],
    baseTriangleCount: basePlateTriangles.length,
    trackTriangleCount: trackTriangles.length,
    textTriangleCount: textTriangles.length,
    scale,
    primaryOrientationDeg: normalizedPrimaryOrientationDeg,
    textOrientationMode: resolvedTextOrientationMode,
    textPositionRank: resolvedTextPositionRank,
    orientationDeg: orientedGeometry.orientationDeg,
    outlinePoints: orientedGeometry.outlinePoints,
    basePlate: orientedGeometry.basePlate,
    projectedNodes: orientedGeometry.projectedNodes,
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
