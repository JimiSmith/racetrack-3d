import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes } from './geometry.js';
import { fetchElevations } from './elevation.js';
import { buildTrackModel, exportStl } from './model.js';
import { export3mf } from './export3mf.js';
import { PRIMARY_ORIENTATION_AUTO, normalizePrimaryOrientationDeg } from './orientation.js';
import { initPreview, updatePreview } from './preview.js';
import { DEFAULT_TEXT_POSITION_RANK, normalizeTextPositionRank } from './text3d.js';
import { selectPrintedTrackName } from './track-name.js';
import {
  buildLayoutPickerState,
  getSelectedLayout,
  normalizeSelectedLayoutIndex,
} from './layout-picker.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');
const trackSummaryEmpty = document.getElementById('track-summary-empty');
const trackSummaryContent = document.getElementById('track-summary-content');
const selectedTrackName = document.getElementById('selected-track-name');
const selectedTrackMeta = document.getElementById('selected-track-meta');
const selectedTrackMobileName = document.getElementById('selected-track-mobile-name');

const summaryLabelInput = document.getElementById('summary-label-input');
const summaryLabelReset = document.getElementById('summary-label-reset');
const trackSummaryToggle = document.getElementById('track-summary-toggle');
const trackSummaryPanel = document.getElementById('track-summary-panel');
const previewOverlay = document.getElementById('preview-overlay');
const previewOverlayTitle = document.getElementById('preview-overlay-title');
const previewOverlayBody = document.getElementById('preview-overlay-body');
const exportBar = document.getElementById('export-bar');
const generateStlButton = document.getElementById('generate-stl');
const generateStlButtonText = generateStlButton.querySelector('.action-text');
const generateStlButtonLabel = generateStlButtonText.textContent;
const generate3mfButton = document.getElementById('generate-3mf');
const generate3mfButtonText = generate3mfButton.querySelector('.action-text');
const generate3mfButtonLabel = generate3mfButtonText.textContent;
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationValue = document.getElementById('exaggeration-value');
const layoutWrap = document.getElementById('layout-wrap');
const layoutSelect = document.getElementById('layout-select');
const layoutHint = document.getElementById('layout-hint');
const orientationSelect = document.getElementById('orientation-select');
const textPositionSelect = document.getElementById('text-position-select');

const TEXT_POSITION_LABELS = {
  1: 'Best fit',
  2: 'Alternate 1',
  3: 'Alternate 2',
};

let currentNodes = null;
let currentProjectedNodes = null;
let currentElevations = null;
let currentTrack = null;
let currentOutline = null;
let currentBasePlate = null;
let currentModel = null;
let currentLayouts = [];
let currentLayoutIndex = 0;
let currentOsmVenueNames = [];
let currentPrimaryOrientationDeg = normalizePrimaryOrientationDeg(orientationSelect?.value);
let currentTextPositionRank = normalizeTextPositionRank(textPositionSelect?.value ?? DEFAULT_TEXT_POSITION_RANK);
let currentLabelOverride = null;
let currentPlacementCacheToken = null;
let isGeneratingStl = false;
let isGenerating3mf = false;
let isTrackSummaryExpanded = true;

const mobileSummaryMedia = window.matchMedia('(max-width: 699px)');

function invalidatePlacementCache() {
  currentPlacementCacheToken = {};
}

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function updateGenerateButton() {
  const disabled = !currentOutline || !currentBasePlate || !currentTrack;
  const hasLoadedModel = Boolean(currentOutline && currentBasePlate && currentTrack);

  generateStlButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
  generate3mfButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
  generateStlButtonText.textContent = isGeneratingStl ? 'Generating STL...' : generateStlButtonLabel;
  generate3mfButtonText.textContent = isGenerating3mf ? 'Generating 3MF...' : generate3mfButtonLabel;
  exportBar.hidden = !hasLoadedModel;
}

function slugifyFileName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
}

function getSelectedTrackNameState(layout = getSelectedLayout(currentLayouts, currentLayoutIndex)) {
  return selectPrintedTrackName({
    wikidataLabel: currentTrack?.wikidataLabel ?? currentTrack?.name,
    wikidataAliases: currentTrack?.wikidataAliases,
    wikidataShortName: currentTrack?.wikidataShortName,
    description: currentTrack?.wikidataDescription,
    osmVenueNames: currentOsmVenueNames,
    selectedLayoutName: layout?.name,
  });
}

function getOrientationLabel() {
  return currentPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO
    ? 'Auto'
    : `${currentPrimaryOrientationDeg}°`;
}

function getTextPlacementLabel() {
  return TEXT_POSITION_LABELS[currentTextPositionRank] ?? TEXT_POSITION_LABELS[DEFAULT_TEXT_POSITION_RANK];
}

function getEffectiveLabel(layout = getSelectedLayout(currentLayouts, currentLayoutIndex)) {
  if (currentLabelOverride !== null) return currentLabelOverride;
  return getSelectedTrackNameState(layout).printedName;
}

function updateExaggerationSliderUI() {
  const value = Number(exaggerationSlider.value);
  const min = Number(exaggerationSlider.min);
  const max = Number(exaggerationSlider.max);
  const progress = ((value - min) / (max - min)) * 100;

  exaggerationValue.textContent = `${value}x`;
  exaggerationSlider.style.background = `linear-gradient(90deg, var(--accent) 0%, var(--accent) ${progress}%, rgba(99, 108, 128, 0.45) ${progress}%, rgba(99, 108, 128, 0.45) 100%)`;
}

function setPreviewOverlayState(title, body, hidden = false) {
  previewOverlay.hidden = hidden;
  if (hidden) {
    return;
  }

  previewOverlayTitle.textContent = title;
  previewOverlayBody.textContent = body;
}

function setTrackSummaryExpanded(expanded) {
  isTrackSummaryExpanded = expanded;

  if (!currentTrack) {
    trackSummaryPanel.hidden = false;
    trackSummaryToggle.setAttribute('aria-expanded', 'false');
    return;
  }

  const shouldExpand = mobileSummaryMedia.matches ? expanded : true;
  trackSummaryPanel.hidden = !shouldExpand;
  trackSummaryToggle.setAttribute('aria-expanded', String(shouldExpand));
}

function syncTrackSummaryForViewport() {
  if (!currentTrack) {
    setTrackSummaryExpanded(false);
    return;
  }

  setTrackSummaryExpanded(mobileSummaryMedia.matches ? isTrackSummaryExpanded : true);
}

function updateTrackSummary() {
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);

  if (!currentTrack) {
    trackSummaryEmpty.hidden = false;
    trackSummaryContent.hidden = true;
    selectedTrackMobileName.textContent = '';

    if (summaryLabelInput) summaryLabelInput.value = '';
    if (summaryLabelReset) summaryLabelReset.hidden = true;
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
    if (summaryLabelReset) summaryLabelReset.hidden = currentLabelOverride === null;

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
  if (summaryLabelReset) summaryLabelReset.hidden = currentLabelOverride === null;

  trackSummaryEmpty.hidden = true;
  trackSummaryContent.hidden = false;
  syncTrackSummaryForViewport();
}

function updateLayoutSelector() {
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
}

function buildDownloadFileName(extension) {
  const { printedName } = getSelectedTrackNameState();
  const effectiveName = (currentLabelOverride !== null && currentLabelOverride) ? currentLabelOverride : printedName;
  return `${slugifyFileName(effectiveName)}.${extension}`;
}

function triggerDownload(blob, fileName) {
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

function buildSelectedLayoutModel(elevations = currentElevations) {
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
  if (!layout) {
    currentNodes = null;
    currentProjectedNodes = null;
    currentElevations = null;
    currentOutline = null;
    currentBasePlate = null;
    currentModel = null;
    updatePreview(null);
    updateTrackSummary();
    setPreviewOverlayState('No preview available', 'This selection does not include a printable layout yet.');
    updateGenerateButton();
    return;
  }

  const projected = projectNodes(layout.nodes, elevations);
  const trackNameState = getSelectedTrackNameState(layout);
  const effectiveLabel = getEffectiveLabel(layout);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    trackName: effectiveLabel,
    projectedNodes: projected,
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
    Number.isFinite(lengthKm) ? `${lengthKm.toFixed(1)} km` : null,
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

function clearResults() {
  resultsList.innerHTML = '';
  resultsList.hidden = true;
}

async function loadElevations(nodes, exaggeration) {
  if (!nodes?.length) return;
  try {
    const elevations = await fetchElevations(nodes, exaggeration);
    buildSelectedLayoutModel(elevations);
    exaggerationWrap.hidden = false;
  } catch (err) {
    console.warn('Elevation loading failed, keeping flat model:', err);
  }
}

async function handleSelect(track) {
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
    const geometry = await fetchTrackGeometry(track.lat, track.lon, undefined, track.name, {
      wikidataId: track.wikidataId,
    });
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
    setPreviewOverlayState('Preview unavailable', 'Try another track or search again in a moment.');
    setStatus(`Error loading geometry: ${err.message}`, true);
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
    const model = currentModel ?? buildTrackModel({
      outlinePoints: currentProjectedNodes ? null : currentOutline,
      basePlate: currentProjectedNodes ? null : currentBasePlate,
      trackName: getEffectiveLabel(),
      projectedNodes: currentProjectedNodes,
      textPositionRank: currentTextPositionRank,
      primaryOrientationDeg: currentProjectedNodes
        ? currentPrimaryOrientationDeg
        : (currentModel?.primaryOrientationDeg ?? currentPrimaryOrientationDeg),
    });

    setStatus('Serializing STL file…');
    const fileName = buildDownloadFileName('stl');
    const result = exportStl(model, fileName);
    setStatus(`Downloaded ${result.fileName} (${result.triangleCount} triangles)`);
  } catch (err) {
    setStatus(`STL export failed: ${err.message}`, true);
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
    const model = currentModel ?? buildTrackModel({
      outlinePoints: currentProjectedNodes ? null : currentOutline,
      basePlate: currentProjectedNodes ? null : currentBasePlate,
      trackName: getEffectiveLabel(),
      projectedNodes: currentProjectedNodes,
      textPositionRank: currentTextPositionRank,
      primaryOrientationDeg: currentProjectedNodes
        ? currentPrimaryOrientationDeg
        : (currentModel?.primaryOrientationDeg ?? currentPrimaryOrientationDeg),
    });

    setStatus('Packaging 3MF file…');
    const fileName = buildDownloadFileName('3mf');
    const result = export3mf(model, fileName);
    triggerDownload(result.blob, result.fileName);
    setStatus(`Downloaded ${result.fileName}`);
  } catch (err) {
    setStatus(`3MF export failed: ${err.message}`, true);
    console.error(err);
  } finally {
    isGenerating3mf = false;
    updateGenerateButton();
  }
});

function renderResults(tracks) {
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

let elevationRefreshTimer;
exaggerationSlider.addEventListener('input', () => {
  updateExaggerationSliderUI();

  if (!currentNodes) return;
  clearTimeout(elevationRefreshTimer);
  elevationRefreshTimer = setTimeout(async () => {
    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(currentNodes, exaggeration);
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
  if (summaryLabelReset) summaryLabelReset.hidden = false;

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
  if (summaryLabelInput) summaryLabelInput.value = trackNameState.printedName ?? '';
  summaryLabelReset.hidden = true;

  if (!currentLayouts.length || !currentTrack) {
    return;
  }

  invalidatePlacementCache();
  buildSelectedLayoutModel();
});

let debounceTimer;
let searchAbortController = null;

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
      if (err.name === 'AbortError') return; // stale request, ignore
      setStatus(`Search error: ${err.message}`, true);
      console.error(err);
    }
  }, 800);
});

document.addEventListener('click', e => {
  if (!resultsList.contains(e.target) && e.target !== input) {
    clearResults();
  }
});

initPreview();
updateExaggerationSliderUI();
updateTrackSummary();
setPreviewOverlayState('Search for a track', 'Choose a circuit to load a large live preview and export a 3D model.');
updateGenerateButton();
