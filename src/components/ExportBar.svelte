<script lang="ts">
  import { get } from 'svelte/store';
  import { canExport, isExportingStl, isExporting3mf } from '../stores/export.js';
  import { currentModel } from '../stores/model.js';
  import { effectiveLabel } from '../stores/options.js';
  import { statusMessage, statusIsError } from '../stores/ui.js';
  import { requestStlExport, requestThreemfExport } from '../workers/export-client.js';

  function slugifyFileName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'racetrack';
  }

  function buildDownloadFileName(extension: string): string {
    const label = get(effectiveLabel);
    return `${slugifyFileName(label)}.${extension}`;
  }

  function triggerDownload(blob: Blob, fileName: string): void {
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

  async function handleStlClick(): Promise<void> {
    if (!$canExport || $isExportingStl) return;

    isExportingStl.set(true);
    try {
      statusMessage.set('Serializing STL file…');
      statusIsError.set(false);
      const model = get(currentModel);
      if (!model) throw new Error('No model available for export');
      const fileName = buildDownloadFileName('stl');
      const result = await requestStlExport(model, fileName);
      const blob = new Blob([result.buffer], { type: 'model/stl' });
      triggerDownload(blob, result.fileName);
      statusMessage.set(`Downloaded ${result.fileName} (${result.triangleCount} triangles)`);
    } catch (err) {
      const error = err as Error;
      statusMessage.set(`STL export failed: ${error.message}`);
      statusIsError.set(true);
      console.error(err);
    } finally {
      isExportingStl.set(false);
    }
  }

  async function handle3mfClick(): Promise<void> {
    if (!$canExport || $isExporting3mf) return;

    isExporting3mf.set(true);
    try {
      statusMessage.set('Packaging 3MF file…');
      statusIsError.set(false);
      const model = get(currentModel);
      if (!model) throw new Error('No model available for export');
      const fileName = buildDownloadFileName('3mf');
      const result = await requestThreemfExport(model, fileName);
      const blob = new Blob([result.buffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip' });
      triggerDownload(blob, result.fileName);
      statusMessage.set(`Downloaded ${result.fileName} (${result.triangleCount} triangles)`);
    } catch (err) {
      const error = err as Error;
      statusMessage.set(`3MF export failed: ${error.message}`);
      statusIsError.set(true);
      console.error(err);
    } finally {
      isExporting3mf.set(false);
    }
  }
</script>

{#if $canExport || $isExportingStl || $isExporting3mf}
  <div class="export-inner">
    <div id="export-bar" class="export-bar">
      <button
        id="generate-3mf"
        class="action-button action-button-primary"
        type="button"
        disabled={!$canExport || $isExporting3mf}
        onclick={handle3mfClick}
      >
        <span class="action-text">{$isExporting3mf ? 'Generating 3MF...' : 'Download 3MF'}</span>
        <span class="action-badge">Recommended</span>
      </button>
      <button
        id="generate-stl"
        class="action-button action-button-secondary"
        type="button"
        disabled={!$canExport || $isExportingStl}
        onclick={handleStlClick}
      >
        <span class="action-text">{$isExportingStl ? 'Generating STL...' : 'Download STL'}</span>
      </button>
    </div>
  </div>
{:else}
  <p class="export-empty">Load a circuit to enable export.</p>
{/if}
