import opentype from 'opentype.js';

import { LABEL_FONT_BASE64 } from '../label-font-data.js';

let cachedFont = null;

function decodeBase64ToArrayBuffer(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') {
    const bytes = Uint8Array.fromBase64(base64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes.buffer;
  }

  /* global Buffer */
  if (typeof Buffer === 'function') {
    const buffer = Buffer.from(base64, 'base64');
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  throw new Error('No base64 decoder is available');
}

export function loadFont(fontOverride = null) {
  if (fontOverride) {
    return fontOverride;
  }

  if (!cachedFont) {
    cachedFont = opentype.parse(decodeBase64ToArrayBuffer(LABEL_FONT_BASE64));
  }

  return cachedFont;
}
