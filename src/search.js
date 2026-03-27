const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';

export async function searchTracks(query, signal) {
  // Search Wikidata for racing circuits by name. Wikidata is reliable, has CORS,
  // and stores OSM relation IDs (P402) for most major circuits.
  const sparql = `
SELECT DISTINCT ?item ?itemLabel ?countryLabel ?osmId WHERE {
  ?item wdt:P31/wdt:P279* wd:Q1777138 .
  OPTIONAL { ?item wdt:P17 ?country . }
  OPTIONAL { ?item wdt:P402 ?osmId . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
  FILTER(CONTAINS(LCASE(?itemLabel), LCASE("${query.replace(/"/g, '')}")))
}
LIMIT 15
  `.trim();

  const url = `${WIKIDATA_SPARQL}?query=${encodeURIComponent(sparql)}&format=json`;
  const response = await fetch(url, {
    headers: { Accept: 'application/sparql-results+json' },
    signal,
  });
  if (!response.ok) throw new Error(`Wikidata error: ${response.status}`);
  const { results } = await response.json();

  return results.bindings.map(b => ({
    name: b.itemLabel?.value || 'Unknown',
    displayName: b.countryLabel
      ? `${b.itemLabel?.value} — ${b.countryLabel.value}`
      : b.itemLabel?.value || 'Unknown',
    osmType: 'relation',
    osmId: b.osmId?.value || null,   // OSM relation ID from Wikidata P402
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
  if (ways.length === 1) return ways[0].geometry.map(n => ({ lat: n.lat, lon: n.lon }));

  // Build a map from endpoint node id to way
  const remaining = ways.map(w => ({ nodes: w.geometry.map(n => ({ lat: n.lat, lon: n.lon })) }));
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

export async function fetchTrackGeometry(osmType, osmId, signal) {
  if (!osmId) throw new Error('No OSM ID available for this circuit (not yet mapped in OSM)');
  let data;

  if (osmType === 'way') {
    data = await runOverpassQuery(`[out:json];way(${osmId});out geom;`, signal);
    const way = data.elements.find(e => e.type === 'way');
    if (!way || !way.geometry) throw new Error('No geometry returned for way');
    return way.geometry.map(n => ({ lat: n.lat, lon: n.lon }));
  }

  if (osmType === 'relation') {
    data = await runOverpassQuery(`[out:json];relation(${osmId});way(r["highway"="raceway"];);out geom;`, signal);
    const ways = data.elements.filter(e => e.type === 'way' && e.geometry);
    if (ways.length === 0) throw new Error('No raceway ways found in this relation');
    return stitchWays(ways);
  }

  throw new Error(`Unsupported osmType: ${osmType}`);
}
