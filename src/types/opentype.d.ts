/**
 * Minimal ambient declarations for opentype.js.
 * The package ships no TypeScript types; we only need the subset
 * used by src/text/font-loader.ts and src/text/contours.ts.
 */
declare module 'opentype.js' {
  /** A single path command returned by Font.getPath(). */
  export interface PathCommand {
    type: 'M' | 'L' | 'Q' | 'C' | 'Z';
    x: number;
    y: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }

  /** A font path object returned by Font.getPath(). */
  export interface Path {
    commands: PathCommand[];
  }

  /** A single glyph in a font. */
  export interface Glyph {
    advanceWidth: number;
  }

  /** An opentype.js Font object. */
  export interface Font {
    unitsPerEm: number;
    charToGlyph(char: string): Glyph;
    getPath(text: string, x: number, y: number, fontSize: number): Path;
  }

  /** Parse an ArrayBuffer containing font data and return a Font object. */
  export function parse(buffer: ArrayBuffer): Font;

  export default {
    parse,
  };
}
