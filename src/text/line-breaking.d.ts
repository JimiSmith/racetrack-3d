// Type declarations for src/text/line-breaking.js (plain JS module, converted to .ts by the other agent).
// Minimal declarations needed by text3d.ts.

export declare function findOptimalLineBreaks(
  words: string[],
  lineCount: number,
  targetWidth: number,
  font: unknown,
): unknown;

export declare function findOptimalLineBreaksForText(
  text: string,
  lineCount: number,
  font: unknown,
): unknown;

export declare function __resetPerfCounters(): void;
export declare function __getPerfCounters(): Record<string, number> | null;
export declare function __disablePerfCounters(): void;
