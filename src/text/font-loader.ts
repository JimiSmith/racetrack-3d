import opentype from 'opentype.js';
import type { Font } from 'opentype.js';
import { LABEL_FONT_BASE64 } from '../label-font-data.js';

let cachedFont: Font | null = null;

function decodeBase64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64 === 'function') {
    const bytes = (Uint8Array as unknown as { fromBase64: (s: string) => Uint8Array }).fromBase64(base64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer as ArrayBuffer;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (typeof g.Buffer === 'function') {
    const buffer: { buffer: ArrayBuffer; byteOffset: number; byteLength: number } = g.Buffer.from(base64, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
  }

  throw new Error('No base64 decoder is available');
}

export function loadFont(fontOverride: Font | null = null): Font {
  if (fontOverride) {
    return fontOverride;
  }

  if (!cachedFont) {
    cachedFont = opentype.parse(decodeBase64ToArrayBuffer(LABEL_FONT_BASE64));
  }

  return cachedFont;
}
