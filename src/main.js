import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes, buildTrackOutline, buildBasePlate } from './geometry.js';
import { fetchElevations } from './elevation.js';
import { loadOcct, buildTrackModel, exportStep } from './model.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');
const generateStepButton = document.getElementById('generate-step');
const generateStepButtonLabel = generateStepButton.textContent;
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationLabel = document.getElementById('exaggeration-label');

let currentNodes = null;
let currentTrack = null;
let currentOutline = null;
let currentBasePlate = null;
let isGeneratingStep = false;

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function updateGenerateButton() {
  generateStepButton.disabled = isGeneratingStep || !currentOutline || !currentBasePlate || !currentTrack;
  generateStepButton.textContent = isGeneratingStep ? 'Generating STEP…' : generateStepButtonLabel;
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
  setStatus('Using fixed elevation…');
  const elevations = await fetchElevations(nodes, exaggeration);
  setStatus('Elevation: fixed 1m for all track nodes');
  console.log('Elevations (stubbed):', elevations);
  return elevations;
}

async function handleSelect(track) {
  clearResults();
  setStatus(`Loading geometry for ${track.name}…`);
  exaggerationWrap.hidden = true;
  currentTrack = null;
  currentOutline = null;
  currentBasePlate = null;
  updateGenerateButton();
  try {
    const nodes = await fetchTrackGeometry(track.osmType, track.osmId);
    setStatus(`Loaded ${nodes.length} nodes for ${track.name}`);
    console.log('Track geometry:', track, nodes);

    const projected = projectNodes(nodes);
    const outline = buildTrackOutline(projected);
    const basePlate = buildBasePlate(outline);
    setStatus(`Outline: ${outline.length} points, base plate ${basePlate.width.toFixed(1)}m × ${basePlate.height.toFixed(1)}m`);
    console.log('Track outline:', outline);

    currentNodes = nodes;
    currentTrack = track;
    currentOutline = outline;
    currentBasePlate = basePlate;
    exaggerationWrap.hidden = true;
    updateGenerateButton();

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(nodes, exaggeration);
  } catch (err) {
    setStatus(`Error loading geometry: ${err.message}`, true);
    console.error(err);
  }
}

generateStepButton.addEventListener('click', async () => {
  if (!currentOutline || !currentBasePlate || !currentTrack || isGeneratingStep) {
    return;
  }

  isGeneratingStep = true;
  updateGenerateButton();

  try {
    setStatus('Initialising OpenCascade…');
    await loadOcct();

    setStatus('Building flat raised track model…');
    const shape = buildTrackModel({
      outlinePoints: currentOutline,
      basePlate: currentBasePlate,
      trackName: currentTrack.name,
    });

    setStatus('Writing STEP file…');
    const fileName = `${slugifyFileName(currentTrack.name)}.step`;
    exportStep(shape, fileName);
    setStatus(`Downloaded ${fileName}`);
  } catch (err) {
    setStatus(`STEP export failed: ${err.message}`, true);
    console.error(err);
  } finally {
    isGeneratingStep = false;
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

updateGenerateButton();
