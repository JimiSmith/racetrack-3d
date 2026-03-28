import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes, buildTrackOutline, buildBasePlate } from './geometry.js';
import { fetchElevations } from './elevation.js';
import { buildTrackModel, exportStl } from './model.js';
import { initPreview, updatePreview } from './preview.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');
const generateStlButton = document.getElementById('generate-stl');
const generateStlButtonLabel = generateStlButton.textContent;
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationLabel = document.getElementById('exaggeration-label');

let currentNodes = null;
let currentTrack = null;
let currentOutline = null;
let currentBasePlate = null;
let currentModel = null;
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

function clearResults() {
  resultsList.innerHTML = '';
  resultsList.hidden = true;
}

async function loadElevations(nodes, exaggeration) {
  // Elevation stubbed — no status update needed
  const elevations = await fetchElevations(nodes, exaggeration);
  // Elevation is stubbed — don't clobber the outline status with a message
  console.log('Elevations (stubbed):', elevations);
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
  updatePreview(null);
  updateGenerateButton();
  try {
    const nodes = await fetchTrackGeometry(track.lat, track.lon, undefined, track.name);
    setStatus(`Loaded ${nodes.length} nodes for ${track.name}`);
    console.log('Track geometry:', track, nodes);

    const projected = projectNodes(nodes);
    const outline = buildTrackOutline(projected);
    const basePlate = buildBasePlate(outline);
    setStatus(`Outline: ${outline.outerRing.length} pts · ${basePlate.width.toFixed(0)}m×${basePlate.height.toFixed(0)}m · ${track.lat.toFixed(4)},${track.lon.toFixed(4)}`);
    console.log('Track outline:', outline);

    currentNodes = nodes;
    currentTrack = track;
    currentOutline = outline;
    currentBasePlate = basePlate;
    currentModel = buildTrackModel({
      outlinePoints: outline,
      basePlate,
      trackName: track.name,
    });
    exaggerationWrap.hidden = true;
    updatePreview(currentModel);
    updateGenerateButton();

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(nodes, exaggeration);
  } catch (err) {
    currentNodes = null;
    currentModel = null;
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
    const fileName = `${slugifyFileName(currentTrack.name)}.stl`;
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
