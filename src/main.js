import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes, buildTrackOutline, buildBasePlate } from './geometry.js';
import { fetchElevations } from './elevation.js';
import { buildTrackModel, exportStl } from './model.js';
import { initPreview, updatePreview } from './preview.js';
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
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationLabel = document.getElementById('exaggeration-label');
const layoutWrap = document.getElementById('layout-wrap');
const layoutSelect = document.getElementById('layout-select');
const layoutHint = document.getElementById('layout-hint');

let currentNodes = null;
let currentTrack = null;
let currentOutline = null;
let currentBasePlate = null;
let currentModel = null;
let currentLayouts = [];
let currentLayoutIndex = 0;
let isGeneratingStl = false;

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function updateGenerateButton() {
  generateStlButton.disabled = isGeneratingStl || !currentOutline || !currentBasePlate || !currentTrack;
  generateStlButton.textContent = isGeneratingStl ? 'Generating STL…' : generateStlButtonLabel;
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

function buildSelectedLayoutModel() {
  const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
  if (!layout) {
    currentNodes = null;
    currentOutline = null;
    currentBasePlate = null;
    currentModel = null;
    updatePreview(null);
    updateGenerateButton();
    return;
  }

  const projected = projectNodes(layout.nodes);
  const outline = buildTrackOutline(projected);
  const basePlate = buildBasePlate(outline);

  currentNodes = layout.nodes;
  currentOutline = outline;
  currentBasePlate = basePlate;
  currentModel = buildTrackModel({
    outlinePoints: outline,
    basePlate,
    trackName: currentTrack?.name,
  });

  const layoutLabel = layout.name || `Layout ${currentLayoutIndex + 1}`;
  const segmentCount = layout.stats?.segmentCount;
  const lengthKm = layout.stats?.lengthMetres ? layout.stats.lengthMetres / 1000 : null;
  const detailParts = [
    Number.isFinite(lengthKm) ? `${lengthKm.toFixed(1)} km` : null,
    Number.isFinite(segmentCount) ? `${segmentCount} segment${segmentCount === 1 ? '' : 's'}` : null,
    `${basePlate.width.toFixed(0)}m×${basePlate.height.toFixed(0)}m`,
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
  const elevations = await fetchElevations(nodes, exaggeration);
  console.log('Elevations:', elevations);
  return elevations;
}

async function handleSelect(track) {
  clearResults();
  setStatus(`Loading geometry for ${track.name}…`);
  exaggerationWrap.hidden = true;
  currentNodes = null;
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
    exaggerationWrap.hidden = true;

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(getSelectedLayout(currentLayouts, currentLayoutIndex)?.nodes ?? [], exaggeration);
  } catch (err) {
    currentNodes = null;
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
      outlinePoints: currentOutline,
      basePlate: currentBasePlate,
      trackName: currentTrack.name,
    });

    setStatus('Serializing STL file…');
    const layout = getSelectedLayout(currentLayouts, currentLayoutIndex);
    const layoutSuffix = currentLayouts.length > 1 ? `-${slugifyFileName(layout?.name || `layout-${currentLayoutIndex + 1}`)}` : '';
    const fileName = `${slugifyFileName(currentTrack.name)}${layoutSuffix}.stl`;
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

  if (currentNodes) {
    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(currentNodes, exaggeration);
  }
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
