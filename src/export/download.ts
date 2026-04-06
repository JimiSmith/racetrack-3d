/**
 * Download helpers — main thread only. Not importable from Web Workers.
 * Wraps raw bytes in a Blob and triggers a browser download.
 */

export function createExportBlob(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>, mimeType: string): Blob {
  return new Blob([buffer], { type: mimeType });
}

export function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
