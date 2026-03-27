// Open-Meteo elevation API: free, no key, CORS enabled, Copernicus DEM (90m global)
// Docs: https://open-meteo.com/en/docs/elevation-api
const ELEVATION_API = 'https://api.open-meteo.com/v1/elevation';
const CHUNK_SIZE = 1000; // API supports up to 1000 per request

export async function fetchElevations(nodes, exaggeration = 15) {
  try {
    const raw = await fetchRawElevations(nodes);
    const cleaned = removeOutliers(raw);
    const minElev = Math.min(...cleaned);
    return cleaned.map(e => (e - minElev) * exaggeration);
  } catch (err) {
    console.warn('fetchElevations failed, using flat track:', err.message);
    return new Array(nodes.length).fill(0);
  }
}

async function fetchRawElevations(nodes) {
  const results = [];
  for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
    const chunk = nodes.slice(i, i + CHUNK_SIZE);
    const lats = chunk.map(n => n.lat).join(',');
    const lons = chunk.map(n => n.lon).join(',');
    const resp = await fetch(`${ELEVATION_API}?latitude=${lats}&longitude=${lons}`);
    if (!resp.ok) throw new Error(`open-meteo elevation error: ${resp.status}`);
    const data = await resp.json();
    if (!data.elevation) throw new Error('No elevation data in response');
    results.push(...data.elevation);
  }
  return results;
}

// Replace statistical outliers (>3σ from mean) with median
function removeOutliers(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return values.map(v => Math.abs(v - mean) > 3 * std ? median : v);
}
