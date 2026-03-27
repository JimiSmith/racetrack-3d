// open-elevation.com: only free elevation API with proper CORS (Access-Control-Allow-Origin: *)
// Bad SRTM data points are handled by outlier filtering before computing range.
const ELEVATION_API = 'https://api.open-elevation.com/api/v1/lookup';
const CHUNK_SIZE = 100;

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
    const resp = await fetch(ELEVATION_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        locations: chunk.map(n => ({ latitude: n.lat, longitude: n.lon })),
      }),
    });
    if (!resp.ok) throw new Error(`open-elevation error: ${resp.status}`);
    const data = await resp.json();
    results.push(...data.results.map(r => r.elevation ?? 0));
  }
  return results;
}

// Replace statistical outliers (>3σ from mean) with median — handles bad SRTM data points
function removeOutliers(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return values.map(v => Math.abs(v - mean) > 3 * std ? median : v);
}
