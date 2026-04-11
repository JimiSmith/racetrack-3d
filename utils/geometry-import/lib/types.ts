/** A geographic coordinate in WGS-84 latitude/longitude. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** CLI options for the import-osm-data command. */
export interface ImportOsmDataOptions {
  tracks: string[] | null; // null = all tracks
  force: boolean;
  bboxMargin: number;
  dryRun: boolean;
}

/** A track entry as loaded from the search index. */
export interface TrackEntry {
  wikidataId: string;
  label: string;
  lat: number;
  lon: number;
}

/** A single way in the output file. */
export interface OutputWay {
  id: number;
  tags: Record<string, string>;
  nodes: LatLon[];
}

/** The complete output file for one track (Step 2 output — ways file). */
export interface TrackWaysFile {
  trackId: string;
  fetchedAt: string;
  center: LatLon;
  boundingBox: {
    south: number;
    west: number;
    north: number;
    east: number;
  };
  ways: OutputWay[];
}

// ---------------------------------------------------------------------------
// Step 3 — Layout file types
// ---------------------------------------------------------------------------

/** CLI options for the create-track-geometry command. */
export interface CreateTrackGeometryOptions {
  tracks: string[] | null; // null = all layout files
  force: boolean;
  dryRun: boolean;
}

/** A way reference within a layout definition, as authored in the layout file. */
export interface LayoutWayEntry {
  wayId: number;
  fromNode?: LatLon;
  toNode?: LatLon;
}

/** A single layout definition as read from the layout file. */
export interface LayoutDefinition {
  ways: LayoutWayEntry[];
}

/** An excluded way entry in the layout file. */
export interface ExcludedWayEntry {
  wayId: number;
  reason?: string;
}

/** The complete layout file for one track (Step 3 input). */
export interface TrackLayoutFile {
  trackId: string;
  name: string;
  layouts: Record<string, LayoutDefinition>;
  excludedWays?: ExcludedWayEntry[];
}

// ---------------------------------------------------------------------------
// Step 2.5 — find-loops types
// ---------------------------------------------------------------------------

/** CLI options for the find-loops command. */
export interface FindLoopsOptions {
  tracks: string[] | null; // null = all ways files
  maxDepth: number;
  minLength: number;
  maxLength: number;
  maxLoops: number;
  force: boolean;
  dryRun: boolean;
}

/** A segment created by splitting a way at junction nodes. */
export interface WaySegment {
  segmentId: number;
  wayId: number;
  fromIdx: number;
  toIdx: number;
  fromCoord: LatLon;
  toCoord: LatLon;
  lengthMetres: number;
  name: string;
}

/** A single loop candidate found by the loop-finder algorithm. */
export interface FoundLoop {
  loopId: number;
  lengthMetres: number;
  wayCount: number;
  namedSections: string[];
  ways: LayoutWayEntry[];
}

/** An entry in the unusedWays list. */
export interface UnusedWayEntry {
  wayId: number;
  name: string;
}

/** The complete output file for one track (find-loops output). */
export interface TrackLoopsFile {
  trackId: string;
  generatedAt: string;
  waysFileHash: string;
  stats: {
    totalWays: number;
    junctionCoords: number;
    segments: number;
    loopsFound: number;
  };
  loops: FoundLoop[];
  unusedWays: UnusedWayEntry[];
}

/** Result returned by the findLoops algorithm. */
export interface FindLoopsResult {
  junctionCount: number;
  segmentCount: number;
  loops: FoundLoop[];
  unusedWays: UnusedWayEntry[];
}
