// Open-Topo-Data: free, no key, ASTER has better global coverage than SRTM
const TOPO_API = 'https://api.opentopodata.org/v1/aster30m';
const CHUNK_SIZE = 100; // API max per request

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
    // Open-Topo-Data uses pipe-separated lat,lon pairs as a GET param
    const locations = chunk.map(n => `${n.lat},${n.lon}`).join('|');
    const resp = await fetch(`${TOPO_API}?locations=${encodeURIComponent(locations)}`);
    if (!resp.ok) throw new Error(`opentopodata error: ${resp.status}`);
    const data = await resp.json();
    if (data.status !== 'OK') throw new Error(`opentopodata: ${data.status}`);
    for (const r of data.results) {
      results.push(r.elevation ?? 0);
    }
  }
  return results;
}

// Remove statistical outliers (> 3 std deviations from mean) — replace with median
function removeOutliers(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return values.map(v => Math.abs(v - mean) > 3 * std ? median : v);
}
