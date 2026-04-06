import type { LatLonNode, ProjectedNode, Point2D } from './types/geometry.js';
import type { OutlinePoints, BasePlate } from './types/model.js';

export declare function projectNodes(
  nodes: LatLonNode[],
  elevations?: number[] | null,
  center?: { lat: number; lon: number } | null,
): ProjectedNode[];

export declare function buildTrackOutline(nodes: Point2D[], widthMetres?: number): OutlinePoints;
export declare function buildBasePlate(outline: OutlinePoints | Point2D[], margin?: number): BasePlate;
