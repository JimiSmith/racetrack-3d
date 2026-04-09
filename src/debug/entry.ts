import trackSearchIndex from '../generated/track-search-index.json' with { type: 'json' };
import type { TrackSearchEntry, SearchResult } from '../types/search.js';
import type { Layout } from '../types/geometry.js';
import { searchLocalTrackIndex } from '../search/scoring.js';
import { getTrackGeometry } from '../search/geometry-index.js';
import { parseOsmXmlElements, buildOsmApiMapUrl, type ParsedOsmWay } from '../geometry/osm-xml-parser.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Leaflet is loaded via CDN in debug.html — use ambient global
const L = (window as any).L as any;

// --- Helpers ---

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- State ---

let map: any;
let osmWayLayers: any[] = [];
let layoutLayers: any[] = [];
let activeAbortController: AbortController | null = null;
const selectedWayIds = new Set<number>();
const wayDataById = new Map<number, ParsedOsmWay>();
const wayLayerById = new Map<number, any>();

const WAY_COLOR_DEFAULT = '#888';
const WAY_COLOR_SELECTED = '#00ccff';
const LAYOUT_COLOR = '#ff234f';

// --- DOM refs ---

const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResults = document.getElementById('search-results') as HTMLUListElement;
const trackInfo = document.getElementById('track-info') as HTMLDivElement;
const wayList = document.getElementById('way-list') as HTMLDivElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement;
const toggleLayouts = document.getElementById('toggle-layouts') as HTMLInputElement;
const statusBar = document.getElementById('status-bar') as HTMLDivElement;

// --- Map init ---

function initMap(): void {
  map = L.map('map', { zoomControl: true }).setView([48.0, 2.0], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}

// --- Search ---

let searchDebounce: ReturnType<typeof setTimeout> | null = null;

function handleSearchInput(): void {
  if (searchDebounce) {clearTimeout(searchDebounce);}
  searchDebounce = setTimeout(() => {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.classList.remove('open');
      searchResults.innerHTML = '';
      return;
    }
    const results = searchLocalTrackIndex(query, trackSearchIndex as TrackSearchEntry[]);
    renderSearchResults(results.slice(0, 12));
  }, 200);
}

function renderSearchResults(results: SearchResult[]): void {
  if (results.length === 0) {
    searchResults.classList.remove('open');
    searchResults.innerHTML = '';
    return;
  }

  searchResults.innerHTML = results
    .map(
      (r, i) =>
        `<li data-index="${i}">${escapeHtml(r.displayName)}</li>`,
    )
    .join('');

  searchResults.classList.add('open');

  for (const li of searchResults.querySelectorAll('li')) {
    li.addEventListener('click', () => {
      const idx = Number(li.getAttribute('data-index'));
      const track = results[idx]!;
      searchResults.classList.remove('open');
      searchInput.value = track.displayName;
      void selectTrack(track);
    });
  }
}

searchInput.addEventListener('input', handleSearchInput);
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.search-wrap')) {
    searchResults.classList.remove('open');
  }
});

// --- Track selection ---

async function selectTrack(track: SearchResult): Promise<void> {
  activeAbortController?.abort();
  const controller = new AbortController();
  activeAbortController = controller;

  clearMap();
  setStatus('Loading geometry...');

  const geo = await getTrackGeometry(track.wikidataId);
  if (controller.signal.aborted) {return;}
  if (!geo) {
    setStatus('No prebuilt geometry found.');
    trackInfo.innerHTML = `<p class="empty-state">No geometry for ${escapeHtml(track.label)}</p>`;
    return;
  }

  const center = geo.center as { lat: number; lon: number } | null;
  if (!center) {
    setStatus('No center coordinates.');
    return;
  }

  trackInfo.innerHTML = `
    <div class="track-name">${escapeHtml(track.label)}</div>
    <div>${escapeHtml(track.description ?? '')}</div>
    <div style="margin-top:6px;color:var(--text-soft);font-size:0.82rem">
      ${geo.layouts.length} layout${geo.layouts.length !== 1 ? 's' : ''} &middot;
      ${center.lat.toFixed(4)}, ${center.lon.toFixed(4)}
    </div>
  `;

  map.setView([center.lat, center.lon], 15);

  // Draw layouts
  drawLayouts(geo.layouts);

  // Fetch OSM ways via the same API the build script uses, with adaptive margin shrinking
  setStatus('Fetching OSM data...');
  try {
    const ways = await fetchOsmApiWaysAdaptive(center.lat, center.lon, controller.signal);
    if (controller.signal.aborted) {return;}
    setStatus(`${ways.length} ways loaded.`);
    drawOsmWays(ways);
  } catch (err) {
    if (controller.signal.aborted) {return;}
    setStatus(`OSM API error: ${(err as Error).message}`);
  }
}

// --- OSM API (same endpoint as build script) ---

const NODE_LIMIT_PATTERN = /too many nodes/i;
const DEFAULT_MARGIN = 0.02;
const MIN_MARGIN = 0.001;
const MAX_ATTEMPTS = 6;

async function fetchOsmApiWays(lat: number, lon: number, margin: number, signal?: AbortSignal): Promise<ParsedOsmWay[]> {
  const url = buildOsmApiMapUrl(lat, lon, margin);
  const response = await fetch(url, signal ? { signal } : {});

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`OSM API returned ${response.status}: ${body}`);
    (err as any).nodeLimitExceeded = NODE_LIMIT_PATTERN.test(body);
    throw err;
  }

  const xml = await response.text();
  const { ways } = parseOsmXmlElements(xml, { includeRelations: false });
  return ways;
}

async function fetchOsmApiWaysAdaptive(lat: number, lon: number, signal?: AbortSignal): Promise<ParsedOsmWay[]> {
  let margin = DEFAULT_MARGIN;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchOsmApiWays(lat, lon, margin, signal);
    } catch (err) {
      if (signal?.aborted) {throw err;}
      if (!(err as any).nodeLimitExceeded || margin <= MIN_MARGIN) {throw err;}
      margin = Math.max(MIN_MARGIN, margin / 2);
      setStatus(`Too many nodes, retrying with smaller area (margin ${margin.toFixed(4)})...`);
    }
  }

  throw new Error('Could not fetch OSM data: area too dense even at minimum margin');
}

// --- Drawing ---

function clearMap(): void {
  for (const layer of osmWayLayers) {map.removeLayer(layer);}
  for (const layer of layoutLayers) {map.removeLayer(layer);}
  osmWayLayers = [];
  layoutLayers = [];
  selectedWayIds.clear();
  wayDataById.clear();
  wayLayerById.clear();
  renderWayList();
}

function drawLayouts(layouts: Layout[]): void {
  for (const layout of layouts) {
    const latlngs = layout.nodes.map((n) => [n.lat, n.lon] as [number, number]);
    const polyline = L.polyline(latlngs, {
      color: LAYOUT_COLOR,
      weight: 4,
      opacity: 0.85,
    }).addTo(map);
    polyline.bindTooltip(escapeHtml(layout.name || 'Layout'), { sticky: true });
    layoutLayers.push(polyline);
  }
}

function drawOsmWays(ways: ParsedOsmWay[]): void {
  for (const way of ways) {
    wayDataById.set(way.id, way);
    const latlngs = way.geometry.map((n) => [n.lat, n.lon] as [number, number]);
    const polyline = L.polyline(latlngs, {
      color: WAY_COLOR_DEFAULT,
      weight: 3,
      opacity: 0.6,
    }).addTo(map);

    const name = way.tags['name'] || way.tags['ref'] || `way/${way.id}`;
    polyline.bindTooltip(
      `<strong>${escapeHtml(name)}</strong><br/>` +
      `ID: ${way.id}<br/>` +
      `${way.tags['highway'] ? `highway=${escapeHtml(way.tags['highway'])}` : ''}`,
      { sticky: true },
    );

    polyline.on('click', () => toggleWaySelection(way.id));
    wayLayerById.set(way.id, polyline);
    osmWayLayers.push(polyline);
  }
}

// --- Way selection ---

function toggleWaySelection(wayId: number): void {
  if (selectedWayIds.has(wayId)) {
    selectedWayIds.delete(wayId);
    wayLayerById.get(wayId)?.setStyle({ color: WAY_COLOR_DEFAULT, weight: 3, opacity: 0.6 });
  } else {
    selectedWayIds.add(wayId);
    wayLayerById.get(wayId)?.setStyle({ color: WAY_COLOR_SELECTED, weight: 5, opacity: 1 });
  }
  renderWayList();
}

function deselectWay(wayId: number): void {
  selectedWayIds.delete(wayId);
  wayLayerById.get(wayId)?.setStyle({ color: WAY_COLOR_DEFAULT, weight: 3, opacity: 0.6 });
  renderWayList();
}

function renderWayList(): void {
  copyBtn.disabled = selectedWayIds.size === 0;

  if (selectedWayIds.size === 0) {
    wayList.innerHTML = '<p class="empty-state">Click ways on the map to select them.</p>';
    return;
  }

  const items = [...selectedWayIds].map((id) => {
    const way = wayDataById.get(id);
    const name = way?.tags['name'] || way?.tags['ref'] || '';
    return `<div class="way-item" data-id="${id}">
      <span>${id}${name ? `<span class="way-name">${escapeHtml(name)}</span>` : ''}</span>
      <button class="remove-btn" data-id="${id}" title="Deselect">&times;</button>
    </div>`;
  });

  wayList.innerHTML = items.join('');

  for (const btn of wayList.querySelectorAll('.remove-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deselectWay(Number((btn as HTMLElement).getAttribute('data-id')));
    });
  }
}

// --- Copy ---

copyBtn.addEventListener('click', () => {
  if (selectedWayIds.size === 0) {return;}
  const text = [...selectedWayIds].join('\n');
  void navigator.clipboard.writeText(text).then(() => {
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy Way IDs'; }, 1500);
  });
});

// --- Layout toggle ---

toggleLayouts.addEventListener('change', () => {
  for (const layer of layoutLayers) {
    if (toggleLayouts.checked) {
      layer.addTo(map);
    } else {
      map.removeLayer(layer);
    }
  }
});

// --- Status ---

function setStatus(msg: string): void {
  statusBar.textContent = msg;
}

// --- Init ---

initMap();
