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
