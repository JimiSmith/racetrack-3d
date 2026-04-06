<script lang="ts">
  import { get } from 'svelte/store';
  import { serializeBinaryStl } from '../export/stl.js';
  import { package3mf } from '../export/threemf.js';
  import { canExport, isExportingStl, isExporting3mf } from '../stores/export.js';
  import { currentModel } from '../stores/model.js';
  import { selectedTrack, layouts, layoutIndex, osmVenueNames } from '../stores/track.js';
  import { labelOverride } from '../stores/options.js';
  import { statusMessage, statusIsError } from '../stores/ui.js';
  import { selectPrintedTrackName } from '../search/index.js';

  function slugifyFileName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'racetrack';
  }

  function getEffectiveLabel(): string {
    const override = get(labelOverride);
    if (override !== null) {
      return override;
    }
    const track = get(selectedTrack);
    const currentLayouts = get(layouts);
    const currentLayoutIndex = get(layoutIndex);
    const venueNames = get(osmVenueNames);
    const layout = currentLayouts[currentLayoutIndex] ?? null;
    return selectPrintedTrackName({
      wikidataLabel: track?.wikidataLabel ?? track?.name ?? null,
      wikidataAliases: track?.wikidataAliases ?? [],
      wikidataShortName: track?.wikidataShortName ?? null,
      description: track?.wikidataDescription ?? null,
      osmVenueNames: venueNames,
      selectedLayoutName: layout?.name ?? null,
    }).printedName;
  }

  function buildDownloadFileName(extension: string): string {
    const effectiveName = getEffectiveLabel();
    return `${slugifyFileName(effectiveName)}.${extension}`;
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
    if (!$canExport || $isExportingStl) {
      return;
    }

    isExportingStl.set(true);
    try {
      statusMessage.set('Serializing STL file…');
      statusIsError.set(false);
      const model = get(currentModel);
      if (!model) {
        throw new Error('No model available for export');
      }
      const fileName = buildDownloadFileName('stl');
      const normalizedBase = String(fileName)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'racetrack';
      const downloadFileName = normalizedBase.endsWith('.stl') ? normalizedBase : `${normalizedBase}.stl`;
      const stlBytes = serializeBinaryStl(model.triangles, downloadFileName);
      const blob = new Blob([stlBytes], { type: 'model/stl' });
      triggerDownload(blob, downloadFileName);
      statusMessage.set(`Downloaded ${downloadFileName} (${model.triangles.length} triangles)`);
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
    if (!$canExport || $isExporting3mf) {
      return;
    }

    isExporting3mf.set(true);
    try {
      statusMessage.set('Packaging 3MF file…');
      statusIsError.set(false);
      const model = get(currentModel);
      if (!model) {
        throw new Error('No model available for export');
      }
      const fileName = buildDownloadFileName('3mf');
      const normalizedBase = String(fileName)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'racetrack';
      const downloadFileName = normalizedBase.endsWith('.3mf') ? normalizedBase : `${normalizedBase}.3mf`;
      const zipBuffer = package3mf(model);
      const blob = new Blob([zipBuffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+zip' });
      triggerDownload(blob, downloadFileName);
      statusMessage.set(`Downloaded ${downloadFileName}`);
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
{/if}
