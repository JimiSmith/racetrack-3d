import type { Font } from 'opentype.js';
import { measureLine } from './contours.js';
import type { LineMeasurement } from './contours.js';
import { SCORING_WEIGHTS } from './scoring.js';

const MAX_TEXT_LINES = 4;

// Performance counters for benchmarking — gated behind __perfCounters so they add zero cost in production.
interface LineBreakingCounters {
  findOptimalLineBreaks: number;
}

let __perfCounters: LineBreakingCounters | null = null;
export function __resetPerfCounters(): void {
  __perfCounters = { findOptimalLineBreaks: 0 };
}
export function __getPerfCounters(): LineBreakingCounters | null { return __perfCounters ? { ...__perfCounters } : null; }
export function __disablePerfCounters(): void { __perfCounters = null; }

function estimateLineWidth(wordWidths: number[], spaceWidth: number, start: number, end: number): number {
  let width = 0;
  for (let i = start; i < end; i += 1) {
    width += wordWidths[i] ?? 0;
  }
  width += spaceWidth * Math.max(0, end - start - 1);
  return width;
}

export function findOptimalLineBreaks(words: string[], lineCount: number, wordWidths: number[], spaceWidth: number): string[] {
  if (__perfCounters) { __perfCounters.findOptimalLineBreaks++; }
  const n = words.length;

  if (lineCount <= 1 || n <= 1) {
    return [words.join(' ')];
  }

  if (lineCount >= n) {
    return words.map(w => w);
  }

  const totalWidth = estimateLineWidth(wordWidths, spaceWidth, 0, n);
  const targetWidth = totalWidth / lineCount;

  function lineCost(start: number, end: number, isLastLine: boolean): number {
    const w = estimateLineWidth(wordWidths, spaceWidth, start, end);
    const diff = targetWidth - w;
    let cost = diff * diff;

    if (isLastLine && end - start === 1 && targetWidth > 0 && w / targetWidth < SCORING_WEIGHTS.orphanThreshold) {
      cost += SCORING_WEIGHTS.orphanPenaltyWeight * targetWidth * targetWidth;
    }

    return cost;
  }

  // dp[m][j] = min cost to place words 0..j-1 into m lines
  // bp[m][j] = split point achieving that minimum
  const dp = Array.from({ length: lineCount + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const bp = Array.from({ length: lineCount + 1 }, () => new Int32Array(n + 1).fill(-1));

  // Base case: 1 line covering words 0..j-1
  for (let j = 1; j <= n; j += 1) {
    dp[1]![j] = lineCost(0, j, lineCount === 1);
  }

  // Fill DP for m = 2..lineCount
  for (let m = 2; m <= lineCount; m += 1) {
    for (let j = m; j <= n; j += 1) {
      for (let i = m - 1; i < j; i += 1) {
        const cost = (dp[m - 1]![i] ?? Infinity) + lineCost(i, j, m === lineCount);
        if (cost < (dp[m]![j] ?? Infinity)) {
          dp[m]![j] = cost;
          bp[m]![j] = i;
        }
      }
    }
  }

  // Backtrack to find break positions
  const breaks: number[] = [];
  let remaining = n;
  for (let m = lineCount; m >= 2; m -= 1) {
    breaks.push(bp[m]![remaining]!);
    remaining = bp[m]![remaining]!;
  }
  breaks.reverse();

  // Build line strings from break positions
  const lines: string[] = [];
  let start = 0;
  for (const brk of breaks) {
    lines.push(words.slice(start, brk).join(' '));
    start = brk;
  }
  lines.push(words.slice(start).join(' '));

  return lines;
}

export function measureWordWidths(words: string[], font: Font, cache: Map<string, LineMeasurement | null>): { wordWidths: number[]; spaceWidth: number } {
  const wordWidths = words.map(word => {
    const measured = measureLine(font, word, cache);
    return measured ? measured.bounds.width : 0;
  });

  let spaceWidth: number;
  if (font.charToGlyph && font.unitsPerEm) {
    spaceWidth = font.charToGlyph(' ').advanceWidth / font.unitsPerEm;
  } else {
    const twoWords = measureLine(font, 'I I', cache);
    const oneChar = measureLine(font, 'I', cache);
    spaceWidth = twoWords && oneChar ? twoWords.bounds.width - oneChar.bounds.width * 2 : 0;
  }

  return { wordWidths, spaceWidth };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function findOptimalLineBreaksForText(text: string, lineCount: number, font: Font): string[] {
  const words = String(text).split(/\s+/u).filter(Boolean);
  if (!words.length) {
    return [];
  }
  const cache = new Map<string, LineMeasurement | null>();
  const { wordWidths, spaceWidth } = measureWordWidths(words, font, cache);
  const maxLines = Math.min(MAX_TEXT_LINES, words.length);
  const targetLineCount = clamp(Math.trunc(Number(lineCount)) || 1, 1, maxLines);
  return findOptimalLineBreaks(words, targetLineCount, wordWidths, spaceWidth);
}

export { MAX_TEXT_LINES };
