const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

export async function searchTracks(query, signal) {
  // Step 1: Wikidata EntitySearch for candidate circuit names
  const searchUrl = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=20&format=json&origin=*`;
  const searchResp = await fetch(searchUrl, { signal });
  if (!searchResp.ok) throw new Error(`Wikidata search error: ${searchResp.status}`);
  const searchData = await searchResp.json();

  const ids = searchData.search.map(r => r.id);
  if (ids.length === 0) return [];

  // Step 2: SPARQL — keep candidates that have P625 (coordinates) AND
  // are an instance/subclass of a race track (P31/P279* wd:Q24931).
  // P625 is needed for the Overpass bbox query.
  const sparql = `
SELECT ?item ?itemLabel ?countryLabel ?lat ?lon WHERE {
  VALUES ?item { ${ids.map(id => `wd:${id}`).join(' ')} }
  ?item p:P625 ?coordStatement .
  ?coordStatement psv:P625 ?coordNode .
  ?coordNode wikibase:geoLatitude ?lat .
  ?coordNode wikibase:geoLongitude ?lon .
  OPTIONAL { ?item wdt:P17 ?country . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
}
  `.trim();

  const sparqlUrl = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
  const sparqlResp = await fetch(sparqlUrl, {
    headers: { Accept: 'application/sparql-results+json' },
    signal,
  });
  if (!sparqlResp.ok) throw new Error(`Wikidata SPARQL error: ${sparqlResp.status}`);
  const { results } = await sparqlResp.json();

  return results.bindings.map(b => ({
    name: b.itemLabel?.value || 'Unknown',
    displayName: b.countryLabel
      ? `${b.itemLabel?.value} — ${b.countryLabel.value}`
      : b.itemLabel?.value || 'Unknown',
    lat: parseFloat(b.lat?.value),
    lon: parseFloat(b.lon?.value),
    wikidataId: b.item?.value?.split('/').pop(),
  }));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ENDPOINT_TIMEOUT_MS = 12000;

async function runOverpassQuery(query, signal) {
  const body = `data=${encodeURIComponent(query)}`;
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const timeoutSignal = AbortSignal.timeout(ENDPOINT_TIMEOUT_MS);
    const combined = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: combined,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
        errors.push(`${endpoint}: ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      errors.push(`${endpoint}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${errors.join('; ')}`);
}

const dist = (a, b) => Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon);
// Exact snap: shared OSM node (same coords). Fuzzy snap: slight gap in OSM data (~30m).
const SNAP_EXACT = 1e-5;
const SNAP_FUZZY = 3e-4; // ~30m — catches gaps in OSM data without pulling in distant outliers

// Build connected components from a list of ways using endpoint proximity.
// Returns arrays of way indices grouped by connectivity.
function buildComponents(ways) {
  const n = ways.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    const si = ways[i].nodes[0];
    const ei = ways[i].nodes[ways[i].nodes.length - 1];
    for (let j = i + 1; j < n; j++) {
      const sj = ways[j].nodes[0];
      const ej = ways[j].nodes[ways[j].nodes.length - 1];
      if (dist(si, sj) < SNAP_FUZZY || dist(si, ej) < SNAP_FUZZY ||
          dist(ei, sj) < SNAP_FUZZY || dist(ei, ej) < SNAP_FUZZY) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()];
}

function stitchWaysOrdered(ways) {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].nodes;

  const remaining = ways.map(w => ({ nodes: [...w.nodes] }));
  const chain = [...remaining.shift().nodes];

  while (remaining.length > 0) {
    const chainStart = chain[0];
    const chainEnd = chain[chain.length - 1];
    let found = false;

    // First pass: exact snap
    for (let snap of [SNAP_EXACT, SNAP_FUZZY]) {
      for (let i = 0; i < remaining.length; i++) {
        const way = remaining[i];
        const wayStart = way.nodes[0];
        const wayEnd = way.nodes[way.nodes.length - 1];

        if (dist(chainEnd, wayStart) < snap) {
          chain.push(...way.nodes.slice(1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainEnd, wayEnd) < snap) {
          chain.push(...way.nodes.slice(0, -1).reverse());
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayEnd) < snap) {
          chain.unshift(...way.nodes.slice(0, -1));
          remaining.splice(i, 1); found = true; break;
        } else if (dist(chainStart, wayStart) < snap) {
          chain.unshift(...way.nodes.slice(1).reverse());
          remaining.splice(i, 1); found = true; break;
        }
      }
      if (found) break;
    }

    if (!found) break; // no more connectable ways in this component
  }

  return chain;
}

function stitchWays(ways) {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].nodes;

  // Find connected components; use only the largest one (main circuit).
  // Discards pit lanes, karting tracks, test loops, etc.
  const components = buildComponents(ways);
  const largest = components.reduce((a, b) => {
    const aNodes = a.reduce((s, i) => s + ways[i].nodes.length, 0);
    const bNodes = b.reduce((s, i) => s + ways[i].nodes.length, 0);
    return bNodes > aNodes ? b : a;
  });

  const mainWays = largest.map(i => ways[i]);
  return stitchWaysOrdered(mainWays);
}

// Fetch raceway geometry using Overpass bbox query around Wikidata P625 coordinates.
// Much more reliable than P402 (stale OSM relation IDs) or name searches (timeouts).
export async function fetchTrackGeometry(lat, lon, signal, trackName) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('No coordinates available for this circuit');
  }

  // ~15km margin around the circuit centre
  const MARGIN = 0.15;
  const bbox = `${lat - MARGIN},${lon - MARGIN},${lat + MARGIN},${lon + MARGIN}`;
  const query = `[out:json][timeout:25];way["highway"="raceway"](${bbox});out body geom;`;

  const data = await runOverpassQuery(query, signal);
  const ways = (data.elements || []).filter(e => e.type === 'way' && e.geometry?.length > 1);

  if (ways.length === 0) {
    throw new Error(`No raceway found near ${trackName ?? 'this location'}`);
  }

  // If multiple ways, prefer those whose name matches the track name (case-insensitive)
  let chosenWays = ways;
  if (trackName && ways.length > 1) {
    const nameLower = trackName.toLowerCase();
    const named = ways.filter(w => w.tags?.name?.toLowerCase().includes(nameLower) ||
                                    nameLower.includes(w.tags?.name?.toLowerCase() ?? '___'));
    if (named.length > 0) chosenWays = named;
  }

  const waysWithGeom = chosenWays.map(w => ({
    nodes: (w.geometry || []).map(({ lat, lon }) => ({ lat, lon })),
  }));

  return stitchWays(waysWithGeom);
}
