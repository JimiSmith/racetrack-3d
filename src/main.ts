import { searchTracks, fetchTrackGeometry, selectPrintedTrackName } from './search/index.js';
import {
  buildLayoutPickerState,
  getSelectedLayout,
  normalizeSelectedLayoutIndex,
} from './search/layout-picker.js';
import { projectNodes } from './geometry/projection.js';
import { fetchElevations } from './elevation/terrarium.js';
import { buildTrackModel } from './model/index.js';
import { PRIMARY_ORIENTATION_AUTO, normalizePrimaryOrientationDeg } from './model/orientation.js';
import { serializeBinaryStl } from './export/stl.js';
import { package3mf } from './export/threemf.js';
import { initPreview, updatePreview } from './preview/renderer.js';
import { DEFAULT_TEXT_POSITION_RANK, normalizeTextPositionRank } from './text3d.js';
import type { TrackModel } from './types/model.js';
import type { Layout } from './types/geometry.js';
import type { SearchResult } from './types/search.js';

export function initApp(): void {
  const input = document.getElementById('search-input') as HTMLInputElement;
  const resultsList = document.getElementById('search-results') as HTMLUListElement;
  const status = document.getElementById('status') as HTMLElement;
  const trackSummaryEmpty = document.getElementById('track-summary-empty') as HTMLElement;
  const trackSummaryContent = document.getElementById('track-summary-content') as HTMLElement;
  const selectedTrackName = document.getElementById('selected-track-name') as HTMLElement;
  const selectedTrackMeta = document.getElementById('selected-track-meta') as HTMLElement;
  const selectedTrackMobileName = document.getElementById('selected-track-mobile-name') as HTMLElement;

  const summaryLabelInput = document.getElementById('summary-label-input') as HTMLInputElement | null;
  const summaryLabelReset = document.getElementById('summary-label-reset') as HTMLButtonElement | null;
  const trackSummaryToggle = document.getElementById('track-summary-toggle') as HTMLButtonElement | null;
  const trackSummaryPanel = document.getElementById('track-summary-panel') as HTMLElement;
  const previewOverlay = document.getElementById('preview-overlay') as HTMLElement;
  const previewOverlayTitle = document.getElementById('preview-overlay-title') as HTMLElement;
  const previewOverlayBody = document.getElementById('preview-overlay-body') as HTMLElement;
  const exportBar = document.getElementById('export-bar') as HTMLElement;
  const generateStlButton = document.getElementById('generate-stl') as HTMLButtonElement;
  const generateStlButtonText = generateStlButton.querySelector('.action-text') as HTMLElement;
  const generateStlButtonLabel = generateStlButtonText.textContent ?? '';
  const generate3mfButton = document.getElementById('generate-3mf') as HTMLButtonElement;
  const generate3mfButtonText = generate3mfButton.querySelector('.action-text') as HTMLElement;
  const generate3mfButtonLabel = generate3mfButtonText.textContent ?? '';
  const exaggerationWrap = document.getElementById('exaggeration-wrap') as HTMLElement;
  const exaggerationSlider = document.getElementById('exaggeration') as HTMLInputElement;
  const exaggerationValue = document.getElementById('exaggeration-value') as HTMLElement;
  const layoutWrap = document.getElementById('layout-wrap') as HTMLElement;
  const layoutSelect = document.getElementById('layout-select') as HTMLSelectElement;
  const layoutHint = document.getElementById('layout-hint') as HTMLElement;
  const combinedLayoutWrap = document.getElementById('combined-layout-wrap') as HTMLElement;
  const combinedLayoutToggle = document.getElementById('combined-layout-toggle') as HTMLInputElement | null;
  const orientationSelect = document.getElementById('orientation-select') as HTMLSelectElement | null;
  const textPositionSelect = document.getElementById('text-position-select') as HTMLSelectElement | null;


  let currentNodes: import('./types/geometry.js').LatLonNode[] | null = null;
  let currentProjectedNodes: import('./types/geometry.js').ProjectedNode[] | null = null;
  let currentElevations: number[] | null = null;
  let currentTrack: SearchResult | null = null;
  let currentOutline: import('./types/model.js').OutlinePoints | null = null;
  let currentBasePlate: import('./types/model.js').BasePlate | null = null;
  let currentModel: TrackModel | null = null;
  let currentLayouts: Layout[] = [];
  let currentLayoutIndex = 0;
  let currentOsmVenueNames: string[] = [];
  let currentPrimaryOrientationDeg: number | 'auto' = normalizePrimaryOrientationDeg(orientationSelect?.value);
  let currentTextPositionRank: number = normalizeTextPositionRank(textPositionSelect?.value ?? DEFAULT_TEXT_POSITION_RANK);
  let currentLabelOverride: string | null = null;
  let currentPlacementCacheToken: object | null = null;
  let currentCombinedLayoutMode = false;
  let currentSecondaryElevations: (number[] | null)[] = [];
  let isGeneratingStl = false;
  let isGenerating3mf = false;
  let isTrackSummaryExpanded = true;

  const mobileSummaryMedia = window.matchMedia('(max-width: 699px)');

  function invalidatePlacementCache(): void {
    currentPlacementCacheToken = {};
  }

  function setStatus(msg: string, isError = false): void {
    status.textContent = msg;
    status.className = isError ? 'error' : '';
  }

  function updateGenerateButton(): void {
    const disabled = !currentOutline || !currentBasePlate || !currentTrack;
    const hasLoadedModel = Boolean(currentOutline && currentBasePlate && currentTrack);

    generateStlButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
    generate3mfButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
    generateStlButtonText.textContent = isGeneratingStl ? 'Generating STL...' : generateStlButtonLabel;
    generate3mfButtonText.textContent = isGenerating3mf ? 'Generating 3MF...' : generate3mfButtonLabel;
    exportBar.hidden = !hasLoadedModel;
  }

  function slugifyFileName(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'racetrack';
  }

  function getSelectedTrackNameState(layout: Layout | null | undefined = getSelectedLayout(currentLayouts, currentLayoutIndex)) {
    return selectPrintedTrackName({
      wikidataLabel: currentTrack?.wikidataLabel ?? currentTrack?.name ?? null,
      wikidataAliases: currentTrack?.wikidataAliases ?? [],
      wikidataShortName: currentTrack?.wikidataShortName ?? null,
      description: currentTrack?.wikidataDescription ?? null,
      osmVenueNames: currentOsmVenueNames,
      selectedLayoutName: layout?.name ?? null,
    });
  }

  function getEffectiveLabel(layout: Layout | null | undefined = getSelectedLayout(currentLayouts, currentLayoutIndex)): string {
    if (currentLabelOverride !== null) {return currentLabelOverride;}
    return getSelectedTrackNameState(layout).printedName;
  }

  function updateExaggerationSliderUI(): void {
    const value = Number(exaggerationSlider.value);
    const min = Number(exaggerationSlider.min);
    const max = Number(exaggerationSlider.max);
    const progress = ((value - min) / (max - min)) * 100;

    exaggerationValue.textContent = `${value}x`;
    exaggerationSlider.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${progress}%, rgba(99, 108, 128, 0.45) ${progress}%, rgba(99, 108, 128, 0.45) 100%)`;
  }

  function setPreviewOverlayState(title: string, body: string, hidden = false): void {
    previewOverlay.hidden = hidden;
    if (hidden) {
      return;
    }

    previewOverlayTitle.textContent = title;
    previewOverlayBody.textContent = body;
  }

  function setTrackSummaryExpanded(expanded: boolean): void {
    isTrackSummaryExpanded = expanded;

    if (!currentTrack) {
      trackSummaryPanel.hidden = false;
      trackSummaryToggle?.setAttribute('aria-expanded', 'false');
      return;
    }

    const shouldExpand = mobileSummaryMedia.matches ? expanded : true;
    trackSummaryPanel.hidden = !shouldExpand;
    trackSummaryToggle?.setAttribute('aria-expanded', String(shouldExpand));
  }

  function syncTrackSummaryForViewport(): void {
    if (!currentTrack) {
      setTrackSummaryExpanded(false);
      return;
    }

    setTrackSummaryExpanded(mobileSummaryMedia.matches ? isTrackSummaryExpanded : true);
  }

  function updateTrackSummary(): void {
    const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);

    if (!currentTrack) {
      trackSummaryEmpty.hidden = false;
      trackSummaryContent.hidden = true;
      selectedTrackMobileName.textContent = '';

      if (summaryLabelInput) {summaryLabelInput.value = '';}
      if (summaryLabelReset) {summaryLabelReset.hidden = true;}
      syncTrackSummaryForViewport();
      return;
    }

    if (!layout) {
      const loadingName = currentTrack.name ?? 'Loading track';
      selectedTrackName.textContent = loadingName;
      selectedTrackMeta.textContent = 'Loading track geometry and printable layout details...';
      selectedTrackMobileName.textContent = loadingName;

      if (currentLabelOverride === null && summaryLabelInput) {
        summaryLabelInput.value = currentTrack.name ?? 'Pending';
      }
      if (summaryLabelReset) {summaryLabelReset.hidden = currentLabelOverride === null;}

      trackSummaryEmpty.hidden = true;
      trackSummaryContent.hidden = false;
      syncTrackSummaryForViewport();
      return;
    }

    const trackNameState = getSelectedTrackNameState(layout);
    const heading = currentTrack.name ?? trackNameState.printedName;
    const meta = currentTrack.displayName && currentTrack.displayName !== heading
      ? currentTrack.displayName
      : 'Preview and export settings update live as you edit options.';

    selectedTrackName.textContent = heading;
    selectedTrackMeta.textContent = meta;
    selectedTrackMobileName.textContent = heading;

    if (currentLabelOverride === null && summaryLabelInput) {
      summaryLabelInput.value = trackNameState.printedName;
    }
    if (summaryLabelReset) {summaryLabelReset.hidden = currentLabelOverride === null;}

    trackSummaryEmpty.hidden = true;
    trackSummaryContent.hidden = false;
    syncTrackSummaryForViewport();
  }

  function updateLayoutSelector(): void {
    const pickerState = buildLayoutPickerState(currentLayouts, currentLayoutIndex);
    currentLayoutIndex = pickerState.selectedIndex;
    layoutSelect.innerHTML = '';

    for (const optionState of pickerState.options) {
      const option = document.createElement('option');
      option.value = optionState.value;
      option.textContent = optionState.label;
      option.selected = optionState.selected;
      layoutSelect.appendChild(option);
    }

    layoutWrap.hidden = pickerState.hidden;
    layoutHint.textContent = pickerState.hint;
    combinedLayoutWrap.hidden = currentLayouts.length < 2;
  }

  function buildDownloadFileName(extension: string): string {
    const { printedName } = getSelectedTrackNameState();
    const effectiveName = (currentLabelOverride !== null && currentLabelOverride) ? currentLabelOverride : printedName;
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

  function buildSelectedLayoutModel(elevations: number[] | null = currentElevations): void {
    const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
    if (!layout) {
      currentNodes = null;
      currentProjectedNodes = null;
      currentElevations = null;
      currentSecondaryElevations = [];
      currentOutline = null;
      currentBasePlate = null;
      currentModel = null;
      updatePreview(null);
      updateTrackSummary();
      setPreviewOverlayState('No preview available', 'This selection does not include a printable layout yet.');
      updateGenerateButton();
      return;
    }

    // Use a shared projection center so all layouts occupy the same coordinate frame.
    const center = {
      lat: layout.nodes.reduce((s, n) => s + n.lat, 0) / layout.nodes.length,
      lon: layout.nodes.reduce((s, n) => s + n.lon, 0) / layout.nodes.length,
    };
    const projected = projectNodes(layout.nodes, elevations, center);

    // Project secondary layouts with their elevation data (if available) when combined mode is active.
    const secondaryProjectedNodes = currentCombinedLayoutMode && currentLayouts.length > 1
      ? currentLayouts
        .filter((_, i) => i !== currentLayoutIndex)
        .map((l, i) => projectNodes(l.nodes, currentSecondaryElevations[i] ?? null, center))
      : [];

    const trackNameState = getSelectedTrackNameState(layout);
    const effectiveLabel = getEffectiveLabel(layout);
    const model = buildTrackModel({
      outlinePoints: null,
      basePlate: null,
      trackName: effectiveLabel,
      projectedNodes: projected,
      secondaryProjectedNodes,
      primaryOrientationDeg: currentPrimaryOrientationDeg,
      textPositionRank: currentTextPositionRank,
      placementCacheToken: currentPlacementCacheToken,
    });

    currentNodes = layout.nodes;
    currentProjectedNodes = projected;
    currentElevations = elevations;
    currentOutline = model.outlinePoints;
    currentBasePlate = model.basePlate;
    currentModel = model;

    const segmentCount = layout.stats?.segmentCount;
    const lengthKm = layout.stats?.lengthMetres ? layout.stats.lengthMetres / 1000 : null;
    const detailParts = [
      Number.isFinite(lengthKm) ? `${lengthKm!.toFixed(1)} km` : null,
      Number.isFinite(segmentCount) ? `${segmentCount} segment${segmentCount === 1 ? '' : 's'}` : null,
      `${model.basePlate.width.toFixed(0)}m×${model.basePlate.height.toFixed(0)}m`,
      currentPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO ? 'Auto orientation' : `${currentPrimaryOrientationDeg}° orientation`,
    ].filter(Boolean);
    setStatus(`${trackNameState.printedName} · ${detailParts.join(' · ')}`);

    updatePreview(currentModel);
    updateTrackSummary();
    setPreviewOverlayState('', '', true);
    updateGenerateButton();
  }

  function clearResults(): void {
    resultsList.innerHTML = '';
    resultsList.hidden = true;
  }

  async function loadElevations(nodes: import('./types/geometry.js').LatLonNode[], exaggeration: number): Promise<void> {
    if (!nodes?.length) {return;}
    try {
      const secondaryLayouts = currentCombinedLayoutMode && currentLayouts.length > 1
        ? currentLayouts.filter((_, i) => i !== currentLayoutIndex)
        : [];

      const allNodes = [...nodes, ...secondaryLayouts.flatMap(l => l.nodes)];
      const allElevations = await fetchElevations(allNodes, exaggeration);

      const primaryElevations = allElevations.slice(0, nodes.length);
      let offset = nodes.length;
      currentSecondaryElevations = secondaryLayouts.map(l => {
        const elevs = allElevations.slice(offset, offset + l.nodes.length);
        offset += l.nodes.length;
        return elevs;
      });

      buildSelectedLayoutModel(primaryElevations);
      exaggerationWrap.hidden = false;
    } catch (err) {
      console.warn('Elevation loading failed, keeping flat model:', err);
    }
  }

  async function handleSelect(track: SearchResult): Promise<void> {
    clearResults();
    setStatus(`Loading geometry for ${track.name}...`);
    exaggerationWrap.hidden = true;
    currentNodes = null;
    currentProjectedNodes = null;
    currentElevations = null;
    currentTrack = track;
    currentOutline = null;
    currentBasePlate = null;
    currentModel = null;
    currentLayouts = [];
    currentLayoutIndex = 0;
    currentOsmVenueNames = [];
    currentLabelOverride = null;
    isTrackSummaryExpanded = !mobileSummaryMedia.matches;
    updateLayoutSelector();
    updatePreview(null);
    updateTrackSummary();
    setPreviewOverlayState('Loading preview', `Fetching track geometry for ${track.name}...`);
    updateGenerateButton();
    try {
      const geometry = await fetchTrackGeometry(track.name, { wikidataId: track.wikidataId }) as {
        layouts?: Layout[];
        selectedLayoutIndex?: number;
        osmVenueNames?: string[];
      };
      currentLayouts = geometry.layouts ?? [];
      currentLayoutIndex = normalizeSelectedLayoutIndex(currentLayouts, geometry.selectedLayoutIndex ?? 0);
      currentOsmVenueNames = geometry.osmVenueNames ?? [];
      updateLayoutSelector();
      invalidatePlacementCache();
      buildSelectedLayoutModel();

      const exaggeration = Number(exaggerationSlider.value);
      await loadElevations(getSelectedLayout(currentLayouts, currentLayoutIndex)?.nodes ?? [], exaggeration);
    } catch (err) {
      currentNodes = null;
      currentProjectedNodes = null;
      currentElevations = null;
      currentTrack = null;
      currentLayouts = [];
      currentOsmVenueNames = [];
      currentModel = null;
      updateLayoutSelector();
      updatePreview(null);
      updateTrackSummary();
      const error = err as Error;
      const isUnavailable = error.message?.startsWith('No prebuilt geometry available');
      const overlayBody = isUnavailable
        ? 'Track geometry not available.'
        : 'Try another track or search again in a moment.';
      setPreviewOverlayState('Preview unavailable', overlayBody);
      setStatus(`Error loading geometry: ${error.message}`, true);
      console.error(err);
    }
  }

  trackSummaryToggle?.addEventListener('click', () => {
    if (!currentTrack || !mobileSummaryMedia.matches) {
      return;
    }

    setTrackSummaryExpanded(!isTrackSummaryExpanded);
  });

  mobileSummaryMedia.addEventListener('change', () => {
    if (currentTrack && mobileSummaryMedia.matches) {
      isTrackSummaryExpanded = false;
    }

    syncTrackSummaryForViewport();
  });

  generateStlButton.addEventListener('click', async () => {
    if (!currentOutline || !currentBasePlate || !currentTrack || isGeneratingStl) {
      return;
    }

    isGeneratingStl = true;
    updateGenerateButton();

    try {
      setStatus('Building STL mesh…');
      const cachedModel = currentModel;
      const orientationForStl = currentProjectedNodes
        ? currentPrimaryOrientationDeg
        : (cachedModel?.primaryOrientationDeg ?? currentPrimaryOrientationDeg);
      const model: TrackModel = cachedModel ?? buildTrackModel({
        outlinePoints: currentProjectedNodes ? null : currentOutline,
        basePlate: currentProjectedNodes ? null : currentBasePlate,
        trackName: getEffectiveLabel(),
        projectedNodes: currentProjectedNodes,
        textPositionRank: currentTextPositionRank,
        primaryOrientationDeg: orientationForStl,
      });

      setStatus('Serializing STL file…');
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
      setStatus(`Downloaded ${downloadFileName} (${model.triangles.length} triangles)`);
    } catch (err) {
      const error = err as Error;
      setStatus(`STL export failed: ${error.message}`, true);
      console.error(err);
    } finally {
      isGeneratingStl = false;
      updateGenerateButton();
    }
  });

  generate3mfButton.addEventListener('click', async () => {
    if (!currentOutline || !currentBasePlate || !currentTrack || isGeneratingStl || isGenerating3mf) {
      return;
    }

    isGenerating3mf = true;
    updateGenerateButton();

    try {
      setStatus('Building 3MF mesh…');
      const cachedModel = currentModel;
      const orientationFor3mf = currentProjectedNodes
        ? currentPrimaryOrientationDeg
        : (cachedModel?.primaryOrientationDeg ?? currentPrimaryOrientationDeg);
      const model: TrackModel = cachedModel ?? buildTrackModel({
        outlinePoints: currentProjectedNodes ? null : currentOutline,
        basePlate: currentProjectedNodes ? null : currentBasePlate,
        trackName: getEffectiveLabel(),
        projectedNodes: currentProjectedNodes,
        textPositionRank: currentTextPositionRank,
        primaryOrientationDeg: orientationFor3mf,
      });

      setStatus('Packaging 3MF file…');
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
      setStatus(`Downloaded ${downloadFileName}`);
    } catch (err) {
      const error = err as Error;
      setStatus(`3MF export failed: ${error.message}`, true);
      console.error(err);
    } finally {
      isGenerating3mf = false;
      updateGenerateButton();
    }
  });

  function renderResults(tracks: SearchResult[]): void {
    resultsList.innerHTML = '';
    if (tracks.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No racetracks found.';
      li.className = 'no-results';
      resultsList.appendChild(li);
    } else {
      for (const track of tracks) {
        const li = document.createElement('li');
        li.textContent = track.displayName;
        li.addEventListener('click', () => handleSelect(track));
        resultsList.appendChild(li);
      }
    }
    resultsList.hidden = false;
  }

  let elevationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  exaggerationSlider.addEventListener('input', () => {
    updateExaggerationSliderUI();

    if (!currentNodes) {return;}
    clearTimeout(elevationRefreshTimer);
    elevationRefreshTimer = setTimeout(async () => {
      const exaggeration = Number(exaggerationSlider.value);
      await loadElevations(currentNodes!, exaggeration);
    }, 150);
  });

  layoutSelect.addEventListener('change', async () => {
    if (!currentLayouts.length) {
      return;
    }

    const nextIndex = Number(layoutSelect.value);
    if (!Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex >= currentLayouts.length) {
      return;
    }

    currentLayoutIndex = normalizeSelectedLayoutIndex(currentLayouts, nextIndex);
    currentElevations = null;
    invalidatePlacementCache();
    buildSelectedLayoutModel();
    exaggerationWrap.hidden = true;

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(getSelectedLayout(currentLayouts, currentLayoutIndex)?.nodes ?? [], exaggeration);
  });

  combinedLayoutToggle?.addEventListener('change', () => {
    currentCombinedLayoutMode = combinedLayoutToggle.checked;
    if (!currentCombinedLayoutMode) {currentSecondaryElevations = [];}
    invalidatePlacementCache();
    buildSelectedLayoutModel();
    if (currentCombinedLayoutMode && currentNodes?.length) {
      void loadElevations(currentNodes, Number(exaggerationSlider.value));
    }
  });

  orientationSelect?.addEventListener('change', async () => {
    currentPrimaryOrientationDeg = normalizePrimaryOrientationDeg(orientationSelect.value);

    if (!currentLayouts.length || !currentTrack) {
      return;
    }

    buildSelectedLayoutModel();
    exaggerationWrap.hidden = true;

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(getSelectedLayout(currentLayouts, currentLayoutIndex)?.nodes ?? [], exaggeration);
  });

  textPositionSelect?.addEventListener('change', () => {
    currentTextPositionRank = normalizeTextPositionRank(textPositionSelect.value);

    if (!currentLayouts.length || !currentTrack) {
      return;
    }

    buildSelectedLayoutModel();
  });

  summaryLabelInput?.addEventListener('input', () => {
    currentLabelOverride = summaryLabelInput.value;
    if (summaryLabelReset) {summaryLabelReset.hidden = false;}

    if (!currentLayouts.length || !currentTrack) {
      return;
    }

    invalidatePlacementCache();
    buildSelectedLayoutModel();
  });

  summaryLabelReset?.addEventListener('click', () => {
    currentLabelOverride = null;
    const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
    const trackNameState = getSelectedTrackNameState(layout);
    if (summaryLabelInput) {summaryLabelInput.value = trackNameState.printedName ?? '';}
    if (summaryLabelReset) {summaryLabelReset.hidden = true;}

    if (!currentLayouts.length || !currentTrack) {
      return;
    }

    invalidatePlacementCache();
    buildSelectedLayoutModel();
  });

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbortController: AbortController | null = null;

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearTimeout(debounceTimer);

    // Cancel any in-flight search request immediately
    if (searchAbortController) {
      searchAbortController.abort();
      searchAbortController = null;
    }

    if (query.length < 3) {
      clearResults();
      setStatus('');
      return;
    }

    debounceTimer = setTimeout(async () => {
      searchAbortController = new AbortController();
      setStatus('Searching…');
      try {
        const tracks = await searchTracks(query, searchAbortController.signal);
        setStatus(`${tracks.length} result${tracks.length !== 1 ? 's' : ''} found`);
        renderResults(tracks);
      } catch (err) {
        const error = err as Error;
        if (error.name === 'AbortError') {return;} // stale request, ignore
        setStatus(`Search error: ${error.message}`, true);
        console.error(err);
      }
    }, 800);
  });

  document.addEventListener('click', e => {
    if (!resultsList.contains(e.target as Node) && e.target !== input) {
      clearResults();
    }
  });

  initPreview();
  updateExaggerationSliderUI();
  updateTrackSummary();
  setPreviewOverlayState('Search for a track', 'Choose a circuit to load a large live preview and export a 3D model.');
  updateGenerateButton();
}
