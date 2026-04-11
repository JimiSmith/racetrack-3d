import trackSearchIndex from '../generated/track-search-index.json' with { type: 'json' };
import type { TrackSearchEntry, SearchResult } from '../types/search.js';
import { searchLocalTrackIndex } from '../search/scoring.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const L = (window as any).L as any;

// --- Inline types for ways/layout files ---

interface LatLon { lat: number; lon: number }
interface WaysFileWay { id: number; tags: Record<string, string>; nodes: LatLon[] }
interface WaysFile { trackId: string; center: LatLon; ways: WaysFileWay[] }
interface LayoutFileWayEntry { wayId: number; fromNode?: LatLon; toNode?: LatLon }
interface LayoutFileDef { ways: LayoutFileWayEntry[] }
interface ExcludedWayEntry { wayId: number; reason?: string }
interface LayoutFile {
  trackId: string;
  name: string;
  layouts: Record<string, LayoutFileDef>;
  excludedWays?: ExcludedWayEntry[];
}

// --- Editor layout state ---

interface EditorLayout {
  id: string;
  name: string;
  wayIds: number[];
  collapsed: boolean;
}

// --- Helpers ---

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// --- State ---

let map: any;
let wayLayers: any[] = [];

let currentTrackId: string | null = null;
let currentTrackName: string | null = null;

const wayDataById = new Map<number, WaysFileWay>();
const wayLayerById = new Map<number, any>();

const editorLayouts: EditorLayout[] = [];
let activeSelectLayoutId: string | null = null;
let existingExcludedWays: ExcludedWayEntry[] = [];

const WAY_COLOR_RACEWAY = '#ffaa00';
const WAY_COLOR_DEFAULT = '#888';
const WAY_COLOR_IN_LAYOUT = '#44ddaa';
const WAY_COLOR_ACTIVE = '#00ccff';

// --- DOM refs ---

const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResults = document.getElementById('search-results') as HTMLUListElement;
const trackInfo = document.getElementById('track-info') as HTMLDivElement;
const statusBar = document.getElementById('status-bar') as HTMLDivElement;
const layoutsContainer = document.getElementById('layouts-container') as HTMLDivElement;
const createLayoutBtn = document.getElementById('create-layout-btn') as HTMLButtonElement;
const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;

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
  if (searchDebounce) clearTimeout(searchDebounce);
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
    .map((r, i) => `<li data-index="${i}">${escapeHtml(r.displayName)}</li>`)
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
  clearAll();
  setStatus('Loading ways file...');
  currentTrackId = track.wikidataId;

  const base = import.meta.env?.BASE_URL ?? '/';

  // Load ways file
  let waysFile: WaysFile;
  try {
    const resp = await fetch(`${base}generated/geometry/ways/${encodeURIComponent(track.wikidataId)}.json`);
    if (!resp.ok) {
      setStatus('No ways file found. Run import-osm-data first.');
      trackInfo.innerHTML = `<p class="empty-state">No ways file for ${escapeHtml(track.label)}. Run <code>import-osm-data --track ${escapeHtml(track.wikidataId)}</code> first.</p>`;
      return;
    }
    waysFile = await resp.json();
  } catch {
    setStatus('Failed to load ways file.');
    return;
  }

  currentTrackName = track.label;
  map.setView([waysFile.center.lat, waysFile.center.lon], 15);

  trackInfo.innerHTML = `
    <div class="track-name">${escapeHtml(track.label)}</div>
    <div>${escapeHtml(track.description ?? '')}</div>
    <div style="margin-top:6px;color:var(--text-soft);font-size:0.82rem">
      ${waysFile.ways.length} ways &middot;
      ${waysFile.center.lat.toFixed(4)}, ${waysFile.center.lon.toFixed(4)}
    </div>
  `;

  // Draw ways on map
  drawWays(waysFile.ways);

  // Try to load existing layout file
  setStatus('Checking for existing layout file...');
  try {
    const resp = await fetch(`${base}generated/geometry/layouts/${encodeURIComponent(track.wikidataId)}.json`);
    if (resp.ok) {
      const layoutFile: LayoutFile = await resp.json();
      currentTrackName = layoutFile.name;
      existingExcludedWays = layoutFile.excludedWays ?? [];
      for (const [name, def] of Object.entries(layoutFile.layouts)) {
        editorLayouts.push({
          id: generateId(),
          name,
          wayIds: def.ways.map(w => w.wayId),
          collapsed: true,
        });
      }
      setStatus(`Loaded ${editorLayouts.length} existing layout${editorLayouts.length !== 1 ? 's' : ''}.`);
    } else {
      setStatus(`${waysFile.ways.length} ways loaded. No existing layout file.`);
    }
  } catch {
    setStatus(`${waysFile.ways.length} ways loaded.`);
  }

  updateWayStyles();
  renderLayoutsPanel();
  updateSaveBtn();
}

// --- Drawing ---

function clearAll(): void {
  for (const layer of wayLayers) map.removeLayer(layer);
  wayLayers = [];
  wayDataById.clear();
  wayLayerById.clear();
  editorLayouts.length = 0;
  activeSelectLayoutId = null;
  existingExcludedWays = [];
  currentTrackId = null;
  currentTrackName = null;
  renderLayoutsPanel();
  updateSaveBtn();
}

function drawWays(ways: WaysFileWay[]): void {
  for (const way of ways) {
    wayDataById.set(way.id, way);
    const latlngs = way.nodes.map(n => [n.lat, n.lon] as [number, number]);
    const isRaceway = String(way.tags.highway ?? '').toLowerCase() === 'raceway';
    const color = isRaceway ? WAY_COLOR_RACEWAY : WAY_COLOR_DEFAULT;
    const polyline = L.polyline(latlngs, {
      color,
      weight: isRaceway ? 4 : 3,
      opacity: isRaceway ? 0.85 : 0.5,
    }).addTo(map);

    const name = way.tags.name || way.tags.ref || `way/${way.id}`;
    const tagLines = Object.entries(way.tags)
      .filter(([k]) => k !== 'name' && k !== 'ref')
      .slice(0, 6)
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
      .join('<br/>');
    polyline.bindTooltip(
      `<strong>${escapeHtml(name)}</strong><br/>ID: ${way.id}${tagLines ? `<br/>${tagLines}` : ''}`,
      { sticky: true },
    );

    polyline.on('click', () => handleWayClick(way.id));
    wayLayerById.set(way.id, polyline);
    wayLayers.push(polyline);
  }
}

// --- Way click handler ---

function handleWayClick(wayId: number): void {
  if (!activeSelectLayoutId) return;

  const layout = editorLayouts.find(l => l.id === activeSelectLayoutId);
  if (!layout) return;

  const idx = layout.wayIds.indexOf(wayId);
  if (idx >= 0) {
    layout.wayIds.splice(idx, 1);
  } else {
    layout.wayIds.push(wayId);
  }

  updateWayStyles();
  renderLayoutsPanel();
  updateSaveBtn();
}

// --- Way styling ---

function getWayIdsInAnyLayout(): Set<number> {
  const ids = new Set<number>();
  for (const layout of editorLayouts) {
    for (const id of layout.wayIds) ids.add(id);
  }
  return ids;
}

function getActiveLayoutWayIds(): Set<number> {
  if (!activeSelectLayoutId) return new Set();
  const layout = editorLayouts.find(l => l.id === activeSelectLayoutId);
  return layout ? new Set(layout.wayIds) : new Set();
}

function updateWayStyles(): void {
  const inAnyLayout = getWayIdsInAnyLayout();
  const inActiveLayout = getActiveLayoutWayIds();

  for (const [wayId, layer] of wayLayerById) {
    if (inActiveLayout.has(wayId)) {
      layer.setStyle({ color: WAY_COLOR_ACTIVE, weight: 5, opacity: 1 });
    } else if (inAnyLayout.has(wayId)) {
      layer.setStyle({ color: WAY_COLOR_IN_LAYOUT, weight: 4, opacity: 0.85 });
    } else {
      const way = wayDataById.get(wayId);
      const isRaceway = String(way?.tags.highway ?? '').toLowerCase() === 'raceway';
      layer.setStyle({
        color: isRaceway ? WAY_COLOR_RACEWAY : WAY_COLOR_DEFAULT,
        weight: isRaceway ? 4 : 3,
        opacity: isRaceway ? 0.85 : 0.5,
      });
    }
  }
}

// --- Layout panel rendering ---

function renderLayoutsPanel(): void {
  if (editorLayouts.length === 0) {
    layoutsContainer.innerHTML = '<p class="empty-state">Create a layout to begin.</p>';
    return;
  }

  const html = editorLayouts.map((layout) => {
    const isActive = activeSelectLayoutId === layout.id;
    const wayItems = layout.wayIds.map((wayId, i) => {
      const way = wayDataById.get(wayId);
      const name = way?.tags.name || way?.tags.ref || '';
      return `<div class="way-item" data-layout-id="${layout.id}" data-way-id="${wayId}">
        <span class="way-index">${i + 1}.</span>
        <span class="way-id">${wayId}</span>
        ${name ? `<span class="way-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` : ''}
        <span class="way-item-controls">
          <button class="move-up-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>\u25b2</button>
          <button class="move-down-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Move down"${i === layout.wayIds.length - 1 ? ' disabled' : ''}>\u25bc</button>
          <button class="remove-btn" data-layout-id="${layout.id}" data-way-id="${wayId}" title="Remove">\u00d7</button>
        </span>
      </div>`;
    }).join('');

    return `<div class="layout-card${layout.collapsed ? ' collapsed' : ''}" data-layout-id="${layout.id}">
      <div class="layout-card-header" data-layout-id="${layout.id}">
        <span class="layout-chevron">${layout.collapsed ? '\u25b6' : '\u25bc'}</span>
        <span class="layout-card-name">${escapeHtml(layout.name || 'Untitled')}</span>
        <span class="layout-card-count">(${layout.wayIds.length})</span>
        <button class="layout-card-delete" data-layout-id="${layout.id}" title="Delete layout">\u00d7</button>
      </div>
      <div class="layout-card-body">
        <input class="layout-name-input" type="text" placeholder="Layout name..." value="${escapeHtml(layout.name)}" data-layout-id="${layout.id}" />
        <button class="select-ways-btn${isActive ? ' active' : ''}" data-layout-id="${layout.id}">
          ${isActive ? '\u25cf Select Ways (active)' : '\u25cb Select Ways'}
        </button>
        <div class="way-list">${wayItems || '<span class="empty-state">No ways added yet.</span>'}</div>
      </div>
    </div>`;
  }).join('');

  layoutsContainer.innerHTML = html;
  wireLayoutEvents();
}

function wireLayoutEvents(): void {
  // Collapse toggle
  for (const header of layoutsContainer.querySelectorAll('.layout-card-header')) {
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.layout-card-delete')) return;
      const layoutId = (header as HTMLElement).dataset.layoutId!;
      const layout = editorLayouts.find(l => l.id === layoutId);
      if (layout) {
        layout.collapsed = !layout.collapsed;
        renderLayoutsPanel();
      }
    });
  }

  // Delete layout
  for (const btn of layoutsContainer.querySelectorAll('.layout-card-delete')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const layoutId = (btn as HTMLElement).dataset.layoutId!;
      const idx = editorLayouts.findIndex(l => l.id === layoutId);
      if (idx >= 0) {
        editorLayouts.splice(idx, 1);
        if (activeSelectLayoutId === layoutId) activeSelectLayoutId = null;
        updateWayStyles();
        renderLayoutsPanel();
        updateSaveBtn();
      }
    });
  }

  // Name input
  for (const input of layoutsContainer.querySelectorAll<HTMLInputElement>('.layout-name-input')) {
    input.addEventListener('input', () => {
      const layoutId = input.dataset.layoutId!;
      const layout = editorLayouts.find(l => l.id === layoutId);
      if (layout) {
        layout.name = input.value;
        // Update the header name text without full re-render
        const card = input.closest('.layout-card');
        const nameSpan = card?.querySelector('.layout-card-name');
        if (nameSpan) nameSpan.textContent = layout.name || 'Untitled';
      }
    });
    // Prevent header collapse toggle when clicking input
    input.addEventListener('click', (e) => e.stopPropagation());
  }

  // Select ways toggle
  for (const btn of layoutsContainer.querySelectorAll('.select-ways-btn')) {
    btn.addEventListener('click', () => {
      const layoutId = (btn as HTMLElement).dataset.layoutId!;
      if (activeSelectLayoutId === layoutId) {
        activeSelectLayoutId = null;
      } else {
        activeSelectLayoutId = layoutId;
        // Auto-expand the layout
        const layout = editorLayouts.find(l => l.id === layoutId);
        if (layout) layout.collapsed = false;
      }
      updateWayStyles();
      renderLayoutsPanel();
    });
  }

  // Move up
  for (const btn of layoutsContainer.querySelectorAll('.move-up-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const layout = editorLayouts.find(l => l.id === el.dataset.layoutId);
      const idx = Number(el.dataset.idx);
      if (layout && idx > 0) {
        [layout.wayIds[idx - 1], layout.wayIds[idx]] = [layout.wayIds[idx]!, layout.wayIds[idx - 1]!];
        renderLayoutsPanel();
      }
    });
  }

  // Move down
  for (const btn of layoutsContainer.querySelectorAll('.move-down-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const layout = editorLayouts.find(l => l.id === el.dataset.layoutId);
      const idx = Number(el.dataset.idx);
      if (layout && idx < layout.wayIds.length - 1) {
        [layout.wayIds[idx], layout.wayIds[idx + 1]] = [layout.wayIds[idx + 1]!, layout.wayIds[idx]!];
        renderLayoutsPanel();
      }
    });
  }

  // Remove way
  for (const btn of layoutsContainer.querySelectorAll('.remove-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      const layout = editorLayouts.find(l => l.id === el.dataset.layoutId);
      const wayId = Number(el.dataset.wayId);
      if (layout) {
        const idx = layout.wayIds.indexOf(wayId);
        if (idx >= 0) layout.wayIds.splice(idx, 1);
        updateWayStyles();
        renderLayoutsPanel();
        updateSaveBtn();
      }
    });
  }
}

// --- Create layout ---

createLayoutBtn.addEventListener('click', () => {
  const layout: EditorLayout = {
    id: generateId(),
    name: '',
    wayIds: [],
    collapsed: false,
  };
  editorLayouts.push(layout);
  activeSelectLayoutId = layout.id;
  updateWayStyles();
  renderLayoutsPanel();
  updateSaveBtn();

  // Focus the name input of the new layout
  const input = layoutsContainer.querySelector(`.layout-name-input[data-layout-id="${layout.id}"]`) as HTMLInputElement | null;
  input?.focus();
});

// --- Save / Download ---

function buildExportJson(): LayoutFile {
  const layouts: Record<string, LayoutFileDef> = {};
  for (const layout of editorLayouts) {
    const name = layout.name.trim() || 'Untitled';
    layouts[name] = {
      ways: layout.wayIds.map(wayId => ({ wayId })),
    };
  }
  const result: LayoutFile = {
    trackId: currentTrackId!,
    name: currentTrackName!,
    layouts,
  };
  if (existingExcludedWays.length > 0) {
    result.excludedWays = existingExcludedWays;
  }
  return result;
}

function downloadJson(data: object, filename: string): void {
  const json = JSON.stringify(data, null, 2) + '\n';
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

saveBtn.addEventListener('click', () => {
  if (!currentTrackId || editorLayouts.length === 0) return;
  const data = buildExportJson();
  downloadJson(data, `${currentTrackId}.json`);
});

function updateSaveBtn(): void {
  saveBtn.disabled = !currentTrackId || editorLayouts.length === 0;
}

// --- Status ---

function setStatus(msg: string): void {
  statusBar.textContent = msg;
}

// --- Init ---

initMap();
