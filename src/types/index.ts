/**
 * Shared TypeScript type definitions for racetrack-3d.
 * Re-exports all types from the domain-specific type modules.
 *
 * Import individual modules when you only need types from one domain,
 * or import from here for convenience.
 */

export type {
  LatLonNode,
  ProjectedNode,
  Point2D,
  Way,
  LayoutStats,
  Layout,
  TrackGeometryResult,
  WayGraphVertex,
  WayGraphEdge,
  WayGraph,
} from './geometry.js';

export type {
  Vertex,
  Triangle,
  BasePlate,
  OutlinePoints,
  TrackModel,
} from './model.js';

export type {
  Rect2D,
  TextPlacementCandidate,
  FittedTextLayout,
  RankedTextPlacement,
  RankedPlacements,
  ScoringWeights,
} from './text.js';

export type {
  TrackSearchEntry,
  SearchResult,
} from './search.js';
