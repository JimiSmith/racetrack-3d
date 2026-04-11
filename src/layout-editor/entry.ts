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

interface EditorWayEntry {
  wayId: number;
  fromNode?: LatLon;
  toNode?: LatLon;
}

interface EditorLayout {
  id: string;
  name: string;
  ways: EditorWayEntry[];
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

const COORD_TOLERANCE = 1e-7;

function coordsMatch(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) < COORD_TOLERANCE && Math.abs(a.lon - b.lon) < COORD_TOLERANCE;
}

/** Get the effective nodes for a way entry, applying fromNode/toNode slicing. */
function getEffectiveNodes(entry: EditorWayEntry): LatLon[] {
  const way = wayDataById.get(entry.wayId);
  if (!way) return [];
  let nodes = way.nodes;
  if (entry.fromNode) {
    const idx = nodes.findIndex(n => coordsMatch(n, entry.fromNode!));
    if (idx > 0) nodes = nodes.slice(idx);
  }
  if (entry.toNode) {
    const idx = nodes.findIndex(n => coordsMatch(n, entry.toNode!));
    if (idx >= 0) nodes = nodes.slice(0, idx + 1);
  }
  return nodes;
}

/** Find the index of a node in a way's node list. Returns -1 if not found. */
function findNodeIndex(wayId: number, node: LatLon): number {
  const way = wayDataById.get(wayId);
  if (!way) return -1;
  return way.nodes.findIndex(n => coordsMatch(n, node));
}

// --- State ---

let map: any;
let wayLayers: any[] = [];
let trimMarkers: any[] = [];
let trimOverlayLayers: any[] = [];

let currentTrackId: string | null = null;
let currentTrackName: string | null = null;

const wayDataById = new Map<number, WaysFileWay>();
const wayLayerById = new Map<number, any>();

const editorLayouts: EditorLayout[] = [];
let activeSelectLayoutId: string | null = null;
let existingExcludedWays: ExcludedWayEntry[] = [];

// Trim mode state
let trimTarget: { layoutId: string; wayIdx: number; field: 'fromNode' | 'toNode' } | null = null;

const WAY_COLOR_RACEWAY = '#ffaa00';
const WAY_COLOR_DEFAULT = '#888';
const WAY_COLOR_IN_LAYOUT = '#44ddaa';
const WAY_COLOR_ACTIVE = '#00ccff';
const WAY_COLOR_TRIMMED_INACTIVE = '#4a7a8a';

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
          ways: def.ways.map(w => {
            const entry: EditorWayEntry = { wayId: w.wayId };
            if (w.fromNode) entry.fromNode = w.fromNode;
            if (w.toNode) entry.toNode = w.toNode;
            return entry;
          }),
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
  clearTrimMarkers();
  wayLayers = [];
  wayDataById.clear();
  wayLayerById.clear();
  editorLayouts.length = 0;
  activeSelectLayoutId = null;
  trimTarget = null;
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

// --- Auto-trim logic ---

/**
 * Try to auto-trim between two adjacent way entries. If their endpoints don't
 * connect, search for a shared internal node and set toNode/fromNode accordingly.
 */
function autoTrimPair(entryA: EditorWayEntry, entryB: EditorWayEntry): void {
  const wayA = wayDataById.get(entryA.wayId);
  const wayB = wayDataById.get(entryB.wayId);
  if (!wayA || !wayB) return;

  const nodesA = getEffectiveNodes(entryA);
  if (nodesA.length === 0) return;

  const aLast = nodesA[nodesA.length - 1]!;
  const aFirst = nodesA[0]!;
  const bFirst = wayB.nodes[0]!;
  const bLast = wayB.nodes[wayB.nodes.length - 1]!;

  // Check if endpoints already connect (any orientation)
  if (coordsMatch(aLast, bFirst) || coordsMatch(aLast, bLast) ||
      coordsMatch(aFirst, bFirst) || coordsMatch(aFirst, bLast)) {
    return; // Clean connection, no trimming needed
  }

  // Try to find a shared internal node between the two ways
  for (let ai = wayA.nodes.length - 1; ai >= 0; ai--) {
    const an = wayA.nodes[ai]!;
    for (let bi = 0; bi < wayB.nodes.length; bi++) {
      const bn = wayB.nodes[bi]!;
      if (coordsMatch(an, bn)) {
        // Found a shared node. Set toNode on way A if it's an internal node.
        const aEffectiveStart = entryA.fromNode
          ? wayA.nodes.findIndex(n => coordsMatch(n, entryA.fromNode!))
          : 0;
        if (ai > aEffectiveStart && ai < wayA.nodes.length - 1) {
          entryA.toNode = { lat: an.lat, lon: an.lon };
        }
        // Set fromNode on way B if it's an internal node.
        if (bi > 0 && bi < wayB.nodes.length - 1) {
          entryB.fromNode = { lat: bn.lat, lon: bn.lon };
        }
        return;
      }
    }
  }
}

/**
 * After adding a new way to a layout, detect if trim points (fromNode/toNode)
 * are needed. Checks the new way against the previous way, and also against the
 * first way in the layout (for loop closure).
 */
function autoTrim(layout: EditorLayout): void {
  if (layout.ways.length < 2) return;

  const newEntry = layout.ways[layout.ways.length - 1]!;
  const prevEntry = layout.ways[layout.ways.length - 2]!;

  // Trim between previous way and new way
  autoTrimPair(prevEntry, newEntry);

  // Trim between new way (last) and first way (loop closure)
  if (layout.ways.length >= 3) {
    const firstEntry = layout.ways[0]!;
    autoTrimPair(newEntry, firstEntry);
  }
}

// --- Way click handler ---

function handleWayClick(wayId: number): void {
  if (!activeSelectLayoutId) return;

  const layout = editorLayouts.find(l => l.id === activeSelectLayoutId);
  if (!layout) return;

  const existingIdx = layout.ways.findIndex(w => w.wayId === wayId);
  if (existingIdx >= 0) {
    layout.ways.splice(existingIdx, 1);
  } else {
    layout.ways.push({ wayId });
    autoTrim(layout);
  }

  updateWayStyles();
  renderLayoutsPanel();
  updateSaveBtn();
}

// --- Way styling ---

function getWayIdsInAnyLayout(): Set<number> {
  const ids = new Set<number>();
  for (const layout of editorLayouts) {
    for (const entry of layout.ways) ids.add(entry.wayId);
  }
  return ids;
}

function getActiveLayoutWayIds(): Set<number> {
  if (!activeSelectLayoutId) return new Set();
  const layout = editorLayouts.find(l => l.id === activeSelectLayoutId);
  return layout ? new Set(layout.ways.map(w => w.wayId)) : new Set();
}

function clearTrimOverlays(): void {
  for (const layer of trimOverlayLayers) map.removeLayer(layer);
  trimOverlayLayers = [];
}

function updateWayStyles(): void {
  clearTrimOverlays();
  const inAnyLayout = getWayIdsInAnyLayout();
  const inActiveLayout = getActiveLayoutWayIds();
  const activeLayout = activeSelectLayoutId
    ? editorLayouts.find(l => l.id === activeSelectLayoutId)
    : null;

  for (const [wayId, layer] of wayLayerById) {
    if (inActiveLayout.has(wayId)) {
      // For active layout ways, show only the effective (trimmed) portion in cyan
      const entry = activeLayout?.ways.find(w => w.wayId === wayId);
      const way = wayDataById.get(wayId);
      if (entry && way && (entry.fromNode || entry.toNode)) {
        // Redraw the main polyline with only the effective nodes
        const effectiveNodes = getEffectiveNodes(entry);
        layer.setLatLngs(effectiveNodes.map((n: LatLon) => [n.lat, n.lon]));
        layer.setStyle({ color: WAY_COLOR_ACTIVE, weight: 5, opacity: 1 });

        // Add overlay polylines for trimmed-off portions
        const allNodes = way.nodes;
        if (entry.fromNode) {
          const fromIdx = allNodes.findIndex(n => coordsMatch(n, entry.fromNode!));
          if (fromIdx > 0) {
            const inactiveNodes = allNodes.slice(0, fromIdx + 1);
            const overlay = L.polyline(
              inactiveNodes.map((n: LatLon) => [n.lat, n.lon]),
              { color: WAY_COLOR_TRIMMED_INACTIVE, weight: 4, opacity: 0.5, dashArray: '6 4' },
            ).addTo(map);
            trimOverlayLayers.push(overlay);
          }
        }
        if (entry.toNode) {
          const toIdx = allNodes.findIndex(n => coordsMatch(n, entry.toNode!));
          if (toIdx >= 0 && toIdx < allNodes.length - 1) {
            const inactiveNodes = allNodes.slice(toIdx);
            const overlay = L.polyline(
              inactiveNodes.map((n: LatLon) => [n.lat, n.lon]),
              { color: WAY_COLOR_TRIMMED_INACTIVE, weight: 4, opacity: 0.5, dashArray: '6 4' },
            ).addTo(map);
            trimOverlayLayers.push(overlay);
          }
        }
      } else {
        // No trim — show full way in cyan
        if (way) layer.setLatLngs(way.nodes.map((n: LatLon) => [n.lat, n.lon]));
        layer.setStyle({ color: WAY_COLOR_ACTIVE, weight: 5, opacity: 1 });
      }
    } else if (inAnyLayout.has(wayId)) {
      // Restore full geometry for ways no longer in the active layout
      const way = wayDataById.get(wayId);
      if (way) layer.setLatLngs(way.nodes.map((n: LatLon) => [n.lat, n.lon]));
      layer.setStyle({ color: WAY_COLOR_IN_LAYOUT, weight: 4, opacity: 0.85 });
    } else {
      const way = wayDataById.get(wayId);
      if (way) layer.setLatLngs(way.nodes.map((n: LatLon) => [n.lat, n.lon]));
      const isRaceway = String(way?.tags.highway ?? '').toLowerCase() === 'raceway';
      layer.setStyle({
        color: isRaceway ? WAY_COLOR_RACEWAY : WAY_COLOR_DEFAULT,
        weight: isRaceway ? 4 : 3,
        opacity: isRaceway ? 0.85 : 0.5,
      });
    }
  }
}

// --- Trim mode (manual) ---

function enterTrimMode(layoutId: string, wayIdx: number, field: 'fromNode' | 'toNode'): void {
  clearTrimMarkers();
  const layout = editorLayouts.find(l => l.id === layoutId);
  if (!layout) return;
  const entry = layout.ways[wayIdx];
  if (!entry) return;
  const way = wayDataById.get(entry.wayId);
  if (!way) return;

  trimTarget = { layoutId, wayIdx, field };
  setStatus(`Click a node on way ${entry.wayId} to set ${field === 'fromNode' ? 'start' : 'end'} point. Press Escape to cancel.`);

  for (let i = 0; i < way.nodes.length; i++) {
    const node = way.nodes[i]!;
    const marker = L.circleMarker([node.lat, node.lon], {
      radius: 5,
      color: '#fff',
      fillColor: '#ff234f',
      fillOpacity: 0.8,
      weight: 2,
    }).addTo(map);
    marker.bindTooltip(`Node ${i}<br/>${node.lat.toFixed(7)}, ${node.lon.toFixed(7)}`, { sticky: true });
    marker.on('click', () => {
      applyTrimSelection(node);
    });
    trimMarkers.push(marker);
  }
}

function applyTrimSelection(node: LatLon): void {
  if (!trimTarget) return;
  const layout = editorLayouts.find(l => l.id === trimTarget!.layoutId);
  if (!layout) return;
  const entry = layout.ways[trimTarget.wayIdx];
  if (!entry) return;

  entry[trimTarget.field] = { lat: node.lat, lon: node.lon };
  exitTrimMode();
  renderLayoutsPanel();
}

function exitTrimMode(): void {
  clearTrimMarkers();
  trimTarget = null;
  setStatus('');
}

function clearTrimMarkers(): void {
  for (const marker of trimMarkers) map.removeLayer(marker);
  trimMarkers = [];
}

// Escape key exits trim mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && trimTarget) {
    exitTrimMode();
  }
});

// --- Layout panel rendering ---

function renderLayoutsPanel(): void {
  if (editorLayouts.length === 0) {
    layoutsContainer.innerHTML = '<p class="empty-state">Create a layout to begin.</p>';
    return;
  }

  const html = editorLayouts.map((layout) => {
    const isActive = activeSelectLayoutId === layout.id;
    const wayItems = layout.ways.map((entry, i) => {
      const way = wayDataById.get(entry.wayId);
      const name = way?.tags.name || way?.tags.ref || '';
      const hasTrim = entry.fromNode || entry.toNode;
      const fromIdx = entry.fromNode ? findNodeIndex(entry.wayId, entry.fromNode) : -1;
      const toIdx = entry.toNode ? findNodeIndex(entry.wayId, entry.toNode) : -1;

      let trimBadges = '';
      if (entry.fromNode) {
        trimBadges += `<span class="trim-badge" data-layout-id="${layout.id}" data-idx="${i}" data-field="fromNode" title="Start at node ${fromIdx}. Click to clear.">from:${fromIdx}</span>`;
      }
      if (entry.toNode) {
        trimBadges += `<span class="trim-badge" data-layout-id="${layout.id}" data-idx="${i}" data-field="toNode" title="End at node ${toIdx}. Click to clear.">to:${toIdx}</span>`;
      }

      return `<div class="way-item${hasTrim ? ' trimmed' : ''}" data-layout-id="${layout.id}" data-way-id="${entry.wayId}">
        <span class="way-index">${i + 1}.</span>
        <span class="way-id">${entry.wayId}</span>
        ${name ? `<span class="way-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` : ''}
        ${trimBadges}
        <span class="way-item-controls">
          <button class="trim-start-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Set start node">\u2702A</button>
          <button class="trim-end-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Set end node">\u2702B</button>
          <button class="move-up-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>\u25b2</button>
          <button class="move-down-btn" data-layout-id="${layout.id}" data-idx="${i}" title="Move down"${i === layout.ways.length - 1 ? ' disabled' : ''}>\u25bc</button>
          <button class="remove-btn" data-layout-id="${layout.id}" data-way-id="${entry.wayId}" title="Remove">\u00d7</button>
        </span>
      </div>`;
    }).join('');

    return `<div class="layout-card${layout.collapsed ? ' collapsed' : ''}" data-layout-id="${layout.id}">
      <div class="layout-card-header" data-layout-id="${layout.id}">
        <span class="layout-chevron">${layout.collapsed ? '\u25b6' : '\u25bc'}</span>
        <span class="layout-card-name">${escapeHtml(layout.name || 'Untitled')}</span>
        <span class="layout-card-count">(${layout.ways.length})</span>
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
        const card = input.closest('.layout-card');
        const nameSpan = card?.querySelector('.layout-card-name');
        if (nameSpan) nameSpan.textContent = layout.name || 'Untitled';
      }
    });
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
        const layout = editorLayouts.find(l => l.id === layoutId);
        if (layout) layout.collapsed = false;
      }
      exitTrimMode();
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
        [layout.ways[idx - 1], layout.ways[idx]] = [layout.ways[idx]!, layout.ways[idx - 1]!];
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
      if (layout && idx < layout.ways.length - 1) {
        [layout.ways[idx], layout.ways[idx + 1]] = [layout.ways[idx + 1]!, layout.ways[idx]!];
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
        const idx = layout.ways.findIndex(w => w.wayId === wayId);
        if (idx >= 0) layout.ways.splice(idx, 1);
        updateWayStyles();
        renderLayoutsPanel();
        updateSaveBtn();
      }
    });
  }

  // Trim start buttons
  for (const btn of layoutsContainer.querySelectorAll('.trim-start-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      enterTrimMode(el.dataset.layoutId!, Number(el.dataset.idx), 'fromNode');
    });
  }

  // Trim end buttons
  for (const btn of layoutsContainer.querySelectorAll('.trim-end-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = btn as HTMLElement;
      enterTrimMode(el.dataset.layoutId!, Number(el.dataset.idx), 'toNode');
    });
  }

  // Trim badges (click to clear)
  for (const badge of layoutsContainer.querySelectorAll('.trim-badge')) {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const el = badge as HTMLElement;
      const layout = editorLayouts.find(l => l.id === el.dataset.layoutId);
      const idx = Number(el.dataset.idx);
      const field = el.dataset.field as 'fromNode' | 'toNode';
      if (layout && layout.ways[idx]) {
        delete layout.ways[idx]![field];
        renderLayoutsPanel();
      }
    });
  }
}

// --- Create layout ---

createLayoutBtn.addEventListener('click', () => {
  const layout: EditorLayout = {
    id: generateId(),
    name: '',
    ways: [],
    collapsed: false,
  };
  editorLayouts.push(layout);
  activeSelectLayoutId = layout.id;
  exitTrimMode();
  updateWayStyles();
  renderLayoutsPanel();
  updateSaveBtn();

  const input = layoutsContainer.querySelector(`.layout-name-input[data-layout-id="${layout.id}"]`) as HTMLInputElement | null;
  input?.focus();
});

// --- Save / Download ---

function buildExportJson(): LayoutFile {
  const layouts: Record<string, LayoutFileDef> = {};
  for (const layout of editorLayouts) {
    const name = layout.name.trim() || 'Untitled';
    layouts[name] = {
      ways: layout.ways.map(entry => {
        const out: LayoutFileWayEntry = { wayId: entry.wayId };
        if (entry.fromNode) out.fromNode = entry.fromNode;
        if (entry.toNode) out.toNode = entry.toNode;
        return out;
      }),
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
