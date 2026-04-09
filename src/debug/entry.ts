import trackSearchIndex from '../generated/track-search-index.json' with { type: 'json' };
import type { TrackSearchEntry, SearchResult } from '../types/search.js';
import type { Layout } from '../types/geometry.js';
import { searchLocalTrackIndex } from '../search/scoring.js';
import { getTrackGeometry } from '../search/geometry-index.js';
import { parseOsmXmlElements, buildOsmApiMapUrl, type ParsedOsmWay, type ParsedOsmElements } from '../geometry/osm-xml-parser.js';

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

// Relation data and way-relation membership
interface WayRelationInfo { relationId: number; tags: Record<string, string>; role: string }
const wayRelationMap = new Map<number, WayRelationInfo[]>();

// Tag filtering state
// Map<tagKey, Map<tagValue, count>> — census of all tag values across loaded ways
let tagCensus = new Map<string, Map<string, number>>();
// Map<tagKey, Set<uncheckedValues>> — only stores unchecked values; absent key = no filter
const activeFilters = new Map<string, Set<string>>();
// Collapsed state for filter groups
const collapsedGroups = new Set<string>();

const UNTAGGED = '__untagged__';

// Tags always shown in filter panel (build-step relevant)
const PRIORITY_TAG_KEYS = ['highway', 'rel:type', 'rel:route', 'sport'];
// Tags that start expanded in the filter panel
const DEFAULT_EXPANDED_KEYS = new Set(['highway', 'rel:type']);
// Tags excluded from auto-discovery (noisy/uninteresting)
const EXCLUDED_TAG_KEYS = new Set([
  'source', 'created_by', 'note', 'fixme', 'attribution', 'import',
  'source:name', 'source:ref', 'source:date', 'source:geometry',
  'wikidata', 'wikipedia', 'is_in', 'addr:city', 'addr:country',
  'addr:postcode', 'addr:state', 'addr:street', 'addr:housenumber',
]);

const WAY_COLOR_DEFAULT = '#888';
const WAY_COLOR_RACEWAY = '#ffaa00';
const WAY_COLOR_RELATION = '#44ddaa';
const WAY_COLOR_SELECTED = '#00ccff';
const LAYOUT_COLOR = '#ff234f';

// --- DOM refs ---

const searchInput = document.getElementById('search-input') as HTMLInputElement;
const searchResults = document.getElementById('search-results') as HTMLUListElement;
const trackInfo = document.getElementById('track-info') as HTMLDivElement;
const wayList = document.getElementById('way-list') as HTMLDivElement;
const copyBtn = document.getElementById('copy-btn') as HTMLButtonElement;
const toggleLayouts = document.getElementById('toggle-layouts') as HTMLInputElement;
const filterGroups = document.getElementById('filter-groups') as HTMLDivElement;
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

  // Fetch OSM ways + relations via the same API the build script uses, with adaptive margin shrinking
  setStatus('Fetching OSM data...');
  try {
    const { ways, relations } = await fetchOsmApiWaysAdaptive(center.lat, center.lon, controller.signal);
    if (controller.signal.aborted) {return;}

    // Build way-relation mapping
    for (const rel of relations) {
      for (const member of rel.members) {
        if (member.type === 'way') {
          let entries = wayRelationMap.get(member.ref);
          if (!entries) {
            entries = [];
            wayRelationMap.set(member.ref, entries);
          }
          entries.push({ relationId: rel.id, tags: rel.tags, role: member.role });
        }
      }
    }

    drawOsmWays(ways);
    rebuildTagCensus();
    initCollapsedGroups();
    renderFilterPanel();
    updateFilteredStatus();
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

async function fetchOsmApiWays(lat: number, lon: number, margin: number, signal?: AbortSignal): Promise<ParsedOsmElements> {
  const url = buildOsmApiMapUrl(lat, lon, margin);
  const response = await fetch(url, signal ? { signal } : {});

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`OSM API returned ${response.status}: ${body}`);
    (err as any).nodeLimitExceeded = NODE_LIMIT_PATTERN.test(body);
    throw err;
  }

  const xml = await response.text();
  return parseOsmXmlElements(xml, { includeRelations: true });
}

async function fetchOsmApiWaysAdaptive(lat: number, lon: number, signal?: AbortSignal): Promise<ParsedOsmElements> {
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
  wayRelationMap.clear();
  tagCensus = new Map();
  activeFilters.clear();
  collapsedGroups.clear();
  filterGroups.innerHTML = '';
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

function getWayColor(way: ParsedOsmWay): string {
  if (String(way.tags['highway'] ?? '').toLowerCase() === 'raceway') {return WAY_COLOR_RACEWAY;}
  if (wayRelationMap.has(way.id)) {return WAY_COLOR_RELATION;}
  return WAY_COLOR_DEFAULT;
}

function getEffectiveTags(way: ParsedOsmWay): Record<string, string> {
  const tags: Record<string, string> = { ...way.tags };
  const rels = wayRelationMap.get(way.id);
  if (rels) {
    // Collect unique relation-level tag values
    const relTypes = new Set<string>();
    const relRoutes = new Set<string>();
    const relSports = new Set<string>();
    for (const r of rels) {
      if (r.tags['type']) {relTypes.add(r.tags['type']);}
      if (r.tags['route']) {relRoutes.add(r.tags['route']);}
      if (r.tags['sport']) {relSports.add(r.tags['sport']);}
    }
    if (relTypes.size > 0) {tags['rel:type'] = [...relTypes].join(', ');}
    if (relRoutes.size > 0) {tags['rel:route'] = [...relRoutes].join(', ');}
    if (relSports.size > 0) {tags['rel:sport'] = [...relSports].join(', ');}
  }
  return tags;
}

function drawOsmWays(ways: ParsedOsmWay[]): void {
  for (const way of ways) {
    wayDataById.set(way.id, way);
    const latlngs = way.geometry.map((n) => [n.lat, n.lon] as [number, number]);
    const baseColor = getWayColor(way);
    const polyline = L.polyline(latlngs, {
      color: baseColor,
      weight: baseColor === WAY_COLOR_DEFAULT ? 3 : 4,
      opacity: baseColor === WAY_COLOR_DEFAULT ? 0.6 : 0.85,
    }).addTo(map);

    // Build tooltip with key tags
    const name = way.tags['name'] || way.tags['ref'] || `way/${way.id}`;
    const tagLines = Object.entries(way.tags)
      .filter(([k]) => k !== 'name' && k !== 'ref')
      .slice(0, 6)
      .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
      .join('<br/>');

    const rels = wayRelationMap.get(way.id) ?? [];
    const relationInfo = rels
      .map(r => `relation/${r.relationId} (${escapeHtml(r.tags['name'] ?? r.tags['type'] ?? '?')}${r.role ? `, role=${escapeHtml(r.role)}` : ''})`)
      .join('<br/>');

    polyline.bindTooltip(
      `<strong>${escapeHtml(name)}</strong><br/>ID: ${way.id}<br/>${tagLines ? `${tagLines}<br/>` : ''}${relationInfo ? `<em>Relations:</em><br/>${relationInfo}` : ''}`,
      { sticky: true },
    );

    polyline.on('click', () => toggleWaySelection(way.id));
    wayLayerById.set(way.id, polyline);
    osmWayLayers.push(polyline);
  }
}

// --- Way selection ---

function restoreWayStyle(wayId: number): void {
  const way = wayDataById.get(wayId);
  if (!way) {return;}
  const color = getWayColor(way);
  wayLayerById.get(wayId)?.setStyle({
    color,
    weight: color === WAY_COLOR_DEFAULT ? 3 : 4,
    opacity: color === WAY_COLOR_DEFAULT ? 0.6 : 0.85,
  });
}

function toggleWaySelection(wayId: number): void {
  if (selectedWayIds.has(wayId)) {
    selectedWayIds.delete(wayId);
    restoreWayStyle(wayId);
    // Hide if filtered out
    const way = wayDataById.get(wayId);
    if (way && !passesFilters(way)) {
      const layer = wayLayerById.get(wayId);
      if (layer && map.hasLayer(layer)) {map.removeLayer(layer);}
    }
  } else {
    selectedWayIds.add(wayId);
    wayLayerById.get(wayId)?.setStyle({ color: WAY_COLOR_SELECTED, weight: 5, opacity: 1 });
  }
  renderWayList();
}

function deselectWay(wayId: number): void {
  selectedWayIds.delete(wayId);
  restoreWayStyle(wayId);
  const way = wayDataById.get(wayId);
  if (way && !passesFilters(way)) {
    const layer = wayLayerById.get(wayId);
    if (layer && map.hasLayer(layer)) {map.removeLayer(layer);}
  }
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

// --- Tag census and filtering ---

function rebuildTagCensus(): void {
  tagCensus = new Map();

  for (const [, way] of wayDataById) {
    const effective = getEffectiveTags(way);
    // Count each tag key's values
    for (const [key, value] of Object.entries(effective)) {
      if (EXCLUDED_TAG_KEYS.has(key)) {continue;}
      let valueCounts = tagCensus.get(key);
      if (!valueCounts) {
        valueCounts = new Map();
        tagCensus.set(key, valueCounts);
      }
      // For multi-value rel: tags (comma-separated), count each value separately
      const values = key.startsWith('rel:') ? value.split(', ') : [value];
      for (const v of values) {
        valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
      }
    }

    // Count untagged for priority keys
    for (const pk of PRIORITY_TAG_KEYS) {
      if (!(pk in effective)) {
        let valueCounts = tagCensus.get(pk);
        if (!valueCounts) {
          valueCounts = new Map();
          tagCensus.set(pk, valueCounts);
        }
        valueCounts.set(UNTAGGED, (valueCounts.get(UNTAGGED) ?? 0) + 1);
      }
    }
  }
}

function getFilterableTagKeys(): string[] {
  const keys: string[] = [];
  // Priority tags first (always shown if they have any values)
  for (const pk of PRIORITY_TAG_KEYS) {
    const values = tagCensus.get(pk);
    if (values && values.size > 0) {keys.push(pk);}
  }
  // Auto-discovered tags: present on 3+ ways with 2+ distinct values
  for (const [key, values] of tagCensus) {
    if (PRIORITY_TAG_KEYS.includes(key)) {continue;}
    if (EXCLUDED_TAG_KEYS.has(key)) {continue;}
    const totalCount = [...values.values()].reduce((a, b) => a + b, 0);
    if (totalCount >= 3 && values.size >= 2) {keys.push(key);}
  }
  return keys;
}

function passesFilters(way: ParsedOsmWay): boolean {
  if (activeFilters.size === 0) {return true;}
  const effective = getEffectiveTags(way);

  for (const [key, uncheckedValues] of activeFilters) {
    if (uncheckedValues.size === 0) {continue;}
    const rawValue = effective[key];

    if (rawValue === undefined) {
      // Way is untagged for this key — check if untagged is unchecked
      if (uncheckedValues.has(UNTAGGED)) {return false;}
    } else {
      // For rel: tags, check if ANY value passes
      const values = key.startsWith('rel:') ? rawValue.split(', ') : [rawValue];
      const allUnchecked = values.every(v => uncheckedValues.has(v));
      if (allUnchecked) {return false;}
    }
  }
  return true;
}

function applyFilters(): void {
  let shown = 0;
  let total = 0;
  for (const [wayId, layer] of wayLayerById) {
    total++;
    const way = wayDataById.get(wayId)!;
    const visible = selectedWayIds.has(wayId) || passesFilters(way);
    if (visible) {
      shown++;
      if (!map.hasLayer(layer)) {layer.addTo(map);}
    } else if (map.hasLayer(layer)) {
      map.removeLayer(layer);
    }
  }
  updateFilteredStatus(shown, total);
}

function updateFilteredStatus(shownCount?: number, totalCount?: number): void {
  const total = totalCount ?? wayDataById.size;
  const shown = shownCount ?? total;
  if (total === 0) {return;}
  if (shown === total) {
    setStatus(`${total} ways loaded.`);
  } else {
    setStatus(`Showing ${shown} of ${total} ways.`);
  }
}

// --- Filter panel rendering ---

function initCollapsedGroups(): void {
  const keys = getFilterableTagKeys();
  for (const key of keys) {
    if (!DEFAULT_EXPANDED_KEYS.has(key)) {
      collapsedGroups.add(key);
    }
  }
}

function renderFilterPanel(): void {
  const keys = getFilterableTagKeys();
  if (keys.length === 0) {
    filterGroups.innerHTML = '';
    return;
  }

  const html = keys.map(key => {
    const values = tagCensus.get(key)!;
    const collapsed = collapsedGroups.has(key);
    const unchecked = activeFilters.get(key);

    // Sort values: UNTAGGED last, then by count descending
    const sorted = [...values.entries()].sort((a, b) => {
      if (a[0] === UNTAGGED) {return 1;}
      if (b[0] === UNTAGGED) {return -1;}
      return b[1] - a[1];
    });

    const allChecked = !unchecked || unchecked.size === 0;
    const noneChecked = unchecked && unchecked.size === sorted.length;

    const checkboxes = sorted.map(([value, count]) => {
      const checked = !unchecked?.has(value);
      const displayValue = value === UNTAGGED ? '(untagged)' : escapeHtml(value);
      return `<label class="filter-checkbox">
        <input type="checkbox" data-tag-key="${escapeHtml(key)}" data-tag-value="${escapeHtml(value)}" ${checked ? 'checked' : ''} />
        <span>${displayValue}</span>
        <span class="filter-count">(${count})</span>
      </label>`;
    }).join('');

    return `<div class="filter-group ${collapsed ? 'collapsed' : ''}" data-key="${escapeHtml(key)}">
      <div class="filter-group-header" data-key="${escapeHtml(key)}">
        <span class="filter-chevron">${collapsed ? '\u25b6' : '\u25bc'}</span>
        <span class="filter-key-name">${escapeHtml(key)}</span>
        <span class="filter-count">(${sorted.length})</span>
        <button class="filter-toggle-all" data-key="${escapeHtml(key)}" title="${allChecked ? 'Select none' : 'Select all'}">${noneChecked ? 'All' : allChecked ? 'None' : 'All'}</button>
      </div>
      <div class="filter-group-body">${checkboxes}</div>
    </div>`;
  }).join('');

  filterGroups.innerHTML = html;

  // Wire up events
  for (const header of filterGroups.querySelectorAll('.filter-group-header')) {
    header.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.filter-toggle-all')) {return;}
      const key = (header as HTMLElement).getAttribute('data-key')!;
      if (collapsedGroups.has(key)) {
        collapsedGroups.delete(key);
      } else {
        collapsedGroups.add(key);
      }
      renderFilterPanel();
    });
  }

  for (const btn of filterGroups.querySelectorAll('.filter-toggle-all')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = (btn as HTMLElement).getAttribute('data-key')!;
      const values = tagCensus.get(key)!;
      const unchecked = activeFilters.get(key);
      const allChecked = !unchecked || unchecked.size === 0;

      if (allChecked) {
        // Uncheck all
        activeFilters.set(key, new Set(values.keys()));
      } else {
        // Check all
        activeFilters.delete(key);
      }
      renderFilterPanel();
      applyFilters();
    });
  }

  for (const checkbox of filterGroups.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    checkbox.addEventListener('change', () => {
      const key = checkbox.getAttribute('data-tag-key')!;
      const value = checkbox.getAttribute('data-tag-value')!;

      let unchecked = activeFilters.get(key);
      if (!unchecked) {
        unchecked = new Set();
        activeFilters.set(key, unchecked);
      }

      if (checkbox.checked) {
        unchecked.delete(value);
        if (unchecked.size === 0) {activeFilters.delete(key);}
      } else {
        unchecked.add(value);
      }
      applyFilters();
      // Update toggle-all button text
      const group = checkbox.closest('.filter-group');
      if (group) {
        const toggleBtn = group.querySelector('.filter-toggle-all');
        if (toggleBtn) {
          const uc = activeFilters.get(key);
          toggleBtn.textContent = (!uc || uc.size === 0) ? 'None' : 'All';
          toggleBtn.setAttribute('title', (!uc || uc.size === 0) ? 'Select none' : 'Select all');
        }
      }
    });
  }
}

// --- Status ---

function setStatus(msg: string): void {
  statusBar.textContent = msg;
}

// --- Init ---

initMap();
