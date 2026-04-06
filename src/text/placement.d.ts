import type { OutlinePoints, BasePlate } from '../types/model.js';
import type { RankedPlacements } from '../types/text.js';

export declare function computeRankedTextPlacements(
  text: string,
  outlinePoints: OutlinePoints | null | undefined,
  basePlate: BasePlate,
  scale: number,
  options?: { allOutlinePoints?: OutlinePoints[] | null },
): RankedPlacements | null;
