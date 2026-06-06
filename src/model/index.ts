// Public re-exports for src/model/

export { BASE_THICKNESS_MM, TARGET_MAX_SIZE_MM, computeScale } from './base-plate.js';
export { normalizeProjectedPath, TRACK_HEIGHT_MM, TRACK_WIDTH_METRES } from './track-ribbon.js';
export { buildModelGeometryCsg } from './base-plate-csg.js';
export {
  PRIMARY_ORIENTATION_AUTO,
  normalizeOrientationDeg,
  normalizePrimaryOrientationDeg,
  rotatePointByOrientation,
  rotatePointsByOrientation,
  rotateOutlineByOrientation,
  rotateBasePlateByOrientation,
  orientTrackGeometry,
  selectAutoOrientation,
} from './orientation.js';
export { buildCombinedBasePlate, buildPrimaryEdgeSet, getUniqueSubChains, edgeKey } from './combined-layout.js';
export {
  buildTrackModel,
  __resetModelPerfCounters,
  __getModelPerfCounters,
  __disableModelPerfCounters,
} from './track-model.js';
export type { BuildTrackModelOptions } from './track-model.js';
export type { OrientTrackGeometryOptions, OrientedTrackGeometry, AutoOrientationResult } from './orientation.js';
export { serializeBinaryStl, computeNormal, exportStl } from '../export/stl.js';
