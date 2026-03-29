import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes } from './geometry.js';
import { fetchElevations } from './elevation.js';
import { buildTrackModel, exportStl } from './model.js';
import { export3mf } from './export3mf.js';
import { PRIMARY_ORIENTATION_AUTO, normalizePrimaryOrientationDeg } from './orientation.js';
import { initPreview, updatePreview } from './preview.js';
import { DEFAULT_TEXT_POSITION_RANK, normalizeTextPositionRank } from './text3d.js';
import {
  buildLayoutPickerState,
  getSelectedLayout,
  normalizeSelectedLayoutIndex,
} from './layout-picker.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');
const generateStlButton = document.getElementById('generate-stl');
const generateStlButtonLabel = generateStlButton.textContent;
const generate3mfButton = document.getElementById('generate-3mf');
const generate3mfButtonLabel = generate3mfButton.textContent;
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationLabel = document.getElementById('exaggeration-label');
const layoutWrap = document.getElementById('layout-wrap');
const layoutSelect = document.getElementById('layout-select');
const layoutHint = document.getElementById('layout-hint');
const orientationSelect = document.getElementById('orientation-select');
const textPositionSelect = document.getElementById('text-position-select');

let currentNodes = null;
let currentProjectedNodes = null;
let currentTrack = null;
let currentOutline = null;
let currentBasePlate = null;
let currentModel = null;
let currentLayouts = [];
let currentLayoutIndex = 0;
let currentPrimaryOrientationDeg = normalizePrimaryOrientationDeg(orientationSelect?.value);
let currentTextPositionRank = normalizeTextPositionRank(textPositionSelect?.value ?? DEFAULT_TEXT_POSITION_RANK);
let isGeneratingStl = false;
let isGenerating3mf = false;

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function updateGenerateButton() {
  const disabled = !currentOutline || !currentBasePlate || !currentTrack;

  generateStlButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
  generate3mfButton.disabled = isGeneratingStl || isGenerating3mf || disabled;
  generateStlButton.textContent = isGeneratingStl ? 'Generating STL…' : generateStlButtonLabel;
  generate3mfButton.textContent = isGenerating3mf ? 'Generating 3MF…' : generate3mfButtonLabel;
}

function slugifyFileName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'racetrack';
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
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
  const layoutSuffix = currentLayouts.length > 1
    ? `-${slugifyFileName(layout?.name || `layout-${currentLayoutIndex + 1}`)}`
    : '';

  return `${slugifyFileName(currentTrack.name)}${layoutSuffix}.${extension}`;
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

function buildSelectedLayoutModel(elevations = null) {
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
  if (!layout) {
    currentNodes = null;
    currentProjectedNodes = null;
    currentOutline = null;
    currentBasePlate = null;
    currentModel = null;
    updatePreview(null);
    updateGenerateButton();
    return;
  }

  const projected = projectNodes(layout.nodes, elevations);
  const model = buildTrackModel({
    outlinePoints: null,
    basePlate: null,
    trackName: currentTrack?.name,
    projectedNodes: projected,
    primaryOrientationDeg: currentPrimaryOrientationDeg,
    textPositionRank: currentTextPositionRank,
  });

  currentNodes = layout.nodes;
  currentProjectedNodes = projected;
  currentOutline = model.outlinePoints;
  currentBasePlate = model.basePlate;
  currentModel = model;

  const layoutLabel = layout.name || `Layout ${currentLayoutIndex + 1}`;
  const segmentCount = layout.stats?.segmentCount;
  const lengthKm = layout.stats?.lengthMetres ? layout.stats.lengthMetres / 1000 : null;
  const detailParts = [
    Number.isFinite(lengthKm) ? `${lengthKm.toFixed(1)} km` : null,
    Number.isFinite(segmentCount) ? `${segmentCount} segment${segmentCount === 1 ? '' : 's'}` : null,
    `${model.basePlate.width.toFixed(0)}m×${model.basePlate.height.toFixed(0)}m`,
    currentPrimaryOrientationDeg === PRIMARY_ORIENTATION_AUTO ? 'Auto orientation' : `${currentPrimaryOrientationDeg}° orientation`,
  ].filter(Boolean);
  setStatus(`${currentTrack.name}: ${layoutLabel} · ${detailParts.join(' · ')}`);

  updatePreview(currentModel);
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
  setStatus(`Loading geometry for ${track.name}…`);
  exaggerationWrap.hidden = true;
  currentNodes = null;
  currentProjectedNodes = null;
  currentTrack = null;
  currentOutline = null;
  currentBasePlate = null;
  currentModel = null;
  currentLayouts = [];
  currentLayoutIndex = 0;
  updateLayoutSelector();
  updatePreview(null);
  updateGenerateButton();
  try {
    const geometry = await fetchTrackGeometry(track.lat, track.lon, undefined, track.name);
    currentLayouts = geometry.layouts ?? [];
    currentLayoutIndex = normalizeSelectedLayoutIndex(currentLayouts, geometry.selectedLayoutIndex ?? 0);
    currentTrack = track;
    updateLayoutSelector();
    buildSelectedLayoutModel();

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(getSelectedLayout(currentLayouts, currentLayoutIndex)?.nodes ?? [], exaggeration);
  } catch (err) {
    currentNodes = null;
    currentProjectedNodes = null;
    currentLayouts = [];
    currentModel = null;
    updateLayoutSelector();
    updatePreview(null);
    setStatus(`Error loading geometry: ${err.message}`, true);
    console.error(err);
  }
}

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
      trackName: currentTrack.name,
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
      trackName: currentTrack.name,
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
  const val = exaggerationSlider.value;
  exaggerationLabel.textContent = `Elevation exaggeration: ${val}×`;

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
updateGenerateButton();
