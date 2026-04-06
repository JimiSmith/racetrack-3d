/**
 * Shared geometry types used across the racetrack-3d codebase.
 * These represent the data flowing through the OSM → projection → model pipeline.
 */

/** A geographic coordinate in WGS-84 latitude/longitude. */
export interface LatLonNode {
  lat: number;
  lon: number;
}

/**
 * A node projected from lat/lon into a flat 2D plane (metres from centroid),
 * optionally carrying an elevation value.
 */
export interface ProjectedNode {
  x: number;
  y: number;
  elevation: number;
}

/** A 2D point in the projected coordinate system (metres). */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * An OSM way, as extracted from the Overpass API response.
 * Tags hold raw OSM key/value pairs; nodes are the geographic shape.
 */
export interface Way {
  id: number;
  tags: Record<string, unknown>;
  nodes: LatLonNode[];
}

/** Statistical metadata attached to each circuit layout. */
export interface LayoutStats {
  /** Total route length in metres. */
  lengthMetres: number;
  /** Number of OSM way segments that make up this layout. */
  segmentCount: number;
  /** Number of diverging sections in variant layouts. */
  variantSectionCount?: number;
}

/**
 * A single named circuit layout — one route around the venue
 * (e.g. "Grand Prix", "National", "Short").
 */
export interface Layout {
  /** Stable identifier for this layout within the result (e.g. "layout-1"). */
  id: string;
  /** Human-readable name for display (e.g. "Grand Prix"). */
  name: string;
  /** Ordered list of geographic nodes forming the route. */
  nodes: LatLonNode[];
  stats: LayoutStats;
}

/**
 * The top-level result from the track geometry pipeline.
 * Contains all discovered layouts plus which one to show by default.
 */
export interface TrackGeometryResult {
  layouts: Layout[];
  /** Index into `layouts` that should be pre-selected. */
  selectedLayoutIndex: number;
  /** Venue name strings collected from OSM tags (used for display). */
  osmVenueNames: string[];
}

/** A vertex entry in the way graph built by `buildWayGraph`. */
export interface WayGraphVertex {
  /** String key encoding the endpoint coordinates. */
  id: string;
  /** Geographic position of this vertex. */
  node: LatLonNode;
  /** IDs of edges incident to this vertex. */
  edges: number[];
}

/** An edge entry in the way graph — represents one OSM way segment. */
export interface WayGraphEdge {
  /** Numeric index into the edges array. */
  id: number;
  /** ID of the start vertex. */
  start: string;
  /** ID of the end vertex. */
  end: string;
  /** Ordered nodes along this edge. */
  nodes: LatLonNode[];
  /** Raw OSM tags from the source way. */
  tags: Record<string, unknown>;
  /** Length of this edge in metres. */
  length: number;
}

/**
 * Node/edge adjacency structure produced by `buildWayGraph`.
 * Used for cycle detection and route stitching.
 */
export interface WayGraph {
  vertices: Map<string, WayGraphVertex>;
  edges: WayGraphEdge[];
}
