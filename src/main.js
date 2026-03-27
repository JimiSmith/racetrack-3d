import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';
import { projectNodes, buildTrackOutline } from './geometry.js';
import { fetchElevations } from './elevation.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');
const exaggerationWrap = document.getElementById('exaggeration-wrap');
const exaggerationSlider = document.getElementById('exaggeration');
const exaggerationLabel = document.getElementById('exaggeration-label');

let currentNodes = null;

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function clearResults() {
  resultsList.innerHTML = '';
  resultsList.hidden = true;
}

async function loadElevations(nodes, exaggeration) {
  setStatus('Fetching elevation data…');
  const elevations = await fetchElevations(nodes, exaggeration);
  // elevations are already multiplied by exaggeration — divide back to get raw range
  const rawMax = Math.round(Math.max(...elevations) / exaggeration);
  const exaggeratedMax = Math.round(rawMax * exaggeration);
  setStatus(`Elevation: 0–${rawMax}m raw → 0–${exaggeratedMax}m (×${exaggeration})`);
  console.log('Elevations (exaggerated):', elevations);
  return elevations;
}

async function handleSelect(track) {
  clearResults();
  setStatus(`Loading geometry for ${track.name}…`);
  exaggerationWrap.hidden = true;
  try {
    const nodes = await fetchTrackGeometry(track.osmType, track.osmId);
    setStatus(`Loaded ${nodes.length} nodes for ${track.name}`);
    console.log('Track geometry:', track, nodes);

    const projected = projectNodes(nodes);
    const outline = buildTrackOutline(projected);
    setStatus(`Outline: ${outline.length} points`);
    console.log('Track outline:', outline);

    currentNodes = nodes;
    exaggerationWrap.hidden = false;

    const exaggeration = Number(exaggerationSlider.value);
    await loadElevations(nodes, exaggeration);
  } catch (err) {
    setStatus(`Error loading geometry: ${err.message}`, true);
    console.error(err);
  }
}

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
