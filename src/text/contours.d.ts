// Type declarations for src/text/contours.js (plain JS module, converted to .ts by the other agent).
// Minimal declarations needed by text3d.ts — extend when the module is migrated to TypeScript.

import type { Point2D } from '../types/geometry.js';

export declare function buildMultilineContours(
  lines: string[],
  font: unknown,
  options?: Record<string, unknown>,
): Point2D[][];

export declare function buildContourTree(contours: Point2D[][]): unknown;
export declare function collectShapes(tree: unknown): unknown[];

export declare function __resetPerfCounters(): void;
export declare function __getPerfCounters(): Record<string, number> | null;
export declare function __disablePerfCounters(): void;
