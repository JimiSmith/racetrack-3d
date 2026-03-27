const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';

export async function searchTracks(query) {
  // Search Overpass directly for raceway-tagged features matching the name.
  // This is far more reliable than Nominatim which returns places, not circuits.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const overpassQuery = `
[out:json][timeout:10];
(
  way["highway"="raceway"]["name"~"${escaped}",i];
  relation["highway"="raceway"]["name"~"${escaped}",i];
  way["leisure"="track"]["sport"~"motor|karting"]["name"~"${escaped}",i];
  relation["leisure"="track"]["sport"~"motor|karting"]["name"~"${escaped}",i];
);
out tags center;
  `.trim();

  const data = await overpassQuery(overpassQuery);

  return data.elements.map(el => {
    const name = el.tags?.name || el.tags?.['name:en'] || 'Unknown';
    const country = el.tags?.['addr:country'] || '';
    const city = el.tags?.['addr:city'] || el.tags?.['addr:state'] || '';
    const location = [city, country].filter(Boolean).join(', ');
    return {
      name,
      displayName: location ? `${name} — ${location}` : name,
      osmType: el.type,   // 'way' or 'relation'
      osmId: el.id,
    };
  });
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
