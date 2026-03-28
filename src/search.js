const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

export async function searchTracks(query, signal) {
  // Step 1: use Wikidata EntitySearch (autocomplete) to find candidate items by name
  const searchUrl = `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=en&type=item&limit=20&format=json&origin=*`;
  const searchResp = await fetch(searchUrl, { signal });
  if (!searchResp.ok) throw new Error(`Wikidata search error: ${searchResp.status}`);
  const searchData = await searchResp.json();

  const ids = searchData.search.map(r => r.id);
  if (ids.length === 0) return [];

  // Step 2: of those candidates, keep only ones that have an OSM relation ID (P402)
  const sparql = `
SELECT ?item ?itemLabel ?countryLabel ?osmId WHERE {
  VALUES ?item { ${ids.map(id => `wd:${id}`).join(' ')} }
  ?item wdt:P402 ?osmId .
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
    osmType: 'relation',
    osmId: b.osmId?.value || null,
    wikidataId: b.item?.value?.split('/').pop(),
  }));
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const ENDPOINT_TIMEOUT_MS = 8000;

async function runOverpassQuery(query, signal) {
  const body = `data=${encodeURIComponent(query)}`;
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    // Combine user cancel signal with a per-endpoint timeout
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
      // Skip on any non-JSON response (504, 429, HTML error pages)
      if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
        errors.push(`${endpoint}: ${response.status}`);
        continue;
      }
      return await response.json();
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); // user cancelled
      errors.push(`${endpoint}: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
  }
  throw new Error(`All Overpass endpoints failed: ${errors.join('; ')}`);
}

function stitchWays(ways) {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].nodes;

  // ways already have { nodes: [{lat, lon}] } — stitch into one ordered chain
  const remaining = ways.map(w => ({ nodes: [...w.nodes] }));
  const chain = [...remaining.shift().nodes];

  while (remaining.length > 0) {
    const chainStart = chain[0];
    const chainEnd = chain[chain.length - 1];
    let found = false;

    for (let i = 0; i < remaining.length; i++) {
      const way = remaining[i];
      const wayStart = way.nodes[0];
      const wayEnd = way.nodes[way.nodes.length - 1];

      const dist = (a, b) => Math.abs(a.lat - b.lat) + Math.abs(a.lon - b.lon);
      const SNAP = 1e-7;

      if (dist(chainEnd, wayStart) < SNAP) {
        chain.push(...way.nodes.slice(1));
        remaining.splice(i, 1);
        found = true;
        break;
      } else if (dist(chainEnd, wayEnd) < SNAP) {
        chain.push(...way.nodes.slice(0, -1).reverse());
        remaining.splice(i, 1);
        found = true;
        break;
      } else if (dist(chainStart, wayEnd) < SNAP) {
        chain.unshift(...way.nodes.slice(0, -1));
        remaining.splice(i, 1);
        found = true;
        break;
      } else if (dist(chainStart, wayStart) < SNAP) {
        chain.unshift(...way.nodes.slice(1).reverse());
        remaining.splice(i, 1);
        found = true;
        break;
      }
    }

    if (!found) {
      // Can't stitch — append nearest remaining way anyway
      const next = remaining.shift();
      chain.push(...next.nodes);
    }
  }

  return chain;
}

const OSM_API = 'https://api.openstreetmap.org/api/0.6';

function extractWaysFromRelationElements(elements) {
  const nodeMap = new Map();
  for (const el of elements) {
    if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
  }

  const relation = elements.find(e => e.type === 'relation');
  const members = relation?.members || [];

  // Build a map of wayId → role for filtering
  const wayMemberRoles = new Map();
  for (const m of members) {
    if (m.type === 'way') wayMemberRoles.set(m.ref, m.role ?? '');
  }

  const allMemberWays = elements.filter(e => e.type === 'way' && wayMemberRoles.has(e.id));

  // Priority 1: ways with empty role (main track), tagged highway=raceway
  // Priority 2: any empty-role ways
  // Priority 3: highway=raceway ways regardless of role
  // Priority 4: all member ways (last resort)
  const emptyRoleWays = allMemberWays.filter(w => wayMemberRoles.get(w.id) === '');
  const emptyRoleRaceway = emptyRoleWays.filter(w => w.tags?.highway === 'raceway');
  const anyRaceway = allMemberWays.filter(w => w.tags?.highway === 'raceway');

  const chosen =
    emptyRoleRaceway.length > 0 ? emptyRoleRaceway :
    emptyRoleWays.length > 0    ? emptyRoleWays :
    anyRaceway.length > 0       ? anyRaceway :
    allMemberWays;

  return chosen.map(w => ({
    nodes: (w.nodes || []).map(id => nodeMap.get(id)).filter(Boolean),
  }));
}

async function fetchGeometryViaOverpassName(trackName, signal) {
  // Fallback: search Overpass for a highway=raceway way with matching name
  const escapedName = trackName.replace(/"/g, '\\"');
  const query = `[out:json][timeout:25];(way["name"="${escapedName}"]["highway"="raceway"];way["name"~"${escapedName}","i"]["highway"="raceway"];);out body geom;`;
  const data = await runOverpassQuery(query, signal);
  const ways = (data.elements || []).filter(e => e.type === 'way' && e.geometry?.length);
  if (ways.length === 0) throw new Error(`No raceway geometry found for "${trackName}"`);
  const waysWithGeom = ways.map(w => ({
    nodes: (w.geometry || []).map(({ lat, lon }) => ({ lat, lon })),
  }));
  return stitchWays(waysWithGeom);
}

export async function fetchTrackGeometry(osmType, osmId, signal, trackName) {
  if (!osmId) throw new Error('No OSM ID available for this circuit (not yet mapped in OSM)');

  // Use the OSM API directly — much more reliable than Overpass for ID-based lookups
  if (osmType === 'relation') {
    const resp = await fetch(`${OSM_API}/relation/${osmId}/full.json`, { signal });

    if (resp.status === 410 || resp.status === 404) {
      // Relation deleted or not found — try Overpass name fallback if we have a name
      if (trackName) return fetchGeometryViaOverpassName(trackName, signal);
      throw new Error(`OSM relation ${osmId} no longer exists (${resp.status})`);
    }
    if (!resp.ok) throw new Error(`OSM API error: ${resp.status}`);

    const { elements } = await resp.json();
    const waysWithGeom = extractWaysFromRelationElements(elements);
    return stitchWays(waysWithGeom);
  }

  if (osmType === 'way') {
    const resp = await fetch(`${OSM_API}/way/${osmId}/full.json`, { signal });
    if (!resp.ok) throw new Error(`OSM API error: ${resp.status}`);
    const { elements } = await resp.json();
    const nodeMap = new Map();
    for (const el of elements) {
      if (el.type === 'node') nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
    }
    const way = elements.find(e => e.type === 'way');
    if (!way) throw new Error('No way found');
    return (way.nodes || []).map(id => nodeMap.get(id)).filter(Boolean);
  }

  throw new Error(`Unsupported osmType: ${osmType}`);
}
