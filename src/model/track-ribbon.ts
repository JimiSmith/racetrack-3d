export const TRACK_HEIGHT_MM = 3;
export const COASTER_TRACK_HEIGHT_FLUSH_MM = 1;     // fills a 1 mm pocket carved into the top of the base
export const COASTER_TRACK_HEIGHT_RAISED_MM = 0.2;  // thin inlay sitting on top of the base
export const TRACK_WIDTH_METRES = 12;
/** Minimum ribbon width in coaster mode, in mm (thin tracks look fragile at small scales). */
export const MIN_COASTER_TRACK_WIDTH_MM = 1.0;

export interface RibbonMeshOptions {
  /** Height of the ribbon above its base, in mm. Defaults to TRACK_HEIGHT_MM. */
  trackHeightMm?: number;
  /** If true, ignore per-node elevation (flat ribbon). Defaults to false. */
  ignoreElevation?: boolean;
  /** Z of the ribbon base (top surface of the base plate). Defaults to BASE_THICKNESS_MM. */
  baseZ?: number;
  /** Track width in metres. Defaults to TRACK_WIDTH_METRES. */
  trackWidthMetres?: number;
}
