const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';
const USER_AGENT = 'racetrack-3d/1.0 (https://github.com/piclaw/racetrack-3d)';

export async function searchTracks(query) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=10`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
  });
  if (!response.ok) throw new Error(`Nominatim error: ${response.status}`);
  const results = await response.json();

  // Accept anything that could be a racing circuit — Nominatim class values vary
  // between leisure, highway, sport, etc. Filter lightly: exclude administrative/
  // postal/place results that are clearly not circuits.
  const EXCLUDED_CLASSES = new Set(['boundary', 'place', 'amenity', 'highway', 'railway', 'waterway', 'natural']);
  const EXCLUDED_TYPES = new Set(['administrative', 'city', 'town', 'village', 'suburb', 'quarter', 'hamlet', 'municipality', 'county', 'state', 'country', 'postcode']);

  return results
    .filter(r => !EXCLUDED_CLASSES.has(r.class) || !EXCLUDED_TYPES.has(r.type))
    .map(r => ({
      name: r.name || r.display_name.split(',')[0],
      displayName: r.display_name,
      osmType: r.osm_type,  // 'node', 'way', or 'relation'
      osmId: r.osm_id,
    }));
}

async function overpassQuery(query) {
  const body = `data=${encodeURIComponent(query)}`;
  for (const endpoint of [OVERPASS_PRIMARY, OVERPASS_FALLBACK]) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!response.ok) continue;
      return await response.json();
    } catch {
      // try fallback
    }
  }
  throw new Error('All Overpass endpoints failed');
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

export async function fetchTrackGeometry(osmType, osmId) {
  let data;

  if (osmType === 'way') {
    data = await overpassQuery(`[out:json];way(${osmId});out geom;`);
    const way = data.elements.find(e => e.type === 'way');
    if (!way || !way.geometry) throw new Error('No geometry returned for way');
    return way.geometry.map(n => ({ lat: n.lat, lon: n.lon }));
  }

  if (osmType === 'relation') {
    data = await overpassQuery(`[out:json];relation(${osmId});way(r);out geom;`);
    const ways = data.elements.filter(e => e.type === 'way' && e.geometry);
    if (ways.length === 0) throw new Error('No ways returned for relation');
    return stitchWays(ways);
  }

  throw new Error(`Unsupported osmType: ${osmType}`);
}
