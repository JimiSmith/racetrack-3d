import type { OutlinePoints, BasePlate, Triangle } from './types/model.js';
import type { RankedPlacements, ScoringWeights } from './types/text.js';

export declare const TEXT_HEIGHT_MM: number;
export declare const DEFAULT_TEXT_POSITION_RANK: number;
export declare const SCORING_WEIGHTS: ScoringWeights;
export declare function normalizeTextPositionRank(rank: unknown): number;
export declare function buildTextMeshFromRankedPlacements(
  rankedPlacements: RankedPlacements | null | undefined,
  options?: { textPositionRank?: number; baseThickness?: number; textHeight?: number },
): Triangle[];
export declare function computeRankedTextPlacements(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options?: { allOutlinePoints?: OutlinePoints[] | null },
): RankedPlacements | null;
