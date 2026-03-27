import './style.css';
import { searchTracks, fetchTrackGeometry } from './search.js';

const input = document.getElementById('search-input');
const resultsList = document.getElementById('search-results');
const status = document.getElementById('status');

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.className = isError ? 'error' : '';
}

function clearResults() {
  resultsList.innerHTML = '';
  resultsList.hidden = true;
}

async function handleSelect(track) {
  clearResults();
  setStatus(`Loading geometry for ${track.name}…`);
  try {
    const nodes = await fetchTrackGeometry(track.osmType, track.osmId);
    setStatus(`Loaded ${nodes.length} nodes for ${track.name}`);
    console.log('Track geometry:', track, nodes);
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

let debounceTimer;
input.addEventListener('input', () => {
  const query = input.value.trim();
  clearTimeout(debounceTimer);

  if (query.length < 2) {
    clearResults();
    setStatus('');
    return;
  }

  debounceTimer = setTimeout(async () => {
    setStatus('Searching…');
    try {
      const tracks = await searchTracks(query);
      setStatus(`${tracks.length} result${tracks.length !== 1 ? 's' : ''} found`);
      renderResults(tracks);
    } catch (err) {
      setStatus(`Search error: ${err.message}`, true);
      console.error(err);
    }
  }, 400);
});

document.addEventListener('click', e => {
  if (!resultsList.contains(e.target) && e.target !== input) {
    clearResults();
  }
});
