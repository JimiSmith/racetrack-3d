import earcut from 'earcut';

import { buildBasePlate, buildTrackOutline } from './geometry.js';
import { PRIMARY_ORIENTATION_AUTO, normalizeOrientationDeg, normalizePrimaryOrientationDeg } from './orientation.js';
import { rotateOutlineByOrientation, rotatePointsByOrientation } from './orientation.js';
import {
  buildTextMesh,
  buildTextMeshFromRankedPlacements,
  computeRankedTextPlacements,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  TEXT_HEIGHT_MM,
  TEXT_ORIENTATION_AUTO,
  TEXT_ORIENTATION_FIXED,
} from './text3d.js';

let textPlacementCache = { token: null, byOrientation: new Map(), resolvedAutoDeg: null };

export const BASE_THICKNESS_MM = 2.5;
const BASE_CORNER_RADIUS_MM = 3;
const BASE_CORNER_SEGMENTS_PER_CORNER = 8;
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

function appendRoundedArc(points, centerX, centerY, radiusMm, startAngleDeg, endAngleDeg, segments) {
  const step = (endAngleDeg - startAngleDeg) / segments;

  for (let index = 1; index <= segments; index += 1) {
    const angle = ((startAngleDeg + step * index) * Math.PI) / 180;
    points.push({
      x: centerX + Math.cos(angle) * radiusMm,
      y: centerY + Math.sin(angle) * radiusMm,
    });
  }
}

function buildRoundedRectangleRing(minX, maxX, minY, maxY, radiusMm, segmentsPerCorner) {
  const ring = [];

  ring.push({ x: minX + radiusMm, y: minY });
  ring.push({ x: maxX - radiusMm, y: minY });
  appendRoundedArc(ring, maxX - radiusMm, minY + radiusMm, radiusMm, 270, 360, segmentsPerCorner);
  ring.push({ x: maxX, y: maxY - radiusMm });
  appendRoundedArc(ring, maxX - radiusMm, maxY - radiusMm, radiusMm, 0, 90, segmentsPerCorner);
  ring.push({ x: minX + radiusMm, y: maxY });
  appendRoundedArc(ring, minX + radiusMm, maxY - radiusMm, radiusMm, 90, 180, segmentsPerCorner);
  ring.push({ x: minX, y: minY + radiusMm });
  appendRoundedArc(ring, minX + radiusMm, minY + radiusMm, radiusMm, 180, 270, segmentsPerCorner);

  return ring;
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

function buildRaisedRibbonMesh(projectedNodes, scale, forceOpen = false) {
  const path = normalizeProjectedPath(projectedNodes);

  if (path.length < 2) {
    return null;
  }

  const isClosed = !forceOpen && path.length > 2;
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
  const radiusMm = Math.min(BASE_CORNER_RADIUS_MM, (maxX - minX) / 2, (maxY - minY) / 2);

  if (radiusMm <= 0) {
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

  const ring = buildRoundedRectangleRing(
    minX,
    maxX,
    minY,
    maxY,
    radiusMm,
    BASE_CORNER_SEGMENTS_PER_CORNER,
  );
  const flattened = [];

  for (const point of ring) {
    flattened.push(point.x, point.y);
  }

  const indices = earcut(flattened);
  const bottom = ring.map(point => createVertex(point.x, point.y, minZ));
  const top = ring.map(point => createVertex(point.x, point.y, maxZ));
  const triangles = [];

  for (let index = 0; index < indices.length; index += 3) {
    const a = indices[index];
    const b = indices[index + 1];
    const c = indices[index + 2];
    addTriangle(triangles, top[a], top[b], top[c]);
    addTriangle(triangles, bottom[c], bottom[b], bottom[a]);
  }

  for (let index = 0; index < ring.length; index += 1) {
    const next = (index + 1) % ring.length;
    addQuad(triangles, bottom[index], bottom[next], top[next], top[index]);
  }

  return triangles;
}

function buildTrackPrismMesh(outline, scale, projectedNodes = null, forceOpen = false) {
  const raisedRibbonMesh = buildRaisedRibbonMesh(projectedNodes, scale, forceOpen);
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

// Returns a canonical key for a directed edge (a→b), using ~1cm coordinate precision.
// Uses lexicographic ordering so the same edge traversed in either direction hashes identically.
function edgeKey(a, b) {
  const ax = Math.round(a.x * 100), ay = Math.round(a.y * 100);
  const bx = Math.round(b.x * 100), by = Math.round(b.y * 100);
  return (ax < bx || (ax === bx && ay <= by))
    ? `${ax},${ay}|${bx},${by}`
    : `${bx},${by}|${ax},${ay}`;
}

function buildPrimaryEdgeSet(nodes) {
  const set = new Set();
  for (let i = 0; i < nodes.length - 1; i += 1) {
    set.add(edgeKey(nodes[i], nodes[i + 1]));
  }
  return set;
}

// Splits a secondary layout's node chain into sub-chains containing only edges
// not already present in the primary layout. This avoids rendering shared sections twice.
function getUniqueSubChains(secondaryNodes, primaryEdgeSet) {
  const chains = [];
  let current = null;

  for (let i = 0; i < secondaryNodes.length - 1; i += 1) {
    const a = secondaryNodes[i];
    const b = secondaryNodes[i + 1];
    if (primaryEdgeSet.has(edgeKey(a, b))) {
      if (current) { chains.push(current); current = null; }
    } else {
      if (!current) current = [a];
      current.push(b);
    }
  }
  if (current) chains.push(current);
  return chains;
}

// Builds a base plate that encompasses all provided outlines (used for combined-layout mode).
function buildCombinedBasePlate(allOutlines, margin = 50) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const outline of allOutlines) {
    for (const { x, y } of (outline?.outerRing ?? [])) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  minX -= margin; maxX += margin; minY -= margin; maxY += margin;
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

// Selects the best auto orientation and returns the ranked text placements for all 4 candidate
// orientations so that buildTrackModel can cache all of them in one pass.
// Returns { deg, placements: Map<deg, rankedResult|null> | null }
// placements is null when trackName is empty (scoring used 'CIRCUIT' placeholder — not cacheable).
function selectAutoOrientation(outlinePoints, basePlate, projectedNodes, trackName, secondaryProjectedNodes = []) {
  // Build an outline we can use for all candidates.
  // projectedNodes takes priority — same logic as orientTrackGeometry.
  const baseOutline = projectedNodes?.length
    ? buildTrackOutline(projectedNodes)
    : outlinePoints;
  const bp = basePlate ?? (baseOutline ? buildBasePlate(baseOutline) : null);
  if (!bp) return { deg: 0, placements: null };

  const LANDSCAPE_BONUS = 1000;
  const TEXT_BOTTOM_BONUS = 100;
  const CANDIDATES = [0, 90, 180, 270];

  // Scoring text label: use the provided name or a short placeholder for geometry-only scoring.
  const normalizedTrackName = String(trackName ?? '').trim();
  const scoringText = normalizedTrackName || 'CIRCUIT';
  const resultsAreCacheable = Boolean(normalizedTrackName);

  let bestDeg = 0;
  let bestScore = -Infinity;
  const placementsMap = resultsAreCacheable ? new Map() : null;

  for (const deg of CANDIDATES) {
    // Rotate projected nodes when available, otherwise rotate outline directly.
    const rotatedOutline = projectedNodes?.length
      ? buildTrackOutline(rotatePointsByOrientation(projectedNodes, deg))
      : rotateOutlineByOrientation(outlinePoints, deg);

    // In combined mode, rotate all secondary layouts and expand the base plate to fit all of them.
    const rotatedSecondaryOutlines = secondaryProjectedNodes.map(nodes =>
      buildTrackOutline(rotatePointsByOrientation(nodes, deg))
    );
    const rotatedBp = rotatedSecondaryOutlines.length > 0
      ? (buildCombinedBasePlate([rotatedOutline, ...rotatedSecondaryOutlines]) ?? buildBasePlate(rotatedOutline) ?? bp)
      : ((rotatedOutline ? buildBasePlate(rotatedOutline) : null) ?? bp);

    const allOutlinePoints = rotatedSecondaryOutlines.length > 0
      ? [rotatedOutline, ...rotatedSecondaryOutlines]
      : null;

    let score = 0;

    // Landscape bonus: width >= height after rotation.
    if (rotatedBp.width >= rotatedBp.height) {
      score += LANDSCAPE_BONUS;
    }

    // Text-bottom bonus: text centroid Y should be in the lower half of the base plate.
    // We use computeRankedTextPlacements so the results can also be cached for later use.
    try {
      const scale = computeScale(rotatedBp);
      const ranked = computeRankedTextPlacements(scoringText, rotatedOutline, rotatedBp, scale, {
        textOrientationMode: TEXT_ORIENTATION_FIXED,
        allOutlinePoints,
      });
      placementsMap?.set(deg, ranked);
      if (ranked) {
        const chosenOrientation = ranked.orientationResults.find(o => o.rotation === 0)
          ?? ranked.orientationResults[0];
        const best = chosenOrientation?.placements[0];
        if (best?.layout?.lineBounds?.length) {
          const { candidate, layout } = best;
          const offsetY = candidate.bounds.minY
            + (candidate.bounds.height - layout.fittedHeight) / 2
            - layout.bounds.minY * layout.scale;
          const textCentroidY = layout.lineBounds.reduce(
            (sum, b) => sum + (b.minY * layout.scale + offsetY + b.maxY * layout.scale + offsetY) / 2,
            0,
          ) / layout.lineBounds.length;
          const scaledBpCenterY = (rotatedBp.minY + rotatedBp.maxY) / 2 * scale;
          if (textCentroidY < scaledBpCenterY) {
            score += TEXT_BOTTOM_BONUS;
          }
        }
      }
    } catch {
      // Text placement scoring is best-effort; skip bonus on failure.
      placementsMap?.set(deg, null);
    }

    // Stable tiebreak: prefer smaller degree value.
    if (score > bestScore) {
      bestScore = score;
      bestDeg = deg;
    }
  }

  return { deg: bestDeg, placements: placementsMap };
}

export function buildTrackModel({
  outlinePoints,
  basePlate,
  trackName,
  projectedNodes = null,
  secondaryProjectedNodes = [],
  primaryOrientationDeg = undefined,
  orientationDeg = undefined,
  textOrientationMode = undefined,
  textPositionRank = DEFAULT_TEXT_POSITION_RANK,
  placementCacheToken = null,
}) {
  const normalizedPrimaryOrientationDeg = normalizePrimaryOrientationDeg(
    primaryOrientationDeg === undefined
      ? (orientationDeg === undefined ? PRIMARY_ORIENTATION_AUTO : orientationDeg)
      : primaryOrientationDeg,
  );

  // Reset the cache upfront if the token has changed, so all subsequent reads see a clean slate.
  if (placementCacheToken !== null && placementCacheToken !== textPlacementCache.token) {
    textPlacementCache = { token: placementCacheToken, byOrientation: new Map(), resolvedAutoDeg: null };
  }
  const cacheActive = placementCacheToken !== null;

  let resolvedOrientationDeg;
  if (normalizedPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO) {
    if (cacheActive && textPlacementCache.resolvedAutoDeg !== null) {
      // Auto-orientation already computed and cached — use it directly.
      resolvedOrientationDeg = textPlacementCache.resolvedAutoDeg;
    } else {
      // Compute auto orientation. This also runs text placement for all 4 candidate orientations,
      // so we pre-populate the cache with all of them in one pass.
      const autoResult = selectAutoOrientation(
        outlinePoints, basePlate, projectedNodes, trackName, secondaryProjectedNodes,
      );
      resolvedOrientationDeg = autoResult.deg;
      if (cacheActive) {
        textPlacementCache.resolvedAutoDeg = resolvedOrientationDeg;
        if (autoResult.placements) {
          for (const [deg, ranked] of autoResult.placements) {
            textPlacementCache.byOrientation.set(deg, ranked);
          }
        }
      }
    }
  } else {
    resolvedOrientationDeg = normalizedPrimaryOrientationDeg;
  }

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

  // Orient secondary layouts with the same rotation and build their outlines.
  const orientedSecondaries = secondaryProjectedNodes.map(nodes =>
    rotatePointsByOrientation(nodes, resolvedOrientationDeg)
  );
  const secondaryOutlines = orientedSecondaries.map(nodes => buildTrackOutline(nodes));

  // In combined mode, expand the base plate to encompass all layouts.
  const effectiveBasePlate = secondaryOutlines.length > 0
    ? (buildCombinedBasePlate([orientedGeometry.outlinePoints, ...secondaryOutlines]) ?? orientedGeometry.basePlate)
    : orientedGeometry.basePlate;

  const scale = computeScale(effectiveBasePlate);
  const basePlateTriangles = buildBasePlateMesh(effectiveBasePlate, scale);

  // Build secondary prism meshes — unique segments only to avoid z-fighting on shared sections.
  const primaryEdgeSet = buildPrimaryEdgeSet(orientedGeometry.projectedNodes ?? []);
  const secondaryTrackTriangles = orientedSecondaries.flatMap(nodes => {
    const uniqueChains = getUniqueSubChains(nodes, primaryEdgeSet);
    return uniqueChains.flatMap(chain => buildTrackPrismMesh(null, scale, chain, true));
  });

  // Primary layout prism mesh (shown in red in the preview/export).
  const trackTriangles = buildTrackPrismMesh(
    orientedGeometry.outlinePoints, scale, orientedGeometry.projectedNodes,
  );

  // Text placement uses all visible layouts as obstacles in combined mode.
  const allOutlinePoints = secondaryOutlines.length > 0
    ? [orientedGeometry.outlinePoints, ...secondaryOutlines]
    : null;

  let rankedPlacements = null;
  const normalizedTrackName = String(trackName ?? '').trim();
  if (normalizedTrackName) {
    rankedPlacements = cacheActive
      ? textPlacementCache.byOrientation.get(resolvedOrientationDeg) ?? null
      : null;

    if (!rankedPlacements) {
      rankedPlacements = computeRankedTextPlacements(
        normalizedTrackName,
        orientedGeometry.outlinePoints,
        effectiveBasePlate,
        scale,
        { textOrientationMode: resolvedTextOrientationMode, allOutlinePoints },
      );
      if (cacheActive) {
        textPlacementCache.byOrientation.set(resolvedOrientationDeg, rankedPlacements);
      }
    }
  }

  const textTriangles = buildTextMeshFromRankedPlacements(rankedPlacements, {
    textPositionRank: resolvedTextPositionRank,
    textOrientationMode: resolvedTextOrientationMode,
    baseThickness: BASE_THICKNESS_MM,
    textHeight: TEXT_HEIGHT_MM,
  });

  return {
    triangles: [...basePlateTriangles, ...secondaryTrackTriangles, ...trackTriangles, ...textTriangles],
    baseTriangleCount: basePlateTriangles.length,
    secondaryTrackTriangleCount: secondaryTrackTriangles.length,
    trackTriangleCount: trackTriangles.length,
    textTriangleCount: textTriangles.length,
    scale,
    primaryOrientationDeg: normalizedPrimaryOrientationDeg,
    textOrientationMode: resolvedTextOrientationMode,
    textPositionRank: resolvedTextPositionRank,
    orientationDeg: orientedGeometry.orientationDeg,
    outlinePoints: orientedGeometry.outlinePoints,
    basePlate: effectiveBasePlate,
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
