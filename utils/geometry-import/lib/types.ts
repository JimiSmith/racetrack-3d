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
