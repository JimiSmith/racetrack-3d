/**
 * Thin re-export shim for the src/text/ module group.
 *
 * This file previously contained all 1585 lines of the text placement and
 * mesh generation pipeline. Those have been decomposed into focused modules
 * under src/text/. This shim re-exports the public API so that existing
 * callers (src/model.js, src/main.js, tests) continue to work unchanged.
 */

// --- Public API re-exports ---
export {
  TEXT_HEIGHT_MM,
  DEFAULT_TEXT_POSITION_RANK,
  normalizeTextPositionRank,
  buildTextMeshFromRankedPlacements,
} from './text/mesh.js';

export { SCORING_WEIGHTS } from './text/scoring.js';

export { computeRankedTextPlacements } from './text/placement.js';

// --- Performance counter aggregation across all sub-modules ---
import {
  __resetPerfCounters as _resetPlacementCounters,
  __getPerfCounters as _getPlacementCounters,
  __disablePerfCounters as _disablePlacementCounters,
} from './text/placement.js';

import {
  __resetPerfCounters as _resetContoursCounters,
  __getPerfCounters as _getContoursCounters,
  __disablePerfCounters as _disableContoursCounters,
} from './text/contours.js';

import {
  __resetPerfCounters as _resetLineBreakingCounters,
  __getPerfCounters as _getLineBreakingCounters,
  __disablePerfCounters as _disableLineBreakingCounters,
} from './text/line-breaking.js';

export function __resetPerfCounters() {
  _resetPlacementCounters();
  _resetContoursCounters();
  _resetLineBreakingCounters();
}

export function __getPerfCounters() {
  const placement = _getPlacementCounters();
  const contours = _getContoursCounters();
  const lineBreaking = _getLineBreakingCounters();
  if (!placement && !contours && !lineBreaking) {
    return null;
  }
  return {
    findOptimalLineBreaks: lineBreaking?.findOptimalLineBreaks ?? 0,
    buildMultilineContours: contours?.buildMultilineContours ?? 0,
    computePlacementMask: placement?.computePlacementMask ?? 0,
    findPlacementCandidates: placement?.findPlacementCandidates ?? 0,
    rankTextPlacements: placement?.rankTextPlacements ?? 0,
    computeRankedTextPlacements: placement?.computeRankedTextPlacements ?? 0,
  };
}

export function __disablePerfCounters() {
  _disablePlacementCounters();
  _disableContoursCounters();
  _disableLineBreakingCounters();
}

// --- Imports needed by debug / legacy functions below ---
import {
  computeSizeWindowMultiplier as _computeSizeWindowMultiplier,
  computeLineCountMultiplier as _computeLineCountMultiplier,
  computeTextClearanceMultiplier as _computeTextClearanceMultiplier,
  SCORING_WEIGHTS as _SCORING_WEIGHTS,
} from './text/scoring.js';

import { findOptimalLineBreaksForText } from './text/line-breaking.js';

import {
  selectAndExpandPlacement as _selectAndExpandPlacement,
  TEXT_HEIGHT_MM as _TEXT_HEIGHT_MM,
} from './text/mesh.js';

import {
  computeRankedTextPlacements as _computeRankedTextPlacements,
  scaleOutline as _scaleOutline,
  createScaledBounds as _createScaledBounds,
  computePlacementMask as _computePlacementMask,
  findPlacementCandidates as _findPlacementCandidates,
  rectIntersectsPolygon as _rectIntersectsPolygon,
  compareRankedTextPlacements as _compareRankedTextPlacements,
  rankTextPlacements as _rankTextPlacements,
} from './text/placement.js';

import {
  buildContourTree as _buildContourTree,
  collectShapes as _collectShapes,
} from './text/contours.js';

import earcut from 'earcut';

import { loadFont as _loadFont } from './text/font-loader.js';

// ─── Private helpers ──────────────────────────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function signedArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function triangulateShape(shape, minZ, maxZ) {
  const rings = [shape.outer, ...shape.holes];
  const flattened = [];
  const holeIndices = [];
  const vertices2d = [];

  for (const ring of rings) {
    if (flattened.length > 0) {
      holeIndices.push(vertices2d.length);
    }
    for (const point of ring) {
      flattened.push(point.x, point.y);
      vertices2d.push(point);
    }
  }

  const indices = earcut(flattened, holeIndices.length ? holeIndices : null);
  const bottomVertices = vertices2d.map(point => createVertex(point.x, point.y, minZ));
  const topVertices = vertices2d.map(point => createVertex(point.x, point.y, maxZ));
  const triangles = [];

  for (let index = 0; index < indices.length; index += 3) {
    addTriangle(triangles, topVertices[indices[index]], topVertices[indices[index + 1]], topVertices[indices[index + 2]]);
    addTriangle(triangles, bottomVertices[indices[index + 2]], bottomVertices[indices[index + 1]], bottomVertices[indices[index]]);
  }

  let ringOffset = 0;
  for (const ring of rings) {
    const clockwise = signedArea(ring) < 0;
    for (let index = 0; index < ring.length; index += 1) {
      const current = ringOffset + index;
      const next = ringOffset + ((index + 1) % ring.length);
      if (clockwise) {
        addQuad(triangles, bottomVertices[next], bottomVertices[current], topVertices[current], topVertices[next]);
      } else {
        addQuad(triangles, bottomVertices[current], bottomVertices[next], topVertices[next], topVertices[current]);
      }
    }
    ringOffset += ring.length;
  }

  return triangles;
}

function computeTextPlacement(text, outlinePoints, basePlate, scale, options = {}) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) {
    return null;
  }

  const rankedResult = _computeRankedTextPlacements(text, outlinePoints, basePlate, scale, options);
  const expanded = _selectAndExpandPlacement(rankedResult, options);
  if (!expanded) {
    return null;
  }

  return { ...expanded, normalizedText };
}

// ─── Debug exports (for tests) ────────────────────────────────────────────────

export function __findOptimalLineBreaks(text, lineCount, font) {
  return findOptimalLineBreaksForText(text, lineCount, font ?? null);
}

export function __debugTextFitModifiers(heightMm, lineCount, fractionOutside = 1) {
  return {
    sizeWindowMultiplier: _computeSizeWindowMultiplier(heightMm),
    lineCountMultiplier: _computeLineCountMultiplier(lineCount),
    outsideMultiplier: _SCORING_WEIGHTS.outsideMultiplierMin + _SCORING_WEIGHTS.outsideMultiplierRange * clamp(fractionOutside, 0, 1),
  };
}

export function __debugCompareRankedTextPlacements(a, b) {
  return _compareRankedTextPlacements(a, b);
}

export function __debugTextPlacement(text, outlinePoints, basePlate, scale, options = {}) {
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
  if (!placement) {
    return null;
  }

  return {
    text: placement.text,
    lines: [...placement.lines],
    lineBounds: placement.lineBounds.map(bounds => ({ ...bounds })),
    scale: placement.scale,
    candidateIndex: placement.candidateIndex,
    candidateCount: placement.candidateCount,
    placementRank: placement.placementRank,
    placementCount: placement.placementCount,
    score: placement.score,
    candidateArea: placement.candidate?.area,
    candidateFractionOutside: placement.candidate?.fractionOutside,
    candidateTrackClearance: placement.candidate?.trackClearance,
  };
}

export function __debugAllPlacements(text, outlinePoints, basePlate, scale, options = {}) {
  const normalizedText = String(text ?? '').trim();
  if (!normalizedText) { return null; }

  const font = _loadFont(options.font ?? null);
  const scaledOutline = _scaleOutline(outlinePoints, scale);
  const scaledBasePlate = _createScaledBounds(basePlate, scale);
  const placementMask = _computePlacementMask([scaledOutline], scaledOutline, scaledBasePlate);
  const { candidates, distanceMap, maxTrackClearance } = _findPlacementCandidates(scaledBasePlate, placementMask);
  if (!candidates.length) { return null; }

  const clearanceContext = {
    distanceMap,
    maxTrackClearance,
    cellWidth: placementMask.cellWidth,
    cellHeight: placementMask.cellHeight,
    originX: scaledBasePlate.minX,
    originY: scaledBasePlate.minY,
  };
  const placements = _rankTextPlacements(normalizedText, font, candidates, clearanceContext);

  return placements.map(({ candidateIndex, layout, score, candidate }) => {
    const textHeight = layout.averageLineHeight * layout.scale;
    const utilization = Math.min(1, (layout.fittedWidth * layout.fittedHeight) / Math.max(candidate.bounds.width * candidate.bounds.height, Number.EPSILON));
    const lineBalance = layout.maxLineWidth > 0 ? layout.minLineWidth / layout.maxLineWidth : 1;
    return {
      candidateIndex,
      lines: layout.lines,
      lineCount: layout.lineCount,
      score,
      textHeight,
      utilization,
      lineBalance,
      averageLineHeight: layout.averageLineHeight,
      fittedScale: layout.scale,
      fittedWidth: layout.fittedWidth,
      fittedHeight: layout.fittedHeight,
      candidateArea: candidate.area,
      candidateWidth: candidate.bounds.width,
      candidateHeight: candidate.bounds.height,
      fractionOutside: candidate.fractionOutside,
      normalizedTrackClearance: candidate.normalizedTrackClearance,
      centreDistance: candidate.centreDistance,
      sizeWindowMultiplier: _computeSizeWindowMultiplier(textHeight),
      lineCountMultiplier: _computeLineCountMultiplier(layout.lineCount),
      textClearanceMultiplier: _computeTextClearanceMultiplier(candidate.bounds, layout, clearanceContext),
    };
  });
}

export function __debugPlacementCandidates(outlinePoints, basePlate, scale) {
  const scaledOutline = _scaleOutline(outlinePoints, scale);
  const scaledBasePlate = _createScaledBounds(basePlate, scale);
  const placementMask = _computePlacementMask([scaledOutline], scaledOutline, scaledBasePlate);
  return _findPlacementCandidates(scaledBasePlate, placementMask).candidates;
}

export function __debugRectIntersectsPolygon(rect, polygon) {
  return _rectIntersectsPolygon(rect, polygon);
}

// ─── Legacy buildTextMesh (for tests — uses triangulateShape directly) ────────

export function buildTextMesh(text, outlinePoints, basePlate, scale, options = {}) {
  const placement = computeTextPlacement(text, outlinePoints, basePlate, scale, options);
  if (!placement?.contours?.length) {
    return [];
  }

  const shapes = _collectShapes(_buildContourTree(placement.contours));
  const minZ = options.baseThickness ?? 8;
  const maxZ = minZ + (options.textHeight ?? _TEXT_HEIGHT_MM);

  return shapes.flatMap(shape => triangulateShape(shape, minZ, maxZ));
}
